/**
 * Génère le config.yaml lu par device-agent/main.js — pas de générateur de code applicatif ici
 * (contrairement à rpigpio) : le device-agent est un bundle statique versionné dans ce dépôt
 * (device-agent/*.js), seul le config.yaml varie par déploiement.
 */

import * as yaml from 'js-yaml';
import type { TeleinfoConfig } from './config-schema';
import type { CompteurDefinition } from './storage-schema';

export function generateAgentConfig(config: TeleinfoConfig, compteurs: CompteurDefinition[]): string {
  const doc = {
    port: config.serialPort,
    gpio: {
      pinA: config.gpio.pinA,
      pinB: config.gpio.pinB
    },
    mqtt: {
      url: `mqtt://${config.mqtt.host}:${config.mqtt.port}`,
      user: config.mqtt.user,
      password: config.mqtt.password
    },
    discoveryPrefix: config.mqtt.discoveryPrefix,
    cycleIntervalMs: config.cycleIntervalMs,
    compteurs: compteurs.map((c) => ({
      adco: c.adco,
      quoi: c.quoi,
      lieuPrecis: c.lieuPrecis,
      lieu: c.lieu,
      lieuPere: c.lieuPere,
      lieuGrandPere: c.lieuGrandPere
    }))
  };

  return yaml.dump(doc, { lineWidth: -1 });
}
