/**
 * Point d'entrée — lit config.yaml (à côté de ce fichier, généré et déployé par l'app dimotic-ha
 * "teleinfo", voir applications/teleinfo/src/domain/generator.ts) et démarre la lecture alternée
 * des 2 compteurs. Adapté de hateleinfo1.js (zdidnodeteleinfo), qui allait déjà dans ce sens (config
 * locale plutôt que centralisée sur le "module principal" de l'ancienne domotique).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createGpioSwitch } = require('./gpio-switch');
const teleinfoService = require('./teleinfo-service');
const { createHaPublisher } = require('./ha-publisher');

function loadConfig() {
  const configPath = path.join(__dirname, 'config.yaml');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(raw);

  if (!Array.isArray(config.compteurs) || config.compteurs.length !== 2) {
    throw new Error('config.yaml doit déclarer exactement 2 compteurs (bascule GPIO à 2 positions)');
  }
  if (!config.mqtt || !config.mqtt.url) {
    throw new Error('config.yaml: mqtt.url manquant');
  }
  if (!config.port) {
    throw new Error('config.yaml: port manquant');
  }

  return config;
}

function main() {
  const config = loadConfig();
  const discoveryPrefix = config.discoveryPrefix || 'homeassist';
  const gpio = config.gpio || { pinA: 11, pinB: 12 };
  const cycleIntervalMs = config.cycleIntervalMs || 30000;

  console.log('[teleinfo] Démarrage — port:', config.port, 'gpio:', gpio, 'discoveryPrefix:', discoveryPrefix, 'cycleIntervalMs:', cycleIntervalMs);

  const gpioSwitch = createGpioSwitch(gpio.pinA, gpio.pinB);
  const publisher = createHaPublisher(config.mqtt, discoveryPrefix);
  publisher.declareCompteurs(config.compteurs);
  publisher.connect();

  teleinfoService.start(
    config.port,
    gpioSwitch,
    (frame) => {
      console.log('[teleinfo] Trame reçue, ADCO:', frame.ADCO);
      publisher.publishFrame(frame);
    },
    (err) => {
      console.warn('[teleinfo] Anomalie de lecture:', err);
    },
    cycleIntervalMs
  );
}

main();
