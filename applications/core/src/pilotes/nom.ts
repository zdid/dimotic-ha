/**
 * Nommage QUOI---OÙ commun aux pilotes (nommage_specs_v1.0 §3.3, fonctionnelles-nommage §3.2) :
 *
 *   quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
 *
 * `lieu_precis` absent = égal au `lieu` (donc `quoi---lieu` suffit quand seul le lieu est donné). `lieu_pere` et `lieu_grand_pere` sont
 * FACULTATIFS : souvent l'étage et le bâtiment, mais ce n'est PAS une règle (aucun sens imposé).
 * La distribution est POSITIONNELLE (N = nombre de segments après `---`) :
 *   N=1 lieu | N=2 précis, lieu | N=3 précis, lieu, père (étage) | N≥4 précis, lieu, père, grand-père (bâtiment).
 * Conséquences pour la composition :
 *   - sans lieu précis ni père : `quoi---lieu` ;
 *   - un père (ou un grand-père) SANS lieu précis : le lieu est répété en tête (`quoi---lieu--lieu--père`), forme déjà utilisée
 *     (`frigo---cuisine--cuisine`) et traitée par le nommage comme « pas de précision distincte » ;
 *   - un grand-père exige un père (sinon sa position serait fausse).
 */

export interface QualificationNom {
  quoi: string;
  lieu: string;
  lieuPrecis?: string;
  /** Niveau au-dessus du lieu (souvent l'étage, ex. « Rez-de-Chaussée » — pas une règle). Facultatif. */
  lieuPere?: string;
  /** Niveau au-dessus du père (souvent le bâtiment, ex. « Maison » — pas une règle). Facultatif ; exige `lieuPere`. */
  lieuGrandPere?: string;
}

const CHAMPS_TEXTE = ['quoi', 'lieu', 'lieuPrecis', 'lieuPere', 'lieuGrandPere'] as const;

function nettoyer(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Décompose un nom complet selon la matrice positionnelle (l'inverse de `composerNom`). */
export function decomposerNom(nom: string): QualificationNom {
  const [quoi = '', reste = ''] = nom.split('---');
  const segments = reste.split('--').map((s) => s.trim()).filter((s, i, t) => s !== '' || i < t.length);
  const q: QualificationNom = { quoi: quoi.trim(), lieu: '' };
  if (segments.length <= 1) {
    q.lieu = segments[0] ?? '';
    return q;
  }
  const [precis = '', lieu = '', pere, grandPere] = segments;
  q.lieu = lieu;
  if (precis && precis !== lieu) q.lieuPrecis = precis;
  if (pere) q.lieuPere = pere;
  if (grandPere) q.lieuGrandPere = grandPere;
  return q;
}

/**
 * Compose le nom complet. Les champs absents de `p` reprennent `defauts` (utile pour `modifier`, qui ne change qu'une partie).
 * Un champ donné vide (`""`) EFFACE la valeur reprise des défauts. Lève une erreur claire si la qualification est incomplète.
 */
export function composerNom(p: Record<string, unknown>, defauts?: Partial<QualificationNom>): string {
  const v: Record<string, string> = {};
  for (const champ of CHAMPS_TEXTE) {
    const donne = p[champ];
    v[champ] = donne === undefined ? nettoyer(defauts?.[champ]) : nettoyer(donne);
    if (v[champ].includes('---')) throw new Error(`« ${champ} » ne doit pas contenir « --- » (séparateur QUOI/OÙ)`);
    if (v[champ].includes('--')) throw new Error(`« ${champ} » ne doit pas contenir « -- » (séparateur du nommage)`);
  }
  if (!v.quoi) throw new Error('Qualification incomplète : « quoi » est obligatoire');
  if (!v.lieu) throw new Error('Qualification incomplète : « lieu » est obligatoire');
  if (v.lieuGrandPere && !v.lieuPere) {
    throw new Error('« lieuGrandPere » (bâtiment) exige « lieuPere » (étage) : la position dans le nom les distingue');
  }
  const segments: string[] = [];
  if (v.lieuPrecis || v.lieuPere) segments.push(v.lieuPrecis || v.lieu);
  segments.push(v.lieu);
  if (v.lieuPere) segments.push(v.lieuPere);
  if (v.lieuGrandPere) segments.push(v.lieuGrandPere);
  return `${v.quoi}---${segments.join('--')}`;
}
