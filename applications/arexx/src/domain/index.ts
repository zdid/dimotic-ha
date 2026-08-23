/**
 * Module principal de l'application AREXX
 *
 * Scanné par AppService pour la détection automatique. Exporte AREXX_APP (métadonnées) et
 * createArexxService (factory).
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
import { AREXX_SOCKET_EVENTS, AREXX_ALL_EVENTS, AREXX_PERSISTENT_EVENTS } from './socket-events';
import { ArexxService, type IArexxService } from './ArexxService';
import type { ArexxConfig } from './config-schema';

// ============================================================================
// Métadonnées UI — paramètres généraux uniquement (mode d'acquisition, adresse BS1000, port HTTP).
// Les capteurs ont leur propre page dédiée (Capteurs, accessible depuis le tableau de bord).
// ============================================================================

export const AREXX_UI_METADATA: ModuleUiMetadata = {
  title: 'AREXX - Capteurs BS1000/BS500',
  description: "Intégration AREXX pour Home Assistant : capteurs de température/humidité lus via BS1000 (réseau) ou BS500 (USB RF433).",
  icon: '🌡️',
  category: 'AREXX',
  menuLabel: 'AREXX',
  menuIcon: '🌡️',
  menuOrder: 25,
  menuPath: '/arexx/config',
  badge: 'BS1000/BS500',

  fields: [
    {
      title: 'Acquisition',
      description: "Mode de lecture des capteurs — un seul actif à la fois. 'push' : le BS1000 (ou un BS500 sur RPi séparé) POSTe ses relevés ici. 'poll' : lecture périodique du BS1000 par HTTP. 'usb' : BS500 branché en direct (hors Docker, arm/v6 ou arm/v7 uniquement).",
      icon: '📡',
      fields: [
        {
          name: 'acquisitionMode',
          label: 'Mode',
          type: 'select',
          options: [
            { value: 'push', label: 'Push HTTP (recommandé)' },
            { value: 'poll', label: 'Poll HTTP (BS1000)' },
            { value: 'usb', label: 'USB local (BS500)' }
          ],
          default: 'push'
        },
        {
          name: 'httpservPort',
          label: 'Port du serveur HTTP local (modes push/usb)',
          type: 'number',
          default: 49161
        },
        {
          name: 'bs1000Address',
          label: 'Adresse du BS1000 (mode poll)',
          type: 'string',
          placeholder: '192.168.1.50'
        },
        {
          name: 'bs1000Port',
          label: 'Port du BS1000 (mode poll)',
          type: 'number',
          default: 80
        },
        {
          name: 'pollIntervalSeconds',
          label: 'Intervalle de lecture (secondes, mode poll)',
          type: 'number',
          default: 50
        },
        {
          name: 'usbDevicePath',
          label: 'Périphérique USB (mode usb)',
          type: 'string',
          placeholder: '/dev/ttyUSB0',
          description: "Dongle branché sur une autre machine que celle-ci ? Voir l'onglet « Déploiement » de l'application AREXX (émetteurs pilotables à distance)."
        },
        {
          name: 'bridgeInstance',
          label: 'Identifiant du bridge MQTT (côté HA)',
          type: 'string',
          default: 'arexx_bridge_0001'
        },
        {
          name: 'waitForHaWsBeforeDiscovery',
          label: 'Attendre la synchronisation HA avant de publier les découvertes',
          type: 'boolean',
          default: true,
          description: "Évite de créer des entités sans area assignée (HA n'applique l'area suggérée qu'une seule fois, à la création) — désactiver si les entités doivent apparaître même quand HA WebSocket est indisponible."
        }
      ]
    },
    {
      title: 'Émetteurs USB (déploiement distant)',
      description: "Machines distantes hébergeant un dongle BS500 — déploiement/pilotage automatisé (voir l'onglet « Déploiement »). Contrairement à rpigpio/teleinfo, AREXX peut avoir plusieurs émetteurs.",
      icon: '🖥️',
      fields: [
        {
          name: 'targets',
          label: 'Cibles',
          type: 'array',
          itemLabel: 'Émetteur',
          itemFields: [
            { name: 'id', label: 'Identifiant', type: 'text', required: true, placeholder: 'bs510', hint: 'Identifiant libre, unique parmi les cibles de cette app' },
            { name: 'host', label: 'Hôte', type: 'text', placeholder: '192.168.1.10' },
            { name: 'remoteDir', label: 'Répertoire distant de copie (data/arexx/drivers/)', type: 'text', default: '/root/arexx-drivers' }
          ]
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

export const AREXX_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'AREXX',
  entry: {
    label: 'AREXX',
    icon: '🌡️',
    path: '/arexx/config',
    order: 25,
    badge: 'BS1000/BS500'
  },
  // "Capteurs" (validation avec saisie QUOI---OÙ) est volontairement absent d'ici, même choix que
  // pour RFXCOM "Devices & Récepteurs" : c'est du fonctionnel, pas un réglage technique — le
  // tableau de bord AREXX (section Applications) donne accès à sa page dédiée via son propre bouton.
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/arexx/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du module AREXX
// ============================================================================

export const AREXX_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'arexx',
  name: 'AREXX',
  description: 'Intégration AREXX : capteurs de température/humidité lus via BS1000 (réseau) ou BS500 (USB RF433), publication MQTT Discovery vers Home Assistant.',
  icon: '🌡️',

  menu: AREXX_MENU_CONFIG,

  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'arexx',
  configUi: AREXX_UI_METADATA,
  socketEvents: AREXX_SOCKET_EVENTS,

  // Migration superviseur (fonctionnelles-supervisor_specs v2.6) — process séparé sur cette même
  // machine. Tout ponté automatiquement par AppService/SupervisorEventBridge (§7.1) : AREXX_ALL_EVENTS
  // (UI), integration:bridge:register/unregister (partagés, tout type: 'integration'), la famille
  // integration:arexx:* (command/bridge:connection/ha:online/passthrough:message émis vers arexx —
  // sans effet ici, arexx n'écoute que ses capteurs, jamais de commande HA→device ; discovery/state
  // émis PAR arexx, reçus par le pont générique côté MQTT→local, aucune déclaration nécessaire).
  runsAsSeparateProcess: true
};

// ============================================================================
// Factory du service
// ============================================================================

export function createArexxService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<ArexxConfig>
): IArexxService {
  const service = ArexxService.create(eventBus, logger, configProvider);

  // AREXX_ALL_EVENTS (pas AREXX_SOCKET_EVENTS) : SocketBridge.setupDynamicAppHandlers() ne câble
  // socket.on(...) que pour les événements listés ici — se limiter aux événements serveur→client
  // signifiait qu'aucune requête client (arexx:status:get, arexx:sensor:set_name, ...) n'atteignait
  // jamais le backend (bug rencontré sur evoo7/rfxcom/nommage lors de la migration Alpine.js).
  eventBus.emit('app:socket-events:registered', {
    appId: 'arexx',
    socketEvents: AREXX_ALL_EVENTS,
    persistentEvents: AREXX_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'arexx',
    menuConfig: AREXX_MENU_CONFIG
  });

  return service;
}

export function createArexxServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IArexxService {
  const configProvider = new AppConfigProvider<ArexxConfig>('arexx', configService);
  return createArexxService(eventBus, logger, configProvider);
}

// Exporter les composants
export * from './ArexxService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
