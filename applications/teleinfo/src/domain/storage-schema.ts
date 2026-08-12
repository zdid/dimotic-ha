/**
 * Schéma de stockage des 2 compteurs — fichier YAML dédié (teleinfo-compteurs-v1.0.yaml), même
 * convention que planificateur/rpigpio (fichier de données séparé du config.yaml applicatif).
 *
 * Exactement 2 compteurs, jamais plus ni moins : contrainte physique de la bascule GPIO (une seule
 * ligne série, 2 positions possibles) — voir device-agent/gpio-switch.js.
 */

import { z } from 'zod';

export const compteurDefinitionSchema = z.object({
  // Numéro de série du compteur (étiquette ADCO de la trame téléinfo) — identifie sans ambiguïté
  // quel compteur a répondu, indépendamment du timing de la bascule GPIO.
  adco: z.number().int().positive(),

  quoi: z.string().min(1),
  lieuPrecis: z.string().optional(),
  lieu: z.string().min(1),
  lieuPere: z.string().optional(),
  lieuGrandPere: z.string().optional()
});

export type CompteurDefinition = z.infer<typeof compteurDefinitionSchema>;

export const compteursConfigSchema = z.object({
  compteurs: z.array(compteurDefinitionSchema).max(2).default([])
});

export type CompteursConfigFile = z.infer<typeof compteursConfigSchema>;

export const DEFAULT_COMPTEURS_CONFIG: CompteursConfigFile = { compteurs: [] };
