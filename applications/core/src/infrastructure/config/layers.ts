/**
 * ⭐ 29/09/2026 — Trois fichiers de configuration par application, gérés par le core
 * (techniques-diffusion-data_specs §8.1-§8.2, temps 1) :
 *   - `config.yaml`          : réglages communs à toutes les machines (sera reproduit) ;
 *   - `machine_config.yaml`  : réglages propres à la machine (jamais reproduit) ;
 *   - `secrets_config.yaml`  : secrets (non reproduit pour l'instant).
 * « Secret » décide seulement du fichier de rangement, jamais du masquage à l'écran.
 *
 * Lecture : les trois fichiers fusionnés dans cet ordre (objets fusionnés clé par clé, valeurs
 * simples et listes remplacées). Écriture : chaque réglage est réécrit dans le fichier où il se
 * trouve déjà (ce réglage précis) ; sinon selon la déclaration (`storage`), sinon
 * `config.yaml`. Migration : les chemins déclarés trouvés dans `config.yaml` sont déplacés dans
 * leur fichier — refaite à chaque démarrage (idempotente), ce qui prend aussi en charge un outil
 * ancien qui réécrirait `config.yaml` à plat (CoreDeployService.pushConfig, docker/start-all.sh).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export const COMMON_FILE = 'config.yaml';
export const MACHINE_FILE = 'machine_config.yaml';
export const SECRETS_FILE = 'secrets_config.yaml';

export type Layer = 'common' | 'machine' | 'secrets';
export type Obj = Record<string, unknown>;

/** Chemins pointés déclarés par fichier (ex. `ha.ws.token`) — un chemin couvre tout son sous-arbre. */
export interface LayerDeclaration {
  machine?: string[];
  secrets?: string[];
}

const YAML_DUMP_OPTIONS = { indent: 2, sortKeys: false, lineWidth: -1 };

/**
 * Inventaire du core (spec §8.3, corrigé le 29/09/2026) : `ha` est commun au foyer (diffusé par
 * CoreDeployService.pushConfig), sauf ses secrets. `ha.mqtt.client_id` reste commun : aucune
 * connexion ne l'utilise (chaque client MQTT du core se nomme d'après `core.machineId`).
 */
export const CORE_DECLARATION: LayerDeclaration = {
  machine: ['core.machineId', 'core.site', 'web', 'logging', 'disabledApps', 'knownApps'],
  secrets: ['ha.ws.token', 'ha.mqtt.password']
};

/**
 * Inventaire des applications (spec §8.3) — temps 2, rempli le 29/09/2026 pour toutes les
 * applications sauf rfxcom (process particulier : déplacement du boîtier RFXCOM). Applications sans
 * réglage propre à la machine ni secret : absentes (arbreouquoi, haplan, nommage — son ancien
 * `sources[].mqtt.password` est vide et abandonné à la prochaine sauvegarde —, outils, planificateur,
 * sauvegarde, scriptsha, supervision, testcycle, arexx).
 */
export const APP_DECLARATIONS: Record<string, LayerDeclaration> = {
  tasmota: { secrets: ['wifi.password'] },
  ia: { secrets: ['mistralApiKey', 'anthropicApiKey'], machine: ['ollamaHttpPort'] },
  evoo7: { secrets: ['box.password'] },
  rpigpio: { secrets: ['mqtt.password'] },
  teleinfo: { secrets: ['mqtt.password'] },
  espdisplay: { machine: ['esphomeContainer', 'esphomeConfigDir', 'pipelineScriptPath', 'pythonBin', 'remote'] }
};

/**
 * Fichiers/dossiers propres à la machine, renommés `machine_…` par la migration (spec §8.3) — le
 * code de l'application utilise déjà le nouveau nom. Chemins relatifs à `data/`.
 */
export const DATA_RENAMES: Array<[string, string]> = [
  ['core/ssh', 'core/machine_ssh'],
  ['core/ha-structure-debug.yaml', 'core/machine_ha-structure-debug.yaml'],
  ['core/ha-structure-changes.yaml', 'core/machine_ha-structure-changes.yaml'],
  ['ia/comparatif.log', 'ia/machine_comparatif.log'],
  ['arexx/drivers', 'arexx/machine_drivers']
];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function layerFiles(dir: string): Record<Layer, string> {
  return {
    common: path.join(dir, COMMON_FILE),
    machine: path.join(dir, MACHINE_FILE),
    secrets: path.join(dir, SECRETS_FILE)
  };
}

function readYamlObject(file: string): Obj | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML in ${file}: ${message}`);
  }
  if (parsed === undefined || parsed === null) return {};
  if (!isObj(parsed)) throw new Error(`Invalid YAML in ${file}: un objet est attendu`);
  return parsed;
}

function writeYamlAtomic(file: string, data: Obj, tmpSuffix = '.tmp'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}${tmpSuffix}`;
  try {
    fs.writeFileSync(tmp, yaml.dump(data, YAML_DUMP_OPTIONS), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* rien */ }
    throw error;
  }
}

/** Fusion profonde : objets clé par clé, valeurs simples et listes remplacées. */
export function mergeLayers(...layers: Array<Obj | undefined>): Obj {
  const result: Obj = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      result[key] = isObj(value) && isObj(result[key]) ? mergeLayers(result[key] as Obj, value) : value;
    }
  }
  return result;
}

export interface LayeredRead {
  /** Vue fusionnée — undefined si aucun des trois fichiers n'existe. */
  merged?: Obj;
  common?: Obj;
  machine?: Obj;
  secrets?: Obj;
}

/** Lit les trois fichiers d'un dossier `data/<app>/`. */
export function readLayered(dir: string): LayeredRead {
  const files = layerFiles(dir);
  const common = readYamlObject(files.common);
  const machine = readYamlObject(files.machine);
  const secrets = readYamlObject(files.secrets);
  if (!common && !machine && !secrets) return {};
  return { merged: mergeLayers(common, machine, secrets), common, machine, secrets };
}

export function layersExist(dir: string): boolean {
  const files = layerFiles(dir);
  return fs.existsSync(files.common) || fs.existsSync(files.machine) || fs.existsSync(files.secrets);
}

// -----------------------------------------------------------------------------
// Chemins
// -----------------------------------------------------------------------------

function getAt(obj: Obj | undefined, keys: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

function setAt(obj: Obj, keys: string[], value: unknown): void {
  let cur = obj;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      cur[key] = value;
      return;
    }
    const next = cur[key];
    if (!isObj(next)) cur[key] = {};
    cur = cur[key] as Obj;
  });
}

function deleteAt(obj: Obj, keys: string[]): void {
  const last = keys[keys.length - 1];
  if (last === undefined) return;
  const chain: Array<{ parent: Obj; key: string }> = [];
  let cur: Obj = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (!isObj(next)) return;
    chain.push({ parent: cur, key });
    cur = next;
  }
  delete cur[last];
  // Objets devenus vides retirés (pas de `ha: {}` laissé derrière une migration).
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i];
    if (!link) break;
    const child = link.parent[link.key];
    if (isObj(child) && Object.keys(child).length === 0) delete link.parent[link.key];
    else break;
  }
}

/** Feuilles d'un objet (listes = feuilles). */
function leaves(obj: Obj, prefix: string[] = [], out: string[][] = []): string[][] {
  for (const [key, value] of Object.entries(obj)) {
    const p = [...prefix, key];
    if (isObj(value) && Object.keys(value).length > 0) leaves(value, p, out);
    else out.push(p);
  }
  return out;
}

const startsWith = (p: string[], decl: string): boolean => {
  const d = decl.split('.');
  return d.length <= p.length && d.every((k, i) => p[i] === k);
};

/**
 * Fichier d'un réglage : celui qui contient déjà CE réglage précis (à égalité, secrets l'emporte) ;
 * sinon la déclaration (un chemin déclaré couvre tout son sous-arbre, ex. `web`) ; sinon commun.
 * Un sous-objet partiellement secret (ex. `box.password`) n'attire donc pas ses nouveaux voisins.
 */
function layerOf(p: string[], existing: { machine?: Obj; secrets?: Obj }, decl: LayerDeclaration): Layer {
  const isLeafIn = (layer?: Obj): boolean => {
    const hit = getAt(layer, p);
    return hit.found && !(isObj(hit.value) && Object.keys(hit.value).length > 0);
  };
  if (isLeafIn(existing.secrets)) return 'secrets';
  if (isLeafIn(existing.machine)) return 'machine';
  if (decl.secrets?.some((d) => startsWith(p, d))) return 'secrets';
  if (decl.machine?.some((d) => startsWith(p, d))) return 'machine';
  return 'common';
}

/**
 * Écrit une section complète (vue fusionnée) dans les trois fichiers de `dir`. Un fichier machine
 * ou secrets vide est supprimé ; `config.yaml` est toujours écrit (même vide).
 */
export function writeLayered(dir: string, data: Obj, decl: LayerDeclaration = {}, tmpSuffix = '.tmp'): void {
  const files = layerFiles(dir);
  const existing = { machine: readYamlObject(files.machine), secrets: readYamlObject(files.secrets) };
  const out: Record<Layer, Obj> = { common: {}, machine: {}, secrets: {} };
  for (const p of leaves(data)) {
    setAt(out[layerOf(p, existing, decl)], p, getAt(data, p).value);
  }
  writeYamlAtomic(files.common, out.common, tmpSuffix);
  for (const layer of ['machine', 'secrets'] as const) {
    if (Object.keys(out[layer]).length > 0) writeYamlAtomic(files[layer], out[layer], tmpSuffix);
    else if (fs.existsSync(files[layer])) fs.unlinkSync(files[layer]);
  }
}

/**
 * Déplace hors de `config.yaml` les chemins déclarés machine/secrets (la valeur trouvée dans
 * `config.yaml` l'emporte : c'est la plus récente). Sauvegarde préalable de `config.yaml` dans
 * `historyDir` si quelque chose bouge. Retourne les chemins déplacés.
 */
export function migrateLayered(dir: string, decl: LayerDeclaration, historyDir?: string): string[] {
  const files = layerFiles(dir);
  const common = readYamlObject(files.common);
  if (!common) return [];
  const machine = readYamlObject(files.machine) ?? {};
  const secrets = readYamlObject(files.secrets) ?? {};
  const moved: string[] = [];
  const move = (paths: string[] | undefined, target: Obj): void => {
    for (const declared of paths ?? []) {
      const keys = declared.split('.');
      const hit = getAt(common, keys);
      if (!hit.found) continue;
      setAt(target, keys, isObj(hit.value) && isObj(getAt(target, keys).value)
        ? mergeLayers(getAt(target, keys).value as Obj, hit.value)
        : hit.value);
      deleteAt(common, keys);
      moved.push(declared);
    }
  };
  // Secrets d'abord : un secret peut être sous un chemin déclaré machine (plus général).
  move(decl.secrets, secrets);
  move(decl.machine, machine);
  if (!moved.length) return [];
  if (historyDir) {
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(files.common, path.join(historyDir, `${COMMON_FILE}.${stamp}`));
  }
  writeYamlAtomic(files.common, common);
  if (Object.keys(machine).length) writeYamlAtomic(files.machine, machine);
  if (Object.keys(secrets).length) writeYamlAtomic(files.secrets, secrets);
  return moved;
}

/** Écrit un chemin dans `machine_config.yaml` sans toucher au reste (ex. machineId généré). */
export function setMachineValue(dir: string, dotted: string, value: unknown): void {
  const file = layerFiles(dir).machine;
  const machine = readYamlObject(file) ?? {};
  setAt(machine, dotted.split('.'), value);
  writeYamlAtomic(file, machine);
}
