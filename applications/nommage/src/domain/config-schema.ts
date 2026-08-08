/**
 * Schéma de configuration pour l'application NOMMAGE
 * Basé sur Zod pour la validation
 *
 * Conforme à fonctionnelles-nommage_specs_v1.1.md §4.3 : `sources` (tableau), toutes connectées
 * et traitées simultanément — remplace l'ancien `couples` (tableau dont seule la première entrée
 * était réellement utilisée par le code).
 */

import { z } from 'zod';

// ============================================================================
// Sous-schémas
// ============================================================================

// Configuration MQTT d'une source (pour écouter les messages de découverte)
const sourceMqttConfigSchema = z.object({
  // Connexion
  host: z.string().default('localhost'),
  port: z.number().min(1).max(65535).default(1883),
  username: z.string().optional(),
  password: z.string().optional(),
  clientId: z.string().default('nommage-app'),
  keepalive: z.number().min(0).max(300).default(60),
  reconnectPeriod: z.number().min(1000).max(300000).default(5000),
  cleanSession: z.boolean().default(true),

  // Topics à écouter (découverte) — voir .transform() ci-dessous : toujours recalculé à partir
  // de topicPrefix, jamais conservé tel quel. Ce champ n'est pas éditable dans le formulaire
  // `array` générique (itemFields ne supporte pas les tableaux imbriqués par item) : une valeur
  // soumise ici vient toujours du template par défaut créé à l'ajout d'une source, jamais mise à
  // jour si topicPrefix change ensuite — la garder telle quelle a déjà causé un abonnement aux
  // mauvais topics MQTT (TODO.md, crash serveur par afflux de messages retained).
  discoveryTopics: z.array(z.string()).optional(),

  // Préfixe des topics (ex: "ha/", "homeassistant/") — source de vérité pour discoveryTopics
  topicPrefix: z.string().default('ha/'),

  // QoS
  qos: z.number().min(0).max(2).default(1),
  retain: z.boolean().default(true),

  // SSL/TLS
  useTls: z.boolean().default(false),
  rejectUnauthorized: z.boolean().default(true)
}).transform((data) => {
  // Toujours dérivé de topicPrefix — jamais la valeur soumise (voir commentaire ci-dessus sur
  // discoveryTopics). topicPrefix n'est pas garanti avoir un "/" final (constaté en pratique :
  // "homeassist" sans slash pour une source réelle, alors que le défaut du schéma est "ha/" avec)
  // — normalisé pour ne jamais produire un topic collé du type "homeassist+/+/config".
  const prefix = data.topicPrefix.replace(/\/+$/, '');

  // Format officiel de découverte MQTT HA : <prefix>/<component>/[<node_id>/]<object_id>/config
  // — node_id est OPTIONNEL, donc exactement deux formes valides, pas un nombre arbitraire de
  // termes. Un catch-all (`prefix/#`) couvrirait les deux mais réintroduirait le risque déjà
  // rencontré (afflux de messages non pertinents, heap overflow) — deux patterns bornés au lieu.
  return {
    ...data,
    discoveryTopics: [`${prefix}/+/+/config`, `${prefix}/+/+/+/config`]
  };
});

// Une source = une connexion MQTT indépendante (fonctionnelles-nommage_specs §3.1, §4.3)
const nommageSourceSchema = z.object({
  // Identifiant unique de la source (ex: "ha-broker", "zigbee2mqtt") — utilisé dans les logs,
  // l'UI, et le champ sourceId des événements
  id: z.string().min(1),
  mqtt: sourceMqttConfigSchema
});

// Configuration de transmission vers HA — commune à toutes les sources (Passthrough MQTT du socle)
const haConfigSchema = z.object({
  // Injecter les attributs de taxonomie dans le payload relayé
  injectTaxonomyAttributes: z.boolean().default(true),

  // Voir le commentaire équivalent dans rfxcom/config-schema.ts — même risque (area jamais
  // réappliquée après coup par HA une fois l'entité créée), même défaut prudent. Particulièrement
  // sensible ici : NOMMAGE relaie potentiellement des centaines d'entités zigbee2mqtt.
  waitForHaWsBeforeDiscovery: z.boolean().default(true)
});

// Configuration Logging — commune à toutes les sources
const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  showParsedMessages: z.boolean().default(false),
  showRawMessages: z.boolean().default(false)
});

// Pays dont les traductions de noms d'entité sont chargées (TranslationsRepository) — désigne un
// nom de pays (ex: "France"), pas un code de langue ISO. Un pays sans fichier connu est généré
// à la volée (voir TranslationsRepository), pas une erreur.
const languageConfigSchema = z.object({
  country: z.string().default('France')
});

// ============================================================================
// Schéma principal
// ============================================================================

export const nommageConfigSchema = z.object({
  // Activation générale
  enabled: z.boolean().default(true),

  // Une ou plusieurs sources MQTT, toutes connectées et traitées simultanément
  sources: z.array(nommageSourceSchema).min(1).default([
    { id: 'ha-broker', mqtt: {} }
  ]),

  ha: haConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  language: languageConfigSchema.default({})
})
  .refine(
    (config) => new Set(config.sources.map((s) => s.id)).size === config.sources.length,
    { message: 'Chaque source doit avoir un id unique', path: ['sources'] }
  )
  .refine(
    (config) => {
      const clientIds = config.sources.map((s) => s.mqtt.clientId);
      return new Set(clientIds).size === clientIds.length;
    },
    { message: 'Chaque source doit avoir un clientId MQTT unique', path: ['sources'] }
  );

// ============================================================================
// Types TypeScript
// ============================================================================

export type NommageConfig = z.infer<typeof nommageConfigSchema>;
export type NommageSourceConfig = z.infer<typeof nommageSourceSchema>;
export type NommageSourceMqttConfig = z.infer<typeof sourceMqttConfigSchema>;
export type NommageHaConfig = z.infer<typeof haConfigSchema>;
export type NommageLoggingConfig = z.infer<typeof loggingConfigSchema>;
export type NommageLanguageConfig = z.infer<typeof languageConfigSchema>;

// ============================================================================
// Valeurs par défaut
// ============================================================================

const DEFAULT_NOMMAGE_SOURCE: NommageSourceConfig = {
  id: 'ha-broker',
  mqtt: {
    host: 'localhost',
    port: 1883,
    clientId: 'nommage-ha-broker',
    keepalive: 60,
    reconnectPeriod: 5000,
    cleanSession: true,
    discoveryTopics: ['ha/+/+/config', 'ha/+/+/+/config'], // recalculé au prochain parse (voir .transform() ci-dessus)
    topicPrefix: 'ha/',
    qos: 1,
    retain: true,
    useTls: false,
    rejectUnauthorized: true
  }
};

export const DEFAULT_NOMMAGE_CONFIG: NommageConfig = {
  enabled: true,
  sources: [DEFAULT_NOMMAGE_SOURCE],
  ha: {
    injectTaxonomyAttributes: true,
    waitForHaWsBeforeDiscovery: true
  },
  logging: {
    level: 'info',
    showParsedMessages: false,
    showRawMessages: false
  },
  language: {
    country: 'France'
  }
};

/**
 * Construit une nouvelle source avec des valeurs par défaut, pour l'ajout dynamique dans l'UI.
 */
export function createDefaultSource(id: string): NommageSourceConfig {
  return {
    id,
    mqtt: {
      host: 'localhost',
      port: 1883,
      clientId: `nommage-${id}`,
      keepalive: 60,
      reconnectPeriod: 5000,
      cleanSession: true,
      discoveryTopics: ['ha/+/+/config', 'ha/+/+/+/config'], // recalculé au prochain parse (voir .transform() ci-dessus)
      topicPrefix: 'ha/',
      qos: 1,
      retain: true,
      useTls: false,
      rejectUnauthorized: true
    }
  };
}
