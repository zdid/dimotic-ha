/**
 * Nettoyage automatique des listes de cibles de déploiement (⭐ 29/09/2026, demande utilisateur :
 * « la machine ha2 est la même vue depuis ha2, stfort ou orangepi2 » — savoir de quelle machine on
 * l'a apprise n'a aucun sens). Les cibles ne s'échangent plus par MQTT : elles circulent avec
 * data/core/config.yaml par la diffusion des données (techniques-diffusion-data_specs §2ter).
 *
 * Règles, appliquées à chaque liste (core / haStack / zigbee2mqtt) :
 *   - l'ancien préfixe d'origine `machineSource::` est retiré de l'identifiant ;
 *   - une machine = une ligne : deux lignes de même adresse ET même dossier sont fusionnées (la
 *     ligne saisie localement l'emporte, sinon la première ; un champ vide est complété par l'autre) ;
 *   - toutes les lignes redeviennent `origin: 'local'` (plus d'origine « apprise ») ;
 *   - un identifiant déjà pris par une autre machine reçoit un suffixe -2, -3…
 * Une ligne sans adresse n'est jamais fusionnée (cible en cours de saisie).
 */

export interface CleanableTarget {
  id: string;
  host: string;
  remoteDir: string;
  origin: 'local' | 'gossip';
}

export interface CleanupResult<T> {
  targets: T[];
  changed: boolean;
  /** Nombre de lignes retirées (doublons fusionnés). */
  merged: number;
}

function baseId(id: string): string {
  const i = id.lastIndexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

export function cleanupTargets<T extends CleanableTarget>(list: T[]): CleanupResult<T> {
  // Lignes locales d'abord : ce sont elles qui gardent leur identifiant et leurs réglages.
  const ordered = [...list.filter((t) => t.origin !== 'gossip'), ...list.filter((t) => t.origin === 'gossip')];
  const byMachine = new Map<string, T>();
  const result: T[] = [];
  let merged = 0;

  for (const target of ordered) {
    const key = target.host ? `${target.host.trim().toLowerCase()}|${target.remoteDir}` : '';
    const existing = key ? byMachine.get(key) : undefined;
    if (existing) {
      for (const [k, v] of Object.entries(target)) {
        const current = (existing as Record<string, unknown>)[k];
        if ((current === undefined || current === '') && v !== undefined && v !== '') (existing as Record<string, unknown>)[k] = v;
      }
      merged++;
      continue;
    }
    const copy = { ...target, origin: 'local' as const };
    if (key) byMachine.set(key, copy);
    result.push(copy);
  }

  const used = new Set<string>();
  for (const target of result) {
    const base = baseId(target.id) || target.host || 'machine';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    target.id = id;
  }

  const changed = merged > 0 || result.length !== list.length ||
    result.some((t, i) => JSON.stringify(t) !== JSON.stringify(list[i]));
  return { targets: result, changed, merged };
}
