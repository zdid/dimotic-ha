// =============================================================================
// Types pour l'intégration MQTT Home Assistant
// Conforme au protocole MQTT HA : https://www.home-assistant.io/docs/mqtt/discovery/
// =============================================================================

/**
 * Configuration pour un module d'intégration MQTT.
 */
export interface IntegrationModuleConfig {
  // Nom unique du module
  moduleName: string;
  
  // Configuration MQTT
  mqtt: {
    host: string;
    port: number;
    client_id: string;
    username?: string;
    password?: string;
    keepalive: number;
    clean: boolean;
  };
  
  // Préfixe pour les topics de ce module (optionnel)
  topicPrefix?: string;
  
  // Délai de reconnexion (secondes)
  reconnectDelay?: number;
}

/**
 * Configuration complète pour l'intégration MQTT.
 */
export interface HaMqttIntegrationConfig {
  enabled: boolean;
  modules: IntegrationModuleConfig[];
}

// =============================================================================
// Types pour les messages de découverte HA
// =============================================================================

/**
 * Device HA pour les messages de découverte.
 * Représente l'appareil physique.
 */
export interface HaMqttDevice {
  identifiers: string[];           // Ex: ["module_001"]
  name: string;                   // Ex: "Integration Module Transceiver"
  manufacturer?: string;          // Ex: "Manufacturer"
  model?: string;                 // Ex: "Model Name"
  sw_version?: string;            // Version firmware
  hw_version?: string;            // Version hardware
  via_device?: string;            // ID du device parent (si applicable)
  /**
   * Nom de l'area HA à suggérer (pas un area_id technique) — HA ne l'utilise qu'une fois, à la
   * création de l'entité, pour lui assigner automatiquement une area si elle n'en a pas déjà une
   * (jamais réappliqué ensuite). Champ réellement reconnu par la découverte MQTT de HA,
   * contrairement à un ancien `area_id` jamais exploitable ici (clé absente du schéma MQTT
   * discovery — confirmé par inspection directe des payloads réels, jamais alimenté nulle part).
   */
  suggested_area?: string;
}

/**
 * Entité MQTT HA pour la découverte.
 * Message publié sur : homeassistant/{component}/{object_id}/config
 */
export interface HaMqttDiscoveryEntity {
  // Champs obligatoires HA
  name: string;                   // Nom affiché dans HA
  unique_id: string;             // ID unique
  
  // Classification
  device_class?: string;         // Ex: "temperature", "motion", "binary_sensor"
  
  // Topics
  state_topic: string;           // Topic pour l'état (ex: "homeassistant/sensor/temperature_001/state")
  command_topic?: string;        // Topic pour les commandes (si applicable)
  
  // Format de l'état
  value_template?: string;      // Template pour extraire la valeur
  payload_on?: string;           // Payload pour état "on" (binary sensors)
  payload_off?: string;          // Payload pour état "off" (binary sensors)
  
  // Métadonnées
  unit_of_measurement?: string;  // Ex: "°C", "%"
  icon?: string;                 // Icône Material Design
  friendly_name?: string;        // Nom convivial
  
  // Device parent
  device?: HaMqttDevice;
  
  // Autre
  retain?: boolean;
  qos?: 0 | 1 | 2;
  
  // Champs optionnels HA
  availability_topic?: string;    // Topic pour disponibilité
  payload_available?: string;
  payload_not_available?: string;

  // Attributs libres de l'entité (ex: attributs_taxonomie) — mécanisme HA officiel : un topic
  // JSON fusionné dans entity.attributes, distinct des champs de découverte ci-dessus (qui sont
  // eux validés contre un schéma strict par plateforme et n'acceptent aucune clé libre).
  json_attributes_topic?: string;
  json_attributes_template?: string;
}

/**
 * Message d'état HA.
 * Publie sur : homeassistant/{component}/{object_id}/state
 */
export interface HaMqttStateMessage {
  state: string | number | boolean;  // État principal
  attributes?: Record<string, unknown>; // Attributs supplémentaires
}

/**
 * Message de commande HA.
 * Reçu sur : homeassistant/{component}/{object_id}/set
 */
export interface HaMqttCommandMessage {
  state?: string | number | boolean; // Nouvel état (pour switch, light, etc.)
  [key: string]: unknown;          // Données spécifiques au service
}

// =============================================================================
// Types pour les événements internes
// =============================================================================

/**
 * Événement de découverte émis par un module métier.
 * La couche HA-integration publie ensuite le message MQTT vers HA.
 */
export interface IntegrationDiscoveryEvent {
  module: string;                  // Nom du module
  component: string;              // Composant HA (ex: "sensor", "switch", "binary_sensor")
  objectId: string;               // ID de l'objet (ex: "temperature_salon")
  entity: HaMqttDiscoveryEntity;  // Message de découverte HA
}

/**
 * Événement de changement d'état émis par un module métier.
 */
export interface IntegrationStateEvent {
  module: string;                  // Nom du module
  component: string;              // Composant HA
  objectId: string;               // ID de l'objet
  state: HaMqttStateMessage;      // Nouveau état
}

/**
 * Événement de commande reçu de HA.
 * Émis par HaMqttIntegrationService, consommé par les modules métier.
 */
export interface IntegrationCommandEvent {
  module: string;                  // Nom du module
  component: string;              // Composant HA
  objectId: string;               // ID de l'objet
  payload: HaMqttCommandMessage;  // Commande reçue
  topic: string;                  // Topic MQTT source
}

/**
 * Statut d'un module d'intégration.
 */
export interface IntegrationModuleStatus {
  module: string;
  connected: boolean;
  lastActivity: Date | null;
  error?: string;
}

// =============================================================================
// Constantes des topics
// =============================================================================

/**
 * Construit le topic de découverte HA (standard, inchangé depuis techniques-socle-ha-mqtt_specs v4.6).
 */
export function getDiscoveryTopic(component: string, objectId: string): string {
  return `homeassistant/${component}/${objectId}/config`;
}

/**
 * Construit le topic d'état pour un device, propre à l'espace de noms de l'application.
 * Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.4.
 * `deviceId` est un identifiant opaque au socle, dont l'encodage est propre à chaque module.
 */
export function getStateTopic(moduleName: string, bridgeInstance: string, deviceId: string): string {
  return `${moduleName}/${bridgeInstance}/${deviceId}/state`;
}

/**
 * Construit le topic de commande pour un device, propre à l'espace de noms de l'application.
 * Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.4.
 */
export function getCommandTopic(moduleName: string, bridgeInstance: string, deviceId: string): string {
  return `${moduleName}/${bridgeInstance}/${deviceId}/set`;
}

/**
 * Construit le topic d'attributs libres (json_attributes_topic) pour un device, propre à
 * l'espace de noms de l'application. Utile uniquement quand le module ne peut pas réutiliser son
 * propre state_topic pour porter les attributs (ex: passthrough — le state_topic appartient à la
 * source tierce relayée, son format n'est pas sous notre contrôle).
 */
export function getAttributesTopic(moduleName: string, bridgeInstance: string, deviceId: string): string {
  return `${moduleName}/${bridgeInstance}/${deviceId}/attributes`;
}

/**
 * Construit le topic de statut (LWT) d'un bridge_instance.
 * Un LWT par bridge_instance (pas par module) : voir techniques-socle-ha-mqtt_specs v4.9 §8.5.1.
 */
export function getBridgeStatusTopic(moduleName: string, bridgeInstance: string): string {
  return `${moduleName}/${bridgeInstance}/status`;
}

/**
 * Construit le topic de disponibilité HA.
 */
export function getAvailabilityTopic(component: string, objectId: string): string {
  return `homeassistant/${component}/${objectId}/availability`;
}

/**
 * Réécrit le premier segment d'un topic source en `homeassistant`.
 * Utilisé par le mode "découverte" du Passthrough MQTT (techniques-socle-ha-mqtt_specs v4.9 §8.5.6) :
 * une application relaie un message de découverte lu sur un préfixe étranger
 * (ex: "homeassist/sensor/x/config") vers le préfixe HA standard.
 */
export function rewriteToHomeAssistantPrefix(sourceTopic: string): string {
  const segments = sourceTopic.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return sourceTopic;
  }
  segments[0] = 'homeassistant';
  return (sourceTopic.startsWith('/') ? '/' : '') + segments.join('/');
}

// =============================================================================
// Payloads standards
// =============================================================================

export const PAYLOAD_ONLINE = 'online';
export const PAYLOAD_OFFLINE = 'offline';
export const PAYLOAD_AVAILABLE = 'online';
export const PAYLOAD_NOT_AVAILABLE = 'offline';
