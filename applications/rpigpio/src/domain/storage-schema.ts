/**
 * Schéma de stockage des définitions de pins GPIO — fichier YAML dédié (rpigpio-pins-v1.0.yaml),
 * même convention que planificateur (macros/planifications dans des fichiers séparés du
 * config.yaml, voir PlanificateurService.ts).
 */

import { z } from 'zod';

// Taxonomie QUOI/OÙ — mêmes niveaux que nommage (ParsedTaxonomy.ou), lieu seul obligatoire.
export const pinDefinitionSchema = z.object({
  id: z.string().min(1),

  quoi: z.string().min(1),
  lieuPrecis: z.string().optional(),
  lieu: z.string().min(1),
  lieuPere: z.string().optional(),
  lieuGrandPere: z.string().optional(),

  // Numérotation BCM (module "raspberrypi" de mqtt-io) — voir generator.ts.
  pin: z.number().int().min(0),

  direction: z.enum(['input', 'output']),

  // "low" est considéré actif quand inverted=true (voir generator.ts et doc mqtt-io ha_discovery).
  inverted: z.boolean().default(false),

  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export type PinDefinition = z.infer<typeof pinDefinitionSchema>;

export const pinsConfigSchema = z.object({
  pins: z.array(pinDefinitionSchema).default([])
});

export type PinsConfigFile = z.infer<typeof pinsConfigSchema>;

export const DEFAULT_PINS_CONFIG: PinsConfigFile = { pins: [] };
