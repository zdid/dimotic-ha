/**
 * Port web forcé par l'environnement (⭐ 13/10/2026, conception-esphome-assembleur §6).
 *
 * L'instance de dev de falbala cohabite avec l'instance réelle (Docker, 8087) : ses scripts de lancement
 * positionnent `DIMOTIC_WEB_PORT=8088`, et cette valeur est PRIORITAIRE sur `web.port` — aucun fichier de
 * configuration, aucune diffusion, aucun écran de paramètres ne peut donc la déplacer. Sans la variable
 * (cas de toutes les instances réelles), le comportement est inchangé.
 */
export const WEB_PORT_ENV = 'DIMOTIC_WEB_PORT';

/** Port forcé par l'environnement, ou null (variable absente ou invalide : ignorée). */
export function forcedWebPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[WEB_PORT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}
