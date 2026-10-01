/**
 * Événements Socket.io de l'application SUPERVISION — préfixe 'supervision:'. Pas de page propre :
 * consommés par le fragment de la page d'accueil (presentation/ts/accueil.ts).
 */

export const SUPERVISION_SOCKET_EVENTS = {
  /** Vue complète (machines, applications, sélection, sauvegardes) — persistant. */
  STATE: 'supervision:state',
  /** { machineId, text?, error? } — journal de la dernière sauvegarde d'une machine (bouton « Voir la log »). */
  BACKUP_LOG: 'supervision:backup:log'
} as const;

export const SUPERVISION_CLIENT_EVENTS = {
  GET_STATE: 'supervision:state:get',
  /** { machines: Record<machineId, { label?, apps: string[] }> } — sélection ENTIÈRE (spec §4). */
  SET_SELECTION: 'supervision:selection:set',
  REFRESH_BACKUPS: 'supervision:backups:refresh',
  /** { machineId, addresses: string[] } — demande du journal de sauvegarde de cette machine. */
  GET_BACKUP_LOG: 'supervision:backup:log:get'
} as const;

export const SUPERVISION_ALL_EVENTS = {
  ...SUPERVISION_SOCKET_EVENTS,
  ...SUPERVISION_CLIENT_EVENTS
} as const;

export const SUPERVISION_PERSISTENT_EVENTS: string[] = [SUPERVISION_SOCKET_EVENTS.STATE];
