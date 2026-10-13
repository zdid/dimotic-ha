/**
 * Relevé des occupations RAM / flash dans la sortie de `esphome compile` (PlatformIO), fonctionnelles-esphome_specs §5.5 :
 *   RAM:   [=         ]   9.9% (used 32388 bytes from 327680 bytes)
 *   Flash: [====      ]  41.4% (used 760037 bytes from 1835008 bytes)
 */

import type { Mesures } from '../messages';

const RAM = /RAM:\s*\[[^\]]*\]\s*[\d.]+%\s*\(used\s+(\d+)\s+bytes\s+from\s+(\d+)\s+bytes\)/g;
const FLASH = /Flash:\s*\[[^\]]*\]\s*[\d.]+%\s*\(used\s+(\d+)\s+bytes\s+from\s+(\d+)\s+bytes\)/g;

function derniere(re: RegExp, texte: string): [number, number] | null {
  let m: RegExpExecArray | null;
  let dernier: [number, number] | null = null;
  re.lastIndex = 0;
  while ((m = re.exec(texte)) !== null) dernier = [Number(m[1]), Number(m[2])];
  return dernier;
}

/** `tailleOctets` : taille de firmware.bin, fournie par l'appelant (lue sur disque). null si les lignes manquent. */
export function releverMesures(sortie: string, tailleOctets: number): Mesures | null {
  const ram = derniere(RAM, sortie);
  const flash = derniere(FLASH, sortie);
  if (!ram || !flash) return null;
  return { ramUtilisee: ram[0], ramDisponible: ram[1], flashUtilisee: flash[0], flashDisponible: flash[1], tailleOctets };
}

export type VerdictTailles = { ok: true; avertissements: string[] } | { ok: false; raison: string };

/** Contrôle des tailles (§5.5) : refus si le firmware ne tient pas dans l'emplacement de mise à jour du modèle. */
export function controlerTailles(m: Mesures, memoire?: { emplacementOtaOctets: number; ramInterneOctets: number }): VerdictTailles {
  const avertissements: string[] = [];
  if (memoire && m.tailleOctets > memoire.emplacementOtaOctets) {
    return { ok: false, raison: `le firmware (${m.tailleOctets} octets) ne tient pas dans l'emplacement (${memoire.emplacementOtaOctets} octets) du modèle` };
  }
  const flashPct = (m.flashUtilisee / m.flashDisponible) * 100;
  const ramPct = (m.ramUtilisee / m.ramDisponible) * 100;
  if (flashPct > 100) return { ok: false, raison: `flash dépassée (${flashPct.toFixed(1)} %)` };
  if (ramPct > 100) return { ok: false, raison: `RAM statique dépassée (${ramPct.toFixed(1)} %)` };
  if (memoire) {
    const pctSlot = (m.tailleOctets / memoire.emplacementOtaOctets) * 100;
    if (pctSlot > 90) avertissements.push(`firmware à ${pctSlot.toFixed(1)} % de l'emplacement de mise à jour`);
  }
  if (flashPct > 90) avertissements.push(`flash utilisée à ${flashPct.toFixed(1)} %`);
  if (ramPct > 80) avertissements.push(`RAM statique utilisée à ${ramPct.toFixed(1)} %`);
  return { ok: true, avertissements };
}
