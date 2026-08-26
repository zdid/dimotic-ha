/**
 * Types partagés du moteur d'interprétation déterministe (voir plan de mise en œuvre / spec ia
 * §16). Miroir volontaire de quelques types de `ia`/`planificateur` existants — pas d'import croisé
 * entre applications (convention déjà en vigueur dans ce projet).
 */

export type Token = string | number;

/** Miroir de `ia/src/domain/types.ts::ExecuterActionParams`. */
export interface ExecuterActionParams {
  verbe: string;
  quoi: string;
  lieux: string[];
  valeur?: string | number;
  phrase_originale?: string;
}

/** Un lieu candidat pour le matching, avec sa forme normalisée pré-calculée (évite de renormaliser
 *  à chaque tentative de match). */
export interface Candidate {
  /** Forme affichage originale (ex. "Salon"). */
  display: string;
  /** Forme normalisée (minuscules, sans accent) découpée en mots — ce contre quoi on matche. */
  words: string[];
}

/** Table nommée du vocabulaire (`<enum:table>`/`<verbe:table>`) : chaque entrée associe une ou
 *  plusieurs formes de surface à une valeur capturée (scalaire ou liste). */
export type EnumTable = Record<string, { formes: string[]; valeur: unknown }[]>;

export interface Vocabulaire {
  /** groupe (ex. "on_off", "valeur") -> verbe canonique -> formes de surface. `<verbe:on_off>`
   *  matche N'IMPORTE QUEL verbe du groupe et capture son nom canonique — pas un verbe unique. */
  verbeGroupes: Record<string, Record<string, string[]>>;
  /** tables <enum:X> nommées (lever_coucher, tous, jours_ouvres...). */
  enums: EnumTable;
  motsIgnores: string[];
  separateurs: string[];
}

export interface GabaritDef {
  pattern: string;
  /** Mode de comparaison — hors mode strict, les mots de `motsIgnores` sont sautés automatiquement
   *  pendant le matching. Défaut : false (comme la plupart des gabarits legacy `ordre`). */
  strict?: boolean;
  /** Ce que produit ce gabarit une fois matché — détermine comment `interpreter/index.ts` route le
   *  résultat. */
  type_sortie: 'ordre' | 'planif_fragment' | 'planif' | 'request' | 'evenement';
  /** Valeurs par défaut fusionnées AVANT les captures de la phrase (les captures l'emportent
   *  toujours). */
  defaults?: Record<string, unknown>;
}

export interface GabaritsFile {
  gabarits: Record<string, GabaritDef>;
}

/** Résultat brut d'un match réussi : les valeurs capturées, nommées, plus la position atteinte dans
 *  le flux de tokens. */
export interface MatchResult {
  captures: Record<string, unknown>;
  next: number;
}

/** Contexte fourni au matcher : données vivantes (lieux/quois/macros) + vocabulaire + gabarits
 *  nommés (pour `<gabarit:X>`, composition). */
export interface MatchContext {
  vocabulaire: Vocabulaire;
  gabarits: Record<string, GabaritDef>;
  lieuxCandidats: Candidate[];
  lieuxComposesCandidats: Array<{ lieuPrecis: Candidate; lieu: Candidate }>;
  quoiCandidats: Candidate[];
  macroCandidats: Candidate[];
}
