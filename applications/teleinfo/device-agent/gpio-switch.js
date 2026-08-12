/**
 * Pilote la carte de commutation entre les 2 lignes téléinfo (2 entrées, une carte "CAN" maison)
 * via 2 pins GPIO en numérotation physique (BOARD) — adapté de edfteleinfogpio.js (zdidnodeteleinfo,
 * prouvé en conditions réelles sur ce matériel). Un seul module `rpio` par process : n'importe quel
 * process Node non-RPi (tests) doit pouvoir charger ce fichier sans planter, d'où le try/catch.
 */
'use strict';

let rpio;
try {
  rpio = require('rpio');
} catch (e) {
  console.error('[gpio-switch] rpio indisponible — attendu hors RPi uniquement');
}

function createGpioSwitch(pinA, pinB) {
  const options = {
    gpiomem: false, // accès /dev/mem, nécessite root — voir README de déploiement
    mapping: 'physical'
  };
  rpio && rpio.init(options);

  let openA = false;
  let openB = false;
  let isANext = false;

  function setState(highA, highB) {
    if (openA) rpio && rpio.close(pinA);
    if (openB) rpio && rpio.close(pinB);
    rpio && rpio.open(pinA, rpio.OUTPUT, highA ? rpio.HIGH : rpio.LOW);
    openA = true;
    rpio && rpio.open(pinB, rpio.OUTPUT, highB ? rpio.HIGH : rpio.LOW);
    openB = true;
  }

  function inverse() {
    if (isANext) {
      setState(true, false);
      isANext = false;
    } else {
      setState(false, true);
      isANext = true;
    }
  }

  return { setState, inverse };
}

module.exports = { createGpioSwitch };
