/**
 * Fichiers éditables à DEUX niveaux — specs ia v1.16 §12bis.
 *
 *   data/ia/modele_integre/<fichier>  copie de la version EMBARQUÉE dans l'image/le code, réécrite à
 *                                     chaque démarrage (jamais à modifier : toute mise à jour de
 *                                     l'application la renouvelle) ;
 *   data/ia/personnalise/<fichier>    version modifiée par l'utilisateur, jamais touchée par le code.
 *
 * Version utilisée = la personnalisée si elle existe, sinon la copie de l'embarquée. Avant, le modèle
 * était copié UNE fois vers data/ia/ puis jamais renouvelé : une mise à jour des règles n'atteignait
 * jamais une installation déjà démarrée.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../../core/dist/exports';

export const BUILTIN_DIR = 'modele_integre';
export const CUSTOM_DIR = 'personnalise';

export interface LayeredFile {
  /** Nom du fichier, identique dans les deux dossiers (et dans l'ancien emplacement data/ia/). */
  name: string;
  /** Version embarquée dans le code. */
  templatePath: string;
  /** data/ia/modele_integre/<name> */
  builtinPath: string;
  /** data/ia/personnalise/<name>, ou un chemin explicite choisi par l'utilisateur. */
  customPath: string;
  /** data/ia/<name> — ancien emplacement unique (avant v1.16). */
  legacyPath: string;
}

export function layeredFile(dataDir: string, name: string, templatePath: string, customPathOverride?: string): LayeredFile {
  return {
    name,
    templatePath,
    builtinPath: path.join(dataDir, BUILTIN_DIR, name),
    customPath: customPathOverride ?? path.join(dataDir, CUSTOM_DIR, name),
    legacyPath: path.join(dataDir, name)
  };
}

/** Fichier réellement utilisé : personnalisé s'il existe, sinon copie de l'embarqué (à défaut, l'embarqué lui-même). */
export function effectivePath(file: LayeredFile): string {
  if (fs.existsSync(file.customPath)) return file.customPath;
  if (fs.existsSync(file.builtinPath)) return file.builtinPath;
  return file.templatePath;
}

export function isCustomized(file: LayeredFile): boolean {
  return fs.existsSync(file.customPath);
}

function sameContent(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * À appeler à chaque démarrage, AVANT de lire les fichiers :
 *  1. renouvelle la copie de la version embarquée (seulement si son contenu diffère) ;
 *  2. reprend l'ancien fichier unique data/ia/<name> : identique à l'embarqué actuel → c'était une
 *     copie intacte, retirée (la version embarquée est utilisée) ; différent → déplacé vers
 *     personnalise/ (jamais perdu — il peut contenir des modifications), avec un avertissement car
 *     ce peut aussi être une copie intacte d'une version plus ancienne.
 */
export function prepareLayeredFile(file: LayeredFile, logger: Logger): void {
  try {
    if (fs.existsSync(file.templatePath) && file.templatePath !== file.builtinPath) {
      if (!sameContent(file.templatePath, file.builtinPath)) {
        fs.mkdirSync(path.dirname(file.builtinPath), { recursive: true });
        fs.copyFileSync(file.templatePath, file.builtinPath);
        logger.info('LayeredFiles', `${file.name} : copie de la version embarquée renouvelée (${file.builtinPath})`);
      }
    }

    if (fs.existsSync(file.legacyPath) && file.legacyPath !== file.customPath) {
      if (sameContent(file.legacyPath, file.templatePath)) {
        fs.rmSync(file.legacyPath);
        logger.info('LayeredFiles', `${file.name} : ancien fichier identique à la version embarquée — retiré (version embarquée utilisée)`);
      } else if (!fs.existsSync(file.customPath)) {
        fs.mkdirSync(path.dirname(file.customPath), { recursive: true });
        fs.renameSync(file.legacyPath, file.customPath);
        logger.warn(
          'LayeredFiles',
          `${file.name} : ancien fichier différent de la version embarquée — conservé comme version personnalisée (${file.customPath}). ` +
          `Si vous ne l'avez jamais modifié, supprimez-le pour suivre la version embarquée.`
        );
      } else {
        logger.warn('LayeredFiles', `${file.name} : ancien fichier ${file.legacyPath} ignoré (une version personnalisée existe déjà) — à supprimer`);
      }
    }
  } catch (error) {
    logger.error('LayeredFiles', `${file.name} : préparation impossible : ${error}`);
  }
}

/**
 * Surveille les deux niveaux (création, modification ET suppression de la version personnalisée
 * rebasculent sur la bonne version) — par dossier, filtré sur le nom : un remplacement par rename
 * (la plupart des éditeurs) rendrait un watch posé sur le fichier lui-même sourd. Anti-rebond.
 */
export function watchLayered(file: LayeredFile, onChange: () => void, debounceMs = 300): Array<fs.FSWatcher> {
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const target of [file.customPath, file.builtinPath]) {
    const dir = path.dirname(target);
    const name = path.basename(target);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, (_event, filename) => {
        if (filename !== null && filename.toString() !== name) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          onChange();
        }, debounceMs);
      });
      watcher.on('close', () => { if (timer) clearTimeout(timer); });
      watchers.push(watcher);
    } catch {
      // dossier non surveillable : le rechargement à chaud de ce niveau est simplement absent
    }
  }
  return watchers;
}
