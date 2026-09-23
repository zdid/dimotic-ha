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
import type { SaveResult } from '../infrastructure/config/writer';
import type { IEventBus } from './IEventBus';
import type { DeploymentTargetConfig, HaStackTargetConfig, Zigbee2mqttTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

const TOPIC_PREFIX = 'dimotic/core';
/** scriptsha peut ne pas être activé/démarré sur cette machine — ne jamais bloquer indéfiniment
 *  une republication déclenchée par un changement de cible si sa réponse ne vient jamais. */
const SCRIPTSHA_GOSSIP_TIMEOUT_MS = 5000;

interface TargetsGossipPayload {
  core: DeploymentTargetConfig[];
  haStack: HaStackTargetConfig[];
  zigbee2mqtt: Zigbee2mqttTargetConfig[];
  // ⭐ 17/09/2026 — site physique de la machine qui publie (core.site, voir schema.ts), diffusé au
  // même endroit que ses cibles plutôt que sur un topic dédié : toujours republié en même temps,
  // pas de risque de désynchronisation entre les deux. Optionnel : les pairs pas encore à jour
  // n'en envoient pas, `peerSites` reste simplement vide pour eux (site inconnu, jamais deviné).
  site?: string;
}

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
  /** sourceMachineId → dernier `site` annoncé par ce pair (voir TargetsGossipPayload.site) — pas
   *  persisté, reconstruit au fil des messages retenus reçus après chaque redémarrage. */
  private readonly peerSites: Map<string, string> = new Map();

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
    this.transport.subscribe(`${TOPIC_PREFIX}/+/known-targets`, 1);
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

    this.republish();
    this.logger.info('TargetGossip', `Synchronisation entre instances active (machineId: ${this.machineId})`);
  }

  stop(): void {
    this.transport?.disconnect();
  }

  /**
   * À appeler après tout changement LOCAL (ajout/suppression depuis l'IHM de CETTE machine) des
   * cibles core ou haStack — jamais après une fusion issue du gossip lui-même (voir l'en-tête :
   * seules les cibles `origin !== 'gossip'` sont republiées, ce qui exclut structurellement tout
   * écho).
   */
  republish(): void {
    if (!this.transport) return;
    const payload: TargetsGossipPayload = {
      core: this.configService.getTargets().filter((t) => t.origin !== 'gossip'),
      haStack: this.configService.getHaStackTargets().filter((t) => t.origin !== 'gossip'),
      zigbee2mqtt: this.configService.getZigbee2mqttTargets().filter((t) => t.origin !== 'gossip'),
      site: this.configService.getConfig().core.site || undefined
    };
    this.transport.publish(`${TOPIC_PREFIX}/${this.machineId}/known-targets`, JSON.stringify(payload), 1, true);
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

    if (kind === 'known-targets') {
      this.handleTargetsMessage(sourceMachineId, message);
    } else if (kind === 'known-scripts') {
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

    const prefix = `${sourceMachineId}::`;
    let changed = false;
    for (const kind of ['core', 'haStack', 'zigbee2mqtt'] as const) {
      const current = this.getTargetsFor(kind);
      if (!current.some((t) => t.id.startsWith(prefix))) continue;
      const result = this.setTargetsFor(kind, current.filter((t) => !t.id.startsWith(prefix)));
      if (result.success) changed = true;
      else this.logger.error('TargetGossip', `Échec de purge locale des cibles ${kind} de ${sourceMachineId}: ${result.error}`);
    }

    this.liveness.delete(sourceMachineId);
    this.broadcastLiveness();
    if (changed) {
      this.eventBus.emitGeneric('core:deployment:gossip:changed', undefined);
      this.logger.warn('TargetGossip', `Suppression confirmée de la machine ${sourceMachineId} reçue par gossip — cibles apprises d'elle retirées localement`);
    }
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

  private handleTargetsMessage(sourceMachineId: string, message: MqttMessage): void {
    let data: TargetsGossipPayload;
    try {
      data = JSON.parse(message.payload.toString());
    } catch {
      this.logger.warn('TargetGossip', `Annonce de cibles illisible reçue sur ${message.topic}, ignorée`);
      return;
    }

    if (data.site) this.peerSites.set(sourceMachineId, data.site);

    this.mergeTargets(sourceMachineId, data.core || [], 'core');
    this.mergeTargets(sourceMachineId, data.haStack || [], 'haStack');
    this.mergeTargets(sourceMachineId, data.zigbee2mqtt || [], 'zigbee2mqtt');
  }

  /** Site d'une cible connue (locale ou apprise par gossip) — voir TargetsGossipPayload.site.
   *  Une cible `origin: 'gossip'` a un id `{sourceMachineId}::{original}` (voir mergeTargets) ;
   *  une cible locale n'a pas ce préfixe, son site est simplement celui de CETTE machine. */
  private resolveSiteFor(target: { id: string; origin: string }): string {
    if (target.origin !== 'gossip') return this.configService.getConfig().core.site;
    const sourceMachineId = target.id.split('::')[0] ?? target.id;
    return this.peerSites.get(sourceMachineId) || '';
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

  /**
   * ⭐ 31/08/2026, réécrite en vraie réconciliation (voir en-tête de fichier) — le message reçu
   * est un instantané COMPLET des cibles locales de `sourceMachineId`, pas un diff : tout ce qui y
   * figure remplace ce qu'on savait déjà de cette source (ajout ou mise à jour d'hôte confondus),
   * et tout ce qu'on avait appris d'elle mais qui n'y figure plus est retiré. Nos propres cibles
   * locales et celles apprises d'AUTRES machines ne sont jamais touchées (filtrées par préfixe
   * `{sourceMachineId}::`).
   */
  private mergeTargets(
    sourceMachineId: string,
    incoming: Array<DeploymentTargetConfig | HaStackTargetConfig | Zigbee2mqttTargetConfig>,
    kind: 'core' | 'haStack' | 'zigbee2mqtt'
  ): void {
    const current = this.getTargetsFor(kind);
    const prefix = `${sourceMachineId}::`;
    const others = current.filter((t) => !t.id.startsWith(prefix));
    const previousForSource = current.filter((t) => t.id.startsWith(prefix));

    const incomingAsGossip = incoming
      .filter((t) => t.host)
      .map((t) => ({ ...t, id: `${prefix}${t.id}`, origin: 'gossip' as const }));

    // Rejeu identique (ex: reconnexion du client gossip, réabonnement, rejeu du message retenu) —
    // rien de neuf, on évite l'écriture disque et le bruit dans les logs.
    if (this.sameGossipSet(previousForSource, incomingAsGossip)) return;

    const merged = [...others, ...incomingAsGossip];
    const result = this.setTargetsFor(kind, merged);

    if (!result.success) {
      this.logger.error('TargetGossip', `Échec d'enregistrement des cibles ${kind} apprises de ${sourceMachineId}: ${result.error}`);
      return;
    }

    this.logGossipDiff(kind, sourceMachineId, previousForSource, incomingAsGossip);
    this.eventBus.emitGeneric('core:deployment:gossip:changed', undefined);
  }

  private getTargetsFor(kind: 'core' | 'haStack' | 'zigbee2mqtt'): Array<DeploymentTargetConfig | HaStackTargetConfig | Zigbee2mqttTargetConfig> {
    return kind === 'core' ? this.configService.getTargets()
      : kind === 'haStack' ? this.configService.getHaStackTargets()
      : this.configService.getZigbee2mqttTargets();
  }

  private setTargetsFor(
    kind: 'core' | 'haStack' | 'zigbee2mqtt',
    list: Array<DeploymentTargetConfig | HaStackTargetConfig | Zigbee2mqttTargetConfig>
  ): SaveResult {
    return kind === 'core' ? this.configService.setTargets(list as DeploymentTargetConfig[])
      : kind === 'haStack' ? this.configService.setHaStackTargets(list as HaStackTargetConfig[])
      : this.configService.setZigbee2mqttTargets(list as Zigbee2mqttTargetConfig[]);
  }

  /** Égalité structurelle, indifférente à l'ordre — un message retenu rejoué produit un payload
   *  strictement identique, donc une comparaison triée par id suffit (pas besoin de deep-equal
   *  sophistiqué : mêmes clés, mêmes valeurs primitives, JSON.stringify après tri est fiable ici). */
  private sameGossipSet(
    a: Array<{ id: string }>,
    b: Array<{ id: string }>
  ): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort((x, y) => x.id.localeCompare(y.id));
    const sortedB = [...b].sort((x, y) => x.id.localeCompare(y.id));
    return JSON.stringify(sortedA) === JSON.stringify(sortedB);
  }

  private logGossipDiff(
    kind: 'core' | 'haStack' | 'zigbee2mqtt',
    sourceMachineId: string,
    previous: Array<{ id: string; host: string }>,
    incoming: Array<{ id: string; host: string }>
  ): void {
    const previousById = new Map(previous.map((t) => [t.id, t]));
    const incomingIds = new Set(incoming.map((t) => t.id));

    const added = incoming.filter((t) => !previousById.has(t.id));
    const updated = incoming.filter((t) => {
      const before = previousById.get(t.id);
      return before !== undefined && before.host !== t.host;
    });
    const removed = previous.filter((t) => !incomingIds.has(t.id));

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} ajoutée(s) [${added.map((t) => t.host).join(', ')}]`);
    if (updated.length > 0) parts.push(`${updated.length} mise(s) à jour [${updated.map((t) => `${t.id}→${t.host}`).join(', ')}]`);
    if (removed.length > 0) parts.push(`${removed.length} retirée(s) [${removed.map((t) => t.id).join(', ')}]`);

    if (parts.length > 0) {
      this.logger.info('TargetGossip', `Cibles ${kind} de ${sourceMachineId} réconciliées : ${parts.join(', ')}`);
    }
  }
}
