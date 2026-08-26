/**
 * Chargement + amorçage + surveillance à chaud des fichiers YAML de l'interpréteur
 * (`vocabulaire_interpreteur.yaml`/`gabarits_interpreteur.yaml`) — même convention que
 * `RulesProvider`/`regles_mistral.txt` (`applications/ia/src/domain/rules.ts`) : fichier vivant
 * sous `data/ia/`, amorcé depuis un modèle intégré au premier démarrage, jamais écrasé ensuite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { GabaritDef, Vocabulaire } from './types';

export function ensureSeeded(targetPath: string, templatePath: string): void {
  if (targetPath === templatePath || fs.existsSync(targetPath) || !fs.existsSync(templatePath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(templatePath, targetPath);
}

export function loadVocabulaire(filePath: string): Vocabulaire {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) as Partial<Vocabulaire> | undefined;
  return {
    verbeGroupes: raw?.verbeGroupes ?? {},
    enums: raw?.enums ?? {},
    motsIgnores: raw?.motsIgnores ?? [],
    separateurs: raw?.separateurs ?? []
  };
}

export function loadGabarits(filePath: string): Record<string, GabaritDef> {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8')) as { gabarits?: Record<string, GabaritDef> } | undefined;
  return raw?.gabarits ?? {};
}

/** Surveille un fichier et rappelle `onChange` (qui doit recharger) à chaque modification —
 *  identique dans l'esprit à `RulesProvider.load()`/`.watcher`, mais générique pour être réutilisé
 *  par les deux fichiers de l'interpréteur sans dupliquer la logique de watch. */
export function watchFile(filePath: string, onChange: () => void): fs.FSWatcher | undefined {
  try {
    return fs.watch(filePath, onChange);
  } catch {
    return undefined;
  }
}
