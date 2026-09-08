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

/** ⭐ 28/08/2026 : quasi noir pur, demande explicite (le fond HAPLAN natif #1a1a2e jugé pas assez
 *  sombre une fois vu déployé sur HA). Exportée (⭐ 08/09/2026) : réutilisée telle quelle par
 *  `createBlankBackgroundPng` ci-dessous pour qu'une "page libre" ait exactement le même fond que
 *  les plans avec image une fois aplatis — source unique, pas de couleur dupliquée en dur. */
export const BACKGROUND_COLOR: [number, number, number] = [0x0d, 0x0d, 0x0d];

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

/**
 * ⭐ 08/09/2026 : fond généré pour une "page libre" HAPLAN — un plan créé sans image fournie (voir
 * HaplanService.handleFloorplanCreate) reçoit un vrai fichier PNG dès sa création, ensuite traité
 * exactement comme n'importe quelle image uploadée partout ailleurs dans le code (aucun cas
 * spécial "pas de filename").
 *
 * TRANSPARENT (alpha=0), pas opaque en BACKGROUND_COLOR — même convention que les vraies images de
 * plan HAPLAN (voir docstring en tête de fichier : fond transparent, pensé pour le fond natif de
 * HAPLAN, `--color-bg` = #1a1a2e, PAS le #0d0d0d de BACKGROUND_COLOR qui n'a de sens que pour le
 * dépôt Lovelace). Une version opaque en #0d0d0d ici aurait produit un rectangle visiblement plus
 * sombre que le reste de la page dans l'éditeur web (letterboxing sur un écran large, retour
 * utilisateur direct). `flattenPngOntoDarkBackground` (déjà appliqué sans distinction à TOUT PNG
 * lors du dépôt Lovelace, voir HaplanService.handleLovelaceDeploy) compose cette transparence sur
 * BACKGROUND_COLOR à ce moment-là — aucun traitement spécial nécessaire ici pour ce cas.
 */
export function createBlankBackgroundPng(width: number, height: number, destPath: string): void {
  const png = new PNG({ width, height });
  png.data.fill(0);

  fs.writeFileSync(destPath, PNG.sync.write(png));
}
