/**
 * Détection Docker — posée une seule fois par `core` (voir index.ts), tôt dans son propre
 * bootstrap, avant que `ProcessSupervisor` ne lance la moindre application en process séparé.
 *
 * Pourquoi une variable d'environnement et pas un `global.*` JS : la plupart des applications
 * tournent dans leur PROPRE process Node (IPC, voir fonctionnelles-supervisor_specs v2.6) — un
 * `global.*` posé dans le process de `core` n'existe que dans ce process, invisible ailleurs.
 * `ProcessSupervisor.spawnChild()` ne passe aucun `env` explicite à `spawn()`, donc chaque enfant
 * hérite automatiquement de `process.env` du parent (comportement par défaut de Node) — cette
 * variable leur est donc transmise sans aucun code IPC supplémentaire, même mécanisme déjà utilisé
 * pour `PROJECT_ROOT` (voir index.ts).
 */

import * as fs from 'node:fs';

const ENV_VAR = 'DIMOTIC_RUNNING_IN_DOCKER';

/** À appeler une seule fois, tôt dans le bootstrap de `core` (avant tout spawn d'enfant). */
export function detectDockerEnvironment(): void {
  process.env[ENV_VAR] = fs.existsSync('/.dockerenv') ? 'true' : 'false';
}

/** Lit le résultat de `detectDockerEnvironment()` — utilisable par `core` ou toute app enfant. */
export function isRunningInDocker(): boolean {
  return process.env[ENV_VAR] === 'true';
}
