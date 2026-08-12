/**
 * Schéma de configuration pour l'application TELEINFO
 *
 * Paramètres de connexion vers la machine cible (RPi1, un seul — 2 compteurs y sont câblés sur une
 * bascule GPIO matérielle, voir device-agent/) et vers le broker MQTT réel qu'utilisera l'agent
 * déployé. Mêmes conventions que rpigpio (SSH par clé, jamais de secret en clair autre que le
 * chemin du fichier de clé).
 */

import { z } from 'zod';

const targetConfigSchema = z.object({
  host: z.string().default(''),
  sshUser: z.string().default('root'),
  sshKeyPath: z.string().default(''),
  // Répertoire sur la machine cible où déployer l'agent (device-agent/ + config.yaml généré).
  remoteDir: z.string().default('/opt/teleinfo'),
  // Chemin du binaire node sur la cible — RPi1 en ARMv6, Node officiel récent n'a plus de build
  // ARMv6 (vérifié 12/08/2026) : utiliser le node déjà installé et prouvé sur ce matériel, pas un
  // node générique du PATH qui pourrait être une version incompatible.
  nodeBinPath: z.string().default('/usr/bin/node'),
  serviceName: z.string().default('teleinfo')
});

const gpioConfigSchema = z.object({
  // Numérotation physique (BOARD), pas BCM — voir device-agent/gpio-switch.js.
  pinA: z.number().int().min(1).max(40).default(11),
  pinB: z.number().int().min(1).max(40).default(12)
});

const mqttConfigSchema = z.object({
  host: z.string().default(''),
  port: z.number().min(1).max(65535).default(1883),
  user: z.string().default(''),
  password: z.string().default(''),
  // ⭐ "homeassist" par défaut, pas "homeassistant" — même convention que nommage/rpigpio : la
  // découverte transite par le pipeline nommage (taxonomie, contrôle quoi/où) avant homeassistant/.
  discoveryPrefix: z.string().default('homeassist')
});

export const teleinfoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  target: targetConfigSchema.default({}),
  gpio: gpioConfigSchema.default({}),
  serialPort: z.string().default('/dev/ttyAMA0'),
  // ⭐ 12/08/2026 (demande utilisateur) — pause entre chaque cycle complet (les 2 compteurs lus
  // une fois) : sans elle, l'agent lit/publie en continu dès qu'une trame arrive, soit environ un
  // message MQTT toutes les 5s PAR compteur (mesuré en conditions réelles) — inutilement rapide
  // pour du suivi de consommation électrique, et lourd pour le recorder HA sur la durée.
  cycleIntervalMs: z.number().int().min(1000).default(30000),
  mqtt: mqttConfigSchema.default({})
});

export type TeleinfoConfig = z.infer<typeof teleinfoConfigSchema>;
export type TeleinfoTargetConfig = z.infer<typeof targetConfigSchema>;
export type TeleinfoGpioConfig = z.infer<typeof gpioConfigSchema>;
export type TeleinfoMqttConfig = z.infer<typeof mqttConfigSchema>;

export const DEFAULT_TELEINFO_CONFIG: TeleinfoConfig = {
  enabled: true,
  target: {
    host: '',
    sshUser: 'root',
    sshKeyPath: '',
    remoteDir: '/opt/teleinfo',
    nodeBinPath: '/usr/bin/node',
    serviceName: 'teleinfo'
  },
  gpio: { pinA: 11, pinB: 12 },
  serialPort: '/dev/ttyAMA0',
  cycleIntervalMs: 30000,
  mqtt: {
    host: '',
    port: 1883,
    user: '',
    password: '',
    discoveryPrefix: 'homeassist'
  }
};
