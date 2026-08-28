/**
 * Lit la largeur/hauteur naturelle d'une image de plan (PNG ou JPEG) sans dépendance externe —
 * nécessaire pour la carte Plan Lovelace (voir lovelace-generator.ts) : le ratio largeur/hauteur
 * de l'image doit être injecté tel quel dans la carte HA (CSS `aspect-ratio`) pour que le
 * conteneur qui accueille l'image ait EXACTEMENT le même ratio qu'elle — sinon `object-fit:
 * contain` laisse des bandes vides ("letterboxing") autour de l'image, et les icônes superposées
 * (positionnées en % du conteneur, pas de l'image elle-même — verrouillé par HA, hors de notre
 * contrôle) se retrouvent décalées par rapport au plan, voire visuellement "en dehors" (retour
 * réel de l'utilisateur, 28/08/2026). Même principe que `FloorPlan.ts` (l'éditeur HAPLAN
 * lui-même) : `Math.min(widthRatio, heightRatio)` y est calculé en JS au moment de l'affichage —
 * ici on ne peut pas dépendre de JS côté carte HA (YAML statique), donc le ratio est calculé une
 * fois au dépôt et gravé dans le CSS généré.
 */

import * as fs from 'node:fs';
import { PNG } from 'pngjs';

export interface ImageDimensions {
  width: number;
  height: number;
}

function readPngDimensions(buffer: Buffer): ImageDimensions {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

/** Parcourt les marqueurs JPEG jusqu'au premier marqueur SOF (Start Of Frame, C0-CF sauf
 *  C4/C8/CC — DHT/JPG réservé/DAC, qui ne portent pas de dimensions) — la hauteur/largeur y sont
 *  toujours aux mêmes offsets (5 et 7 octets après le marqueur), quel que soit le variant JPEG. */
function readJpegDimensions(buffer: Buffer): ImageDimensions {
  let offset = 2; // saute le marqueur SOI (0xFFD8)
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  throw new Error('Dimensions JPEG introuvables (aucun marqueur SOF)');
}

/** Dispatch sur l'extension du fichier — voir HaplanService.ts (ACCEPTED_MIME_TYPES) pour la
 *  liste des formats acceptés à l'import (PNG/JPEG uniquement à ce jour). */
export function readImageDimensions(filePath: string): ImageDimensions {
  const buffer = fs.readFileSync(filePath);
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return readPngDimensions(buffer);
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return readJpegDimensions(buffer);
  throw new Error(`Format d'image non supporté pour la lecture de dimensions : ${filePath}`);
}
