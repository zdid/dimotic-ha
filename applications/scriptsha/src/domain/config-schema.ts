/**
 * Schéma de configuration pour l'application scriptsha — minimal, aucun réglage de connexion
 * propre (l'app ne parle jamais HA/MQTT directement, seulement via le pont générique HaRestBridge
 * du core, voir domain/index.ts).
 */

import { z } from 'zod';

export const scriptshaConfigSchema = z.object({
  enabled: z.boolean().default(true)
});

export type ScriptshaConfig = z.infer<typeof scriptshaConfigSchema>;

export const DEFAULT_SCRIPTSHA_CONFIG: ScriptshaConfig = {
  enabled: true
};
