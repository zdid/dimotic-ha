/**
 * Événements Socket.io spécifiques à l'application Sauvegarde/Restauration
 *
 * Conventions : préfixe 'sauvegarde:', format 'sauvegarde:<section>:<action>' — même pattern que
 * rfxcom/arexx/teleinfo.
 */

export const SAUVEGARDE_SOCKET_EVENTS = {
  STATUS: 'sauvegarde:status',
  ERROR: 'sauvegarde:error',
  SECRET_PUSH_RESULT: 'sauvegarde:secret:push:result',
  GOSSIP_IMPORT_RESULT: 'sauvegarde:gossip:import:result'
} as const;

export const SAUVEGARDE_CLIENT_EVENTS = {
  GET_STATUS: 'sauvegarde:status:get',
  // { targetId, appPassword } — jamais persisté, voir SecretPushService.
  SECRET_PUSH: 'sauvegarde:secret:push',
  // Import assisté des répertoires depuis les cibles déjà gossipées par core (targets +
  // haStackTargets) — voir handleGossipImport() dans SauvegardeService.
  GOSSIP_IMPORT: 'sauvegarde:gossip:import'
} as const;

export const SAUVEGARDE_ALL_EVENTS = {
  ...SAUVEGARDE_SOCKET_EVENTS,
  ...SAUVEGARDE_CLIENT_EVENTS
} as const;

export type SauvegardeSocketEvents = typeof SAUVEGARDE_SOCKET_EVENTS;
export type SauvegardeClientEvents = typeof SAUVEGARDE_CLIENT_EVENTS;
export type SauvegardeAllEvents = typeof SAUVEGARDE_ALL_EVENTS;

// Événements persistants (rejoués automatiquement à la connexion) — valeurs réelles des
// événements, pas les clés (voir le commentaire équivalent dans arexx/socket-events.ts).
export const SAUVEGARDE_PERSISTENT_EVENTS: string[] = [
  SAUVEGARDE_SOCKET_EVENTS.STATUS
];
