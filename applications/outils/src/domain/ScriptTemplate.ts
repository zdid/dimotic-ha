/**
 * Stockage des scripts de la bibliothèque Outils — ⭐ 20/09/2026, remplace l'ancien schéma
 * (une entrée par script dans `data/outils/config.yaml`, contenu séparé dans
 * `data/outils/scripts/<id>.sh`, jamais dans le dépôt git donc jamais embarqué dans l'image
 * Docker). Chaque script est désormais un triplet de fichiers, dans l'une de deux arborescences
 * parallèles :
 *
 *   <root>/yaml/<id>.yaml      — métadonnées (voir outilScriptSchema, config-schema.ts)
 *   <root>/wrappers/<id>.sh    — le script proposé au téléchargement, variables `__NOM__` +
 *                                 commentaires `@outils:hint/select/checklist/default` dedans
 *                                 (mécanisme inchangé, voir detectVariables/detectVariableHints)
 *   <root>/scripts/            — bassin partagé de "moteurs" (fichiers réels référencés par des
 *                                 directives `@outils:bundle` — voir detectBundlePaths), PAS un
 *                                 fichier par id : un moteur peut être partagé par plusieurs
 *                                 wrappers (ex: flash-sd-card.js, utilisé par les deux phases
 *                                 SD card)
 *
 * `<root>` = soit `builtinRoot()` (applications/outils/reposcripts/, dans le dépôt git — survit à
 * `find ./applications -name '*.ts' -delete` dans le Dockerfile car ce ne sont pas des .ts, donc
 * présent dans l'image Docker sur toute machine qui la fait tourner, lecture seule côté app), soit
 * `dataRoot()` (data/outils/reposcripts/, gitignored comme le reste de data/, propre à chaque
 * machine — scripts ajoutés via le formulaire "Ajouter un script").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { outilScriptSchema, type OutilScriptConfig } from './config-schema';

/** applications/outils/reposcripts — deux niveaux au-dessus de dist/domain/. */
export function builtinRoot(): string {
  return path.join(__dirname, '..', '..', 'reposcripts');
}

/** data/outils/reposcripts — scripts ajoutés par l'utilisateur, propres à cette machine. */
export function dataRoot(): string {
  return path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'outils', 'reposcripts');
}

function yamlDir(root: string): string {
  return path.join(root, 'yaml');
}

function wrappersDir(root: string): string {
  return path.join(root, 'wrappers');
}

function enginesDir(root: string): string {
  return path.join(root, 'scripts');
}

/** Lit tous les `<id>.yaml` valides d'une arborescence — une entrée illisible/invalide est
 *  ignorée individuellement (pas de crash de toute la liste pour un fichier corrompu). */
export function listYamlScripts(root: string): OutilScriptConfig[] {
  const dir = yamlDir(root);
  if (!fs.existsSync(dir)) return [];
  const entries: OutilScriptConfig[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const raw = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
      entries.push(outilScriptSchema.parse(raw));
    } catch {
      // Fichier ignoré individuellement — ne doit pas empêcher l'affichage des autres scripts.
    }
  }
  return entries;
}

export function readWrapperContent(root: string, id: string): string {
  return fs.readFileSync(path.join(wrappersDir(root), `${id}.sh`), 'utf8');
}

export function writeWrapperContent(root: string, id: string, content: string): void {
  fs.mkdirSync(wrappersDir(root), { recursive: true });
  fs.writeFileSync(path.join(wrappersDir(root), `${id}.sh`), content, 'utf8');
}

export function writeYamlEntry(root: string, entry: OutilScriptConfig): void {
  fs.mkdirSync(yamlDir(root), { recursive: true });
  fs.writeFileSync(path.join(yamlDir(root), `${entry.id}.yaml`), yaml.dump(entry), 'utf8');
}

export function readYamlContent(root: string, id: string): string {
  return fs.readFileSync(path.join(yamlDir(root), `${id}.yaml`), 'utf8');
}

/** Retire le triplet yaml+wrapper d'un script (jamais appelé sur builtinRoot() — voir
 *  OutilsService.handleDeleteScript, qui refuse la suppression d'un script intégré). Le moteur
 *  partagé éventuel dans scripts/ n'est PAS supprimé : peut être référencé par d'autres scripts. */
export function deleteScriptFiles(root: string, id: string): void {
  const yamlPath = path.join(yamlDir(root), `${id}.yaml`);
  const wrapperPath = path.join(wrappersDir(root), `${id}.sh`);
  if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
  if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
}

/** Dépose un fichier moteur optionnel dans le bassin partagé scripts/ (ex: un .js référencé par
 *  une directive @outils:bundle du wrapper) — nom de fichier libre, pas lié à un id de script. */
export function writeEngineFile(root: string, filename: string, content: Buffer): void {
  fs.mkdirSync(enginesDir(root), { recursive: true });
  fs.writeFileSync(path.join(enginesDir(root), filename), content);
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
 *
 * ⭐ 20/09/2026 — décision explicite : reste dans le `.sh` (pas absorbé par le `<id>.yaml`, qui ne
 * porte que l'identité du script — titre/description/filename/sudo).
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
 *   # @outils:bundle applications/outils/reposcripts/scripts/flash-sd-card.js => scripts/flash-sd-card.js
 *   # @outils:bundle applications/outils/node_modules/js-yaml => node_modules/js-yaml
 *
 * Chaque chemin SOURCE est relatif à la racine du dépôt, copié tel quel (répertoires y compris,
 * symlinks déréférencés) dans l'archive. `=> <dest>` (optionnel) recompose l'arborescence attendue
 * par les scripts embarqués quand la source réelle ne vit pas déjà au bon chemin relatif — ⭐ bug
 * réel évité avant publication : une image Docker réelle (voir Dockerfile) ne contient PAS de
 * `node_modules/js-yaml` à la racine (seul un pnpm workspace de développement en a un) ; la seule
 * copie garantie présente en production est celle, propre, de `applications/outils/` (dépendance
 * déclarée dans son package.json) — d'où ce remap vers `node_modules/js-yaml`, le chemin que
 * `flash-sd-card.js` résout relativement à lui-même (`require('../node_modules/js-yaml')`),
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
