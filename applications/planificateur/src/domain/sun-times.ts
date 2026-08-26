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

/**
 * Récupère la position GPS de HA une fois résolue, mise en cache définitivement ensuite (ne change
 * jamais en pratique) — mais RÉESSAYE à chaque appel tant que non résolue : vérifié en conditions
 * réelles (26/08/2026) qu'un premier essai au démarrage de `planificateur` peut échouer avec
 * "Cannot get config: not authenticated" (même course démarrage/authentification WS déjà
 * rencontrée côté `ExecutionEngine` — `core` vient de redémarrer, `planificateur` l'interroge avant
 * que sa connexion HA soit authentifiée). Sans nouvelle tentative, la position resterait bloquée
 * indéfiniment (contrairement à une commande HA classique qui s'auto-corrige au coup d'après) —
 * chaque appel de la fonction retournée est l'occasion de réessayer si besoin, sans minuteur dédié.
 * Tant que non résolue, retourne `null` — `scheduler.ts::triggerToMs` gère déjà ce cas proprement.
 */
export function createSunTimesProvider(haBridgeClient: HaBridgeClient, logger: Logger): SunTimesProvider {
  let position: { latitude: number; longitude: number } | undefined;
  let fetching = false;

  const attemptFetch = (): void => {
    if (fetching || position) return;
    fetching = true;
    haBridgeClient
      .getHaConfig()
      .then((config) => {
        position = config;
        logger.info('sun-times', `Position GPS HA résolue: ${config.latitude}, ${config.longitude}`);
      })
      .catch((error) => {
        logger.warn('sun-times', `Échec de récupération de la position GPS HA (nouvel essai au prochain besoin): ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        fetching = false;
      });
  };

  attemptFetch();

  return (date: Date): SunTimes | null => {
    if (!position) {
      attemptFetch();
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
}
