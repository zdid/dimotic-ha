/**
 * Déclaration des machines dimotic-ha dans Home Assistant (fonctionnelles-supervision_specs v1.3 §3ter), par MQTT :
 * pour chaque machine du site, un appareil « dimotic-ha <machine> » avec
 *   - « En ligne » (binary_sensor, connectivité) : lu DIRECTEMENT sur le LWT du core (`app/dimotic-core-appgossip-<m>/status`,
 *     online/offline) — marche même quand la machine est éteinte, personne n'a besoin de publier à sa place ;
 *   - « Version installée » (sensor) : lue sur l'annonce retenue du core (`dimotic/core/<m>/known-apps`, `dimoticVersion`) ;
 *   - « Mise à jour » (update) : version installée / dernière version du Docker Hub (HA affiche « mise à jour disponible »).
 * Plus un appareil « dimotic-ha — Docker Hub » avec « Dernière version » (sensor), publiée par la supervision
 * (`dimotic/supervision/hub/latest-version`, retenue). Tout est retenu : HA retrouve les entités après un redémarrage.
 */

export const DISCOVERY_PREFIX = 'homeassistant';
export const HUB_LATEST_TOPIC = 'dimotic/supervision/hub/latest-version';

export interface DiscoveryMessage { topic: string; payload: Record<string, unknown> }

function slug(texte: string): string {
  return texte.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function lwtTopic(machineId: string): string {
  return `app/dimotic-core-appgossip-${machineId}/status`;
}

/** Segment de site, comme le cœur et l'agent : minuscules, [a-z0-9_-]. */
export function segmentSite(site: string): string {
  return site.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

/** Topic où le bouton « Installer » de HA publie (écouté par l'agent `maj` de la machine). */
export function installerTopic(site: string, machineId: string): string {
  return `dimotic/${segmentSite(site)}/maj/${machineId}/installer`;
}

/** État de mise à jour d'une machine, publié (retenu) par la supervision pour l'entité `update` de HA. */
export function majEtatTopic(machineId: string): string {
  // Volontairement PAS sous `dimotic/<site>/maj/<machine>/etat` (celui des agents) : l'abonnement aux agents le reconnaîtrait.
  return `dimotic/supervision/maj-etat/${machineId}`;
}

/** Ancien emplacement (v1.9 initiale), confondu avec l'état d'un agent de site « supervision » : à vider une fois. */
export function majEtatTopicAncien(machineId: string): string {
  return `dimotic/supervision/maj/${machineId}/etat`;
}

export interface MajEtat { installed_version: string; latest_version: string; in_progress: boolean }

/** `latest_version` absent (hub pas encore lu) : on répète l'installée, HA n'affiche alors aucune mise à jour. */
export function majEtat(installee: string | undefined, derniere: string | null, enCours: boolean): MajEtat {
  const inst = installee && installee.length ? installee : 'inconnue';
  return { installed_version: inst, latest_version: derniere ?? inst, in_progress: enCours };
}

export function knownAppsTopic(machineId: string): string {
  return `dimotic/core/${machineId}/known-apps`;
}

/** Messages de découverte HA d'une machine (3 entités). */
export function machineDiscovery(machineId: string, siteAgent?: string): DiscoveryMessage[] {
  const id = slug(machineId);
  const device = {
    identifiers: [`dimotic_ha_${id}`],
    name: `dimotic-ha ${machineId}`,
    manufacturer: 'dimotic-ha',
    model: 'Docker'
  };
  return [
    {
      topic: `${DISCOVERY_PREFIX}/binary_sensor/dimotic_${id}/online/config`,
      payload: {
        name: 'En ligne', unique_id: `dimotic_${id}_online`, device_class: 'connectivity', device,
        state_topic: lwtTopic(machineId), payload_on: 'online', payload_off: 'offline', entity_category: 'diagnostic'
      }
    },
    {
      topic: `${DISCOVERY_PREFIX}/sensor/dimotic_${id}/version/config`,
      payload: {
        name: 'Version installée', unique_id: `dimotic_${id}_version`, icon: 'mdi:tag-outline', device,
        state_topic: knownAppsTopic(machineId), value_template: "{{ value_json.dimoticVersion | default('inconnue', true) }}",
        entity_category: 'diagnostic'
      }
    },
    {
      topic: `${DISCOVERY_PREFIX}/update/dimotic_${id}/maj/config`,
      payload: {
        name: 'Mise à jour', unique_id: `dimotic_${id}_maj`, device,
        state_topic: majEtatTopic(machineId),
        // Le bouton « Installer » n'existe que si l'agent `maj` de cette machine s'est fait connaître (son site est alors connu).
        ...(siteAgent ? { command_topic: installerTopic(siteAgent, machineId), payload_install: 'INSTALL' } : {}),
        entity_picture: 'https://brands.home-assistant.io/_/docker/icon.png'
      }
    }
  ];
}

/** Un cœur lancé hors image (`APP_VERSION` absent → `dev`) n'est pas une vraie machine du site : jamais déclaré dans HA. */
export function estCoeurDeDev(version: string | undefined): boolean {
  return version === 'dev';
}

/** Messages qui RETIRENT de HA les entités d'une machine (payload vide retenu sur chaque topic de découverte). */
export function machineRetrait(machineId: string): Array<{ topic: string; payload: '' }> {
  return machineDiscovery(machineId).map((m) => ({ topic: m.topic, payload: '' as const }));
}

/** Appareil « Docker Hub » : dernière version publiée. */
export function hubDiscovery(repository: string): DiscoveryMessage[] {
  return [{
    topic: `${DISCOVERY_PREFIX}/sensor/dimotic_hub/latest/config`,
    payload: {
      name: 'Dernière version', unique_id: 'dimotic_hub_latest', icon: 'mdi:docker', state_topic: HUB_LATEST_TOPIC,
      device: { identifiers: ['dimotic_ha_hub'], name: 'dimotic-ha — Docker Hub', manufacturer: 'Docker Hub', model: repository }
    }
  }];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Plus haute version `X.Y.Z` d'une liste de tags du hub (ni `latest` ni suffixes), `null` s'il n'y en a pas. */
export function latestVersion(tags: string[]): string | null {
  let best: { tag: string; n: number[] } | null = null;
  for (const tag of tags) {
    const m = SEMVER.exec(tag);
    if (!m) continue;
    const n = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || n[0] > best.n[0] || (n[0] === best.n[0] && (n[1] > best.n[1] || (n[1] === best.n[1] && n[2] > best.n[2])))) best = { tag, n };
  }
  return best?.tag ?? null;
}

/** Interroge le Docker Hub (API publique, sans compte) : tags du dépôt. Lève en cas d'échec. */
export async function fetchHubTags(repository: string, timeoutMs = 15000): Promise<string[]> {
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(repository)) throw new Error(`dépôt invalide : ${repository}`);
  const res = await fetch(`https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Docker Hub a répondu ${res.status}`);
  const json = (await res.json()) as { results?: Array<{ name?: string }> };
  return (json.results ?? []).map((r) => r.name ?? '').filter(Boolean);
}
