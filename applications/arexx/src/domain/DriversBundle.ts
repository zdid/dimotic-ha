/**
 * DriversBundle
 *
 * Prépare `data/arexx/drivers/` — copie du bundle de déploiement (scripts/deploy-sender.sh,
 * rf_usb_http_rpi_0_6/, tl-500/) depuis l'installation de l'application elle-même
 * (`applications/arexx/`) vers le volume de données.
 *
 * Pourquoi : sous Docker, `applications/arexx/` est figé dans l'image au build (pas de volume
 * dessus, voir Dockerfile racine) — inaccessible depuis l'hôte. `data/arexx/`, lui, est un volume
 * monté (déjà utilisé pour la config/les capteurs) — le seul endroit d'où l'utilisateur peut
 * réellement copier ce bundle vers une machine distante, conteneur ou pas.
 *
 * Rafraîchi à chaque démarrage (scripts/binaires écrasés, sans risque — ce sont des copies
 * statiques du code livré) ; `target.txt` (adresse du récepteur AREXX à joindre depuis la machine
 * distante) n'est en revanche créé QUE s'il est absent, pour ne jamais écraser une valeur déjà
 * éditée par l'utilisateur.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../../core/dist/exports';
import type { ArexxConfig } from './config-schema';

const BUNDLE_ITEMS = ['scripts', 'rf_usb_http_rpi_0_6', 'tl-500'];
const TARGET_PLACEHOLDER_HOST = 'A_REMPLACER';

export function driversDirPath(): string {
  const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'arexx');
  return path.join(dataDir, 'drivers');
}

function targetFilePath(): string {
  return path.join(driversDirPath(), 'target.txt');
}

export function ensureDriversBundle(config: ArexxConfig, logger: Logger): void {
  const driversDir = driversDirPath();
  // Depuis dist/domain/DriversBundle.js, remonte à applications/arexx/ (racine de l'app,
  // scripts/rf_usb_http_rpi_0_6/tl-500 y vivent en tant que dossiers frères de dist/src) — même
  // convention que UsbBridge.ts pour localiser son propre binaire vendored.
  const appRoot = path.join(__dirname, '..', '..');

  fs.mkdirSync(driversDir, { recursive: true });

  for (const item of BUNDLE_ITEMS) {
    const src = path.join(appRoot, item);
    const dest = path.join(driversDir, item);
    if (!fs.existsSync(src)) {
      logger.warn('DriversBundle', `Élément du bundle introuvable, ignoré: ${src}`);
      continue;
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
  }

  const targetFile = targetFilePath();
  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, `${TARGET_PLACEHOLDER_HOST}:${config.httpservPort}\n`, 'utf8');
    logger.info('DriversBundle', `target.txt créé (à renseigner via la page Déploiement): ${targetFile}`);
  }

  logger.info('DriversBundle', `Bundle de déploiement prêt: ${driversDir}`);
}

/** Lit target.txt tel quel — { host: '', port } si absent/placeholder non encore renseigné. */
export function readDriverTarget(config: ArexxConfig): { host: string; port: number } {
  const targetFile = targetFilePath();
  try {
    const line = fs.readFileSync(targetFile, 'utf8').split('\n')[0].trim();
    const [host, portStr] = line.split(':');
    const port = Number(portStr);
    if (!host || host === TARGET_PLACEHOLDER_HOST || !Number.isInteger(port) || port <= 0) {
      return { host: '', port: config.httpservPort };
    }
    return { host, port };
  } catch {
    return { host: '', port: config.httpservPort };
  }
}

/** Écrit target.txt à partir d'une saisie utilisateur (page Déploiement) — validé par l'appelant. */
export function writeDriverTarget(host: string, port: number): void {
  fs.writeFileSync(targetFilePath(), `${host}:${port}\n`, 'utf8');
}
