/**
 * Schéma de configuration `ia` — section `ia` de data/config.yaml. Voir specs §12.
 * Le routage multi-IA (§6) est hors scope de cette version (voir plan d'implémentation) — pas de
 * champs claude/gemini/chatgpt ici pour l'instant.
 */

import { z } from 'zod';

export const modelMapSchema = z.record(z.string()).default({
  mistral: 'mistral-small-latest',
  'mistral:latest': 'mistral-small-latest',
  'mistral-small': 'mistral-small-latest',
  'mistral-large': 'mistral-large-latest'
});

// Limites du plan Mistral en cours, PAR MODÈLE (constatées par l'utilisateur, 10/08/2026 — un
// modèle différent du même compte a des quotas indépendants, ex: mistral-large est nettement plus
// restreint que mistral-small) — throttling préventif (RateLimiter.ts, une instance par modèle
// dans MistralClient) en complément du backoff réactif sur 429. Non exposé dans la config UI
// générique (même précédent que modelMap ci-dessus, un record n'y est pas éditable) : à ajuster
// directement dans data/ia/config.yaml si le plan change.
export const mistralRateLimitSchema = z.object({
  requestsPerSecond: z.number().positive(),
  tokensPerMinute: z.number().int().positive()
});

export const mistralRateLimitsSchema = z.record(mistralRateLimitSchema).default({
  'mistral-small-latest': { requestsPerSecond: 1.67, tokensPerMinute: 100000 },
  'mistral-large-latest': { requestsPerSecond: 0.25, tokensPerMinute: 400000 }
});

export const iaConfigSchema = z.object({
  enabled: z.boolean().default(true),

  mistralApiKey: z.string().optional(),
  mistralBaseUrl: z.string().default('https://api.mistral.ai/v1'),
  defaultMistralModel: z.string().default('mistral-small-latest'),
  modelMap: modelMapSchema,
  mistralRateLimits: mistralRateLimitsSchema,

  ollamaHttpPort: z.number().int().positive().default(11434),

  // Chemin relatif à la racine de l'application (applications/ia/), sauf s'il est absolu — voir
  // IaService.resolveRulesPath()/ensureRulesFileSeeded(). Par défaut sous data/ia/ (pas
  // applications/ia/rules/, qui reste le modèle intégré utilisé pour amorcer ce fichier s'il
  // n'existe pas encore) : data/ est le seul répertoire monté/persistant en déploiement Docker
  // (voir techniques-socle-ha-mqtt_specs §11) — un fichier sous applications/ n'y serait pas
  // éditable sans reconstruire l'image.
  rulesFile: z.string().min(1).default('../../data/ia/regles_mistral.txt'),

  // Délais d'attente pour les échanges de corrélation avec planificateur
  commandTimeoutMs: z.number().int().positive().default(2000),
  toolExecuteTimeoutMs: z.number().int().positive().default(10000),

  // ⭐ Quoi exclus du catalogue quoi/lieux statique injecté dans le prompt système (rules.ts,
  // techniques-socle-ha-mqtt_specs §8.3.3) — demande utilisateur : certains quoi ne désignent pas
  // une cible adressable par une commande domotique (déclencheurs physiques, accessoires,
  // infrastructure technique), et leurs "lieux" ne sont souvent pas de vrais lieux non plus
  // (ex: "Télécommande 2" comme lieu, "1"-"4" comme numéro de bouton). Non exposé dans la config
  // UI générique — même précédent que modelMap/mistralRateLimits ci-dessus (pas de type de champ
  // "liste de chaînes" réellement implémenté côté ConfigForm.ts, seul le type "array" — objets
  // complexes — l'est) : à ajuster directement dans data/ia/config.yaml, rechargé à chaud
  // (IaService surveille ce fichier, même mécanisme que RulesProvider pour regles_mistral.txt).
  excludedQuoiIds: z.array(z.string()).default(['bouton', 'telecommande', 'scenes_switch', 'zigbee2mqtt_bridge'])
});

export type IaConfig = z.infer<typeof iaConfigSchema>;

export const DEFAULT_IA_CONFIG: IaConfig = {
  enabled: true,
  mistralBaseUrl: 'https://api.mistral.ai/v1',
  defaultMistralModel: 'mistral-small-latest',
  modelMap: {
    mistral: 'mistral-small-latest',
    'mistral:latest': 'mistral-small-latest',
    'mistral-small': 'mistral-small-latest',
    'mistral-large': 'mistral-large-latest'
  },
  mistralRateLimits: {
    'mistral-small-latest': { requestsPerSecond: 1.67, tokensPerMinute: 100000 },
    'mistral-large-latest': { requestsPerSecond: 0.25, tokensPerMinute: 400000 }
  },
  ollamaHttpPort: 11434,
  rulesFile: '../../data/ia/regles_mistral.txt',
  commandTimeoutMs: 2000,
  toolExecuteTimeoutMs: 10000,
  excludedQuoiIds: ['bouton', 'telecommande', 'scenes_switch', 'zigbee2mqtt_bridge']
};
