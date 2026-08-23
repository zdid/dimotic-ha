/**
 * Événements Socket.io spécifiques à l'application RPIGPIO
 *
 * Conventions : préfixe 'rpigpio:', format 'rpigpio:<section>:<action>' — voir nommage/socket-events.ts.
 *
 * `REMOTE_OP`/`REMOTE_OP_RESULT` (22-23/08/2026, remplace l'ancien couple `DEPLOY`/`DEPLOY_RESULT`) :
 * protocole uniforme partagé avec teleinfo/arexx — { targetId, action: RemoteAction } en entrée,
 * quelle que soit l'intervention distante (deploy/start/stop/restart) ou l'app. `targetId` désigne
 * une entrée de `config.targets[]` (multi-cible, ⭐ 23/08/2026 — voir core/infrastructure/remote/).
 */

export const RPIGPIO_SOCKET_EVENTS = {
  STATUS: 'rpigpio:status',
  PINS_LIST: 'rpigpio:pins:list',
  PIN_SAVED: 'rpigpio:pin:saved',
  PIN_DELETED: 'rpigpio:pin:deleted',
  REMOTE_OP_RESULT: 'rpigpio:remote-op:result',
  ERROR: 'rpigpio:error'
} as const;

export const RPIGPIO_CLIENT_EVENTS = {
  GET_STATUS: 'rpigpio:status:get',
  GET_PINS: 'rpigpio:pins:list:get',
  SAVE_PIN: 'rpigpio:pin:save',
  DELETE_PIN: 'rpigpio:pin:delete',
  REMOTE_OP: 'rpigpio:remote-op'
} as const;

export const RPIGPIO_ALL_EVENTS = {
  ...RPIGPIO_SOCKET_EVENTS,
  ...RPIGPIO_CLIENT_EVENTS
} as const;

export type RpigpioSocketEvents = typeof RPIGPIO_SOCKET_EVENTS;
export type RpigpioClientEvents = typeof RPIGPIO_CLIENT_EVENTS;
export type RpigpioAllEvents = typeof RPIGPIO_ALL_EVENTS;

// Valeurs réelles des événements (pas les clés de l'objet) — voir nommage/socket-events.ts pour
// le bug déjà rencontré si ce détail est oublié.
export const RPIGPIO_PERSISTENT_EVENTS: string[] = [
  RPIGPIO_SOCKET_EVENTS.STATUS,
  RPIGPIO_SOCKET_EVENTS.PINS_LIST
];
