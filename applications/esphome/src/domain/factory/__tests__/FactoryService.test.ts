import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { faireZip } from './zip-test';
import { FactoryService, type DepsUsine } from '../FactoryService';
import { SecretsStore } from '../SecretsStore';
import { sha256 } from '../manifest';
import type { DockerClient } from '../DockerApi';
import type { Job } from '../../messages';

const yaml = 'esphome:\n  name: hasat4\n';
const SORTIE_OK = 'RAM:   [=  ]   9.9% (used 32388 bytes from 327680 bytes)\nFlash: [==  ]  41.4% (used 760037 bytes from 1835008 bytes)\n';

function paquet(extra: Record<string, unknown> = {}, appareil = 'hasat4', revision = 3): Buffer {
  const fichiers = { [`${appareil}.yaml`]: yaml };
  const manifeste = {
    v: 1, appareil, nomAffichage: 'Satellite 4', revision, assemble: '2026-10-13T18:00:00+02:00',
    modele: { id: 'waveshare', puce: 'esp32-s3', flash: '16MB', cadre: 'esp-idf', memoire: { emplacementOtaOctets: 6_000_000, ramInterneOctets: 327680 } },
    esp: { adresse: '192.168.1.44' }, options: { autoriserAppelsService: false }, wifi: ['stfort'],
    fichiers: Object.fromEntries(Object.entries(fichiers).map(([k, v]) => [k, sha256(Buffer.from(v))])), ...extra
  };
  return faireZip({ 'manifest.json': JSON.stringify(manifeste), ...fichiers }, { deflate: true });
}
const jobPour = (z: Buffer, o: Partial<Job> = {}): Job => ({ v: 1, site: 'stfort', appareil: 'hasat4', revision: 3, at: '2026-10-13T18:00:00+02:00', action: 'firmware', origine: 'x', paquet: 'http://h/p.zip', sha256: sha256(z), ...o });

let racine: string, evts: string[], deps: DepsUsine, secrets: SecretsStore, docker: DockerClient & { appels: string[] };
let pose: any, statuts: any[];
let reponse: { codeSortie: number; sortie: string }, firmwareOctets: number, telechargement: () => Promise<Buffer>;

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'usine-'));
  evts = []; statuts = []; pose = null; reponse = { codeSortie: 0, sortie: SORTIE_OK }; firmwareOctets = 1_000_000;
  const config = path.join(racine, 'config'); fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'secrets.yaml'), 'api_haplan-display: "ancienne"\n');
  secrets = new SecretsStore(path.join(config, 'secrets.yaml'), () => 'CLE-NEUVE');
  docker = {
    appels: [],
    async etat() { return { existe: true, enMarche: true }; },
    async demarrer() { this.appels.push('demarrer'); },
    async exec(_c: string, cmd: string[]) {
      this.appels.push(cmd.join(' '));
      const b = path.join(config, '.esphome/build/hasat4/.pioenvs/hasat4'); fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(path.join(b, 'firmware.ota.bin'), Buffer.alloc(firmwareOctets, 7));
      return reponse;
    }
  } as any;
  deps = {
    telecharger: () => telechargement(), docker, secrets,
    publication: {
      statut: (_s, _a, etat, extra) => { evts.push(`statut:${etat}`); statuts.push({ etat, ...extra }); },
      pose: (_s, _a, p) => { evts.push('pose'); pose = p; },
      supprimerDemande: () => evts.push('supprime')
    },
    dossierConfig: config, cheminDansConteneur: '/config', conteneur: 'esphome',
    partage: { dossier: path.join(racine, 'partage'), url: 'http://192.168.1.26:8087/api/apps/esphome/partage' }, revisionsGardees: 2
  };
});

describe('FactoryService — chemin nominal', () => {
  it('appareil neuf : dépôt, suppression de la demande, clé, compilation, firmware publié, pose avec la clé', async () => {
    const z = paquet(); telechargement = async () => z;
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('termine');

    expect(evts).toEqual(['statut:recuperation', 'supprime', 'statut:compilation', 'pose', 'statut:pret_a_poser']);
    expect(fs.readFileSync(path.join(deps.dossierConfig, 'hasat4.yaml'), 'utf8')).toBe(yaml);
    expect(docker.appels).toEqual(['esphome compile /config/hasat4.yaml']);
    expect(fs.readFileSync(path.join(deps.dossierConfig, 'secrets.yaml'), 'utf8')).toContain('api_hasat4: "CLE-NEUVE"');
    const publie = fs.readFileSync(path.join(deps.partage.dossier, 'firmwares/hasat4/3/firmware.bin'));
    expect(publie).toHaveLength(1_000_000);
    expect(pose).toMatchObject({ appareil: 'hasat4', revision: 3, esp: '192.168.1.44', nomAffichage: 'Satellite 4', cle: 'CLE-NEUVE', tailleOctets: 1_000_000, sha256: sha256(publie), firmware: 'http://192.168.1.26:8087/api/apps/esphome/partage/firmwares/hasat4/3/firmware.bin' });
    expect(statuts[statuts.length - 1].mesures).toMatchObject({ flashUtilisee: 760037, ramDisponible: 327680, tailleOctets: 1_000_000 });
  });

  it('secrets référencés absents du secrets.yaml : échec clair AVANT tout dépôt et toute compilation', async () => {
    fs.writeFileSync(path.join(deps.dossierConfig, 'secrets.yaml'), 'wifi_ssid: "x"\n');
    const z = paquet({ secrets: ['wifi_ssid', 'wifi_stfort_secours_password'] }); telechargement = async () => z;
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts[statuts.length - 1]).toMatchObject({ etat: 'echec' });
    expect(statuts[statuts.length - 1].detail).toContain('wifi_stfort_secours_password');
    expect(statuts[statuts.length - 1].detail).not.toContain('wifi_ssid');
    expect(docker.appels).toEqual([]);
    expect(fs.existsSync(path.join(deps.dossierConfig, 'hasat4.yaml'))).toBe(false);
  });

  it('appareil déjà en service : pas de nouvelle clé dans la pose, secrets.yaml inchangé', async () => {
    const z = paquet({}, 'haplan-display'); telechargement = async () => z;
    docker.exec = async function (this: any) { const b = path.join(deps.dossierConfig, '.esphome/build/haplan-display/.pioenvs/haplan-display'); fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'firmware.bin'), Buffer.alloc(500, 1)); return reponse; } as any;
    expect(await new FactoryService(deps).traiter(jobPour(z, { appareil: 'haplan-display' }))).toBe('termine');
    expect(pose.cle).toBeUndefined();
    expect(fs.readFileSync(path.join(deps.dossierConfig, 'secrets.yaml'), 'utf8')).toBe('api_haplan-display: "ancienne"\n');
  });

  it('démarre le conteneur ESPHome s\'il est arrêté', async () => {
    const z = paquet(); telechargement = async () => z;
    docker.etat = async () => ({ existe: true, enMarche: false });
    await new FactoryService(deps).traiter(jobPour(z));
    expect(docker.appels[0]).toBe('demarrer');
  });

  it('garde les N dernières révisions du firmware publié', async () => {
    for (const rev of [1, 2, 3]) {
      const z = paquet({ revision: rev }, 'hasat4', rev); telechargement = async () => z;
      await new FactoryService(deps).traiter(jobPour(z, { revision: rev }));
    }
    expect(fs.readdirSync(path.join(deps.partage.dossier, 'firmwares/hasat4')).sort()).toEqual(['2', '3']);
  });

  it('amorce : firmware publié sous un autre nom, aucun message de pose', async () => {
    const z = paquet(); telechargement = async () => z;
    docker.exec = async function (this: any) { const b = path.join(deps.dossierConfig, '.esphome/build/hasat4/.pioenvs/hasat4'); fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'firmware.factory.bin'), Buffer.alloc(900, 2)); return reponse; } as any;
    expect(await new FactoryService(deps).traiter(jobPour(z, { action: 'amorce' }))).toBe('termine');
    expect(pose).toBeNull();
    expect(fs.existsSync(path.join(deps.partage.dossier, 'firmwares/hasat4/3/amorce.bin'))).toBe(true);
  });
});

describe('FactoryService — échecs', () => {
  it('paquet inaccessible ou corrompu : la demande est CONSERVÉE (à réessayer), rien n\'est déposé', async () => {
    const z = paquet();
    telechargement = async () => { throw new Error('connexion refusée'); };
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('a_reessayer');
    telechargement = async () => paquet({ nomAffichage: 'autre' });
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('a_reessayer');
    expect(evts).not.toContain('supprime');
    expect(fs.existsSync(path.join(deps.dossierConfig, 'hasat4.yaml'))).toBe(false);
  });

  it('manifeste invalide : échec, demande supprimée, aucune compilation', async () => {
    const z = faireZip({ 'hasat4.yaml': yaml }); telechargement = async () => z;
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toBe('manifest.json absent du paquet');
    expect(evts).toContain('supprime'); expect(docker.appels).toEqual([]);
  });

  it('manifeste d\'un autre appareil ou d\'une autre révision que la demande : refusé', async () => {
    const z = paquet({}, 'hasat4', 9); telechargement = async () => z;
    expect(await new FactoryService(deps).traiter(jobPour(z, { revision: 3 }))).toBe('echec');
    expect(statuts.pop().detail).toContain('ne correspond pas à la demande');
  });

  it('archive avec chemin dangereux : refusée', async () => {
    const z = faireZip({ '../evil': 'x' }); telechargement = async () => z;
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toContain('paquet illisible');
  });

  it('compilation ratée : échec avec la fin du journal, demande supprimée, rien publié', async () => {
    const z = paquet(); telechargement = async () => z;
    reponse = { codeSortie: 2, sortie: 'ERROR Unknown platform \'foo\'' };
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toContain("Unknown platform 'foo'");
    expect(pose).toBeNull();
  });

  it('firmware trop gros pour l\'emplacement du modèle : refus avant toute publication', async () => {
    const z = paquet(); telechargement = async () => z; firmwareOctets = 6_500_000;
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toBe("le firmware (6500000 octets) ne tient pas dans l'emplacement (6000000 octets) du modèle");
    expect(pose).toBeNull();
    expect(fs.existsSync(path.join(deps.partage.dossier, 'firmwares'))).toBe(false);
  });

  it('conteneur ESPHome introuvable ou Docker en panne : échec explicite', async () => {
    const z = paquet(); telechargement = async () => z;
    docker.etat = async () => ({ existe: false, enMarche: false });
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toBe('conteneur esphome introuvable');
    docker.etat = async () => { throw new Error('socket refusé'); };
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('echec');
    expect(statuts.pop().detail).toContain('ESPHome injoignable : socket refusé');
  });

  it('sans ligne RAM / flash dans la sortie : avertissement, firmware quand même publié', async () => {
    const z = paquet(); telechargement = async () => z; reponse = { codeSortie: 0, sortie: 'ok' };
    expect(await new FactoryService(deps).traiter(jobPour(z))).toBe('termine');
    expect(statuts.pop().detail).toContain('occupation RAM / flash non relevée');
  });
});
