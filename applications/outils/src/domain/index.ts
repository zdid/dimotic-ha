/**
 * Module principal de l'application Outils — scanné par AppService pour la détection automatique.
 * Exporte OUTILS_APP (métadonnées) et createOutilsService (factory).
 *
 * Bibliothèque de scripts shell paramétrables : titre + description + fichier .sh, variables
 * `__NOM__` détectées automatiquement, formulaire de saisie généré, génération + téléchargement
 * fait côté navigateur (aucun round-trip serveur pour la substitution elle-même).
 *
 * Pas de formulaire Paramètres Techniques significatif (configUi.fields vide, même pattern que
 * HAPLAN) — toute l'interface vit sur la page dédiée de l'application (liste + formulaire de
 * variables + génération), pas dans le formulaire technique générique.
 *
 * Process séparé (comme arexx/teleinfo/sauvegarde) — voir standalone.ts. `bridgedEvents` ne liste
 * que le sens core→enfant : `outils:internal:upload`, relayé par la route générique
 * POST /api/apps/:appId/upload (voir ScriptsHaService/HAPLAN pour le même mécanisme).
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
import { OUTILS_SOCKET_EVENTS, OUTILS_ALL_EVENTS, OUTILS_PERSISTENT_EVENTS } from './socket-events';
import { OutilsService, type IOutilsService } from './OutilsService';
import type { OutilsConfig } from './config-schema';

export const OUTILS_UI_METADATA: ModuleUiMetadata = {
  title: 'Outils',
  description: 'Bibliothèque de scripts shell paramétrables — configuration sur sa propre page.',
  icon: '🧰',
  category: 'Outils',
  menuLabel: 'Outils',
  menuIcon: '🧰',
  menuOrder: 40,
  menuPath: '/outils',
  fields: []
};

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

export const OUTILS_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Applications',
  section: 'Outils',
  entry: {
    label: 'Outils',
    icon: '🧰',
    path: '/outils',
    order: 40
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Bibliothèque de scripts',
      icon: '🧰',
      path: '/applications/outils/presentation/index.html',
      order: 1
    }
  ]
};

export const OUTILS_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'outils',
  name: 'Outils',
  description: 'Bibliothèque de scripts shell paramétrables — titre, description, variables détectées, génération et téléchargement.',
  icon: '🧰',

  menu: OUTILS_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'outils',
  configUi: OUTILS_UI_METADATA,
  socketEvents: OUTILS_SOCKET_EVENTS,

  runsAsSeparateProcess: true,
  bridgedEvents: ['outils:internal:upload']
};

export function createOutilsService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<OutilsConfig>
): IOutilsService {
  const service = OutilsService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'outils',
    socketEvents: OUTILS_ALL_EVENTS,
    persistentEvents: OUTILS_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'outils',
    menuConfig: OUTILS_MENU_CONFIG
  });

  return service;
}

export function createOutilsServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IOutilsService {
  const configProvider = new AppConfigProvider<OutilsConfig>('outils', configService);
  return createOutilsService(eventBus, logger, configProvider);
}

export * from './OutilsService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
