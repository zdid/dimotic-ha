/**
 * Appels génériques à HA pour les applications (⭐ 13/10/2026, conception-esphome-assembleur §2 : « interroger HA ») —
 * validations pures, testées à part. Le cœur reste seul détenteur de la connexion et du jeton ; une application passe
 * par HaBridgeClient.callWs / callRest (HaQueryBridge côté cœur).
 *
 * - WebSocket : n'importe quelle commande `{ type, … }` (ex. `dimotic_plans/floorplans/list`, `config_entries/get`) ;
 *   l'`id` du message est géré par le client, un `id` fourni est refusé.
 * - REST : GET / POST / DELETE sur un chemin **sous `/api/`** de HA (ex. `/api/config/config_entries/flow` pour déclarer
 *   un appareil ESPHome) ; aucun autre hôte, aucun `..`.
 */
export type HaRestMethod = 'GET' | 'POST' | 'DELETE';

export function validateWsMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'message WebSocket : objet attendu';
  const m = message as Record<string, unknown>;
  if (typeof m.type !== 'string' || !/^[a-z0-9_]+(\/[a-z0-9_]+)*$/.test(m.type)) return 'message WebSocket : « type » invalide';
  if ('id' in m) return 'message WebSocket : « id » est géré par le client, ne pas le fournir';
  return null;
}

export function validateRestCall(method: unknown, path: unknown): string | null {
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return 'méthode REST : GET, POST ou DELETE';
  if (typeof path !== 'string' || !path.startsWith('/api/')) return 'chemin REST : doit commencer par /api/';
  if (path.includes('..') || path.includes('//') || !/^\/api\/[A-Za-z0-9_\-./?=&%:]*$/.test(path)) return 'chemin REST invalide';
  return null;
}
