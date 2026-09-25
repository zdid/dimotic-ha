/**
 * Racines d'applications (⭐ 24/09/2026 — conception « racine externe » du 01/09/2026, voir TODO.md) :
 *
 * - **interne** : `applications/` — livrée avec le dépôt / l'image Docker ;
 * - **externe** : `data/applications/` — sur le volume `data/`, survit aux mises à jour d'image ;
 *   sert à déposer une application à tester avant de l'intégrer à une image.
 *
 * Une application externe de même nom qu'une interne la MASQUE (remplacement) sans toucher au disque :
 * supprimer le dossier externe suffit pour que l'interne reprenne.
 *
 * SEUL résolveur « appId → dossier » du core : AppService, ApplicationManager et la route statique
 * `/applications/:appId` passent tous par ici, pour ne jamais diverger.
 *
 * Les applications compilées importent le core par chemin RELATIF (`../../../core/dist/exports`) :
 * depuis la racine externe ce chemin tomberait sur `data/applications/core`, inexistant. D'où le lien
 * symbolique relatif `data/applications/core → ../../applications/core` créé par
 * `ensureExternalRoot()` (vérifié en réel le 24/09/2026 : sans lien « Cannot find module », avec lien
 * l'app charge le core par son chemin réel — même instance que celle du process core).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type AppOrigin = 'interne' | 'externe' | 'externe-remplace';

export interface AppLocation {
  appId: string;
  dir: string;
  origin: AppOrigin;
}

/** Noms réservés : `core` (jamais une app désactivable / lien vers le core dans la racine externe),
 *  `applications` (collision avec `data/applications/`, voir ConfigLoader.mergeAppSections()). */
const RESERVED_APP_IDS = new Set(['core', 'applications']);

export function isValidAppId(appId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(appId);
}

export function projectRootDir(): string {
  return process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../../'));
}

export function internalAppsRoot(projectRoot = projectRootDir()): string {
  return path.join(projectRoot, 'applications');
}

export function externalAppsRoot(projectRoot = projectRootDir()): string {
  return path.join(projectRoot, 'data', 'applications');
}

/** Un dossier est une application s'il a un point d'entrée de domaine (compilé ou source). */
function isAppDir(dir: string): boolean {
  return ['dist/domain/index.js', 'src/domain/index.ts', 'src/domain/index.js']
    .some((entry) => fs.existsSync(path.join(dir, entry)));
}

function listAppDirs(root: string): Map<string, string> {
  const found = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || RESERVED_APP_IDS.has(name) || !isValidAppId(name)) continue;
    const dir = path.join(root, name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    }
    if (isDir && isAppDir(dir)) found.set(name, dir);
  }
  return found;
}

/** Toutes les applications présentes sur disque, l'externe masquant l'interne de même nom. */
export function scanApplications(projectRoot = projectRootDir()): Map<string, AppLocation> {
  const internal = listAppDirs(internalAppsRoot(projectRoot));
  const external = listAppDirs(externalAppsRoot(projectRoot));
  const apps = new Map<string, AppLocation>();
  for (const [appId, dir] of internal) apps.set(appId, { appId, dir, origin: 'interne' });
  for (const [appId, dir] of external) {
    apps.set(appId, { appId, dir, origin: internal.has(appId) ? 'externe-remplace' : 'externe' });
  }
  return new Map([...apps.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * ⭐ 24/09/2026 — dossier d'où chaque application a été CHARGÉE par le core (AppService.registerApp).
 * La route statique `/applications/:appId` doit servir la page de la version qui TOURNE : sans ça,
 * une copie externe déposée pendant que la version interne tournait faisait afficher la page de
 * l'externe avec le menu et le paramétrage de l'interne (constaté en test réel le 24/09).
 * Singleton de module : même process que PresentationServer.
 */
const loadedAppDirs = new Map<string, string>();

export function setLoadedAppDir(appId: string, dir: string): void {
  loadedAppDirs.set(appId, dir);
}

export function clearLoadedAppDir(appId: string): void {
  loadedAppDirs.delete(appId);
}

/**
 * ⭐ 25/09/2026 (fonctionnelles-supervision_specs §7.1) — une application peut déclarer dans son
 * `package.json` `"dimotic": { "enabledByDefault": true }` : elle est alors ACTIVÉE à sa première
 * apparition, au lieu de la règle générale « une application nouvelle arrive désactivée ». Lu dans
 * package.json (pas dans la déclaration TypeScript) : le rapprochement disque/config ne charge
 * jamais le code des applications.
 */
export function isEnabledByDefault(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dimotic?: { enabledByDefault?: unknown } };
    return pkg.dimotic?.enabledByDefault === true;
  } catch {
    return false;
  }
}

/** Dossier de la version chargée si l'application l'est, sinon résolution sur disque. */
export function servedAppDir(appId: string, projectRoot = projectRootDir()): string | undefined {
  return loadedAppDirs.get(appId) ?? resolveAppDir(appId, projectRoot);
}

/** Dossier effectif d'une application (externe prioritaire), `undefined` si absente. */
export function resolveAppDir(appId: string, projectRoot = projectRootDir()): string | undefined {
  if (!isValidAppId(appId) || RESERVED_APP_IDS.has(appId)) return undefined;
  for (const root of [externalAppsRoot(projectRoot), internalAppsRoot(projectRoot)]) {
    const dir = path.join(root, appId);
    if (fs.existsSync(dir) && isAppDir(dir)) return dir;
  }
  return undefined;
}

/**
 * Crée `data/applications/` et le lien relatif `data/applications/core → ../../applications/core`
 * s'ils manquent (idempotent). Renvoie un message d'erreur, jamais d'exception : la racine externe
 * est une commodité, son absence ne doit pas empêcher le core de démarrer.
 */
export function ensureExternalRoot(projectRoot = projectRootDir()): string | undefined {
  try {
    const root = externalAppsRoot(projectRoot);
    fs.mkdirSync(root, { recursive: true });
    const link = path.join(root, 'core');
    const target = path.relative(root, path.join(internalAppsRoot(projectRoot), 'core'));
    let current: string | undefined;
    try { current = fs.readlinkSync(link); } catch { current = undefined; }
    if (current === target) return undefined;
    if (current !== undefined || fs.existsSync(link)) {
      return `${link} existe déjà et n'est pas le lien attendu vers ${target} — laissé tel quel`;
    }
    fs.symlinkSync(target, link, 'dir');
    return undefined;
  } catch (error) {
    return `Racine externe ${externalAppsRoot(projectRoot)} : ${error instanceof Error ? error.message : String(error)}`;
  }
}
