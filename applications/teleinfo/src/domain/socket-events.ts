/**
 * Événements Socket.io spécifiques à l'application TELEINFO — voir nommage/rpigpio/socket-events.ts.
 */

export const TELEINFO_SOCKET_EVENTS = {
  STATUS: 'teleinfo:status',
  COMPTEURS_LIST: 'teleinfo:compteurs:list',
  COMPTEUR_SAVED: 'teleinfo:compteur:saved',
  COMPTEUR_DELETED: 'teleinfo:compteur:deleted',
  DEPLOY_RESULT: 'teleinfo:deploy:result',
  ERROR: 'teleinfo:error'
} as const;

export const TELEINFO_CLIENT_EVENTS = {
  GET_STATUS: 'teleinfo:status:get',
  GET_COMPTEURS: 'teleinfo:compteurs:list:get',
  SAVE_COMPTEUR: 'teleinfo:compteur:save',
  DELETE_COMPTEUR: 'teleinfo:compteur:delete',
  DEPLOY: 'teleinfo:deploy'
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
