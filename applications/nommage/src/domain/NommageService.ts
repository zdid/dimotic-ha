/**
 * NommageService
 *
 * Service métier principal de l'application NOMMAGE.
 *
 * Responsabilités :
 * - Écouter les messages de découverte bruts via EventBus (sources multiples, voir
 *   NommageMqttIntegrationService)
 * - Parser les messages selon le format QUOI---OÙ (nommage_specs_v1.0.md)
 * - Enrichir le message source avec les attributs de taxonomie et le relayer vers HA via le
 *   Passthrough MQTT du socle (fonctionnelles-nommage_specs §3.4, remplace l'ancien
 *   nommage:transmit:to-core)
 * - Gérer le statut et les erreurs
 *
 * Couche : Domain (Métier)
 * ⚠️ NE CONNAÎT PAS : MQTT, HA, Socket.io, filesystem
 *    → Tout passe par EventBus et interfaces injectées
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/src/exports';
import { getAttributesTopic } from '../../../core/src/exports';
import type { INommageMqttIntegrationService } from '../ha/integration/nommage/NommageMqttIntegrationService';
import { nommageConfigSchema, type NommageConfig } from './config-schema';
import type {
  DiscoveryMessage,
  ParsedTaxonomy,
  TaxonomyLevel,
  TaxonomyStructure,
  NommageStatus,
  PassthroughDiscoveryEvent,
  PassthroughPublishEvent,
  DailyCount
} from './types';

// ============================================================================
// Constantes
// ============================================================================

/**
 * bridge_instance utilisé par NOMMAGE pour s'enregistrer auprès du socle (IntegrationBridge) et
 * publier ses messages de découverte enrichis via le Passthrough MQTT (une seule connexion vers
 * le broker HA du socle, indépendante des sources de lecture — voir techniques-socle-ha-mqtt_specs
 * §8.5.1/§8.5.6).
 */
const BRIDGE_INSTANCE = 'main';

/** Nombre de jours affichés dans l'historique glissant des entrées traitées (fonctionnelles-nommage_specs §3.5). */
const DAILY_STATS_WINDOW_DAYS = 5;

// ============================================================================
// Interface du service
// ============================================================================

export interface INommageService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): NommageStatus;
  getTaxonomyStructures(): TaxonomyStructure[];
}

// ============================================================================
// Implémentation
// ============================================================================

export class NommageService implements INommageService {
  private parsedCount: number = 0;
  private lastParsedAt: Date | null = null;
  private taxonomyStructures: TaxonomyStructure[] = [];
  private mqttConnected: boolean = false;
  private status: NommageStatus = {
    connected: false,
    mqttConnected: false,
    discoveryTopics: [],
    parsedMessagesCount: 0,
    error: undefined,
    sources: [],
    dailyCounts: []
  };

  private config: NommageConfig;
  private discoveryTopics: string[] = [];

  // ⭐ Nombre d'entrées traitées par jour (clé "AAAA-MM-JJ", heure locale du serveur), en mémoire —
  // même limite que parsedMessagesCount/taxonomyStructures : réinitialisé au redémarrage.
  private dailyCounts: Map<string, number> = new Map();

  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configProvider: IAppConfigProvider<NommageConfig>,
    private mqttService: INommageMqttIntegrationService
  ) {
    this.config = this.loadConfig();
    this.discoveryTopics = this.aggregateDiscoveryTopics();
    this.setupEventListeners();
  }

  /**
   * Charge la config depuis le provider et applique les valeurs par défaut du schéma (le
   * provider retourne {} si la section 'nommage' n'existe pas encore dans config.yaml —
   * première installation, jamais configuré via l'UI).
   */
  private loadConfig(): NommageConfig {
    return nommageConfigSchema.parse(this.configProvider.getAppConfig());
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  async start(): Promise<void> {
    this.logger.info('NommageService', 'Démarrage du service NOMMAGE...');

    try {
      // Enregistrer le bridge auprès du socle pour pouvoir publier via le Passthrough MQTT
      // (une seule connexion socle, indépendante des N sources de lecture ci-dessous).
      this.eventBus.emit('integration:bridge:register', {
        moduleName: 'nommage',
        bridgeInstance: BRIDGE_INSTANCE
      });

      // Se connecter à toutes les sources MQTT configurées, en parallèle
      await this.mqttService.connect();
      this.mqttConnected = this.mqttService.isConnected();

      this.logger.info('NommageService',
        `Service démarré avec succès. ${this.config.sources.length} source(s), topics: ${this.discoveryTopics.join(', ')}`);

      this.updateStatus();
      this.emitStatus();
      this.emitPersistentEvents();

    } catch (error) {
      this.logger.error('NommageService',
        `Échec du démarrage: ${error}`);
      this.status.error = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('NommageService', 'Arrêt du service NOMMAGE...');

    try {
      await this.mqttService.disconnect();
      this.mqttConnected = false;

      this.eventBus.emit('integration:bridge:unregister', {
        moduleName: 'nommage',
        bridgeInstance: BRIDGE_INSTANCE
      });

      this.updateStatus();
      this.emitStatus();

      this.logger.info('NommageService', 'Service arrêté avec succès');
    } catch (error) {
      this.logger.error('NommageService',
        `Erreur lors de l'arrêt: ${error}`);
    }
  }

  // ==========================================================================
  // Gestion des événements EventBus
  // ==========================================================================

  private setupEventListeners(): void {
    this.eventBus.on('nommage:discovery:raw',
      (data: unknown) => {
        this.handleRawDiscoveryMessage(data as DiscoveryMessage);
      });

    this.eventBus.on('nommage:mqtt:status', (data: unknown) => {
      const status = data as { connected: boolean };
      this.mqttConnected = status.connected;
      this.updateStatus();
      this.emitStatus();
    });

    this.eventBus.on('nommage:status:get', () => {
      this.emitStatus();
    });

    this.eventBus.on('nommage:taxonomy:get', () => {
      this.emitTaxonomyStructure();
    });

    this.eventBus.on('nommage:config:save', (data: unknown) => {
      this.saveConfig(data as Partial<NommageConfig>);
    });
  }

  // ==========================================================================
  // Parsing des messages de découverte
  // ==========================================================================

  private handleRawDiscoveryMessage(discoveryMessage: DiscoveryMessage): void {
    this.logger.debug('NommageService',
      `[${discoveryMessage.sourceId}] Message brut reçu: ${discoveryMessage.rawName}`);

    try {
      const parsed = this.parseDiscoveryName(discoveryMessage.rawName);

      if (parsed) {
        parsed.sourceTopic = discoveryMessage.topic;
        parsed.sourcePayload = discoveryMessage.payload;

        discoveryMessage.rawQuoi = parsed.quoi.raw;
        discoveryMessage.slugQuoi = parsed.quoi.slug;
        discoveryMessage.nomPrecis = parsed.ou.precis?.raw;
        discoveryMessage.slugPrecis = parsed.ou.precis?.slug;
        discoveryMessage.nomLieu = parsed.ou.lieu?.raw;
        discoveryMessage.slugLieu = parsed.ou.lieu?.slug;
        discoveryMessage.nomPere = parsed.ou.pere?.raw;
        discoveryMessage.slugPere = parsed.ou.pere?.slug;
        discoveryMessage.nomGrandPere = parsed.ou.grandPere?.raw;
        discoveryMessage.slugGrandPere = parsed.ou.grandPere?.slug;

        const taxonomyStructure: TaxonomyStructure = {
          entityId: this.generateEntityId(parsed),
          taxonomy: parsed,
          lastUpdated: new Date()
        };

        this.taxonomyStructures.push(taxonomyStructure);

        this.parsedCount++;
        this.lastParsedAt = new Date();
        this.recordProcessedEntry(this.lastParsedAt);

        this.emitDiscoveryParsed(discoveryMessage, parsed);

        // Relayer vers HA via le Passthrough MQTT du socle (remplace transmitToCore)
        this.emitPassthroughDiscovery(discoveryMessage, parsed);

        this.logger.info('NommageService',
          `[${discoveryMessage.sourceId}] Message parsed: QUOI="${parsed.quoi.raw}" | LIEU="${parsed.ou.lieu?.raw || 'N/A'}"`);

        if (this.config.logging?.showParsedMessages) {
          this.logger.debug('NommageService',
            `Parsed: ${JSON.stringify(parsed, null, 2)}`);
        }

        this.updateStatus();
        this.emitStatus();
        this.emitTaxonomyStructure();

      } else {
        this.logger.warn('NommageService',
          `Format de nom non valide: ${discoveryMessage.rawName}`);
      }

    } catch (error) {
      this.logger.error('NommageService',
        `Erreur de parsing: ${error}`);

      this.eventBus.emit('nommage:error', {
        message: `Erreur de parsing du message: ${discoveryMessage.rawName}`,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date()
      });
    }
  }

  /**
   * Parse un nom selon le format QUOI---OÙ
   * Basé sur nommage_specs_v1.0.md
   */
  private parseDiscoveryName(rawName: string): ParsedTaxonomy | null {
    const separatorIndex = rawName.indexOf('---');

    let rawQuoi: string;
    let rawLieux: string;

    if (separatorIndex === -1) {
      rawQuoi = rawName.trim();
      rawLieux = '';
    } else {
      rawQuoi = rawName.substring(0, separatorIndex).trim();
      rawLieux = rawName.substring(separatorIndex + 3).trim();
    }

    const slugQuoi = this.slugify(rawQuoi);

    const lieuxSegments = rawLieux ? rawLieux.split('--').map(s => s.trim()) : [];
    const N = lieuxSegments.length;

    let nomPrecis: TaxonomyLevel | undefined;
    let nomLieu: TaxonomyLevel | undefined;
    let nomPere: TaxonomyLevel | undefined;
    let nomGrandPere: TaxonomyLevel | undefined;

    if (N === 0) {
      nomLieu = undefined;
    } else if (N === 1) {
      nomLieu = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
    } else if (N === 2) {
      nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
      nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
    } else if (N === 3) {
      nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
      nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
      nomPere = { raw: lieuxSegments[2], slug: this.slugify(lieuxSegments[2]) };
    } else if (N >= 4) {
      nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
      nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
      nomPere = { raw: lieuxSegments[2], slug: this.slugify(lieuxSegments[2]) };
      nomGrandPere = { raw: lieuxSegments[3], slug: this.slugify(lieuxSegments[3]) };
    }

    const taxonomy: ParsedTaxonomy = {
      quoi: { raw: rawQuoi, slug: slugQuoi },
      ou: {
        precis: nomPrecis,
        lieu: nomLieu,  // ⭐ OBLIGATOIRE pour HA
        pere: nomPere,
        grandPere: nomGrandPere
      },
      haAreaId: nomLieu ? this.slugify(nomLieu.raw) : undefined,
      haAreaName: nomLieu?.raw,
      haEntityId: nomLieu ? `nommage_${slugQuoi}_${nomLieu.slug}` : `nommage_${slugQuoi}`,
      haAttributes: {
        attributs_taxonomie: {
          quoi: rawQuoi,
          slug_quoi: slugQuoi,
          lieu_precis: nomPrecis?.raw,
          slug_precis: nomPrecis?.slug,
          lieu_principal: nomLieu?.raw,
          slug_lieu: nomLieu?.slug,
          lieu_pere: nomPere?.raw,
          slug_pere: nomPere?.slug,
          lieu_grand_pere: nomGrandPere?.raw,
          slug_grand_pere: nomGrandPere?.slug
        }
      },
      sourceTopic: '',
      sourcePayload: {}
    };

    return taxonomy;
  }

  /**
   * Normalisation slugify (basé sur nommage_specs_v1.0.md §2.2)
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
  }

  /**
   * Générer un entity_id informatif pour l'UI (n'est jamais transmis à HA : le passthrough
   * relaie le message source tel quel, HA détermine lui-même ses propres entity_id/unique_id).
   */
  private generateEntityId(parsed: ParsedTaxonomy): string {
    const quoi = parsed.quoi.slug;
    const lieu = parsed.ou.lieu?.slug || 'unknown';

    return `sensor.nommage_${quoi}_${lieu}`;
  }

  // ==========================================================================
  // Transmission vers HA — Passthrough MQTT du socle
  // ==========================================================================

  /**
   * Enrichit le message source avec les attributs de taxonomie et le relaie vers le broker HA du
   * socle via le Passthrough MQTT (mode "découverte") — remplace l'ancien transmitToCore qui
   * reconstruisait un message HA de toutes pièces et appelait l'API WebSocket.
   * Conforme à fonctionnelles-nommage_specs §3.4 et implementation-nommage_specs §5.3.
   */
  private emitPassthroughDiscovery(discoveryMessage: DiscoveryMessage, parsed: ParsedTaxonomy): void {
    let payload: Record<string, unknown> = { ...discoveryMessage.payload };

    // suggested_area (lieu de taxonomie, pas lieu_precis) — HA ne s'en sert qu'une fois, à la
    // création de l'entité, pour lui assigner automatiquement une area si elle n'en a pas déjà
    // une. Appliqué indépendamment de ha.injectTaxonomyAttributes (concerne les attributs
    // d'entité, pas l'area du device) ; ne modifie le bloc device relayé que s'il existe déjà
    // (on ne fabrique pas de device pour une source qui n'en déclarait pas).
    const existingDevice = payload.device;
    if (parsed.ou.lieu?.raw && existingDevice && typeof existingDevice === 'object') {
      payload = {
        ...payload,
        device: { ...(existingDevice as Record<string, unknown>), suggested_area: parsed.ou.lieu.raw }
      };
    }

    // attributs_taxonomie glissé directement dans la découverte n'atteint jamais entity.attributes
    // (HA valide contre un schéma strict par plateforme, ignore les clés non reconnues — vérifié
    // en direct sur une instance HA réelle). Le state_topic de l'entité relayée appartient à la
    // source tierce (ex: Zigbee2MQTT) : contrairement à evoo7/rfxcom, NOMMAGE ne le contrôle pas et
    // ne peut pas se fier à son format pour y superposer json_attributes_topic — les attributs sont
    // donc publiés sur un topic dédié que NOMMAGE possède, déclaré dans la découverte relayée.
    if (this.config.ha.injectTaxonomyAttributes) {
      const attributesTopic = getAttributesTopic('nommage', BRIDGE_INSTANCE, parsed.haEntityId || parsed.quoi.slug);
      payload = {
        ...payload,
        json_attributes_topic: attributesTopic,
        json_attributes_template: '{{ value_json.attributes | tojson }}'
      };

      const publishEvent: PassthroughPublishEvent & { bridgeInstance: string } = {
        bridgeInstance: BRIDGE_INSTANCE,
        topic: attributesTopic,
        payload: { attributes: parsed.haAttributes },
        qos: 1,
        retain: true
      };
      this.eventBus.emit('integration:nommage:passthrough:publish', publishEvent);
    }

    const event: PassthroughDiscoveryEvent & { bridgeInstance: string } = {
      bridgeInstance: BRIDGE_INSTANCE,
      sourceTopic: discoveryMessage.topic,
      payload
    };

    this.eventBus.emit('integration:nommage:passthrough:discovery', event);

    this.logger.debug('NommageService',
      `[${discoveryMessage.sourceId}] Relayé vers HA via Passthrough MQTT (sourceTopic: ${discoveryMessage.topic})`);
  }

  // ==========================================================================
  // Statistiques journalières (fenêtre glissante de 5 jours)
  // ==========================================================================

  private toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Incrémente le compteur du jour et purge les entrées plus anciennes que la fenêtre affichée
   * (évite une croissance illimitée de la Map sur un processus longue durée).
   */
  private recordProcessedEntry(at: Date): void {
    const key = this.toIsoDate(at);
    this.dailyCounts.set(key, (this.dailyCounts.get(key) || 0) + 1);

    const cutoff = new Date(at);
    cutoff.setDate(cutoff.getDate() - (DAILY_STATS_WINDOW_DAYS - 1));
    const cutoffKey = this.toIsoDate(cutoff);
    for (const existingKey of this.dailyCounts.keys()) {
      if (existingKey < cutoffKey) {
        this.dailyCounts.delete(existingKey);
      }
    }
  }

  /**
   * Retourne toujours DAILY_STATS_WINDOW_DAYS entrées (plus ancien → plus récent), 0 pour les
   * jours sans entrée traitée — conforme à la demande d'affichage "par jour sur 5 jours".
   */
  private getDailyCountsLastDays(): DailyCount[] {
    const result: DailyCount[] = [];
    const today = new Date();

    for (let i = DAILY_STATS_WINDOW_DAYS - 1; i >= 0; i--) {
      const day = new Date(today);
      day.setDate(day.getDate() - i);
      const key = this.toIsoDate(day);
      result.push({ date: key, count: this.dailyCounts.get(key) || 0 });
    }

    return result;
  }

  // ==========================================================================
  // Émission des événements Socket.io
  // ==========================================================================

  private emitStatus(): void {
    this.status = {
      ...this.status,
      connected: true,
      mqttConnected: this.mqttConnected,
      discoveryTopics: this.discoveryTopics,
      parsedMessagesCount: this.parsedCount,
      lastParsedAt: this.lastParsedAt || undefined,
      error: undefined,
      sources: this.mqttService.getSourceStatuses(),
      dailyCounts: this.getDailyCountsLastDays()
    };

    this.eventBus.emit('nommage:status', this.status);
  }

  private emitDiscoveryParsed(discoveryMessage: DiscoveryMessage, parsed: ParsedTaxonomy): void {
    this.eventBus.emit('nommage:discovery:parsed', {
      sourceId: discoveryMessage.sourceId,
      discoveryMessage: {
        rawName: discoveryMessage.rawName,
        topic: discoveryMessage.topic,
        payload: discoveryMessage.payload
      },
      parsedTaxonomy: parsed,
      timestamp: new Date()
    });
  }

  private emitTaxonomyStructure(): void {
    this.eventBus.emit('nommage:taxonomy:structure', {
      structures: this.taxonomyStructures,
      count: this.taxonomyStructures.length,
      timestamp: new Date()
    });
  }

  private emitPersistentEvents(): void {
    this.emitStatus();
    this.emitTaxonomyStructure();
  }

  // ==========================================================================
  // Gestion de la configuration
  // ==========================================================================

  private aggregateDiscoveryTopics(): string[] {
    return this.config.sources.flatMap((source) => source.mqtt.discoveryTopics);
  }

  private async saveConfig(partialConfig: Partial<NommageConfig>): Promise<void> {
    try {
      await this.configProvider.savePartialConfig(partialConfig as NommageConfig);
      this.config = this.loadConfig();
      this.discoveryTopics = this.aggregateDiscoveryTopics();

      // Reconfigurer toutes les connexions MQTT (déconnexion + reconnexion de toutes les sources)
      await this.mqttService.disconnect();
      await this.mqttService.connect();
      this.mqttConnected = this.mqttService.isConnected();

      this.logger.info('NommageService', 'Configuration sauvegardée et appliquée');

      this.eventBus.emit('nommage:config:saved', {
        success: true,
        config: this.config
      });

    } catch (error) {
      this.logger.error('NommageService',
        `Erreur de sauvegarde de la config: ${error}`);

      this.eventBus.emit('nommage:config:saved', {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getStatus(): NommageStatus {
    return { ...this.status };
  }

  getTaxonomyStructures(): TaxonomyStructure[] {
    return [...this.taxonomyStructures];
  }

  private updateStatus(): void {
    this.status = {
      ...this.status,
      connected: true,
      mqttConnected: this.mqttConnected,
      discoveryTopics: this.discoveryTopics,
      parsedMessagesCount: this.parsedCount,
      lastParsedAt: this.lastParsedAt || undefined,
      error: undefined,
      sources: this.mqttService.getSourceStatuses(),
      dailyCounts: this.getDailyCountsLastDays()
    };
  }

  // ==========================================================================
  // Factory
  // ==========================================================================

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<NommageConfig>,
    mqttService: INommageMqttIntegrationService
  ): NommageService {
    return new NommageService(eventBus, logger, configProvider, mqttService);
  }
}
