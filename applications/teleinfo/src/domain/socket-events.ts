/**
 * Événements Socket.io spécifiques à l'application TELEINFO — voir nommage/rpigpio/socket-events.ts.
 *
 * `REMOTE_OP`/`REMOTE_OP_RESULT` (22/08/2026, remplace l'ancien couple `DEPLOY`/`DEPLOY_RESULT`) :
 * protocole uniforme partagé avec rpigpio — { action: RemoteAction } en entrée, quelle que soit
 * l'intervention distante (deploy aujourd'hui, start/stop/restart dès que ces boutons existeront),
 * plutôt qu'un événement par action. Voir core/infrastructure/remote/RemoteUnitController.ts.
 */

export const TELEINFO_SOCKET_EVENTS = {
  STATUS: 'teleinfo:status',
  COMPTEURS_LIST: 'teleinfo:compteurs:list',
  COMPTEUR_SAVED: 'teleinfo:compteur:saved',
  COMPTEUR_DELETED: 'teleinfo:compteur:deleted',
  REMOTE_OP_RESULT: 'teleinfo:remote-op:result',
  ERROR: 'teleinfo:error'
} as const;

export const TELEINFO_CLIENT_EVENTS = {
  GET_STATUS: 'teleinfo:status:get',
  GET_COMPTEURS: 'teleinfo:compteurs:list:get',
  SAVE_COMPTEUR: 'teleinfo:compteur:save',
  DELETE_COMPTEUR: 'teleinfo:compteur:delete',
  REMOTE_OP: 'teleinfo:remote-op'
} as const;

export const TELEINFO_ALL_EVENTS = {
  ...TELEINFO_SOCKET_EVENTS,
  ...TELEINFO_CLIENT_EVENTS
} as const;

export type TeleinfoSocketEvents = typeof TELEINFO_SOCKET_EVENTS;
export type TeleinfoClientEvents = typeof TELEINFO_CLIENT_EVENTS;
export type TeleinfoAllEvents = typeof TELEINFO_ALL_EVENTS;

export const TELEINFO_PERSISTENT_EVENTS: string[] = [
  TELEINFO_SOCKET_EVENTS.STATUS,
  TELEINFO_SOCKET_EVENTS.COMPTEURS_LIST
];
