// Source de vérité unique — voir ScriptTemplate.ts (⭐ 18/09/2026 : ce fichier avait sa propre
// définition dupliquée, divergée de celle de ScriptTemplate.ts, ex: `default` manquant ici).
import type { VariableHint } from './ScriptTemplate';
export type { VariableHint };

export interface OutilScriptSummary {
  id: string;
  title: string;
  description: string;
  filename: string;
  requiresSudo: boolean;
}

export interface OutilsStatus {
  scripts: OutilScriptSummary[];
}

/** Réponse à `outils:script:get` — contenu complet + variables détectées, tout envoyé en une fois
 *  (pas de round-trip supplémentaire pour générer : la substitution se fait côté navigateur). */
export interface OutilScriptDetail extends OutilScriptSummary {
  content: string;
  variables: string[];
  // Directives `# @outils:select|checklist|hint|default` détectées — voir ScriptTemplate.ts.
  variableHints: Record<string, VariableHint>;
  // ⭐ 18/09/2026 — présence d'au moins une directive `@outils:bundle` : le client doit générer via
  // `outils:bundle:build` (archive auto-extractible) plutôt que télécharger `content` directement.
  hasBundling: boolean;
  // ⭐ 19/09/2026, demande explicite — dernières valeurs saisies pour ce script (persistées dans
  // un fichier, voir ScriptValues.ts), pour préremplir le formulaire sans tout ressaisir. Prime sur
  // `variableHints[x].default` côté client (voir app.ts) — l'historique réel de l'utilisateur est
  // plus pertinent qu'un défaut générique déclaré par le script.
  savedValues: Record<string, string>;
}

export interface AddScriptResult {
  success: boolean;
  error?: string;
}

/** Réponse à `outils:bundle:build` — le fichier réel est servi par la route HTTP générique
 *  `GET /api/apps/outils/download/:token` (voir PresentationServer), pas par Socket.io. */
export interface BundleResult {
  success: boolean;
  token?: string;
  filename?: string;
  error?: string;
}
