import { describe, it, expect } from 'vitest';
import { arrondi, ajuster, versPixels, boiteCentree, positionSurEcran } from '../coordonnees';

// Valeurs de référence calculées avec le script Python d'origine (tools/generate_esphome_floorplan.py : fit_and_pad, round, clamp_box).
describe('arrondi (comme round de Python)', () => {
  it('arrondit les demis au pair', () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, 2.4, 2.6].map(arrondi)).toEqual([0, 2, 2, 4, 0, 2, 3]);
  });
});

describe('ajustement de l\'image à l\'écran (fit_and_pad)', () => {
  it('plan portrait 660x790 sur écran 800x480 : bandes à gauche et à droite', () => {
    const a = ajuster({ largeur: 660, hauteur: 790 }, { largeur: 800, hauteur: 480 });
    expect(a).toMatchObject({ largeurImage: 401, hauteurImage: 480, decalageX: 199, decalageY: 0 });
    expect(a.echelle).toBeCloseTo(480 / 790, 10);
  });
  it('plan paysage 790x660 sur écran 800x480', () => {
    const a = ajuster({ largeur: 790, hauteur: 660 }, { largeur: 800, hauteur: 480 });
    expect(a).toMatchObject({ largeurImage: 575, hauteurImage: 480, decalageX: 112, decalageY: 0 });
  });
  it('image déjà au format de l\'écran : aucun décalage', () => {
    expect(ajuster({ largeur: 800, hauteur: 480 }, { largeur: 800, hauteur: 480 })).toMatchObject({ echelle: 1, decalageX: 0, decalageY: 0 });
  });
  it('plan plus large que l\'écran : bandes en haut et en bas', () => {
    expect(ajuster({ largeur: 1600, hauteur: 600 }, { largeur: 800, hauteur: 480 })).toMatchObject({ largeurImage: 800, hauteurImage: 300, decalageX: 0, decalageY: 90 });
  });
  it('dimensions invalides refusées', () => {
    expect(() => ajuster({ largeur: 0, hauteur: 10 }, { largeur: 800, hauteur: 480 })).toThrow();
  });
});

const IMG = { largeur: 660, hauteur: 790 };
const ECR = { largeur: 800, hauteur: 480 };
const ICONE = { largeur: 32, hauteur: 32 };

describe('un objet au coin inférieur gauche du plan tombe au pixel attendu', () => {
  it('coin bas-gauche (0,1) : le coin de l\'icône est au coin bas-gauche de l\'image, pas au centre', () => {
    const r = positionSurEcran({ x: 0, y: 1 }, IMG, ECR, ICONE, 'bas-gauche');
    // image à gauche = 199 px, bas = 480 : centre = (199+16, 480-16), boîte haut-gauche = (199, 448)
    expect(r).toMatchObject({ centreX: 215, centreY: 464, x: 199, y: 448, horsEcran: false });
  });
  it('même point en ancrage « centre » (anciens plans HAPLAN) : le centre est au point, boîte bornée', () => {
    const r = positionSurEcran({ x: 0, y: 1 }, IMG, ECR, ICONE, 'centre');
    expect(r).toMatchObject({ centreX: 199, centreY: 480, x: 183, y: 448 });
  });
  it('coin haut-droit (1,0) : boîte bornée pour rester entièrement dans l\'écran', () => {
    const r = positionSurEcran({ x: 1, y: 0 }, IMG, ECR, ICONE, 'bas-gauche');
    expect(r.x + ICONE.largeur).toBeLessThanOrEqual(800);
    expect(r.y).toBe(0);
    expect(r.x).toBe(600); // bord droit de l'image (199 + 401), la boîte de 32 px tient encore dans l'écran
  });
  it('centre de l\'image', () => {
    const r = positionSurEcran({ x: 0.5, y: 0.5 }, IMG, ECR, ICONE, 'bas-gauche');
    expect(r).toMatchObject({ x: 400, y: 208 }); // le point (400,240) est le coin bas-gauche de l'icône : la boîte de 32 px monte jusqu'à y = 208
  });
});

describe('équivalence avec l\'ancien générateur sur des positions aléatoires', () => {
  /** Réimplémentation littérale du Python d'origine pour des positions « centre » (px = round(offset_x + x·W·scale) ; clamp_box). */
  function ancien(fx: number, fy: number, img: { largeur: number; hauteur: number }, ecr: { largeur: number; hauteur: number }, box: number) {
    const scale = Math.min(ecr.largeur / img.largeur, ecr.hauteur / img.hauteur);
    const sw = arrondi(img.largeur * scale), sh = arrondi(img.hauteur * scale);
    const ox = Math.floor((ecr.largeur - sw) / 2), oy = Math.floor((ecr.hauteur - sh) / 2);
    const px = arrondi(ox + fx * img.largeur * scale), py = arrondi(oy + fy * img.hauteur * scale);
    const x = Math.max(0, Math.min(px - Math.floor(box / 2), ecr.largeur - box));
    const y = Math.max(0, Math.min(py - Math.floor(box / 2), ecr.hauteur - box));
    return { px, py, x, y };
  }
  it('1000 positions, trois formats d\'image, deux écrans : écart 0 pixel', () => {
    let seed = 42; const alea = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const images = [{ largeur: 660, hauteur: 790 }, { largeur: 790, hauteur: 660 }, { largeur: 1000, hauteur: 700 }];
    const ecrans = [{ largeur: 800, hauteur: 480 }, { largeur: 240, hauteur: 320 }];
    for (let n = 0; n < 1000; n++) {
      const img = images[n % 3], ecr = ecrans[n % 2], fx = alea(), fy = alea();
      const ref = ancien(fx, fy, img, ecr, 32);
      const nouveau = positionSurEcran({ x: fx, y: fy }, img, ecr, ICONE, 'centre');
      expect({ x: nouveau.x, y: nouveau.y, cx: nouveau.centreX, cy: nouveau.centreY }).toEqual({ x: ref.x, y: ref.y, cx: ref.px, cy: ref.py });
    }
  });
  it('ancrage bas-gauche = ancrage centre décalé d\'une demi-boîte (même boîte finale)', () => {
    // Un objet dont le CENTRE est à (cx,cy) a son coin bas-gauche à (cx-16, cy+16) : les deux saisies donnent la même boîte.
    const img = { largeur: 660, hauteur: 790 }, ecr = { largeur: 800, hauteur: 480 };
    const a = ajuster(img, ecr);
    const centre = versPixels(0.4, 0.6, img, a);
    const coinFx = (centre.x - 16 - a.decalageX) / (img.largeur * a.echelle), coinFy = (centre.y + 16 - a.decalageY) / (img.hauteur * a.echelle);
    const viaCentre = positionSurEcran({ x: 0.4, y: 0.6 }, img, ecr, ICONE, 'centre');
    const viaCoin = positionSurEcran({ x: coinFx, y: coinFy }, img, ecr, ICONE, 'bas-gauche');
    expect({ x: viaCoin.x, y: viaCoin.y }).toEqual({ x: viaCentre.x, y: viaCentre.y });
  });
});

describe('objet hors de l\'écran', () => {
  it('signalé pour être ignoré, comme le faisait l\'ancien générateur', () => {
    expect(positionSurEcran({ x: 1.5, y: 0.5 }, IMG, ECR, ICONE).horsEcran).toBe(true);
    expect(positionSurEcran({ x: 0.5, y: 0.5 }, IMG, ECR, ICONE).horsEcran).toBe(false);
  });
});
