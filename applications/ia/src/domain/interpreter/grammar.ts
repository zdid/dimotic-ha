/**
 * Moteur générique de matching de gabarits (voir plan de mise en œuvre — "Notation des gabarits").
 * Port du principe de `traitModel()`/`_interpreteUnePhrase()` legacy (mécanique
 * mots/type/facultatif/resultname/and/or/liste), piloté par des `PatternNode` compilés depuis le
 * DSL (`dsl.ts`) plutôt que par du code TS par gabarit.
 */

import type { PatternNode } from './dsl';
import { compilePattern } from './dsl';
import type { Candidate, GabaritDef, MatchContext, Token } from './types';
import { parseSpokenDuration, parseDateTimeAt, parseFrenchDate, parseTimeOfDay, isNumeric } from './datetime';

const CONNECTEURS_LIEU_COMPOSE = ['de la', 'de l', 'du', 'des', 'de'];
const MAX_REPEAT = 20;

export interface CaptureMap {
  [key: string]: unknown[];
}

export interface MatchOutcome {
  matched: boolean;
  next: number;
  captures: CaptureMap;
}

const FAIL: MatchOutcome = { matched: false, next: -1, captures: {} };

function ok(next: number, captures: CaptureMap = {}): MatchOutcome {
  return { matched: true, next, captures };
}

function mergeCaptures(a: CaptureMap, b: CaptureMap): CaptureMap {
  const out: CaptureMap = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = [...(out[k] ?? []), ...v];
  return out;
}

function skipIgnorable(mots: Token[], pos: number, ctx: MatchContext, strict: boolean): number {
  if (strict) return pos;
  let p = pos;
  while (typeof mots[p] === 'string' && ctx.vocabulaire.motsIgnores.includes(mots[p] as string)) p++;
  return p;
}

/** Compare une séquence de mots candidats (déjà normalisée) aux tokens à partir de `pos`, mots
 *  ignorables sautés entre chaque mot du candidat si non strict. Renvoie la position après le
 *  candidat si tout matche, sinon -1. */
export function matchWordSequence(words: string[], mots: Token[], pos: number, ctx: MatchContext, strict: boolean): number {
  let p = pos;
  for (const w of words) {
    // ⭐ Ne saute un mot ignorable QUE s'il ne correspond pas déjà au mot attendu — sinon un
    // candidat multi-mots contenant lui-même un mot ignorable (ex. "plan de travail", "de" étant
    // dans motsIgnores) le sauterait à tort en cherchant autre chose derrière.
    while (mots[p] !== w && !strict && typeof mots[p] === 'string' && ctx.vocabulaire.motsIgnores.includes(mots[p] as string)) p++;
    if (mots[p] !== w) return -1;
    p++;
  }
  return p;
}

/** Essaie les candidats les plus longs (mots) en premier — déjà trié à la construction du contexte,
 *  voir index.ts. */
function matchCandidateList(candidates: Candidate[], mots: Token[], pos: number, ctx: MatchContext, strict: boolean): { display: string; next: number } | undefined {
  for (const c of candidates) {
    const next = matchWordSequence(c.words, mots, pos, ctx, strict);
    if (next > -1) return { display: c.display, next };
  }
  return undefined;
}

function matchComposedLieu(ctx: MatchContext, mots: Token[], pos: number, strict: boolean): { display: string; next: number } | undefined {
  for (const { lieuPrecis, lieu } of ctx.lieuxComposesCandidats) {
    const afterPrecis = matchWordSequence(lieuPrecis.words, mots, pos, ctx, strict);
    if (afterPrecis === -1) continue;
    let afterConnecteur = afterPrecis;
    for (const connecteur of CONNECTEURS_LIEU_COMPOSE) {
      const p = matchWordSequence(connecteur.split(/\s+/), mots, afterPrecis, ctx, strict);
      if (p > -1) { afterConnecteur = p; break; }
    }
    const afterLieu = matchWordSequence(lieu.words, mots, afterConnecteur, ctx, strict);
    if (afterLieu > -1) return { display: lieuPrecis.display, next: afterLieu };
  }
  return undefined;
}

function matchTerminalCategory(category: string, captureName: string, mots: Token[], pos: number, ctx: MatchContext, strict: boolean): MatchOutcome {
  const p = skipIgnorable(mots, pos, ctx, strict);
  switch (category) {
    case 'lieu': {
      const composed = matchComposedLieu(ctx, mots, p, strict);
      if (composed) return ok(composed.next, { [captureName]: [composed.display] });
      const simple = matchCandidateList(ctx.lieuxCandidats, mots, p, ctx, strict);
      if (simple) return ok(simple.next, { [captureName]: [simple.display] });
      return FAIL;
    }
    case 'quoi': {
      const simple = matchCandidateList(ctx.quoiCandidats, mots, p, ctx, strict);
      return simple ? ok(simple.next, { [captureName]: [simple.display] }) : FAIL;
    }
    case 'valeur': {
      // isNumeric (pas isInteger) : une consigne de température ("20.5") est un cas réaliste, pas
      // seulement des entiers — trouvé en confrontant le moteur au jeu d'essai (tester.mjs).
      const val = isNumeric(mots[p] ?? '');
      return val !== false ? ok(p + 1, { [captureName]: [val] }) : FAIL;
    }
    case 'duree': {
      const r = parseSpokenDuration(mots, p);
      return r.found ? ok(r.next, { [captureName]: [r.durationMs] }) : FAIL;
    }
    case 'heure': {
      const r = parseTimeOfDay(mots, p);
      if (!r.found) return FAIL;
      const hh = `${r.hours}`.padStart(2, '0');
      const mm = `${r.minutes}`.padStart(2, '0');
      return ok(r.next, { [captureName]: [`${hh}:${mm}`] });
    }
    case 'datetime': {
      const r = parseDateTimeAt(mots, p);
      return r.found ? ok(r.next, { [captureName]: [r.timestampMs ?? r.durationMs] }) : FAIL;
    }
    case 'date': {
      const r = parseFrenchDate(mots, p);
      return r.found && r.date ? ok(r.next, { [captureName]: [r.date.getTime()] }) : FAIL;
    }
    default:
      return FAIL;
  }
}

function matchEnum(source: 'verbe' | 'enum', table: string, captureName: string, mots: Token[], pos: number, ctx: MatchContext, strict: boolean): MatchOutcome {
  const p = skipIgnorable(mots, pos, ctx, strict);
  if (source === 'verbe') {
    // `table` est un GROUPE (ex. "on_off"/"valeur") — matche n'importe quel verbe du groupe,
    // capture son nom canonique (pas le nom du groupe).
    const groupe = ctx.vocabulaire.verbeGroupes[table] ?? {};
    const flat = Object.entries(groupe).flatMap(([verbe, formes]) => formes.map((forme) => ({ forme, verbe })));
    flat.sort((a, b) => b.forme.split(/\s+/).length - a.forme.split(/\s+/).length);
    for (const { forme, verbe } of flat) {
      const next = matchWordSequence(forme.split(/\s+/), mots, p, ctx, strict);
      if (next > -1) return ok(next, { [captureName]: [verbe] });
    }
    return FAIL;
  }
  const entries = ctx.vocabulaire.enums[table] ?? [];
  const flat = entries.flatMap((entry) => entry.formes.map((forme) => ({ forme, valeur: entry.valeur })));
  flat.sort((a, b) => b.forme.split(/\s+/).length - a.forme.split(/\s+/).length);
  for (const { forme, valeur } of flat) {
    const next = matchWordSequence(forme.split(/\s+/), mots, p, ctx, strict);
    if (next > -1) return ok(next, { [captureName]: [valeur] });
  }
  return FAIL;
}

export function matchNode(node: PatternNode, mots: Token[], pos: number, ctx: MatchContext, strict: boolean): MatchOutcome {
  switch (node.kind) {
    case 'literal': {
      // ⭐ Même correctif que matchWordSequence : ne saute un mot ignorable QUE s'il ne
      // correspond pas déjà au littéral attendu — sinon un gabarit dont le littéral EST lui-même
      // un mot ignorable (ex. "les" dans "tous les <jour>*") le sauterait à tort en le cherchant
      // plus loin. Trouvé en testant "tous les lundi et mardi..." (touslesjourssemaine).
      let p = pos;
      while (mots[p] !== node.word && !strict && typeof mots[p] === 'string' && ctx.vocabulaire.motsIgnores.includes(mots[p] as string)) p++;
      return mots[p] === node.word ? ok(p + 1) : FAIL;
    }
    case 'category':
      return matchTerminalCategory(node.category, node.captureName, mots, pos, ctx, strict);
    case 'enum':
      return matchEnum(node.source, node.table, node.captureName, mots, pos, ctx, strict);
    case 'gabaritRef': {
      const def = ctx.gabarits[node.name];
      if (!def) return FAIL;
      const compiled = compilePattern(def.pattern);
      return matchNode(compiled, mots, pos, ctx, def.strict ?? false);
    }
    case 'sequence': {
      let cursor = pos;
      let captures: CaptureMap = {};
      for (const item of node.items) {
        const r = matchNode(item, mots, cursor, ctx, strict);
        if (!r.matched) return FAIL;
        cursor = r.next;
        captures = mergeCaptures(captures, r.captures);
      }
      return ok(cursor, captures);
    }
    case 'alternation': {
      for (const option of node.options) {
        const r = matchNode(option, mots, pos, ctx, strict);
        if (r.matched) return r;
      }
      return FAIL;
    }
    case 'optional': {
      const r = matchNode(node.inner, mots, pos, ctx, strict);
      return r.matched ? r : ok(pos);
    }
    case 'repeat': {
      let cursor = pos;
      let captures: CaptureMap = {};
      for (let i = 0; i < MAX_REPEAT; i++) {
        const r = matchNode(node.inner, mots, cursor, ctx, strict);
        if (!r.matched || r.next === cursor) break;
        cursor = r.next;
        captures = mergeCaptures(captures, r.captures);
      }
      return ok(cursor, captures);
    }
    default:
      return FAIL;
  }
}

/** Tente un gabarit nommé à `pos`. Renvoie `undefined` si non reconnu (jamais un résultat
 *  approximatif — même contrat que `resolveAction`/`executeImmediateAction` côté planificateur). */
export function matchGabarit(name: string, mots: Token[], pos: number, ctx: MatchContext): MatchOutcome | undefined {
  const def = ctx.gabarits[name];
  if (!def) return undefined;
  const compiled = compilePattern(def.pattern);
  const r = matchNode(compiled, mots, pos, ctx, def.strict ?? false);
  return r.matched ? r : undefined;
}

/** Aplati une `CaptureMap` en valeurs scalaires (dernier élément gagne) sauf pour les clés
 *  "cumulatives" (tout nom de capture contenant "lieu" ou "jour" — couvre `lieux`/`trigger_lieu`/
 *  toute autre capture renommée via `#`, sans avoir à maintenir une liste blanche à part) qui
 *  restent des tableaux. */
export function flattenCaptures(captures: CaptureMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(captures)) {
    if (/lieu|jour/i.test(k)) {
      out[k] = v.flatMap((x) => (Array.isArray(x) ? x : [x]));
    } else {
      out[k] = v[v.length - 1];
    }
  }
  return out;
}

export function getGabaritOutputType(ctx: MatchContext, name: string): GabaritDef['type_sortie'] | undefined {
  return ctx.gabarits[name]?.type_sortie;
}
