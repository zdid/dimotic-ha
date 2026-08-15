/**
 * Schéma de configuration pour l'application RPIGPIO
 *
 * Paramètres de connexion vers le broker MQTT réel (celui que mqtt-io utilisera, pas le socle —
 * rpigpio ne relaie rien lui-même, voir domain/index.ts) et vers la machine cible où tourne le
 * conteneur mqtt-io (SSH + docker compose, mêmes conventions que docker/rebuild-and-deploy.sh :
 * utilisateur dédié avec sudo NOPASSWD, clé SSH par chemin de fichier — jamais de mot de passe/clé
 * en clair ici).
 *
 * ⭐ 12/08/2026 (demande utilisateur) — déploiement en conteneur Docker (image officielle
 * flyte/mqtt-io, vérifiée sur https://hub.docker.com/r/flyte/mqtt-io et son Dockerfile —
 * `CMD python -m mqtt_io /config.yml`, config attendue à la racine du conteneur), au lieu d'un
 * service systemd : cohérent avec le reste de l'infra (ha2/orangepi tournent déjà tout en Docker
 * — dimotic-ha, zigbee2mqtt, homeassistant, mosquitto).
 */

import { z } from 'zod';

const targetConfigSchema = z.object({
  // Hôte SSH (ex: "192.168.1.51" pour ha2, "192.168.1.32" pour orangepi — voir docker/*.sh)
  host: z.string().default(''),
  sshUser: z.string().default('claude'),
  // Chemin LOCAL (sur cette machine de dev) vers la clé privée SSH — jamais le contenu de la clé.
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
  target: targetConfigSchema.default({}),
  mqtt: mqttConfigSchema.default({})
});

export type RpigpioConfig = z.infer<typeof rpigpioConfigSchema>;
export type RpigpioTargetConfig = z.infer<typeof targetConfigSchema>;
export type RpigpioMqttConfig = z.infer<typeof mqttConfigSchema>;

export const DEFAULT_RPIGPIO_CONFIG: RpigpioConfig = {
  enabled: true,
  bridgeInstance: 'rpigpio_bridge_0001',
  target: {
    host: '',
    sshUser: 'claude',
    sshKeyPath: '',
    hostDir: '/docker/mqttio-rpigpio',
    containerName: 'mqtt-io-rpigpio',
    image: 'flyte/mqtt-io:2.6.0'
  },
  mqtt: {
    host: '',
    port: 1883,
    user: '',
    password: '',
    topicPrefix: 'mqttio/rpigpio',
    discoveryPrefix: 'homeassist'
  }
};
