/**
 * Adresse réseau primaire de la machine hôte (⭐ 24/08/2026, affichage version+hôte dans la barre
 * latérale) — fiable sous Docker grâce à `network_mode: host` (compose.yaml/compose.deploy.yaml) :
 * `os.networkInterfaces()` voit alors directement les interfaces réelles de l'hôte, pas celles
 * d'un réseau bridge Docker isolé. Vérifié en conditions réelles sur `stfort` (conteneur de
 * production) avant d'écrire ce code : renvoie bien la vraie IP LAN (192.168.1.53), pas une
 * adresse interne au conteneur.
 */

import * as os from 'node:os';

/** Interfaces virtuelles de Docker (réseaux bridge) : jamais une adresse de la machine sur le LAN. */
const VIRTUAL_IFACE_RE = /^(docker\d*|br-|veth|virbr)/;
/** Rang de préférence : ethernet d'abord, puis le reste, wifi en dernier. */
function ifaceRank(name: string): number {
  if (/^(eth|en)/.test(name)) return 0;
  if (/^(wlan|wl)/.test(name)) return 2;
  return 1;
}

/**
 * ⭐ 25/09/2026 (fonctionnelles-supervision_specs v1.4) — toutes les IPv4 non-internes de la machine,
 * ethernet d'abord, wifi en dernier, interfaces Docker exclues. Constaté sur ha2 : .51 (ethernet)
 * et .106 (wifi) — la supervision doit pouvoir la reconnaître par l'une ou l'autre.
 */
export function getIPv4Addresses(): string[] {
  const found: Array<{ address: string; rank: number }> = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) found.push({ address: addr.address, rank: ifaceRank(name) });
    }
  }
  // Tri stable : à rang égal, l'ordre du système est conservé.
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.address);
}

/** Adresse principale : la première de getIPv4Addresses() (ethernet préféré au wifi depuis le
 *  25/09/2026 — avant : première IPv4 trouvée, le wifi sur ha2), ou `undefined` si aucune. */
export function getPrimaryIPv4Address(): string | undefined {
  return getIPv4Addresses()[0];
}
