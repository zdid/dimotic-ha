/**
 * NommageMqttIntegrationService
 *
 * ⭐ 24/09/2026 (décision utilisateur) — plus AUCUN client MQTT propre à NOMMAGE. Les découvertes
 * brutes sont lues via la connexion MQTT du socle : abonnement `integration:nommage:passthrough:
 * subscribe` à chaque préfixe configuré (config.prefixes), réception par `integration:nommage:
 * passthrough:message` (IntegrationBridge, réabonnement automatique à chaque reconnexion du socle —
 * MqttTransport.resubscribeAll). Remplace les N connexions indépendantes aux « sources » (hôte/port/
 * identifiants par source), prévues pour d'autres brokers mais jamais utilisées ainsi.
 *
 * Même interface qu'avant pour NommageService (connect/disconnect/isConnected/getSourceStatuses) :
 * une « source » affichée = un préfixe écouté, son état = celui de la connexion MQTT du socle.
 *
 * Couche : Integration (Passerelle)
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../../../core/dist/exports';
import { nommageConfigSchema, discoveryTopicsFor, type NommageConfig } from '../../../domain/config-schema';
import type { DiscoveryMessage, SourceStatus } from '../../../domain/types';

const MODULE_NAME = 'nommage';

// ============================================================================
// Interface
// ============================================================================

export interface INommageMqttIntegrationService {
  /** (Re)lit la config et s'abonne aux préfixes configurés (si le socle est connecté — sinon à la
   *  prochaine connexion). */
  connect(): Promise<void>;
  /** Arrête de traiter les messages reçus (les abonnements du socle restent en place). */
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Un élément par préfixe écouté, état = connexion MQTT du socle. */
  getSourceStatuses(): SourceStatus[];
}

/** Retrait d'une entité à la source : message retenu VIDE sur son topic de découverte. */
export interface DiscoveryRemovedMessage {
  sourceId: string;
  topic: string;
}

// ============================================================================
// Implémentation
// ============================================================================

export class NommageMqttIntegrationService implements INommageMqttIntegrationService {
  private config: NommageConfig;
  private bridgeConnected = false;
  private active = false;
  /** Topics déjà demandés au socle — le socle les rejoue lui-même à chaque reconnexion. */
  private readonly subscribed = new Set<string>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<NommageConfig>,
    private readonly bridgeInstance: string
  ) {
    this.config = this.loadConfig();

    this.eventBus.on(`integration:${MODULE_NAME}:bridge:connection`, (data: unknown) => {
      const event = data as { bridgeInstance: string; connected: boolean };
      if (event.bridgeInstance !== this.bridgeInstance) return;
      this.bridgeConnected = event.connected;
      if (event.connected && this.active) this.subscribeAll();
      this.eventBus.emit('nommage:mqtt:status', { connected: event.connected });
    });

    this.eventBus.on(`integration:${MODULE_NAME}:passthrough:message`, (data: unknown) => {
      const event = data as { bridgeInstance: string; topic: string; payload: string };
      if (!this.active || event.bridgeInstance !== this.bridgeInstance) return;
      this.handleIncomingMessage(event.topic, event.payload ?? '');
    });
  }

  private loadConfig(): NommageConfig {
    return nommageConfigSchema.parse(this.configProvider.getAppConfig());
  }

  async connect(): Promise<void> {
    this.config = this.loadConfig();
    this.active = true;
    this.logger.info('NommageMqttIntegrationService',
      `Écoute des découvertes via la connexion MQTT du socle — préfixe(s) : ${this.config.prefixes.map((p) => p.prefix).join(', ')}`);
    if (this.bridgeConnected) this.subscribeAll();
  }

  async disconnect(): Promise<void> {
    this.active = false;
  }

  isConnected(): boolean {
    return this.bridgeConnected;
  }

  getSourceStatuses(): SourceStatus[] {
    return this.config.prefixes.map((p) => ({ id: p.prefix, connected: this.bridgeConnected }));
  }

  /** Demande au socle les abonnements manquants. Un préfixe retiré de la config reste abonné côté
   *  socle jusqu'au redémarrage de l'application, mais ses messages sont ignorés (matchPrefix). */
  private subscribeAll(): void {
    for (const { prefix } of this.config.prefixes) {
      for (const topic of discoveryTopicsFor(prefix)) {
        if (this.subscribed.has(topic)) continue;
        this.eventBus.emit(`integration:${MODULE_NAME}:passthrough:subscribe`, {
          bridgeInstance: this.bridgeInstance,
          topic,
          qos: 1
        });
        this.subscribed.add(topic);
      }
    }
  }

  // ==========================================================================
  // Réception
  // ==========================================================================

  private matchPrefix(topic: string): string | undefined {
    for (const { prefix } of this.config.prefixes) {
      if (discoveryTopicsFor(prefix).some((pattern) => topicMatchesPattern(topic, pattern))) return prefix;
    }
    return undefined;
  }

  private handleIncomingMessage(topic: string, payloadString: string): void {
    const prefix = this.matchPrefix(topic);
    if (!prefix) return; // autre abonné du socle (même module) ou préfixe retiré de la config

    if (this.config.logging?.showRawMessages) {
      this.logger.debug('NommageMqttIntegrationService', `[${prefix}] Message MQTT reçu - Topic: ${topic}`);
    }

    // ⭐ Retrait à la source (ex: appareil supprimé de zigbee2mqtt) : message retenu VIDE. Avant,
    // pris pour une « découverte » `{raw:""}` relayée telle quelle à HA — l'entité restait fantôme.
    if (payloadString.trim() === '') {
      this.eventBus.emit('nommage:discovery:removed', { sourceId: prefix, topic } satisfies DiscoveryRemovedMessage);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadString);
    } catch {
      this.logger.warn('NommageMqttIntegrationService', `[${prefix}] Découverte non-JSON ignorée sur ${topic}`);
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    this.processDiscoveryMessage(prefix, topic, payload);
  }

  private processDiscoveryMessage(sourceId: string, topic: string, payload: Record<string, unknown>): void {
    let rawName: string;

    // device.name en priorité : la convention de nommage "QUOI---LIEU" (nommage_specs §2) est
    // portée par le nom de l'APPAREIL (ex: zigbee2mqtt friendly_name "gros ballon---maison--
    // maison--rez de chaussée"), pas par le nom de chaque entité individuelle. Bug réel constaté
    // le 10/08/2026 : en donnant la priorité à payload.name, toute entité z2m ayant son propre nom
    // explicite (switch/select/diagnostic — ex: "Linkquality", "Power outage memory", "Temperature
    // breaker") parsait ce nom d'entité au lieu du nom d'appareil, ne trouvait jamais "---",
    // n'obtenait donc aucun lieu ni suggested_area — alors que les capteurs sans nom propre
    // (device_class seul, ex: temperature/power) retombaient par accident sur device.name et
    // parsaient correctement. HA n'appliquant suggested_area qu'à la toute première découverte
    // d'un device (voir AreaEnsureService), le device restait sans area de façon définitive dès
    // qu'une entité "nommée" arrivait en premier — expliquait des devices zigbee sans pièce,
    // différents à chaque redémarrage selon l'ordre d'arrivée des messages retenus.
    if (typeof (payload as { device?: { name?: string } }).device?.name === 'string') {
      rawName = (payload as { device: { name: string } }).device.name;
    } else if (typeof payload.name === 'string') {
      rawName = payload.name;
    } else if (typeof payload.raw_name === 'string') {
      rawName = payload.raw_name;
    } else {
      rawName = JSON.stringify(payload);
    }

    const discoveryMessage: DiscoveryMessage = {
      sourceId,
      rawName,
      rawQuoi: '',
      slugQuoi: '',
      rawLieux: '',
      lieuxSegments: [],
      topic,
      payload,
      timestamp: new Date()
    };

    this.eventBus.emit('nommage:discovery:raw', discoveryMessage);

    if (this.config.logging?.showRawMessages) {
      this.logger.debug('NommageMqttIntegrationService', `[${sourceId}] Message de découverte brut: ${rawName}`);
    }
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<NommageConfig>,
    bridgeInstance: string
  ): NommageMqttIntegrationService {
    return new NommageMqttIntegrationService(eventBus, logger, configProvider, bridgeInstance);
  }
}

/** Correspondance de topic MQTT (+ = un niveau, # = plusieurs niveaux). */
function topicMatchesPattern(topic: string, pattern: string): boolean {
  const topicParts = topic.split('/');
  const patternParts = pattern.split('/');
  const hashIndex = patternParts.indexOf('#');
  if (hashIndex !== -1) {
    return patternParts.slice(0, hashIndex).every((part, index) => part === '+' || part === topicParts[index]);
  }
  if (topicParts.length !== patternParts.length) return false;
  return patternParts.every((part, index) => part === '+' || part === topicParts[index]);
}
