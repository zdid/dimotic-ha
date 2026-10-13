import { describe, it, expect } from 'vitest';
import { lireSortieEsptool, normaliserPuce, normaliserFlash, juger, reconnaitre, ReconnaissanceEchouee, type ModeleFiche, type AppareilEnregistre } from '../Reconnaissance';
import type { DockerClient } from '../DockerApi';

const SORTIE_S3 = `esptool v5.1.0
Connected to ESP32-S3 on /dev/ttyACM0:
Chip type:          ESP32-S3 (QFN56) (revision v0.2)
Features:           Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB (AP_3v3)
Crystal frequency:  40MHz
MAC:                DC:DA:0C:AB:CD:EF

Stub flasher running.

Flash Memory Information:
=========================
Manufacturer: 46
Device: 4018
Detected flash size: 16MB
Flash type set in eFuse: quad (4 data lines)
Hard resetting via RTS pin...
`;
const SORTIE_C6 = SORTIE_S3.replace('ESP32-S3 (QFN56) (revision v0.2)', 'ESP32-C6 (QFN40) (revision v0.1)').replace('16MB', '8MB').replace('DC:DA:0C:AB:CD:EF', '60:55:F9:11:22:33');

const S3: ModeleFiche = { id: 'sunton-8048s070c', puce: 'esp32-s3', flash: '16MB' };
const C3: ModeleFiche = { id: 'sonoff-basic-r4', puce: 'esp32-c3', flash: '4MB' };
const connus: AppareilEnregistre[] = [{ appareil: 'haplan-display', mac: 'dc:da:0c:ab:cd:ef', modele: 'sunton-8048s070c' }];

describe('lecture de la sortie d\'esptool', () => {
  it('puce, MAC, flash et fonctions', () => {
    expect(lireSortieEsptool(SORTIE_S3)).toEqual({ puce: 'esp32-s3', puceBrute: 'ESP32-S3 (QFN56) (revision v0.2)', mac: 'dc:da:0c:ab:cd:ef', flash: '16MB', fonctions: ['Wi-Fi', 'BT 5 (LE)', 'Dual Core + LP Core', '240MHz', 'Embedded PSRAM 8MB (AP_3v3)'] });
    expect(lireSortieEsptool(SORTIE_C6)).toMatchObject({ puce: 'esp32-c6', flash: '8MB', mac: '60:55:f9:11:22:33' });
  });
  it('puces et flash normalisés', () => {
    expect(['ESP32-S3 (QFN56)', 'esp32s3', 'ESP32', 'ESP8266EX', 'ESP32-C3 (QFN32)'].map(normaliserPuce)).toEqual(['esp32-s3', 'esp32-s3', 'esp32', 'esp8266', 'esp32-c3']);
    expect([normaliserFlash('16MB'), normaliserFlash('4 Mo'), normaliserFlash('1M'), normaliserFlash(null), normaliserFlash('?')]).toEqual(['16MB', '4MB', '1MB', null, null]);
  });
  it('pas de carte : erreur lisible', () => {
    expect(() => lireSortieEsptool('A fatal error occurred: Could not open /dev/ttyUSB0, the port is busy or doesn\'t exist.')).toThrow(/carte non reconnue.*Could not open/);
    expect(() => lireSortieEsptool('n\'importe quoi')).toThrow(ReconnaissanceEchouee);
  });
});

describe('verdict (§5.4)', () => {
  const rel = lireSortieEsptool(SORTIE_S3);
  it('MAC déjà enregistrée : appareil connu, conforme à son modèle', () => {
    expect(juger(rel, [S3], connus)).toEqual({ type: 'appareil_connu', appareil: 'haplan-display', modele: 'sunton-8048s070c', conforme: true });
  });
  it('MAC inconnue mais un modèle correspond : nouvel exemplaire', () => {
    expect(juger(rel, [S3, C3], [])).toEqual({ type: 'nouvel_exemplaire', modeles: ['sunton-8048s070c'] });
  });
  it('MAC inconnue, aucun modèle ne correspond (C6 8 Mo) : carte inconnue avec proposition de fiche', () => {
    expect(juger(lireSortieEsptool(SORTIE_C6), [S3, C3], [])).toEqual({ type: 'carte_inconnue', propositionModele: { puce: 'esp32-c6', flash: '8MB' } });
  });
  it('carte choisie pour un modèle différent (Sonoff attendu, S3 branchée) : non conforme avec le détail', () => {
    expect(juger(rel, [S3, C3], [], C3)).toEqual({ type: 'non_conforme', attendu: C3, detail: 'détectée : ESP32-S3, 16 Mo ; la fiche attend ESP32-C3, 4 Mo' });
  });
  it('même puce mais flash différente : non conforme', () => {
    const v = juger(rel, [S3], [], { id: 'x', puce: 'esp32-s3', flash: '8MB' });
    expect(v).toMatchObject({ type: 'non_conforme', detail: 'détectée : ESP32-S3, 16 Mo ; la fiche attend ESP32-S3, 8 Mo' });
  });
  it('appareil connu mais carte d\'un autre modèle que sa fiche : signalé', () => {
    const v = juger(rel, [C3], [{ appareil: 'x', mac: rel.mac, modele: 'sonoff-basic-r4' }]);
    expect(v).toMatchObject({ type: 'appareil_connu', appareil: 'x', conforme: false });
  });
});

describe('reconnaitre (exec dans le conteneur ESPHome)', () => {
  const docker = (r: { codeSortie: number; sortie: string }, appels: string[][] = []): DockerClient => ({
    etat: async () => ({ existe: true, enMarche: true }), demarrer: async () => undefined,
    exec: async (_c, cmd) => { appels.push(cmd); return r; }
  });
  it('lance esptool flash-id (lecture seule) sur le bon port', async () => {
    const appels: string[][] = [];
    const rel = await reconnaitre(docker({ codeSortie: 0, sortie: SORTIE_S3 }, appels), 'esphome', '/dev/ttyACM0');
    expect(appels).toEqual([['esptool', '--port', '/dev/ttyACM0', 'flash-id']]);
    expect(rel.puce).toBe('esp32-s3');
  });
  it('esptool en échec : message avec la fin de la sortie', async () => {
    await expect(reconnaitre(docker({ codeSortie: 2, sortie: 'A fatal error occurred: Failed to connect to ESP32' }), 'esphome', '/dev/ttyUSB0')).rejects.toThrow(/code 2.*Failed to connect/);
  });
});
