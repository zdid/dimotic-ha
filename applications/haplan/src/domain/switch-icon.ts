/**
 * Icône MDI + couleurs on/off pour les sous-types de `switch.*` que HA ne peut pas distinguer tout
 * seul — ⭐ 29/08/2026, retour utilisateur : les switchs qui pilotent en réalité un ballon d'eau
 * chaude, un radiateur ou une VMC affichent l'icône switch générique de HA sur la carte Plan
 * (aucun domaine HA dédié ni `device_class` pour ces trois cas, contrairement à light/climate/
 * cover) — vérifié que MDI a bien un équivalent pour chacun (pictogrammers.com) avant de porter
 * cette détection : `mdi:water-boiler`, `mdi:radiator`, `mdi:fan` (ce dernier explicitement tagué
 * "ventilation"). Couleurs reprises de `EnhancedWaterHeaterObject.ts`/`EnhancedRadiatorObject.ts`/
 * `EnhancedVMCObject.ts` (HAPLAN) — 29/08/2026, second retour : "les ballons c'est orange, pas
 * jaune" (confirmé dans le code HAPLAN d'origine : orange allumé / bleu éteint).
 *
 * Port de `SwitchTypeDetector` (HAPLAN, presentation/haplan/utils/SwitchTypeDetector.ts) — deux de
 * ses trois méthodes sont portées ici : par entity_id, ET par `attributs_taxonomie.quoi` (⭐
 * 15/09/2026 — un entity_id figé avant que son "quoi" ne soit précisé/corrigé, ex.
 * `switch.entree_salle` sur noisy2, ne matchait aucun mot-clé côté entity_id mais son
 * attributs_taxonomie.quoi vaut bien "Radiateur" ; il s'affichait donc en switch générique sur la
 * carte Lovelace alors que HAPLAN web l'affiche déjà correctement en radiateur depuis ce même
 * correctif côté SwitchTypeDetector). `attributs_taxonomie` est un attribut STATIQUE de l'entité
 * (déjà publié par RFXCOM/EVOO7/nommage, comme entity_id), pas un état live — utilisable au moment
 * du dépôt, contrairement au troisième fallback de cette classe (`detectByAttributes`, ex:
 * `water_temperature`/`fan_mode`) qui LUI reste hors de portée pour un tableau de bord statique.
 * Cas résiduel accepté (ni entity_id ni taxonomie ne matchent) : icône switch générique de HA,
 * comme aujourd'hui — pas un blocage, juste pas d'amélioration.
 *
 * Volontairement limité à ces trois sous-types de `switch.*` : les autres domaines
 * (light/climate/cover, et les capteurs avec `device_class`) ont déjà une icône HA native
 * pertinente — la dupliquer ici risquerait de DÉGRADER un choix HA déjà meilleur (ex: un `cover`
 * avec `device_class: garage` affiche une icône garage bien plus juste qu'un `mdi:window-shutter`
 * générique qu'on imposerait à l'aveugle sans connaître ce `device_class` au moment du dépôt).
 */
export interface SwitchIconStyle {
  icon: string;
  colorOn: string;
  colorOff: string;
}

/** Recherche des mots-clés de type dans un texte donné — même liste que SwitchTypeDetector.
 *  matchKeywords(), partagée ici entre le texte de l'entity_id et celui du "quoi" taxonomie. */
function matchKeywords(text: string): SwitchIconStyle | null {
  const lower = text.toLowerCase();

  if (lower.includes('ventilation') || lower.includes('vmc') || lower.includes('fan')) {
    return { icon: 'mdi:fan', colorOn: '#FFEB3B', colorOff: '#FFFFFF' }; // Jaune allumé / blanc éteint
  }
  if (lower.includes('water_heater') || lower.includes('chauffe_eau') || lower.includes('ballon')) {
    return { icon: 'mdi:water-boiler', colorOn: '#FF9800', colorOff: '#2196F3' }; // Orange allumé / bleu éteint
  }
  if (
    lower.includes('radiateur') ||
    lower.includes('radiator') ||
    lower.includes('heating') ||
    lower.includes('chauffage')
  ) {
    return { icon: 'mdi:radiator', colorOn: '#F44336', colorOff: '#2196F3' }; // Rouge allumé / bleu éteint
  }
  return null;
}

/** `taxonomyQuoi` : `attributs_taxonomie.quoi` de l'entité si connu (voir en-tête de fichier) —
 *  repli utilisé seulement si l'entity_id seul ne matche aucun mot-clé. */
export function detectSwitchIconStyle(entityId: string, taxonomyQuoi?: string | null): SwitchIconStyle | null {
  return matchKeywords(entityId) ?? (taxonomyQuoi ? matchKeywords(taxonomyQuoi) : null);
}
