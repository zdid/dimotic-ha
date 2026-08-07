/**
 * Module principal de l'application EVOO7
 *
 * Scanné par AppService pour la détection automatique. Exporte EVOO7_APP (métadonnées) et
 * createEvoo7Service (factory).
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
import { EVOO7_SOCKET_EVENTS, EVOO7_ALL_EVENTS, EVOO7_PERSISTENT_EVENTS } from './socket-events';
import { Evoo7Service, type IEvoo7Service } from './Evoo7Service';
import type { Evoo7Config } from './config-schema';

// ============================================================================
// Métadonnées UI — paramètres généraux uniquement (connexion broker EVOO7, commande globale).
// Les 43 données ont leur propre page dédiée (/evoo7/config, onglets Paramétrage/Données).
// ============================================================================

export const EVOO7_UI_METADATA: ModuleUiMetadata = {
  title: 'EVOO7 - Intégration EVOO7 Control',
  description: "Intégration EVOO7 Control (VR Electronique) pour Home Assistant via MQTT : régulation chauffage/PAC.",
  icon: '🌡️',
  category: 'EVOO7',
  menuLabel: 'EVOO7',
  menuIcon: '🌡️',
  menuOrder: 40,
  menuPath: '/evoo7/config',
  badge: 'MQTT',

  fields: [
    {
      title: 'Broker EVOO7',
      description: 'Connexion MQTT dédiée au broker EVOO7 Control (indépendante du broker HA)',
      icon: '🔌',
      fields: [
        {
          name: 'mqtt.host',
          label: 'Hôte',
          type: 'string',
          placeholder: '192.168.1.53',
          required: true
        },
        {
          name: 'mqtt.port',
          label: 'Port',
          type: 'number',
          default: 1883,
          required: true
        },
        {
          name: 'mqtt.username',
          label: 'Utilisateur',
          type: 'string'
        },
        {
          name: 'mqtt.password',
          label: 'Mot de passe',
          type: 'password'
        },
        {
          name: 'mqtt.qos',
          label: 'QoS',
          type: 'number',
          default: 0,
          min: 0,
          max: 2
        },
        {
          name: 'bridgeInstance',
          label: 'Identifiant du bridge MQTT (côté HA)',
          type: 'string',
          default: 'evoo7_bridge_0001',
          description: 'Identifie cette instance EVOO7 dans les topics MQTT du socle (LWT)'
        }
      ]
    },
    {
      title: 'Commande EVOO7 (topic global, partagé par toutes les données)',
      description: 'Topic et format du message de commande — $name$/$value$ substitués par l\'application.',
      icon: '📤',
      fields: [
        {
          name: 'topicCommand',
          label: 'Topic Commande',
          type: 'string',
          default: 'domitic/command/evoo7'
        },
        {
          name: 'formatMessageCommand',
          label: 'Format du message Commande',
          type: 'string',
          default: '{ "num" : "$name$", "status" : "$value$" }'
        }
      ]
    }
  ]
};

// ============================================================================
// Configuration du menu
// ============================================================================

export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
}

export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

export const EVOO7_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'EVOO7',
  entry: {
    label: 'EVOO7',
    icon: '🌡️',
    path: '/evoo7/config',
    order: 40,
    badge: 'MQTT'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/evoo7/presentation/index.html',
      order: 1
    },
    {
      // Distinct de entry.path ci-dessus (qui reste un marqueur interne pilotant le formulaire
      // générique) : celui-ci pointe vers la vraie page dédiée (mqtt.host/port et bridgeInstance
      // sont dans le formulaire générique, mais le catalogue des 43 données EVOO7 a besoin de sa
      // propre page). Avant correctif : même valeur que entry.path, donc jamais rendu comme lien
      // distinct par Sidebar.ts (page.path !== entry.path), et de toute façon 404 si atteint
      // (le serveur ne sert aucune route '/evoo7/config').
      id: 'config',
      label: 'Données',
      icon: '📋',
      path: '/applications/evoo7/presentation/evoo7/config.html',
      order: 2
    }
  ]
};

// ============================================================================
// Déclaration du module EVOO7
// ============================================================================

export const EVOO7_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'evoo7',
  name: 'EVOO7',
  description: "Intégration EVOO7 Control (VR Electronique) : régulation chauffage/PAC via MQTT, publication MQTT Discovery vers Home Assistant.",
  icon: '🌡️',

  menu: EVOO7_MENU_CONFIG,

  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'evoo7',
  configUi: EVOO7_UI_METADATA,
  socketEvents: EVOO7_SOCKET_EVENTS
};

// ============================================================================
// Factory du service
// ============================================================================

export function createEvoo7Service(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<Evoo7Config>
): IEvoo7Service {
  const service = Evoo7Service.create(eventBus, logger, configProvider);

  // EVOO7_ALL_EVENTS (pas EVOO7_SOCKET_EVENTS) : SocketBridge.setupDynamicAppHandlers() ne câble
  // socket.on(...) que pour les événements listés ici — se limiter aux événements serveur→client
  // signifiait qu'aucune requête client (evoo7:status:get, evoo7:config:save, ...) n'atteignait
  // jamais le backend.
  eventBus.emit('app:socket-events:registered', {
    appId: 'evoo7',
    socketEvents: EVOO7_ALL_EVENTS,
    persistentEvents: EVOO7_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'evoo7',
    menuConfig: EVOO7_MENU_CONFIG
  });

  return service;
}

export function createEvoo7ServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IEvoo7Service {
  const configProvider = new AppConfigProvider<Evoo7Config>('evoo7' as any, configService);
  return createEvoo7Service(eventBus, logger, configProvider);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './Evoo7Service';
export * from './config-schema';
export * from './donnees-config-schema';
export * from './socket-events';
export * from './types';
