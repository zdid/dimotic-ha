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
  // bridge_instance — sa découverte/ses topics d'état passent par mqtt-io (processus externe), pas
  // par le socle, injecté par generator.ts dans le config.yml de mqtt-io (topic_prefix/
  // ha_discovery.prefix). ⭐ 06/09/2026 — n'est plus qu'un PRÉFIXE, duplicable sans risque entre
  // machines dimotic-ha : voir le commentaire équivalent dans arexx/config-schema.ts.
  bridgeInstance: z.string().min(1).default('rpigpio_bridge'),
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
  bridgeInstance: 'rpigpio_bridge',
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
