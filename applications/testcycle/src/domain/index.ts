/**
 * Module principal de l'application de TEST du cycle de vie (⭐ 24/09/2026, demande explicite) —
 * sert à éprouver ce que fait le core quand une application est ajoutée, activée, désactivée,
 * retirée ou plante. Embarquée dans l'image Docker (docker/build-apps.sh, 24/09/2026) : comme toute
 * application nouvelle elle y arrive désactivée — l'activer sur une machine pour y éprouver le core.
 *
 * Scanné par AppService : exporte TESTCYCLE_APP, testcycleConfigSchema (convention
 * {moduleId}ConfigSchema, validation à l'enregistrement) et TESTCYCLE_SOCKET_EVENTS.
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
import { TESTCYCLE_SOCKET_EVENTS, TESTCYCLE_ALL_EVENTS, TESTCYCLE_PERSISTENT_EVENTS } from './socket-events';
import { TestCycleService, type ITestCycleService } from './TestCycleService';
import type { TestcycleConfig } from './config-schema';

export const TESTCYCLE_UI_METADATA: ModuleUiMetadata = {
  title: 'Test cycle de vie',
  description: "Application de TEST : éprouve ce que fait le core à l'ajout, l'activation, la désactivation, le retrait ou la panne d'une application (MQTT, HA WebSocket, config).",
  icon: '🧪',
  category: 'Test',
  menuLabel: 'Test cycle de vie',
  menuIcon: '🧪',
  menuOrder: 90,
  menuPath: '/testcycle/config',
  badge: 'Test',
  fields: [
    {
      title: 'Paramètres de test',
      description: 'Trois paramètres techniques — relus à chaud à chaque enregistrement.',
      icon: '⚙️',
      fields: [
        {
          name: 'haEntity',
          label: 'Entité HA à lire (WebSocket)',
          type: 'text',
          default: 'sun.sun',
          hint: 'Lue à chaque intervalle via le core — son état est affiché sur la page et publié en attribut du capteur compteur.'
        },
        {
          name: 'publishIntervalSec',
          label: 'Intervalle de publication MQTT (s)',
          type: 'number',
          default: 10,
          min: 2,
          max: 3600
        },
        {
          name: 'crashMode',
          label: 'Mode de panne (test)',
          type: 'select',
          default: 'aucun',
          options: [
            { value: 'aucun', label: 'Aucun — fonctionnement normal' },
            { value: 'demarrage', label: 'Plante au démarrage' },
            { value: 'apres30s', label: 'Plante 30 s après le démarrage' },
            { value: 'ignoreSigterm', label: 'Ignore SIGTERM (arrêt forcé par SIGKILL)' }
          ],
          hint: '« Plante au démarrage » ne s\'applique qu\'au prochain démarrage du process ; les autres modes s\'appliquent tout de suite.'
        }
      ]
    }
  ]
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

export const TESTCYCLE_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Test cycle de vie',
  entry: {
    label: 'Test cycle de vie',
    icon: '🧪',
    path: '/testcycle/config',
    order: 90,
    badge: 'Test'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/testcycle/presentation/index.html',
      order: 1
    }
  ]
};

export const TESTCYCLE_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'testcycle',
  name: 'Test cycle de vie',
  description: "Application de TEST du cycle de vie des applications (MQTT, HA WebSocket, config, pannes volontaires).",
  icon: '🧪',
  menu: TESTCYCLE_MENU_CONFIG,
  // 'integration' : bridge MQTT tenu par le core (découverte HA de 2 capteurs), comme arexx/rfxcom.
  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: true,
  configSection: 'testcycle',
  configUi: TESTCYCLE_UI_METADATA,
  socketEvents: TESTCYCLE_SOCKET_EVENTS,
  runsAsSeparateProcess: true
};

export function createTestcycleService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<TestcycleConfig>,
  haBridgeClient?: HaBridgeClient
): ITestCycleService {
  const service = new TestCycleService(eventBus, logger, configProvider, haBridgeClient);

  eventBus.emit('app:socket-events:registered', {
    appId: 'testcycle',
    socketEvents: TESTCYCLE_ALL_EVENTS,
    persistentEvents: TESTCYCLE_PERSISTENT_EVENTS
  });
  eventBus.emit('app:menu:register', { appId: 'testcycle', menuConfig: TESTCYCLE_MENU_CONFIG });

  return service;
}

export function createTestcycleServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haBridgeClient?: HaBridgeClient
): ITestCycleService {
  const configProvider = new AppConfigProvider<TestcycleConfig>('testcycle', configService);
  return createTestcycleService(eventBus, logger, configProvider, haBridgeClient);
}

export * from './TestCycleService';
export * from './socket-events';
export * from './config-schema';
