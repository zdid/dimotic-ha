/**
 * AppGossipService — registre décentralisé des applications actives sur chaque machine d'un même
 * site (⭐ 27/08/2026, demande utilisateur : visibilité multi-machines — "toutes les machines avec
 * un core aient une vision des applications des autres machines afin de pouvoir les afficher").
 *
 * Même patron que `TargetGossipService` (voir son en-tête pour le raisonnement complet, repris ici
 * sans le dupliquer) : chaque machine annonce, sur un topic MQTT RETENU portant son propre
 * `machineId`, UNIQUEMENT ce qu'elle connaît localement — jamais ce qu'elle a appris d'ailleurs
 * (pas d'écho). Toute instance abonnée au wildcard fusionne dans un registre agrégé, tenu à jour en
 * mémoire, jamais persisté sur disque (redécouvert à chaque démarrage via les messages retenus).
 *
 * Différence volontaire avec `TargetGossipService::mergeTargets()` : PAS de renommage
 * `{machineId}::{id}` — qu'une même application tourne sur plusieurs machines et apparaisse donc
 * plusieurs fois dans le registre agrégé (une entrée par (machineId, appId)) est le comportement
 * voulu ici, pas une collision à éviter (demande explicite : "nous savons que la même application
 * peut tourner à plusieurs machines, elle apparaîtra donc plusieurs fois").
 *
 * Portée strictement intra-site : ce registre ne franchit jamais un site (un site = un broker MQTT
 * indépendant, voir §0 du plan de mise en œuvre) — aucune fusion de visibilité entre sites,
 * décision explicite de l'utilisateur.
 */

import { MqttTransport, type MqttMessage } from '../infrastructure/transport/MqttTransport';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { IEventBus } from './IEventBus';
import type { Logger } from '../infrastructure/logger';
import type { ApplicationModule } from '../types/config';
import { isRunningInDocker } from '../infrastructure/runtime/docker';
import { getPrimaryIPv4Address } from '../infrastructure/runtime/network';

const TOPIC_PREFIX = 'dimotic/core';

export interface RemoteAppEntry {
  id: string;
  name: string;
  icon: string;
  audience?: 'inspection' | 'configuration' | 'end-user';
}

export interface MachineAppsAnnouncement {
  machineId: string;
  address?: string;
  webPort: number;
  runningInDocker: boolean;
  apps: RemoteAppEntry[];
}

/** Payload publié sur le topic — mêmes champs que `MachineAppsAnnouncement` moins `machineId`
 *  (déjà porté par le topic lui-même, comme pour `TargetGossipService`). */
type AppsGossipPayload = Omit<MachineAppsAnnouncement, 'machineId'>;

export class AppGossipService {
  private transport?: MqttTransport;
  private readonly machineId: string;
  /** Registre agrégé des AUTRES machines — ne contient jamais sa propre annonce. */
  private readonly registry = new Map<string, MachineAppsAnnouncement>();

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
      this.logger.info('AppGossip', "ha.mqtt non configuré — registre d'applications inter-machines inactif");
      return;
    }

    this.transport = new MqttTransport(
      {
        host: mqttConfig.host,
        port: mqttConfig.port,
        clientId: `dimotic-core-appgossip-${this.machineId}`,
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
    this.transport.subscribe(`${TOPIC_PREFIX}/+/known-apps`, 1);

    // app:modules:registered déjà émis par AppService à chaque (re)détection des modules locaux —
    // même source que app:modules:list côté frontend (voir SocketBridge.ts), pas de nouvelle
    // dérivation à construire.
    this.eventBus.on('app:modules:registered', ({ modules }: { modules: ApplicationModule[] }) => {
      this.republish(modules);
    });

    this.logger.info('AppGossip', `Registre d'applications inter-machines actif (machineId: ${this.machineId})`);
  }

  stop(): void {
    this.transport?.disconnect();
  }

  /** Registre agrégé de toutes les AUTRES machines connues (jamais soi-même) — consommé par
   *  SocketBridge pour l'exposer au frontend (nouvelle page d'accueil). */
  getRegistry(): MachineAppsAnnouncement[] {
    return [...this.registry.values()];
  }

  private republish(modules: ApplicationModule[]): void {
    if (!this.transport) return;
    const payload: AppsGossipPayload = {
      address: getPrimaryIPv4Address(),
      webPort: this.configService.getConfig().web.port,
      runningInDocker: isRunningInDocker(),
      apps: modules
        .filter((m) => m.id !== 'core')
        .map((m) => ({ id: m.id, name: m.name, icon: m.icon, audience: m.audience }))
    };
    this.transport.publish(`${TOPIC_PREFIX}/${this.machineId}/known-apps`, JSON.stringify(payload), 1, true);
  }

  private handleMessage(message: MqttMessage): void {
    const parts = message.topic.split('/');
    const sourceMachineId = parts[2];
    // Jamais sa propre annonce (le broker peut la renvoyer) — topic malformé sans segment attendu.
    if (!sourceMachineId || sourceMachineId === this.machineId) return;

    let data: AppsGossipPayload;
    try {
      data = JSON.parse(message.payload.toString());
    } catch {
      this.logger.warn('AppGossip', `Annonce d'applications illisible reçue sur ${message.topic}, ignorée`);
      return;
    }
    if (!Array.isArray(data.apps)) return;

    this.registry.set(sourceMachineId, { machineId: sourceMachineId, ...data });
    this.logger.info('AppGossip', `Registre mis à jour pour ${sourceMachineId}: ${data.apps.length} application(s)`);
    // Générique (pas dans AppEvents typé) — même convention que scriptsha:gossip:* de
    // TargetGossipService, écouté par SocketBridge pour relayer vers le frontend.
    this.eventBus.emitGeneric('app:remote-registry:changed', this.getRegistry());
  }
}
