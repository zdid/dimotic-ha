/**
 * Événements Socket.io de l'application ESPHOME — préfixe `esphome:`, format `esphome:<section>:<action>`
 * (voir nommage/socket-events.ts).
 */

export const ESPHOME_SOCKET_EVENTS = {
  STATUS: 'esphome:status',
  CARTE_RELEVE: 'esphome:carte:releve',
  ERROR: 'esphome:error'
} as const;

export const ESPHOME_CLIENT_EVENTS = {
  GET_STATUS: 'esphome:status:get',
  CARTE_RECONNAITRE: 'esphome:carte:reconnaitre'
} as const;

export const ESPHOME_ALL_EVENTS = {
  ...ESPHOME_SOCKET_EVENTS,
  ...ESPHOME_CLIENT_EVENTS
} as const;

// Valeurs réelles des événements (pas les clés de l'objet) — voir nommage/socket-events.ts.
export const ESPHOME_PERSISTENT_EVENTS: string[] = [ESPHOME_SOCKET_EVENTS.STATUS];
