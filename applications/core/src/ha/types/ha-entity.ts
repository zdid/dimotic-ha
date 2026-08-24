// =============================================================================
// Types pour les entités Home Assistant (brutes, depuis WebSocket)
// =============================================================================

/**
 * Message WebSocket HA générique (id + type + payload libre).
 * Relocalisé ici depuis infrastructure/transport/HaWsTransport.ts (supprimé lors du
 * remplacement du client WS maison par home-assistant-js-websocket) — sa présence dans la
 * couche transport n'était qu'historique.
 */
export interface HaWsMessage {
  id: number;
  type: string;
  [key: string]: unknown;
}

/**
 * État brut d'une entité tel que retourné par l'API WebSocket HA.
 * Structure conforme à : https://developers.home-assistant.io/docs/api/rest/
 */
export interface HaRawEntity {
  entity_id: string;          // Ex: "light.salon_plafond"
  state: string;             // Ex: "on", "off", "255", "21.5"
  attributes: Record<string, unknown>;
  last_changed: string;      // ISO8601 timestamp
  last_updated: string;      // ISO8601 timestamp
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

/**
 * État d'une entité dans le référentiel structuré.
 * Contient des champs supplémentaires pour la structuration.
 */
export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: Date;
  last_updated: Date;
}

/**
 * Classe de dispositif HA (pour les capteurs principalement).
 * Liste complète : https://developers.home-assistant.io/docs/core/entity/sensor/
 */
export type HaDeviceClass =
  // Capteurs de température et environnement
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'gas'
  | 'co2'
  | 'voc'
  | 'pm1'
  | 'pm25'
  | 'pm10'
  // Capteurs de mouvement/présence
  | 'motion'
  | 'occupancy'
  | 'presence'
  // Capteurs de porte/fenêtre
  | 'door'
  | 'window'
  | 'opening'
  | 'garage_door'
  // Capteurs binaires
  | 'binary'
  | 'connectivity'
  | 'power'
  | 'problem'
  | 'safety'
  | 'smoke'
  | 'moisture'
  // Capteurs de lumière
  | 'illuminance'
  | 'light'
  // Énergie
  | 'energy'
  | 'power'
  | 'current'
  | 'voltage'
  | 'frequency'
  | 'power_factor'
  // Eau
  | 'water'
  | 'flow'
  | 'pressure'
  // Autres
  | string; // Pour les device_class custom

/**
 * Domaine HA (premier segment de entity_id).
 * Liste complète : https://www.home-assistant.io/integrations/
 */
export type HaDomain =
  // Éclairage
  | 'light'
  // Interrupteurs et prises
  | 'switch'
  | 'input_boolean'
  // Climatisation
  | 'climate'
  | 'fan'
  | 'heater'
  | 'humidifier'
  | 'dehumidifier'
  // Volets et stores
  | 'cover'
  | 'curtain'
  // Capteurs
  | 'sensor'
  | 'binary_sensor'
  // Automatisation
  | 'automation'
  | 'script'
  | 'input_text'
  | 'input_select'
  | 'input_number'
  | 'input_datetime'
  | 'input_boolean'
  // Multimédia
  | 'media_player'
  | 'tv'
  | 'remote'
  // Sécurité
  | 'alarm_control_panel'
  | 'lock'
  // Autres
  | string; // Pour les domaines custom

/**
 * Entité structurée avec métadonnées pour la classification.
 * 
 * **Relations :**
 * - `device_id` → ID du device parent (optionnel)
 * - `area_id` → ID de l'area parent (optionnel)
 * - `quoi_ids` → Liste des QUOI auxquels cette entité appartient
 * - `device` → Référence au device complet (peuplé par HaStructureRegistry)
 * - `area` → Référence à l'area complète (peuplé par HaStructureRegistry)
 */
export interface HaStructuredEntity {
  entity_id: string;
  friendly_name: string;
  domain: HaDomain;
  device_class?: HaDeviceClass;
  state: string;
  attributes: Record<string, unknown>;
  device_id?: string;
  area_id?: string;
  quoi_ids: string[]; // Résultats de la classification (peut être vide)
  last_updated: Date;
  // Références complètes (peuplées par HaStructureRegistry)
  device?: any; // HaDevice - Référence au device parent
  area?: any;  // HaArea - Référence à l'area parente
}

/**
 * `HaStructuredEntity.device`/`.area` sont des références d'objets complets, pas de simples ID —
 * `device.entities`/`area.entities` pointent en retour vers cette même entité (et toutes ses
 * "sœurs") : un graphe réellement circulaire. Envoyée telle quelle sur un canal qui sérialise
 * (socket.io-parser, IPC `process.send`), cette structure boucle indéfiniment
 * (`RangeError: Maximum call stack size exceeded`, déjà rencontré et corrigé une fois dans
 * arbreouquoi) — ne garder que les champs id/name réellement utiles côté consommateur avant de
 * franchir toute frontière de sérialisation. Partagé par ArbreouquoiService et HaQueryBridge.
 */
export function sanitizeHaEntity(entity: HaStructuredEntity): HaStructuredEntity {
  const device = entity.device as { device_id?: string; name?: string } | undefined;
  const area = entity.area as { area_id?: string; name?: string } | undefined;
  return {
    ...entity,
    device: device ? { device_id: device.device_id, name: device.name } : undefined,
    area: area ? { area_id: area.area_id, name: area.name } : undefined
  };
}

export function sanitizeHaEntities(entities: HaStructuredEntity[]): HaStructuredEntity[] {
  return entities.map(sanitizeHaEntity);
}

/**
 * Message de type "state_changed" reçu via WebSocket HA.
 */
export interface HaStateChangedMessage extends HaWsMessage {
  type: 'state_changed';
  data: {
    entity_id: string;
    new_state: HaRawEntity;
    old_state: HaRawEntity;
  };
}

/**
 * Message de type "area_registry_updated" reçu via WebSocket HA.
 */
export interface HaAreaRegistryUpdatedMessage extends HaWsMessage {
  type: 'area_registry_updated';
  data: {
    area_id: string;
    action: 'create' | 'update' | 'delete';
    area?: {
      name: string;
      picture?: string;
    };
  };
}

/**
 * Message de type "device_registry_updated" reçu via WebSocket HA.
 */
export interface HaDeviceRegistryUpdatedMessage extends HaWsMessage {
  type: 'device_registry_updated';
  data: {
    device_id: string;
    action: 'create' | 'update' | 'delete';
    device?: {
      name: string;
      identifiers?: any[];
      manufacturer?: string;
      model?: string;
      via_device_id?: string;
      area_id?: string;
    };
  };
}

/**
 * Message de type "entity_registry_updated" reçu via WebSocket HA.
 */
export interface HaEntityRegistryUpdatedMessage extends HaWsMessage {
  type: 'entity_registry_updated';
  data: {
    entity_id: string;
    action: 'create' | 'update' | 'delete';
    entity?: {
      name: string;
      platform?: string;
      domain: string;
      device_id?: string;
      area_id?: string;
      device_class?: string;
    };
  };
}
