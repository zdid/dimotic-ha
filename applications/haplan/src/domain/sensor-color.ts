/**
 * Type de capteur détecté par mot-clé dans l'entity_id — même détection que
 * `UnifiedObjectFactory.getEntityType()` côté HAPLAN (domaine `sensor.*` + mot-clé, pure, aucun
 * état HA nécessaire). Sert de base à la fois à la couleur d'icône (⭐ 29/08/2026, "donner les
 * couleurs de HAPLAN aux capteurs sous HA") et au nombre de décimales affichées (⭐ 30/08/2026,
 * "humidité et pression sans chiffre après la virgule, températures 1 seul") — un seul point de
 * détection pour éviter deux logiques de mots-clés qui pourraient diverger.
 */
type SensorType = 'temperature' | 'humidity' | 'pressure' | 'power' | 'energy' | 'default';

function detectSensorType(entityId: string): SensorType | null {
  if (!entityId.startsWith('sensor.')) return null;

  if (entityId.includes('temperature')) return 'temperature';
  if (entityId.includes('humidity')) return 'humidity';
  if (entityId.includes('pressure')) return 'pressure';
  if (entityId.includes('power')) return 'power';
  if (entityId.includes('energy')) return 'energy';
  return 'default';
}

/** Couleur d'icône par type de capteur, reprise telle quelle du code HAPLAN (`Enhanced*Sensor.ts`,
 *  `getColorSchemeForType()`). Un capteur n'a pas d'état "on/off" à refléter — une seule couleur
 *  fixe par type suffit, pas de gabarit Jinja (contrairement aux switchs, voir switch-icon.ts). */
export function getSensorIconColor(entityId: string): string | null {
  const type = detectSensorType(entityId);
  if (!type) return null;

  switch (type) {
    case 'temperature': return '#F44336'; // Rouge
    case 'humidity': return '#00BCD4'; // Cyan
    case 'pressure': return '#9C27B0'; // Violet
    case 'power':
    case 'energy':
      return '#FFC107'; // Jaune/ambre
    default:
      return '#607D8B'; // Bleu gris
  }
}

/** Décimales affichées pour la valeur d'un capteur — `null` = pas de mise en forme spécifique,
 *  affichage natif de HA inchangé (demande utilisateur limitée à humidité/pression/température,
 *  pas de règle donnée pour puissance/énergie/générique — ne pas deviner un arrondi non demandé). */
export function getSensorRoundDigits(entityId: string): 0 | 1 | null {
  const type = detectSensorType(entityId);
  if (type === 'humidity' || type === 'pressure') return 0;
  if (type === 'temperature') return 1;
  return null;
}
