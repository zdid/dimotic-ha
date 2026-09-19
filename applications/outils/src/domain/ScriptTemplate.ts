/**
 * Stockage du contenu des scripts (fichiers `.sh` séparés de config.yaml, voir config-schema.ts)
 * et détection des variables `__NOM__` — même convention que
 * `applications/sauvegarde/src/domain/BackupScript.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function scriptsDir(): string {
  return path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'outils', 'scripts');
}

function scriptFilePath(id: string): string {
  return path.join(scriptsDir(), `${id}.sh`);
}

export function readScriptContent(id: string): string {
  return fs.readFileSync(scriptFilePath(id), 'utf8');
}

export function writeScriptContent(id: string, content: string): void {
  fs.mkdirSync(scriptsDir(), { recursive: true });
  fs.writeFileSync(scriptFilePath(id), content, 'utf8');
}

export function deleteScriptContent(id: string): void {
  const filePath = scriptFilePath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/**
 * Détecte les jetons `__NOM__` (majuscules/chiffres/underscore) dans le contenu d'un script — pas
 * de déclaration séparée des variables (⭐ 18/09/2026, demande explicite : garder ça simple, un
 * script est juste un fichier .sh, pas un schéma à maintenir en plus). Résultat dédupliqué, ordre
 * de première apparition dans le fichier (ordre plus prévisible pour l'utilisateur qui lit le
 * script que l'ordre alphabétique).
 */
export function detectVariables(content: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const regex = /__([A-Z][A-Z0-9_]*)__/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

/** "TARGET_HOST" -> "Target host" — libellé de formulaire par défaut pour une variable détectée. */
export function humanizeVariableLabel(token: string): string {
  const lower = token.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export type VariableHint =
  | { type: 'select'; options: string[]; help?: string; default?: string }
  | { type: 'checklist'; options: string[]; help?: string }
  | { type: 'text'; help?: string; default?: string };

/**
 * ⭐ 18/09/2026, demande explicite — "ce sera dans le script lui-même que c'est une liste, pas
 * dans l'application" : une variable peut se déclarer comme liste déroulante (un seul choix) ou
 * liste à cocher (plusieurs choix, valeurs jointes par des virgules à la génération — pratique pour
 * une variable déjà consommée comme liste séparée par des virgules, ex. `packages: [__PACKAGES__]`)
 * via une ligne de commentaire dédiée n'importe où dans le script — jamais une déclaration séparée
 * à maintenir côté application, le script reste la seule source de vérité sur lui-même :
 *
 *   # @outils:select PI_MODEL = Raspberry Pi 3, Raspberry Pi 4, Raspberry Pi 5
 *   # @outils:checklist PACKAGES = git, vim, htop
 *   # @outils:hint MACHINE = Nom libre affiché dans les journaux, aucune diffusion.
 *   # @outils:default DISTRO = trixie-lite
 *
 * Une variable sans directive reste un simple champ texte (comportement par défaut, inchangé).
 * `default` (⭐ 18/09/2026) préremplit un champ texte ou présélectionne une option d'un `select` —
 * sans objet pour un `checklist` (rien à présélectionner par défaut pour l'instant).
 */
export function detectVariableHints(content: string): Record<string, VariableHint> {
  const hints: Record<string, VariableHint> = {};

  const choiceRegex = /^#\s*@outils:(select|checklist)\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = choiceRegex.exec(content)) !== null) {
    const kind = match[1] as 'select' | 'checklist';
    const name = match[2];
    const options = match[3].split(',').map((o) => o.trim()).filter(Boolean);
    hints[name] = { type: kind, options };
  }

  const hintRegex = /^#\s*@outils:hint\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm;
  while ((match = hintRegex.exec(content)) !== null) {
    const name = match[1];
    const help = match[2].trim();
    const existing = hints[name];
    if (existing) {
      existing.help = help;
    } else {
      hints[name] = { type: 'text', help };
    }
  }

  const defaultRegex = /^#\s*@outils:default\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm;
  while ((match = defaultRegex.exec(content)) !== null) {
    const name = match[1];
    const value = match[2].trim();
    const existing = hints[name];
    if (existing && existing.type !== 'checklist') {
      existing.default = value;
    } else if (!existing) {
      hints[name] = { type: 'text', default: value };
    }
  }

  return hints;
}

export interface BundlePath {
  /** Chemin réel à lire, relatif à la racine du dépôt (process.env.PROJECT_ROOT/cwd — voir
   *  BundleBuilder.ts). C'est cette racine qui diffère entre dev (checkout git complet, pnpm
   *  workspace) et un conteneur Docker réel (seuls tsconfig.json/docker/applications sont copiés
   *  par le Dockerfile, voir plus bas) — d'où le besoin de `dest` pour recomposer, dans l'archive,
   *  l'arborescence attendue par les scripts embarqués même quand la SOURCE réelle vit ailleurs. */
  src: string;
  /** Chemin de destination DANS l'archive, relatif à sa racine (là où vit `run.sh`). Par défaut
   *  identique à `src` (cas le plus courant : la source vit déjà au bon endroit relatif). */
  dest: string;
}

/**
 * ⭐ 18/09/2026, demande explicite — un script qui dépend de fichiers RÉELS du dépôt (autre script,
 * module npm, clé, gabarit...) le déclare lui-même, pour permettre à l'app de construire une archive
 * auto-extractible autonome (le fichier téléchargé sinon échoue hors d'un clone du dépôt — bug réel
 * constaté : "scripts/flash-sd-card.js introuvable" quand le script est lancé depuis Téléchargements) :
 *
 *   # @outils:bundle scripts/flash-sd-card.js
 *   # @outils:bundle applications/outils/node_modules/js-yaml => node_modules/js-yaml
 *
 * Chaque chemin SOURCE est relatif à la racine du dépôt, copié tel quel (répertoires y compris,
 * symlinks déréférencés) dans l'archive. `=> <dest>` (optionnel) recompose l'arborescence attendue
 * par les scripts embarqués quand la source réelle ne vit pas déjà au bon chemin relatif — ⭐ bug
 * réel évité avant publication : une image Docker réelle (voir Dockerfile) ne contient PAS de
 * `node_modules/js-yaml` à la racine (seul un pnpm workspace de développement en a un) ; la seule
 * copie garantie présente en production est celle, propre, de `applications/outils/` (dépendance
 * déclarée dans son package.json) — d'où ce remap vers `node_modules/js-yaml`, le chemin que
 * `scripts/flash-sd-card.js` résout relativement à lui-même (`require('../node_modules/js-yaml')`),
 * quelle que soit la racine réelle d'où la source a été lue.
 *
 * Un script SANS directive `@outils:bundle` reste un simple téléchargement direct d'un seul fichier
 * (comportement historique, inchangé) — l'archive n'est construite que si au moins un chemin est
 * déclaré.
 */
export function detectBundlePaths(content: string): BundlePath[] {
  const paths: BundlePath[] = [];
  const seen = new Set<string>();
  const regex = /^#\s*@outils:bundle\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    const arrowIdx = raw.indexOf('=>');
    const src = (arrowIdx === -1 ? raw : raw.slice(0, arrowIdx)).trim();
    const dest = (arrowIdx === -1 ? raw : raw.slice(arrowIdx + 2)).trim();
    const key = `${src}=>${dest}`;
    if (src && !seen.has(key)) {
      seen.add(key);
      paths.push({ src, dest });
    }
  }
  return paths;
}
