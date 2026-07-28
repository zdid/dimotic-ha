/**
 * Événements Socket.io spécifiques à l'application HAPLAN
 *
 * Conventions :
 * - Préfixe : 'haplan:'
 * - Format : 'haplan:<section>:<action>'
 */

// ============================================================================
// Événements Server → Client
// ============================================================================

export const HAPLAN_SOCKET_EVENTS = {
  // --- Statut ---
  STATUS: 'haplan:status',

  // --- Plans ---
  FLOORPLANS_LIST: 'haplan:floorplans:list',

  // --- Sélecteur d'entité (taxonomie QUOI/OÙ, voir plan de portage Phase 2) ---
  TAXONOMY_TREE: 'haplan:taxonomy:tree',

  // --- États des entités ---
  // Snapshot initial (toutes les entités présentes sur un plan), envoyé en réponse à
  // GET_FLOORPLANS — pas persistant (contrairement à FLOORPLANS_LIST) : un événement persistant
  // n'a qu'une seule valeur rejouée par nom d'événement, incompatible avec un état par entité.
  ENTITIES_STATE_BULK: 'haplan:entities:state:bulk',
  // Poussé en direct à chaque changement d'état d'une entité affichée sur un plan.
  ENTITY_STATE: 'haplan:entity:state',

  // --- Erreurs ---
  ERROR: 'haplan:error'
} as const;

// ============================================================================
// Événements Client → Server
// ============================================================================

export const HAPLAN_CLIENT_EVENTS = {
  // --- Demandes ---
  GET_STATUS: 'haplan:status:get',
  GET_FLOORPLANS: 'haplan:floorplans:list:get',
  GET_TAXONOMY_TREE: 'haplan:taxonomy:tree:get',

  // --- Commande vers une entité HA existante (via HaWsClient.sendCommand) ---
  ENTITY_COMMAND: 'haplan:entity:command',

  // --- Positions (ajout/déplacement/suppression d'icône, voir plan de portage Phase 2) ---
  FLOORPLAN_POSITIONS_UPDATE: 'haplan:floorplan:positions:update',

  // --- Suppression de plan (Phase 3 — la création, elle, passe par POST /api/haplan/floorplans/
  // upload, hors Socket.io, voir PresentationServer.ts) ---
  FLOORPLAN_DELETE: 'haplan:floorplan:delete'
} as const;

// ============================================================================
// Combinaison / types
// ============================================================================

export const HAPLAN_ALL_EVENTS = {
  ...HAPLAN_SOCKET_EVENTS,
  ...HAPLAN_CLIENT_EVENTS
} as const;

export type HaplanSocketEvents = typeof HAPLAN_SOCKET_EVENTS;
export type HaplanClientEvents = typeof HAPLAN_CLIENT_EVENTS;
export type HaplanAllEvents = typeof HAPLAN_ALL_EVENTS;

// Événements persistants (envoyés automatiquement aux nouveaux clients) — voir
// SocketBridge.registerAppSocketEvents() : compare contre la VALEUR de l'événement émis, pas la
// clé de l'objet.
export const HAPLAN_PERSISTENT_EVENTS: string[] = [
  HAPLAN_SOCKET_EVENTS.STATUS,
  HAPLAN_SOCKET_EVENTS.FLOORPLANS_LIST,
  HAPLAN_SOCKET_EVENTS.TAXONOMY_TREE
];
