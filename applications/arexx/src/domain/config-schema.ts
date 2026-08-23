/**
 * Schéma de configuration AREXX — section `arexx` de data/config.yaml.
 * Paramètres généraux uniquement (mode d'acquisition, adresse BS1000, port HTTP local) — les
 * capteurs sont dans arexx-sensors-v1.0.yaml (voir devices-config-schema.ts), même séparation
 * que RFXCOM (config.yaml vs config-rfxcom-devices-v1.0.yaml).
 */

import { z } from 'zod';

/**
 * Cible de déploiement automatisé d'un émetteur USB (BS500) — ⭐ 23/08/2026, remplace la copie
 * manuelle de `data/arexx/drivers/` décrite jusqu'ici sur la page Déploiement. Même patron
 * multi-cible que `rpigpio`/`teleinfo` (demande explicite : implémentation identique dans les 3
 * apps), sans plafond ici : AREXX a 2 émetteurs dès le départ. Toujours en root direct (voir
 * core/infrastructure/remote/SshClient.ts).
 */
const arexxTargetSchema = z.object({
  // Identifiant libre de la cible (ex: "bs510") — utilisé dans l'IHM et le protocole Socket.io
  // (arexx:remote-op { targetId, action }), voir ArexxService.ts.
  id: z.string().min(1),
  host: z.string().default(''),
  // Chemin LOCAL vers la clé privée SSH dédiée à CETTE cible — sous data/arexx/ssh/<id>/, jamais
  // ~/.ssh/... (non résolu dans le conteneur Docker, voir defaultSshKeyPath dans SshClient.ts).
  sshKeyPath: z.string().default(''),
  // Répertoire sur la machine cible où copier data/arexx/drivers/ (staging, avant exécution de
  // scripts/deploy-sender.sh — voir ArexxDeployService.ts).
  remoteDir: z.string().default('/root/arexx-drivers')
});

export const arexxConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // Émetteurs USB pilotables à distance (⭐ 23/08/2026) — voir arexxTargetSchema ci-dessus.
  targets: z.array(arexxTargetSchema).default([]),

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

  // bridge_instance utilisé pour la connexion MQTT au socle (via IntegrationBridge, comme RFXCOM).
  // Ce défaut fixe n'est en pratique jamais appliqué : ArexxService.loadConfig() génère et persiste
  // un tirage aléatoire au premier démarrage (voir fonctionnelles-supervisor_specs v2.3 §9.2).
  bridgeInstance: z.string().min(1).default('arexx_bridge_0001'),

  // Fichier de configuration centralisé (capteurs), relatif à la racine du projet
  sensorsConfigFile: z.string().min(1).default('arexx-sensors-v1.0.yaml'),

  // Voir le commentaire équivalent dans rfxcom/config-schema.ts — même risque (area jamais
  // réappliquée après coup par HA), même défaut prudent.
  waitForHaWsBeforeDiscovery: z.boolean().default(true)
})
  .refine(
    (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
    { message: 'Chaque cible doit avoir un id unique', path: ['targets'] }
  );

export type ArexxConfig = z.infer<typeof arexxConfigSchema>;
export type ArexxTargetConfig = z.infer<typeof arexxTargetSchema>;

export const DEFAULT_AREXX_CONFIG: ArexxConfig = {
  enabled: true,
  targets: [],
  acquisitionMode: 'push',
  httpservPort: 49161,
  bs1000Port: 80,
  pollIntervalSeconds: 50,
  bridgeInstance: 'arexx_bridge_0001',
  sensorsConfigFile: 'arexx-sensors-v1.0.yaml',
  waitForHaWsBeforeDiscovery: true
};
