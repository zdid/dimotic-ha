/**
 * Persistance des dernières valeurs saisies par script (⭐ 19/09/2026, demande explicite : "éviter
 * que l'on ait tout à ressaisir") — un fichier JSON par script, à côté du contenu du script lui-même
 * (data/outils/saved-values/<id>.json), jamais commité (data/ gitignoré).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function valuesDir(): string {
  return path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'outils', 'saved-values');
}

function valuesFilePath(id: string): string {
  return path.join(valuesDir(), `${id}.json`);
}

export function readSavedValues(id: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(valuesFilePath(id), 'utf8'));
  } catch {
    return {};
  }
}

export function saveValues(id: string, values: Record<string, string>): void {
  fs.mkdirSync(valuesDir(), { recursive: true });
  fs.writeFileSync(valuesFilePath(id), JSON.stringify(values, null, 2), 'utf8');
}
