/**
 * Schéma de validation Zod pour le fichier de configuration centralisé des plans
 * config-haplan-floorplans-v1.0.yaml — même forme que le client-floorplans.json original de
 * haplanserver (positions normalisées 0-1, null tant que non placées).
 *
 * ⭐ 07-08/09/2026, extension "texte libre" (fonctionnelles-haplan_specs v1.7) :
 * - `texts[]` : éléments de texte libre positionnés comme les entités, mais sans entity_id HA —
 *   jamais suivis/commandables (voir HaplanService.trackedEntityIds, qui ne parcourt que
 *   `positions`).
 * - `filename` reste OBLIGATOIRE (⭐ 08/09/2026, correction de conception explicite de
 *   l'utilisateur — premier essai avec `filename` optionnel abandonné) : une "page libre" est une
 *   image unie générée à la création (voir HaplanService.handleFloorplanCreate,
 *   createBlankBackgroundPng), pas un cas spécial "pas d'image" propagé dans tout le code
 *   (FloorPlan.ts, HaplanService.ts, lovelace-generator.ts) — chaque plan a donc TOUJOURS un vrai
 *   fichier, même chemin de traitement partout, seuls les textes sont réellement nouveaux.
 */

import { z } from 'zod';

export const haplanPositionSchema = z.object({
  entity_id: z.string().min(1),
  x: z.number().nullable(),
  y: z.number().nullable()
});

export const haplanTextSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  x: z.number(),
  y: z.number(),
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  color: z.string().min(1).default('#FFFFFF')
});

export const haplanFloorplanSchema = z.object({
  filename: z.string().min(1),
  positions: z.array(haplanPositionSchema).default([]),
  texts: z.array(haplanTextSchema).default([])
});

export const haplanFloorplansConfigSchema = z.object({
  floorplans: z.record(haplanFloorplanSchema).default({})
});

export type HaplanPositionEntry = z.infer<typeof haplanPositionSchema>;
export type HaplanTextEntry = z.infer<typeof haplanTextSchema>;
export type HaplanFloorplanEntry = z.infer<typeof haplanFloorplanSchema>;
export type HaplanFloorplansConfigFile = z.infer<typeof haplanFloorplansConfigSchema>;

export const DEFAULT_FLOORPLANS_CONFIG: HaplanFloorplansConfigFile = {
  floorplans: {}
};
