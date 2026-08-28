/**
 * Module principal de l'application HAPLAN
 *
 * Scanné par AppService pour la détection automatique. Exporte HAPLAN_APP (métadonnées) et
 * createHaplanService — reçoit un HaBridgeClient (⭐ 24/08/2026, façade générique vers le
 * référentiel HA et les commandes détenus par `core`, voir HaBridgeClient.ts), nécessaire pour
 * afficher l'état en direct et piloter réellement les entités. Portage de haplanserver
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
  HaBridgeClient
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
  // ⭐ 24/08/2026 — migration en process séparé (découplage HaStructureRegistry/HaWsClient via
  // HaBridgeClient, voir HaplanService.ts) : résout le redémarrage complet de core à la
  // désactivation depuis Gestion des applications (superviseur Phase 2).
  runsAsSeparateProcess: true,
  configSection: 'haplan',
  configUi: HAPLAN_UI_METADATA,
  socketEvents: HAPLAN_SOCKET_EVENTS,
  // ⭐ 28/08/2026 : sans ce tableau, aucun événement core→haplan hors la liste générique fixe de
  // AppService.wireSeparateProcessApp() ne peut atteindre ce process — bug réel trouvé en
  // préparant le dépôt de la carte Plan Lovelace : 'espdisplay:deploy-result' (déjà utilisé par
  // handleFloorplanDeploy depuis la migration en process séparé du 24/08) n'était pas ponté non
  // plus, listener mort depuis cette date sans jamais avoir été détecté (autoBridgeSocketEvents ne
  // ponte que les valeurs de HAPLAN_SOCKET_EVENTS, pas les événements internes reçus d'une autre
  // application). Corrigé au passage.
  bridgedEvents: ['espdisplay:deploy-result', 'core:haplan-lovelace:deploy:result']
};

// ============================================================================
// Factory du service — reçoit un HaBridgeClient (⭐ 24/08/2026, remplace HaStructureRegistry/
// HaWsClient en direct, non transportables hors du process de `core`).
// ============================================================================

export function createHaplanService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<HaplanConfig>,
  haBridgeClient: HaBridgeClient
): IHaplanService {
  const service = HaplanService.create(eventBus, logger, configProvider, haBridgeClient);

  // ⭐ 24/08/2026 — app en process séparé : app:socket-events:registered déjà émis par
  // HaplanService.registerSocketEvents() (HAPLAN_ALL_EVENTS, plus complet que le HAPLAN_SOCKET_EVENTS
  // statique du manifeste) ; app:menu:register en revanche n'était émis nulle part jusqu'ici
  // (jamais nécessaire tant que l'app tournait in-process, le menu venait directement du manifeste).
  eventBus.emit('app:menu:register', {
    appId: 'haplan',
    menuConfig: HAPLAN_MENU_CONFIG
  });

  return service;
}

export function createHaplanServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haBridgeClient: HaBridgeClient
): IHaplanService {
  const configProvider = new AppConfigProvider<HaplanConfig>('haplan' as any, configService);
  return createHaplanService(eventBus, logger, configProvider, haBridgeClient);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './HaplanService';
export * from './config-schema';
export * from './floorplans-config-schema';
export * from './socket-events';
export * from './types';
