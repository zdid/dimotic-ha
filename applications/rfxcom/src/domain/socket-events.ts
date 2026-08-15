/**
 * Événements Socket.io spécifiques à l'application RFXCOM
 *
 * Conventions :
 * - Préfixe : 'rfxcom:'
 * - Format : 'rfxcom:<section>:<action>'
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §11.3/§12.2 et
 * recepteurs-emetteurs-rfxcom_specs_v5.1.md §11.
 */

// ============================================================================
// Événements Server → Client
// ============================================================================

export const RFXCOM_SOCKET_EVENTS = {
  // --- Statut ---
  STATUS: 'rfxcom:status',

  // --- Devices ---
  DEVICES_LIST: 'rfxcom:devices:list',
  DEVICE_DETECTED: 'rfxcom:device:detected',
  DEVICE_DELETED: 'rfxcom:device:deleted',

  // --- Récepteurs ---
  RECEIVERS_LIST: 'rfxcom:receivers:list',
  RECEIVER_CREATED: 'rfxcom:receiver:created',
  RECEIVER_UPDATED: 'rfxcom:receiver:updated',
  RECEIVER_DELETED: 'rfxcom:receiver:deleted',

  // --- Scan ---
  SCAN_START: 'rfxcom:scan:start',
  SCAN_COMPLETE: 'rfxcom:scan:complete',
  SCAN_FAILED: 'rfxcom:scan:failed',

  // --- Scènes ---
  SCENES_LIST: 'rfxcom:scenes:list',
  SCENE_STATUS: 'rfxcom:scene:status',
  SCENE_EXECUTED: 'rfxcom:scene:executed',
  SCENE_CREATED: 'rfxcom:scene:created',
  SCENE_UPDATED: 'rfxcom:scene:updated',
  SCENE_DELETED: 'rfxcom:scene:deleted',

  // --- Protocoles (fonctionnelles-rfxcom_specs §8.2) ---
  PROTOCOLS_LIST: 'rfxcom:protocols:list',

  // --- Journal des ordres reçus (demande utilisateur 10/08/2026) : chaque commande HA→RFXCOM
  // reçue, avec son résultat d'exécution réel (transceiver connecté ou non, transmission tentée
  // ou non) — seule source de vérité fiable, indépendante de l'ACK générique HA en amont (voir
  // TODO.md "RFXCOM : journal des ordres reçus avec résultat d'exécution").
  ORDERS_LIST: 'rfxcom:orders:list',

  // --- Recouvrement RF entre instances (fonctionnelles-supervisor_specs v2.3 §9.4) : objectId
  // publiés ici mais déjà revendiqués par une autre instance RFXCOM (rfxcom/+/registered-devices)
  // — avertissement visible, pas une exclusion silencieuse (§9.1).
  CLAIMED_ELSEWHERE_LIST: 'rfxcom:claimed-elsewhere:list',

  // --- Erreurs ---
  ERROR: 'rfxcom:error'
} as const;

// ============================================================================
// Événements Client → Server
// ============================================================================

export const RFXCOM_CLIENT_EVENTS = {
  // --- Demandes ---
  GET_STATUS: 'rfxcom:status:get',
  GET_DEVICES: 'rfxcom:devices:list:get',
  GET_RECEIVERS: 'rfxcom:receivers:list:get',
  GET_SCENES: 'rfxcom:scenes:list:get',
  GET_ORDERS: 'rfxcom:orders:list:get',
  GET_CLAIMED_ELSEWHERE: 'rfxcom:claimed-elsewhere:list:get',

  // --- Devices ---
  DEVICES_REFRESH: 'rfxcom:devices:refresh',
  DEVICES_CLEAR_UNCONFIGURED: 'rfxcom:devices:clear-unconfigured',
  DEVICE_SET_NAME: 'rfxcom:device:set_name',
  DEVICE_SET_TRANSMIT: 'rfxcom:device:set_transmit',
  DEVICE_DELETE: 'rfxcom:device:delete',

  // --- Scan ---
  SCAN_START: 'rfxcom:scan:start',

  // --- Récepteurs ---
  RECEIVER_CREATE: 'rfxcom:receiver:create',
  RECEIVER_UPDATE: 'rfxcom:receiver:update',
  RECEIVER_DELETE: 'rfxcom:receiver:delete',

  // --- Scènes ---
  SCENE_EXECUTE: 'rfxcom:scene:execute',
  SCENE_CANCEL: 'rfxcom:scene:cancel',
  SCENE_CREATE: 'rfxcom:scene:create',
  SCENE_UPDATE: 'rfxcom:scene:update',
  SCENE_DELETE: 'rfxcom:scene:delete',

  // --- Protocoles (fonctionnelles-rfxcom_specs §8.2) ---
  GET_PROTOCOLS: 'rfxcom:protocols:list:get',
  // --- Protocoles matériel (poussés au RFXtrx433, granularité X10/ARC/AC/...) ---
  HARDWARE_PROTOCOL_TOGGLE: 'rfxcom:hardware-protocol:toggle',
  HARDWARE_PROTOCOLS_PUSH: 'rfxcom:hardware-protocols:push',
  HARDWARE_STATUS_REFRESH: 'rfxcom:hardware-status:refresh'
} as const;

// ============================================================================
// Combinaison / types
// ============================================================================

export const RFXCOM_ALL_EVENTS = {
  ...RFXCOM_SOCKET_EVENTS,
  ...RFXCOM_CLIENT_EVENTS
} as const;

export type RfxComSocketEvents = typeof RFXCOM_SOCKET_EVENTS;
export type RfxComClientEvents = typeof RFXCOM_CLIENT_EVENTS;
export type RfxComAllEvents = typeof RFXCOM_ALL_EVENTS;

// Événements persistants (envoyés automatiquement aux nouveaux clients) — valeurs réelles des
// événements (pas les clés) : SocketBridge.registerAppSocketEvents() compare contre le nom
// d'événement émis (ex: 'rfxcom:status'), pas contre la clé de l'objet (ex: 'STATUS'). Un décalage
// clé/valeur ici désactivait silencieusement le rejeu à la reconnexion pour toute l'app.
export const RFXCOM_PERSISTENT_EVENTS: string[] = [
  RFXCOM_SOCKET_EVENTS.STATUS,
  RFXCOM_SOCKET_EVENTS.DEVICES_LIST,
  RFXCOM_SOCKET_EVENTS.RECEIVERS_LIST,
  RFXCOM_SOCKET_EVENTS.SCENES_LIST,
  RFXCOM_SOCKET_EVENTS.PROTOCOLS_LIST,
  RFXCOM_SOCKET_EVENTS.ORDERS_LIST,
  RFXCOM_SOCKET_EVENTS.CLAIMED_ELSEWHERE_LIST
];
