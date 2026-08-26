/**
 * Construit le `LiveCatalogs` (lieux/quois/macros vivants) que consomme l'interpréteur
 * déterministe — factorisé pour être identique côté `IaService` (conversation courante) et
 * `DeployResponder` (réinterprétation à l'exécution) : les deux ont besoin exactement de la même
 * dérivation depuis `HaBridgeClient`, jamais deux logiques différentes qui pourraient diverger.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import type { LiveCatalogs } from './interpreter/index';

export function buildLiveCatalogs(haBridgeClient: HaBridgeClient, macros: string[], excludedQuoiIds: string[]): LiveCatalogs {
  return {
    lieux: haBridgeClient.getLieuCatalog(excludedQuoiIds),
    lieuxComposes: buildLieuxComposes(haBridgeClient),
    quois: haBridgeClient.getQuoiCatalog().map((q) => q.label),
    macros,
    lieuOrigine: undefined // aucune source réelle branchée à ce stade — voir specs §16.6
  };
}

/** Dérive les paires (lieu_precis, lieu_principal) réellement observées, pour les candidats
 *  composés de l'interpréteur (§16.5) — `getLieuCatalog()` seul les a déjà aplaties. */
function buildLieuxComposes(haBridgeClient: HaBridgeClient): Array<{ lieuPrecis: string; lieu: string }> {
  const pairs: Array<{ lieuPrecis: string; lieu: string }> = [];
  const seen = new Set<string>();
  for (const entity of haBridgeClient.getAllEntities()) {
    const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
    const lieuPrecis = taxonomy?.lieu_precis;
    const lieu = taxonomy?.lieu_principal;
    if (typeof lieuPrecis === 'string' && lieuPrecis && typeof lieu === 'string' && lieu) {
      const key = `${lieuPrecis}::${lieu}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ lieuPrecis, lieu });
      }
    }
  }
  return pairs;
}
