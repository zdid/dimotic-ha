/**
 * Module principal de l'application zigbee2mqtt (pilote) — scanné par AppService pour la détection automatique.
 * Exporte ZIGBEE2MQTT_APP (métadonnées) et createZigbee2mqttService (factory). Arrive DÉSACTIVÉE comme toute application
 * nouvelle (activation à chaud depuis Gestion des applications).
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
import { Zigbee2mqttService, type IZigbee2mqttService } from './Zigbee2mqttService';
import type { Zigbee2mqttConfig } from './config-schema';

export const ZIGBEE2MQTT_UI_METADATA: ModuleUiMetadata = {
  title: 'zigbee2mqtt - Pilote',
  description: "Pilote d'une instance zigbee2mqtt existante : liste des appareils Zigbee, appairage, nommage QUOI---OÙ, suppression et remplacement, pour l'agent IA (canal « gestion des pilotes »). N'installe pas zigbee2mqtt.",
  icon: '🐝',
  category: 'zigbee2mqtt',
  menuLabel: 'zigbee2mqtt',
  menuIcon: '🐝',
  menuOrder: 28,
  menuPath: '/zigbee2mqtt/config',
  badge: 'Pilote',
  fields: [
    {
      title: 'zigbee2mqtt',
      description: "Où trouver l'instance zigbee2mqtt (même broker MQTT que dimotic-ha) et limites de l'appairage.",
      icon: '🐝',
      fields: [
        { name: 'baseTopic', label: 'Sujet de base de zigbee2mqtt', type: 'string', default: 'zigbee2mqtt', description: "`mqtt.base_topic` de la configuration de zigbee2mqtt." },
        { name: 'bridgeInstance', label: 'Préfixe du pont MQTT', type: 'string', default: 'z2m_bridge', description: 'Un suffixe unique par machine (core.machineId) y est ajouté automatiquement.' },
        { name: 'delaiReponseSec', label: "Délai d'attente d'une réponse (secondes)", type: 'number', default: 30 },
        { name: 'appairageDefautSec', label: "Durée d'appairage par défaut (secondes)", type: 'number', default: 120 },
        { name: 'appairageMaxSec', label: "Durée maximale d'appairage (secondes)", type: 'number', default: 254, description: "Le réseau ne reste jamais ouvert plus longtemps (254 s = maximum de zigbee2mqtt)." }
      ]
    }
  ]
};

export const ZIGBEE2MQTT_APP: ApplicationModule = {
  id: 'zigbee2mqtt',
  name: 'zigbee2mqtt',
  description: "Pilote zigbee2mqtt : gestion des appareils Zigbee (liste, appairage, nommage QUOI---OÙ, suppression, remplacement) par le canal « gestion des pilotes ».",
  icon: '🐝',
  type: 'integration',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'zigbee2mqtt',
  configUi: ZIGBEE2MQTT_UI_METADATA,
  socketEvents: {},
  // Process séparé sur cette machine ; la famille integration:zigbee2mqtt:* est pontée automatiquement par AppService.
  runsAsSeparateProcess: true
};

export function createZigbee2mqttService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<Zigbee2mqttConfig>
): IZigbee2mqttService {
  return Zigbee2mqttService.create(eventBus, logger, configProvider);
}

export function createZigbee2mqttServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService): IZigbee2mqttService {
  const configProvider = new AppConfigProvider<Zigbee2mqttConfig>('zigbee2mqtt', configService);
  return createZigbee2mqttService(eventBus, logger, configProvider);
}

export * from './Zigbee2mqttService';
export * from './Zigbee2mqttPilote';
export * from './config-schema';
export * from './types';
