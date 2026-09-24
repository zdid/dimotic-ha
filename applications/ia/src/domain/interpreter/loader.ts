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
 *  par les deux fichiers de l'interpréteur et `data/ia/config.yaml` sans dupliquer la logique.
 *
 *  ⭐ 24/09/2026 — surveille le DOSSIER parent, filtré sur le nom du fichier : un `fs.watch` posé
 *  sur le fichier lui-même suit son inode et devient sourd dès que le fichier est remplacé par
 *  rename (ConfigWriter tmp → rename, la plupart des éditeurs) — vérifié : 5 enregistrements, 3
 *  événements puis plus rien. Un fichier encore absent (créé plus tard) est couvert aussi.
 *  Anti-rebond : une sauvegarde produit plusieurs événements (change + rename), un seul
 *  rechargement. */
export function watchFile(filePath: string, onChange: () => void, debounceMs = 300): fs.FSWatcher | undefined {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== null && filename.toString() !== name) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (fs.existsSync(filePath)) onChange();
      }, debounceMs);
    });
    watcher.on('close', () => { if (timer) clearTimeout(timer); });
    return watcher;
  } catch {
    return undefined;
  }
}
