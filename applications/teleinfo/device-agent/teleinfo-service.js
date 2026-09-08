/**
 * Boucle de lecture alternée entre les 2 compteurs — adapté de teleinfoserv.js (zdidnodeteleinfo).
 * Contrairement à l'original, ne dépend plus de `global.properties` (config centrale de l'ancienne
 * domotique) : tous les paramètres sont passés explicitement, lus depuis config.yaml par main.js.
 *
 * ⭐ 12/08/2026 (demande utilisateur, mesuré en conditions réelles à ~5s/compteur) — une pause
 * configurable est insérée après chaque cycle complet (les 2 compteurs lus une fois), pour ne pas
 * publier en MQTT/saturer HA à un rythme inutilement élevé pour du suivi de consommation
 * électrique. SWITCH_DELAY_MS (court, matériel) reste inchangé ENTRE les 2 lectures d'un même
 * cycle — seule la pause APRÈS le cycle complet est configurable.
 */
'use strict';

const { readOneFrame } = require('./teleinfo-reader');

const SWITCH_DELAY_MS = 150; // laisse le temps à la carte de commutation matérielle de basculer

/**
 * @param {string} port chemin du device série
 * @param {{setState:Function, inverse:Function}} gpioSwitch
 * @param {(frame: object) => void} onFrame appelé pour chaque trame longue valide reçue
 * @param {(err: string) => void} onError appelé sur anomalie/timeout d'une lecture (non fatal, la boucle continue)
 * @param {number} cycleIntervalMs pause après chaque cycle complet (2 compteurs lus une fois)
 * @param {boolean} [debug] active la trace fine (teleinfo-reader.js) et journalise chaque bascule GPIO
 */
function start(port, gpioSwitch, onFrame, onError, cycleIntervalMs, debug) {
  const log = debug ? (...args) => console.log('[teleinfo-service]', ...args) : () => {};

  gpioSwitch.inverse(); // position initiale déterministe
  log('position GPIO initiale forcée');
  let readsInCycle = 0;

  function loop() {
    readOneFrame(
      port,
      (err, frame) => {
        if (err) {
          onError(err);
        } else {
          onFrame(frame);
        }
        readsInCycle++;
        if (readsInCycle >= 2) {
          readsInCycle = 0;
          log(`cycle complet, pause ${cycleIntervalMs}ms`);
          setTimeout(loop, cycleIntervalMs);
        } else {
          setTimeout(loop, SWITCH_DELAY_MS);
        }
      },
      () => {
        log('bascule GPIO');
        gpioSwitch.inverse();
      },
      debug
    );
  }

  loop();
}

module.exports = { start };
