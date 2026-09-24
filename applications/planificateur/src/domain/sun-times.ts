/**
 * Calcul lever/coucher du soleil pour une date donnée — via `suncalc` (position GPS de
 * l'installation HA elle-même, récupérée une fois via `HaBridgeClient.getHaConfig()`), pas juste
 * une lecture de `sun.sun` de HA : `sun.sun.next_rising`/`next_setting` ne donne que le PROCHAIN
 * lever/coucher, insuffisant dès qu'un filtre de jours est combiné (ex. "tous les week-ends" —
 * calculer le coucher de samedi prochain quand on est dimanche demande une date arbitraire, pas
 * juste "le prochain"). Voir fonctionnelles-ia_specs §16 (gabarit "soleil") et
 * fonctionnelles-planificateur_specs (trigger.type='sun').
 *
 * Reprend le calcul de l'ancien système (`zdidnodedomoutil/heurelevercouchersoleil.js`, `suncalc`
 * déjà utilisé là — même bibliothèque). Point technique repris et corrigé : `suncalc` calcule en
 * UTC ; le legacy fixait l'heure locale à 3h pour éviter un décalage de jour civil (fonctionnait
 * pour la France, pas en général). Ici : ancrage sur MIDI local, robuste pour n'importe quel fuseau
 * réel (±12h reste dans le même jour calendaire UTC).
 */

import SunCalc from 'suncalc';
import type { HaBridgeClient, Logger } from '../../../core/dist/exports';

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
}

export type SunTimesProvider = (date: Date) => SunTimes | null;

/** ⭐ 24/09/2026 — le calcul (`get`) + un moyen d'ATTENDRE la position avant de programmer. */
export interface SunTimesSource {
  get: SunTimesProvider;
  /** Résout `true` dès que la position est connue (demande si besoin), `false` si la demande
   *  échoue — ne rejette jamais. */
  ensurePosition(): Promise<boolean>;
}

/**
 * Récupère la position GPS de HA une fois résolue, mise en cache définitivement ensuite (ne change
 * jamais en pratique) — mais RÉESSAYE à chaque appel tant que non résolue : vérifié en conditions
 * réelles (26/08/2026) qu'un premier essai au démarrage de `planificateur` peut échouer avec
 * "Cannot get config: not authenticated". Tant que non résolue, `get` retourne `null`.
 *
 * ⭐ 24/09/2026 — bug : `get` étant synchrone, le 1er calcul au démarrage renvoyait TOUJOURS
 * `null` (demande partie mais pas encore revenue) → planification `sun` rejetée (« déclencheur non
 * supporté ») sans nouvel essai. `ensurePosition()` permet à PlanificateurService d'attendre la
 * position (après ha:ready) AVANT de programmer ; SchedulerRuntime réessaie en plus tout seul si
 * le calcul reste impossible.
 */
export function createSunTimesProvider(haBridgeClient: HaBridgeClient, logger: Logger): SunTimesSource {
  let position: { latitude: number; longitude: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  const attemptFetch = (): Promise<boolean> => {
    if (position) return Promise.resolve(true);
    if (inFlight) return inFlight;
    inFlight = haBridgeClient
      .getHaConfig()
      .then((config) => {
        position = config;
        logger.info('sun-times', `Position GPS HA résolue: ${config.latitude}, ${config.longitude}`);
        return true;
      })
      .catch((error) => {
        logger.warn('sun-times', `Échec de récupération de la position GPS HA (nouvel essai au prochain besoin): ${error instanceof Error ? error.message : String(error)}`);
        return false;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const get = (date: Date): SunTimes | null => {
    if (!position) {
      void attemptFetch();
      return null;
    }
    const anchored = new Date(date);
    anchored.setHours(12, 0, 0, 0);
    const times = SunCalc.getTimes(anchored, position.latitude, position.longitude);
    // Aux latitudes extrêmes (jour/nuit polaire), suncalc peut renvoyer null pour l'un des deux —
    // non calculable ce jour-là, même contrat que le reste de triggerToMs (pas de valeur approchée).
    if (!times.sunrise || !times.sunset) return null;
    return { sunrise: times.sunrise, sunset: times.sunset };
  };

  return { get, ensurePosition: attemptFetch };
}
