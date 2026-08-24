import * as os from 'node:os';
import { z } from 'zod';

// =============================================================================
// Schéma Zod STRICT (sans valeurs par défaut) pour validation pure
// Les valeurs par défaut sont appliquées dans ConfigLoader/ConfigWriter
// =============================================================================

const haWsSchema = z.object({
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().positive().max(65535, 'Port must be between 1 and 65535'),
  token: z.string().min(1, 'Long-Lived Access Token is required'),
  reconnect_delay: z.number().int().nonnegative().max(60, 'Reconnect delay cannot exceed 60 seconds'),
});

const mqttSchema = z.object({
  host: z.string().min(1, 'MQTT host is required'),
  port: z.number().int().positive().max(65535, 'Port must be between 1 and 65535'),
  client_id: z.string().min(1, 'MQTT client_id is required'),
  username: z.string(),
  password: z.string(),
  keepalive: z.number().int().positive().max(3600, 'Keepalive must be a positive integer'),
  reconnect_delay: z.number().int().nonnegative().max(60, 'Reconnect delay cannot exceed 60 seconds'),
});

const haStructureSchema = z.object({
  include_unassigned: z.boolean(),
  unassigned_label: z.string(),
});

const haConfigSchema = z.object({
  ws_enable: z.boolean().default(false),
  mqtt_enable: z.boolean().default(false),
  ws: haWsSchema.optional(),
  mqtt: mqttSchema.optional(),
  structure: haStructureSchema,
});

// Porte d'authentification OAuth2 HA (accès externe, désactivée par défaut) — absente du fichier
// tant qu'elle n'est pas explicitement configurée, voir infrastructure/auth/AuthService.
// ⭐ fonctionnelles-supervisor_specs v2.6 §4 : identité de cette machine pour le futur registre de
// présence multi-machines (superviseur) — os.hostname() est stable d'un démarrage à l'autre sur une
// même machine, contrairement au tirage aléatoire utilisé pour bridgeInstance (voir ha-mqtt.ts
// generateRandomBridgeInstance) : pas besoin de générer une fois puis persister, un défaut Zod
// simple suffit ici.
const coreSchema = z.object({
  machineId: z.string().min(1).default(() => os.hostname())
});

const authSchema = z.object({
  enabled: z.boolean(),
  ha_base_url: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  session_secret: z.string(),
  session_ttl_hours: z.number().int().positive(),
});

const webSchema = z.object({
  port: z.number().int().positive().max(65535, 'Port must be between 1 and 65535'),
  host: z.string(),
  auth: authSchema.optional(),
});

const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  rotate: z.object({
    max_size_mb: z.number().int().positive(),
    max_files: z.number().int().positive().max(100, 'max_files cannot exceed 100'),
  }),
});

/**
 * Cible de déploiement de dimotic-ha lui-même (⭐ 23/08/2026) — une machine (ha2, orangepi...) sur
 * laquelle installer/mettre à jour l'application complète, en remplacement de
 * docker/rebuild-and-deploy.sh. Même patron multi-cible que rpigpio/teleinfo/arexx (voir leurs
 * config-schema.ts) : id texte libre unique, toujours en root direct (voir
 * core/infrastructure/remote/SshClient.ts pour le raisonnement). Pas de champ de clé SSH par
 * cible : une seule clé pour toute l'installation (⭐ 24/08/2026, voir
 * SshClient.ts#globalSshKeyPath). Pas de .max() — plusieurs cibles réelles.
 */
const deploymentTargetSchema = z.object({
  id: z.string().min(1),
  host: z.string().default(''),
  remoteDir: z.string().default('/docker/dimotic-ha'),
  // ⭐ 24/08/2026 : 'local' = ajoutée depuis l'IHM de CETTE machine, 'gossip' = apprise d'une
  // annonce MQTT d'une autre instance dimotic-ha (voir TargetGossipService) — distingue ce que
  // cette machine doit elle-même annoncer (jamais 'gossip', pour éviter tout écho/boucle entre
  // instances) de ce qu'elle a seulement appris d'ailleurs.
  origin: z.enum(['local', 'gossip']).default('local')
});

/**
 * Cible de déploiement d'un stack Home Assistant + Mosquitto (⭐ nouveau 24/08/2026) — liste
 * SÉPARÉE de `targets` (décidé avec l'utilisateur : pas forcément les mêmes machines que celles
 * qui hébergent dimotic-ha). Même forme que `deploymentTargetSchema`, seul le `remoteDir` par
 * défaut change — même clé SSH globale que toute autre cible (SshClient.ts#globalSshKeyPath).
 */
/**
 * Un service post-installation HA (⭐ 24/08/2026) — MQTT n'y figure pas : par construction déjà
 * co-localisé avec HA sur cette même cible (HaStackDeployService y déploie systématiquement
 * Mosquitto), donc rien à qualifier. `host` vide = même machine que la cible HA elle-même (décision
 * utilisateur, 17/08/2026) ; renseigné = adresse:port explicite. Simple carnet d'adresses partagé
 * par gossip — ne configure jamais HA lui-même (aucun appel à ses `config_entries`/`flow`, qui
 * resterait de toute façon bloqué tant que l'onboarding initial n'a pas été fait à la main, voir
 * échange du 17/08/2026).
 */
const haStackServiceEndpointSchema = z.object({
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).optional()
});

const haStackServicesSchema = z.object({
  whisper: haStackServiceEndpointSchema.optional(),
  piper: haStackServiceEndpointSchema.optional(),
  ia: haStackServiceEndpointSchema.optional()
}).default({});

const haStackTargetSchema = z.object({
  id: z.string().min(1),
  host: z.string().default(''),
  remoteDir: z.string().default('/docker/homeassistant'),
  origin: z.enum(['local', 'gossip']).default('local'),
  services: haStackServicesSchema
});

/**
 * Schéma principal de la configuration de l'application.
 * STRICT : tous les champs sont requis. Les valeurs par défaut sont appliquées
 * par ConfigLoader/ConfigWriter après validation.
 * 
 * NOTE: Les sections spécifiques aux modules sont ajoutées dynamiquement
 * par les modules eux-mêmes lors de leur enregistrement.
 */
export const configSchema = z.object({
  core: coreSchema.default({ machineId: os.hostname() }),
  ha: haConfigSchema.optional(),
  web: webSchema,
  logging: loggingSchema,
  // Liste des applications désactivées (id de dossier sous applications/) — remplace le
  // déplacement physique vers applications_désactivées/ (voir ApplicationManager.ts) : une
  // application désactivée reste présente sur disque, seule sa présence dans cette liste
  // l'empêche d'être chargée. Élimine le besoin de fs.renameSync() entre deux répertoires
  // (qui échouait avec EXDEV sous overlay2 sans volume nommé dédié, voir Dockerfile).
  disabledApps: z.array(z.string()).default([]),
  // Cibles de déploiement de dimotic-ha lui-même (⭐ 23/08/2026) — voir deploymentTargetSchema.
  targets: z.array(deploymentTargetSchema).default([]),
  // Cibles de déploiement Home Assistant + Mosquitto (⭐ 24/08/2026) — voir haStackTargetSchema.
  haStackTargets: z.array(haStackTargetSchema).default([]),
  // Les sections spécifiques aux modules seront ajoutées dynamiquement
}).passthrough()
  .refine(
    (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
    { message: 'Chaque cible doit avoir un id unique', path: ['targets'] }
  )
  .refine(
    (config) => new Set(config.haStackTargets.map((t) => t.id)).size === config.haStackTargets.length,
    { message: 'Chaque cible doit avoir un id unique', path: ['haStackTargets'] }
  );
// ⚠️ .passthrough() est indispensable : sans lui, Zod strippe silencieusement toute clé de
// premier niveau non déclarée ci-dessus (nommage/rfxcom/arbreouquoi/evoo7/...) à chaque
// ConfigLoader.load() — la config des modules, pourtant bien écrite sur disque par
// ConfigWriter, disparaissait alors systématiquement de ConfigService.getConfig() dès le
// redémarrage suivant (bug réel constaté : toute config module sauvegardée était perdue).

// =============================================================================
// Types TypeScript (générés à partir du schéma)
// =============================================================================

export type CoreConfig = z.infer<typeof coreSchema>;
export type HaWsConfig = z.infer<typeof haWsSchema>;
export type HaStructureConfig = z.infer<typeof haStructureSchema>;
export type HaConfig = z.infer<typeof haConfigSchema>;
export type MqttConfig = z.infer<typeof mqttSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type DeploymentTargetConfig = z.infer<typeof deploymentTargetSchema>;
export type HaStackTargetConfig = z.infer<typeof haStackTargetSchema>;
export type HaStackServices = z.infer<typeof haStackServicesSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export { coreSchema, haWsSchema, haStructureSchema, haConfigSchema, mqttSchema, webSchema, loggingSchema, deploymentTargetSchema, haStackTargetSchema };
