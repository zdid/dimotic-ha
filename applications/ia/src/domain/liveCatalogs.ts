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
    lieuOrigine: undefined, // aucune source réelle branchée à ce stade — voir specs §16.6
    quoiUniqueLieu: buildQuoiUniqueLieu(haBridgeClient)
  };
}

/** Pour chaque quoi, le lieu_principal unique où il existe dans toute la maison — absent si le
 *  quoi n'existe nulle part ou existe dans plusieurs lieux distincts (§16.6bis, demande utilisateur
 *  27/08/2026). Niveau `lieu_principal`, PAS `lieu_precis` : deux entités dans le MÊME lieu à des
 *  lieu_precis différents (ex. deux appliques dans le même salon) comptent pour un seul lieu — les
 *  cibler ensemble via ce lieu est le comportement attendu, pas une ambiguïté. Clé du résultat =
 *  label affichage du quoi (même valeur que `flat.quoi` dans buildActionParams), pas son id/slug —
 *  évite toute re-slugification ici. */
function buildQuoiUniqueLieu(haBridgeClient: HaBridgeClient): Record<string, string> {
  const lieuxParQuoiId = new Map<string, Set<string>>();
  for (const entity of haBridgeClient.getAllEntities()) {
    const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
    const quoiId = taxonomy?.slug_quoi;
    const lieu = taxonomy?.lieu_principal;
    if (typeof quoiId === 'string' && quoiId && typeof lieu === 'string' && lieu) {
      if (!lieuxParQuoiId.has(quoiId)) lieuxParQuoiId.set(quoiId, new Set());
      lieuxParQuoiId.get(quoiId)!.add(lieu);
    }
  }
  const result: Record<string, string> = {};
  for (const q of haBridgeClient.getQuoiCatalog()) {
    const lieux = lieuxParQuoiId.get(q.quoi_id);
    if (lieux && lieux.size === 1) result[q.label] = [...lieux][0];
  }
  return result;
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
