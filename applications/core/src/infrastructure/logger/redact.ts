/**
 * ⭐ 24/09/2026 — masquage des secrets dans les JOURNAUX uniquement (demande explicite : « il faut
 * supprimer des logs, pas du transfert »). Les messages eux-mêmes (Socket.io, EventBus, IPC) restent
 * intacts ; seule leur trace écrite dans les logs passe par ici. Couvre le mot de passe Nextcloud de
 * l'app sauvegarde, le token HA, les mots de passe MQTT, les clés d'API (Mistral/Anthropic)…
 *
 * Règle : toute clé dont le nom évoque un secret (password, passwd, pass, token, secret, apiKey…)
 * voit sa valeur texte non vide remplacée par `***` — sauf les libellés d'interface
 * (…Placeholder, …Label, …Hint) qui décrivent un champ sans en contenir la valeur.
 */

const SECRET_KEY = /pass(word|wd)?|token|secret|api_?key|credential/i;
const UI_TEXT_KEY = /(placeholder|label|hint|description|title)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !UI_TEXT_KEY.test(key);
}

/** `JSON.stringify` qui masque les secrets — à utiliser pour tout contenu de message écrit dans un log. */
export function redactForLog(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(
      value,
      (key, val) => (key && isSecretKey(key) && typeof val === 'string' && val !== '' ? '***' : val),
      indent
    ) ?? String(value);
  } catch {
    return '[contenu non sérialisable]';
  }
}
