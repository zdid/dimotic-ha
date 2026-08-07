/**
 * Module principal de l'application planificateur.
 *
 * Scanné par AppService pour la détection automatique. Exporte PLANIFICATEUR_APP (métadonnées) et
 * createPlanificateurService (factory à 5 paramètres — reçoit HaStructureRegistry ET HaWsClient,
 * nécessaires pour résoudre et exécuter réellement les actions HA, voir AppService.ts).
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
import { PLANIFICATEUR_ALL_EVENTS, PLANIFICATEUR_PERSISTENT_EVENTS } from './socket-events';
import { PlanificateurService, type IPlanificateurService } from './PlanificateurService';
import type { PlanificateurConfig } from './config-schema';

// ============================================================================
// Métadonnées UI
// ============================================================================

export const PLANIFICATEUR_UI_METADATA: ModuleUiMetadata = {
  title: 'Planificateur - Macros & planifications domotiques',
  description: "Stockage et exécution des macros et planifications exprimées en langage naturel (voir application 'ia'). Toute planification est réinterprétée à chaque déclenchement, jamais exécutée depuis une version figée.",
  icon: '🗓️',
  category: 'Planificateur',
  menuLabel: 'Planificateur',
  menuIcon: '🗓️',
  menuOrder: 30,
  menuPath: '/planificateur/config',
  badge: 'IA',

  fields: [
    {
      title: 'Stockage',
      description: 'Fichiers YAML locaux (macros, planifications) et délai d\'attente pour la réinterprétation par ia au déclenchement.',
      icon: '💾',
      fields: [
        { name: 'macrosFile', label: 'Fichier des macros', type: 'string', default: 'planificateur-macros-v1.0.yaml' },
        { name: 'planificationsFile', label: 'Fichier des planifications', type: 'string', default: 'planificateur-planifications-v1.0.yaml' },
        { name: 'deployTimeoutMs', label: 'Délai d\'attente de réinterprétation (ms)', type: 'number', default: 15000 },
        { name: 'catchUpWindowSeconds', label: 'Fenêtre de rattrapage après coupure (s)', type: 'number', default: 300 }
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

export const PLANIFICATEUR_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Planificateur',
  entry: {
    label: 'Planificateur',
    icon: '🗓️',
    path: '/planificateur/config',
    order: 30,
    badge: 'IA'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/planificateur/presentation/index.html',
      order: 1
    },
    {
      id: 'gestion',
      label: 'Macros & planifications',
      icon: '🗓️',
      path: '/applications/planificateur/presentation/planificateur/config.html',
      order: 2
    }
  ]
};

// ============================================================================
// Déclaration du module
// ============================================================================

export const PLANIFICATEUR_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'planificateur',
  name: 'Planificateur',
  description: "Stockage, ordonnancement et exécution de macros/planifications domotiques exprimées en langage naturel, en lien avec l'application 'ia'.",
  icon: '🗓️',

  menu: PLANIFICATEUR_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: true,
  configSection: 'planificateur',
  configUi: PLANIFICATEUR_UI_METADATA,
  socketEvents: PLANIFICATEUR_ALL_EVENTS
};

// ============================================================================
// Factory du service
// ============================================================================

export function createPlanificateurService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<PlanificateurConfig>,
  haStructureRegistry?: HaStructureRegistry,
  haWsClient?: HaWsClient
): IPlanificateurService {
  const service = PlanificateurService.create(eventBus, logger, configProvider, haStructureRegistry, haWsClient);

  eventBus.emit('app:socket-events:registered', {
    appId: 'planificateur',
    socketEvents: PLANIFICATEUR_ALL_EVENTS,
    persistentEvents: PLANIFICATEUR_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'planificateur',
    menuConfig: PLANIFICATEUR_MENU_CONFIG
  });

  return service;
}

export function createPlanificateurServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haStructureRegistry?: HaStructureRegistry,
  haWsClient?: HaWsClient
): IPlanificateurService {
  const configProvider = new AppConfigProvider<PlanificateurConfig>('planificateur', configService);
  return createPlanificateurService(eventBus, logger, configProvider, haStructureRegistry, haWsClient);
}

// Exporter les composants
export * from './PlanificateurService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
