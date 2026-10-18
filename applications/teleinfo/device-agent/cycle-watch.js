/**
 * Surveillance des cycles de lecture — prévient quand AUCUNE trame n'arrive, ou qu'un compteur déclaré manque
 * (« un seul reçu sur deux attendus »). Un cycle = 2 lectures (une par position de la bascule GPIO).
 *
 * Pour éviter les fausses alertes sur un cycle isolé, l'alerte ne part qu'après `cyclesAvantAlerte` cycles mauvais
 * consécutifs ; un cycle complet suffit à revenir à la normale. Seuls les CHANGEMENTS d'état sont signalés (plus un
 * rappel au journal toutes les `rappelMs` tant que ça dure) — aucun message pour une trame normale.
 *
 * Fonction pure côté horloge/sorties (injectées) pour être testée sans matériel.
 */
'use strict';

const LECTURES_PAR_CYCLE = 2;

/**
 * @param {object} options
 * @param {() => number[]} options.attendus ADCO déclarés (ceux qu'on s'attend à lire) — relu à chaque cycle
 * @param {(alerte: object) => void} options.signaler appelé à chaque changement d'état ({niveau:'alerte'|'ok', …})
 * @param {number} [options.cyclesAvantAlerte] cycles mauvais consécutifs avant l'alerte (défaut 3)
 * @param {number} [options.rappelMs] rappel au journal pendant une alerte (défaut 10 min)
 * @param {(msg: string) => void} [options.journal] sortie des rappels
 * @param {() => number} [options.maintenant] horloge (ms)
 */
function createCycleWatch(options) {
  const cyclesAvantAlerte = options.cyclesAvantAlerte || 3;
  const rappelMs = options.rappelMs || 10 * 60 * 1000;
  const journal = options.journal || (() => {});
  const maintenant = options.maintenant || Date.now;

  let lectures = 0;
  let vus = new Set();
  let mauvaisConsecutifs = 0;
  let enAlerte = false;
  let depuis = 0;
  let dernierRappel = 0;

  function description(attendus, manquants, recus) {
    if (recus.length === 0) {
      return attendus.length
        ? 'Aucune trame reçue (attendu : ' + attendus.length + ' compteur' + (attendus.length > 1 ? 's' : '') + ')'
        : 'Aucune trame reçue';
    }
    return recus.length + ' compteur' + (recus.length > 1 ? 's' : '') + ' reçu' + (recus.length > 1 ? 's' : '') + ' sur ' + attendus.length +
      ' attendu' + (attendus.length > 1 ? 's' : '') + ' — pas de trame de : ' + manquants.join(', ');
  }

  function evaluerCycle() {
    const attendus = options.attendus();
    const recus = [...vus];
    const manquants = attendus.filter((adco) => !vus.has(adco));
    // Mauvais cycle : rien reçu du tout, ou au moins un compteur déclaré sans trame.
    const mauvais = recus.length === 0 || manquants.length > 0;
    vus = new Set();

    if (mauvais) {
      mauvaisConsecutifs++;
      if (!enAlerte && mauvaisConsecutifs >= cyclesAvantAlerte) {
        enAlerte = true;
        depuis = maintenant();
        dernierRappel = depuis;
        options.signaler({
          niveau: 'alerte',
          raison: recus.length === 0 ? 'aucune_trame' : 'compteur_manquant',
          attendus: attendus.length,
          recus: recus.length,
          manquants,
          message: description(attendus, manquants, recus),
          depuis: new Date(depuis).toISOString()
        });
      } else if (enAlerte && maintenant() - dernierRappel >= rappelMs) {
        dernierRappel = maintenant();
        journal(description(attendus, manquants, recus) + ' — depuis ' + Math.round((maintenant() - depuis) / 60000) + ' min');
      }
    } else {
      mauvaisConsecutifs = 0;
      if (enAlerte) {
        enAlerte = false;
        options.signaler({ niveau: 'ok', message: 'Lecture rétablie : tous les compteurs répondent', attendus: attendus.length, recus: recus.length, manquants: [], depuis: new Date(maintenant()).toISOString() });
      }
    }
  }

  function lecture() {
    lectures++;
    if (lectures >= LECTURES_PAR_CYCLE) {
      lectures = 0;
      evaluerCycle();
    }
  }

  return {
    /** Une trame valide a été lue pour ce compteur. */
    trame(adco) {
      vus.add(Number(adco));
      lecture();
    },
    /** Une lecture a échoué (timeout/anomalie) : compte comme une lecture sans trame. */
    erreur() {
      lecture();
    },
    etat() {
      return { enAlerte, mauvaisConsecutifs };
    }
  };
}

module.exports = { createCycleWatch };
