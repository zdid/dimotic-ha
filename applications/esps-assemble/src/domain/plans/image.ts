/**
 * Image de fond d'un plan : ramenée à la taille de l'écran en conservant le ratio (« contain »), centrée sur fond noir — équivalent de
 * `fit_and_pad` de l'ancien script (Pillow, filtre LANCZOS). Sans bibliothèque native : décodage et encodage PNG par `pngjs` (JavaScript pur),
 * redimensionnement de Lanczos (a = 3) séparable, calculé sur des canaux pré-multipliés par l'alpha (comme Pillow pour un PNG avec
 * transparence), puis composition sur fond noir. L'image obtenue est un PNG RGB de la taille exacte de l'écran.
 */

import { PNG } from 'pngjs';
import { ajuster, type Ajustement, type Dimensions } from './coordonnees';

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Poids de rééchantillonnage d'un axe (même découpage que Pillow : fenêtre de 3 × max(1, échelle) autour du centre). */
function poids(tailleSource: number, tailleCible: number): { debut: number[]; poids: Float64Array[] } {
  const echelle = tailleSource / tailleCible;
  const filtre = Math.max(1, echelle);
  const support = 3 * filtre;
  const debut: number[] = [];
  const tous: Float64Array[] = [];
  for (let i = 0; i < tailleCible; i++) {
    const centre = (i + 0.5) * echelle;
    const min = Math.max(0, Math.floor(centre - support + 0.5));
    const max = Math.min(tailleSource, Math.floor(centre + support + 0.5));
    const w = new Float64Array(Math.max(0, max - min));
    let somme = 0;
    for (let k = 0; k < w.length; k++) { w[k] = lanczos((min + k + 0.5 - centre) / filtre); somme += w[k]; }
    if (somme !== 0) for (let k = 0; k < w.length; k++) w[k] /= somme;
    debut.push(min);
    tous.push(w);
  }
  return { debut, poids: tous };
}

/** Redimensionne 4 canaux flottants (RGBA pré-multipliés) : d'abord l'horizontale, puis la verticale. */
function redimensionner(src: Float64Array, lS: number, hS: number, lC: number, hC: number): Float64Array {
  const ph = poids(lS, lC), pv = poids(hS, hC);
  const milieu = new Float64Array(lC * hS * 4);
  for (let y = 0; y < hS; y++) {
    for (let x = 0; x < lC; x++) {
      const w = ph.poids[x], d = ph.debut[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) { const i = (y * lS + d + k) * 4; r += src[i] * w[k]; g += src[i + 1] * w[k]; b += src[i + 2] * w[k]; a += src[i + 3] * w[k]; }
      const o = (y * lC + x) * 4; milieu[o] = r; milieu[o + 1] = g; milieu[o + 2] = b; milieu[o + 3] = a;
    }
  }
  const sortie = new Float64Array(lC * hC * 4);
  for (let y = 0; y < hC; y++) {
    const w = pv.poids[y], d = pv.debut[y];
    for (let x = 0; x < lC; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) { const i = ((d + k) * lC + x) * 4; r += milieu[i] * w[k]; g += milieu[i + 1] * w[k]; b += milieu[i + 2] * w[k]; a += milieu[i + 3] * w[k]; }
      const o = (y * lC + x) * 4; sortie[o] = r; sortie[o + 1] = g; sortie[o + 2] = b; sortie[o + 3] = a;
    }
  }
  return sortie;
}

export class ImageInvalide extends Error {}

/** Dimensions d'un PNG sans le décoder (en-tête IHDR). */
export function dimensionsPng(png: Buffer): Dimensions {
  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG') throw new ImageInvalide('ce n\'est pas un fichier PNG');
  return { largeur: png.readUInt32BE(16), hauteur: png.readUInt32BE(20) };
}

export interface OptionsImage {
  /** `auto` (défaut) : un plan à fond transparent (dessin au trait sombre) est inversé pour se lire sur le fond noir de l'écran ; `true` / `false` : forcé. */
  inverser?: 'auto' | boolean;
}

/** Vrai si au moins un cinquième des pixels est (même en partie) transparent : dessin au trait fait pour un fond clair. */
function aFondTransparent(d: PNG): boolean {
  let n = 0;
  const total = d.width * d.height;
  for (let i = 0; i < total; i++) if (d.data[i * 4 + 3] < 250) n++;
  return n >= total / 5;
}

/** Équivalent du filtre CSS `invert(1) hue-rotate(180deg)` (celui du mode sombre du panneau Plans) : le noir devient blanc, les teintes sont conservées. */
function inverserCouleur(r: number, g: number, b: number): [number, number, number] {
  const R = 255 - r, G = 255 - g, B = 255 - b;
  const lim = (v: number): number => Math.max(0, Math.min(255, v));
  return [lim(-0.574 * R + 1.430 * G + 0.144 * B), lim(0.426 * R + 0.430 * G + 0.144 * B), lim(0.426 * R + 1.430 * G - 0.856 * B)];
}

export interface ImageAjustee { png: Buffer; ajustement: Ajustement; source: Dimensions }

export function ajusterImage(png: Buffer, ecran: Dimensions, options: OptionsImage = {}): ImageAjustee {
  let decode: PNG;
  try { decode = PNG.sync.read(png); } catch (e) { throw new ImageInvalide(`PNG illisible : ${(e as Error).message}`); }
  const source = { largeur: decode.width, hauteur: decode.height };
  const a = ajuster(source, ecran);
  const inverser = options.inverser === undefined || options.inverser === 'auto' ? aFondTransparent(decode) : options.inverser;
  // Pré-multiplication par l'alpha (comme Pillow pour RGBA), en flottants.
  const pre = new Float64Array(source.largeur * source.hauteur * 4);
  for (let i = 0; i < source.largeur * source.hauteur; i++) {
    const al = decode.data[i * 4 + 3] / 255;
    const [r, g, b] = inverser ? inverserCouleur(decode.data[i * 4], decode.data[i * 4 + 1], decode.data[i * 4 + 2]) : [decode.data[i * 4], decode.data[i * 4 + 1], decode.data[i * 4 + 2]];
    pre[i * 4] = r * al; pre[i * 4 + 1] = g * al; pre[i * 4 + 2] = b * al; pre[i * 4 + 3] = decode.data[i * 4 + 3];
  }
  const redim = redimensionner(pre, source.largeur, source.hauteur, a.largeurImage, a.hauteurImage);
  const sortie = new PNG({ width: ecran.largeur, height: ecran.hauteur });
  sortie.data.fill(0);
  for (let i = 0; i < ecran.largeur * ecran.hauteur; i++) sortie.data[i * 4 + 3] = 255; // fond noir opaque
  const borne = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < a.hauteurImage; y++) {
    for (let x = 0; x < a.largeurImage; x++) {
      const i = (y * a.largeurImage + x) * 4;
      const o = ((y + a.decalageY) * ecran.largeur + (x + a.decalageX)) * 4;
      // Composition sur NOIR : le canal pré-multiplié EST la couleur composée.
      sortie.data[o] = borne(redim[i]); sortie.data[o + 1] = borne(redim[i + 1]); sortie.data[o + 2] = borne(redim[i + 2]);
    }
  }
  return { png: PNG.sync.write(sortie, { colorType: 2, inputColorType: 6, inputHasAlpha: true }), ajustement: a, source };
}
