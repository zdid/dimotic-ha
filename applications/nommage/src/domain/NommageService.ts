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

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import type { INommageMqttIntegrationService } from '../ha/integration/nommage/NommageMqttIntegrationService';
import { nommageConfigSchema, type NommageConfig } from './config-schema';
import { TranslationsRepository } from './translations/TranslationsRepository';
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
  // object_id -> libellé traduit (voir TranslationsRepository). Chargé une fois au démarrage,
  // pas de rechargement à chaud pour l'instant (mécanisme de mise à jour décidé plus tard).
  private entityNameTranslations: Record<string, string>;

  // ⭐ Nombre d'entrées traitées par jour (clé "AAAA-MM-JJ", heure locale du serveur), en mémoire —
  // même limite que parsedMessagesCount/taxonomyStructures : réinitialisé au redémarrage.
  private dailyCounts: Map<string, number> = new Map();

  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configProvider: IAppConfigProvider<NommageConfig>,
    private mqttService: INommageMqttIntegrationService,
    private translationsRepository: TranslationsRepository
  ) {
    this.config = this.loadConfig();
    this.discoveryTopics = this.aggregateDiscoveryTopics();
    this.entityNameTranslations = this.translationsRepository.loadCountryTranslations(this.config.language.country);
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

    // Nommage n'a pas d'UI de configuration dédiée : les paramètres (sources MQTT, etc.) sont
    // édités via le formulaire générique "Paramètres du Module" du core, qui sauvegarde par
    // ConfigService.saveModuleConfig() (AppService.handleModuleConfigSave) — un chemin qui
    // écrit directement sur disque sans jamais émettre 'nommage:config:save' (TODO.md : ce
    // dernier n'est déclenché par aucune UI réelle). Sans ce listener, les connexions MQTT en
    // cours continuaient de tourner avec les anciens paramètres jusqu'au redémarrage complet de
    // l'application — le fichier était à jour, mais pas les clients mqtt.js déjà connectés.
    this.eventBus.on('app:module:config:saved', (data: unknown) => {
      const result = data as { moduleId: string; success: boolean };
      if (result.moduleId !== 'nommage' || !result.success) return;

      this.logger.info('NommageService',
        'Configuration sauvegardée via le formulaire générique — reconnexion des sources MQTT...');

      this.reloadConfigAndReconnectMqtt().catch((error) => {
        this.logger.error('NommageService',
          `Erreur lors de la reconnexion après sauvegarde: ${error}`);
      });
    });

    // ⭐ Second déclencheur de republication de découverte (voir HA_STATUS_TOPIC,
    // techniques-socle-ha-mqtt_specs §8.5.4 — même correctif que RFXCOM). NOMMAGE ne maintient
    // pas de liste des devices déjà vus (passthrough réactif, pas de registre local) : on
    // déclenche donc une reconnexion complète de toutes les sources plutôt qu'un "republish"
    // ciblé — un nouvel abonnement fait redélivrer par le broker tous les messages retenus
    // (les découvertes déjà publiées par zigbee2mqtt/etc.), qui repassent alors par le pipeline
    // normal (suggested_area, traductions...) comme à la connexion initiale.
    this.eventBus.on('integration:nommage:ha:online', () => {
      this.logger.info('NommageService', 'HA en ligne — reconnexion des sources MQTT pour republier la découverte');
      this.reloadConfigAndReconnectMqtt().catch((error) => {
        this.logger.error('NommageService',
          `Erreur lors de la reconnexion sur HA online: ${error}`);
      });
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

    // lieu_precis == lieu n'apporte aucune information distincte — laissé vide plutôt que
    // dupliqué avec lieu (demande utilisateur, 08/08/2026, même règle que rfxcom/taxonomy.ts).
    const precisIfDistinct = (precis: string, lieu: string): TaxonomyLevel | undefined =>
      precis.toLowerCase() === lieu.toLowerCase() ? undefined : { raw: precis, slug: this.slugify(precis) };

    if (N === 0) {
      nomLieu = undefined;
    } else if (N === 1) {
      nomLieu = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
    } else if (N === 2) {
      nomPrecis = precisIfDistinct(lieuxSegments[0], lieuxSegments[1]);
      nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
    } else if (N === 3) {
      nomPrecis = precisIfDistinct(lieuxSegments[0], lieuxSegments[1]);
      nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
      nomPere = { raw: lieuxSegments[2], slug: this.slugify(lieuxSegments[2]) };
    } else if (N >= 4) {
      nomPrecis = precisIfDistinct(lieuxSegments[0], lieuxSegments[1]);
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

    // ⭐ 12/08/2026 (demande utilisateur, config ha.forceLightForLumiere) — un QUOI "lumière"
    // relayé en tant que composant `switch` (source ne connaissant que les capacités physiques du
    // device, pas notre taxonomie) est republié en `light` : seul le topic de découverte change de
    // composant, le payload traverse tel quel (compatible avec les deux schémas). Les autres
    // entités du même device (select/number de config) ne sont jamais concernées, seul le composant
    // effectivement `switch` l'est.
    const effectiveTopic = (this.config.ha.forceLightForLumiere && parsed.quoi.slug === 'lumiere')
      ? this.rewriteSwitchTopicToLight(discoveryMessage.topic)
      : discoveryMessage.topic;

    if (effectiveTopic !== discoveryMessage.topic) {
      this.logger.info('NommageService',
        `[${discoveryMessage.sourceId}] QUOI "lumière" sur un composant switch — republié en light (${discoveryMessage.topic} → ${effectiveTopic})`);
    }

    // name explicite (ex: zigbee2mqtt "Linkquality") traverse HA sans jamais être traduit, et une
    // entité SANS name (ex: Linky EAST) reste indiscernable des autres entités du même
    // device_class — HA ne calcule un nom lui-même que depuis device_class, jamais à partir de
    // object_id. Clé = object_id (dernier segment du topic avant /config), seul identifiant
    // toujours présent — voir TranslationsRepository (point d'entrée unique, un fichier YAML par
    // pays, demande utilisateur 08/08/2026, remplace les surcharges ponctuelles côté zigbee2mqtt).
    const objectId = discoveryMessage.topic.split('/').slice(-2, -1)[0];
    const translated = objectId ? this.entityNameTranslations[objectId] : undefined;
    // Ne touche au payload QUE si une traduction existe : un `name` absent chez zigbee2mqtt
    // (ex: entités sans entrée au dictionnaire) doit rester absent, pas devenir `name: null`
    // (comportement HA différent — repli sur device_class côté HA préservé tel quel).
    if (translated !== undefined) {
      payload = { ...payload, name: translated };
    }

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
    // donc publiés sur un topic dédié, calqué sur le topic de découverte source (même convention
    // que core/discovery.ts::getAttributesTopic — "attributs" à la place de "config") : simple
    // substitution du suffixe, robuste au nombre de segments précédents (Zigbee2MQTT peut publier
    // sur 4 OU 5 segments selon la présence d'un node_id — vérifié en direct).
    if (this.config.ha.injectTaxonomyAttributes) {
      const attributesTopic = effectiveTopic.replace(/\/config$/, '/attributs');
      payload = {
        ...payload,
        json_attributes_topic: attributesTopic,
        json_attributes_template: '{{ value_json | tojson }}'
      };

      const publishEvent: PassthroughPublishEvent & { bridgeInstance: string } = {
        bridgeInstance: BRIDGE_INSTANCE,
        topic: attributesTopic,
        payload: parsed.haAttributes,
        qos: 1,
        retain: true
      };
      this.eventBus.emit('integration:nommage:passthrough:publish', publishEvent);
    }

    const event: PassthroughDiscoveryEvent & { bridgeInstance: string } = {
      bridgeInstance: BRIDGE_INSTANCE,
      sourceTopic: effectiveTopic,
      payload
    };

    this.eventBus.emit('integration:nommage:passthrough:discovery', event);

    this.logger.debug('NommageService',
      `[${discoveryMessage.sourceId}] Relayé vers HA via Passthrough MQTT (sourceTopic: ${discoveryMessage.topic})`);
  }

  // ⭐ 12/08/2026 — trouvé en test réel (voir rewriteSwitchTopicToLight) : un device "lumière"
  // équipé de VRAIES fonctionnalités de gradateur/couleur (ex: Lidl Livarno HG06104A) publie déjà
  // son état principal en `light` nativement chez Zigbee2MQTT, et n'a QUE des switches auxiliaires
  // de configuration (ex: "Ne pas déranger", verrouillage enfant) en plus — ceux-là ne doivent PAS
  // devenir des light. Seul le segment id technique (dernier avant /config, ex: "switch",
  // "switch_l1"/"switch_l2" pour un module 2 gangs — chaque canal pilote une lumière indépendante)
  // identifie de façon fiable l'état principal : les switches auxiliaires ont un id du type
  // "switch_do_not_disturb"/"switch_child_lock", jamais couvert par ce motif. `entity_category`
  // (présent côté HA pour distinguer "config"/"diagnostic") n'est PAS fiable seul : "do_not_disturb"
  // n'en porte pas dans la définition Zigbee2MQTT de ce modèle, alors que "child_lock" oui.
  private static readonly LIGHT_ELIGIBLE_OBJECT_ID = /^switch(_l\d+)?$/;

  /**
   * Remplace le composant `switch` par `light` dans un topic de découverte MQTT HA
   * (`<prefix>/<component>/[<node_id>/]<object_id>/config`, composant toujours au segment 1, juste
   * après le préfixe — vrai pour les deux formes valides, avec ou sans node_id) — uniquement si
   * l'id technique juste avant `/config` correspond à un état principal (voir
   * LIGHT_ELIGIBLE_OBJECT_ID ci-dessus), jamais pour un switch auxiliaire de configuration du même
   * device, ni pour un select/number/sensor (composant différent, jamais concernés).
   */
  private rewriteSwitchTopicToLight(topic: string): string {
    const segments = topic.split('/');
    if (segments[1] !== 'switch') return topic;
    const technicalObjectId = segments[segments.length - 2];
    if (!NommageService.LIGHT_ELIGIBLE_OBJECT_ID.test(technicalObjectId)) return topic;
    segments[1] = 'light';
    return segments.join('/');
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

  /**
   * Recharge la config depuis le provider (fichier déjà écrit par l'appelant) et reconfigure
   * toutes les connexions MQTT (déconnexion + reconnexion de toutes les sources) avec les
   * nouveaux paramètres. Factorisé hors de saveConfig() pour être aussi utilisable quand le
   * fichier a été écrit ailleurs (voir listener 'app:module:config:saved' ci-dessous).
   */
  private async reloadConfigAndReconnectMqtt(): Promise<void> {
    this.config = this.loadConfig();
    this.discoveryTopics = this.aggregateDiscoveryTopics();

    await this.mqttService.disconnect();
    await this.mqttService.connect();
    this.mqttConnected = this.mqttService.isConnected();

    this.logger.info('NommageService', 'Configuration rechargée, connexions MQTT reconfigurées avec les nouveaux paramètres');
  }

  private async saveConfig(partialConfig: Partial<NommageConfig>): Promise<void> {
    try {
      await this.configProvider.savePartialConfig(partialConfig as NommageConfig);
      await this.reloadConfigAndReconnectMqtt();

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
    mqttService: INommageMqttIntegrationService,
    translationsRepository: TranslationsRepository = new TranslationsRepository(logger)
  ): NommageService {
    return new NommageService(eventBus, logger, configProvider, mqttService, translationsRepository);
  }
}
