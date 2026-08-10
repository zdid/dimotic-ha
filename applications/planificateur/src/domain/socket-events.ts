/**
 * Événements Socket.io spécifiques à l'application planificateur.
 * Convention : préfixe 'planificateur:', format 'planificateur:<section>:<action>'.
 * Miroir du pattern arexx/rfxcom.
 */

export const PLANIFICATEUR_SOCKET_EVENTS = {
  STATUS: 'planificateur:status',
  MACROS_LIST: 'planificateur:macros:list',
  PLANIFICATIONS_LIST: 'planificateur:planifications:list',
  // ⭐ Journal des actions reçues de `ia` (ia:command / ia:tool:execute) — demande utilisateur
  // ("il me faut une trace sur l'application pour voir les actions entreprises à la réception
  // d'un message de IA"), même principe que ia:exchanges:list côté application `ia`.
  ACTIONS_LIST: 'planificateur:actions:list',
  ERROR: 'planificateur:error'
} as const;

export const PLANIFICATEUR_CLIENT_EVENTS = {
  GET_STATUS: 'planificateur:status:get',
  GET_MACROS: 'planificateur:macros:list:get',
  GET_PLANIFICATIONS: 'planificateur:planifications:list:get',
  GET_ACTIONS: 'planificateur:actions:list:get',

  // Gestion UI directe (§4 — hors conversation, mêmes opérations que le nœud `gestion`)
  PLANIFICATION_ACTIVER: 'planificateur:planification:activer',
  PLANIFICATION_DESACTIVER: 'planificateur:planification:desactiver',
  PLANIFICATION_SUPPRIMER: 'planificateur:planification:supprimer',
  MACRO_SUPPRIMER: 'planificateur:macro:supprimer'
} as const;

export const PLANIFICATEUR_ALL_EVENTS = {
  ...PLANIFICATEUR_SOCKET_EVENTS,
  ...PLANIFICATEUR_CLIENT_EVENTS
} as const;

export type PlanificateurSocketEvents = typeof PLANIFICATEUR_SOCKET_EVENTS;
export type PlanificateurClientEvents = typeof PLANIFICATEUR_CLIENT_EVENTS;
export type PlanificateurAllEvents = typeof PLANIFICATEUR_ALL_EVENTS;

export const PLANIFICATEUR_PERSISTENT_EVENTS: string[] = [
  PLANIFICATEUR_SOCKET_EVENTS.STATUS,
  PLANIFICATEUR_SOCKET_EVENTS.MACROS_LIST,
  PLANIFICATEUR_SOCKET_EVENTS.PLANIFICATIONS_LIST,
  PLANIFICATEUR_SOCKET_EVENTS.ACTIONS_LIST
];
