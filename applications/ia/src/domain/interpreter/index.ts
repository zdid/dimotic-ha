/**
 * Point d'entrée public du moteur d'interprétation déterministe (voir specs/current/
 * fonctionnelles-ia_specs §16). `interpretDeterministic()` tente de reconnaître une phrase SANS
 * appeler Mistral ; `undefined` = repli intégral sur le chemin Mistral existant (jamais un résultat
 * approximatif), exactement le contrat déjà établi par `resolveAction`/`executeImmediateAction`
 * côté planificateur.
 */

import { splitSentences, tokenize } from './tokenizer';
import { matchGabarit, matchWordSequence, flattenCaptures } from './grammar';
import type { CaptureMap } from './grammar';
import { matchMacro } from './macros';
import type { Candidate, ExecuterActionParams, GabaritDef, MatchContext, Token, Vocabulaire } from './types';

export type { Vocabulaire, GabaritDef, ExecuterActionParams } from './types';
export { loadVocabulaire, loadGabarits } from './loader';

export interface LiveCatalogs {
  /** `HaStructureRegistry.getLieuCatalog()` — valeurs affichage, tous niveaux de taxonomie confondus. */
  lieux: string[];
  /** Paires (lieu_precis, lieu) observées par entité, pour les candidats composés (§16.5). */
  lieuxComposes: Array<{ lieuPrecis: string; lieu: string }>;
  /** Noms de quoi connus (valeurs affichage). */
  quois: string[];
  /** Noms de macros connues (`planificateur:macros:list`, relayé — voir §16.5). */
  macros: string[];
  /** Défaut de lieu si la phrase n'en capture aucun (§16.6) — `undefined` tant que la source réelle
   *  (device_id du satellite déclencheur) n'est pas branchée. */
  lieuOrigine?: string;
}

export type DeterministicOutcome =
  | { kind: 'action'; params: ExecuterActionParams }
  | { kind: 'structured'; data: Record<string, unknown> }
  | {
      kind: 'evenement';
      triggerQuoi?: string;
      triggerLieu?: string;
      triggerEtat: string;
      action: ExecuterActionParams;
    };

const FRAGMENT_GABARITS = ['dans', 'attendre', 'pendant', 'a', 'touslesjours', 'touslesjourssemaine', 'leweekend'];
const TERMINAL_ORDRE = ['ordre_immediat', 'ordre_valeur'];

function normalizeWords(text: string): string[] {
  return tokenize(text).filter((t): t is string => typeof t === 'string');
}

function toCandidates(values: string[]): Candidate[] {
  return values
    .map((display) => ({ display, words: normalizeWords(display) }))
    .filter((c) => c.words.length > 0)
    .sort((a, b) => b.words.join(' ').length - a.words.join(' ').length);
}

function buildContext(vocabulaire: Vocabulaire, gabarits: Record<string, GabaritDef>, live: LiveCatalogs): MatchContext {
  const lieuxComposesCandidats = live.lieuxComposes
    .map(({ lieuPrecis, lieu }) => ({
      lieuPrecis: { display: lieuPrecis, words: normalizeWords(lieuPrecis) },
      lieu: { display: lieu, words: normalizeWords(lieu) }
    }))
    .filter((p) => p.lieuPrecis.words.length > 0 && p.lieu.words.length > 0)
    .sort((a, b) => b.lieuPrecis.words.join(' ').length - a.lieuPrecis.words.join(' ').length);

  return {
    vocabulaire,
    gabarits,
    lieuxCandidats: toCandidates(live.lieux),
    lieuxComposesCandidats,
    quoiCandidats: toCandidates(live.quois),
    macroCandidats: toCandidates(live.macros)
  };
}

function buildActionParams(captures: CaptureMap, def: GabaritDef, lieuOrigine: string | undefined): ExecuterActionParams {
  const flat = flattenCaptures(captures);
  const quoi = (flat.quoi as string | undefined) ?? (def.defaults?.quoi as string | undefined) ?? '';
  let lieux = (flat.lieux as string[] | undefined) ?? [];
  if (lieux.length === 0 && lieuOrigine) lieux = [lieuOrigine];
  return {
    verbe: (flat.verbe as string) ?? '',
    quoi,
    lieux,
    valeur: flat.valeur as string | number | undefined
  };
}

/** Assemble une `PlanificationDefinition`-shaped JSON (miroir de
 *  `fonctionnelles-planificateur_specs`) depuis les captures cumulées des fragments temporels. Le
 *  fragment `pendant` (durée d'exécution avant réaction inverse) est capturé mais PAS ENCORE
 *  assemblé en séquence — limitation connue documentée dans le plan de mise en œuvre, la phrase
 *  entière retombe sur Mistral tant que ce cas n'est pas complété (voir garde plus bas). */
function buildPlanificationJson(planifCaptures: CaptureMap, action: ExecuterActionParams): Record<string, unknown> | undefined {
  const flat = flattenCaptures(planifCaptures);
  const trigger: Record<string, unknown> = {};

  if (typeof flat.duree === 'number') {
    trigger.type = 'delay';
    trigger.seconds = Math.round((flat.duree as number) / 1000);
  } else if (flat.jours || flat.heure) {
    trigger.type = 'recurrence';
    if (flat.heure) trigger.at = flat.heure;
    if (flat.jours) trigger.days = flat.jours;
    if (flat.jourssauf) trigger.except_days = flat.jourssauf;
  } else {
    return undefined; // fragment reconnu mais pas assez d'info pour un trigger exploitable (ex: `pendant` seul)
  }

  return {
    type: 'planification',
    name: `interpreteur_${Date.now()}`,
    active: true,
    phrase_originale: '',
    trigger,
    action: { type: 'action', order: '', verbe: action.verbe, quoi: action.quoi, lieux: action.lieux, valeur: action.valeur }
  };
}

function nextTokenIsKnownVerbOrSi(mots: Token[], pos: number, ctx: MatchContext): boolean {
  if (mots[pos] === 'si') return true;
  for (const groupe of Object.values(ctx.vocabulaire.verbeGroupes)) {
    for (const formes of Object.values(groupe)) {
      for (const forme of formes) {
        if (matchWordSequence(forme.split(/\s+/), mots, pos, ctx, false) > -1) return true;
      }
    }
  }
  return false;
}

interface Utterance {
  outcome: DeterministicOutcome;
  next: number;
}

function matchUtterance(mots: Token[], startPos: number, ctx: MatchContext, lieuOrigine: string | undefined): Utterance | undefined {
  let pos = startPos;
  let planifCaptures: CaptureMap = {};
  let matchedAnyFragment = false;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const name of FRAGMENT_GABARITS) {
      const r = matchGabarit(name, mots, pos, ctx);
      if (r) {
        planifCaptures = { ...planifCaptures };
        for (const [k, v] of Object.entries(r.captures)) planifCaptures[k] = [...(planifCaptures[k] ?? []), ...v];
        pos = r.next;
        matchedAnyFragment = true;
        progressed = true;
        break;
      }
    }
  }

  const evenement = matchGabarit('si_alors', mots, pos, ctx);
  if (evenement) {
    const flat = flattenCaptures(evenement.captures);
    const action: ExecuterActionParams = {
      verbe: (flat.verbe as string) ?? '',
      quoi: (flat.quoi as string | undefined) ?? 'lumiere',
      lieux: (flat.lieux as string[] | undefined) ?? [],
      valeur: flat.valeur as string | number | undefined
    };
    return {
      outcome: {
        kind: 'evenement',
        triggerQuoi: flat.trigger_quoi as string | undefined,
        triggerLieu: (flat.trigger_lieu as string[] | undefined)?.[0],
        triggerEtat: (flat.trigger_etat as string) ?? 'on',
        action
      },
      next: evenement.next
    };
  }

  for (const name of TERMINAL_ORDRE) {
    const r = matchGabarit(name, mots, pos, ctx);
    if (!r) continue;
    const def = ctx.gabarits[name];
    const params = buildActionParams(r.captures, def, lieuOrigine);
    if (matchedAnyFragment) {
      const structured = buildPlanificationJson(planifCaptures, params);
      if (!structured) return undefined;
      return { outcome: { kind: 'structured', data: structured }, next: r.next };
    }
    return { outcome: { kind: 'action', params }, next: r.next };
  }

  return undefined;
}

function interpretPhrase(mots: Token[], ctx: MatchContext, lieuOrigine: string | undefined): DeterministicOutcome[] | undefined {
  if (mots.length === 0) return undefined;

  const macro = matchMacro(mots, 0, ctx);
  if (macro && macro.next === mots.length) {
    return [{ kind: 'structured', data: { type: 'macro_ref', name: macro.name } }];
  }

  const outcomes: DeterministicOutcome[] = [];
  let cursor = 0;
  while (cursor < mots.length) {
    const utterance = matchUtterance(mots, cursor, ctx, lieuOrigine);
    if (!utterance) return undefined;
    outcomes.push(utterance.outcome);
    cursor = utterance.next;
    if (cursor >= mots.length) break;
    if (!nextTokenIsKnownVerbOrSi(mots, cursor, ctx)) return undefined;
  }
  return outcomes;
}

/** Tente de reconnaître `text` sans passer par Mistral. `undefined` si non reconnu avec confiance
 *  (repli intégral sur `runChatRounds`, comportement inchangé). Ne renvoie JAMAIS un résultat
 *  partiel — soit toute la phrase (une fois découpée en énoncés) est reconnue, soit rien. */
export function interpretDeterministic(text: string, vocabulaire: Vocabulaire, gabarits: Record<string, GabaritDef>, live: LiveCatalogs): DeterministicOutcome[] | undefined {
  const phrases = splitSentences(text, vocabulaire.separateurs);
  if (phrases.length === 0) return undefined;

  const ctx = buildContext(vocabulaire, gabarits, live);
  const outcomes: DeterministicOutcome[] = [];
  for (const phrase of phrases) {
    const mots = tokenize(phrase);
    const phraseOutcomes = interpretPhrase(mots, ctx, live.lieuOrigine);
    if (!phraseOutcomes) return undefined;
    outcomes.push(...phraseOutcomes);
  }
  return outcomes.length > 0 ? outcomes : undefined;
}
