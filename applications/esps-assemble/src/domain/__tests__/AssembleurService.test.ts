import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AssembleurService, type TransportMqtt } from '../AssembleurService';
import { lireZip } from '../../../../esphome/dist/domain/factory/zip';
import { verifierPaquet } from '../../../../esphome/dist/domain/factory/manifest';

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const maintenant = () => new Date('2026-10-14T10:00:00Z');

class FauxTransport implements TransportMqtt {
  connecte = false; publications: { topic: string; payload: string; retain: boolean }[] = []; abonnements: string[] = [];
  private msg: ((m: { topic: string; payload: Buffer | string }) => void)[] = []; private conn: (() => void)[] = [];
  connect() { this.connecte = true; this.conn.forEach((c) => c()); }
  disconnect() { this.connecte = false; }
  publish(topic: string, payload: string | Buffer, _q = 0, retain = false) { this.publications.push({ topic, payload: payload.toString(), retain }); }
  subscribe(t: string) { this.abonnements.push(t); }
  onMessage(cb: (m: { topic: string; payload: Buffer | string }) => void) { this.msg.push(cb); }
  onConnect(cb: () => void) { this.conn.push(cb); }
  getConnected() { return this.connecte; }
  recevoir(topic: string, payload: string) { this.msg.forEach((m) => m({ topic, payload })); }
  derniere(topic: string) { return [...this.publications].reverse().find((p) => p.topic === topic); }
}

let app: string, donnees: string, evts: { e: string; d: any }[], transport: FauxTransport;
const ecrire = (rel: string, contenu: string) => { const f = path.join(app, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenu); };
const bus: any = { on() {}, onGeneric() {}, emit(e: string, d: any) { evts.push({ e, d }); } };
const provider = (c: unknown): any => ({ getAppConfig: () => c, reload() {} });
function service(conf: unknown = { site: 'stfort', revisionsGardees: 2 }) {
  return new AssembleurService(bus, logger, provider(conf), () => (transport = new FauxTransport()), app, donnees, 8087, maintenant);
}

beforeEach(() => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-app-')); donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-data-')); evts = [];
  ecrire('bibliotheque/materiels/carte/base.yaml', 'esp32:\n  board: esp32dev\n');
  ecrire('bibliotheque/materiels/carte/fiche.yaml', 'id: carte\nnom: Carte\nplateforme: esp32\npuce: esp32\ncadre: arduino\ncarte: esp32dev\nflash: 4MB\nmemoire: { emplacement_ota_octets: 1835008, ram_interne_octets: 327680 }\n');
  ecrire('appareils/ecran.yaml', 'esphome:\n  name: ecran\npackages:\n  materiel: !include bibliotheque/materiels/carte/base.yaml\n');
  ecrire('appareils/ecran.fiche.yaml', 'nom: ecran\nnom_affichage: "Écran"\nmateriel: carte\nesp:\n  adresse: 192.168.1.40\n');
});

describe('AssembleurService — assemblage et demande', () => {
  it('publie la demande conservée avec l\'adresse du paquet, dépose le paquet, que l\'usine accepte', async () => {
    const s = service({ site: 'stfort', adresseJoignable: '192.168.1.51:8087' }); await s.start();
    const r = s.demander({ appareil: 'ecran' });
    expect(r).toMatchObject({ ok: true, revision: 1, action: 'firmware' });
    const job = JSON.parse(transport.derniere('dimotic/esphome/stfort/jobs/ecran')!.payload);
    expect(transport.derniere('dimotic/esphome/stfort/jobs/ecran')!.retain).toBe(true);
    expect(job).toMatchObject({ v: 1, site: 'stfort', appareil: 'ecran', revision: 1, action: 'firmware', origine: '192.168.1.51:8087', paquet: 'http://192.168.1.51:8087/api/apps/esps-assemble/partage/paquets/ecran/r1.zip' });
    const zip = fs.readFileSync(path.join(donnees, 'machine_partage/paquets/ecran/r1.zip'));
    const verif = verifierPaquet(lireZip(zip));
    expect(verif.ok).toBe(true);
    expect(job.sha256).toBe(r.ok && r.sha256);
  });

  it('révision croissante, 2 dernières conservées, action amorce', async () => {
    const s = service(); await s.start();
    for (let i = 0; i < 3; i++) s.demander({ appareil: 'ecran' });
    expect(s.demander({ appareil: 'ecran', action: 'amorce' })).toMatchObject({ ok: true, revision: 4, action: 'amorce' });
    expect(fs.readdirSync(path.join(donnees, 'machine_partage/paquets/ecran')).sort()).toEqual(['r3.zip', 'r4.zip']);
    expect(JSON.parse(fs.readFileSync(path.join(donnees, 'revisions.json'), 'utf8'))).toEqual({ ecran: 4 });
  });

  it('refus : appareil refusé par les vérifications → rien publié, rien déposé, raisons données', async () => {
    ecrire('appareils/ecran.fiche.yaml', 'nom: ecran\nnom_affichage: "Écran"\nmateriel: autre\n');
    const s = service(); await s.start();
    const r = s.demander({ appareil: 'ecran' });
    expect(r.ok).toBe(false);
    expect(transport.publications.filter((p) => p.topic.includes('/jobs/'))).toEqual([]);
    expect(fs.existsSync(path.join(donnees, 'machine_partage'))).toBe(false);
  });

  it('refus : pas de connexion au broker, nom d\'appareil dangereux', async () => {
    const s = service(); // pas de start() : transport absent
    expect(s.demander({ appareil: 'ecran' })).toMatchObject({ ok: false, erreurs: [expect.stringContaining('broker MQTT')] });
    await s.start();
    expect(s.demander({ appareil: '../x' })).toMatchObject({ ok: false, erreurs: ['nom d\'appareil invalide'] });
  });

  it('annulation : message vide conservé sur la demande', async () => {
    const s = service(); await s.start();
    expect(s.annuler('ecran')).toBe(true);
    expect(transport.derniere('dimotic/esphome/stfort/jobs/ecran')).toEqual({ topic: 'dimotic/esphome/stfort/jobs/ecran', payload: '', retain: true });
    expect(s.annuler('../x')).toBe(false);
  });
});

describe('AssembleurService — état', () => {
  it('liste conservée des appareils publiée à la connexion (pour le bouton « Générer » de HA)', async () => {
    const s = service(); await s.start();
    const l = JSON.parse(transport.derniere('dimotic/esps-assemble/stfort/appareils')!.payload);
    expect(l).toMatchObject({ v: 1, site: 'stfort', appareils: [{ nom: 'ecran', nomAffichage: 'Écran' }] });
  });
  it('affiche le statut de l\'usine et la demande en attente reçus par MQTT', async () => {
    const s = service(); await s.start();
    transport.recevoir('dimotic/esphome/stfort/status/ecran', JSON.stringify({ v: 1, site: 'stfort', appareil: 'ecran', revision: 2, at: 'x', etat: 'compilation', detail: 'en cours' }));
    transport.recevoir('dimotic/esphome/stfort/jobs/ecran', JSON.stringify({ revision: 3, action: 'firmware' }));
    const l = s.lignes()[0];
    expect(l).toMatchObject({ nom: 'ecran', etat: 'pret', statut: { etat: 'compilation', revision: 2 }, demandeEnAttente: { revision: 3, action: 'firmware' } });
    transport.recevoir('dimotic/esphome/stfort/jobs/ecran', ''); // l'usine a pris la demande
    expect(s.lignes()[0].demandeEnAttente).toBeNull();
  });
  it('un appareil refusé est listé avec ses raisons', async () => {
    ecrire('appareils/ecran.fiche.yaml', 'nom: ecran\nnom_affichage: "Écran"\nmateriel: autre\n');
    const s = service(); await s.start();
    expect(s.lignes()[0]).toMatchObject({ etat: 'refuse' });
    expect(s.lignes()[0].erreurs.length).toBeGreaterThan(0);
  });
  it('message MQTT illisible : ignoré sans exception', async () => {
    const s = service(); await s.start();
    expect(() => transport.recevoir('dimotic/esphome/stfort/status/ecran', '{pas du json')).not.toThrow();
  });
});
