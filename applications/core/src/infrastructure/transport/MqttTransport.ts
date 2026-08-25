import * as mqtt from 'mqtt';
import type { Logger } from '../logger/index';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration pour le transport MQTT
 */
export interface MqttTransportConfig {
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  keepalive: number;
  reconnectDelay: number;
  clean?: boolean;
  /** Topic du LWT (Last Will and Testament). Défaut : `app/{clientId}/status`. */
  willTopic?: string;
  /** Version du protocole MQTT (3 = 3.1, 4 = 3.1.1, 5 = 5.0) — passé tel quel à mqtt.js. Absent =
   *  défaut de la librairie (3.1.1). ⭐ 24/08/2026 : passage général à MQTT 5, SAUF les deux ponts
   *  de compatibilité vers l'ancienne domotique (rpigpio, rfxcom) qui doivent rester en 3.1.1 — ne
   *  jamais fixer cette valeur par défaut ici, chaque appelant décide explicitement. */
  protocolVersion?: 3 | 4 | 5;
}

/**
 * Message MQTT reçu
 */
export interface MqttMessage {
  topic: string;
  payload: Buffer | string;
  qos: number;
  retain: boolean;
}

/**
 * Publication mise en attente pendant une déconnexion transitoire (voir §"File d'attente courte").
 */
interface QueuedPublish {
  topic: string;
  payload: string | Buffer;
  qos: 0 | 1;
  retain: boolean;
  queuedAt: number;
}

/**
 * Callback pour les messages entrants
 */
type MessageCallback = (message: MqttMessage) => void;

/**
 * Callback pour les événements de connexion
 */
type ConnectCallback = () => void;

/**
 * Callback pour les événements de déconnexion
 */
type DisconnectCallback = (reason?: string) => void;

/**
 * Callback pour les erreurs
 */
type ErrorCallback = (error: Error) => void;

// =============================================================================
// Constantes
// =============================================================================

const MAX_RECONNECT_DELAY_MS = 60000; // 60 secondes max
// ⭐ 25/08/2026 : délai avant de considérer une connexion comme stable (voir handleConnect) — en
// dessous de ce seuil, une coupure ne doit PAS remettre le backoff à zéro (voir le commentaire sur
// stableTimeout : bug réel constaté en conditions réelles sur stfort, boucle connexion/coupure par
// le broker toutes les ~1-2s indéfiniment, sans jamais ralentir, faute de ce garde-fou).
const STABLE_CONNECTION_MS = 5000;
const LWT_TOPIC_PREFIX = 'app';
const LWT_PAYLOAD_OFFLINE = 'offline';
const LWT_PAYLOAD_ONLINE = 'online';

/**
 * Durée de vie maximale d'une publication en attente (déconnexion transitoire) avant
 * abandon silencieux (avec avertissement journalisé) — "file d'attente courte", pas une
 * garantie de livraison longue durée : au-delà, un message d'état est considéré périmé.
 */
const PENDING_PUBLISH_MAX_AGE_MS = 30000; // 30 secondes
/** Borne la mémoire en cas de rafale pendant une coupure prolongée : le plus ancien est abandonné au-delà. */
const PENDING_PUBLISH_MAX_SIZE = 200;

/**
 * Client de transport MQTT bas niveau.
 * Gère la connexion, la publication/souscription, et la reconnexion automatique.
 *
 * NE PAS utiliser directement pour la logique métier :
 * voir les modules d'intégration dans la couche HA.
 */
export class MqttTransport {
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  /** Programmée à la connexion, annulée à la déconnexion — voir handleConnect/STABLE_CONNECTION_MS. */
  private stableTimeout: NodeJS.Timeout | null = null;

  // Callbacks
  private messageCallbacks: MessageCallback[] = [];
  private connectCallbacks: ConnectCallback[] = [];
  private disconnectCallbacks: DisconnectCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];

  /**
   * Publications tentées pendant une déconnexion — rejouées à la reconnexion (voir
   * `flushPendingPublishes`), au lieu de faire lever `publish()` (ancien comportement :
   * une exception synchrone ici remontait jusqu'au callback `'message'` de la bibliothèque
   * `mqtt`, donc jusqu'à une exception non capturée au niveau du process Node entier —
   * voir TODO.md "MqttTransport.publish() lève une exception synchrone...").
   */
  private pendingPublishes: QueuedPublish[] = [];

  /**
   * Abonnements actifs, réappliqués à chaque reconnexion — `scheduleReconnect()` crée un
   * tout nouveau client `mqtt.MqttClient` à chaque tentative (pas une reconnexion interne
   * de la bibliothèque sur le même client), donc aucun abonnement ne survit naturellement
   * à une reconnexion sans ce mécanisme explicite.
   */
  private activeSubscriptions: Map<string, 0 | 1> = new Map();

  private readonly config: MqttTransportConfig;
  private readonly logger?: Logger;

  /**
   * @param config - Configuration pour la connexion MQTT
   * @param logger - Optionnel : journalise les publications/abonnements mis en attente et
   *   leur résolution à la reconnexion. Sans logger, ces événements restent silencieux.
   */
  constructor(config: MqttTransportConfig, logger?: Logger) {
    this.config = {
      clean: true,
      ...config,
    };
    this.logger = logger;
  }

  // ===========================================================================
  // Méthodes publiques
  // ===========================================================================

  /**
   * Établit la connexion MQTT au broker
   */
  connect(): void {
    if (this.isConnected || this.client !== null) {
      return; // Déjà connecté ou en cours de connexion
    }

    this.createMqttClient();
  }

  /**
   * Ferme la connexion MQTT proprement
   */
  disconnect(): void {
    this.clearReconnectTimeout();
    this.clearStableTimeout();

    if (this.client) {
      // Publier le LWT offline avant de se déconnecter
      this.publishLwt(LWT_PAYLOAD_OFFLINE, true);
      this.client.end();
      this.client = null;
    }

    this.isConnected = false;
    this.reconnectAttempts = 0;
    // Déconnexion volontaire : les messages en attente n'ont plus de destinataire prévu.
    this.pendingPublishes = [];
  }

  /**
   * Publie un message sur un topic MQTT.
   *
   * Si le client est temporairement déconnecté, le message est mis en attente (file courte,
   * voir `PENDING_PUBLISH_MAX_AGE_MS`/`PENDING_PUBLISH_MAX_SIZE`) et rejoué automatiquement à
   * la reconnexion, plutôt que de lever une exception (voir le commentaire sur
   * `pendingPublishes`) — une coupure MQTT transitoire est un événement normal en pub/sub,
   * pas une erreur de programmation.
   * @param topic - Topic MQTT
   * @param payload - Payload à publier (string ou Buffer)
   * @param qos - Niveau de QoS (0 ou 1 uniquement)
   * @param retain - Flag retain
   */
  publish(topic: string, payload: string | Buffer, qos: 0 | 1 = 0, retain: boolean = false): void {
    if (!this.client || !this.isConnected) {
      this.enqueuePendingPublish({ topic, payload, qos, retain, queuedAt: Date.now() });
      return;
    }

    this.client.publish(topic, payload, { qos, retain });
  }

  /**
   * S'abonne à un topic MQTT.
   *
   * L'abonnement est mémorisé (`activeSubscriptions`) et réappliqué à chaque reconnexion,
   * qu'il ait pu être envoyé immédiatement ou non — voir le commentaire sur
   * `activeSubscriptions`. Ne lève plus si le client est temporairement déconnecté (même
   * raison que `publish`) : l'abonnement sera simplement effectif dès la reconnexion.
   * @param topic - Topic MQTT
   * @param qos - Niveau de QoS (0 ou 1 uniquement)
   */
  subscribe(topic: string, qos: 0 | 1 = 0): void {
    this.activeSubscriptions.set(topic, qos);

    if (!this.client || !this.isConnected) {
      this.logger?.warn('ha:mqtt:transport', `Client MQTT déconnecté [${this.config.clientId}] — abonnement à "${topic}" appliqué dès la reconnexion`);
      return;
    }

    this.client.subscribe(topic, { qos });
  }

  /**
   * Se désabonne d'un topic MQTT
   * @param topic - Topic MQTT
   */
  unsubscribe(topic: string): void {
    this.activeSubscriptions.delete(topic);

    if (!this.client || !this.isConnected) {
      return; // Ignorer si non connecté
    }

    this.client.unsubscribe(topic);
  }

  /**
   * S'abonne aux messages entrants
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * S'abonne aux événements de connexion
   */
  onConnect(callback: ConnectCallback): void {
    this.connectCallbacks.push(callback);
  }

  /**
   * S'abonne aux événements de déconnexion
   */
  onDisconnect(callback: DisconnectCallback): void {
    this.disconnectCallbacks.push(callback);
  }

  /**
   * S'abonne aux erreurs
   */
  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Retourne l'état de la connexion
   */
  getConnected(): boolean {
    return this.isConnected;
  }

  // ===========================================================================
  // Méthodes privées - Connexion et gestion
  // ===========================================================================

  /**
   * Crée un nouveau client MQTT et configure les événements
   */
  private createMqttClient(): void {
    // Un ancien client peut encore exister ici (scheduleReconnect() en crée un nouveau à chaque
    // tentative, voir le commentaire sur activeSubscriptions) — le fermer explicitement avant de
    // le remplacer, sinon il reste vivant en arrière-plan (voir reconnectPeriod ci-dessous).
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
    }

    const url = `mqtt://${this.config.host}:${this.config.port}`;

    const options: mqtt.IClientOptions = {
      clientId: this.config.clientId,
      clean: this.config.clean,
      keepalive: this.config.keepalive,
      // Reconnexion gérée nous-mêmes (scheduleReconnect, backoff exponentiel) — PAS par mqtt.js
      // lui-même (reconnectPeriod: 0 désactive sa reconnexion interne automatique sur ce même
      // client). Les deux mécanismes actifs simultanément créaient un client fantôme par coupure
      // (l'ancien continuait de retenter tout seul, jamais fermé, avec le même clientId que le
      // nouveau) — tempête de reconnexions constatée en conditions réelles le 07/08/2026
      // ("session taken over" en boucle sur mosquitto, des dizaines de fois par seconde).
      reconnectPeriod: 0,
      protocolVersion: this.config.protocolVersion,
      username: this.config.username || undefined,
      password: this.config.password || undefined,
      // Configuration du LWT (Last Will and Testament)
      will: {
        topic: this.getWillTopic(),
        payload: LWT_PAYLOAD_OFFLINE,
        retain: true,
        qos: 1,
      },
    };

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => this.handleConnect());
    this.client.on('message', (topic, payload, packet) => this.handleMessage(topic, payload, packet));
    this.client.on('close', () => this.handleClose());
    this.client.on('error', (error) => this.handleError(error));
    this.client.on('offline', () => this.handleOffline());
    this.client.on('end', () => this.handleEnd());
  }

  /**
   * Gère la connexion réussie
   */
  private handleConnect(): void {
    this.isConnected = true;
    this.clearReconnectTimeout();

    // ⭐ 25/08/2026 : ne remet reconnectAttempts à zéro qu'après STABLE_CONNECTION_MS de connexion
    // ininterrompue — pas immédiatement ici. Sinon une connexion coupée par le broker presque
    // aussitôt après chaque tentative (bug réel constaté sur stfort, "Connection closed by broker"
    // ~1s après chaque connexion) fait repartir le backoff à son délai minimal à chaque cycle, sans
    // jamais ralentir — la boucle tourne alors indéfiniment au lieu de finir par espacer ses
    // tentatives. Annulée dans handleClose/handleOffline/handleEnd si la coupure survient avant.
    this.clearStableTimeout();
    this.stableTimeout = setTimeout(() => {
      this.stableTimeout = null;
      this.reconnectAttempts = 0;
    }, STABLE_CONNECTION_MS);

    // Publier le LWT online
    this.publishLwt(LWT_PAYLOAD_ONLINE, true);

    // Réappliquer les abonnements actifs et rejouer les publications en attente —
    // voir les commentaires sur `activeSubscriptions`/`pendingPublishes`.
    this.resubscribeAll();
    this.flushPendingPublishes();

    // Notifier les callbacks
    this.notifyConnect();
  }

  /**
   * Gère la réception d'un message
   */
  private handleMessage(topic: string, payload: Buffer, packet: any): void {
    const message: MqttMessage = {
      topic,
      payload,
      qos: (packet as { qos?: number }).qos || 0,
      retain: (packet as { retain?: boolean }).retain || false,
    };

    this.notifyMessage(message);
  }

  /**
   * Gère la fermeture de la connexion
   */
  private handleClose(): void {
    this.isConnected = false;
    this.clearReconnectTimeout();
    this.clearStableTimeout();
    this.notifyDisconnect('Connection closed by broker');
    this.scheduleReconnect();
  }

  /**
   * Gère les erreurs de connexion
   */
  private handleError(error: Error): void {
    this.notifyError(error);
  }

  /**
   * Gère le passage en mode offline
   */
  private handleOffline(): void {
    this.isConnected = false;
    this.notifyDisconnect('Client went offline');
  }

  /**
   * Gère la fin de la connexion (appelée par .end())
   */
  private handleEnd(): void {
    this.isConnected = false;
    this.notifyDisconnect('Connection ended');
  }

  // ===========================================================================
  // Méthodes privées - LWT (Last Will and Testament)
  // ===========================================================================

  /**
   * Publie le LWT (Last Will and Testament)
   * @param payload - Payload à publier ('online' ou 'offline')
   * @param retain - Flag retain (toujours true pour LWT)
   */
  private publishLwt(payload: string, retain: boolean = true): void {
    if (!this.client || !this.isConnected) return;

    this.client.publish(this.getWillTopic(), payload, { qos: 1, retain });
  }

  /**
   * Topic du LWT, configurable via `config.willTopic` (défaut : `app/{clientId}/status`).
   */
  private getWillTopic(): string {
    return this.config.willTopic ?? `${LWT_TOPIC_PREFIX}/${this.config.clientId}/status`;
  }

  /**
   * Flip manuel du statut retained online/offline, sans fermer la connexion.
   * Utile quand l'application détecte elle-même la perte d'un matériel en aval
   * (ex: port série débranché) sans que la connexion MQTT elle-même ne tombe —
   * dans ce cas le LWT natif (déclenché uniquement à la perte de connexion) ne suffit pas.
   * @param online - true pour publier "online", false pour "offline"
   */
  publishStatus(online: boolean): void {
    this.publishLwt(online ? LWT_PAYLOAD_ONLINE : LWT_PAYLOAD_OFFLINE, true);
  }

  // ===========================================================================
  // Méthodes privées - Reconnexion
  // ===========================================================================

  /**
   * Planifie une reconnexion avec backoff exponentiel (max 60s)
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return; // Déjà planifiée

    // Calcul du délai : min(2^attempts * 1000, 60000)
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 1000,
      MAX_RECONNECT_DELAY_MS
    );

    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.createMqttClient();
    }, delay);
  }

  /**
   * Annule la reconnexion planifiée
   */
  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private clearStableTimeout(): void {
    if (this.stableTimeout) {
      clearTimeout(this.stableTimeout);
      this.stableTimeout = null;
    }
  }

  // ===========================================================================
  // Méthodes privées - File d'attente courte (publications) et réabonnement
  // ===========================================================================

  /**
   * Met une publication en attente pendant une déconnexion transitoire, en bornant la
   * mémoire (`PENDING_PUBLISH_MAX_SIZE`) : au-delà, la plus ancienne est abandonnée pour
   * faire de la place à la nouvelle plutôt que de rejeter cette dernière — les messages les
   * plus récents (état courant) valent mieux que les plus anciens (déjà périmés).
   */
  private enqueuePendingPublish(item: QueuedPublish): void {
    if (this.pendingPublishes.length >= PENDING_PUBLISH_MAX_SIZE) {
      const dropped = this.pendingPublishes.shift();
      this.logger?.warn(
        'ha:mqtt:transport',
        `File d'attente pleine (${PENDING_PUBLISH_MAX_SIZE}) — message le plus ancien abandonné (topic: ${dropped?.topic})`
      );
    }

    this.pendingPublishes.push(item);
    this.logger?.warn(
      'ha:mqtt:transport',
      `Client MQTT déconnecté — publication mise en attente (topic: ${item.topic}, ${this.pendingPublishes.length} en attente)`
    );
  }

  /**
   * Rejoue les publications en attente à la reconnexion. Les messages plus vieux que
   * `PENDING_PUBLISH_MAX_AGE_MS` sont abandonnés (avertissement journalisé) plutôt que
   * republiés — passé ce délai, un message d'état est considéré périmé, republier une
   * valeur potentiellement obsolète serait pire que de ne rien publier.
   */
  private flushPendingPublishes(): void {
    if (this.pendingPublishes.length === 0 || !this.client) return;

    const toReplay = this.pendingPublishes;
    this.pendingPublishes = [];
    const now = Date.now();
    let sent = 0;
    let expired = 0;

    for (const item of toReplay) {
      if (now - item.queuedAt > PENDING_PUBLISH_MAX_AGE_MS) {
        expired++;
        continue;
      }
      this.client.publish(item.topic, item.payload, { qos: item.qos, retain: item.retain });
      sent++;
    }

    this.logger?.info(
      'ha:mqtt:transport',
      `Reconnexion — ${sent} publication(s) en attente rejouée(s), ${expired} abandonnée(s) (délai de ${PENDING_PUBLISH_MAX_AGE_MS / 1000}s dépassé)`
    );
  }

  /**
   * Réapplique tous les abonnements actifs à la reconnexion — voir le commentaire sur
   * `activeSubscriptions` (chaque reconnexion recrée un client MQTT entièrement nouveau).
   */
  private resubscribeAll(): void {
    if (this.activeSubscriptions.size === 0 || !this.client) return;

    for (const [topic, qos] of this.activeSubscriptions) {
      this.client.subscribe(topic, { qos });
    }

    this.logger?.info('ha:mqtt:transport', `Reconnexion [${this.config.clientId}] — ${this.activeSubscriptions.size} abonnement(s) réappliqué(s)`);
  }

  // ===========================================================================
  // Méthodes privées - Notifications aux callbacks
  // ===========================================================================

  /**
   * Notifie tous les callbacks de message
   */
  private notifyMessage(message: MqttMessage): void {
    for (const callback of this.messageCallbacks) {
      try {
        callback(message);
      } catch {
        // Ignorer les erreurs dans les callbacks
      }
    }
  }

  /**
   * Notifie tous les callbacks de connexion
   */
  private notifyConnect(): void {
    for (const callback of this.connectCallbacks) {
      try {
        callback();
      } catch {
        // Ignorer les erreurs dans les callbacks
      }
    }
  }

  /**
   * Notifie tous les callbacks de déconnexion
   */
  private notifyDisconnect(reason: string): void {
    for (const callback of this.disconnectCallbacks) {
      try {
        callback(reason);
      } catch {
        // Ignorer les erreurs dans les callbacks
      }
    }
  }

  /**
   * Notifie tous les callbacks d'erreur
   */
  private notifyError(error: Error): void {
    for (const callback of this.errorCallbacks) {
      try {
        callback(error);
      } catch {
        // Ignorer les erreurs dans les callbacks
      }
    }
  }
}
