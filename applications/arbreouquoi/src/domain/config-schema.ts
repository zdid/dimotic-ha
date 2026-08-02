import { z } from 'zod';

// Schema de configuration pour l'application ArbreOuquoi
export const arbreouquoiConfigSchema = z.object({
  // Activation/désactivation
  enabled: z.boolean().default(true),
  
  // Options d'affichage
  display: z.object({
    expandAll: z.boolean().default(false),
    showEntityIds: z.boolean().default(true),
    showQuoiIcons: z.boolean().default(true),
    theme: z.enum(['light', 'dark', 'auto']).default('auto'),
    // Mode d'affichage : 'ou-first' (OÙ → QUOI) ou 'quoi-first' (QUOI → OÙ)
    viewMode: z.enum(['ou-first', 'quoi-first']).default('ou-first')
  }).default({}),
  
  // Options de rafraîchissement
  refresh: z.object({
    // Minuteur périodique CÔTÉ SERVEUR, indépendant du champ "auto-refresh-seconds" de la
    // toolbar (purement client, voir app.ts) — désactivé par défaut : refreshOnHaUpdate (push
    // réel sur changement HA) est le mécanisme normal, ce minuteur ne faisait que pousser des
    // mises à jour redondantes toutes les 30s sans qu'aucune UI ne permette de le désactiver,
    // donnant l'impression que "durée de rafraîchissement = 0" (champ client) était ignoré.
    autoRefreshEnabled: z.boolean().default(false),
    autoRefreshInterval: z.number().min(1000).max(300000).default(30000), // 30 secondes
    refreshOnHaUpdate: z.boolean().default(true)
  }).default({})
});

export type ArbreouquoiConfig = z.infer<typeof arbreouquoiConfigSchema>;
