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
 * Échec silencieux si le verbe est inconnu : resolved_service_call reste absent, le repli
 * (execution.ts, HaWsClient.processConversation) prend le relais.
 */

import type { HaStructureRegistry } from '../../../core/dist/exports';
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

/** Résout les entity_id ciblés par (quoi, lieux) via HaStructureRegistry. */
export function resolveEntityIds(
  registry: HaStructureRegistry,
  quoi: string,
  lieux: string[] = []
): string[] {
  const quoiId = slugify(quoi);

  if (lieux.length === 0) {
    return registry.getEntitiesByQuoi(quoiId).map((e) => e.entity_id);
  }

  const areas = [...registry.getAreas().values()];
  const entityIds = new Set<string>();

  for (const lieu of lieux) {
    const lieuSlug = slugify(lieu);
    const matchedAreas = areas.filter((a) => slugify(a.name) === lieuSlug || slugify(a.area_id) === lieuSlug);

    if (matchedAreas.length > 0) {
      for (const area of matchedAreas) {
        for (const entity of registry.getEntitiesByAreaAndQuoi(area.area_id, quoiId)) {
          entityIds.add(entity.entity_id);
        }
      }
      continue;
    }

    // ⭐ 10/08/2026 — repli sur le lieu précis de la taxonomie (ex: "Salon", plus fin que l'area
    // HA "Salle" qui le contient) : uniquement si ce terme ne correspond à AUCUNE area HA, pour ne
    // jamais élargir une cible déjà précisément résolue par area. Demande utilisateur : "éteins le
    // salon" éteignait toute la salle (les 4 lumières), faute de ce repli — seule l'area "Salle"
    // était consultable, "Salon" n'existe qu'en attribut d'entité (attributs_taxonomie.lieu_precis),
    // jamais comme area HA à part entière.
    for (const entity of registry.getEntitiesByQuoi(quoiId)) {
      if (matchesLieuPrecis(entity, lieuSlug)) {
        entityIds.add(entity.entity_id);
      }
    }
  }

  return [...entityIds];
}

function matchesLieuPrecis(entity: { attributes: Record<string, unknown> }, lieuSlug: string): boolean {
  const taxonomie = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
  if (!taxonomie) return false;
  if (typeof taxonomie.slug_precis === 'string' && taxonomie.slug_precis === lieuSlug) return true;
  return typeof taxonomie.lieu_precis === 'string' && slugify(taxonomie.lieu_precis) === lieuSlug;
}

/** Résout une intention (verbe/quoi/lieux/valeur) en resolved_service_call, ou undefined. */
export function resolveAction(
  registry: HaStructureRegistry,
  verbe: string,
  quoi: string,
  lieux: string[] = [],
  valeur?: string | number
): ResolvedServiceCall | undefined {
  const entityIds = resolveEntityIds(registry, quoi, lieux);
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
