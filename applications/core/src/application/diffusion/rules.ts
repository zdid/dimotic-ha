/**
 * Règles de la diffusion des fichiers de data/ (techniques-diffusion-data_specs v1.3) — fonctions
 * pures, testées à part (rules.test.ts). Chemins toujours relatifs à data/, séparateur '/'.
 */

/** ⭐ 29/09/2026 (spec v1.6 §2bis) — deux cases par machine au lieu de trois modes : Diffuser (envoie)
 *  et Recevoir. Recevoir sans Diffuser = machine de développement : ses applications actives sont
 *  isolées (ni remplacées ni envoyées). */
export interface DiffusionSettings {
  send: boolean;
  receive: boolean;
}

export const MAX_SIZE = 1024 * 1024;              // D4 : 1 Mo
export const MAX_SIZE_PLAN_IMAGES = 20 * 1024 * 1024; // D5 : images de plan, 20 Mo

/** Raison de non-reproduction d'un chemin, ou null s'il est reproductible. */
export function exclusionReason(relPath: string, size?: number): string | null {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length < 2) return 'hors dossier d’application';
  const name = segs[segs.length - 1] as string;
  for (const seg of segs) {
    if (seg.startsWith('machine_')) return 'machine_ (propre à la machine)';
    if (seg.startsWith('secrets_')) return 'secrets_ (non reproduit)';
    if (seg === 'tmp' || seg.endsWith('-tmp')) return 'répertoire temporaire';
    if (seg === 'node_modules') return 'node_modules';
  }
  // Applications externes : sources seulement, chaque machine compile (D8).
  if (segs[0] === 'applications' && segs[2] === 'dist') return 'dist/ (compilé sur place)';
  if (name.endsWith('.tmp') || name.endsWith('~') || name.startsWith('.#') || /^\..*\.swp$/.test(name)) return 'fichier temporaire';
  if (name.endsWith('.bak') || name.endsWith('.origine.yaml')) return '.bak / .origine.yaml';
  if (size !== undefined) {
    const planImage = segs[0] === 'haplan' && segs[1] === 'images';
    const limit = planImage ? MAX_SIZE_PLAN_IMAGES : MAX_SIZE;
    if (size > limit) return `plus de ${planImage ? '20' : '1'} Mo`;
  }
  return null;
}

/** Répertoire à ne jamais parcourir (gain de temps au scan et à la surveillance). */
export function isExcludedDir(name: string): boolean {
  return name.startsWith('machine_') || name.startsWith('secrets_') || name === 'node_modules' || name === 'tmp' || name.endsWith('-tmp');
}

/** Application propriétaire d'un chemin : 1er segment, ou 2e sous applications/ (code externe). */
export function appOf(relPath: string): string {
  const segs = relPath.split('/');
  return (segs[0] === 'applications' ? segs[1] : segs[0]) ?? '';
}

/** Application isolée (ni envoi ni réception) : Recevoir sans Diffuser + application active ici. */
export function isIsolated(relPath: string, s: DiffusionSettings, activeApps: Set<string>): boolean {
  return s.receive && !s.send && activeApps.has(appOf(relPath));
}

export function canSend(relPath: string, s: DiffusionSettings): boolean {
  return s.send;
}

export function canReceive(relPath: string, s: DiffusionSettings, activeApps: Set<string>): boolean {
  if (!s.receive) return false;
  return !isIsolated(relPath, s, activeApps);
}

export interface Version {
  mtime: number;    // ms epoch
  sha256: string;
  origin: string;   // machineId
  deleted?: boolean;
}

/**
 * La version `candidate` l'emporte-t-elle sur `local` ? Le plus récent gagne ; à date égale et
 * contenus différents, départage stable par machine d'origine (ordre alphabétique, la plus grande).
 */
export function isNewer(candidate: Version, local: Version | undefined): boolean {
  if (!local) return !candidate.deleted;
  if (candidate.sha256 === local.sha256 && !!candidate.deleted === !!local.deleted) return false;
  if (candidate.mtime !== local.mtime) return candidate.mtime > local.mtime;
  return candidate.origin > local.origin;
}
