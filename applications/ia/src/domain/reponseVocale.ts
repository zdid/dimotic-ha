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
