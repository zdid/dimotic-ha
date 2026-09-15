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
 * Port de `SwitchTypeDetector.detectByEntityId()` (HAPLAN, presentation/haplan/utils/
 * SwitchTypeDetector.ts) — SEULE la méthode par entity_id est portée ici (pure, aucun état HA
 * nécessaire, donc utilisable au moment du dépôt sans requête à HA). Le fallback par attributs de
 * cette même classe (`detectByAttributes`, ex: `water_temperature`, `fan_mode`) n'est PAS porté —
 * demanderait l'état live de l'entité au moment de la génération du YAML, hors de portée pour un
 * tableau de bord statique. Cas résiduel accepté (entity_id mal nommé ne matchant aucun mot-clé) :
 * icône switch générique de HA, comme aujourd'hui — pas un blocage, juste pas d'amélioration.
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

export function detectSwitchIconStyle(entityId: string): SwitchIconStyle | null {
  const lowerId = entityId.toLowerCase();

  if (lowerId.includes('ventilation') || lowerId.includes('vmc') || lowerId.includes('fan')) {
    return { icon: 'mdi:fan', colorOn: '#FFEB3B', colorOff: '#FFFFFF' }; // Jaune allumé / blanc éteint
  }
  if (lowerId.includes('water_heater') || lowerId.includes('chauffe_eau') || lowerId.includes('ballon')) {
    return { icon: 'mdi:water-boiler', colorOn: '#FF9800', colorOff: '#2196F3' }; // Orange allumé / bleu éteint
  }
  if (
    lowerId.includes('radiateur') ||
    lowerId.includes('radiator') ||
    lowerId.includes('heating') ||
    lowerId.includes('chauffage')
  ) {
    // ⭐ 15/09/2026 : "radiateur" ajouté — cette fonction est un port figé de
    // SwitchTypeDetector.detectByEntityId (HAPLAN), qui avait le même bug jusqu'au 14/09/2026
    // (switch.salle_radiateur_18 et les 7 autres radiateurs de noisy2 n'étaient détectés par
    // aucun des deux). Garder les deux copies synchronisées si l'une est de nouveau corrigée.
    return { icon: 'mdi:radiator', colorOn: '#F44336', colorOff: '#2196F3' }; // Rouge allumé / bleu éteint
  }
  return null;
}
