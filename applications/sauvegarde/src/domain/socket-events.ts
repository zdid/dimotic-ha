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
  BACKUP_RUN_RESULT: 'sauvegarde:backup:run:result',
  // ⭐ 23/09/2026 — assistant de restauration (écrans ①-④), réponses corrélées par requestId.
  RESTORE_CONTEXT: 'sauvegarde:restore:context',
  RESTORE_LIST_RESULT: 'sauvegarde:restore:list:result',
  RESTORE_MANIFEST_RESULT: 'sauvegarde:restore:manifest:result',
  RESTORE_PROBE_RESULT: 'sauvegarde:restore:probe:result',
  // ⭐ 23/09/2026 — script de restauration : { host, status } (contenu de restore-status.json).
  RESTORE_STATUS: 'sauvegarde:restore:status',
  RESTORE_START_RESULT: 'sauvegarde:restore:start:result',
  RESTORE_START2_RESULT: 'sauvegarde:restore:start2:result'
} as const;

export const SAUVEGARDE_CLIENT_EVENTS = {
  GET_STATUS: 'sauvegarde:status:get',
  // { targetId, appPassword, item, moduleConfig } — mot de passe jamais persisté, voir
  // SecretPushService ; item/moduleConfig = ligne et config à l'écran (⭐ 23/09/2026).
  // ⭐ 23/09/2026 — GOSSIP_IMPORT retiré (bouton « Importer depuis le gossip » supprimé).
  SECRET_PUSH: 'sauvegarde:secret:push',
  // ⭐ 18/09/2026 — { targetId, item, moduleConfig } : exécute le script déjà déployé sur la machine cible tout de
  // suite, par SSH, sans attendre le cron — voir handleBackupRunNow() dans SauvegardeService
  // (demande explicite : pouvoir déclencher une sauvegarde à la demande, ex. après de grosses
  // modifications).
  BACKUP_RUN: 'sauvegarde:backup:run',
  // ⭐ 23/09/2026 — assistant de restauration : { requestId } ; { requestId, credentials } ;
  // { requestId, credentials, destinationHost, backup } — mot de passe Nextcloud saisi dans l'assistant, jamais stocké.
  RESTORE_CONTEXT_GET: 'sauvegarde:restore:context:get',
  RESTORE_LIST: 'sauvegarde:restore:list',
  RESTORE_MANIFEST: 'sauvegarde:restore:manifest',
  // { requestId, destinationHost } — contrôle SSH root, docker/compose/curl/tar, espace libre.
  RESTORE_PROBE: 'sauvegarde:restore:probe',
  // { requestId, credentials, destinationHost, backup, items, archiveSize, neededBytes } — étape 1.
  RESTORE_START: 'sauvegarde:restore:start',
  // { requestId, destinationHost } — étape 2 (démarrage), après validation humaine.
  RESTORE_START2: 'sauvegarde:restore:start2',
  // { destinationHost } — relecture de l'état (rechargement de page, reconnexion).
  RESTORE_STATUS_GET: 'sauvegarde:restore:status:get'
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
