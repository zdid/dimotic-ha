/**
 * Module principal de l'application RFXCOM
 *
 * Scanné par AppService pour la détection automatique. Exporte RFXCOM_APP (métadonnées) et
 * createRfxComService (factory). Conforme à guide-nouvelle-application_specs_v1.6.md.
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
import { RFXCOM_SOCKET_EVENTS, RFXCOM_ALL_EVENTS, RFXCOM_PERSISTENT_EVENTS } from './socket-events';
import { RfxComService, type IRfxComService } from './RfxComService';
import type { RfxComConfig } from './config-schema';

// ============================================================================
// Métadonnées UI — paramètres généraux uniquement (port série, bridge, découverte).
// Devices/Récepteurs ont leur propre page dédiée (/rfxcom/config, onglets Devices/Récepteurs).
// ============================================================================

export const RFXCOM_UI_METADATA: ModuleUiMetadata = {
  title: 'RFXCOM - Intégration RF433',
  description: 'Intégration RFXCOM (RF433) pour Home Assistant : capteurs, interrupteurs, volets via un transceiver RFXtrx433.',
  icon: '📡',
  category: 'RFXCOM',
  menuLabel: 'RFXCOM',
  menuIcon: '📡',
  menuOrder: 20,
  menuPath: '/rfxcom/config',
  badge: 'RF433',

  fields: [
    {
      title: 'Transceiver',
      description: 'Connexion série au transceiver RFXtrx433',
      icon: '🔌',
      fields: [
        {
          name: 'port',
          label: 'Port série',
          type: 'string',
          placeholder: '/dev/ttyUSB0',
          default: '/dev/ttyUSB0',
          required: true
        },
        {
          name: 'baudRate',
          label: 'Vitesse (baud)',
          type: 'number',
          default: 38400,
          required: true
        },
        {
          name: 'bridgeInstance',
          label: 'Identifiant du bridge MQTT',
          type: 'string',
          default: 'rfx_bridge_0001',
          description: 'Identifie ce transceiver dans les topics MQTT (LWT par bridge)'
        },
        {
          name: 'autoDiscovery',
          label: 'Détection continue des nouveaux devices',
          type: 'boolean',
          default: true
        },
        {
          name: 'waitForHaWsBeforeDiscovery',
          label: 'Attendre la synchronisation HA avant de publier les découvertes',
          type: 'boolean',
          default: true,
          description: "Évite de créer des entités sans area assignée (HA n'applique l'area suggérée qu'une seule fois, à la création) — désactiver si les entités doivent apparaître même quand HA WebSocket est indisponible."
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

export const RFXCOM_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'RFXCOM',
  entry: {
    label: 'RFXCOM',
    icon: '📡',
    path: '/rfxcom/config',
    order: 30,
    badge: 'RF433'
  },
  // "Devices & Récepteurs" (catalogue peuplé par découverte matérielle, union discriminée à 4
  // formes) est volontairement absent d'ici : c'est du fonctionnel, pas un réglage technique — le
  // tableau de bord RFXCOM (section Applications) donne déjà accès à sa page dédiée
  // (/applications/rfxcom/presentation/rfxcom/config.html) via son propre bouton.
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/rfxcom/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du module RFXCOM
// ============================================================================

export const RFXCOM_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'rfxcom',
  name: 'RFXCOM',
  description: 'Intégration RFXCOM (RF433) : réception des capteurs/télécommandes, pilotage des récepteurs logiques (switch/light/cover) via un transceiver RFXtrx433, publication MQTT Discovery vers Home Assistant.',
  icon: '📡',

  menu: RFXCOM_MENU_CONFIG,

  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'rfxcom',
  configUi: RFXCOM_UI_METADATA,
  socketEvents: RFXCOM_SOCKET_EVENTS
};

// ============================================================================
// Factory du service
// ============================================================================

export function createRfxComService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<RfxComConfig>
): IRfxComService {
  const service = RfxComService.create(eventBus, logger, configProvider);

  // RFXCOM_ALL_EVENTS (pas RFXCOM_SOCKET_EVENTS) : SocketBridge.setupDynamicAppHandlers() ne
  // câble socket.on(...) que pour les événements listés ici — se limiter aux événements
  // serveur→client signifiait qu'aucune requête client (rfxcom:status:get, rfxcom:scene:execute,
  // ...) n'atteignait jamais le backend.
  eventBus.emit('app:socket-events:registered', {
    appId: 'rfxcom',
    socketEvents: RFXCOM_ALL_EVENTS,
    persistentEvents: RFXCOM_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'rfxcom',
    menuConfig: RFXCOM_MENU_CONFIG
  });

  return service;
}

export function createRfxComServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IRfxComService {
  const configProvider = new AppConfigProvider<RfxComConfig>('rfxcom' as any, configService);
  return createRfxComService(eventBus, logger, configProvider);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './RfxComService';
export * from './config-schema';
export * from './devices-config-schema';
export * from './socket-events';
export * from './types';
