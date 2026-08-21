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

export function ensureDriversBundle(config: ArexxConfig, logger: Logger): void {
  const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'arexx');
  const driversDir = path.join(dataDir, 'drivers');
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

  const targetFile = path.join(driversDir, 'target.txt');
  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, `A_REMPLACER:${config.httpservPort}\n`, 'utf8');
    logger.info('DriversBundle', `target.txt créé (à éditer avant copie sur la machine cible): ${targetFile}`);
  }

  logger.info('DriversBundle', `Bundle de déploiement prêt: ${driversDir}`);
}
