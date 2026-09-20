/**
 * Construit une archive auto-extractible pour un script Outils qui dépend de fichiers réels du
 * dépôt (voir ScriptTemplate.ts::detectBundlePaths) — ⭐ 18/09/2026, demande explicite suite à un
 * bug réel constaté : le script téléchargé seul ("flash-sd-card.sh") échouait hors d'un clone du
 * dépôt ("scripts/flash-sd-card.js introuvable"), alors que l'objectif de l'app est un script
 * téléchargeable et exécutable directement, sans dépôt cloné.
 *
 * Principe (technique standard des installeurs auto-extractibles shell, ex: makeself) : un seul
 * fichier `.sh` = un petit en-tête bash (extraction) + une archive .tar.gz brute collée après un
 * marqueur `__ARCHIVE_BELOW__`. `run.sh` (le script généré, variables déjà substituées côté
 * navigateur) + chaque chemin déclaré via `@outils:bundle` sont copiés tels quels (répertoires
 * inclus, symlinks déréférencés — nécessaire pour `node_modules/js-yaml`, un symlink pnpm) dans une
 * arborescence miroir de la racine du dépôt, pour que les scripts embarqués (qui résolvent leurs
 * propres chemins relativement à eux-mêmes ou via un repli `git rev-parse`) fonctionnent SANS
 * modification une fois extraits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import archiver from 'archiver';
import type { BundlePath } from './ScriptTemplate';

function repoRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

export function downloadsDir(): string {
  return path.join(repoRoot(), 'data', 'outils', 'tmp', 'downloads');
}

export interface BuiltBundle {
  token: string;
  filename: string;
}

/** Copie `content` (nommé `runName`) + chaque `bundlePaths` dans un répertoire temporaire, miroir
 *  de la racine du dépôt — partagé par buildBundle() (archive auto-extractible) et buildZip()
 *  (.zip brut), seule la mise en forme finale diffère. Appelant responsable du nettoyage. */
function stageFiles(content: string, runName: string, bundlePaths: BundlePath[]): string {
  const root = repoRoot();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outils-bundle-'));
  fs.writeFileSync(path.join(stagingDir, runName), content, { mode: 0o755 });

  for (const { src: relSrc, dest: relDest } of bundlePaths) {
    const src = path.join(root, relSrc);
    if (!fs.existsSync(src)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Chemin déclaré par @outils:bundle introuvable: ${relSrc} (racine résolue: ${root})`);
    }
    const dest = path.join(stagingDir, relDest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // dereference: true — au cas où la source soit un symlink (ex: pnpm en dev).
    fs.cpSync(src, dest, { recursive: true, dereference: true });
  }

  return stagingDir;
}

export function buildBundle(content: string, bundlePaths: BundlePath[], outputFilename: string): BuiltBundle {
  const token = crypto.randomBytes(16).toString('hex');
  const stagingDir = stageFiles(content, 'run.sh', bundlePaths);
  const tarPath = path.join(os.tmpdir(), `outils-bundle-${token}.tar.gz`);

  try {
    execFileSync('tar', ['czf', tarPath, '-C', stagingDir, '.']);

    // Marqueur ancré en début de ligne (^) : awk s'arrête dès qu'il le trouve, avant d'avoir à
    // interpréter l'archive binaire qui suit comme du texte (exit immédiat, voir plus bas).
    //
    // ⭐ 18/09/2026, bug réel évité avant publication — EXTRACT_DIR ne doit PAS être un `mktemp -d`
    // recréé (et détruit) à chaque exécution : ce script fait partie d'une paire en 2 phases
    // (préparation puis flashage, voir prepare-sd-card.sh/flash-sd-card.sh) qui doivent retrouver le
    // MÊME dossier — en particulier `data/.sd-card-image-cache/prepared/<machine>.img`, écrit par la
    // phase 1 et relu par la phase 2. Emplacement fixe (XDG cache, pas de sudo requis pour l'écrire),
    // jamais supprimé automatiquement — l'utilisateur peut le vider lui-même s'il le souhaite.
    // L'extraction (`tar xz`, sans --delete) n'écrase que les fichiers PRÉSENTS dans l'archive,
    // jamais un fichier généré au runtime par une phase précédente (ex: l'image déjà préparée).
    const stub = [
      '#!/bin/bash',
      '# Archive auto-extractible générée par l\'app Outils (dimotic-ha) — voir BundleBuilder.ts.',
      'set -eo pipefail',
      'ARCHIVE_LINE=$(awk \'/^__ARCHIVE_BELOW__$/{print NR + 1; exit 0}\' "$0")',
      // ⭐ 18/09/2026, bug réel corrigé — `sudo bash ce-script.sh` (tout en root dès le départ, un
      // réflexe naturel pour un script qui a besoin de privilèges) fait pointer $HOME vers /root,
      // donc un dossier de cache DIFFÉRENT de celui utilisé par la phase précédente lancée sans
      // sudo global (privilège pris seulement à l'intérieur, via `sudo node ...`) — le profil
      // persisté entre les deux phases devient introuvable. Toujours résoudre le VRAI utilisateur
      // (SUDO_USER, déjà root ou pas) plutôt que $HOME brut, pour que les deux façons de lancer le
      // script retombent sur le même dossier.
      'if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then',
      '  REAL_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"',
      'else',
      '  REAL_HOME="$HOME"',
      'fi',
      'EXTRACT_DIR="${XDG_CACHE_HOME:-$REAL_HOME/.cache}/dimotic-ha-outils"',
      'mkdir -p "$EXTRACT_DIR"',
      'echo "Extraction dans $EXTRACT_DIR (dossier fixe, réutilisé par les autres scripts de cette paire)..."',
      'tail -n +"$ARCHIVE_LINE" "$0" | tar xz -C "$EXTRACT_DIR"',
      'cd "$EXTRACT_DIR"',
      'chmod +x run.sh',
      'exec bash run.sh "$@"',
      '__ARCHIVE_BELOW__',
      ''
    ].join('\n');

    fs.mkdirSync(downloadsDir(), { recursive: true });
    const outputPath = path.join(downloadsDir(), token);
    const tarBuffer = fs.readFileSync(tarPath);
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from(stub, 'utf8'), tarBuffer]), { mode: 0o755 });
    fs.writeFileSync(`${outputPath}.meta.json`, JSON.stringify({ filename: outputFilename }));

    return { token, filename: outputFilename };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(tarPath, { force: true });
  }
}

/**
 * ⭐ 20/09/2026, demande explicite — alternative "à plat" à buildBundle() : un .zip ordinaire
 * plutôt qu'une archive auto-extractible, pour qui préfère l'extraire lui-même. Mêmes fichiers que
 * l'archive auto-extractible (`runName` + les dépendances `@outils:bundle`), `extraFiles` en plus
 * (ex: le `<id>.yaml` du script, absent de bundlePaths car ce n'est pas une dépendance déclarée
 * dans le `.sh` — juste un fichier à ajouter tel quel dans le zip).
 */
export function buildZip(
  content: string,
  runName: string,
  bundlePaths: BundlePath[],
  extraFiles: Record<string, string>,
  outputFilename: string
): Promise<BuiltBundle> {
  const token = crypto.randomBytes(16).toString('hex');
  const stagingDir = stageFiles(content, runName, bundlePaths);
  for (const [name, text] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(stagingDir, name), text, 'utf8');
  }

  return new Promise((resolve, reject) => {
    fs.mkdirSync(downloadsDir(), { recursive: true });
    const outputPath = path.join(downloadsDir(), token);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.writeFileSync(`${outputPath}.meta.json`, JSON.stringify({ filename: outputFilename }));
      resolve({ token, filename: outputFilename });
    });
    archive.on('error', (error) => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    archive.pipe(output);
    archive.directory(stagingDir, false);
    void archive.finalize();
  });
}
