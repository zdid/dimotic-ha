/**
 * ⭐ 11/11/2026 (specs ia v1.37 §16.12) — réponses parlées de l'assistant vocal.
 *
 * Constat réel (hasat3 → ha2) : la réponse d'une action immédiate était le message technique de
 * `planificateur` (« homeassistant.turn_on exécuté sur light.salle_salon. »), lu tel quel par la
 * synthèse vocale ; Mistral, voyant ces réponses dans l'historique de la conversation, les imitait
 * ensuite en texte libre SANS appeler `executer_action` (succès annoncé, rien exécuté).
 */
import type { OllamaMessage } from './types';

/** Participe passé de chaque verbe connu de `planificateur` (resolution.ts), forme normalisée
 *  (minuscules, sans accents, espaces → `_`). */
const PARTICIPES: Record<string, string> = {
  allumer: 'allumé',
  activer: 'activé',
  ouvrir: 'ouvert',
  eteindre: 'éteint',
  desactiver: 'désactivé',
  fermer: 'fermé',
  basculer: 'basculé',
  regler: 'réglé',
  baisser: 'baissé',
  augmenter: 'augmenté',
  mettre: 'mis'
};

/** Début fixe de toute confirmation d'action — sert aussi de repère au garde-fou
 *  `annonceActionSansExecution` (Mistral qui imiterait cette phrase sans agir). */
export const DEBUT_CONFIRMATION = "C'est fait";

export const REPONSE_ACTION_NON_EXECUTEE = "Je n'ai pas exécuté la commande. Répète-la, s'il te plaît.";

/** ⭐ 12/11/2026 (specs v1.41 §16.16) — texte reçu suspect (autre langue, vide) : rien n'est envoyé à Mistral.
 *  Finit par « ? » : HA garde le micro ouvert pour la répétition. */
export const REPONSE_TEXTE_NON_COMPRIS = "Je n'ai pas compris. Peux-tu répéter ?";

/** ⭐ 13/11/2026 (specs v1.42 §16.17) — transcriptions connues fausses, phrase ENTIÈRE (casse, accents et ponctuation
 *  ignorés) → phrase voulue. « éteins » est rendu « Et tant » par Voxtral comme par Whisper (constaté 13/11 10 h 49 :
 *  Mistral avait RALLUMÉ la chambre du bas). Dans une phrase plus longue, le vocabulaire de l'interpréteur s'en charge. */
const TRANSCRIPTIONS_CORRIGEES: Record<string, string> = {
  'et tant': 'Éteins.'
};

export function corrigerTranscription(texte: string): string | undefined {
  const cle = texte.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return TRANSCRIPTIONS_CORRIGEES[cle];
}

function normaliser(verbe: string): string {
  return verbe.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, '_');
}

/** Phrase parlée d'une action immédiate réussie : « C'est fait, j'ai allumé : lumière, salon. » */
export function phraseConfirmationAction(params: { verbe: string; quoi: string; lieux?: string[]; valeur?: string | number }): string {
  const participe = PARTICIPES[normaliser(params.verbe)] ?? params.verbe;
  const cibles = [params.quoi, ...(params.lieux ?? [])].filter((s) => s && s.trim()).join(', ');
  const valeur = params.valeur !== undefined && params.valeur !== '' ? ` à ${params.valeur}` : '';
  return `${DEBUT_CONFIRMATION}, j'ai ${participe} : ${cibles}${valeur}.`;
}

/**
 * Échange « libre » pour le cache et l'interpréteur déterministe : aucune réponse de l'assistant
 * dans l'historique, OU la dernière réponse de l'assistant ne se termine pas par un point
 * d'interrogation (même règle que HA pour rouvrir le micro, `ChatLog.continue_conversation`) — elle
 * ne demandait donc aucune précision, la nouvelle phrase est une nouvelle commande. Une réponse qui
 * finit par « ? » (Mistral attend une précision, ex. formulation assistée d'une planification) laisse
 * la main à Mistral, seul à avoir le contexte.
 */
export function echangeLibre(messages: OllamaMessage[]): boolean {
  const reponses = messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() !== '');
  if (reponses.length === 0) return !messages.some((m) => m.role === 'assistant');
  const derniere = (reponses[reponses.length - 1].content as string).trim();
  return !/[?;？]$/.test(derniere);
}

/** Texte final de Mistral qui annonce une action (phrase de confirmation, ou ancien message
 *  technique « domaine.service exécuté sur … ») alors qu'aucun `executer_action` n'a réussi dans
 *  cet échange. */
export function annonceActionSansExecution(texte: string, executerActionOk: boolean | undefined): boolean {
  if (executerActionOk === true) return false;
  const t = texte.trim();
  return t.startsWith(DEBUT_CONFIRMATION) || /\b[a-z_]+\.[a-z_]+ exécuté sur\b/i.test(t);
}

/**
 * ⭐ 19/11/2026 (specs v1.45 §16.18) — texte rendu à HA, lu tel quel par la synthèse vocale.
 * Constat réel (11/11, hasat3) : « "quoi_introuvable" : aucun "salons" trouvé dans les lieux connus.
 * Vérifie avec **salon** ? » — code interne et gras Markdown lus à voix haute.
 * - erreur §0.4 (`{"error":"quoi_introuvable",…}`, éventuellement dans un bloc ```json) → phrase française ;
 * - code `quoi_introuvable` cité dans une phrase → retiré ;
 * - Markdown (gras, italique, code, titres, puces, liens) → texte simple.
 * Un texte déjà propre est rendu à l'identique (l'appelant compare pour savoir s'il doit réécrire).
 */
export function texteParle(texte: string): string {
  let t = texte;

  // Erreur §0.4 au format JSON (avec ou sans bloc de code autour).
  const json = t.match(/(?:```(?:json)?\s*)?(\{[^{}]*"error"\s*:\s*"quoi_introuvable"[^{}]*\})(?:\s*```)?/);
  if (json) {
    let phrase = "Je n'ai rien trouvé qui corresponde.";
    try {
      const e = JSON.parse(json[1]) as { quoi?: string; area?: string };
      const quoi = e.quoi?.trim();
      const lieu = e.area?.trim();
      if (quoi) phrase = `Je n'ai pas trouvé de ${quoi}${lieu ? ` dans ${lieu}` : ''}.`;
    } catch { /* JSON abîmé : phrase générique */ }
    t = t.replace(json[0], phrase);
  }

  // Code interne cité en texte libre : « "quoi_introuvable" : aucun … » → « aucun … ».
  t = t.replace(/["«]?\s*quoi_introuvable\s*["»]?\s*[:\-–—]?\s*/gi, '');

  // Markdown → texte simple.
  t = t
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '');

  // Première lettre en majuscule si on a coupé le début.
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  if (t !== texte.trim()) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t === texte.trim() ? texte : t;
}
