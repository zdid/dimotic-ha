/**
 * Aplatit un PNG transparent (fond alpha=0) sur un fond opaque uni — nécessaire pour le dépôt de
 * la carte Plan Lovelace (voir lovelace-generator.ts) : les images de plan HAPLAN ont un fond
 * transparent (RVB blanc, alpha=0) et des traits blancs opaques, pensé pour être affiché sur le
 * fond sombre de HAPLAN lui-même (dashboard.html, --color-bg). La carte `picture-elements` de HA
 * s'affiche elle sur le fond opaque de sa propre `ha-card` — blanc en thème clair par défaut —
 * ce qui rend les traits blancs invisibles ("blanc sur blanc", constaté en réel le 28/08/2026).
 * Ni la vue ni la carte HA n'exposent de couleur de fond personnalisable sans dépendre d'une
 * carte tierce (card_mod, non garanti installé) : aplatir l'image nous-mêmes, une fois au dépôt,
 * la rend correcte indépendamment du thème HA de l'utilisateur.
 *
 * `pngjs` (pur JS, pas de binding natif contrairement à `sharp`) — portable tel quel sur tous les
 * runtimes/architectures du build Docker multi-arch (amd64/arm64/arm-v7) sans binaire précompilé
 * à gérer par plateforme.
 */

import * as fs from 'node:fs';
import { PNG } from 'pngjs';

/** Même couleur que --color-bg (core/src/presentation/ui/styles/main.css) — cohérence visuelle
 *  avec le rendu HAPLAN natif. */
const BACKGROUND_COLOR: [number, number, number] = [0x1a, 0x1a, 0x2e];

/**
 * Lit `sourcePath`, compose alpha-over sur BACKGROUND_COLOR, écrit le résultat (toujours opaque)
 * dans `destPath`.
 */
export function flattenPngOntoDarkBackground(sourcePath: string, destPath: string): void {
  const png = PNG.sync.read(fs.readFileSync(sourcePath));
  const [bgR, bgG, bgB] = BACKGROUND_COLOR;

  for (let i = 0; i < png.data.length; i += 4) {
    const alpha = png.data[i + 3]! / 255;
    png.data[i] = Math.round(png.data[i]! * alpha + bgR * (1 - alpha));
    png.data[i + 1] = Math.round(png.data[i + 1]! * alpha + bgG * (1 - alpha));
    png.data[i + 2] = Math.round(png.data[i + 2]! * alpha + bgB * (1 - alpha));
    png.data[i + 3] = 255;
  }

  fs.writeFileSync(destPath, PNG.sync.write(png));
}
