/**
 * Schéma de configuration AREXX — section `arexx` de data/config.yaml.
 * Paramètres généraux uniquement (mode d'acquisition, adresse BS1000, port HTTP local) — les
 * capteurs sont dans arexx-sensors-v1.0.yaml (voir devices-config-schema.ts), même séparation
 * que RFXCOM (config.yaml vs config-rfxcom-devices-v1.0.yaml).
 */

import { z } from 'zod';

export const arexxConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // Mode d'acquisition, mutuellement exclusif (mirroring arexx2hass Controller.start()) :
  // - 'push' : arexx2hass héberge un serveur HTTP local, le BS1000 (ou un BS500 sur RPi séparé)
  //   POSTe ses relevés dessus. Recommandé.
  // - 'poll' : ws-ha va chercher les relevés sur le BS1000 par GET périodique.
  // - 'usb'  : BS500 branché en direct, spawn du binaire rf_usb_http.elf.
  acquisitionMode: z.enum(['push', 'poll', 'usb']).default('push'),

  // Mode 'push' et 'usb' (le binaire USB pousse aussi en HTTP local)
  httpservPort: z.number().int().positive().default(49161),

  // Mode 'poll'
  bs1000Address: z.string().optional(),
  bs1000Port: z.number().int().positive().default(80),
  pollIntervalSeconds: z.number().int().min(5).max(300).default(50),

  // Mode 'usb'
  usbDevicePath: z.string().optional(),

  // bridge_instance utilisé pour la connexion MQTT au socle (via IntegrationBridge, comme RFXCOM)
  bridgeInstance: z.string().min(1).default('arexx_bridge_0001'),

  // Fichier de configuration centralisé (capteurs), relatif à la racine du projet
  sensorsConfigFile: z.string().min(1).default('arexx-sensors-v1.0.yaml'),

  // Voir le commentaire équivalent dans rfxcom/config-schema.ts — même risque (area jamais
  // réappliquée après coup par HA), même défaut prudent.
  waitForHaWsBeforeDiscovery: z.boolean().default(true)
});

export type ArexxConfig = z.infer<typeof arexxConfigSchema>;

export const DEFAULT_AREXX_CONFIG: ArexxConfig = {
  enabled: true,
  acquisitionMode: 'push',
  httpservPort: 49161,
  bs1000Port: 80,
  pollIntervalSeconds: 50,
  bridgeInstance: 'arexx_bridge_0001',
  sensorsConfigFile: 'arexx-sensors-v1.0.yaml',
  waitForHaWsBeforeDiscovery: true
};
