/**
 * Événements Socket.io spécifiques à l'application `ia`.
 * Convention : préfixe 'ia:', format 'ia:<section>:<action>'.
 */

export const IA_SOCKET_EVENTS = {
  STATUS: 'ia:status',
  EXCHANGES_LIST: 'ia:exchanges:list',
  TEST_REPLY: 'ia:test:reply',
  // ⭐ Comparatif Claude/Mistral (demande utilisateur, 11/08/2026) — voir IaService.handleCompareCommand.
  COMPARE_REPLY: 'ia:compare:reply',
  ERROR: 'ia:error'
} as const;

export const IA_CLIENT_EVENTS = {
  GET_STATUS: 'ia:status:get',
  GET_EXCHANGES: 'ia:exchanges:list:get',
  // Saisie manuelle d'une commande "comme si elle venait de HA" (specs §13) — teste le pipeline
  // complet (règles, outils, routage JSON) sans passer par le serveur Ollama émulé.
  TEST_SEND: 'ia:test:send',
  // ⭐ Envoie la même phrase aux DEUX fournisseurs (config-schema.ts::provider et l'autre) : celui
  // actif exécute réellement (comme TEST_SEND), l'autre s'arrête juste avant l'exécution/dispatch
  // (dry-run) — comparaison de la décision structurée + du temps de réponse, journalisée dans
  // data/ia/comparatif.log (voir IaService.handleCompareCommand).
  COMPARE_SEND: 'ia:compare:send'
} as const;

export const IA_ALL_EVENTS = {
  ...IA_SOCKET_EVENTS,
  ...IA_CLIENT_EVENTS
} as const;

export type IaSocketEvents = typeof IA_SOCKET_EVENTS;
export type IaClientEvents = typeof IA_CLIENT_EVENTS;
export type IaAllEvents = typeof IA_ALL_EVENTS;

export const IA_PERSISTENT_EVENTS: string[] = [
  IA_SOCKET_EVENTS.STATUS,
  IA_SOCKET_EVENTS.EXCHANGES_LIST
];
