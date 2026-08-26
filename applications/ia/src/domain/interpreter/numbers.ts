/**
 * Conversion des nombres écrits en toutes lettres françaises vers leur valeur numérique — port de
 * `zdidnodeutil/convertlettresennombre.js` (workspace6/zdidnodedomotext), fonction par fonction,
 * même algorithme (groupement par puissance de mille, gestion "quatre-vingt"/soixante-dix par
 * `suivantMinor`, connecteurs "et"/"de" sautés entre deux mots-nombres).
 */

interface NombreBase {
  nbdigit: number;
  value: number;
  suivantMinor?: number[];
  special?: { prefix: number; name: string };
}

const NOMBRES_BASE: Record<string, NombreBase> = {
  zero: { nbdigit: 1, value: 0 },
  un: { nbdigit: 1, value: 1 },
  deux: { nbdigit: 1, value: 2 },
  trois: { nbdigit: 1, value: 3 },
  quatre: { nbdigit: 1, value: 4 },
  cinq: { nbdigit: 1, value: 5 },
  six: { nbdigit: 1, value: 6 },
  sept: { nbdigit: 1, value: 7 },
  huit: { nbdigit: 1, value: 8 },
  neuf: { nbdigit: 1, value: 9 },
  dix: { nbdigit: 2, value: 10, suivantMinor: [7, 8, 9] },
  onze: { nbdigit: 2, value: 11 },
  douze: { nbdigit: 2, value: 12 },
  treize: { nbdigit: 2, value: 13 },
  quatorze: { nbdigit: 2, value: 14 },
  quinze: { nbdigit: 2, value: 15 },
  seize: { nbdigit: 2, value: 16 },
  vingt: {
    nbdigit: 2,
    value: 20,
    suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    special: { prefix: 4, name: 'quatre-vingt' }
  },
  trente: { nbdigit: 2, value: 30, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  quarante: { nbdigit: 2, value: 40, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  cinquante: { nbdigit: 2, value: 50, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  soixante: { nbdigit: 2, value: 60, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  septante: { nbdigit: 2, value: 70, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  'quatre-vingt': { nbdigit: 2, value: 80, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  octante: { nbdigit: 2, value: 80, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  nonante: { nbdigit: 2, value: 90, suivantMinor: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  cent: { nbdigit: 3, value: 100 },
  mille: { nbdigit: 4, value: 1000 },
  million: { nbdigit: 7, value: 1000000 },
  milliard: { nbdigit: 10, value: 1000000000 }
};

interface ParseResult {
  pos: number;
  resultat: number;
}

interface Accumulated {
  val: number;
  base: NombreBase;
}

/** Comme `_parseNombreEnLettres` legacy : tente de lire un nombre en toutes lettres à partir de
 *  `pos`, retourne la position juste après le dernier mot consommé (= `pos` si aucun nombre trouvé
 *  à cette position) et la valeur numérique reconstituée. */
export function parseNombreEnLettresAt(mots: string[], pos: number): ParseResult {
  const start = !pos || pos < 0 ? 0 : pos;
  const resultats: Accumulated[] = [];
  let newpos = start;
  let varbreak = false;
  let nombreTrouve = false;

  outer: for (let i = start; i < mots.length; i++) {
    const lesMots = mots[i].split(/-/g);
    for (const motBrut of lesMots) {
      let lemot = motBrut;
      const lemot2 = lemot.substring(0, lemot.length - 1);
      if (NOMBRES_BASE[lemot2] && !NOMBRES_BASE[lemot]) {
        lemot = lemot2;
      }
      const base = NOMBRES_BASE[lemot];
      if (base) {
        nombreTrouve = true;
        const dernier = resultats[resultats.length - 1];
        if (dernier && base.special && dernier.base.value === base.special.prefix) {
          const base2 = NOMBRES_BASE[base.special.name];
          resultats[resultats.length - 1] = { val: base2.value, base: base2 };
        } else if (dernier && dernier.base.suivantMinor && dernier.base.suivantMinor.includes(base.value)) {
          dernier.val += base.value;
        } else {
          resultats.push({ val: base.value, base });
        }
      } else if (!((lemot === 'et' || lemot === 'de') && nombreTrouve)) {
        newpos = i;
        varbreak = true;
        break outer;
      }
    }
  }
  if (!varbreak) newpos = mots.length;

  const resinter: Array<{ res: number; precis: number }> = [{ res: 0, precis: 2000 }];
  let posinter = 0;
  if (resultats.length > 0) {
    for (const r of resultats) {
      if (r.base.nbdigit < resinter[posinter].precis) {
        posinter++;
        resinter[posinter] = { res: r.val, precis: r.base.nbdigit };
        continue;
      }
      if (r.base.nbdigit === resinter[posinter].precis) {
        continue; // ne devrait pas arriver, cf. legacy
      }
      let nombre = 0;
      while (resinter[posinter].precis < r.base.nbdigit) {
        nombre += resinter[posinter].res;
        resinter.splice(posinter, 1);
        posinter--;
      }
      posinter++;
      resinter[posinter] = { res: Math.max(1, nombre) * r.val, precis: r.base.nbdigit };
    }
  }

  const res = resinter.reduce((sum, r) => sum + r.res, 0);
  if (newpos !== start && (mots[newpos - 1] === 'et' || mots[newpos - 1] === 'de')) {
    newpos--;
  }
  return { pos: newpos, resultat: res };
}

/** Remplace, dans un tableau de mots déjà tokenisés, toute séquence reconnue comme un nombre en
 *  lettres par sa valeur numérique (nombre JS) — port de `parseAllNombreEnLettres`. Les autres mots
 *  sont laissés inchangés (string). */
export function parseAllNombreEnLettres(mots: string[]): Array<string | number> {
  const res: Array<string | number> = [];
  let currentPos = 0;
  while (currentPos < mots.length) {
    const ret = parseNombreEnLettresAt(mots, currentPos);
    if (ret.pos === currentPos) {
      res.push(mots[currentPos]);
      currentPos++;
    } else {
      res.push(ret.resultat);
      currentPos = ret.pos;
    }
  }
  return res;
}
