/**
 * Module principal de l'application TELEINFO
 *
 * Ce fichier est scanné par AppService pour la détection automatique. Il doit exporter :
 * - TELEINFO_APP : ApplicationModule (métadonnées)
 * - createTeleinfoService : Factory de service
 *
 * ⚠️ Le nom du répertoire (teleinfo) DOIT correspondre à l'ID déclaré ici.
 *
 * Paramétrage de la téléinformation EDF mode historique (2 compteurs sur bascule GPIO, un seul
 * RPi1) et déploiement de l'agent Node.js (device-agent/) sur cette machine. Pas de Docker (Node
 * officiel n'a plus de build ARMv6, voir DeployService.ts) — SSH + systemd, comme l'ancienne
 * installation déjà prouvée sur ce matériel exact (12/08/2026).
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
import { TELEINFO_SOCKET_EVENTS, TELEINFO_ALL_EVENTS, TELEINFO_PERSISTENT_EVENTS } from './socket-events';
import { TeleinfoService, ITeleinfoService } from './TeleinfoService';
import { DEFAULT_TELEINFO_CONFIG, type TeleinfoConfig } from './config-schema';

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

export const TELEINFO_UI_METADATA: ModuleUiMetadata = {
  title: 'TELEINFO - Téléinformation EDF',
  description: "Paramétrage des 2 compteurs EDF mode historique (ADCO, quoi/où) reliés à un RPi1 via bascule GPIO, et déploiement de l'agent sur cette machine. La découverte HA est publiée par l'agent sur le préfixe homeassist/, reprise par le pipeline nommage comme n'importe quelle source zigbee2mqtt.",
  icon: '⚡',
  category: 'TELEINFO',
  menuLabel: 'Téléinfo',
  menuIcon: '⚡',
  menuOrder: 26,
  menuPath: '/teleinfo/config',
  fields: [
    {
      title: 'Machines cibles',
      description: 'Le RPi1 auquel sont câblés les 2 compteurs — accès SSH root direct (rpio nécessite /dev/mem). Au plus 1 en pratique, mais même structure que rpigpio/arexx.',
      icon: '🖥️',
      fields: [
        {
          name: 'targets',
          label: 'Cibles',
          type: 'array',
          itemLabel: 'Cible',
          itemFields: [
            { name: 'id', label: 'Identifiant', type: 'text', required: true, placeholder: 'rpi1', hint: 'Identifiant libre, unique parmi les cibles de cette app' },
            { name: 'host', label: 'Hôte', type: 'text', placeholder: '192.168.1.183' },
            { name: 'sshKeyPath', label: 'Clé SSH privée (chemin)', type: 'text', placeholder: 'data/teleinfo/ssh/rpi1/id_ed25519', hint: "Jamais le contenu de la clé, uniquement son chemin — sous data/ pour rester accessible en Docker" },
            { name: 'remoteDir', label: "Répertoire distant de l'agent", type: 'text', default: '/opt/teleinfo' },
            { name: 'nodeBinPath', label: 'Chemin du binaire node sur la cible', type: 'text', default: '/usr/bin/node', hint: 'RPi1/ARMv6 : utiliser le node déjà installé et prouvé sur cette machine, pas un node générique' },
            { name: 'serviceName', label: 'Nom du service systemd', type: 'text', default: 'teleinfo' }
          ]
        }
      ]
    },
    {
      title: 'Câblage',
      description: 'Port série et pins GPIO (numérotation physique/BOARD) de la carte de commutation entre les 2 compteurs.',
      icon: '🔌',
      fields: [
        { name: 'serialPort', label: 'Port série', type: 'text', default: '/dev/ttyAMA0' },
        { name: 'gpio.pinA', label: 'Pin GPIO A (physique)', type: 'number', default: 11 },
        { name: 'gpio.pinB', label: 'Pin GPIO B (physique)', type: 'number', default: 12 },
        { name: 'cycleIntervalMs', label: 'Pause entre cycles complets (ms)', type: 'number', default: 30000, hint: "Délai entre deux lectures d'un même compteur — évite de saturer MQTT/HA (mesuré à ~5s sans pause)" }
      ]
    },
    {
      title: 'Broker MQTT (utilisé par l\'agent)',
      description: "Connexion que l'agent déployé utilisera pour publier ses états et sa découverte — pas le socle : cette app ne se connecte elle-même à aucun broker.",
      icon: '📡',
      fields: [
        { name: 'mqtt.host', label: 'Hôte MQTT', type: 'text', placeholder: '192.168.1.51' },
        { name: 'mqtt.port', label: 'Port MQTT', type: 'number', default: 1883 },
        { name: 'mqtt.user', label: 'Utilisateur MQTT', type: 'text' },
        { name: 'mqtt.password', label: 'Mot de passe MQTT', type: 'password' },
        { name: 'mqtt.discoveryPrefix', label: 'Préfixe de découverte HA', type: 'text', default: 'homeassist', hint: 'homeassist (pas homeassistant) — pour transiter par le pipeline nommage' }
      ]
    }
  ]
};

export const TELEINFO_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Téléinfo',
  entry: {
    label: 'Téléinfo',
    icon: '⚡',
    path: '/teleinfo/config',
    order: 26
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Compteurs',
      icon: '⚡',
      path: '/applications/teleinfo/presentation/index.html',
      order: 1
    }
  ]
};

export const TELEINFO_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'teleinfo',
  name: 'TELEINFO',
  description: 'Paramétrage de la téléinformation EDF mode historique (2 compteurs, bascule GPIO) et déploiement de l\'agent sur le RPi1 cible.',
  icon: '⚡',

  menu: TELEINFO_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'teleinfo',
  configUi: TELEINFO_UI_METADATA,
  socketEvents: TELEINFO_SOCKET_EVENTS,

  // Migration superviseur (fonctionnelles-supervisor_specs v2.6) — process séparé sur cette même
  // machine, même profil que rpigpio : événements UI (TELEINFO_ALL_EVENTS) pontés automatiquement
  // (§7.1), aucune dépendance haStructureRegistry/haWsClient/integration:* (l'app ne parle jamais
  // HA/MQTT directement — le vrai accès matériel est sur le RPi1 distant).
  runsAsSeparateProcess: true
};

export function createTeleinfoService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<TeleinfoConfig>
): ITeleinfoService {
  const service = TeleinfoService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'teleinfo',
    socketEvents: TELEINFO_ALL_EVENTS,
    persistentEvents: TELEINFO_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'teleinfo',
    menuConfig: TELEINFO_MENU_CONFIG
  });

  return service;
}

export function createTeleinfoServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): ITeleinfoService {
  const configProvider = new AppConfigProvider<TeleinfoConfig>('teleinfo' as any, configService);
  return createTeleinfoService(eventBus, logger, configProvider);
}

export * from './TeleinfoService';
export * from './config-schema';
export * from './storage-schema';
export * from './socket-events';
export * from './generator';
export * from './DeployService';
export { DEFAULT_TELEINFO_CONFIG };
