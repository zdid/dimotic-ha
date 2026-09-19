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
  GOSSIP_IMPORT_RESULT: 'sauvegarde:gossip:import:result',
  BACKUP_RUN_RESULT: 'sauvegarde:backup:run:result'
} as const;

export const SAUVEGARDE_CLIENT_EVENTS = {
  GET_STATUS: 'sauvegarde:status:get',
  // { targetId, appPassword } — jamais persisté, voir SecretPushService.
  SECRET_PUSH: 'sauvegarde:secret:push',
  // Import assisté des répertoires depuis les cibles déjà gossipées par core (targets +
  // haStackTargets) — voir handleGossipImport() dans SauvegardeService.
  GOSSIP_IMPORT: 'sauvegarde:gossip:import',
  // ⭐ 18/09/2026 — { targetId } : exécute le script déjà déployé sur la machine cible tout de
  // suite, par SSH, sans attendre le cron — voir handleBackupRunNow() dans SauvegardeService
  // (demande explicite : pouvoir déclencher une sauvegarde à la demande, ex. après de grosses
  // modifications).
  BACKUP_RUN: 'sauvegarde:backup:run'
  // ⭐ 17/09/2026 — TARGETS_ADD/TARGETS_ADD_RESULT retirés : l'ajout manuel d'une machine se fait
  // désormais uniquement via le champ 'array' natif de Paramètres Techniques (bouton "+ Ajouter"
  // déjà générique, ModuleManager.generateArrayFieldHtml) — la carte dédiée du tableau de bord qui
  // était l'unique appelante de cet événement a été retirée (demande explicite : configuration
  // uniquement sur Paramètres Techniques).
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
