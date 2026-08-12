/**
 * Vérifie que les références HA (couples quoi/lieux, entity_id de déclencheur state_change)
 * présentes dans une réponse JSON structurée correspondent bien à des entités réelles — peu
 * importe la provenance du JSON (conversation directe via IaService, réinterprétation à
 * l'exécution via DeployResponder).
 *
 * Bug réel constaté (comparatif Claude/Mistral, 11/08/2026) : sur une planification à déclencheur
 * d'état ("quand la porte d'entrée s'ouvre...", "si la température dépasse..."), Mistral invente
 * parfois un entity_id plausible mais inexistant (ex: "sensor.salon_temperature") sans jamais
 * appeler lister_entites/obtenir_etat pour vérifier — contrairement à l'outil executer_action
 * (résolu par planificateur) ou au texte libre "quoi_introuvable" (détecté par
 * isUnverifiedQuoiIntrouvable dans IaService), rien ne vérifiait jusqu'ici les couples quoi/lieux
 * ni les entity_id internes à un JSON structuré (planification/macro/condition/sequence/execution)
 * avant de le transmettre à planificateur — la planification créée ne se déclenche alors jamais,
 * en silence.
 */

import type { HaStructureRegistry } from '../../../core/dist/exports';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export interface ReferenceProblem {
  path: string;
  detail: string;
}

/** Parcourt récursivement l'objet (structure arbitraire — steps de tableau compris, un tableau se
 *  parcourt comme un objet en JS) à la recherche de couples {quoi, lieux} et de déclencheurs
 *  state_change, et vérifie chacun contre le référentiel HA réel. Registre absent (ia sans accès
 *  HA en lecture) → aucune vérification possible, retourne [] plutôt que de bloquer à tort. */
export function validateReferences(data: unknown, registry: HaStructureRegistry | undefined): ReferenceProblem[] {
  if (!registry) return [];
  const problems: ReferenceProblem[] = [];
  walk(data, '', registry, problems);
  return problems;
}

function walk(node: unknown, path: string, registry: HaStructureRegistry, problems: ReferenceProblem[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.quoi === 'string' && obj.quoi.trim()) {
    const lieux = Array.isArray(obj.lieux) ? (obj.lieux as unknown[]).filter((l): l is string => typeof l === 'string') : [];
    const entities = registry.getEntitiesByQuoiAndLieux(slugify(obj.quoi), lieux);
    if (entities.length === 0) {
      problems.push({
        path: path || 'racine',
        detail: `"${obj.quoi}"${lieux.length ? ` (${lieux.join(', ')})` : ''} : aucune entité correspondante`
      });
    }
  }

  if (obj.type === 'state_change' && typeof obj.entity_id === 'string' && !registry.getEntity(obj.entity_id)) {
    problems.push({ path: path ? `${path}.entity_id` : 'entity_id', detail: `entité "${obj.entity_id}" inexistante` });
  }

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') walk(value, path ? `${path}.${key}` : key, registry, problems);
  }
}

/** Message renvoyé à l'utilisateur quand la vérification échoue encore après la relance forcée
 *  (tool_choice=any) — jamais de création/exécution sur une référence non vérifiée. */
export function buildCorrectionRequestMessage(problems: ReferenceProblem[]): string {
  const details = problems.map((p) => `• ${p.detail}`).join('\n');
  return `Je ne peux pas donner suite : certains éléments référencés n'existent pas dans la maison.\n${details}\nPeux-tu préciser ou reformuler ta demande ?`;
}
