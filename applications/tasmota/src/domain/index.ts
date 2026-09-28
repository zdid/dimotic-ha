/**
 * Module principal de l'application TASMOTA (fonctionnelles-tasmota_specs v1.0) — flotte Tasmota :
 * liste, nommage + publication HA (comme RFXCOM), fiche réinjectée, mise en service d'un neuf,
 * règles préétablies et modes.
 */

import {
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider,
  HaBridgeClient
} from '../../../core/dist/exports';
import { TASMOTA_SOCKET_EVENTS, TASMOTA_ALL_EVENTS, TASMOTA_PERSISTENT_EVENTS, TASMOTA_REQUEST_EVENTS } from './socket-events';
import { TasmotaService, type ITasmotaService } from './TasmotaService';
import type { TasmotaConfig } from './config-schema';

// Type de menu déclaré localement, comme dans les autres applications (outils, sauvegarde…).
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

export const TASMOTA_UI_METADATA: ModuleUiMetadata = {
  title: 'Tasmota',
  description: 'Appareils Tasmota : liste, nommage, réglages, mise en service, règles et modes',
  icon: '🔌',
  category: 'Applications',
  menuLabel: 'Tasmota',
  menuIcon: '🔌',
  menuOrder: 45,
  menuPath: '/tasmota',
  // Vide : pas de formulaire générique, tout le paramétrage est sur la page de l'application.
  fields: []
};

export const TASMOTA_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Applications',
  section: 'Tasmota',
  entry: { label: 'Tasmota', icon: '🔌', path: '/tasmota', order: 45 },
  pages: [
    { id: 'dashboard', label: 'Appareils Tasmota', icon: '🔌', path: '/applications/tasmota/presentation/index.html', order: 1 }
  ]
};

export const TASMOTA_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'tasmota',
  name: 'Tasmota',
  description: 'Appareils Tasmota : liste tenue à jour, nommage QUOI---LIEU et publication vers HA, fiche réinjectée, mise en service d’un neuf, règles et modes.',
  icon: '🔌',
  menu: TASMOTA_MENU_CONFIG,
  // 'integration' : connexion MQTT du socle (passthrough) pour les Tasmota et les découvertes HA.
  type: 'integration',
  audience: 'end-user',
  configurable: true,
  requiredMqtt: true,
  // Le référentiel HA ne sert qu'aux listes de choix (QUOI, lieux) : facultatif.
  requiredHaWs: false,
  configSection: 'tasmota',
  configUi: TASMOTA_UI_METADATA,
  socketEvents: TASMOTA_SOCKET_EVENTS,
  runsAsSeparateProcess: true,
  // Requêtes corrélées d'ia (spec §8).
  bridgedEvents: [TASMOTA_REQUEST_EVENTS.CATALOG_GET, TASMOTA_REQUEST_EVENTS.RULE_DEFINE, TASMOTA_REQUEST_EVENTS.MODE_SET]
};

export function createTasmotaService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<TasmotaConfig>,
  haBridge?: HaBridgeClient
): ITasmotaService {
  const service = TasmotaService.create(eventBus, logger, configProvider, haBridge);
  eventBus.emit('app:socket-events:registered', {
    appId: 'tasmota',
    socketEvents: TASMOTA_ALL_EVENTS,
    persistentEvents: TASMOTA_PERSISTENT_EVENTS
  });
  eventBus.emit('app:menu:register', { appId: 'tasmota', menuConfig: TASMOTA_MENU_CONFIG });
  return service;
}

export function createTasmotaServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService, haBridge?: HaBridgeClient): ITasmotaService {
  return createTasmotaService(eventBus, logger, new AppConfigProvider<TasmotaConfig>('tasmota', configService), haBridge);
}

export * from './TasmotaService';
export * from './socket-events';
export * from './config-schema';
export * from './rules';
export * from './ha-discovery';
export * from './taxonomy';
