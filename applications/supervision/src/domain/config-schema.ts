/**
 * Configuration et sélection de SUPERVISION (fonctionnelles-supervision_specs §3bis, §4, §5).
 * Pas de page de paramétrage (v1.1) : la config (section `supervision`, data/supervision/config.yaml)
 * n'a que des valeurs par défaut, modifiables à la main.
 */

import { z } from 'zod';

export const supervisionConfigSchema = z.object({
  /** Annonce « périmée » au-delà de N périodes du gossip (core.appGossipIntervalSeconds). */
  staleAfterPeriods: z.coerce.number().int().min(2).max(100).default(3),
  /** Rafraîchissement automatique de l'état des sauvegardes. */
  backupRefreshMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  /** Délai de réponse de l'application sauvegarde. */
  backupTimeoutSec: z.coerce.number().int().min(10).max(600).default(60)
});

export type SupervisionConfig = z.infer<typeof supervisionConfigSchema>;

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const selectionMachineSchema = z.object({
  label: z.string().max(80).optional(),
  apps: z.array(z.string().regex(SAFE_ID)).default([])
});

export const selectionMachinesSchema = z.record(z.string().regex(SAFE_ID), selectionMachineSchema);

/** Sélection diffusée (§4) : remplacée ENTIÈRE à chaque modification, la plus récente l'emporte. */
export const selectionSchema = z.object({
  updatedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'date invalide'),
  updatedBy: z.string().max(64).default(''),
  machines: selectionMachinesSchema.default({})
});

export type Selection = z.infer<typeof selectionSchema>;
