/**
 * Module principal de l'application HAPLAN
 *
 * Scanné par AppService pour la détection automatique. Exporte HAPLAN_APP (métadonnées) et
 * createHaplanService (factory à 5 paramètres — reçoit HaStructureRegistry ET HaWsClient, voir
 * AppService.ts détection par arité de factory). Portage de haplanserver
 * (github.com/zdid/haplanserver, voir plan de portage) — Phase 1.
 */

import {
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider,
  HaStructureRegistry,
  HaWsClient
} from '../../../core/dist/exports';
import { HAPLAN_SOCKET_EVENTS } from './socket-events';
import { HaplanService, type IHaplanService } from './HaplanService';
import type { HaplanConfig } from './config-schema';

// ============================================================================
// Métadonnées UI — Phase 1 : rien à paramétrer via le formulaire générique (juste enabled),
// la page dédiée (dashboard) est le vrai point d'entrée.
// ============================================================================

export const HAPLAN_UI_METADATA: ModuleUiMetadata = {
  title: 'HAPLAN - Plans de maison',
  description: 'Plans de maison avec icônes tactiles reliées à Home Assistant (portage de haplanserver).',
  icon: '🗺️',
  category: 'HAPLAN',
  menuLabel: 'Plans',
  menuIcon: '🗺️',
  menuOrder: 40,
  menuPath: '/applications/haplan/presentation/haplan/dashboard.html',
  badge: 'Plans',

  fields: []
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

export const HAPLAN_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'HAPLAN',
  // Pas de formulaire générique (configUi.fields est vide, rien à paramétrer via ce mécanisme en
  // Phase 1) — l'entrée de menu ouvre directement le tableau de bord (Sidebar.ts route toute
  // entry.path commençant par '/applications/' vers une page dédiée plutôt que le formulaire
  // générique de config).
  entry: {
    label: 'HAPLAN',
    icon: '🗺️',
    path: '/applications/haplan/presentation/haplan/dashboard.html',
    order: 40,
    badge: 'Plans'
  }
};

// ============================================================================
// Déclaration du module HAPLAN
// ============================================================================

export const HAPLAN_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'haplan',
  name: 'HAPLAN',
  description: 'Plans de maison avec icônes tactiles : visualisation en direct et pilotage d\'entités Home Assistant existantes, positionnées sur des images de plan.',
  icon: '🗺️',

  menu: HAPLAN_MENU_CONFIG,

  type: 'standalone',
  audience: 'end-user',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: true,
  configSection: 'haplan',
  configUi: HAPLAN_UI_METADATA,
  socketEvents: HAPLAN_SOCKET_EVENTS
};

// ============================================================================
// Factory du service — 5 paramètres : reçoit HaStructureRegistry ET HaWsClient (voir
// AppService.ts, dispatch par arité de factory). Peuvent être undefined si ha.ws_enable=false.
// ============================================================================

export function createHaplanService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<HaplanConfig>,
  haStructureRegistry: HaStructureRegistry | undefined,
  haWsClient: HaWsClient | undefined
): IHaplanService {
  return HaplanService.create(eventBus, logger, configProvider, haStructureRegistry, haWsClient);
}

export function createHaplanServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haStructureRegistry: HaStructureRegistry | undefined,
  haWsClient: HaWsClient | undefined
): IHaplanService {
  const configProvider = new AppConfigProvider<HaplanConfig>('haplan' as any, configService);
  return createHaplanService(eventBus, logger, configProvider, haStructureRegistry, haWsClient);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './HaplanService';
export * from './config-schema';
export * from './floorplans-config-schema';
export * from './socket-events';
export * from './types';
