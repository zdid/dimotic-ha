/**
 * Module principal de l'application NOMMAGE
 * 
 * Ce fichier est scanné par AppService pour la détection automatique.
 * Il doit exporter :
 * - NOMMAGE_APP : ApplicationModule (métadonnées)
 * - createNommageService : Factory de service
 * 
 * ⚠️ Le nom du répertoire (nommage) DOIT correspondre à l'ID déclaré ici.
 * 
 * NOUVEAU v1.0 : Configuration pour un chapitre de menu dédié "Nommage"
 */

import { 
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider
} from '../../../core/dist/exports';
import { NOMMAGE_SOCKET_EVENTS, NOMMAGE_ALL_EVENTS, NOMMAGE_PERSISTENT_EVENTS } from './socket-events';
import { NommageService, INommageService } from './NommageService';
import { NommageMqttIntegrationService, INommageMqttIntegrationService } from '../ha/integration/nommage/NommageMqttIntegrationService';
import { DEFAULT_NOMMAGE_CONFIG, type NommageConfig } from './config-schema';

// ============================================================================
// Types pour la configuration du menu
// ============================================================================

/**
 * Configuration d'une entrée de menu
 */
export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
  parentId?: string;
}

/**
 * Configuration du menu pour une application
 */
export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

// ============================================================================
// Métadonnées UI (pour la configuration dans l'interface)
// ============================================================================

export const NOMMAGE_UI_METADATA: ModuleUiMetadata = {
  title: 'NOMMAGE - Conventions de Nommage',
  description: 'Application de gestion des conventions de nommage QUOI/OÙ pour Home Assistant. Parse les messages de découverte MQTT et normalise les noms selon le protocole unifié.',
  icon: '🏷️',
  category: 'Nommage',
  menuLabel: 'Nommage',
  menuIcon: '🏷️',
  menuOrder: 10,
  menuPath: '/nommage/config',
  badge: 'MQTT',

  // ⭐ v1.2 : les sources MQTT (config.sources[], une ou plusieurs, ajout/suppression dynamique)
  // avaient nécessité une page de config dédiée (presentation/nommage/config.html) tant que le
  // formulaire générique ne savait pas rendre un tableau dynamique. Type 'array' ajouté au socle
  // (Alpine x-for/x-model) — la page dédiée est retirée, tout tient maintenant ici. Seule
  // mqtt.discoveryTopics (tableau de chaînes DANS chaque source) reste non éditable ici : un
  // sous-champ de type 'array' imbriqué dans un élément de tableau n'est pas supporté par le
  // socle — garde ses valeurs par défaut (ou modification via config.yaml directement).
  fields: [
    {
      title: 'Sources MQTT',
      description: 'Une ou plusieurs connexions MQTT indépendantes, toutes actives en même temps (ex : le broker HA lui-même, et séparément Zigbee2MQTT sur un préfixe de topics différent).',
      icon: '📡',
      fields: [
        {
          name: 'sources',
          label: 'Sources',
          type: 'array',
          itemLabel: 'Source',
          minItems: 1,
          // Sans ça, une config fraîche sans clé 'sources' du tout affiche un tableau vide (0
          // élément) au lieu d'une première source pré-remplie — même défaut que le schéma Zod
          // (nommageConfigSchema), réutilisé ici comme seule source de vérité.
          default: DEFAULT_NOMMAGE_CONFIG.sources,
          itemFields: [
            { name: 'id', label: 'Identifiant de la source', type: 'text', required: true, placeholder: 'ha-broker', hint: 'Identifiant unique (ex: "ha-broker", "zigbee2mqtt")' },
            { name: 'mqtt.clientId', label: 'Client ID MQTT', type: 'text', required: true, placeholder: 'nommage-app', hint: 'Doit être unique entre toutes les sources' },
            { name: 'mqtt.host', label: 'Hôte MQTT', type: 'text', required: true, placeholder: '192.168.1.100', default: 'localhost' },
            { name: 'mqtt.port', label: 'Port MQTT', type: 'number', required: true, min: 1, max: 65535, default: 1883 },
            { name: 'mqtt.username', label: 'Utilisateur MQTT', type: 'text', placeholder: 'user' },
            { name: 'mqtt.password', label: 'Mot de passe MQTT', type: 'password', placeholder: 'password' },
            { name: 'mqtt.topicPrefix', label: 'Préfixe des Topics', type: 'text', required: true, placeholder: 'ha/', default: 'ha/', hint: 'Préfixe du 1er terme des topics de cette source' },
            {
              name: 'mqtt.qos', label: 'QoS', type: 'select', default: 1,
              options: [
                { value: '0', label: '0 - Au maximum une fois' },
                { value: '1', label: '1 - Au moins une fois' },
                { value: '2', label: '2 - Exactement une fois' }
              ]
            },
            { name: 'mqtt.retain', label: 'Conserver les messages retain', type: 'boolean', default: true },
            { name: 'mqtt.useTls', label: 'Utiliser TLS (mqtts://)', type: 'boolean', default: false }
          ]
        }
      ]
    },
    {
      title: 'Home Assistant',
      description: 'Configuration de la transmission vers Home Assistant (Passthrough MQTT)',
      icon: '🏠',
      fields: [
        {
          name: 'ha.injectTaxonomyAttributes',
          label: 'Injecter les attributs de taxonomie',
          type: 'boolean',
          default: true,
          description: 'Ajouter les attributs de taxonomie au message relayé vers HA'
        },
        {
          name: 'ha.waitForHaWsBeforeDiscovery',
          label: 'Attendre la synchronisation HA avant de relayer les découvertes',
          type: 'boolean',
          default: true,
          description: "Évite de créer des entités sans area assignée (HA n'applique l'area suggérée qu'une seule fois, à la création) — désactiver si les entités doivent apparaître même quand HA WebSocket est indisponible."
        }
      ]
    },
    {
      title: 'Langue',
      description: "Pays dont les traductions de noms d'entité sont utilisées (voir TranslationsRepository) — un pays inconnu est généré automatiquement au démarrage (libellés en anglais par défaut, à corriger ensuite dans data/nommage/translations/).",
      icon: '🌍',
      fields: [
        {
          name: 'language.country',
          label: 'Pays',
          type: 'text',
          default: 'France',
          placeholder: 'France',
          hint: 'Nom de pays, pas un code de langue ISO (ex: "France", pas "fr")'
        }
      ]
    },
    {
      title: 'Logging',
      description: 'Configuration des logs de l\'application',
      icon: '📜',
      fields: [
        {
          name: 'logging.level',
          label: 'Niveau de Log',
          type: 'select',
          options: ['debug', 'info', 'warn', 'error'],
          default: 'info'
        },
        {
          name: 'logging.showRawMessages',
          label: 'Afficher les messages bruts',
          type: 'boolean',
          default: false,
          description: 'Afficher les messages MQTT bruts dans les logs'
        },
        {
          name: 'logging.showParsedMessages',
          label: 'Afficher les messages parsés',
          type: 'boolean',
          default: false,
          description: 'Afficher les messages parsés dans les logs'
        }
      ]
    }
  ]
};

// ============================================================================
// Configuration du Menu pour NOMMAGE
// ============================================================================

export const NOMMAGE_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Nommage',
  entry: {
    // Chemin interne, pas une vraie route servie — Sidebar.ts ne suit une navigation réelle que
    // pour un entry.path commençant par '/applications/' ; sinon il route vers le formulaire
    // générique (showModuleConfig()), ce qu'on veut ici depuis le retrait de la page dédiée.
    label: 'Nommage',
    icon: '🏷️',
    path: '/nommage/config',
    order: 20,
    badge: 'MQTT'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/nommage/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du Module NOMMAGE
// ============================================================================

export const NOMMAGE_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'nommage',
  name: 'NOMMAGE',
  description: 'Application de gestion des conventions de nommage et taxonomie pour Home Assistant. Écoute une ou plusieurs sources MQTT simultanément, parse les noms selon le format QUOI---OÙ, et relaie les messages enrichis vers HA via le Passthrough MQTT du socle.',
  icon: '🏷️',
  
  menu: NOMMAGE_MENU_CONFIG,
  
  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'nommage',
  configUi: NOMMAGE_UI_METADATA,
  socketEvents: NOMMAGE_SOCKET_EVENTS
};

// ============================================================================
// Factory du Service NOMMAGE
// ============================================================================

export function createNommageService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<NommageConfig>
): INommageService {
  const mqttService = NommageMqttIntegrationService.create(
    eventBus,
    logger,
    configProvider
  );
  
  const service = NommageService.create(
    eventBus,
    logger,
    configProvider,
    mqttService
  );
  
  // NOMMAGE_ALL_EVENTS (pas NOMMAGE_SOCKET_EVENTS) : SocketBridge.setupDynamicAppHandlers() ne
  // câble socket.on(...) que pour les événements listés ici — se limiter aux événements
  // serveur→client signifiait qu'aucune requête client (nommage:status:get, nommage:config:save,
  // ...) n'atteignait jamais le backend.
  eventBus.emit('app:socket-events:registered', {
    appId: 'nommage',
    socketEvents: NOMMAGE_ALL_EVENTS,
    persistentEvents: NOMMAGE_PERSISTENT_EVENTS
  });
  
  eventBus.emit('app:menu:register', {
    appId: 'nommage',
    menuConfig: NOMMAGE_MENU_CONFIG
  });
  
  return service;
}

export function createNommageServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): INommageService {
  const configProvider = new AppConfigProvider<NommageConfig>('nommage' as any, configService);
  return createNommageService(eventBus, logger, configProvider);
}

// ============================================================================
// Ré-export de tous les composants
// ============================================================================

export * from './NommageService';
export * from './config-schema';
export * from './socket-events';
export * from './types';
export * from '../ha/integration/nommage/NommageMqttIntegrationService';
