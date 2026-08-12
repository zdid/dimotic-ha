import {
  createLongLivedTokenAuth,
  createConnection,
  getStates,
  callService,
  type Connection,
} from 'home-assistant-js-websocket';
import type { HaRawEntity, HaStateChangedMessage, HaAreaRegistryUpdatedMessage, HaDeviceRegistryUpdatedMessage, HaEntityRegistryUpdatedMessage, HaWsMessage } from '../types/ha-entity';
import { HaWsConfig } from '../../infrastructure/config/schema';
import { Logger } from '../../infrastructure/logger/index';

// =============================================================================
// Polyfill WebSocket pour Node.js — home-assistant-js-websocket cible le navigateur
// (WebSocket natif) ; usage documenté officiellement pour Node.js (README du paquet).
// =============================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (globalThis as { WebSocket?: unknown }).WebSocket = require('ws');
}

// =============================================================================
// Callbacks pour les événements HA
// =============================================================================

type RegistryAction = 'create' | 'update' | 'delete';
type EntityStateCallback = (entity: HaRawEntity) => void;
type AreaUpdatedCallback = (area: { area_id: string; name: string; picture?: string; action: RegistryAction }) => void;
type DeviceUpdatedCallback = (device: { device_id: string; name: string; area_id?: string; action: RegistryAction }) => void;
type EntityUpdatedCallback = (entity: { entity_id: string; domain: string; device_class?: string; area_id?: string; action: RegistryAction }) => void;
type ConnectCallback = () => void;
type DisconnectCallback = (reason?: string) => void;
type ErrorCallback = (error: Error) => void;

// =============================================================================
// HaWsClient - Client WebSocket HA de haut niveau
// =============================================================================

/**
 * Client WebSocket HA de haut niveau.
 * Gère la connexion, l'authentification, et la synchronisation du référentiel HA.
 *
 * Implémenté sur `home-assistant-js-websocket` (librairie officiellement maintenue par
 * l'équipe Home Assistant, utilisée par le frontend HA lui-même) — remplace l'ancien
 * transport WebSocket maison (HaWsTransport, supprimé) qui contenait un bug de double
 * authentification par connexion (auth envoyée à la fois par le transport à l'ouverture du
 * socket ET par HaWsClient en réponse à `auth_required`).
 *
 * **Responsabilités :**
 * - Connexion et authentification via Long-Lived Access Token
 * - Chargement initial des états, areas, devices
 * - Souscription aux événements temps réel
 * - Émission des événements vers EventBus
 *
 * **Ne pas confondre avec :**
 * - HaStateRegistry (stockage des états)
 * - HaStructureRegistry (structuration des entités)
 */
export class HaWsClient {
  private logger: Logger;
  private connection: Connection | undefined;

  // État de connexion
  private isAuthenticated = false;
  private isReady = false;

  // Configuration actuelle pour reconfigure
  private currentConfig: HaWsConfig;

  // Callbacks
  private stateCallbacks: EntityStateCallback[] = [];
  private areaCallbacks: AreaUpdatedCallback[] = [];
  private deviceCallbacks: DeviceUpdatedCallback[] = [];
  private entityCallbacks: EntityUpdatedCallback[] = [];
  private connectCallbacks: ConnectCallback[] = [];
  private disconnectCallbacks: DisconnectCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];

  /**
   * @param config - Configuration WebSocket HA
   * @param logger - Logger pour les logs (optionnel)
   */
  constructor(
    private config: HaWsConfig,
    logger?: Logger
  ) {
    this.currentConfig = config;

    this.logger = logger || new Logger({
      level: 'info',
      maxSizeMb: 10,
      maxFiles: 5,
      logDir: '/app/logs',
    });
  }

  // ===========================================================================
  // Méthodes publiques
  // ===========================================================================

  /**
   * Établit la connexion à Home Assistant.
   * Se connecte, s'authentifie, et lance la synchronisation initiale.
   *
   * Fire-and-forget (comme l'ancienne implémentation) : createConnection est asynchrone en
   * interne, l'appelant n'attend pas cette méthode — le résultat est notifié via
   * onConnect/onDisconnect/onError.
   */
  connect(): void {
    this.logger.info('ha:ws', `Connexion à HA WebSocket: ${this.config.host}:${this.config.port}`);

    const hassUrl = `http://${this.config.host}:${this.config.port}`;
    const auth = createLongLivedTokenAuth(hassUrl, this.config.token);

    // setupRetry: -1 = réessaie indéfiniment la connexion initiale (même comportement que
    // l'ancien transport). ⚠️ Contrairement à l'ancien transport, la lib officielle n'insiste
    // PAS en cas de jeton invalide (auth_invalid rejette immédiatement, pas de retry) — fini la
    // boucle de reconnexion toutes les secondes observée avec un jeton invalide.
    createConnection({ auth, setupRetry: -1 })
      .then((connection) => this.handleConnected(connection))
      .catch((error) => this.handleConnectFailed(error));
  }

  private handleConnected(connection: Connection): void {
    this.connection = connection;
    this.isAuthenticated = true;
    this.logger.info('ha:ws', 'Connexion WebSocket établie et authentifiée');
    this.notifyConnect();

    connection.addEventListener('disconnected', () => {
      this.logger.warn('ha:ws', 'Déconnexion WebSocket');
      this.isAuthenticated = false;
      this.isReady = false;
      this.notifyDisconnect();
    });

    connection.addEventListener('ready', () => {
      this.logger.info('ha:ws', 'Reconnexion WebSocket établie');
      this.isAuthenticated = true;
      this.notifyConnect();
    });

    connection.addEventListener('reconnect-error', (_conn, errorCode) => {
      const message = errorCode === 2 /* ERR_INVALID_AUTH */ ? 'Invalid HA token' : `Reconnect error (code ${errorCode})`;
      this.logger.error('ha:ws', message);
      this.notifyError(new Error(message));
    });
  }

  private handleConnectFailed(error: unknown): void {
    // ERR_INVALID_AUTH (2) ou ERR_CANNOT_CONNECT (1), voir home-assistant-js-websocket/errors.
    const message = error === 2 ? 'Invalid HA token' : `Impossible de se connecter à HA WebSocket (code ${error})`;
    this.logger.error('ha:ws', message);
    this.notifyError(new Error(message));
  }

  /**
   * Ferme la connexion.
   */
  disconnect(): void {
    this.logger.info('ha:ws', 'Déconnexion de HA WebSocket');
    this.connection?.close();
    this.connection = undefined;
    this.isAuthenticated = false;
    this.isReady = false;
  }

  /**
   * Charge le référentiel initial de manière synchrone.
   * Appelle get_states, config/area_registry/list, config/device_registry/list
   * et config/entity_registry/list en parallèle.
   *
   * @returns Promise qui résout quand tout est chargé
   */
  async loadInitialRegistry(): Promise<{
    entities: HaRawEntity[];
    areas: Array<{ area_id: string; name: string; picture?: string }>;
    devices: Array<{ device_id: string; name: string; area_id?: string }>;
    entityRegistry: Array<{ entity_id: string; domain: string; device_class?: string; area_id?: string }>;
  }> {
    if (!this.isAuthenticated || !this.connection) {
      throw new Error('Cannot load registry: not authenticated. Call connect() first.');
    }

    this.logger.info('ha:ws', 'Chargement du référentiel initial');

    const conn = this.connection;
    // config/{area,device,entity}_registry/list n'ont pas d'équivalent haut niveau dans
    // home-assistant-js-websocket (seuls get_states/get_config/get_services/get_user en ont) —
    // passe par l'échappatoire bas niveau sendMessagePromise, comportement documenté.
    const [entities, areasResult, devicesResult, entityRegistry] = await Promise.all([
      getStates(conn) as unknown as Promise<HaRawEntity[]>,
      conn.sendMessagePromise<{ areas: Array<{ area_id: string; name: string; picture?: string }> }>({ type: 'config/area_registry/list' }),
      conn.sendMessagePromise<Array<{ id: string; name: string; area_id?: string }>>({ type: 'config/device_registry/list' }),
      conn.sendMessagePromise<Array<{ entity_id: string; domain: string; device_class?: string; area_id?: string }>>({ type: 'config/entity_registry/list' }),
    ]);

    // config/area_registry/list retourne soit { areas: [...] } (anciennes versions HA) soit
    // directement [...] (versions récentes) — gère les deux formes.
    const areas = Array.isArray(areasResult) ? areasResult : areasResult.areas;

    // ⚠️ Le champ d'identifiant renvoyé par config/device_registry/list s'appelle `id`, PAS
    // `device_id` (vérifié en live sur une instance HA réelle) — contrairement aux entités, où
    // c'est bien `device_id`/`area_id`. Sans ce remappage, this.devices.set(undefined, device)
    // pour chaque device : ils s'écrasent tous mutuellement dans HaStructureRegistry, un seul
    // survit (le dernier traité).
    const devices = devicesResult.map((d) => ({ device_id: d.id, name: d.name, area_id: d.area_id }));

    this.logger.info('ha:ws', `Référentiel chargé: ${entities.length} entités, ${areas.length} areas, ${devices.length} devices`);
    this.isReady = true;

    return { entities, areas, devices, entityRegistry };
  }

  /**
   * Souscrit aux événements temps réel HA.
   */
  subscribeToEvents(): void {
    if (!this.connection) {
      this.logger.warn('ha:ws', 'subscribeToEvents() appelé sans connexion établie');
      return;
    }

    this.logger.info('ha:ws', 'Souscription aux événements temps réel');

    const conn = this.connection;
    conn.subscribeEvents<HaStateChangedMessage>((message) => this.handleStateChanged(message), 'state_changed');
    conn.subscribeEvents<HaAreaRegistryUpdatedMessage>((message) => this.handleAreaRegistryUpdated(message), 'area_registry_updated');
    conn.subscribeEvents<HaDeviceRegistryUpdatedMessage>((message) => this.handleDeviceRegistryUpdated(message), 'device_registry_updated');
    conn.subscribeEvents<HaEntityRegistryUpdatedMessage>((message) => this.handleEntityRegistryUpdated(message), 'entity_registry_updated');
  }

  /**
   * Envoie une commande à Home Assistant (via call_service).
   * @param domain - Domaine de la commande (ex: "light", "switch")
   * @param service - Service à appeler (ex: "turn_on", "turn_off")
   * @param target - Cible de la commande (ex: { entity_id: "light.salon" })
   * @param serviceData - Données du service (optionnel)
   */
  sendCommand(
    domain: string,
    service: string,
    target: { entity_id?: string | string[] },
    serviceData?: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.isAuthenticated || !this.connection) {
      throw new Error('Cannot send command: not authenticated');
    }

    return callService(this.connection, domain, service, serviceData || {}, target);
  }

  /**
   * Transmet un ordre en langage naturel à l'agent de conversation natif de HA
   * (conversation.process). Repli pour les intentions non résolues en resolved_service_call
   * (voir applications/planificateur, specs §8) — pas d'équivalent haut niveau dans
   * home-assistant-js-websocket, même échappatoire bas niveau que loadInitialRegistry().
   */
  processConversation(text: string, language = 'fr'): Promise<unknown> {
    if (!this.isAuthenticated || !this.connection) {
      throw new Error('Cannot process conversation: not authenticated');
    }

    return this.connection.sendMessagePromise({ type: 'conversation/process', text, language });
  }

  /**
   * Crée une area HA (config/area_registry/create) — même échappatoire bas niveau que
   * processConversation()/loadInitialRegistry() ci-dessus, pas d'équivalent haut niveau dans
   * home-assistant-js-websocket. Utilisé par AreaEnsureService pour garantir l'existence d'une
   * area suggérée en découverte MQTT (suggested_area), HA ne l'auto-créant pas de façon fiable.
   *
   * `icon` (mdi:xxx, demande utilisateur 12/08/2026) : accepté par le schéma WS de HA au même
   * titre que `name` (config/area_registry/create), ignoré silencieusement s'il est omis.
   */
  createArea(name: string, icon?: string): Promise<{ area_id: string; name: string; icon?: string }> {
    if (!this.isAuthenticated || !this.connection) {
      throw new Error('Cannot create area: not authenticated');
    }

    return this.connection.sendMessagePromise({ type: 'config/area_registry/create', name, ...(icon ? { icon } : {}) });
  }

  // ===========================================================================
  // Callbacks pour s'abonner aux événements
  // ===========================================================================

  onStateChanged(callback: EntityStateCallback): void {
    this.stateCallbacks.push(callback);
  }

  onAreaUpdated(callback: AreaUpdatedCallback): void {
    this.areaCallbacks.push(callback);
  }

  onDeviceUpdated(callback: DeviceUpdatedCallback): void {
    this.deviceCallbacks.push(callback);
  }

  onEntityUpdated(callback: EntityUpdatedCallback): void {
    this.entityCallbacks.push(callback);
  }

  onConnect(callback: ConnectCallback): void {
    this.connectCallbacks.push(callback);
  }

  onDisconnect(callback: DisconnectCallback): void {
    this.disconnectCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  // ===========================================================================
  // Gestion des événements HA
  // ===========================================================================

  private handleStateChanged(message: HaStateChangedMessage): void {
    const newState = message.data.new_state;
    if (newState) {
      this.notifyStateChanged(newState);
    }
  }

  private handleAreaRegistryUpdated(message: HaAreaRegistryUpdatedMessage): void {
    // action === 'delete' : HA ne renvoie pas les données de l'area supprimée, seul l'id
    // est garanti — notifié quand même, indispensable pour retirer l'area du registre.
    const area = {
      area_id: message.data.area_id,
      name: message.data.area?.name || '',
      picture: message.data.area?.picture,
      action: message.data.action,
    };
    this.notifyAreaUpdated(area);
  }

  private handleDeviceRegistryUpdated(message: HaDeviceRegistryUpdatedMessage): void {
    const device = {
      device_id: message.data.device_id,
      name: message.data.device?.name || '',
      area_id: message.data.device?.area_id,
      action: message.data.action,
    };
    this.notifyDeviceUpdated(device);
  }

  private handleEntityRegistryUpdated(message: HaEntityRegistryUpdatedMessage): void {
    const entity = {
      entity_id: message.data.entity_id,
      domain: message.data.entity?.domain || '',
      device_class: message.data.entity?.device_class,
      area_id: message.data.entity?.area_id,
      action: message.data.action,
    };
    this.notifyEntityUpdated(entity);
  }

  // ===========================================================================
  // Notifications aux callbacks
  // ===========================================================================

  private notifyStateChanged(entity: HaRawEntity): void {
    for (const callback of this.stateCallbacks) {
      try {
        callback(entity);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback state_changed: ${error}`);
      }
    }
  }

  private notifyAreaUpdated(area: { area_id: string; name: string; picture?: string; action: RegistryAction }): void {
    for (const callback of this.areaCallbacks) {
      try {
        callback(area);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback area_updated: ${error}`);
      }
    }
  }

  private notifyDeviceUpdated(device: { device_id: string; name: string; area_id?: string; action: RegistryAction }): void {
    for (const callback of this.deviceCallbacks) {
      try {
        callback(device);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback device_updated: ${error}`);
      }
    }
  }

  private notifyEntityUpdated(entity: { entity_id: string; domain: string; device_class?: string; area_id?: string; action: RegistryAction }): void {
    for (const callback of this.entityCallbacks) {
      try {
        callback(entity);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback entity_updated: ${error}`);
      }
    }
  }

  private notifyConnect(): void {
    for (const callback of this.connectCallbacks) {
      try {
        callback();
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback connect: ${error}`);
      }
    }
  }

  private notifyDisconnect(reason?: string): void {
    for (const callback of this.disconnectCallbacks) {
      try {
        callback(reason);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback disconnect: ${error}`);
      }
    }
  }

  private notifyError(error: Error): void {
    for (const callback of this.errorCallbacks) {
      try {
        callback(error);
      } catch (error) {
        this.logger.error('ha:ws', `Erreur dans callback error: ${error}`);
      }
    }
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  getIsAuthenticated(): boolean {
    return this.isAuthenticated;
  }

  getIsReady(): boolean {
    return this.isReady;
  }

  /**
   * Compare deux configurations WebSocket
   */
  private areConfigsEqual(c1: HaWsConfig, c2: HaWsConfig): boolean {
    return (
      c1.host === c2.host &&
      c1.port === c2.port &&
      c1.token === c2.token &&
      c1.reconnect_delay === c2.reconnect_delay
    );
  }

  /**
   * Reconfigure la connexion WebSocket avec une nouvelle configuration.
   * - Si déconnecté : connecte avec la nouvelle config
   * - Si connecté : compare, déconnecte et reconnecte si la config a changé
   */
  reconfigure(newConfig: HaWsConfig): void {
    // Si déconnecté, juste connecter avec la nouvelle config
    if (!this.getIsAuthenticated()) {
      this.logger.info('ha:ws', 'Reconfiguration WebSocket (déconnecté) - Connexion avec nouvelle config');
      this.currentConfig = newConfig;
      this.config = newConfig;
      this.connect();
      return;
    }

    // Si connecté, comparer avec l'ancienne config
    if (!this.areConfigsEqual(this.currentConfig, newConfig)) {
      this.logger.info('ha:ws', 'Reconfiguration WebSocket - Config changée, reconnexion...');
      this.currentConfig = newConfig;
      this.disconnect();
      this.config = newConfig;
      this.connect();
    } else {
      this.logger.debug('ha:ws', 'Reconfiguration WebSocket - Config inchangée, aucune action');
    }
  }
}

export type { HaWsMessage };
