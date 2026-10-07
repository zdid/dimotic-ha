/**
 * Module principal de l'application SCREEN2HTTP
 *
 * Scanné par AppService pour la détection automatique : exporte SCREEN2HTTP_APP (ApplicationModule)
 * et une factory de service. ⚠️ Le nom du répertoire (screen2http) DOIT correspondre à l'id.
 *
 * Console web d'une session `screen` distante (SSH). Paramètres (cibles, délais) dans Paramètres
 * Techniques ; la page de l'application affiche le terminal. Voir
 * specs/current/fonctionnelles-screen2http_specs_v1.0.md.
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
import { SCREEN2HTTP_SOCKET_EVENTS, SCREEN2HTTP_ALL_EVENTS, SCREEN2HTTP_PERSISTENT_EVENTS } from './socket-events';
import { Screen2HttpService, IScreen2HttpService } from './Screen2HttpService';
import { DEFAULT_SCREEN2HTTP_CONFIG, type Screen2HttpConfig } from './config-schema';

export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
  parentId?: string;
}

export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

export const SCREEN2HTTP_UI_METADATA: ModuleUiMetadata = {
  title: 'SCREEN2HTTP - Console screen distante',
  description: "Machines et sessions screen accessibles depuis la page « Console ». Connexion SSH avec la clé de l'utilisateur qui lance l'application (~/.ssh/id_ed25519, id_ecdsa ou id_rsa, ou son agent ssh) : sa clé publique doit être installée sur chaque machine cible.",
  icon: '🖥️',
  category: 'SCREEN2HTTP',
  menuLabel: 'Console screen',
  menuIcon: '🖥️',
  menuOrder: 27,
  menuPath: '/screen2http/config',
  fields: [
    {
      title: 'Sessions screen',
      description: 'Une entrée par session screen à rejoindre. Plusieurs entrées peuvent viser la même machine.',
      icon: '🖥️',
      fields: [
        {
          name: 'targets',
          label: 'Sessions',
          type: 'array',
          itemLabel: 'Session',
          itemFields: [
            { name: 'id', label: 'Identifiant', type: 'text', required: true, placeholder: 'monapp', hint: 'Identifiant libre, unique parmi les sessions' },
            { name: 'label', label: 'Nom affiché', type: 'text', placeholder: 'Mon application' },
            { name: 'host', label: 'Hôte', type: 'text', placeholder: '192.168.1.100' },
            { name: 'port', label: 'Port SSH', type: 'number', default: 22 },
            { name: 'username', label: 'Utilisateur', type: 'text', default: 'root', hint: 'Compte sur la machine distante' },
            { name: 'screenName', label: 'Nom de la session screen', type: 'text', placeholder: 'monapp', hint: "Équivaut à « screen -xS <nom> » ; vide = « screen -x » (une seule session attendue)" },
            { name: 'privateKeyPath', label: 'Clé privée (optionnel)', type: 'text', placeholder: '/home/pi/.ssh/id_ed25519', hint: "Vide = clé SSH de l'utilisateur qui lance l'application (~/.ssh/id_ed25519, id_ecdsa, id_rsa, ou agent ssh)" }
          ]
        }
      ]
    },
    {
      title: 'Connexion',
      description: 'Délais et maintien des connexions SSH.',
      icon: '🔌',
      fields: [
        { name: 'keepaliveInterval', label: 'Keepalive SSH (ms)', type: 'number', default: 10000 },
        { name: 'readyTimeout', label: 'Délai de connexion SSH (ms)', type: 'number', default: 20000 },
        { name: 'sessionTimeoutSeconds', label: "Fermeture d'une session sans navigateur (s)", type: 'number', default: 60, hint: "Délai sans signe de vie de la page avant fermeture de la connexion SSH (onglet fermé, plantage du navigateur)" }
      ]
    }
  ]
};

export const SCREEN2HTTP_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Console screen',
  entry: {
    label: 'Console screen',
    icon: '🖥️',
    path: '/screen2http/config',
    order: 27
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Console',
      icon: '🖥️',
      path: '/applications/screen2http/presentation/index.html',
      order: 1
    }
  ]
};

export const SCREEN2HTTP_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'screen2http',
  name: 'SCREEN2HTTP',
  description: "Console web d'une session screen distante (SSH) : paramétrage dans Paramètres Techniques, terminal dans la page Console.",
  icon: '🖥️',

  menu: SCREEN2HTTP_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'screen2http',
  configUi: SCREEN2HTTP_UI_METADATA,
  socketEvents: SCREEN2HTTP_SOCKET_EVENTS,

  // Process séparé comme teleinfo/rpigpio : les événements UI (SCREEN2HTTP_ALL_EVENTS) sont pontés
  // automatiquement ; aucune dépendance HA/MQTT.
  runsAsSeparateProcess: true
};

export function createScreen2HttpService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<Screen2HttpConfig>
): IScreen2HttpService {
  const service = Screen2HttpService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'screen2http',
    socketEvents: SCREEN2HTTP_ALL_EVENTS,
    persistentEvents: SCREEN2HTTP_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'screen2http',
    menuConfig: SCREEN2HTTP_MENU_CONFIG
  });

  return service;
}

export function createScreen2HttpServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IScreen2HttpService {
  const configProvider = new AppConfigProvider<Screen2HttpConfig>('screen2http' as any, configService);
  return createScreen2HttpService(eventBus, logger, configProvider);
}

export * from './Screen2HttpService';
export * from './config-schema';
export * from './socket-events';
export { DEFAULT_SCREEN2HTTP_CONFIG };
