/**
 * NommageMqttIntegrationService
 *
 * Service d'intégration MQTT pour l'application NOMMAGE.
 * Gère une connexion MQTT indépendante par source configurée (config.sources[]), toutes actives
 * simultanément — pas une seule connexion globale. Chaque source a son propre client
 * mqtt.MqttClient, sa propre reconnexion (gérée par mqtt.js, indépendante des autres sources),
 * ses propres topics.
 *
 * Conforme à fonctionnelles-nommage_specs_v1.1.md §3.1 et implementation-nommage_specs_v1.1.md §4.1.
 *
 * Couche : HA (Intégration)
 * Rôle : Abstraction MQTT pour les modules de découverte
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../../../core/dist/exports';
import { nommageConfigSchema, type NommageConfig, type NommageSourceConfig } from '../../../domain/config-schema';
import type { DiscoveryMessage, SourceStatus } from '../../../domain/types';
import * as mqtt from 'mqtt';

// ============================================================================
// Interface du service
// ============================================================================

export interface INommageMqttIntegrationService {
  /** Connecte toutes les sources configurées, en parallèle. */
  connect(): Promise<void>;
  /** Déconnecte toutes les sources. */
  disconnect(): Promise<void>;
  /** true si au moins une source est actuellement connectée. */
  isConnected(): boolean;
  /** Statut détaillé de chaque source configurée (id + connectée ou non). */
  getSourceStatuses(): SourceStatus[];
}

// ============================================================================
// Implémentation
// ============================================================================

export class NommageMqttIntegrationService implements INommageMqttIntegrationService {
  // Une connexion MQTT par source, stockée par sourceId
  private clients: Map<string, mqtt.MqttClient> = new Map();
  private connectedSources: Set<string> = new Set();
  private config: NommageConfig;

  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configProvider: IAppConfigProvider<NommageConfig>
  ) {
    this.config = this.loadConfig();
  }

  /**
   * Charge la config depuis le provider et applique les valeurs par défaut du schéma (le
   * provider retourne {} si la section 'nommage' n'existe pas encore dans config.yaml).
   */
  private loadConfig(): NommageConfig {
    return nommageConfigSchema.parse(this.configProvider.getAppConfig());
  }

  // ==========================================================================
  // Connexion MQTT — toutes les sources en parallèle
  // ==========================================================================

  async connect(): Promise<void> {
    this.config = this.loadConfig();

    this.logger.info('NommageMqttIntegrationService',
      `Connexion de ${this.config.sources.length} source(s) MQTT en parallèle...`);

    // Chaque source se connecte indépendamment : l'échec d'une source ne doit pas
    // empêcher les autres de démarrer (fonctionnelles-nommage_specs §3.1).
    const results = await Promise.allSettled(
      this.config.sources.map((source) => this.connectSource(source))
    );

    results.forEach((result, index) => {
      const source = this.config.sources[index];
      if (result.status === 'rejected') {
        this.logger.error('NommageMqttIntegrationService',
          `Échec de connexion de la source "${source?.id}": ${result.reason}`);
      }
    });

    if (this.connectedSources.size === 0 && this.config.sources.length > 0) {
      throw new Error('Aucune source MQTT n\'a pu être connectée');
    }
  }

  private connectSource(source: NommageSourceConfig): Promise<void> {
    const brokerUrl = this.buildBrokerUrl(source);

    this.logger.info('NommageMqttIntegrationService',
      `[${source.id}] Tentative de connexion MQTT à ${brokerUrl}...`);

    const options: mqtt.IClientOptions = {
      clientId: source.mqtt.clientId,
      keepalive: source.mqtt.keepalive,
      reconnectPeriod: source.mqtt.reconnectPeriod,
      clean: source.mqtt.cleanSession,
      username: source.mqtt.username,
      password: source.mqtt.password,
      rejectUnauthorized: source.mqtt.rejectUnauthorized
    };

    const client = mqtt.connect(brokerUrl, options);
    this.clients.set(source.id, client);
    this.setupMqttEventHandlers(source, client);

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error(`[${source.id}] Timeout de connexion MQTT`));
      }, 30000);

      client.once('connect', async () => {
        clearTimeout(connectTimeout);
        this.logger.info('NommageMqttIntegrationService',
          `[${source.id}] Connecté au broker MQTT avec succès`);
        this.connectedSources.add(source.id);
        this.emitStatusChange();

        try {
          await this.subscribeSourceTopics(source, client);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      client.once('error', (err) => {
        clearTimeout(connectTimeout);
        this.logger.error('NommageMqttIntegrationService',
          `[${source.id}] Erreur de connexion MQTT: ${err.message}`);
        reject(err);
      });
    });
  }

  private buildBrokerUrl(source: NommageSourceConfig): string {
    const protocol = source.mqtt.useTls ? 'mqtts' : 'mqtt';
    return `${protocol}://${source.mqtt.host}:${source.mqtt.port}`;
  }

  private setupMqttEventHandlers(source: NommageSourceConfig, client: mqtt.MqttClient): void {
    client.on('message', (topic: string, payload: Buffer) => {
      this.handleIncomingMessage(source, topic, payload);
    });

    client.on('close', () => {
      this.logger.warn('NommageMqttIntegrationService', `[${source.id}] Déconnecté du broker MQTT`);
      this.connectedSources.delete(source.id);
      this.emitStatusChange();
    });

    client.on('error', (err: Error) => {
      this.logger.error('NommageMqttIntegrationService', `[${source.id}] Erreur MQTT: ${err.message}`);
    });

    client.on('reconnect', () => {
      this.logger.info('NommageMqttIntegrationService', `[${source.id}] Tentative de reconnexion MQTT...`);
    });

    client.on('offline', () => {
      this.logger.warn('NommageMqttIntegrationService', `[${source.id}] Client MQTT hors ligne`);
      this.connectedSources.delete(source.id);
      this.emitStatusChange();
    });
  }

  private emitStatusChange(): void {
    // La perte d'une source ne doit pas interrompre le traitement des autres : le statut global
    // reflète "au moins une source connectée" (fonctionnelles-nommage_specs §3.1, §8.1).
    this.eventBus.emit('nommage:mqtt:status', {
      connected: this.connectedSources.size > 0,
      connectedSources: Array.from(this.connectedSources),
      totalSources: this.config.sources.length,
      timestamp: new Date()
    });
  }

  // ==========================================================================
  // Traitement des messages entrants
  // ==========================================================================

  private handleIncomingMessage(source: NommageSourceConfig, topic: string, payload: Buffer): void {
    try {
      const message = this.parseMessage(topic, payload);

      if (this.config.logging?.showRawMessages) {
        this.logger.debug('NommageMqttIntegrationService',
          `[${source.id}] Message MQTT reçu - Topic: ${topic}`);
      }

      if (this.isDiscoveryTopic(source, topic)) {
        this.processDiscoveryMessage(source.id, topic, message);
      }
    } catch (error) {
      this.logger.error('NommageMqttIntegrationService',
        `[${source.id}] Erreur lors du traitement du message MQTT: ${error}`);
    }
  }

  private parseMessage(topic: string, payload: Buffer): Record<string, unknown> {
    try {
      const payloadString = payload.toString('utf8');
      return JSON.parse(payloadString);
    } catch {
      this.logger.warn('NommageMqttIntegrationService',
        `Message non-JSON reçu sur ${topic}, traitement comme chaîne brute`);
      return { raw: payload.toString('utf8') };
    }
  }

  private isDiscoveryTopic(source: NommageSourceConfig, topic: string): boolean {
    const { topicPrefix, discoveryTopics } = source.mqtt;

    if (topicPrefix && !topic.startsWith(topicPrefix)) {
      return false;
    }

    return discoveryTopics.some((pattern) => this.topicMatchesPattern(topic, pattern));
  }

  private topicMatchesPattern(topic: string, pattern: string): boolean {
    // Simple wildcard matching (+ = un niveau, # = plusieurs niveaux)
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');

    if (patternParts.includes('#')) {
      const hashIndex = patternParts.indexOf('#');
      return patternParts.slice(0, hashIndex).every((part, index) =>
        part === '+' || part === topicParts[index]
      );
    }

    if (topicParts.length !== patternParts.length) {
      return false;
    }

    return patternParts.every((part, index) => part === '+' || part === topicParts[index]);
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
    if (typeof payload === 'object' && payload &&
        typeof (payload as { device?: { name?: string } }).device?.name === 'string') {
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

    // Émettre le message brut vers le service métier pour parsing
    this.eventBus.emit('nommage:discovery:raw', discoveryMessage);

    if (this.config.logging?.showRawMessages) {
      this.logger.debug('NommageMqttIntegrationService',
        `[${sourceId}] Message de découverte brut: ${rawName}`);
    }
  }

  // ==========================================================================
  // Abonnements MQTT
  // ==========================================================================

  private async subscribeSourceTopics(source: NommageSourceConfig, client: mqtt.MqttClient): Promise<void> {
    const qos = source.mqtt.qos as 0 | 1 | 2;

    for (const topic of source.mqtt.discoveryTopics) {
      await new Promise<void>((resolve, reject) => {
        client.subscribe(topic, { qos }, (err) => {
          if (err) {
            this.logger.error('NommageMqttIntegrationService',
              `[${source.id}] Erreur d'abonnement à ${topic}: ${err.message}`);
            reject(err);
          } else {
            this.logger.info('NommageMqttIntegrationService',
              `[${source.id}] Abonné à ${topic} (QoS: ${qos})`);
            resolve();
          }
        });
      });
    }
  }

  // ==========================================================================
  // Déconnexion — toutes les sources
  // ==========================================================================

  async disconnect(): Promise<void> {
    const clients = Array.from(this.clients.values());

    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.end(true, {}, () => resolve());
          })
      )
    );

    this.clients.clear();
    this.connectedSources.clear();
    this.logger.info('NommageMqttIntegrationService', 'Toutes les sources MQTT déconnectées');
    this.emitStatusChange();
  }

  isConnected(): boolean {
    return this.connectedSources.size > 0;
  }

  getSourceStatuses(): SourceStatus[] {
    return this.config.sources.map((source) => ({
      id: source.id,
      connected: this.connectedSources.has(source.id)
    }));
  }

  // ==========================================================================
  // Factory
  // ==========================================================================

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<NommageConfig>
  ): NommageMqttIntegrationService {
    return new NommageMqttIntegrationService(eventBus, logger, configProvider);
  }
}
