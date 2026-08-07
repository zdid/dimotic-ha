/**
 * PortDetector — détection automatique du port série RFXCOM via /dev/serial/by-id.
 *
 * Le nom /dev/ttyUSBx attribué par le noyau à un adaptateur USB-série n'est PAS garanti stable
 * d'un redémarrage à l'autre (dépend de l'ordre d'énumération USB) — /dev/serial/by-id/, lui,
 * contient un lien symbolique nommé d'après le vendor/produit/numéro de série USB du périphérique
 * (stable), qui pointe vers le vrai /dev/ttyUSBx du moment (ex: usb-RFXCOM_RFXtrx433_A1RST9E-if00-
 * port0 -> ../../ttyUSB0). On résout ce lien pour récupérer le VRAI nom (/dev/ttyUSBx), et c'est
 * CE nom qu'on transmet à la bibliothèque `rfxcom` — pas le lien lui-même : passer le lien
 * directement pose parfois problème dans certains environnements (ex: Docker, mapping de
 * périphérique par nom réel plutôt que par lien symbolique).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../../../core/dist/exports';

const BY_ID_DIR = '/dev/serial/by-id';
const NAME_PATTERN = /rfxcom|rfxtrx/i;

/**
 * Cherche dans /dev/serial/by-id un lien dont le nom contient "rfxcom" ou "rfxtrx", et retourne
 * le chemin réel (résolu) du périphérique série vers lequel il pointe (ex: "/dev/ttyUSB0").
 * Retourne `null` si le dossier n'existe pas, est vide, ou qu'aucune entrée ne correspond —
 * l'appelant doit alors se rabattre sur le port configuré manuellement (fichier de config).
 */
export function detectRfxComPort(logger: Logger): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(BY_ID_DIR);
  } catch {
    return null; // dossier absent (pas de périphérique série USB par ID sur ce système)
  }

  const match = entries.find((entry) => NAME_PATTERN.test(entry));
  if (!match) return null;

  const linkPath = path.join(BY_ID_DIR, match);
  try {
    const target = fs.readlinkSync(linkPath);
    const resolved = path.resolve(BY_ID_DIR, target);
    logger.info('PortDetector', `Port RFXCOM détecté via ${linkPath} -> ${resolved}`);
    return resolved;
  } catch (error) {
    logger.warn('PortDetector', `Lien trouvé (${linkPath}) mais impossible à résoudre: ${error}`);
    return null;
  }
}
