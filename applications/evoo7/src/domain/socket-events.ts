/**
 * Événements Socket.io spécifiques à l'application EVOO7
 *
 * Conventions :
 * - Préfixe : 'evoo7:'
 * - Format : 'evoo7:<section>:<action>'
 */

// ============================================================================
// Événements Server → Client
// ============================================================================

export const EVOO7_SOCKET_EVENTS = {
  // --- Statut ---
  STATUS: 'evoo7:status',

  // --- Données ---
  DONNEES_LIST: 'evoo7:donnees:list',
  DONNEE_UPDATED: 'evoo7:donnee:updated',
  // Réponse honnête (succès ou échec réel) à set_selection/set_topic — jamais un succès supposé
  // côté client, voir TODO.md "EVOO7 : formulaire générique... confirmation de sauvegarde".
  DONNEE_SAVE_RESPONSE: 'evoo7:donnee:save:response',

  // --- Thermostat (entité climate composite) ---
  THERMOSTAT_SAVE_RESPONSE: 'evoo7:thermostat:save:response',

  // --- Erreurs ---
  ERROR: 'evoo7:error'
} as const;

// ============================================================================
// Événements Client → Server
// ============================================================================

export const EVOO7_CLIENT_EVENTS = {
  // --- Demandes ---
  GET_STATUS: 'evoo7:status:get',
  GET_DONNEES: 'evoo7:donnees:list:get',

  // --- Données ---
  // Un seul événement de sauvegarde par ligne (sélection + topic/format + taxonomie + classe HA)
  // — voir TODO.md "un seul bouton de sauvegarde par ligne".
  DONNEE_SAVE: 'evoo7:donnee:save',

  // --- Thermostat (entité climate composite) ---
  THERMOSTAT_SAVE: 'evoo7:thermostat:save'
} as const;

// ============================================================================
// Combinaison / types
// ============================================================================

export const EVOO7_ALL_EVENTS = {
  ...EVOO7_SOCKET_EVENTS,
  ...EVOO7_CLIENT_EVENTS
} as const;

export type Evoo7SocketEvents = typeof EVOO7_SOCKET_EVENTS;
export type Evoo7ClientEvents = typeof EVOO7_CLIENT_EVENTS;
export type Evoo7AllEvents = typeof EVOO7_ALL_EVENTS;

// Événements persistants (envoyés automatiquement aux nouveaux clients) — valeurs réelles des
// événements (pas les clés) : SocketBridge.registerAppSocketEvents() compare contre le nom
// d'événement émis (ex: 'evoo7:status'), pas contre la clé de l'objet (ex: 'STATUS'). Un décalage
// clé/valeur ici désactivait silencieusement le rejeu à la reconnexion pour toute l'app.
export const EVOO7_PERSISTENT_EVENTS: string[] = [
  EVOO7_SOCKET_EVENTS.STATUS,
  EVOO7_SOCKET_EVENTS.DONNEES_LIST
];
