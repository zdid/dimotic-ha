/**
 * Fichiers PARTAGÉS par une application, en lecture seule (⭐ 13/10/2026, conception-esphome-assembleur §4 et §11 :
 * livraison par « je demande, j'obtiens » — l'usine de l'application esphome vient chercher le paquet zip d'un appareil
 * chez l'assembleur, puis le poseur le firmware chez l'usine, à travers le VPN entre sites).
 *
 * Route : `GET /api/apps/<appId>/partage/<chemin>` → `data/<appId>/machine_partage/<chemin>`.
 * - Dossier réservé `machine_partage` : le préfixe `machine_` l'exclut de la diffusion entre instances (ces fichiers sont
 *   propres à la machine qui les produit ; la diffusion reste un dispositif de sécurité et de reprise).
 * - Lecture seule ; rien d'autre de `data/` n'est servi.
 * - Refus de tout chemin qui sortirait du dossier : `..`, segment vide ou caché, caractères hors liste, et **liens
 *   symboliques** (le chemin réel doit rester sous le dossier réservé). Pas d'authentification : réseau local et VPN,
 *   comme le reste de l'interface web de dimotic-ha.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHARED_DIR_NAME = 'machine_partage';
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const APP_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export type SharedFileResolution =
  | { ok: true; filePath: string }
  | { ok: false; status: 400 | 404; message: string };

/** Dossier réservé d'une application (sans vérifier son existence). */
export function sharedDir(dataRoot: string, appId: string): string {
  return path.join(dataRoot, appId, SHARED_DIR_NAME);
}

/** Résout le fichier demandé, ou dit pourquoi il est refusé. */
export function resolveSharedFile(dataRoot: string, appId: string, relPath: string): SharedFileResolution {
  if (!APP_ID.test(appId)) return { ok: false, status: 400, message: 'appId invalide' };
  const segments = relPath.split('/');
  if (!relPath || segments.some((s) => !SEGMENT.test(s))) {
    return { ok: false, status: 400, message: 'chemin invalide' };
  }
  const base = sharedDir(dataRoot, appId);
  const candidate = path.join(base, ...segments);
  let realBase: string;
  let realFile: string;
  try {
    realBase = fs.realpathSync(base);
    realFile = fs.realpathSync(candidate);
  } catch {
    return { ok: false, status: 404, message: 'fichier introuvable' };
  }
  if (!realFile.startsWith(realBase + path.sep)) {
    return { ok: false, status: 400, message: 'chemin hors du dossier partagé' };
  }
  if (!fs.statSync(realFile).isFile()) return { ok: false, status: 404, message: 'fichier introuvable' };
  return { ok: true, filePath: realFile };
}
