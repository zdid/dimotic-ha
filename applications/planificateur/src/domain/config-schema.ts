/**
 * Schéma de configuration `planificateur` — section `planificateur` de data/config.yaml.
 * Pas de connexion MQTT propre (contrairement à EVOO7/Nommage) — voir specs §10.
 */

import { z } from 'zod';

export const planificateurConfigSchema = z.object({

  // Fichiers de données (relatifs à data/), voir specs §5
  macrosFile: z.string().min(1).default('planificateur-macros-v1.0.yaml'),
  planificationsFile: z.string().min(1).default('planificateur-planifications-v1.0.yaml'),

  // Délai d'attente de la réponse de `ia` quand planificateur lui demande d'évaluer une condition
  // en texte libre (planificateur:condition, ⭐ 24/09/2026 — seul échange restant dans ce sens ;
  // nom conservé pour ne pas invalider les config.yaml existants)
  deployTimeoutMs: z.number().int().positive().default(15000),

  // Reprise après coupure (voir SchedulerRuntime/StateWatcher) : au-delà de cette fenêtre, un
  // déclenchement dont l'heure cible est déjà passée au redémarrage est abandonné (marqué missed)
  // plutôt que déclenché tardivement.
  catchUpWindowSeconds: z.number().int().positive().default(300)
});

export type PlanificateurConfig = z.infer<typeof planificateurConfigSchema>;

export const DEFAULT_PLANIFICATEUR_CONFIG: PlanificateurConfig = {
  macrosFile: 'planificateur-macros-v1.0.yaml',
  planificationsFile: 'planificateur-planifications-v1.0.yaml',
  deployTimeoutMs: 15000,
  catchUpWindowSeconds: 300
};
