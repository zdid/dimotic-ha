/**
 * Module principal de l'application RPIGPIO
 *
 * Ce fichier est scanné par AppService pour la détection automatique. Il doit exporter :
 * - RPIGPIO_APP : ApplicationModule (métadonnées)
 * - createRpigpioService : Factory de service
 *
 * ⚠️ Le nom du répertoire (rpigpio) DOIT correspondre à l'ID déclaré ici.
 *
 * Paramétrage graphique des pins GPIO (mqtt-io) — quoi/où, pin, inversion, direction — et
 * déploiement (SSH + systemctl) vers la machine cible. Pas de lien direct connu avec HA à ce jour
 * (12/08/2026) : la découverte MQTT que publiera mqtt-io lui-même transite par le même pipeline
 * nommage que zigbee2mqtt (topic homeassist/, voir generator.ts/config-schema.ts), sans que cette
 * app parle jamais HA ni MQTT directement — d'où requiredMqtt/requiredHaWs à false ci-dessous.
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
import { RPIGPIO_SOCKET_EVENTS, RPIGPIO_ALL_EVENTS, RPIGPIO_PERSISTENT_EVENTS } from './socket-events';
import { RpigpioService, IRpigpioService } from './RpigpioService';
import { DEFAULT_RPIGPIO_CONFIG, type RpigpioConfig } from './config-schema';

// ============================================================================
// Types pour la configuration du menu (pas exportés par core — copie locale, voir nommage/index.ts)
// ============================================================================

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

// ============================================================================
// Métadonnées UI — réglages de connexion (le formulaire générique du socle suffit ici, pas de
// page dédiée : contrairement aux pins (liste dynamique de records), ce sont des champs fixes).
// ============================================================================

export const RPIGPIO_UI_METADATA: ModuleUiMetadata = {
  title: 'RPIGPIO - GPIO via mqtt-io',
  description: "Paramétrage des pins GPIO (quoi/où, numéro, inversion, direction) exposés via mqtt-io sur une machine distante. La découverte HA est publiée par mqtt-io lui-même sur le préfixe homeassist/, reprise par le pipeline nommage comme n'importe quelle source zigbee2mqtt.",
  icon: '🔌',
  category: 'RPIGPIO',
  menuLabel: 'RPI GPIO',
  menuIcon: '🔌',
  menuOrder: 25,
  menuPath: '/rpigpio/config',
  fields: [
    {
      title: 'Machine cible',
      description: 'Machine où tourne le service mqtt-io — accès SSH par clé (mêmes conventions que le déploiement Docker : utilisateur dédié, sudo NOPASSWD).',
      icon: '🖥️',
      fields: [
        { name: 'target.host', label: 'Hôte', type: 'text', placeholder: '192.168.1.51', hint: 'ha2, orangepi, ou toute autre machine Docker' },
        { name: 'target.sshUser', label: 'Utilisateur SSH', type: 'text', default: 'claude' },
        { name: 'target.sshKeyPath', label: 'Clé SSH privée (chemin local)', type: 'text', placeholder: '~/.ssh/ha2-claude/id_ed25519', hint: 'Jamais le contenu de la clé, uniquement son chemin sur cette machine' },
        { name: 'target.hostDir', label: 'Répertoire distant (compose.yaml + config.yml)', type: 'text', default: '/docker/mqttio-rpigpio', hint: 'Même convention que /docker/<app>/ sur ha2/orangepi' },
        { name: 'target.containerName', label: 'Nom du conteneur', type: 'text', default: 'mqtt-io-rpigpio' },
        { name: 'target.image', label: 'Image Docker', type: 'text', default: 'flyte/mqtt-io:2.6.0', hint: 'Image officielle flyte/mqtt-io, épinglée à une version numérotée' }
      ]
    },
    {
      title: 'Broker MQTT (utilisé par mqtt-io)',
      description: "Connexion que mqtt-io utilisera pour publier ses états et sa découverte — pas le socle : cette app ne se connecte elle-même à aucun broker.",
      icon: '📡',
      fields: [
        { name: 'mqtt.host', label: 'Hôte MQTT', type: 'text', placeholder: '192.168.1.51' },
        { name: 'mqtt.port', label: 'Port MQTT', type: 'number', default: 1883 },
        { name: 'mqtt.user', label: 'Utilisateur MQTT', type: 'text' },
        { name: 'mqtt.password', label: 'Mot de passe MQTT', type: 'password' },
        { name: 'mqtt.topicPrefix', label: 'Préfixe des topics état/commande', type: 'text', default: 'mqttio/rpigpio' },
        { name: 'mqtt.discoveryPrefix', label: 'Préfixe de découverte HA', type: 'text', default: 'homeassist', hint: 'homeassist (pas homeassistant) — pour transiter par le pipeline nommage, même convention que zigbee2mqtt' }
      ]
    }
  ]
};

// ============================================================================
// Configuration du Menu pour RPIGPIO
// ============================================================================

export const RPIGPIO_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'RPI GPIO',
  entry: {
    label: 'RPI GPIO',
    icon: '🔌',
    path: '/rpigpio/config',
    order: 25
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Pins',
      icon: '📌',
      path: '/applications/rpigpio/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du Module RPIGPIO
// ============================================================================

export const RPIGPIO_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'rpigpio',
  name: 'RPIGPIO',
  description: 'Paramétrage graphique des pins GPIO exposés via mqtt-io (quoi/où, numéro de pin, inversion, direction) et déploiement du config.yaml généré vers la machine cible.',
  icon: '🔌',

  menu: RPIGPIO_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'rpigpio',
  configUi: RPIGPIO_UI_METADATA,
  socketEvents: RPIGPIO_SOCKET_EVENTS
};

// ============================================================================
// Factory du Service RPIGPIO
// ============================================================================

export function createRpigpioService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<RpigpioConfig>
): IRpigpioService {
  const service = RpigpioService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'rpigpio',
    socketEvents: RPIGPIO_ALL_EVENTS,
    persistentEvents: RPIGPIO_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'rpigpio',
    menuConfig: RPIGPIO_MENU_CONFIG
  });

  return service;
}

export function createRpigpioServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IRpigpioService {
  const configProvider = new AppConfigProvider<RpigpioConfig>('rpigpio' as any, configService);
  return createRpigpioService(eventBus, logger, configProvider);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './RpigpioService';
export * from './config-schema';
export * from './storage-schema';
export * from './socket-events';
export * from './generator';
export * from './DeployService';
export { DEFAULT_RPIGPIO_CONFIG };
