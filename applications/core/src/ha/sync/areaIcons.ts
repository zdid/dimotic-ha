// src/ha/sync/areaIcons.ts
// Table statique nom de pièce (FR) → icône mdi, utilisée par AreaEnsureService pour donner une
// icône cohérente aux areas qu'il crée lui-même (demande utilisateur, 12/08/2026 — HA propose bien
// des icônes par défaut selon le nom dans son assistant d'onboarding, mais c'est un comportement
// purement frontend, jamais appliqué aux areas créées via l'API WebSocket).
//
// Correspondance volontairement approximative (mots-clés, pas noms exacts) : les noms d'area réels
// varient ("Chambre d'ami", "Chambre du bas", "Chambre de jojo"...). Ordre des entrées significatif
// — la première correspondance gagne, donc les motifs les plus spécifiques d'abord (ex: "salle de
// bain" avant "salle", "salle à manger" avant "salle").
const AREA_ICON_RULES: Array<{ pattern: RegExp; icon: string }> = [
  { pattern: /salle de bain/, icon: 'mdi:bathtub' },
  { pattern: /salle à manger|salle a manger/, icon: 'mdi:table-chair' },
  { pattern: /toilettes?/, icon: 'mdi:toilet' },
  { pattern: /cuisine/, icon: 'mdi:chef-hat' },
  { pattern: /salon/, icon: 'mdi:sofa' },
  { pattern: /chambre/, icon: 'mdi:bed' },
  { pattern: /bureau/, icon: 'mdi:desk' },
  { pattern: /buanderie/, icon: 'mdi:washing-machine' },
  { pattern: /garage/, icon: 'mdi:garage' },
  { pattern: /cave/, icon: 'mdi:bottle-wine' },
  { pattern: /grenier/, icon: 'mdi:home-roof' },
  { pattern: /couloir/, icon: 'mdi:floor-plan' },
  { pattern: /escalier/, icon: 'mdi:stairs' },
  { pattern: /entrée|entree/, icon: 'mdi:door' },
  { pattern: /dressing/, icon: 'mdi:hanger' },
  { pattern: /terrasse/, icon: 'mdi:umbrella-beach' },
  { pattern: /jardin/, icon: 'mdi:flower' },
  { pattern: /extérieur|exterieur/, icon: 'mdi:home-outline' },
  { pattern: /garde-?manger|cellier/, icon: 'mdi:fridge' },
];

/**
 * Normalise en minuscules. Pas de suppression d'accents : les motifs ci-dessus couvrent
 * explicitement les deux variantes (accentuée / non accentuée) là où c'est pertinent.
 */
function normalize(name: string): string {
  return name.toLowerCase();
}

/**
 * Devine une icône mdi à partir du nom de la pièce, ou `undefined` si aucun motif connu ne
 * correspond (HA applique alors son icône par défaut générique).
 */
export function guessAreaIcon(name: string): string | undefined {
  const normalized = normalize(name);
  return AREA_ICON_RULES.find((rule) => rule.pattern.test(normalized))?.icon;
}
