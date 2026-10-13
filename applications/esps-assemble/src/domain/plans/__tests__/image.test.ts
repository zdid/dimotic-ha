import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { ajusterImage, dimensionsPng, ImageInvalide } from '../image';

function creer(l: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const p = new PNG({ width: l, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < l; x++) { const [r, g, b, a] = pixel(x, y); const i = (y * l + x) * 4; p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = a; }
  return PNG.sync.write(p);
}
const pixel = (png: Buffer, x: number, y: number) => { const d = PNG.sync.read(png); const i = (y * d.width + x) * 4; return [d.data[i], d.data[i + 1], d.data[i + 2]]; };

describe('image de fond (fit and pad)', () => {
  it('dimensions lues dans l\'en-tête', () => {
    expect(dimensionsPng(creer(123, 45, () => [0, 0, 0, 255]))).toEqual({ largeur: 123, hauteur: 45 });
    expect(() => dimensionsPng(Buffer.from('pas un png'))).toThrow(ImageInvalide);
  });
  it('plan portrait sur écran paysage : bandes noires à gauche et à droite, image centrée, couleur conservée', () => {
    const src = creer(100, 200, () => [200, 100, 50, 255]);
    const r = ajusterImage(src, { largeur: 400, hauteur: 240 });
    expect(r.ajustement).toMatchObject({ largeurImage: 120, hauteurImage: 240, decalageX: 140, decalageY: 0 });
    const d = PNG.sync.read(r.png);
    expect([d.width, d.height]).toEqual([400, 240]);
    expect(pixel(r.png, 10, 100)).toEqual([0, 0, 0]);          // bande gauche
    expect(pixel(r.png, 390, 100)).toEqual([0, 0, 0]);         // bande droite
    expect(pixel(r.png, 200, 120)).toEqual([200, 100, 50]);    // centre : couleur d'origine, sans dérive
    expect(pixel(r.png, 140, 5)).toEqual([200, 100, 50]);      // bord de l'image
    expect(pixel(r.png, 139, 5)).toEqual([0, 0, 0]);
  });
  it('transparence composée sur fond noir ; pixel à demi transparent assombri de moitié', () => {
    const src = creer(8, 8, (x) => (x < 4 ? [255, 255, 255, 0] : [255, 255, 255, 255]));
    const r = ajusterImage(src, { largeur: 8, hauteur: 8 });
    expect(pixel(r.png, 1, 4)).toEqual([0, 0, 0]);
    expect(pixel(r.png, 6, 4)).toEqual([255, 255, 255]);
    const demi = ajusterImage(creer(4, 4, () => [200, 200, 200, 128]), { largeur: 4, hauteur: 4 });
    const [v] = pixel(demi.png, 2, 2);
    expect(v).toBeGreaterThan(95); expect(v).toBeLessThan(105);
  });
  it('réduction : un motif en damier fin donne un gris moyen (filtre de Lanczos, pas de crénelage)', () => {
    const src = creer(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const [v] = pixel(ajusterImage(src, { largeur: 16, hauteur: 16 }).png, 8, 8);
    expect(v).toBeGreaterThan(110); expect(v).toBeLessThan(145);
  });
  it('agrandissement vers un écran plus grand : taille exacte, ratio conservé', () => {
    const r = ajusterImage(creer(10, 10, () => [10, 20, 30, 255]), { largeur: 100, hauteur: 60 });
    expect(r.ajustement).toMatchObject({ largeurImage: 60, hauteurImage: 60, decalageX: 20 });
    expect(pixel(r.png, 50, 30)).toEqual([10, 20, 30]);
  });
  it('fichier non PNG : erreur claire', () => {
    expect(() => ajusterImage(Buffer.from('xxxx'), { largeur: 10, hauteur: 10 })).toThrow(/PNG illisible/);
  });
});
