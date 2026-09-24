/**
 * Événements Socket.io de l'application de test du cycle de vie — préfixe 'testcycle:'.
 */

export const TESTCYCLE_SOCKET_EVENTS = {
  STATUS: 'testcycle:status',
  DONNEES: 'testcycle:donnees',
  DONNEES_SAVE_RESULT: 'testcycle:donnees:save:result'
} as const;

export const TESTCYCLE_CLIENT_EVENTS = {
  GET_STATUS: 'testcycle:status:get',
  GET_DONNEES: 'testcycle:donnees:get',
  // { message, valeurDepart, publicationActive }
  SAVE_DONNEES: 'testcycle:donnees:save'
} as const;

export const TESTCYCLE_ALL_EVENTS = {
  ...TESTCYCLE_SOCKET_EVENTS,
  ...TESTCYCLE_CLIENT_EVENTS
} as const;

export const TESTCYCLE_PERSISTENT_EVENTS: string[] = [
  TESTCYCLE_SOCKET_EVENTS.STATUS,
  TESTCYCLE_SOCKET_EVENTS.DONNEES
];
