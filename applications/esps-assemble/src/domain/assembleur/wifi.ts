/**
 * Wifi d'un appareil, GÉNÉRÉ à l'assemblage d'après les sites de sa fiche (`wifi: [site, …]`) et les fichiers `bibliotheque/wifi/<site>.yaml` :
 * tous les réseaux de tous les sites, le premier site (celui où l'appareil sera installé) et son premier réseau étant préférés, plus un point
 * d'accès de secours avec portail captif (mot de passe du premier site). Aucun mot de passe : des références `!secret`, que l'usine vérifie.
 */

import type { Bibliotheque } from './fiches';

export const CHEMIN_WIFI = 'generes/wifi.yaml';

export function genererWifi(nom: string, sites: string[], biblio: Bibliotheque): { yaml: string; secrets: string[] } {
  const lignes: string[] = [];
  const secrets: string[] = [];
  let rang = 0;
  for (const site of sites) {
    for (const r of biblio.wifiSite(site).reseaux) {
      const ssid = r.ssidSecret ?? `wifi_${site}_${r.id}_ssid`, mdp = r.passwordSecret ?? `wifi_${site}_${r.id}_password`;
      lignes.push(`    # site ${site}, réseau ${r.id}`, `    - ssid: !secret ${ssid}`, `      password: !secret ${mdp}`, `      priority: ${100 - rang}`);
      secrets.push(ssid, mdp);
      rang++;
    }
  }
  const secours = biblio.wifiSite(sites[0]).secoursPasswordSecret ?? `wifi_${sites[0]}_secours_password`;
  secrets.push(secours);
  const apSsid = `${nom} secours`.slice(0, 32);
  const yaml = [
    `# GÉNÉRÉ à l'assemblage d'après la fiche de l'appareil (wifi : ${sites.join(', ')}). Ne pas modifier.`,
    "# Réseau le plus prioritaire d'abord ; sans aucun réseau joignable, l'ESP ouvre le point d'accès de secours (portail captif) pour saisir le wifi du lieu.",
    'wifi:', '  networks:', ...lignes,
    '  ap:', `    ssid: "${apSsid}"`, `    password: !secret ${secours}`, '    ap_timeout: 1min',
    'captive_portal:', ''
  ].join('\n');
  return { yaml, secrets: [...new Set(secrets)] };
}
