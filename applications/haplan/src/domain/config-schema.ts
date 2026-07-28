/**
 * Schéma de configuration HAPLAN — section `haplan` de data/haplan/config.yaml.
 * Paramètres généraux uniquement — les plans/positions sont dans
 * config-haplan-floorplans-v1.0.yaml (voir floorplans-config-schema.ts). Pas de section MQTT :
 * cette app ne publie pas de découverte, elle lit/écrit directement via HaWsClient (voir
 * HaplanService, requiredHaWs: true).
 */

import { z } from 'zod';

export const haplanConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // Fichier de configuration des plans/positions, relatif à data/haplan/
  floorplansConfigFile: z.string().min(1).default('config-haplan-floorplans-v1.0.yaml')
});

export type HaplanConfig = z.infer<typeof haplanConfigSchema>;

export const DEFAULT_HAPLAN_CONFIG: HaplanConfig = {
  enabled: true,
  floorplansConfigFile: 'config-haplan-floorplans-v1.0.yaml'
};
