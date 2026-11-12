/**
 * ⭐ 12/11/2026 (conception-esphome-assembleur v1.8) — paramètres DU SITE, GÉNÉRÉS à l'assemblage (`generes/site.yaml`) au lieu d'être
 * écrits dans chaque fiche : le broker MQTT du site (paramètre MQTT général de dimotic-ha, ou `mqtt.hote` de l'application).
 * L'élément `transport-mqtt` inclut ce fichier ; une fiche qui passe `broker` dans ses `vars` garde la main (cas particulier).
 * Cause : la renumérotation du réseau de Saint-Fort (11/11/2026) avait obligé à corriger l'adresse dans chaque fiche, et les fiches
 * de l'image de ha2 étaient restées sur l'ancienne (module du poêle recompilé vers un broker disparu).
 */

export const CHEMIN_SITE = 'generes/site.yaml';

export interface BrokerSite {
  hote: string;
  port: number;
}

export function genererSite(site: string, broker: BrokerSite): string {
  return [
    `# GÉNÉRÉ à l'assemblage d'après la configuration du site ${site} (broker MQTT général de dimotic-ha). Ne pas modifier.`,
    '# Une fiche peut garder la main en passant `broker` (et `port_broker`) dans les vars de l\'élément transport-mqtt.',
    'substitutions:',
    `  broker: "${broker.hote}"`,
    `  port_broker: "${broker.port}"`,
    ''
  ].join('\n');
}
