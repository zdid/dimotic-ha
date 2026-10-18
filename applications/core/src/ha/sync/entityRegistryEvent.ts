// Lecture d'un événement `entity_registry_updated` de HA → métadonnées d'entité transmises au reste du cœur.
// `old_entity_id` n'est présent que si l'entity_id a CHANGÉ (renommage dans HA) : le cache doit alors retirer l'ancien.

import type { HaEntityRegistryUpdatedMessage } from '../types/ha-entity';

export function metaDepuisEvenementRegistre(message: HaEntityRegistryUpdatedMessage) {
  const d = message.data;
  return {
    entity_id: d.entity_id,
    ...(d.old_entity_id && d.old_entity_id !== d.entity_id ? { old_entity_id: d.old_entity_id } : {}),
    domain: d.entity?.domain || '',
    device_class: d.entity?.device_class,
    area_id: d.entity?.area_id,
    entity_category: d.entity?.entity_category,
    hidden_by: d.entity?.hidden_by,
    disabled_by: d.entity?.disabled_by,
    platform: d.entity?.platform,
    action: d.action
  };
}
