/**
 * Événements Socket.io spécifiques à l'application AREXX
 *
 * Conventions :
 * - Préfixe : 'arexx:'
 * - Format : 'arexx:<section>:<action>'
 *
 * Miroir du pattern rfxcom/socket-events.ts.
 */

// ============================================================================
// Événements Server → Client
// ============================================================================

export const AREXX_SOCKET_EVENTS = {
  // --- Statut ---
  STATUS: 'arexx:status',

  // --- Capteurs ---
  SENSORS_LIST: 'arexx:sensors:list',
  SENSOR_DETECTED: 'arexx:sensor:detected',

  // --- Déploiement (page dédiée, voir DriversBundle.ts) ---
  DRIVER_TARGET: 'arexx:driver-target',

  // --- Pilotage distant des émetteurs (⭐ 23/08/2026, voir ArexxDeployService.ts) — protocole
  // uniforme partagé avec rpigpio/teleinfo : { targetId, action } en entrée, quelle que soit
  // l'intervention (deploy/start/stop/restart). Voir core/infrastructure/remote/.
  REMOTE_OP_RESULT: 'arexx:remote-op:result',

  // --- Erreurs ---
  ERROR: 'arexx:error'
} as const;

// ============================================================================
// Événements Client → Server
// ============================================================================

export const AREXX_CLIENT_EVENTS = {
  GET_STATUS: 'arexx:status:get',
  GET_SENSORS: 'arexx:sensors:list:get',

  SENSOR_SET_NAME: 'arexx:sensor:set_name',
  SENSOR_SET_TRANSMIT: 'arexx:sensor:set_transmit',
  SENSOR_DELETE: 'arexx:sensor:delete',

  GET_DRIVER_TARGET: 'arexx:driver-target:get',
  SAVE_DRIVER_TARGET: 'arexx:driver-target:save',

  REMOTE_OP: 'arexx:remote-op'
} as const;

// ============================================================================
// Combinaison / types
// ============================================================================

export const AREXX_ALL_EVENTS = {
  ...AREXX_SOCKET_EVENTS,
  ...AREXX_CLIENT_EVENTS
} as const;

export type ArexxSocketEvents = typeof AREXX_SOCKET_EVENTS;
export type ArexxClientEvents = typeof AREXX_CLIENT_EVENTS;
export type ArexxAllEvents = typeof AREXX_ALL_EVENTS;

// Événements persistants (envoyés automatiquement aux nouveaux clients) — valeurs réelles des
// événements (pas les clés) : SocketBridge.registerAppSocketEvents() compare contre le nom
// d'événement émis (ex: 'arexx:status'), pas contre la clé de l'objet (ex: 'STATUS'). Un décalage
// clé/valeur ici désactivait silencieusement le rejeu à la reconnexion pour toute l'app (bug
// rencontré 3x sur evoo7/rfxcom/nommage lors de la migration Alpine.js).
export const AREXX_PERSISTENT_EVENTS: string[] = [
  AREXX_SOCKET_EVENTS.STATUS,
  AREXX_SOCKET_EVENTS.SENSORS_LIST
];
