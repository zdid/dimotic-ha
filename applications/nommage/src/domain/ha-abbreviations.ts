/**
 * Abréviations de la découverte MQTT de Home Assistant (`dev`, `ids`, `uniq_id`…). Certaines sources (ESPHome) publient
 * leur découverte sous cette forme abrégée ; NOMMAGE et le cœur lisent la forme longue (`device.name`,
 * `device.suggested_area`…). On développe donc les seules clés qu'ils exploitent, avant tout traitement, pour qu'une
 * source abrégée soit traitée comme une autre (taxonomie calculée depuis `device.name`, pièce suggérée, etc.).
 */

const CLES_RACINE: Record<string, string> = {
  dev: 'device',
  dev_cla: 'device_class',
  uniq_id: 'unique_id',
  obj_id: 'object_id',
  ent_cat: 'entity_category'
};

const CLES_APPAREIL: Record<string, string> = {
  ids: 'identifiers',
  cns: 'connections',
  mf: 'manufacturer',
  mdl: 'model',
  sw: 'sw_version',
  hw: 'hw_version',
  sa: 'suggested_area',
  cu: 'configuration_url'
};

function developper(source: Record<string, unknown>, table: Record<string, string>): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(source)) {
    const longue = table[cle];
    // Une clé longue déjà présente l'emporte sur son abréviation.
    if (longue && longue in source) continue;
    sortie[longue ?? cle] = valeur;
  }
  return sortie;
}

/** Retourne une copie du message de découverte avec `dev` et ses clés abrégées développées (autres clés inchangées). */
export function expandHaAbbreviations(payload: Record<string, unknown>): Record<string, unknown> {
  const racine = developper(payload, CLES_RACINE);
  const appareil = racine.device;
  if (appareil && typeof appareil === 'object' && !Array.isArray(appareil)) {
    racine.device = developper(appareil as Record<string, unknown>, CLES_APPAREIL);
  }
  return racine;
}
