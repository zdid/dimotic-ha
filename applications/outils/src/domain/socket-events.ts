/**
 * Événements Socket.io spécifiques à l'application Outils.
 *
 * Conventions : préfixe 'outils:', format 'outils:<section>:<action>' — même pattern que
 * rfxcom/arexx/teleinfo/sauvegarde.
 */

export const OUTILS_SOCKET_EVENTS = {
  STATUS: 'outils:status',
  ERROR: 'outils:error',
  SCRIPT_RESULT: 'outils:script:result',
  ADD_RESULT: 'outils:script:add:result',
  DELETE_RESULT: 'outils:script:delete:result',
  // ⭐ 18/09/2026 — BundleResult { success, token?, filename?, error? } ; le token pointe vers
  // GET /api/apps/outils/download/:token (voir PresentationServer), pas de contenu binaire ici.
  BUNDLE_RESULT: 'outils:bundle:result'
} as const;

export const OUTILS_CLIENT_EVENTS = {
  GET_STATUS: 'outils:status:get',
  // { id } — renvoie OutilScriptDetail (contenu + variables détectées) sur outils:script:result.
  GET_SCRIPT: 'outils:script:get',
  // { id } — retire un script (config + fichier .sh) — résultat sur outils:script:delete:result.
  DELETE_SCRIPT: 'outils:script:delete',
  // { id, content } — content = script déjà substitué (variables remplies côté navigateur, même
  // texte qu'un téléchargement direct) ; uniquement pour un script avec au moins une directive
  // @outils:bundle (voir OutilScriptDetail.hasBundling) — résultat sur outils:bundle:result.
  BUILD_BUNDLE: 'outils:bundle:build',
  // ⭐ 19/09/2026 — { id, values: Record<string,string> } : sauvegarde les valeurs saisies (voir
  // ScriptValues.ts), aucun résultat renvoyé (fire-and-forget, simple confort).
  SAVE_VALUES: 'outils:values:save'
} as const;

export const OUTILS_ALL_EVENTS = {
  ...OUTILS_SOCKET_EVENTS,
  ...OUTILS_CLIENT_EVENTS
} as const;

export type OutilsSocketEvents = typeof OUTILS_SOCKET_EVENTS;
export type OutilsClientEvents = typeof OUTILS_CLIENT_EVENTS;
export type OutilsAllEvents = typeof OUTILS_ALL_EVENTS;

// Événements persistants (rejoués automatiquement à la connexion).
export const OUTILS_PERSISTENT_EVENTS: string[] = [
  OUTILS_SOCKET_EVENTS.STATUS
];
