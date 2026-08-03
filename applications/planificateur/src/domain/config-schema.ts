/**
 * Schéma de configuration `planificateur` — section `planificateur` de data/config.yaml.
 * Pas de connexion MQTT propre (contrairement à EVOO7/Nommage) — voir specs §10.
 */

import { z } from 'zod';

export const planificateurConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // Fichiers de données (relatifs à data/), voir specs §5
  macrosFile: z.string().min(1).default('planificateur-macros-v1.0.yaml'),
  planificationsFile: z.string().min(1).default('planificateur-planifications-v1.0.yaml'),

  // Délai d'attente pour les échanges de corrélation avec `ia` (ia:command, ia:tool:execute
  // n'attendent pas de réponse de planificateur : c'est l'inverse ici, planificateur attend `ia`
  // pour planificateur:deploy)
  deployTimeoutMs: z.number().int().positive().default(15000),

  // Reprise après coupure (voir SchedulerRuntime/StateWatcher) : au-delà de cette fenêtre, un
  // déclenchement dont l'heure cible est déjà passée au redémarrage est abandonné (marqué missed)
  // plutôt que déclenché tardivement.
  catchUpWindowSeconds: z.number().int().positive().default(300)
});

export type PlanificateurConfig = z.infer<typeof planificateurConfigSchema>;

export const DEFAULT_PLANIFICATEUR_CONFIG: PlanificateurConfig = {
  enabled: true,
  macrosFile: 'planificateur-macros-v1.0.yaml',
  planificationsFile: 'planificateur-planifications-v1.0.yaml',
  deployTimeoutMs: 15000,
  catchUpWindowSeconds: 300
};
