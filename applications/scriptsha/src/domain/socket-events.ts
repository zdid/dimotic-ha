/**
 * Événements Socket.io spécifiques à l'application scriptsha.
 *
 * Convention : préfixe 'scriptsha:', format 'scriptsha:<section>:<action>' — voir rpigpio/socket-events.ts.
 * Bridgés automatiquement (app:socket-events:registered) dans les deux sens, contrairement aux 2
 * événements internes core↔enfant (voir SCRIPTSHA_APP.bridgedEvents dans domain/index.ts), qui ne
 * sont pas des événements Socket.io et n'ont pas leur place ici.
 */

export const SCRIPTSHA_SOCKET_EVENTS = {
  SCRIPTS_LIST: 'scriptsha:scripts:list',
  SCRIPT_CONTENT: 'scriptsha:script:content',
  ERROR: 'scriptsha:error',
  // ⭐ 25/08/2026 : import de scripts/automatisations déjà présents dans HA (créés à la main,
  // hérités d'une installation antérieure...) — voir ScriptsHaService.handleImportCandidatesGet/
  // handleImportApply. Une fois importé (origin:'local'), un script bénéficie automatiquement du
  // gossip inter-instances déjà existant (voir plus bas dans ce service) : visible sur toutes les
  // machines dimotic-ha sans mécanisme supplémentaire.
  IMPORT_CANDIDATES: 'scriptsha:import:candidates'
} as const;

export const SCRIPTSHA_CLIENT_EVENTS = {
  SCRIPTS_GET: 'scriptsha:scripts:get',
  SCRIPT_DEPLOY: 'scriptsha:script:deploy',
  SCRIPT_UNDEPLOY: 'scriptsha:script:undeploy',
  SCRIPT_DELETE: 'scriptsha:script:delete',
  SCRIPT_GET_CONTENT: 'scriptsha:script:get_content',
  IMPORT_CANDIDATES_GET: 'scriptsha:import:candidates:get',
  IMPORT_APPLY: 'scriptsha:import:apply'
} as const;

export const SCRIPTSHA_ALL_EVENTS = {
  ...SCRIPTSHA_SOCKET_EVENTS,
  ...SCRIPTSHA_CLIENT_EVENTS
} as const;

export type ScriptshaSocketEvents = typeof SCRIPTSHA_SOCKET_EVENTS;
export type ScriptshaClientEvents = typeof SCRIPTSHA_CLIENT_EVENTS;
export type ScriptshaAllEvents = typeof SCRIPTSHA_ALL_EVENTS;

// Valeurs réelles des événements (pas les clés de l'objet).
export const SCRIPTSHA_PERSISTENT_EVENTS: string[] = [
  SCRIPTSHA_SOCKET_EVENTS.SCRIPTS_LIST
];
