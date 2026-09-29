/**
 * TargetGossipService — synchronisation "sans maître" entre toutes les instances dimotic-ha du
 * foyer (⭐ 24/08/2026, demande explicite : "chaque dimotic-ha doit connaître les machines
 * déployées... pas de machine maître", étendue ensuite aux scripts scriptsha). Couvre :
 *   - les cibles de déploiement dimotic-ha (`core.targets`)
 *   - les cibles Home Assistant + Mosquitto (`core.haStackTargets`)
 *   - les scripts scriptsha déposés localement (métadonnées + contenu YAML)
 *
 * Même patron déjà éprouvé dans ce projet pour RFXCOM (`rfxcom/{bridgeInstance}/
 * registered-devices`, topic MQTT retenu par instance, chaque abonné fusionne) : chaque machine
 * annonce, sur un topic retenu portant son propre `machineId`, UNIQUEMENT ce qu'elle a elle-même
 * localement (`origin: 'local'`) — jamais ce qu'elle a appris d'ailleurs, sous peine d'écho
 * indéfini entre instances. Toute instance abonnée au wildcard fusionne les annonces des autres
 * machines dans son propre état (`origin: 'gossip'`), sans jamais les réannoncer. Convergence
 * complète du réseau garantie par les messages retenus eux-mêmes (un nouvel abonné, ou une
 * instance qui redémarre, reçoit immédiatement l'annonce de CHAQUE machine déjà connue du broker)
 * — pas besoin de rediffusion en cascade.
 *
 * ⭐ 29/09/2026 — LES CIBLES NE PASSENT PLUS PAR ICI (demande utilisateur : « la machine ha2 est la
 * même vue depuis ha2, stfort ou orangepi2 », savoir d'où on l'a apprise n'a aucun sens) : elles
 * circulent avec data/core/config.yaml par la diffusion des données (techniques-diffusion-data_specs
 * §2ter), une machine = une ligne, sans préfixe (voir infrastructure/config/targetsCleanup.ts). Ce
 * service ne garde que la présence des machines (LWT), leur suppression explicite et les scripts
 * scriptsha. Le topic retenu `known-targets` de CETTE machine est vidé au démarrage. Les paragraphes
 * ci-dessous sur la fusion des cibles décrivent l'ancien fonctionnement.
 *
 * Utilise directement `ha.mqtt` (host/port), indépendamment de `ha.mqtt_enable` — ce flag régit la
 * découverte HA (IntegrationBridge), pas ce canal de plomberie interne au socle. Inactif si
 * `ha.mqtt.host` n'est pas configuré du tout (rien à joindre).
 *
 * scriptsha tourne en process séparé (⭐ superviseur Phase 2) : aucun accès direct au broker MQTT
 * ni à ConfigService depuis là-bas — ce service relaie dans les deux sens via l'EventBus/IPC
 * (`scriptsha:gossip:*`, voir ScriptsHaService.ts et le manifeste `bridgedEvents` de scriptsha).
 *
 * Les identifiants (cibles ou scripts) ne sont uniques qu'au sein d'une seule installation — tout
 * élément appris par gossip est donc systématiquement renommé `{machineId source}::{id d'origine}`
 * avant fusion locale, pour éviter toute collision avec un id choisi indépendamment ailleurs.
 *
 * ⭐ 31/08/2026, réconciliation + présence + suppression explicite (bug réel trouvé le même jour :
 * un changement d'IP sur une machine ne se propageait jamais aux autres, qui gardaient l'ancienne
 * adresse indéfiniment — `mergeTargets` n'ajoutait qu'une cible dont l'hôte était totalement
 * inconnu, sans jamais mettre à jour ni retirer une cible déjà apprise) :
 * - **Réconciliation automatique tant que la source est vivante** : chaque annonce `known-targets`
 *   reçue est un instantané COMPLET de ce que la machine source connaît d'elle-même (pas un diff) —
 *   `mergeTargets` upsert donc chaque cible reçue et retire toute cible apprise de cette même
 *   source qui n'apparaît plus dans l'annonce. Ni timer ni nouveau message : la source annonçant
 *   son propre changement (IP, suppression volontaire) suffit.
 * - **Présence via LWT MQTT natif** (`willTopic`, voir MqttTransport) sur `{TOPIC_PREFIX}/
 *   {machineId}/status` — même patron que les bridges applicatifs (`rfxcom/{bridgeInstance}/
 *   status`, HaMqttIntegrationService). Une machine qui devient silencieuse (LWT déclenché par le
 *   broker) est une ANOMALIE signalée (`core:machine:status:list`), jamais une suppression
 *   automatique — décision utilisateur explicite du 31/08/2026.
 * - **Suppression définitive = décision humaine** (`purgeMachine`, déclenché depuis l'UI via
 *   AppService) : publie un message de suppression retenu (`{TOPIC_PREFIX}/{machineId}/removed`)
 *   que chaque instance applique en retirant localement les cibles de cette machine — même idiome
 *   que `unpublishDiscovery` (ha/integration/discovery.ts) pour l'effacement d'un topic retenu.
 */

import { MqttTransport, type MqttMessage, LWT_PAYLOAD_ONLINE } from '../infrastructure/transport/MqttTransport';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { IEventBus } from './IEventBus';
import type { Logger } from '../infrastructure/logger';

const TOPIC_PREFIX = 'dimotic/core';
/** scriptsha peut ne pas être activé/démarré sur cette machine — ne jamais bloquer indéfiniment
 *  une republication déclenchée par un changement de cible si sa réponse ne vient jamais. */
const SCRIPTSHA_GOSSIP_TIMEOUT_MS = 5000;

interface GossipableScript {
  id: string;
  title: string;
  description: string;
  originalFilename: string;
  haDomain: 'script' | 'automation';
  content: string;
}

interface ScriptsGossipPayload {
  scripts: GossipableScript[];
}

export class TargetGossipService {
  private transport?: MqttTransport;
  private readonly machineId: string;
  /** machineId → dernier statut connu (true=online). Absent = jamais reçu de statut pour cette
   *  machine (peer pas encore mis à jour vers cette fonctionnalité, ou aucun message depuis le
   *  démarrage de CE service — un redémarrage local perd donc la mémoire du statut, mais le LWT
   *  retenu du pair la restaure dès l'abonnement, comme know-targets). */
  private readonly liveness: Map<string, boolean> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger
  ) {
    this.machineId = configService.getConfig().core.machineId;
  }

  start(): void {
    const mqttConfig = this.configService.getConfig().ha?.mqtt;
    if (!mqttConfig?.host) {
      this.logger.info('TargetGossip', 'ha.mqtt non configuré — synchronisation entre instances inactive');
      return;
    }

    this.transport = new MqttTransport(
      {
        host: mqttConfig.host,
        port: mqttConfig.port,
        clientId: `dimotic-core-gossip-${this.machineId}`,
        username: mqttConfig.username || '',
        password: mqttConfig.password || '',
        keepalive: mqttConfig.keepalive || 60,
        reconnectDelay: mqttConfig.reconnect_delay || 10,
        protocolVersion: 5,
        // ⭐ 31/08/2026 : LWT natif (voir MqttTransport) — présence de CETTE machine, retenu,
        // déclenché automatiquement par le broker sur déconnexion (propre ou non).
        willTopic: `${TOPIC_PREFIX}/${this.machineId}/status`
      },
      this.logger
    );

    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.connect();
    this.transport.subscribe(`${TOPIC_PREFIX}/+/known-scripts`, 1);
    this.transport.subscribe(`${TOPIC_PREFIX}/+/status`, 1);
    this.transport.subscribe(`${TOPIC_PREFIX}/+/removed`, 1);

    // ⭐ 31/08/2026, best-effort : efface un tombstone périmé sur NOTRE PROPRE machineId, laissé
    // par une purge passée (cas machineId réutilisé après une réinstallation/reconstruction) — sans
    // ça, un pair déjà connecté au moment de notre redémarrage garderait le souvenir "cette machine
    // a été supprimée" et ignorerait nos futures annonces. Pas garanti à 100% contre un pair qui
    // s'abonnerait dans la fenêtre exacte entre le redémarrage du broker et ce démarrage-ci — même
    // tolérance aux petites courses que le reste de ce fichier (⭐ commentaires similaires).
    this.transport.publish(`${TOPIC_PREFIX}/${this.machineId}/removed`, '', 1, true);

    // scriptsha (process séparé) annonce proactivement son état une fois démarré (voir
    // ScriptsHaService.start()) plutôt que d'attendre une sollicitation qui pourrait arriver avant
    // qu'il soit prêt — ce service se contente d'écouter et de relayer.
    this.eventBus.onGeneric('scriptsha:gossip:changed', () => {
      this.logger.info('TargetGossip', 'scriptsha:gossip:changed reçu — republication en cours');
      this.republishScripts();
    });

    // ⭐ 23/09/2026 — demande/réponse 'sauvegarde:gossip-targets:get' retirée avec le bouton
    // « Importer depuis le gossip » de l'app sauvegarde (demande explicite, test live).

    // Ancienne annonce de cibles de CETTE machine effacée (les cibles circulent désormais par la
    // diffusion de data/core/config.yaml).
    this.transport.publish(`${TOPIC_PREFIX}/${this.machineId}/known-targets`, '', 1, true);
    this.logger.info('TargetGossip', `Synchronisation entre instances active (machineId: ${this.machineId})`);
  }

  stop(): void {
    this.transport?.disconnect();
  }

  /** Demande à scriptsha (IPC) sa liste actuelle de scripts locaux, puis republie l'annonce MQTT
   *  correspondante — déclenché par `scriptsha:gossip:changed` (dépôt/suppression d'un script). */
  private republishScripts(): void {
    if (!this.transport) return;

    let settled = false;
    const onResult = (data: ScriptsGossipPayload) => {
      if (settled) return;
      settled = true;
      this.transport?.publish(`${TOPIC_PREFIX}/${this.machineId}/known-scripts`, JSON.stringify(data), 1, true);
    };
    this.eventBus.onceGeneric<ScriptsGossipPayload>('scriptsha:gossip:list:result', onResult);
    this.eventBus.emitGeneric('scriptsha:gossip:list:get', undefined);

    setTimeout(() => {
      if (settled) return;
      settled = true;
      this.eventBus.offGeneric('scriptsha:gossip:list:result', onResult);
      this.logger.warn('TargetGossip', `Pas de réponse de scriptsha après ${SCRIPTSHA_GOSSIP_TIMEOUT_MS}ms — republication de scripts annulée`);
    }, SCRIPTSHA_GOSSIP_TIMEOUT_MS);
  }

  private handleMessage(message: MqttMessage): void {
    const parts = message.topic.split('/');
    const sourceMachineId = parts[2];
    const kind = parts[3];
    // Jamais sa propre annonce (le broker peut renvoyer un message publié par soi-même) — et
    // topic malformé sans les segments attendus.
    if (!sourceMachineId || sourceMachineId === this.machineId) return;

    if (kind === 'known-scripts') {
      this.handleScriptsMessage(sourceMachineId, message);
    } else if (kind === 'status') {
      this.handleStatusMessage(sourceMachineId, message);
    } else if (kind === 'removed') {
      this.handleRemovedMessage(sourceMachineId, message);
    }
  }

  /** ⭐ 31/08/2026 : transition-only — un rejeu du même statut retenu (ex: reconnexion du client
   *  gossip, qui réabonne et reçoit à nouveau le dernier message retenu) ne doit pas re-notifier
   *  ni re-émettre — seul un changement RÉEL de statut compte comme événement. */
  private handleStatusMessage(sourceMachineId: string, message: MqttMessage): void {
    const raw = message.payload.toString();
    if (raw === '') return; // topic retenu vidé (auto-nettoyage au démarrage, ou purge) — pas un statut
    const online = raw === LWT_PAYLOAD_ONLINE;
    if (this.liveness.get(sourceMachineId) === online) return;
    this.liveness.set(sourceMachineId, online);
    this.logger[online ? 'info' : 'warn'](
      'TargetGossip',
      `Machine ${sourceMachineId} ${online ? 'de nouveau joignable' : 'injoignable (LWT/déconnexion MQTT) — anomalie signalée, aucune suppression automatique'}`
    );
    this.broadcastLiveness();
  }

  /** ⭐ 31/08/2026 : réception du message de suppression explicite (voir purgeMachine) — retire
   *  localement tout ce qu'on avait appris de cette machine, sur les 3 listes. Un payload vide
   *  (topic retenu jamais réellement purgé, ou notre propre auto-nettoyage au démarrage — voir
   *  start()) est ignoré : ce n'est pas un vrai tombstone. */
  private handleRemovedMessage(sourceMachineId: string, message: MqttMessage): void {
    if (message.payload.toString() === '') return;
    this.liveness.delete(sourceMachineId);
    this.broadcastLiveness();
  }

  /**
   * Purge une machine disparue à la demande explicite d'un humain (voir AppService.
   * handleDeploymentTargetPurge, propriétaire du retrait des 3 listes LOCALES — ce service ne
   * s'occupe que du réseau) : annonce la suppression à tout le foyer et nettoie les topics retenus
   * de la machine disparue elle-même (payload vide + retain=true efface un message retenu, même
   * convention que unpublishDiscovery dans ha/integration/discovery.ts).
   */
  purgeMachine(machineId: string): void {
    if (!this.transport) return;
    const payload = JSON.stringify({ machineId, purgedAt: new Date().toISOString() });
    this.transport.publish(`${TOPIC_PREFIX}/${machineId}/removed`, payload, 1, true);
    this.transport.publish(`${TOPIC_PREFIX}/${machineId}/known-targets`, '', 1, true);
    this.transport.publish(`${TOPIC_PREFIX}/${machineId}/known-scripts`, '', 1, true);
    this.transport.publish(`${TOPIC_PREFIX}/${machineId}/status`, '', 1, true);
    this.liveness.delete(machineId);
    this.broadcastLiveness();
    this.logger.warn('TargetGossip', `Machine ${machineId} purgée à la demande de l'utilisateur — suppression annoncée aux autres instances`);
  }

  private broadcastLiveness(): void {
    const statuses = Array.from(this.liveness.entries()).map(([machineId, online]) => ({ machineId, online }));
    this.eventBus.emit('core:machine:status:list', { statuses });
  }

  private handleScriptsMessage(sourceMachineId: string, message: MqttMessage): void {
    let data: ScriptsGossipPayload;
    try {
      data = JSON.parse(message.payload.toString());
    } catch {
      this.logger.warn('TargetGossip', `Annonce de scripts illisible reçue sur ${message.topic}, ignorée`);
      return;
    }
    if (!Array.isArray(data.scripts) || data.scripts.length === 0) return;
    // Fusion effective déléguée à scriptsha lui-même (fichiers/manifeste sous son propre
    // process) — ce service ne fait que relayer l'annonce reçue.
    this.eventBus.emitGeneric('scriptsha:gossip:learned', { sourceMachineId, scripts: data.scripts });
  }
}
