/**
 * ⭐ 24/09/2026 — évaluation EN CODE des conditions d'une planification/macro, à chaque exécution
 * (décision utilisateur : conditions et commandes toujours recalculées, plus jamais figées ni
 * réinterprétées par Mistral). Trois familles évaluées ici :
 *  - **soleil** (« soleil couché/levé », « nuit/jour ») : même calcul daté que le déclencheur `sun`
 *    (suncalc + position GPS de HA, sun-times.ts) — lever/coucher du jour courant ;
 *  - **comparaison numérique** (forme structurée regles_mistral.txt §2.3 : quoi/lieux/signe/valeur
 *    numérique) : état des entités résolues par quoi/lieux, moyenne si plusieurs ;
 *  - **état simple** (valeur « allumé/éteint/ouvert/fermé/détecté… », signe = ou !=).
 * Tout le reste renvoie `undefined` : l'appelant (execution.ts) demande alors à `ia` d'évaluer la
 * condition (texte libre) — seul appel restant à `ia` au déclenchement.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import type { ConditionSpec } from './types';
import type { SunTimesProvider } from './sun-times';

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function slugify(text: string): string {
  return normalize(text).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
}

const ON_VALUES = ['allume', 'on', 'ouvert', 'ouverte', 'open', 'detecte', 'detectee', 'vrai', 'true', 'present', 'presente', 'actif', 'active', 'marche'];
const OFF_VALUES = ['eteint', 'eteinte', 'off', 'ferme', 'fermee', 'closed', 'faux', 'false', 'absent', 'absente', 'inactif', 'inactive', 'arret'];
const ON_STATES = new Set(['on', 'open', 'opening', 'home', 'detected', 'true', 'playing', 'unlocked']);
const OFF_STATES = new Set(['off', 'closed', 'closing', 'not_home', 'clear', 'false', 'idle', 'paused', 'locked']);

/** « soleil couché » → 'nuit', « soleil levé » → 'jour', sinon undefined. */
function sunExpectation(text: string): 'nuit' | 'jour' | undefined {
  const t = normalize(text);
  if (/couch|nuit|below_horizon|apres le coucher|avant le lever/.test(t)) return 'nuit';
  if (/leve|jour\b|above_horizon|apres le lever|avant le coucher/.test(t)) return 'jour';
  return undefined;
}

function compare(a: number, signe: string, b: number): boolean | undefined {
  switch (signe.trim()) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '=': case '==': return a === b;
    case '!=': return a !== b;
    default: return undefined;
  }
}

export interface LocalConditionResult {
  /** `undefined` : non évaluable en code, à demander à `ia`. */
  result?: boolean;
  /** Explication courte, tracée dans le journal des commandes. */
  detail: string;
}

export async function evaluateConditionLocally(
  condition: string | ConditionSpec,
  registry: HaBridgeClient,
  getSunTimes: SunTimesProvider,
  now: Date = new Date()
): Promise<LocalConditionResult> {
  const spec: ConditionSpec = typeof condition === 'string' ? { phrase: condition } : condition;
  const text = [spec.phrase, spec.quoi, typeof spec.valeur === 'string' ? spec.valeur : ''].filter(Boolean).join(' ');
  const negate = spec.signe?.trim() === '!=';

  // --- Soleil -----------------------------------------------------------------------------
  const isSun = (spec.quoi && /soleil/.test(normalize(spec.quoi))) || /soleil|\bnuit\b|\bjour\b|horizon/.test(normalize(text));
  if (isSun) {
    const expected = sunExpectation(typeof spec.valeur === 'string' ? `${spec.valeur} ${spec.phrase ?? ''}` : text);
    if (!expected) return { detail: `soleil : attente non reconnue (« ${text} »)` };
    const times = getSunTimes(now);
    if (!times) return { detail: 'soleil : position GPS de HA pas encore connue' };
    const nuit = now < times.sunrise || now >= times.sunset;
    const ok = (expected === 'nuit') === nuit;
    return {
      result: negate ? !ok : ok,
      detail: `soleil ${nuit ? 'couché' : 'levé'} (lever ${times.sunrise.toLocaleTimeString('fr-FR')}, coucher ${times.sunset.toLocaleTimeString('fr-FR')})`
    };
  }

  // Sans quoi structuré, rien d'évaluable en code.
  if (!spec.quoi || !registry.isAvailable()) return { detail: 'texte libre' };
  const entities = await registry.getEntitiesByQuoiAndLieux(slugify(spec.quoi), spec.lieux ?? []);
  if (entities.length === 0) return { detail: `aucune entité pour « ${spec.quoi} » ${(spec.lieux ?? []).join(', ')}` };

  // --- Comparaison numérique -----------------------------------------------------------------
  const target = typeof spec.valeur === 'number' ? spec.valeur : Number(String(spec.valeur ?? '').replace(',', '.'));
  if (spec.signe && spec.valeur !== undefined && spec.valeur !== '' && !Number.isNaN(target)) {
    const values = entities.map((e) => Number(e.state)).filter((v) => !Number.isNaN(v));
    if (values.length === 0) return { detail: `« ${spec.quoi} » : aucun état numérique` };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const ok = compare(mean, spec.signe, target);
    if (ok === undefined) return { detail: `signe « ${spec.signe} » non reconnu` };
    return { result: ok, detail: `${spec.quoi} = ${Math.round(mean * 100) / 100} ${spec.signe} ${target}` };
  }

  // --- État simple ---------------------------------------------------------------------------
  const v = normalize(String(spec.valeur ?? ''));
  const wanted = ON_VALUES.includes(v) ? ON_STATES : OFF_VALUES.includes(v) ? OFF_STATES : undefined;
  if (!wanted) return { detail: `valeur « ${spec.valeur ?? ''} » non reconnue` };
  const any = entities.some((e) => wanted.has(String(e.state)));
  return {
    result: negate ? !any : any,
    detail: `${spec.quoi} : ${entities.map((e) => `${e.entity_id}=${e.state}`).join(', ')}`
  };
}
