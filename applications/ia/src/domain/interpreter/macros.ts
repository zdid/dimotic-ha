/**
 * Reconnaissance d'un nom de macro en tête de phrase — mirror du rôle de
 * `verifMacros()`/`createModelForMacro()` legacy (workspace6/zdidnodedomotext/interpretetext.js),
 * mais contre les vraies données `planificateur` (`MacroDefinition[]`, voir
 * `fonctionnelles-planificateur_specs`) plutôt qu'un stockage fichier propre à l'ancien système.
 */

import type { Candidate, MatchContext, Token } from './types';

export interface MacroMatch {
  name: string;
  next: number;
}

/** Tente de reconnaître un nom de macro connu à partir de `pos` — candidats déjà triés par
 *  longueur décroissante (voir index.ts), pour que "chevet gauche de la chambre" (si c'est aussi le
 *  nom d'une macro) soit essayé avant un nom de macro plus court qui le préfixerait. */
export function matchMacro(mots: Token[], pos: number, ctx: MatchContext): MacroMatch | undefined {
  for (const candidate of ctx.macroCandidats) {
    const next = matchWords(candidate, mots, pos, ctx);
    if (next > -1) return { name: candidate.display, next };
  }
  return undefined;
}

function matchWords(candidate: Candidate, mots: Token[], pos: number, ctx: MatchContext): number {
  let p = pos;
  for (const w of candidate.words) {
    while (mots[p] !== w && typeof mots[p] === 'string' && ctx.vocabulaire.motsIgnores.includes(mots[p] as string)) p++;
    if (mots[p] !== w) return -1;
    p++;
  }
  return p;
}
