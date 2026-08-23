/**
 * Schéma de configuration pour l'application RPIGPIO
 *
 * Paramètres de connexion vers le broker MQTT réel (celui que mqtt-io utilisera, pas le socle —
 * rpigpio ne relaie rien lui-même, voir domain/index.ts) et vers la ou les machines cibles où
 * tourne le conteneur mqtt-io (SSH + docker compose, toujours en root direct — voir le commentaire
 * d'en-tête de `core/infrastructure/remote/SshClient.ts`).
 *
 * ⭐ 12/08/2026 (demande utilisateur) — déploiement en conteneur Docker (image officielle
 * flyte/mqtt-io, vérifiée sur https://hub.docker.com/r/flyte/mqtt-io et son Dockerfile —
 * `CMD python -m mqtt_io /config.yml`, config attendue à la racine du conteneur), au lieu d'un
 * service systemd : cohérent avec le reste de l'infra (ha2/orangepi tournent déjà tout en Docker
 * — dimotic-ha, zigbee2mqtt, homeassistant, mosquitto).
 *
 * ⭐ 23/08/2026 — `target` (singulier) devient `targets[]`, plafonné à 1 (`.max(1)`) : rpigpio ne
 * pilotera jamais plus d'une machine, mais le schéma suit le même patron multi-cible que
 * `teleinfo`/`arexx` (demande explicite : implémentation identique dans les 3 apps). Voir
 * `nommage/config-schema.ts` (`nommageSourceSchema`) pour le précédent de ce pattern.
 */

import { z } from 'zod';

const targetConfigSchema = z.object({
  // Identifiant libre de la cible (ex: "stfort") — utilisé dans l'IHM et le protocole Socket.io
  // (rpigpio:remote-op { targetId, action }), voir RpigpioService.ts.
  id: z.string().min(1),
  // Hôte SSH (ex: "192.168.1.53" pour stfort)
  host: z.string().default(''),
  // Chemin LOCAL vers la clé privée SSH dédiée à CETTE cible — jamais son contenu. Par défaut,
  // sous data/rpigpio/ssh/<id>/ (voir defaultSshKeyPath, core/infrastructure/remote/SshClient.ts),
  // jamais ~/.ssh/... (non résolu dans le conteneur Docker, voir ce même fichier).
  sshKeyPath: z.string().default(''),
  // Répertoire sur la machine CIBLE contenant compose.yaml + config.yml générés (voir
  // generator.ts::generateComposeFile) — mêmes conventions que /docker/<app>/ sur ha2/orangepi.
  hostDir: z.string().default('/docker/mqttio-rpigpio'),
  // Nom du conteneur ET du service dans le compose.yaml généré.
  containerName: z.string().default('mqtt-io-rpigpio'),
  // Image Docker — épinglée à une version numérotée plutôt que :latest/:develop (reproductibilité
  // d'un déploiement non supervisé) ; 2.6.0 = dernière version numérotée stable au 12/08/2026.
  image: z.string().default('flyte/mqtt-io:2.6.0')
});

const mqttConfigSchema = z.object({
  host: z.string().default(''),
  port: z.number().min(1).max(65535).default(1883),
  user: z.string().default(''),
  password: z.string().default(''),
  // Préfixe des topics d'état/commande mqtt-io (distinct du préfixe de découverte HA ci-dessous).
  topicPrefix: z.string().default('mqttio/rpigpio'),
  // ⭐ Volontairement "homeassist" par défaut, PAS "homeassistant" — même convention que
  // zigbee2mqtt (voir nommage/config-schema.ts topicPrefix) : la découverte transite par le
  // pipeline nommage (taxonomie, contrôle quoi/où) avant d'atteindre le vrai préfixe HA, jamais
  // publiée directement sur homeassistant/.
  discoveryPrefix: z.string().default('homeassist')
});

export const rpigpioConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : contrairement à rfxcom/evoo7/arexx, rpigpio ne
  // passait par AUCUNE convention de bridgeInstance jusqu'ici — sa découverte/ses topics d'état
  // passent par mqtt-io (processus externe), pas par le socle. Deux instances rpigpio non
  // reconfigurées à la main partageaient donc déjà, réellement, le même topicPrefix/discoveryPrefix
  // (`mqttio/rpigpio`/`homeassist`, valeurs fixes ci-dessous). RpigpioService.loadConfig() génère et
  // persiste un tirage aléatoire au premier démarrage si absent, injecté par generator.ts dans le
  // config.yml de mqtt-io (topic_prefix/ha_discovery.prefix). Défaut fixe ci-dessous conservé comme
  // filet (comme rfxcom/evoo7/arexx), jamais vraiment appliqué en pratique.
  bridgeInstance: z.string().min(1).default('rpigpio_bridge_0001'),
  targets: z.array(targetConfigSchema).max(1).default([]),
  mqtt: mqttConfigSchema.default({})
})
  .refine(
    (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
    { message: 'Chaque cible doit avoir un id unique', path: ['targets'] }
  );

export type RpigpioConfig = z.infer<typeof rpigpioConfigSchema>;
export type RpigpioTargetConfig = z.infer<typeof targetConfigSchema>;
export type RpigpioMqttConfig = z.infer<typeof mqttConfigSchema>;

export const DEFAULT_RPIGPIO_CONFIG: RpigpioConfig = {
  enabled: true,
  bridgeInstance: 'rpigpio_bridge_0001',
  targets: [],
  mqtt: {
    host: '',
    port: 1883,
    user: '',
    password: '',
    topicPrefix: 'mqttio/rpigpio',
    discoveryPrefix: 'homeassist'
  }
};
