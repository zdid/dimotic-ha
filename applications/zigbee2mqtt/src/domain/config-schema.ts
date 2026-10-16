/**
 * Schéma de configuration — section `zigbee2mqtt` de data/core/config.yaml.
 * Le pilote ne démarre pas zigbee2mqtt : il parle à une instance déjà en place, par MQTT (sujets `<baseTopic>/bridge/...`).
 */

import { z } from 'zod';

export const zigbee2mqttConfigSchema = z.object({
  /** Sujet de base de zigbee2mqtt (`mqtt.base_topic` de sa configuration ; défaut zigbee2mqtt). */
  baseTopic: z.string().min(1).default('zigbee2mqtt'),
  /** Préfixe du pont MQTT ; un suffixe unique par machine (core.machineId) y est ajouté. */
  bridgeInstance: z.string().min(1).default('z2m_bridge'),
  /** Délai d'attente d'une réponse de zigbee2mqtt (secondes). */
  delaiReponseSec: z.number().int().min(2).max(120).default(30),
  /** Durée par défaut de l'appairage (secondes) et plafond : le réseau ne reste jamais ouvert longtemps. */
  appairageDefautSec: z.number().int().min(10).max(254).default(120),
  appairageMaxSec: z.number().int().min(10).max(254).default(254)
});

export type Zigbee2mqttConfig = z.infer<typeof zigbee2mqttConfigSchema>;

export const DEFAULT_ZIGBEE2MQTT_CONFIG: Zigbee2mqttConfig = zigbee2mqttConfigSchema.parse({});
