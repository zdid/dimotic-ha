// =============================================================================
// stateCommand.ts — Publication d'état et routage des commandes reçues
//
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.4 :
// topics `/{moduleName}/{bridgeInstance}/{deviceId}/state|set`.
// =============================================================================

import type { MqttTransport, MqttMessage } from '../../infrastructure/transport/MqttTransport';
import type { HaMqttStateMessage } from './types/ha-mqtt';
import { getStateTopic, getCommandTopic } from './types/ha-mqtt';

/**
 * Publie un changement d'état pour un device ou un récepteur.
 */
export function publishState(
  transport: MqttTransport,
  moduleName: string,
  bridgeInstance: string,
  deviceId: string,
  state: HaMqttStateMessage,
  qos: 0 | 1 = 1,
  retain: boolean = true
): void {
  const topic = getStateTopic(moduleName, bridgeInstance, deviceId);
  transport.publish(topic, JSON.stringify(state), qos, retain);
}

/**
 * S'abonne au topic de commande d'un device.
 */
export function subscribeCommands(
  transport: MqttTransport,
  moduleName: string,
  bridgeInstance: string,
  deviceId: string,
  qos: 0 | 1 = 1
): void {
  transport.subscribe(getCommandTopic(moduleName, bridgeInstance, deviceId), qos);
}

/**
 * Commande entrante décodée, prête à être routée vers le module concerné.
 */
export interface ParsedIncomingCommand {
  moduleName: string;
  bridgeInstance: string;
  deviceId: string;
  command: Record<string, unknown>;
}

/**
 * Parse un message MQTT entrant sur un topic de commande
 * (`/{moduleName}/{bridgeInstance}/{deviceId}/set`).
 * Retourne `null` si le topic ne correspond pas à ce format.
 */
export function parseIncomingCommand(message: MqttMessage): ParsedIncomingCommand | null {
  const segments = message.topic.split('/').filter((segment) => segment.length > 0);

  if (segments.length !== 4 || segments[3] !== 'set') {
    return null;
  }

  const moduleName = segments[0] as string;
  const bridgeInstance = segments[1] as string;
  const deviceId = segments[2] as string;

  const payloadString: string = Buffer.isBuffer(message.payload) ? message.payload.toString() : message.payload;

  // Schéma MQTT light/switch/cover "par défaut" de HA (aucun command_template déclaré en
  // découverte) : le command_topic reçoit le payload BRUT ("ON"/"OFF"/"OPEN"/"CLOSE"/"STOP"),
  // pas du JSON — vérifié en conditions réelles (2026-07-30), commande visible sur le broker
  // mais jamais traitée (JSON.parse jetait silencieusement, ni log ni état en retour). On
  // retombe sur { state: <payload brut> } pour rester compatible avec parseHaCommandPayload
  // (RfxComService), qui attend déjà `payload.state`.
  let command: Record<string, unknown>;
  try {
    command = JSON.parse(payloadString);
  } catch {
    command = { state: payloadString.trim() };
  }

  return { moduleName, bridgeInstance, deviceId, command };
}
