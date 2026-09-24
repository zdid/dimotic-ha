/**
 * Résolution déterministe d'une intention (verbe/quoi/lieux/valeur) vers un
 * `resolved_service_call` HA — specs §7. Prolonge la table verbe→quoi de regles_mistral.txt §0.1 :
 * même liste de verbes, colonne service en plus, côté code plutôt qu'une nouvelle table à
 * maintenir séparément.
 *
 * Deux niveaux (specs §7) :
 *  - verbes sans valeur → services génériques homeassistant.turn_on/turn_off/toggle (routent
 *    eux-mêmes vers le domaine réel de l'entité, pas besoin de le connaître à l'avance)
 *  - verbes avec valeur → service spécifique au domaine (light.turn_on+brightness_pct,
 *    climate.set_temperature, cover.set_cover_position...) — HA n'a pas d'équivalent générique
 *
 * Verbe inconnu ou aucune entité : `undefined` — l'étape est tracée en échec (execution.ts). Plus
 * de repli vers l'agent de conversation de HA depuis le 24/09/2026 : cet agent EST ia (émulation
 * Ollama), le repli pouvait boucler planificateur → HA → ia → planificateur.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import type { ResolvedServiceCall } from './types';

// Verbes sans valeur → services génériques HA (routent eux-mêmes vers le domaine réel de
// l'entité ciblée, pas besoin de le connaître à l'avance).
const ON_OFF_TOGGLE_VERBS: Record<string, 'turn_on' | 'turn_off' | 'toggle'> = {
  allumer: 'turn_on',
  activer: 'turn_on',
  ouvrir: 'turn_on',
  eteindre: 'turn_off',
  desactiver: 'turn_off',
  fermer: 'turn_off',
  basculer: 'toggle'
};

// Verbes portant une valeur — le domaine (et donc le service/champ) est déterminé à partir du
// domaine réel de l'entité ciblée (entity_id.split('.')[0]), pas deviné depuis le texte du verbe :
// "régler"/"baisser"/"augmenter" visent des domaines différents selon l'entité résolue.
const VALUE_VERBS = new Set(['regler', 'baisser', 'augmenter', 'mettre']);

const DOMAIN_VALUE_SERVICE: Record<string, { service: string; dataKey: string; parseValue: (v: string | number) => unknown }> = {
  light: { service: 'turn_on', dataKey: 'brightness_pct', parseValue: Number },
  climate: { service: 'set_temperature', dataKey: 'temperature', parseValue: Number },
  cover: { service: 'set_cover_position', dataKey: 'position', parseValue: Number }
};

function normalizeVerb(verbe: string): string {
  return verbe
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** Résout les entity_id ciblés par (quoi, lieux) via HaStructureRegistry.getEntitiesByQuoiAndLieux
 *  — recherche de lieu indépendante du niveau taxonomique (lieu_precis/lieu/lieu_pere/
 *  lieu_grand_pere), voir le graphe de lieux dans HaStructureRegistry (demande utilisateur
 *  10/08/2026, généralise le repli lieu_precis initial : "salon" comme "toilettes de l'étage"
 *  passent par le même mécanisme, sans que ce module ait à savoir à quel niveau chacun est codifié). */
export async function resolveEntityIds(
  registry: HaBridgeClient,
  quoi: string,
  lieux: string[] = []
): Promise<string[]> {
  const quoiId = slugify(quoi);
  const entities = await registry.getEntitiesByQuoiAndLieux(quoiId, lieux);
  return entities.map((e) => e.entity_id);
}

/** Résout une intention (verbe/quoi/lieux/valeur) en resolved_service_call, ou undefined. */
export async function resolveAction(
  registry: HaBridgeClient,
  verbe: string,
  quoi: string,
  lieux: string[] = [],
  valeur?: string | number
): Promise<ResolvedServiceCall | undefined> {
  const entityIds = await resolveEntityIds(registry, quoi, lieux);
  if (entityIds.length === 0) return undefined;
  return buildServiceCall(verbe, entityIds, valeur);
}

/** ⭐ 24/09/2026 — verbe connu de la table ? (sert à refuser dès la création une commande que le
 *  moteur ne saurait jamais exécuter — plus de repli vers l'agent de conversation de HA). */
export function isKnownVerb(verbe: string): boolean {
  const v = normalizeVerb(verbe);
  return v in ON_OFF_TOGGLE_VERBS || VALUE_VERBS.has(v);
}

/** ⭐ 24/09/2026 — verbe inverse (fin d'une plage `window` / d'une `duration`), `undefined` si le
 *  verbe n'a pas d'inverse évident (régler, baisser…). */
const INVERSE_VERBS: Record<string, string> = {
  allumer: 'éteindre', eteindre: 'allumer',
  ouvrir: 'fermer', fermer: 'ouvrir',
  activer: 'désactiver', desactiver: 'activer'
};

export function inverseVerb(verbe: string): string | undefined {
  return INVERSE_VERBS[normalizeVerb(verbe)];
}

/** Construit l'appel de service pour des entités déjà connues — partagé entre la résolution par
 *  quoi/lieux et le ciblage direct de l'entité déclenchante (« éteins-la », trigger state_change). */
export function buildServiceCall(
  verbe: string,
  entityIds: string[],
  valeur?: string | number
): ResolvedServiceCall | undefined {
  if (entityIds.length === 0) return undefined;
  const normalizedVerb = normalizeVerb(verbe);

  if (valeur !== undefined && VALUE_VERBS.has(normalizedVerb)) {
    const domain = entityIds[0].split('.')[0];
    const entry = DOMAIN_VALUE_SERVICE[domain];
    if (!entry) return undefined;
    return {
      domain,
      service: entry.service,
      entity_id: entityIds.length === 1 ? entityIds[0] : entityIds,
      data: { [entry.dataKey]: entry.parseValue(valeur) }
    };
  }

  const genericService = ON_OFF_TOGGLE_VERBS[normalizedVerb];
  if (genericService) {
    return {
      domain: 'homeassistant',
      service: genericService,
      entity_id: entityIds.length === 1 ? entityIds[0] : entityIds
    };
  }

  return undefined;
}
