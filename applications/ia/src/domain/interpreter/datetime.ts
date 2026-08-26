/**
 * Reconnaissance de durées/heures/dates en français — port de
 * `zdidnodeutil/num_convert_date_duration_time.js` (workspace6/zdidnodedomotext), fonction par
 * fonction pour la pièce la plus utilisée (`isArrayLiteralHoursMinutesSecondes` → durées/heures
 * parlées : "3 heures et quart", "midi moins le quart", "dans 5 minutes"...).
 *
 * ⭐ Portée volontairement réduite par rapport au legacy sur la reconnaissance de DATE ABSOLUE
 * (`parseDateTime` legacy s'appuyait sur `SimpleDateFormat`, un moteur de formats génériques que ce
 * port ne reprend pas) : couvre `dd/MM/yyyy`, `d MMMM yyyy`/`d MMMM` (mois en toutes lettres),
 * "demain"/"après-demain" — les tournures réalistes d'une commande vocale — mais pas le format
 * "Google" abrégé (`5h30m20s`), jamais entendu en usage réel. Voir le plan de mise en œuvre pour le
 * détail de ce choix.
 */

export function isNumeric(value: string | number): number | false {
  if (typeof value === 'number') return value;
  const num = parseFloat(value.trim());
  return `${num}` === value.trim() ? num : false;
}

export function isInteger(value: string | number): number | false {
  const res = isNumeric(value);
  if (res === false) return false;
  if (res > 0 && res === Math.round(res)) return res;
  if (res < 0 && res === Math.floor(res)) return res;
  if (res === 0) return 0;
  return false;
}

const FACTEUR = [24 * 60 * 60 * 1000, 60 * 60 * 1000, 60 * 1000, 1000, 1, 30 * 60 * 1000, 15 * 60 * 1000];
const FACT_JOUR = 0;
const FACT_HEURE = 1;
const FACT_MINUTES = 2;
const FACT_SECONDES = 3;
const FACT_MILLI = 4;
const FACT_DEMIHEURE = 5;
const FACT_QUARTHEURE = 6;

export interface SpokenDurationResult {
  found: boolean;
  next: number;
  durationMs: number;
  isOnlyDuration: boolean;
  isOnlyTime: boolean;
}

type Token = string | number;

function wordAt(mots: Token[], i: number): string | undefined {
  const w = mots[i];
  return typeof w === 'string' ? w : undefined;
}

/** Port de `isArrayLiteralHoursMinutesSecondes` — reconnaît une durée/heure exprimée en toutes
 *  lettres à partir de `pos` : "3 heures 55 minutes 20 secondes", "midi", "midi et quart", "14
 *  heures moins le quart", "1 jour 3 heures"... */
export function parseSpokenDuration(mots: Token[], pos: number): SpokenDurationResult {
  if (mots.length < 2) return { found: false, next: pos, durationMs: 0, isOnlyDuration: false, isOnlyTime: false };

  const values: number[] = [];
  let pasbon = false;
  let prev: string | undefined;
  let isOnlyDuration = false;
  let isOnlyTime = false;
  let potentialMinutes = false;
  let flagHeure = 0;
  let i = 0;

  for (i = 0; i + pos < mots.length; i++) {
    const j = Math.round((i + flagHeure) / 2) * 2;
    const w = wordAt(mots, i + pos);
    if (i + flagHeure === j) {
      // position paire : une valeur (nombre, "midi", "minuit")
      if (w === 'midi') {
        flagHeure = flagHeure === 0 ? 1 : 0;
        values.push(12, 1);
        prev = 'heure';
        isOnlyTime = true;
      } else if (w === 'minuit') {
        flagHeure = flagHeure === 0 ? 1 : 0;
        values.push(0, 1);
        prev = 'heure';
        isOnlyTime = true;
      } else {
        const val = mots[i + pos] !== undefined ? isInteger(mots[i + pos]) : false;
        if (val !== false) {
          values.push(val);
          potentialMinutes = prev === 'heure';
        } else {
          pasbon = true;
        }
      }
    } else {
      // position impaire : une unité ("heure(s)", "minute(s)", "seconde(s)", "jour(s)"...)
      const w2 = wordAt(mots, i + pos + 1);
      const w3raw = mots[i + pos + 2];
      const w3 = typeof w3raw === 'string' ? w3raw : undefined;
      if (w?.substring(0, 4) === 'jour') {
        potentialMinutes = false;
        isOnlyDuration = true;
        values.push(FACT_JOUR);
      } else if (w?.substring(0, 10) === 'demi-heure') {
        flagHeure = flagHeure === 0 ? 1 : 0;
        values.push(FACT_DEMIHEURE);
        potentialMinutes = false;
        prev = 'heure';
        isOnlyDuration = true;
      } else if (w?.substring(0, 13) === 'quart-d-heure') {
        flagHeure = flagHeure === 0 ? 1 : 0;
        values.push(FACT_QUARTHEURE);
        potentialMinutes = false;
        prev = 'heure';
        isOnlyDuration = true;
      } else if (w?.substring(0, 5) === 'quart' && w2 === 'd' && w3?.substring(0, 5) === 'heure') {
        flagHeure = flagHeure === 0 ? 1 : 0;
        values.push(FACT_QUARTHEURE);
        potentialMinutes = false;
        prev = 'heure';
        isOnlyDuration = true;
        i += 2;
      } else if (w?.substring(0, 5) === 'heure') {
        potentialMinutes = false;
        prev = 'heure';
        values.push(FACT_HEURE);
      } else if (w?.substring(0, 6) === 'minute') {
        potentialMinutes = false;
        prev = 'minute';
        values.push(FACT_MINUTES);
      } else if (w?.substring(0, 6) === 'second') {
        potentialMinutes = false;
        prev = 'second';
        values.push(FACT_SECONDES);
      } else if (w?.substring(0, 5) === 'milli') {
        potentialMinutes = false;
        values.push(FACT_MILLI);
        prev = 'milli';
      } else {
        pasbon = true;
      }
    }
    if (pasbon) break;
  }

  if (potentialMinutes && prev === 'heure') values.push(FACT_MINUTES);

  let next = pos;
  let trouve = false;
  if (values.length > 1) {
    next += i;
    trouve = true;
  }

  let peutetrenext = next;
  if (trouve && prev === 'heure' && mots[next] !== undefined) {
    if (mots[next + 1] !== undefined && `${mots[next]}`.toLowerCase() === 'et') {
      peutetrenext += 1;
    }
    if (mots[peutetrenext] === 'quart') {
      values.push(15, FACT_MINUTES);
      next = peutetrenext + 1;
    }
    if (mots[peutetrenext] === 'demi') {
      values.push(30, FACT_MINUTES);
      next = peutetrenext + 1;
    }
    if (mots[next + 1] !== undefined && mots[next] === 'moins') {
      peutetrenext += 1;
      if (mots[peutetrenext + 1] !== undefined && mots[peutetrenext] === 'le') peutetrenext += 1;
      if (mots[peutetrenext] === 'quart') {
        values[values.length - 2] -= 1;
        values.push(45, FACT_MINUTES);
        next = peutetrenext + 1;
      } else {
        const num = isInteger(mots[peutetrenext] ?? '');
        if (num !== false && num < 30) {
          values[values.length - 2] -= 1;
          values.push(60 - num, FACT_MINUTES);
          next = peutetrenext + 1;
        }
      }
    }
  }

  if (pasbon && next === pos) return { found: false, next: pos, durationMs: 0, isOnlyDuration: false, isOnlyTime: false };

  let resultat = 0;
  for (let k = 1; k < values.length; k += 2) resultat += values[k - 1] * FACTEUR[values[k]];

  return { found: trouve, next, durationMs: resultat, isOnlyDuration, isOnlyTime };
}

// ---------------------------------------------------------------------------------------------
// Date absolue — portée réduite (voir en-tête de fichier)
// ---------------------------------------------------------------------------------------------

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11
};

export interface DateParseResult {
  found: boolean;
  next: number;
  date?: Date;
  /** true si l'heure a aussi été trouvée dans le même motif (ex. "23/10/2026 14:30"). */
  hasTime: boolean;
}

function todayAt(hours = 0, minutes = 0): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** Reconnaît une date absolue à partir de `pos` : `dd/MM/yyyy`, `d MMMM yyyy`, `d MMMM`,
 *  "demain"/"après-demain". Ne consomme jamais partiellement un motif non reconnu. */
export function parseFrenchDate(mots: Token[], pos: number): DateParseResult {
  const w0 = wordAt(mots, pos);
  const notFound: DateParseResult = { found: false, next: pos, hasTime: false };
  if (w0 === undefined) return notFound;

  const lower = w0.toLowerCase();
  if (lower === 'demain') {
    const d = todayAt();
    d.setDate(d.getDate() + 1);
    return { found: true, next: pos + 1, date: d, hasTime: false };
  }
  if (lower === 'apres-demain' || lower === 'après-demain' || lower === 'apres demain' || lower === 'après demain') {
    const d = todayAt();
    d.setDate(d.getDate() + 2);
    return { found: true, next: pos + 1, date: d, hasTime: false };
  }
  if ((lower === 'apres' || lower === 'après') && wordAt(mots, pos + 1)?.toLowerCase() === 'demain') {
    const d = todayAt();
    d.setDate(d.getDate() + 2);
    return { found: true, next: pos + 2, date: d, hasTime: false };
  }

  // dd/MM/yyyy ou dd/MM (année courante), éventuellement suivi de HH:mm(:ss)
  if (w0.includes('/')) {
    const parts = w0.split('/').map((p) => parseInt(p, 10));
    if (parts.length >= 2 && parts.every((p) => !Number.isNaN(p))) {
      const [day, month, yearRaw] = parts;
      const year = yearRaw === undefined ? new Date().getFullYear() : yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      const d = new Date(year, month - 1, day, 0, 0, 0, 0);
      if (d.getMonth() === month - 1 && d.getDate() === day) {
        const timeWord = wordAt(mots, pos + 1);
        if (timeWord?.includes(':')) {
          const [hh, mm, ss] = timeWord.split(':').map((p) => parseInt(p, 10));
          if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
            d.setHours(hh, mm, Number.isNaN(ss) ? 0 : ss, 0);
            return { found: true, next: pos + 2, date: d, hasTime: true };
          }
        }
        return { found: true, next: pos + 1, date: d, hasTime: false };
      }
    }
    return notFound;
  }

  // "d MMMM" / "d MMMM yyyy"
  const day = isInteger(w0);
  if (day !== false && day > 0 && day <= 31) {
    const monthWord = wordAt(mots, pos + 1)?.toLowerCase();
    const month = monthWord !== undefined ? FRENCH_MONTHS[monthWord] : undefined;
    if (month !== undefined) {
      const yearWord = mots[pos + 2];
      const yearNum = typeof yearWord === 'number' ? yearWord : isInteger(yearWord ?? '');
      if (yearNum !== false && yearNum > 1900) {
        const d = new Date(yearNum, month, day, 0, 0, 0, 0);
        return { found: true, next: pos + 3, date: d, hasTime: false };
      }
      const d = new Date(new Date().getFullYear(), month, day, 0, 0, 0, 0);
      return { found: true, next: pos + 2, date: d, hasTime: false };
    }
  }

  return notFound;
}

// ---------------------------------------------------------------------------------------------
// Orchestrateur : date + heure/durée qui suit éventuellement
// ---------------------------------------------------------------------------------------------

export interface DateTimeResult {
  found: boolean;
  next: number;
  /** Horodatage absolu (epoch ms) si une date a été trouvée. */
  timestampMs?: number;
  /** Durée/décalage en ms si seule une heure/durée a été trouvée (pas de date). */
  durationMs?: number;
  isDate: boolean;
  isDatetime: boolean;
  isTime: boolean;
  isDuration: boolean;
}

const NOT_FOUND: DateTimeResult = { found: false, next: 0, isDate: false, isDatetime: false, isTime: false, isDuration: false };

/** Port simplifié de `parseDateTime` : cherche d'abord une date absolue, puis, si un mot "à"/"a"
 *  suit ou immédiatement, une heure/durée parlée (`parseSpokenDuration`) — combine les deux en un
 *  seul horodatage si les deux sont trouvés, sinon renvoie l'un ou l'autre. */
export function parseDateTimeAt(mots: Token[], pos: number): DateTimeResult {
  const dateResult = parseFrenchDate(mots, pos);
  let cursor = dateResult.found ? dateResult.next : pos;
  let date = dateResult.date;
  let hasTime = dateResult.hasTime;

  if (!hasTime) {
    let timeCursor = cursor;
    const w = wordAt(mots, timeCursor);
    if ((w === 'a' || w === 'à') && mots[timeCursor + 1] !== undefined) timeCursor += 1;

    const spoken = parseSpokenDuration(mots, timeCursor);
    if (spoken.found) {
      if (date) {
        if (!spoken.isOnlyDuration) {
          date = new Date(date.getTime() + spoken.durationMs);
          cursor = spoken.next;
          hasTime = true;
        }
        // un élément qui n'est qu'une durée après une date déjà trouvée n'est pas exploitable ici
        // (mirroring legacy : la date reste valide seule, la durée n'est pas consommée)
      } else {
        const epoch = new Date(1970, 0, 1);
        const combined = new Date(epoch.getTime() + spoken.durationMs);
        if (spoken.isOnlyDuration) {
          return {
            found: true,
            next: spoken.next,
            durationMs: spoken.durationMs,
            isDate: false,
            isDatetime: false,
            isTime: false,
            isDuration: true
          };
        }
        return {
          found: true,
          next: spoken.next,
          timestampMs: combined.getTime(),
          durationMs: spoken.durationMs,
          isDate: false,
          isDatetime: false,
          isTime: !spoken.isOnlyTime ? true : true,
          isDuration: false
        };
      }
    }
  }

  if (!date) return { ...NOT_FOUND, next: pos };

  return {
    found: true,
    next: cursor,
    timestampMs: date.getTime(),
    isDate: !hasTime,
    isDatetime: hasTime,
    isTime: false,
    isDuration: false
  };
}

function classify(mots: Token[], pos: number, predicate: (r: DateTimeResult) => boolean): DateTimeResult {
  const result = parseDateTimeAt(mots, pos ?? 0);
  if (predicate(result)) return result;
  return { ...result, found: false, next: pos ?? 0 };
}

export interface TimeOfDayResult {
  found: boolean;
  next: number;
  hours: number;
  minutes: number;
}

/** Extrait une heure de la journée ("midi", "14 heures", "14 heures 30", "midi et quart"...) sous
 *  forme heures/minutes directement exploitables pour un `trigger.at` ("HH:mm") — plus direct que
 *  `parseDateTimeAt` pour ce besoin précis (celui-ci raisonne en horodatage absolu ancré sur epoch,
 *  peu pratique pour n'en extraire que l'heure du jour). Ignore un résultat qui n'est qu'une durée
 *  pure ("3 jours") : ce n'est pas une heure de la journée. */
export function parseTimeOfDay(mots: Token[], pos: number): TimeOfDayResult {
  const r = parseSpokenDuration(mots, pos);
  if (!r.found || r.isOnlyDuration) return { found: false, next: pos, hours: 0, minutes: 0 };
  const totalMinutes = Math.round(r.durationMs / 60000) % (24 * 60);
  return { found: true, next: r.next, hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export const isDate = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isDate || r.isDatetime);
export const isDatetime = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isDatetime);
export const isOnlyDate = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isDate);
export const isOnlyTimeOrDuration = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isTime || r.isDuration);
export const isTime = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isTime);
export const isDuration = (mots: Token[], pos = 0): DateTimeResult => classify(mots, pos, (r) => r.isDuration);
