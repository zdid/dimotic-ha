/**
 * Événements de TASMOTA (fonctionnelles-tasmota_specs §8, §10) — préfixe 'tasmota:'.
 */

export const TASMOTA_SOCKET_EVENTS = {
  /** Vue complète : appareils, modes, configuration — persistant. */
  STATE: 'tasmota:state',
  /** Réglages relus d'un appareil (réponse à DEVICE_READ). */
  DEVICE_DETAILS: 'tasmota:device:details',
  /** Compte rendu pas à pas (application d'une fiche, action, mise en service). */
  LOG: 'tasmota:log',
  /** Résultat des vérifications / du scan de la mise en service. */
  PROVISION_STATUS: 'tasmota:provision:status'
} as const;

export const TASMOTA_CLIENT_EVENTS = {
  GET_STATE: 'tasmota:state:get',
  DEVICE_READ: 'tasmota:device:read',
  DEVICE_APPLY: 'tasmota:device:apply',
  DEVICE_ACTION: 'tasmota:device:action',
  DEVICE_FORGET: 'tasmota:device:forget',
  RULES_SAVE: 'tasmota:rules:save',
  MODE_SET: 'tasmota:mode:set:ui',
  CONFIG_SAVE: 'tasmota:config:save',
  PROVISION_CHECK: 'tasmota:provision:check',
  PROVISION_START: 'tasmota:provision:start'
} as const;

/** Requêtes corrélées d'autres applications (ia) — §8. Réponse = même nom + ':reply'. */
export const TASMOTA_REQUEST_EVENTS = {
  CATALOG_GET: 'tasmota:catalog:get',
  RULE_DEFINE: 'tasmota:rule:define',
  MODE_SET: 'tasmota:mode:set'
} as const;

export const TASMOTA_ALL_EVENTS = {
  ...TASMOTA_SOCKET_EVENTS,
  ...TASMOTA_CLIENT_EVENTS
} as const;

export const TASMOTA_PERSISTENT_EVENTS: string[] = [TASMOTA_SOCKET_EVENTS.STATE];
