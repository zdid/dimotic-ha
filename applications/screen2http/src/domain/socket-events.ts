/**
 * Événements Socket.io de l'application SCREEN2HTTP.
 *
 * Plusieurs onglets peuvent ouvrir des sessions en même temps : chaque session est identifiée par un
 * `sessionId` généré par le navigateur, et toutes les sorties/états le portent — le navigateur ignore
 * ceux qui ne sont pas les siens. (Les événements d'une app sont diffusés à tous les clients connectés,
 * ils n'ont pas de destinataire unique ; l'interface n'est de toute façon accessible qu'à
 * l'administrateur — audience 'configuration'.)
 */

export const SCREEN2HTTP_SOCKET_EVENTS = {
  /** Liste des cibles configurées — { targets: [{ id, label, host, screenName }] } (persistant). */
  STATUS: 'screen2http:status',
  /** État d'une session — { sessionId, state: 'connecting'|'connected'|'closed'|'error', message? }. */
  SESSION_STATE: 'screen2http:session:state',
  /** Sortie du terminal — { sessionId, data } (non persistant). */
  OUTPUT: 'screen2http:output',
  ERROR: 'screen2http:error'
} as const;

export const SCREEN2HTTP_CLIENT_EVENTS = {
  GET_STATUS: 'screen2http:status:get',
  /** { sessionId, targetId, cols, rows } */
  SESSION_OPEN: 'screen2http:session:open',
  /** { sessionId, data } — caractères tapés */
  INPUT: 'screen2http:input',
  /** { sessionId, cols, rows } */
  RESIZE: 'screen2http:resize',
  /** { sessionId } — fin demandée par le navigateur */
  SESSION_CLOSE: 'screen2http:session:close',
  /** { sessionId } — battement de cœur ; sans lui pendant sessionTimeoutSeconds, la session est fermée */
  PING: 'screen2http:ping'
} as const;

export const SCREEN2HTTP_ALL_EVENTS = {
  ...SCREEN2HTTP_SOCKET_EVENTS,
  ...SCREEN2HTTP_CLIENT_EVENTS
} as const;

export type Screen2HttpSessionState = 'connecting' | 'connected' | 'closed' | 'error';

/** Seule la liste des cibles est rejouée à la connexion d'un client — jamais le flux du terminal. */
export const SCREEN2HTTP_PERSISTENT_EVENTS: string[] = [SCREEN2HTTP_SOCKET_EVENTS.STATUS];
