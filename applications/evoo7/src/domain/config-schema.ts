/**
 * Schéma de configuration EVOO7 — section `evoo7` de data/config.yaml.
 * Paramètres généraux uniquement (connexion au broker MQTT propre à EVOO7, topic/format de
 * commande global, bridge socle) — les 43 données sont dans config-evoo7-donnees-v1.0.yaml
 * (voir donnees-config-schema.ts).
 */

import { z } from 'zod';

const evoo7MqttConfigSchema = z.object({
  // Défaut = adresse réelle du broker EVOO7 de ce déploiement (vue dans l'onglet Paramétrage
  // d'EVOO7 lui-même) — pas un placeholder générique, même convention que le port série par
  // défaut de RFXCOM (/dev/ttyUSB0, également l'appareil réel de ce déploiement).
  host: z.string().default('192.168.1.53'),
  port: z.number().min(1).max(65535).default(1883),
  username: z.string().optional(),
  password: z.string().optional(),
  clientId: z.string().default('evoo7-app'),
  keepalive: z.number().min(0).max(300).default(60),
  reconnectPeriod: z.number().min(1000).max(300000).default(5000),
  cleanSession: z.boolean().default(true),
  qos: z.number().min(0).max(2).default(0),
  useTls: z.boolean().default(false),
  rejectUnauthorized: z.boolean().default(true)
});

export const evoo7ConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // bridge_instance utilisé pour la connexion MQTT au socle (techniques-socle-ha-mqtt_specs §8.5.1).
  // Ce défaut fixe n'est en pratique jamais appliqué : Evoo7Service.loadConfig() génère et persiste
  // un tirage aléatoire au premier démarrage (voir fonctionnelles-supervisor_specs v2.3 §9.2).
  bridgeInstance: z.string().min(1).default('evoo7_bridge_0001'),

  // Connexion directe au broker EVOO7 (indépendante du broker HA du socle — voir plan EVOO7)
  mqtt: evoo7MqttConfigSchema.default({}),

  // Topic + format du message de commande EVOO7 (unique, partagé par toutes les données —
  // désambiguïsé par le champ "num" dans le payload). $name$/$value$ substitués par l'app.
  topicCommand: z.string().min(1).default('domitic/command/evoo7'),
  formatMessageCommand: z.string().min(1).default('{ "num" : "$name$", "status" : "$value$" }'),

  // Fichier de configuration centralisé (données), relatif à la racine du projet
  donneesConfigFile: z.string().min(1).default('config-evoo7-donnees-v1.0.yaml')
});

export type Evoo7Config = z.infer<typeof evoo7ConfigSchema>;
export type Evoo7MqttConfig = z.infer<typeof evoo7MqttConfigSchema>;

export const DEFAULT_EVOO7_CONFIG: Evoo7Config = {
  enabled: true,
  bridgeInstance: 'evoo7_bridge_0001',
  mqtt: {
    host: '192.168.1.53',
    port: 1883,
    clientId: 'evoo7-app',
    keepalive: 60,
    reconnectPeriod: 5000,
    cleanSession: true,
    qos: 0,
    useTls: false,
    rejectUnauthorized: true
  },
  topicCommand: 'domitic/command/evoo7',
  formatMessageCommand: '{ "num" : "$name$", "status" : "$value$" }',
  donneesConfigFile: 'config-evoo7-donnees-v1.0.yaml'
};
