import { z } from 'zod';

// Schema de configuration pour l'application ArbreOuquoi
// ⭐ 06/09/2026 — pas de champ `enabled` ici : l'activation réelle d'une application passe
// exclusivement par `core.disabledApps` (Paramètres Techniques > Gestion des applications) — un
// champ `enabled` par app n'était lu nulle part dans le code, jamais consulté (trouvé en auditant
// les 13 apps pour la duplication de paramètres entre machines).
export const arbreouquoiConfigSchema = z.object({
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
