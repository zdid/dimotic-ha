/**
 * Mise en service d'un Tasmota neuf (fonctionnelles-tasmota_specs §6) — Wi-Fi de la machine basculé
 * sur le point d'accès du Tasmota par nmcli, envoi Wi-Fi + MQTT en HTTP, Wi-Fi remis dans son état
 * d'origine dans TOUS les cas. Procédure validée en réel le 28/09/2026 (falbala, hôte et conteneur).
 */

import { execFile } from 'node:child_process';

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

async function httpCommand(command: string, timeoutMs = 8000): Promise<string> {
  const url = `http://${AP_ADDRESS}/cm?cmnd=${encodeURIComponent(command)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return await response.text();
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
