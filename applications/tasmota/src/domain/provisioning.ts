/**
 * Mise en service d'un Tasmota neuf (fonctionnelles-tasmota_specs §6) — Wi-Fi de la machine basculé
 * sur le point d'accès du Tasmota par nmcli, envoi Wi-Fi + MQTT en HTTP, Wi-Fi remis dans son état
 * d'origine dans TOUS les cas. Procédure validée en réel le 28/09/2026 (falbala, hôte et conteneur).
 */

import { execFile } from 'node:child_process';
import { getIPv4Addresses } from '../../../core/dist/exports';

const AP_ADDRESS = '192.168.4.1';
const TEMP_CONNECTION = 'dimotic-tasmota-neuf';

export interface ProvisionCheck {
  available: boolean;
  reason?: string;
  wifiInterface?: string;
  ethernetInterface?: string;
  /** Connexion Wi-Fi active au moment de la vérification ('' = déconnecté). */
  wifiConnection?: string;
}

export interface ProvisionParams {
  ssid: string;
  password: string;
  mqttHost: string;
  mqttPort: number;
}

export type ProvisionLog = (message: string, level?: 'info' | 'ok' | 'error') => void;

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr || (error ? String(error.message) : '') });
    });
  });
}

/** Lignes `nmcli -t` : champs séparés par ':' (les ':' des valeurs sont échappés en '\:'). */
function parseTerse(stdout: string): string[][] {
  return stdout.split('\n').filter(Boolean).map((line) => line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':')));
}

export async function checkProvisioning(): Promise<ProvisionCheck> {
  const devices = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  if (devices.code !== 0) {
    const reason = /ENOENT|not found/i.test(devices.stderr)
      ? "nmcli absent sur cette machine (NetworkManager requis — rien n'est prévu sans lui)"
      : `NetworkManager injoignable : ${devices.stderr.trim().split('\n')[0]}`;
    return { available: false, reason };
  }
  const rows = parseTerse(devices.stdout);
  const ethernet = rows.find((r) => r[1] === 'ethernet' && r[2] === 'connected');
  const wifi = rows.find((r) => r[1] === 'wifi' && r[2] !== 'unavailable' && r[2] !== 'unmanaged');
  if (!ethernet) return { available: false, reason: "Aucune connexion Ethernet active : la domotique doit passer par l'Ethernet pendant que le Wi-Fi est basculé" };
  if (!wifi) return { available: false, reason: 'Aucune interface Wi-Fi gérée par NetworkManager sur cette machine', ethernetInterface: ethernet[0] };
  return {
    available: true,
    wifiInterface: wifi[0],
    ethernetInterface: ethernet[0],
    wifiConnection: wifi[2] === 'connected' ? (wifi[3] ?? '') : ''
  };
}

/** Points d'accès `tasmota-*` à portée. */
export async function scanTasmotaAccessPoints(wifiInterface: string): Promise<Array<{ ssid: string; signal: number }>> {
  const result = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL', 'device', 'wifi', 'list', 'ifname', wifiInterface, '--rescan', 'yes'], 45_000);
  if (result.code !== 0) throw new Error(`Recherche Wi-Fi impossible : ${result.stderr.trim()}`);
  const seen = new Map<string, number>();
  for (const [ssid, signal] of parseTerse(result.stdout)) {
    if (!ssid || !/^tasmota[-_]/i.test(ssid)) continue;
    seen.set(ssid, Math.max(seen.get(ssid) ?? 0, Number(signal) || 0));
  }
  return [...seen.entries()].map(([ssid, signal]) => ({ ssid, signal })).sort((a, b) => b.signal - a.signal);
}

async function httpCommandAt(host: string, command: string, timeoutMs = 8000): Promise<string> {
  const url = `http://${host}/cm?cmnd=${encodeURIComponent(command)}`;
  // ⭐ 29/09/2026 — Referer obligatoire : un Tasmota récent (constaté en 15.6.0, contrôle du
  // référent SetOption128) ferme la connexion sans rien répondre à /cm sans cet en-tête.
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Referer: `http://${host}/` } });
  return await response.text();
}

async function httpCommand(command: string, timeoutMs = 8000): Promise<string> {
  return httpCommandAt(AP_ADDRESS, command, timeoutMs);
}

async function waitForAddress(wifiInterface: string, log: ProvisionLog): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', wifiInterface]);
    if (/inet 192\.168\.4\./.test(r.stdout)) {
      log(`Adresse obtenue sur le réseau du Tasmota : ${/inet (\S+)/.exec(r.stdout)?.[1] ?? '?'}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Pas d'adresse 192.168.4.x sur le Wi-Fi après 20 s");
}

/**
 * Déroulé complet. Retourne la MAC lue sur l'appareil (Status 0), ou lève une Error après avoir
 * restauré le Wi-Fi.
 */
export async function provisionNewDevice(apSsid: string, params: ProvisionParams, log: ProvisionLog): Promise<{ mac?: string }> {
  const check = await checkProvisioning();
  if (!check.available || !check.wifiInterface) throw new Error(check.reason ?? 'Mise en service indisponible');
  const ifname = check.wifiInterface;
  const origin = check.wifiConnection ?? '';
  const mask = (text: string): string => (params.password ? text.split(params.password).join('****') : text);
  log(`Wi-Fi ${ifname} — état d'origine : ${origin ? `connecté à « ${origin} »` : 'déconnecté'} ; Ethernet ${check.ethernetInterface} inchangé`);

  let mac: string | undefined;
  try {
    await run('nmcli', ['connection', 'delete', TEMP_CONNECTION]);
    const add = await run('nmcli', ['connection', 'add', 'type', 'wifi', 'ifname', ifname, 'con-name', TEMP_CONNECTION,
      'ssid', apSsid, 'autoconnect', 'no', 'ipv4.method', 'auto', 'ipv4.never-default', 'yes', 'ipv6.method', 'disabled']);
    if (add.code !== 0) throw new Error(`Création de la connexion temporaire impossible : ${add.stderr.trim()}`);
    log(`Connexion au point d'accès « ${apSsid} »…`);
    const up = await run('nmcli', ['connection', 'up', TEMP_CONNECTION], 60_000);
    if (up.code !== 0) throw new Error(`Connexion au point d'accès impossible : ${up.stderr.trim()}`);
    await waitForAddress(ifname, log);

    const status = await httpCommand('Status 0');
    let parsed: { Status?: { DeviceName?: string; Topic?: string }; StatusNET?: { Mac?: string }; StatusLOG?: { SSId?: string[] }; StatusFWR?: { Version?: string } };
    try {
      parsed = JSON.parse(status);
    } catch {
      throw new Error("Le Tasmota ne répond pas aux commandes (/cm) : il n'est pas sorti d'usine (mode gestionnaire Wi-Fi ?)");
    }
    mac = parsed.StatusNET?.Mac?.replace(/:/g, '').toUpperCase();
    log(`Tasmota lu : nom « ${parsed.Status?.DeviceName ?? '?'} », topic ${parsed.Status?.Topic ?? '?'}, version ${parsed.StatusFWR?.Version ?? '?'}, MAC ${mac ?? '?'}, Wi-Fi enregistré : ${(parsed.StatusLOG?.SSId ?? []).filter(Boolean).join(', ') || 'aucun'}`, 'ok');

    const backlog = `Backlog SSID1 ${params.ssid}; Password1 ${params.password}; MqttHost ${params.mqttHost}; MqttPort ${params.mqttPort}`;
    log(`Envoi : ${mask(backlog)}`);
    const reply = await httpCommand(backlog);
    log(`Réponse du Tasmota : ${mask(reply) || '(vide)'}`, 'ok');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    await restoreWifi(ifname, origin, log);
  }
  return { mac };
}

// =============================================================================
// Recherche des Tasmota déjà connectés au réseau (distincte de la mise en service d'un neuf
// ci-dessus, qui cherche un POINT D'ACCÈS Wi-Fi — ici l'appareil a déjà rejoint le réseau normal,
// on le trouve par une requête HTTP active sur chaque adresse du sous-réseau).
// =============================================================================

export interface NetworkTasmota {
  mac: string;
  ip: string;
  deviceName?: string;
  topic?: string;
  mqttHost?: string;
  mqttPort?: number;
  firmware?: string;
  /** Nom du modèle (commande `Module`, ex. « Sonoff Basic R4 », « Generic ») — `Status 0` n'en donne
   *  que le numéro. */
  model?: string;
  /** Puce (StatusFWR.Hardware, ex. « ESP8266EX », « ESP32-C3 v0.4 »). */
  hardware?: string;
  /** Contenu réel du modèle : broches utilisées et leur rôle (commande `Gpio 255`, qui répond aussi
   *  pour un modèle figé, là où `Gpio` seul répond « Not supported »), ex. « GPIO5 : Relay1 ». Nom
   *  du rôle dans la langue du firmware. */
  pins?: string[];
  /** Déjà dans la liste (ancienne annonce sur notre broker) mais pointe ailleurs — renseigné par
   *  TasmotaService, pas par la recherche. */
  known?: boolean;
}

const SCAN_TIMEOUT_MS = 700;
const SCAN_CONCURRENCY = 32;

/**
 * Balaie le sous-réseau IPv4 principal de cette machine (adresse Ethernet préférée, /24 supposé —
 * limite acceptée : un Tasmota joignable seulement par un autre sous-réseau ne sera pas trouvé) :
 * une requête `Status 0` par adresse, courte et sans mot de passe. Un appareil déjà protégé par un
 * mot de passe web ne répond pas en JSON exploitable et n'est donc pas détecté (limite acceptée).
 */
export async function scanNetworkForTasmota(log: ProvisionLog): Promise<NetworkTasmota[]> {
  const local = getIPv4Addresses()[0];
  if (!local || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(local)) {
    throw new Error('Aucune adresse IPv4 locale trouvée — recherche impossible');
  }
  const parts = local.split('.');
  const base = parts.slice(0, 3).join('.');
  const own = Number(parts[3]);
  const hosts = Array.from({ length: 254 }, (_, i) => i + 1).filter((n) => n !== own).map((n) => `${base}.${n}`);
  log(`Recherche sur ${base}.0/24 (${hosts.length} adresses, quelques secondes)…`);

  const found: NetworkTasmota[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < hosts.length) {
      const ip = hosts[index++];
      try {
        const text = await httpCommandAt(ip, 'Status 0', SCAN_TIMEOUT_MS);
        const parsed = JSON.parse(text) as {
          Status?: { DeviceName?: string; Topic?: string };
          StatusNET?: { Mac?: string };
          StatusFWR?: { Version?: string; Hardware?: string };
          StatusMQT?: { MqttHost?: string; MqttPort?: number };
        };
        const mac = parsed.StatusNET?.Mac?.replace(/:/g, '').toUpperCase();
        if (!mac || !parsed.StatusFWR?.Version) continue; // pas un Tasmota (ou réponse incomplète)
        // Nom du modèle : une requête de plus, seulement pour les Tasmota trouvés (réponse
        // {"Module":{"<n>":"<nom>"}}).
        let model: string | undefined;
        try {
          const m = JSON.parse(await httpCommandAt(ip, 'Module', 3000)) as { Module?: Record<string, string> };
          model = m.Module ? Object.values(m.Module)[0] : undefined;
        } catch { /* modèle facultatif */ }
        let pins: string[] | undefined;
        try {
          const g = JSON.parse(await httpCommandAt(ip, 'Gpio 255', 3000)) as Record<string, Record<string, number>>;
          pins = Object.entries(g).flatMap(([gpio, role]) =>
            Object.entries(role ?? {}).filter(([, code]) => code !== 0).map(([name]) => `${gpio} : ${name}`));
        } catch { /* broches facultatives */ }
        found.push({
          mac,
          ip,
          deviceName: parsed.Status?.DeviceName,
          topic: parsed.Status?.Topic,
          mqttHost: parsed.StatusMQT?.MqttHost,
          mqttPort: parsed.StatusMQT?.MqttPort,
          firmware: parsed.StatusFWR.Version,
          model,
          hardware: parsed.StatusFWR.Hardware,
          pins
        });
      } catch {
        // Hôte injoignable, pas de serveur HTTP, pas du JSON exploitable (mot de passe web…) : ignoré.
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  log(`Recherche terminée : ${found.length} Tasmota trouvé(s) sur le réseau.`, 'ok');
  return found;
}

/** Pointe un Tasmota déjà sur le réseau vers notre broker, par HTTP direct — pas de bascule Wi-Fi
 *  nécessaire puisqu'il y est déjà. */
export async function pointToBroker(ip: string, mqttHost: string, mqttPort: number, log: ProvisionLog): Promise<void> {
  log(`Envoi à ${ip} : MqttHost ${mqttHost}; MqttPort ${mqttPort}`);
  const reply = await httpCommandAt(ip, `Backlog MqttHost ${mqttHost}; MqttPort ${mqttPort}`, 8000);
  log(`Réponse : ${reply || '(vide)'}`, 'ok');
}

async function restoreWifi(ifname: string, origin: string, log: ProvisionLog): Promise<void> {
  await run('nmcli', ['connection', 'down', TEMP_CONNECTION]);
  await run('nmcli', ['connection', 'delete', TEMP_CONNECTION]);
  if (origin) {
    const up = await run('nmcli', ['connection', 'up', origin], 60_000);
    log(up.code === 0 ? `Wi-Fi remis sur « ${origin} »` : `⚠️ Reconnexion de « ${origin} » impossible : ${up.stderr.trim()}`, up.code === 0 ? 'ok' : 'error');
  } else {
    // Sans ça NetworkManager reconnecte seul un profil existant (constaté le 28/09/2026).
    await run('nmcli', ['device', 'disconnect', ifname]);
    log('Wi-Fi remis à l’état déconnecté', 'ok');
  }
}
