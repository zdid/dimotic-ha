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
 */

import { MqttTransport, type MqttMessage } from '../infrastructure/transport/MqttTransport';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { IEventBus } from './IEventBus';
import type { DeploymentTargetConfig, HaStackTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

const TOPIC_PREFIX = 'dimotic/core';
/** scriptsha peut ne pas être activé/démarré sur cette machine — ne jamais bloquer indéfiniment
 *  une republication déclenchée par un changement de cible si sa réponse ne vient jamais. */
const SCRIPTSHA_GOSSIP_TIMEOUT_MS = 5000;

interface TargetsGossipPayload {
  core: DeploymentTargetConfig[];
  haStack: HaStackTargetConfig[];
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
        protocolVersion: 5
      },
      this.logger
    );

    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.connect();
    this.transport.subscribe(`${TOPIC_PREFIX}/+/known-targets`, 1);
    this.transport.subscribe(`${TOPIC_PREFIX}/+/known-scripts`, 1);

    // scriptsha (process séparé) annonce proactivement son état une fois démarré (voir
    // ScriptsHaService.start()) plutôt que d'attendre une sollicitation qui pourrait arriver avant
    // qu'il soit prêt — ce service se contente d'écouter et de relayer.
    this.eventBus.onGeneric('scriptsha:gossip:changed', () => {
      this.logger.info('TargetGossip', 'scriptsha:gossip:changed reçu — republication en cours');
      this.republishScripts();
    });

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
      haStack: this.configService.getHaStackTargets().filter((t) => t.origin !== 'gossip')
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
    }
  }

  private handleTargetsMessage(sourceMachineId: string, message: MqttMessage): void {
    let data: TargetsGossipPayload;
    try {
      data = JSON.parse(message.payload.toString());
    } catch {
      this.logger.warn('TargetGossip', `Annonce de cibles illisible reçue sur ${message.topic}, ignorée`);
      return;
    }

    this.mergeTargets(sourceMachineId, data.core || [], 'core');
    this.mergeTargets(sourceMachineId, data.haStack || [], 'haStack');
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

  private mergeTargets(
    sourceMachineId: string,
    incoming: Array<DeploymentTargetConfig | HaStackTargetConfig>,
    kind: 'core' | 'haStack'
  ): void {
    const current = kind === 'core' ? this.configService.getTargets() : this.configService.getHaStackTargets();
    const knownHosts = new Set(current.map((t) => t.host).filter(Boolean));
    const newOnes = incoming
      .filter((t) => t.host && !knownHosts.has(t.host))
      .map((t) => ({ ...t, id: `${sourceMachineId}::${t.id}`, origin: 'gossip' as const }));
    if (newOnes.length === 0) return;

    const merged = [...current, ...newOnes];
    const result = kind === 'core'
      ? this.configService.setTargets(merged as DeploymentTargetConfig[])
      : this.configService.setHaStackTargets(merged as HaStackTargetConfig[]);

    if (result.success) {
      this.logger.info(
        'TargetGossip',
        `${newOnes.length} nouvelle(s) cible(s) ${kind} apprise(s) de ${sourceMachineId}: ${newOnes.map((t) => t.host).join(', ')}`
      );
    } else {
      this.logger.error('TargetGossip', `Échec d'enregistrement des cibles ${kind} apprises de ${sourceMachineId}: ${result.error}`);
    }
  }
}
