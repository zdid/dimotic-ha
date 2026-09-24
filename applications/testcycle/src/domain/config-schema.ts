/**
 * Configuration de l'application de test du cycle de vie — section `testcycle` de
 * data/testcycle/config.yaml, éditée dans Paramètres Techniques (3 champs, demande du 24/09/2026).
 */

import { z } from 'zod';

/**
 * Modes de panne volontaires, pour éprouver ce que fait le core quand une application
 * se comporte mal :
 * - `aucun` : fonctionnement normal.
 * - `demarrage` : plante immédiatement au démarrage (backoff, état « crashed », désactivation
 *   pendant l'attente de relance).
 * - `apres30s` : plante 30 s après le démarrage (crash en cours de route, nettoyage MQTT).
 * - `ignoreSigterm` : ignore SIGTERM à la désactivation (SIGKILL de secours, arrêt non propre).
 */
export const CRASH_MODES = ['aucun', 'demarrage', 'apres30s', 'ignoreSigterm'] as const;
export type CrashMode = typeof CRASH_MODES[number];

export const testcycleConfigSchema = z.object({
  haEntity: z.string().default('sun.sun'),
  publishIntervalSec: z.coerce.number().int().min(2).max(3600).default(10),
  crashMode: z.enum(CRASH_MODES).default('aucun')
});

export type TestcycleConfig = z.infer<typeof testcycleConfigSchema>;

/** Données saisies sur la page de l'application (3 champs), fichier data/testcycle/donnees.yaml. */
export const testcycleDonneesSchema = z.object({
  message: z.string().default('Bonjour'),
  valeurDepart: z.coerce.number().default(0),
  publicationActive: z.boolean().default(true)
});

export type TestcycleDonnees = z.infer<typeof testcycleDonneesSchema>;
