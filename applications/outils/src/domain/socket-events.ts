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
  BUNDLE_RESULT: 'outils:bundle:result',
  // ⭐ 20/09/2026 — ZipResult, même forme/route que BUNDLE_RESULT, fichier .zip au lieu d'une
  // archive auto-extractible.
  ZIP_RESULT: 'outils:zip:result',
  // ⭐ 25/09/2026 — exécution par SSH (spec §5.5)
  EXEC_STARTED: 'outils:exec:started',
  EXEC_OUTPUT: 'outils:exec:output',
  EXEC_END: 'outils:exec:end'
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
  // ⭐ 20/09/2026 — { id, content } même contrat que BUILD_BUNDLE, produit un .zip plutôt qu'une
  // archive auto-extractible — résultat sur outils:zip:result. Proposé pour TOUT script (pas
  // seulement ceux avec @outils:bundle) : contient au minimum le wrapper substitué + son yaml.
  BUILD_ZIP: 'outils:zip:build',
  // ⭐ 19/09/2026 — { id, values: Record<string,string> } : sauvegarde les valeurs saisies (voir
  // ScriptValues.ts), aucun résultat renvoyé (fire-and-forget, simple confort).
  SAVE_VALUES: 'outils:values:save',
  // ⭐ 25/09/2026 — exécution par SSH (spec §5.5) : { id, content, host, user, dossier } ; réponse
  // tapée { runId, text } ; arrêt { runId }.
  EXEC_START: 'outils:exec:start',
  EXEC_INPUT: 'outils:exec:input',
  EXEC_CANCEL: 'outils:exec:cancel'
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
