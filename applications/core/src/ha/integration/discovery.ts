// =============================================================================
// discovery.ts — Construction et publication du message de découverte HA
//
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.0 : le module métier ne fournit
// que les données ESSENTIELLES d'une entité ; cette brique complète et normalise
// l'intégralité du message de découverte (topics, bloc device, defaults).
// =============================================================================

import type { MqttTransport } from '../../infrastructure/transport/MqttTransport';
import type { HaMqttDevice, HaMqttDiscoveryEntity } from './types/ha-mqtt';
import { getDiscoveryTopic, getStateTopic, getCommandTopic, getAttributesTopic } from './types/ha-mqtt';

/**
 * Données essentielles qu'un module métier doit fournir pour une entité.
 * Tout le reste (topics, bloc device par défaut, etc.) est complété par cette brique.
 */
export interface EssentialEntityData {
  /** null si l'entité n'a pas de nom propre distinct du device (voir HaMqttDiscoveryEntity.has_entity_name). */
  name: string | null;
  deviceClass?: string;
  unitOfMeasurement?: string;
  icon?: string;
  payloadOn?: string;
  payloadOff?: string;
  valueTemplate?: string;
  device?: HaMqttDevice;
  /** Si absent, publication en lecture seule (pas de command_topic). */
  commandEnabled?: boolean;
  /**
   * Champs de découverte additionnels reconnus par HA, fusionnés tels quels (ex: state_class,
   * entity_category). ⚠️ Ne PAS y glisser des attributs libres arbitraires (ex: taxonomie) : HA
   * valide le message de découverte contre un schéma strict par plateforme et ignore
   * silencieusement toute clé non reconnue — vérifié en direct sur une instance HA réelle,
   * confirmé par un test de bout en bout (aucun des champs "extra" custom n'atteignait jamais
   * entity.attributes). Pour des attributs libres, voir `attributsTaxonomie` ci-dessous.
   */
  extra?: Record<string, unknown>;
  /**
   * Taxonomie QUOI/OÙ de l'entité (buildAttributsTaxonomie côté module métier). Si fourni,
   * publiée sur un topic dédié (getAttributesTopic) UNIQUEMENT à la (re)découverte — jamais à
   * chaque état, contrairement à l'ancien mécanisme qui réutilisait state_topic. Absent = pas de
   * json_attributes_topic du tout pour cette entité (ex: scènes RFXCOM/device_automation, qui
   * n'ont pas d'équivalent HA pour ce mécanisme).
   */
  attributsTaxonomie?: Record<string, unknown>;
}

/**
 * Contexte de routage nécessaire pour construire les topics.
 */
export interface DiscoveryContext {
  moduleName: string;
  bridgeInstance: string;
  /** Identifiant opaque utilisé pour les topics état/commande — peut différer de objectId. */
  deviceId: string;
  /** Composant HA (sensor, switch, binary_sensor, ...). */
  component: string;
  /** object_id HA — utilisé dans le topic de découverte et comme unique_id par défaut. */
  objectId: string;
}

/**
 * Construit le message de découverte HA complet à partir des données essentielles
 * fournies par un module métier.
 */
export function buildDiscoveryPayload(
  essential: EssentialEntityData,
  context: DiscoveryContext
): HaMqttDiscoveryEntity {
  const stateTopic = getStateTopic(context.moduleName, context.bridgeInstance, context.deviceId);

  const entity: HaMqttDiscoveryEntity = {
    name: essential.name,
    has_entity_name: true,
    unique_id: context.objectId,
    state_topic: stateTopic,
    device_class: essential.deviceClass,
    unit_of_measurement: essential.unitOfMeasurement,
    icon: essential.icon,
    payload_on: essential.payloadOn,
    payload_off: essential.payloadOff,
    value_template: essential.valueTemplate,
    device: essential.device,
    retain: true,
    qos: 1,
  };

  if (essential.attributsTaxonomie) {
    // Topic dédié, distinct du state_topic — publié une seule fois à la découverte (voir
    // publishAttributes ci-dessous), pas à chaque état. Payload = { attributs_taxonomie: {...} }
    // directement, donc pas de `.attributes` à déballer dans le template.
    entity.json_attributes_topic = getAttributesTopic(context.component, context.objectId);
    entity.json_attributes_template = '{{ value_json | tojson }}';
  }

  if (essential.commandEnabled) {
    entity.command_topic = getCommandTopic(context.moduleName, context.bridgeInstance, context.deviceId);
  }

  return essential.extra ? ({ ...entity, ...essential.extra } as HaMqttDiscoveryEntity) : entity;
}

/**
 * Publie un message de découverte sur le topic HA standard.
 */
export function publishDiscovery(
  transport: MqttTransport,
  component: string,
  objectId: string,
  entity: HaMqttDiscoveryEntity,
  qos: 0 | 1 = 1,
  retain: boolean = true,
  bridgeInstance?: string
): void {
  // ⭐ fonctionnelles-supervisor_specs v2.3 §9.3 : au passage au nouveau format (node_id=bridgeInstance),
  // nettoie activement l'ancien topic (sans node_id) à CHAQUE publication — sans ça, une instance
  // déjà en production laisserait indéfiniment un message retenu orphelin sur l'ancien topic après
  // la mise à jour. Idempotent/inoffensif si l'ancien topic n'a jamais existé.
  if (bridgeInstance) {
    transport.publish(getDiscoveryTopic(component, objectId), '', qos, true);
  }
  transport.publish(getDiscoveryTopic(component, objectId, bridgeInstance), JSON.stringify(entity), qos, retain);
}

/**
 * Publie la taxonomie d'une entité sur son topic d'attributs dédié (voir getAttributesTopic) —
 * à appeler uniquement à la (re)découverte, jamais à chaque changement d'état.
 */
export function publishAttributes(
  transport: MqttTransport,
  component: string,
  objectId: string,
  attributsTaxonomie: Record<string, unknown>,
  qos: 0 | 1 = 1,
  retain: boolean = true
): void {
  const topic = getAttributesTopic(component, objectId);
  transport.publish(topic, JSON.stringify({ attributs_taxonomie: attributsTaxonomie }), qos, retain);
}

/**
 * Retire une entité déjà découverte côté HA — convention MQTT Discovery standard : un payload
 * vide (pas `{}`, une chaîne réellement vide) publié en retain sur le même topic de découverte
 * fait supprimer l'entité par HA. Utilisé quand un module désélectionne une donnée/un device
 * qui avait déjà été publié (sans ça, l'entité restait visible dans HA indéfiniment).
 */
export function unpublishDiscovery(
  transport: MqttTransport,
  component: string,
  objectId: string,
  qos: 0 | 1 = 1,
  bridgeInstance?: string
): void {
  transport.publish(getDiscoveryTopic(component, objectId, bridgeInstance), '', qos, true);
}
