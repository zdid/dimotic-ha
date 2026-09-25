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
  // ⭐ 20/09/2026 — true si le script vient de applications/outils/reposcripts/ (dans le dépôt
  // git, embarqué dans l'image Docker, lecture seule côté app), false s'il a été ajouté par
  // l'utilisateur (data/outils/reposcripts/, propre à cette machine, supprimable).
  builtin: boolean;
}

export interface OutilsStatus {
  scripts: OutilScriptSummary[];
  /** ⭐ 25/09/2026 — pour l'exécution par SSH (spec §5.5) : machine locale (proposée dans la liste
   *  avec celles du gossip) et contexte du bloc de préparation `ssh-copy-id`. */
  localMachine: { machineId: string; address?: string };
  isRunningInDocker: boolean;
  projectRoot: string;
}

/** Réponse à `outils:script:get` — contenu complet + variables détectées, tout envoyé en une fois
 *  (pas de round-trip supplémentaire pour générer : la substitution se fait côté navigateur). */
export interface OutilScriptDetail extends OutilScriptSummary {
  /** ⭐ 25/09/2026 — présélection de l'exécution par SSH (champ `execution` du yaml). */
  execution?: { machine?: string; utilisateur?: string; dossier?: string };
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
  // ⭐ 20/09/2026 — contenu brut du <id>.yaml, pour le proposer en téléchargement séparé (voir
  // OutilScriptSummary.builtin/hasEngine) et pour le zip.
  yamlContent: string;
}

export interface AddScriptResult {
  success: boolean;
  error?: string;
}

/** Réponse à `outils:bundle:build` — le fichier réel est servi par la route HTTP générique
 *  GET /api/apps/outils/download/:token (voir PresentationServer), pas de contenu binaire ici. */
export interface BundleResult {
  success: boolean;
  token?: string;
  filename?: string;
  error?: string;
}

/** Réponse à `outils:zip:build` — même route de téléchargement générique que BundleResult (le
 *  fichier réel est un .zip, pas une archive auto-extractible tar+stub). */
export interface ZipResult {
  success: boolean;
  token?: string;
  filename?: string;
  error?: string;
}
