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

/** ⭐ 24/09/2026 — défense en profondeur : jamais de chemin hors de saved-values/. */
function valuesFilePath(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Identifiant de script invalide: ${id}`);
  return path.join(valuesDir(), `${id}.json`);
}

/**
 * ⭐ 29/09/2026 (techniques-diffusion-data_specs §8.3) — les valeurs des variables sensibles (nom
 * contenant PASS, PASSWORD, MDP, TOKEN, KEY, SECRET) sont rangées à part, dans
 * `secrets_<id>.json` (non reproduit sur les autres machines) ; les autres dans `<id>.json`.
 * Rien ne change pour l'appelant : lecture fusionnée, écriture répartie.
 */
const SENSITIVE = /(PASS|MDP|TOKEN|KEY|SECRET)/i;

function secretsFilePath(id: string): string {
  return path.join(valuesDir(), `secrets_${path.basename(valuesFilePath(id))}`);
}

function readJson(file: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function readSavedValues(id: string): Record<string, string> {
  const common = readJson(valuesFilePath(id));
  const values = { ...common, ...readJson(secretsFilePath(id)) };
  // Migration : une valeur sensible encore dans <id>.json (fichier antérieur) est déplacée.
  if (Object.keys(common).some((k) => SENSITIVE.test(k))) saveValues(id, values);
  return values;
}

export function saveValues(id: string, values: Record<string, string>): void {
  fs.mkdirSync(valuesDir(), { recursive: true });
  const common: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) (SENSITIVE.test(k) ? secrets : common)[k] = v;
  fs.writeFileSync(valuesFilePath(id), JSON.stringify(common, null, 2), 'utf8');
  const secretsFile = secretsFilePath(id);
  if (Object.keys(secrets).length) fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 });
  else if (fs.existsSync(secretsFile)) fs.unlinkSync(secretsFile);
}

/** Range à part les valeurs sensibles de tous les fichiers existants (appelé au démarrage d'Outils). */
export function migrateAllSavedValues(): string[] {
  const migrated: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(valuesDir());
  } catch {
    return migrated;
  }
  for (const file of files) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(file);
    if (!m || file.startsWith('secrets_')) continue;
    const id = m[1] as string;
    if (Object.keys(readJson(valuesFilePath(id))).some((k) => SENSITIVE.test(k))) {
      readSavedValues(id);
      migrated.push(id);
    }
  }
  return migrated;
}
