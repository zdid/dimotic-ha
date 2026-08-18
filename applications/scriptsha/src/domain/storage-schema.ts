/**
 * Schéma de stockage des scripts déposés — métadonnées dans un fichier YAML dédié
 * (scriptsha-scripts-v1.0.yaml, même convention que rpigpio-pins-v1.0.yaml), le contenu YAML brut
 * de chaque script vivant séparément dans data/scriptsha/scripts/<id>.yaml (voir ScriptsHaService).
 */

import { z } from 'zod';

export const scriptEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  originalFilename: z.string().min(1),
  deployed: z.boolean().default(false),
  deployedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

export type ScriptEntry = z.infer<typeof scriptEntrySchema>;

export const scriptsConfigSchema = z.object({
  scripts: z.array(scriptEntrySchema).default([])
});

export type ScriptsConfigFile = z.infer<typeof scriptsConfigSchema>;

export const DEFAULT_SCRIPTS_CONFIG: ScriptsConfigFile = { scripts: [] };
