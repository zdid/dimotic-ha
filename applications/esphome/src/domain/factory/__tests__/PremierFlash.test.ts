import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Catalogue } from '../Catalogue';
import { flasherParUsb, type DepsPremierFlash } from '../PremierFlash';
import type { DockerClient } from '../DockerApi';

const SORTIE = (puce: string, flash: string, mac: string) => `Chip type:          ${puce}\nMAC:                ${mac}\nDetected flash size: ${flash}\nFeatures: Wi-Fi\n`;
let cat: Catalogue, appels: string[][], reponses: { codeSortie: number; sortie: string }[], deps: DepsPremierFlash;

beforeEach(() => {
  cat = new Catalogue(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cat-')), 'catalogue.json'));
  cat.noterPaquet({ id: 'esp8266-4mb', puce: 'esp8266', flash: '4MB' }, 'essai-esp8266');
  appels = []; reponses = [];
  const docker: DockerClient = { etat: async () => ({ existe: true, enMarche: true }), demarrer: async () => undefined, exec: async (_c, cmd) => { appels.push(cmd); return reponses.shift()!; } };
  deps = { docker, catalogue: cat, conteneur: 'esphome', cheminDansConteneur: '/config', peripherique: '/dev/ttyUSB0' };
});

describe('Catalogue', () => {
  it('note le modèle et l\'appareil d\'un paquet, puis la MAC ; fichier absent = catalogue vide', () => {
    expect(new Catalogue('/inexistant/c.json').lire()).toEqual({ modeles: [], appareils: [] });
    cat.noterMac('essai-esp8266', 'DC:4F:22:4A:D4:9C');
    expect(cat.lire().appareils).toEqual([{ appareil: 'essai-esp8266', modele: 'esp8266-4mb', mac: 'dc:4f:22:4a:d4:9c' }]);
    cat.noterPaquet({ id: 'esp8266-4mb', puce: 'esp8266', flash: '4MB' }, 'essai-esp8266'); // nouveau paquet : la MAC est conservée
    expect(cat.appareilsAvecMac()).toHaveLength(1);
    expect(() => cat.noterMac('inconnu', 'aa:bb:cc:dd:ee:ff')).toThrow(/inconnu/);
  });
});

describe('premier flash USB', () => {
  it('carte conforme : reconnaissance puis esphome upload sur le bon port, MAC enregistrée', async () => {
    reponses = [{ codeSortie: 0, sortie: SORTIE('ESP8266EX', '4MB', 'dc:4f:22:4a:d4:9c') }, { codeSortie: 0, sortie: 'INFO Upload successful' }];
    const r = await flasherParUsb(deps, 'essai-esp8266');
    expect(r.ok).toBe(true);
    expect(appels).toEqual([['esptool', '--port', '/dev/ttyUSB0', 'flash-id'], ['esphome', 'upload', '/config/essai-esp8266.yaml', '--device', '/dev/ttyUSB0']]);
    expect(cat.lire().appareils[0].mac).toBe('dc:4f:22:4a:d4:9c');
  });

  it('carte d\'un autre modèle : refus AVANT tout flash, aucune écriture', async () => {
    reponses = [{ codeSortie: 0, sortie: SORTIE('ESP32-S3 (QFN56)', '16MB', 'aa:aa:aa:aa:aa:aa') }];
    const r = await flasherParUsb(deps, 'essai-esp8266');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.raison).toContain('détectée : ESP32-S3, 16 Mo ; la fiche attend ESP8266, 4 Mo');
    expect(appels).toHaveLength(1); // seulement la lecture
    expect(cat.lire().appareils[0].mac).toBeUndefined();
  });

  it('carte déjà enregistrée sous un AUTRE appareil : refus de l\'écraser', async () => {
    cat.noterPaquet({ id: 'esp8266-4mb', puce: 'esp8266', flash: '4MB' }, 'autre');
    cat.noterMac('autre', 'dc:4f:22:4a:d4:9c');
    reponses = [{ codeSortie: 0, sortie: SORTIE('ESP8266EX', '4MB', 'DC:4F:22:4A:D4:9C') }];
    const r = await flasherParUsb(deps, 'essai-esp8266');
    expect(!r.ok && r.raison).toContain('déjà l\'appareil « autre »');
    expect(appels).toHaveLength(1);
  });

  it('même appareil déjà flashé (reflash de la même carte) : accepté', async () => {
    cat.noterMac('essai-esp8266', 'dc:4f:22:4a:d4:9c');
    reponses = [{ codeSortie: 0, sortie: SORTIE('ESP8266EX', '4MB', 'dc:4f:22:4a:d4:9c') }, { codeSortie: 0, sortie: 'ok' }];
    expect((await flasherParUsb(deps, 'essai-esp8266')).ok).toBe(true);
  });

  it('aucune carte, appareil inconnu, flash raté : messages clairs, MAC non enregistrée', async () => {
    reponses = [{ codeSortie: 2, sortie: 'A fatal error occurred: Could not open /dev/ttyUSB0' }];
    expect((await flasherParUsb(deps, 'essai-esp8266') as any).raison).toContain('Could not open');
    expect((await flasherParUsb(deps, 'inconnu') as any).raison).toContain('inconnu');
    reponses = [{ codeSortie: 0, sortie: SORTIE('ESP8266EX', '4MB', 'dc:4f:22:4a:d4:9c') }, { codeSortie: 1, sortie: 'ERROR Serial port busy' }];
    const r = await flasherParUsb(deps, 'essai-esp8266');
    expect(!r.ok && r.raison).toContain('flash USB raté (code 1)');
    expect(cat.lire().appareils[0].mac).toBeUndefined();
  });
});
