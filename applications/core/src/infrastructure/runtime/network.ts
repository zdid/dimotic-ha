/**
 * Adresse réseau primaire de la machine hôte (⭐ 24/08/2026, affichage version+hôte dans la barre
 * latérale) — fiable sous Docker grâce à `network_mode: host` (compose.yaml/compose.deploy.yaml) :
 * `os.networkInterfaces()` voit alors directement les interfaces réelles de l'hôte, pas celles
 * d'un réseau bridge Docker isolé. Vérifié en conditions réelles sur `stfort` (conteneur de
 * production) avant d'écrire ce code : renvoie bien la vraie IP LAN (192.168.1.53), pas une
 * adresse interne au conteneur.
 */

import * as os from 'node:os';

/** Première IPv4 non-interne trouvée, ou `undefined` si aucune (ex: machine hors réseau). */
export function getPrimaryIPv4Address(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}
