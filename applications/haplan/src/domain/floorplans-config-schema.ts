/**
 * Schéma de validation Zod pour le fichier de configuration centralisé des plans
 * config-haplan-floorplans-v1.0.yaml — même forme que le client-floorplans.json original de
 * haplanserver (positions normalisées 0-1, null tant que non placées).
 */

import { z } from 'zod';

export const haplanPositionSchema = z.object({
  entity_id: z.string().min(1),
  x: z.number().nullable(),
  y: z.number().nullable()
});

export const haplanFloorplanSchema = z.object({
  filename: z.string().min(1),
  positions: z.array(haplanPositionSchema).default([])
});

export const haplanFloorplansConfigSchema = z.object({
  floorplans: z.record(haplanFloorplanSchema).default({})
});

export type HaplanPositionEntry = z.infer<typeof haplanPositionSchema>;
export type HaplanFloorplanEntry = z.infer<typeof haplanFloorplanSchema>;
export type HaplanFloorplansConfigFile = z.infer<typeof haplanFloorplansConfigSchema>;

export const DEFAULT_FLOORPLANS_CONFIG: HaplanFloorplansConfigFile = {
  floorplans: {}
};
