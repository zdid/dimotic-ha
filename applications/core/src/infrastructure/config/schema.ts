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
 * Schéma principal de la configuration de l'application.
 * STRICT : tous les champs sont requis. Les valeurs par défaut sont appliquées
 * par ConfigLoader/ConfigWriter après validation.
 * 
 * NOTE: Les sections spécifiques aux modules sont ajoutées dynamiquement
 * par les modules eux-mêmes lors de leur enregistrement.
 */
export const configSchema = z.object({
  ha: haConfigSchema.optional(),
  web: webSchema,
  logging: loggingSchema,
  // Les sections spécifiques aux modules seront ajoutées dynamiquement
}).passthrough();
// ⚠️ .passthrough() est indispensable : sans lui, Zod strippe silencieusement toute clé de
// premier niveau non déclarée ci-dessus (nommage/rfxcom/arbreouquoi/evoo7/...) à chaque
// ConfigLoader.load() — la config des modules, pourtant bien écrite sur disque par
// ConfigWriter, disparaissait alors systématiquement de ConfigService.getConfig() dès le
// redémarrage suivant (bug réel constaté : toute config module sauvegardée était perdue).

// =============================================================================
// Types TypeScript (générés à partir du schéma)
// =============================================================================

export type HaWsConfig = z.infer<typeof haWsSchema>;
export type HaStructureConfig = z.infer<typeof haStructureSchema>;
export type HaConfig = z.infer<typeof haConfigSchema>;
export type MqttConfig = z.infer<typeof mqttSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export { haWsSchema, haStructureSchema, haConfigSchema, mqttSchema, webSchema, loggingSchema };
