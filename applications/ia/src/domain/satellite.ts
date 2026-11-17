/**
 * ⭐ 11/11/2026 (specs ia v1.39 §16.14) — lieu du satellite vocal qui parle.
 *
 * HA ne transmet pas à un agent « Ollama » l'appareil qui a parlé, mais le texte d'instructions de
 * l'intégration Ollama est un modèle rendu à chaque demande avec `llm_context` (device_id). Il y
 * porte une ligne repère, par exemple :
 *   [satellite: hasat-cuisine | pièce: Cuisine]
 * `ia` la lit dans le message système et en déduit le lieu d'origine de la demande : la pièce HA de l'appareil.
 * ⭐ 13/11/2026 (specs ia v1.42) — table `satellites` (nom d'appareil → lieu) SUPPRIMÉE, demande utilisateur :
 * le lieu est celui que HA transmet (pièce de l'appareil), une seule source de vérité.
 */
import type { OllamaMessage } from './types';

export interface SatelliteRepere {
  nom?: string;
  piece?: string;
}

const REPERE = /\[satellite:\s*([^|\]]*?)\s*(?:\|\s*pi[eè]ce:\s*([^\]]*?)\s*)?\]/i;

/** Repère du satellite dans les messages système ; `undefined` sans repère ou sans appareil. */
export function lireSatellite(messages: OllamaMessage[]): SatelliteRepere | undefined {
  for (const m of messages) {
    if (m.role !== 'system' || typeof m.content !== 'string') continue;
    const r = m.content.match(REPERE);
    if (!r) continue;
    const nom = r[1]?.trim();
    const piece = r[2]?.trim();
    const vide = (s?: string): boolean => !s || /^(aucun|none|unknown)$/i.test(s);
    if (vide(nom) && vide(piece)) return undefined;
    return { nom: vide(nom) ? undefined : nom, piece: vide(piece) ? undefined : piece };
  }
  return undefined;
}

/** Lieu d'origine : la pièce HA de l'appareil, en minuscules ; `undefined` sans repère ou sans pièce. */
export function lieuDuSatellite(messages: OllamaMessage[]): string | undefined {
  const piece = lireSatellite(messages)?.piece;
  return piece ? piece.toLowerCase() : undefined;
}
