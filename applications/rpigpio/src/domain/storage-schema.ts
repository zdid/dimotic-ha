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

  // ⭐ 13/09/2026 (bug réel trouvé en conditions réelles sur noisy — les 12 sorties basculaient à
  // un état électrique arbitraire à chaque redémarrage du conteneur mqtt-io, aucune persistance
  // entre config.yml/schéma jusqu'ici) : état logique ("on"/"off", pas "high"/"low" — mêmes
  // conventions que PAYLOAD_ON/PAYLOAD_OFF de gpiobridge.js) forcé au tout premier démarrage
  // (avant toute commande MQTT reçue). Traduit en `initial: high|low` selon `inverted` dans
  // generator.ts::buildPinEntry, voir son commentaire pour le second mécanisme complémentaire
  // (retain MQTT côté gpiobridge.js) qui couvre les redémarrages SUIVANTS. Optionnel : un pin sans
  // valeur ici garde le comportement mqtt-io par défaut (état électrique indéterminé au boot).
  initial: z.enum(['on', 'off']).optional(),

  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export type PinDefinition = z.infer<typeof pinDefinitionSchema>;

export const pinsConfigSchema = z.object({
  pins: z.array(pinDefinitionSchema).default([])
});

export type PinsConfigFile = z.infer<typeof pinsConfigSchema>;

export const DEFAULT_PINS_CONFIG: PinsConfigFile = { pins: [] };
