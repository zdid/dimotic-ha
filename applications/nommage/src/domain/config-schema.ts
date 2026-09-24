/**
 * Schéma de configuration pour l'application NOMMAGE
 * Basé sur Zod pour la validation
 *
 * ⭐ 24/09/2026 (décision utilisateur) — plus de connexion MQTT propre à NOMMAGE : les « sources »
 * (hôte/port/identifiants/clientId/TLS… par source) avaient été prévues pour lire des découvertes
 * sur d'autres brokers que celui du socle, ce qui n'a jamais servi. NOMMAGE s'abonne désormais via
 * la connexion MQTT du socle (passthrough), et la config se réduit à la liste des PRÉFIXES de
 * découverte à écouter (ex. "homeassist" : là où zigbee2mqtt/mqtt-io publient leurs découvertes
 * brutes, relayées enrichies vers "homeassistant/"). Une ancienne config `sources[]` est migrée
 * automatiquement (préfixes déduits de `sources[].mqtt.topicPrefix`).
 */

import { z } from 'zod';

// ============================================================================
// Sous-schémas
// ============================================================================

/** Un préfixe de découverte à écouter — objet (et non simple chaîne) : le formulaire générique ne
 *  sait éditer qu'un tableau d'objets (type 'array' + itemFields). */
const prefixEntrySchema = z.object({
  prefix: z.string().min(1).transform((p) => p.trim().replace(/^\/+|\/+$/g, ''))
});

// Configuration de transmission vers HA (Passthrough MQTT du socle)
const haConfigSchema = z.object({
  // Injecter les attributs de taxonomie dans le payload relayé
  injectTaxonomyAttributes: z.boolean().default(true),

  // Voir le commentaire équivalent dans rfxcom/config-schema.ts — même risque (area jamais
  // réappliquée après coup par HA une fois l'entité créée), même défaut prudent. Particulièrement
  // sensible ici : NOMMAGE relaie potentiellement des centaines d'entités zigbee2mqtt.
  waitForHaWsBeforeDiscovery: z.boolean().default(true),

  // ⭐ 12/08/2026 (demande utilisateur) — un device physiquement neutre (ex: module relais mural
  // Tuya) déclaré côté source avec un QUOI "lumière"/"lumiere" (ex: "lumière---vitrine--cuisine")
  // est promu en composant HA `light` au lieu du `switch` publié tel quel par la source (Zigbee2MQTT
  // ne connaît pas notre taxonomie, seulement les capacités physiques du device — il ne peut donc
  // pas savoir que ce relais pilote un vrai luminaire). Uniquement le composant `switch`
  // effectivement basé sur le QUOI : les autres entités du même device (select power_on_behavior,
  // number countdown...) restent inchangées. Le payload HA "switch" basique (state_topic,
  // command_topic, payload_on/off) est compatible avec le schéma "light" par défaut de HA (pas de
  // brightness/couleur nécessaire) — vérifié par comparaison des deux schémas de découverte MQTT.
  forceLightForLumiere: z.boolean().default(true)
});

// Configuration Logging
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
// Migration de l'ancien format (sources[])
// ============================================================================

/** Ancienne config `sources[].mqtt.topicPrefix` → `prefixes[]` (dédoublonnés) ; les paramètres de
 *  connexion propres à chaque source sont abandonnés (connexion du socle désormais). */
function migrateLegacySources(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const config = raw as Record<string, unknown>;
  if (config.prefixes !== undefined || !Array.isArray(config.sources)) return raw;
  const prefixes = [...new Set(
    (config.sources as Array<{ mqtt?: { topicPrefix?: string } }>)
      .map((s) => (s?.mqtt?.topicPrefix ?? 'ha/').trim().replace(/^\/+|\/+$/g, ''))
      .filter((p) => p.length > 0)
  )];
  const { sources: _sources, ...rest } = config;
  return { ...rest, prefixes: prefixes.map((prefix) => ({ prefix })) };
}

// ============================================================================
// Schéma principal
// ============================================================================

export const nommageConfigSchema = z.preprocess(
  migrateLegacySources,
  z.object({
    // Préfixes de découverte écoutés (via la connexion MQTT du socle)
    prefixes: z.array(prefixEntrySchema).min(1).default([{ prefix: 'homeassist' }]),
    ha: haConfigSchema.default({}),
    logging: loggingConfigSchema.default({}),
    language: languageConfigSchema.default({})
  }).refine(
    (config) => new Set(config.prefixes.map((p) => p.prefix)).size === config.prefixes.length,
    { message: 'Chaque préfixe ne doit apparaître qu\'une fois', path: ['prefixes'] }
  )
);

/**
 * Topics de découverte écoutés pour un préfixe — format officiel HA
 * `<prefix>/<component>/[<node_id>/]<object_id>/config` (node_id optionnel → 2 formes), plus une
 * 3e forme à un niveau de plus pour rpigpio/mqtt-io, qui insère son bridgeInstance comme segment
 * supplémentaire (`prefix/bridgeInstance/component/node_id/object_id/config`, trouvé en conditions
 * réelles sur noisy2 le 14/09/2026). Patterns BORNÉS, jamais de joker `#` : un catch-all a déjà
 * provoqué un afflux de messages retenus non pertinents (crash serveur, voir historique).
 */
export function discoveryTopicsFor(prefix: string): string[] {
  return [`${prefix}/+/+/config`, `${prefix}/+/+/+/config`, `${prefix}/+/+/+/+/config`];
}

// ============================================================================
// Types TypeScript
// ============================================================================

export type NommageConfig = z.infer<typeof nommageConfigSchema>;
export type NommageHaConfig = z.infer<typeof haConfigSchema>;
export type NommageLoggingConfig = z.infer<typeof loggingConfigSchema>;
export type NommageLanguageConfig = z.infer<typeof languageConfigSchema>;

// ============================================================================
// Valeurs par défaut
// ============================================================================

export const DEFAULT_NOMMAGE_CONFIG: NommageConfig = {
  prefixes: [{ prefix: 'homeassist' }],
  ha: {
    injectTaxonomyAttributes: true,
    waitForHaWsBeforeDiscovery: true,
    forceLightForLumiere: true
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
