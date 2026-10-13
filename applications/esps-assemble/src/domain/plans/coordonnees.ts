/**
 * Conversion des coordonnées des plans vers l'écran (fonctionnelles-espdisplay_specs §10 ; conception-esphome-assembleur §7).
 *
 * Elle se fait ICI, à l'assemblage — ni dans HA (qui ne connaît pas l'écran) ni sur l'ESP (qui ne reçoit que des pixels) — en deux étapes :
 *  1. **Ancrage** : l'intégration Plans donne le **coin inférieur gauche** de l'icône (fraction 0–1 de l'image) ; l'ancien générateur
 *     (`tools/generate_esphome_floorplan.py`) raisonnait en **centre**. On décale d'une demi-icône (vers la droite et vers le haut), la
 *     taille étant celle de l'icône SUR L'ÉCRAN (déclarée par l'élément), pas celle du panneau HA (28 px).
 *  2. **Mise à l'échelle** : l'image est ramenée à la taille de l'écran en gardant ses proportions (« contain »), centrée (bandes
 *     noires) ; px = décalage + x × largeur_image × échelle ; la boîte est ensuite **bornée** pour rester entièrement dans l'écran.
 * Mêmes arrondis que le script Python d'origine (arrondi « au pair » de `round`, division entière), pour un résultat identique au pixel.
 */

export interface Dimensions {
  largeur: number;
  hauteur: number;
}

export interface Ajustement {
  echelle: number;
  /** Taille de l'image une fois mise à l'échelle. */
  largeurImage: number;
  hauteurImage: number;
  decalageX: number;
  decalageY: number;
}

/** `round` de Python 3 : arrondi au pair le plus proche sur les demis (2,5 → 2 ; 3,5 → 4). */
export function arrondi(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Équivalent de `fit_and_pad` : image ramenée à l'écran en conservant le ratio, centrée. */
export function ajuster(image: Dimensions, ecran: Dimensions): Ajustement {
  if (image.largeur <= 0 || image.hauteur <= 0 || ecran.largeur <= 0 || ecran.hauteur <= 0) throw new Error('dimensions invalides');
  const echelle = Math.min(ecran.largeur / image.largeur, ecran.hauteur / image.hauteur);
  const largeurImage = arrondi(image.largeur * echelle);
  const hauteurImage = arrondi(image.hauteur * echelle);
  return {
    echelle,
    largeurImage,
    hauteurImage,
    decalageX: Math.floor((ecran.largeur - largeurImage) / 2),
    decalageY: Math.floor((ecran.hauteur - hauteurImage) / 2)
  };
}

/** Position d'un point de l'image (fractions 0–1) en pixels de l'écran, avant tout bornage. */
export function versPixels(fx: number, fy: number, image: Dimensions, a: Ajustement): { x: number; y: number } {
  return { x: arrondi(a.decalageX + fx * image.largeur * a.echelle), y: arrondi(a.decalageY + fy * image.hauteur * a.echelle) };
}

export interface Boite {
  largeur: number;
  hauteur: number;
}

/** Coin haut-gauche d'une boîte centrée sur (cx, cy), bornée pour rester ENTIÈREMENT dans l'écran (équivalent de `clamp_box`). */
export function boiteCentree(cx: number, cy: number, boite: Boite, ecran: Dimensions): { x: number; y: number } {
  const x = cx - Math.floor(boite.largeur / 2);
  const y = cy - Math.floor(boite.hauteur / 2);
  return { x: Math.max(0, Math.min(x, ecran.largeur - boite.largeur)), y: Math.max(0, Math.min(y, ecran.hauteur - boite.hauteur)) };
}

export type Ancrage = 'bas-gauche' | 'centre';

export interface PositionEcran {
  /** Centre de l'icône en pixels (ce que calculait l'ancien générateur). */
  centreX: number;
  centreY: number;
  /** Coin haut-gauche de la boîte, bornée à l'écran. */
  x: number;
  y: number;
  /** Vrai si le point d'ancrage tombe hors de l'écran (position à ignorer comme le faisait l'ancien générateur). */
  horsEcran: boolean;
}

/**
 * Convertit la position d'un objet du plan en position sur l'écran.
 * `ancrage` : `bas-gauche` (intégration Plans, v0.1.6+) ou `centre` (anciens plans HAPLAN) ; `boite` : taille de l'objet SUR L'ÉCRAN.
 */
export function positionSurEcran(
  pos: { x: number; y: number },
  image: Dimensions,
  ecran: Dimensions,
  boite: Boite,
  ancrage: Ancrage = 'bas-gauche'
): PositionEcran {
  const a = ajuster(image, ecran);
  const p = versPixels(pos.x, pos.y, image, a);
  const horsEcran = !(p.x >= 0 && p.x <= ecran.largeur && p.y >= 0 && p.y <= ecran.hauteur);
  // Étape 1 — ancrage : le coin bas-gauche devient le centre (demi-boîte vers la droite et vers le haut).
  const centreX = ancrage === 'bas-gauche' ? p.x + Math.floor(boite.largeur / 2) : p.x;
  const centreY = ancrage === 'bas-gauche' ? p.y - Math.floor(boite.hauteur / 2) : p.y;
  const b = boiteCentree(centreX, centreY, boite, ecran);
  return { centreX, centreY, x: b.x, y: b.y, horsEcran };
}
