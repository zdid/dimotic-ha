import { describe, it, expect, vi, afterEach } from 'vitest';
import { FauxBroker } from './faux-broker';
import { EsphomeService } from '../EsphomeService';
import { esphomeConfigSchema } from '../config-schema';
import { topics } from '../messages';
import { AgentPresence } from '../AgentPresence';
import type { TraiteurUsine, FabriqueTraiteur, FabriquePoseur, TraiteurPoseur } from '../EsphomeService';
import type { Pose } from '../messages';
import type { PublicationPoseur } from '../installer/InstallerService';
import type { Job } from '../messages';
import type { ResultatTraitement, PublicationUsine } from '../factory/FactoryService';

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const bus: any = { handlers: {} as Record<string, Function>, emitted: [] as { e: string; d: any }[], on(e: string, cb: Function) { this.handlers[e] = cb; }, onGeneric(e: string, cb: Function) { this.handlers[e] = cb; }, emit(e: string, d: any) { this.emitted.push({ e, d }); } };
const provider = (conf: unknown): any => ({ getAppConfig: () => conf, reload() {} });
const job = (rev: number, appareil = 'hasat4') => ({ v: 1, site: 'stfort', appareil, revision: rev, at: '2026-10-13T18:00:00+02:00', action: 'firmware', origine: 'x', paquet: 'http://h/p.zip', sha256: 'c'.repeat(64) });

afterEach(() => { vi.useRealTimers(); bus.emitted.length = 0; });

/** Traiteur d'essai : chaque demande attend qu'on la libère (`liberer(resultat)`), ce qui permet d'observer la file. */
function traiteurManuel() {
  const vus: Job[] = [];
  const attente: ((r: ResultatTraitement) => void)[] = [];
  let publication!: PublicationUsine;
  const fabrique: FabriqueTraiteur = (_c, _i, p) => { publication = p; return { traiter: (job) => new Promise((res) => { vus.push(job); attente.push(res); }) } as TraiteurUsine; };
  return { vus, fabrique, liberer: (r: ResultatTraitement = 'termine') => attente.shift()!(r), publication: () => publication };
}

function service(brokers: Record<string, FauxBroker>, conf: unknown, identite = { instance: 'falbala_410210', port: 8087 }, traiteur: FabriqueTraiteur = traiteurManuel().fabrique) {
  const fabrique = ({ broker, willTopic, willPayload }: any) => brokers[broker.hote].transport({ topic: willTopic, payload: willPayload });
  return EsphomeService.create(bus, logger, provider(conf), fabrique, identite, traiteur);
}
const confUsine = { site: 'stfort', usine: { actif: true, machine: 'falbala', sites: [{ id: 'stfort', mqtt: { hote: 'ha2' } }, { id: 'noisy', mqtt: { hote: 'noisy2' } }] } };

describe('EsphomeService — usine (réception des demandes)', () => {
  it('liste une demande conservée, ignore une révision déjà traitée ou plus ancienne, retire une demande annulée', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const noisy2 = new FauxBroker();
    ha2.publier(topics.job('stfort', 'hasat4'), JSON.stringify(job(3)), true); // demande déposée AVANT le démarrage de l'usine
    const s = service({ ha2, noisy2 }, confUsine);
    await s.start();

    expect(s.getStatus().usine.demandes.map((d) => `${d.site}/${d.appareil}@${d.revision}`)).toEqual(['stfort/hasat4@3']);
    expect(s.getStatus().usine.connexions).toEqual([{ site: 'stfort', connecte: true }, { site: 'noisy', connecte: true }]);

    ha2.publier(topics.job('stfort', 'hasat4'), JSON.stringify(job(4)), true); // plus récente : remplace
    expect(s.getStatus().usine.demandes[0].revision).toBe(4);

    ha2.publier(topics.job('stfort', 'hasat4'), '', true); // annulation
    expect(s.getStatus().usine.demandes).toEqual([]);
    await s.stop();
  });

  it('une demande du site noisy ne vient que du broker de noisy (sites étanches)', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const noisy2 = new FauxBroker();
    const s = service({ ha2, noisy2 }, confUsine);
    await s.start();
    noisy2.publier(topics.job('noisy', 'ecran-chambre'), JSON.stringify({ ...job(1, 'ecran-chambre'), site: 'noisy' }), true);
    ha2.publier(topics.job('noisy', 'ecran-intrus'), JSON.stringify({ ...job(1, 'ecran-intrus'), site: 'noisy' }), true); // mauvais broker pour ce site
    expect(s.getStatus().usine.demandes.map((d) => d.appareil)).toEqual(['ecran-chambre']);
    await s.stop();
  });

  it('une demande invalide n\'arrête rien', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const s = service({ ha2, noisy2: new FauxBroker() }, confUsine);
    await s.start();
    ha2.publier(topics.job('stfort', 'x'), '{"v":1,"bidon":true}', true);
    ha2.publier(topics.job('stfort', 'hasat5'), JSON.stringify(job(1, 'hasat5')), true);
    expect(s.getStatus().usine.demandes.map((d) => d.appareil)).toEqual(['hasat5']);
    await s.stop();
  });

  it('en retrait (autre usine déjà active) : aucune demande n\'est traitée, la raison est donnée', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const autre = { instance: 'falbala_817412', port: 8088 };
    ha2.publier(topics.usine('falbala'), JSON.stringify({ v: 1, enLigne: true, ...autre, at: '2026-10-13T17:00:00+02:00' }), true);
    const s = service({ ha2, noisy2: new FauxBroker() }, confUsine);
    await s.start();
    expect(s.getStatus().usine.enRetrait).toBe('un autre agent est déjà actif : instance falbala_817412, port 8088');
    ha2.publier(topics.job('stfort', 'hasat4'), JSON.stringify(job(1)), true);
    expect(s.getStatus().usine.demandes).toEqual([]);
    await s.stop();
  });

  it('annonce sa présence après un court délai, sur chaque broker servi', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const noisy2 = new FauxBroker();
    const s = service({ ha2, noisy2 }, confUsine);
    await s.start();
    expect(ha2.conserves.has(topics.usine('falbala'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1600);
    expect(JSON.parse(ha2.conserves.get(topics.usine('falbala'))!)).toMatchObject({ enLigne: true, instance: 'falbala_410210', port: 8087 });
    expect(noisy2.conserves.has(topics.usine('falbala'))).toBe(true);
    await s.stop();
  });

  it('rien n\'est actif par défaut : aucune connexion', async () => {
    const s = service({}, { site: 'stfort' });
    await s.start();
    expect(s.getStatus().usine.connexions).toEqual([]);
    expect(s.getStatus().poseur.connecte).toBe(false);
    await s.stop();
  });
});

describe('EsphomeService — poseur (réception des poses)', () => {
  it('liste un message de pose du site et le retire quand il est supprimé', async () => {
    vi.useFakeTimers();
    const ha2 = new FauxBroker();
    const s = service({ ha2 }, { site: 'stfort', poseur: { actif: true, mqtt: { hote: 'ha2' } } });
    await s.start();
    const pose = { v: 1, site: 'stfort', appareil: 'hasat4', revision: 3, at: '2026-10-13T18:00:00+02:00', firmware: 'http://f/x.bin', sha256: 'd'.repeat(64), tailleOctets: 1000, esp: '192.168.1.44', nomAffichage: 'Satellite 4' };
    ha2.publier(topics.pose('stfort', 'hasat4'), JSON.stringify(pose), true);
    expect(s.getStatus().poseur.poses.map((p) => p.esp)).toEqual(['192.168.1.44']);
    ha2.publier(topics.pose('stfort', 'hasat4'), '', true);
    expect(s.getStatus().poseur.poses).toEqual([]);
    await s.stop();
  });
});

describe('EsphomeService — file de l\'usine', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('une compilation à la fois, dans l\'ordre ; une demande plus récente remplace celle qui attend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker();
    const tm = traiteurManuel();
    const s = service({ ha2, noisy2: new FauxBroker() }, confUsine, undefined, tm.fabrique);
    await s.start();
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(1, 'a')), true);
    ha2.publier(topics.job('stfort', 'b'), JSON.stringify(job(1, 'b')), true);
    ha2.publier(topics.job('stfort', 'b'), JSON.stringify(job(2, 'b')), true); // remplace b@1 en attente
    await flush();
    expect(tm.vus.map((j) => `${j.appareil}@${j.revision}`)).toEqual(['a@1']); // b attend
    expect(s.getStatus().usine.demandes.map((d) => `${d.appareil}:${d.etat}`)).toEqual(['a:en_cours', 'b:en_attente']);
    tm.liberer(); await flush();
    expect(tm.vus.map((j) => `${j.appareil}@${j.revision}`)).toEqual(['a@1', 'b@2']);
    tm.liberer(); await flush();
    expect(s.getStatus().usine.demandes).toEqual([]);
    await s.stop();
  });

  it('une révision terminée n\'est pas retraitée ; une plus récente l\'est', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker();
    const tm = traiteurManuel();
    const s = service({ ha2, noisy2: new FauxBroker() }, confUsine, undefined, tm.fabrique);
    await s.start();
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(5, 'a')), true);
    await flush(); tm.liberer(); await flush();
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(5, 'a')), true); // même révision
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(4, 'a')), true); // plus ancienne
    await flush();
    expect(tm.vus).toHaveLength(1);
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(6, 'a')), true);
    await flush();
    expect(tm.vus.map((j) => j.revision)).toEqual([5, 6]);
    await s.stop();
  });

  it('« à réessayer » : nouvelle tentative après un délai, abandon après 3 essais', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker();
    const tm = traiteurManuel();
    const s = service({ ha2, noisy2: new FauxBroker() }, confUsine, undefined, tm.fabrique);
    await s.start();
    ha2.publier(topics.job('stfort', 'a'), JSON.stringify(job(1, 'a')), true);
    await flush();
    for (let essai = 1; essai <= 3; essai++) {
      expect(tm.vus).toHaveLength(essai);
      tm.liberer('a_reessayer'); await flush();
      if (essai < 3) {
        expect(s.getStatus().usine.demandes[0]).toMatchObject({ etat: 'a_reessayer', essais: essai });
        await vi.advanceTimersByTimeAsync(31_000); await flush();
      }
    }
    expect(s.getStatus().usine.demandes).toEqual([]); // abandonnée après 3 essais
    await vi.advanceTimersByTimeAsync(120_000); await flush();
    expect(tm.vus).toHaveLength(3);
    await s.stop();
  });

  it('publie état, pose et suppression de demande sur le broker DU SITE de la demande', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker();
    const noisy2 = new FauxBroker();
    const tm = traiteurManuel();
    const s = service({ ha2, noisy2 }, confUsine, undefined, tm.fabrique);
    await s.start();
    noisy2.publier(topics.job('noisy', 'ecran'), JSON.stringify({ ...job(7, 'ecran'), site: 'noisy' }), true);
    await flush();
    const pub = tm.publication();
    pub.statut('noisy', 'ecran', 'compilation', { detail: 'en cours' });
    pub.pose('noisy', 'ecran', { site: 'noisy', appareil: 'ecran', revision: 7, firmware: 'http://f/x.bin', sha256: 'a'.repeat(64), tailleOctets: 10, esp: '192.168.1.40', portApi: 6053, portOta: 3232, nomAffichage: 'Écran', options: { autoriserAppelsService: false } });
    pub.supprimerDemande('noisy', 'ecran');
    expect(JSON.parse(noisy2.conserves.get(topics.status('noisy', 'ecran'))!)).toMatchObject({ v: 1, site: 'noisy', appareil: 'ecran', revision: 7, etat: 'compilation', detail: 'en cours' });
    expect(JSON.parse(noisy2.conserves.get(topics.pose('noisy', 'ecran'))!)).toMatchObject({ v: 1, tailleOctets: 10, esp: '192.168.1.40' });
    expect(noisy2.conserves.has(topics.job('noisy', 'ecran'))).toBe(false);
    expect([...ha2.conserves.keys()].filter((k) => k.includes('/noisy/'))).toEqual([]); // rien de noisy sur le broker de stfort
    await s.stop();
  });
});

describe('EsphomeService — file du poseur', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const poseMsg = (rev: number, app = 'hasat4') => ({ v: 1, site: 'stfort', appareil: app, revision: rev, at: '2026-10-13T18:00:00+02:00', firmware: 'http://f/x.bin', sha256: 'd'.repeat(64), tailleOctets: 1000, esp: '192.168.1.44', nomAffichage: 'Satellite' });
  function poseurManuel() {
    const vus: Pose[] = [];
    const attente: ((r: ResultatTraitement) => void)[] = [];
    let publication!: PublicationPoseur;
    const fabrique: FabriquePoseur = (_c, p) => { publication = p; return { traiter: (pose) => new Promise((res) => { vus.push(pose); attente.push(res); }) } as TraiteurPoseur; };
    return { vus, fabrique, liberer: (r: ResultatTraitement = 'termine') => attente.shift()!(r), publication: () => publication };
  }
  const confPoseur = { site: 'stfort', poseur: { actif: true, mqtt: { hote: 'ha2' }, tentatives: { intervalleMinutes: 5, dureeMinutes: 10 } } };
  const svc = (ha2: FauxBroker, pm: ReturnType<typeof poseurManuel>) =>
    EsphomeService.create(bus, logger, provider(confPoseur), ({ broker, willTopic, willPayload }: any) => ({ ha2 }[broker.hote as 'ha2']).transport({ topic: willTopic, payload: willPayload }), { instance: 'p', port: 8087 }, undefined, undefined, pm.fabrique);

  it('traite une pose à la fois, remplace celle qui attend, ignore une révision terminée', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker(); const pm = poseurManuel(); const s = svc(ha2, pm);
    await s.start();
    ha2.publier(topics.pose('stfort', 'a'), JSON.stringify(poseMsg(1, 'a')), true);
    ha2.publier(topics.pose('stfort', 'b'), JSON.stringify(poseMsg(1, 'b')), true);
    ha2.publier(topics.pose('stfort', 'b'), JSON.stringify(poseMsg(2, 'b')), true);
    await flush();
    expect(pm.vus.map((p) => `${p.appareil}@${p.revision}`)).toEqual(['a@1']);
    expect(s.getStatus().poseur.poses.map((p) => `${p.appareil}:${p.etat}`)).toEqual(['a:en_cours', 'b:en_attente']);
    pm.liberer(); await flush();
    expect(pm.vus.map((p) => `${p.appareil}@${p.revision}`)).toEqual(['a@1', 'b@2']);
    pm.liberer(); await flush();
    ha2.publier(topics.pose('stfort', 'a'), JSON.stringify(poseMsg(1, 'a')), true); // déjà terminée
    await flush();
    expect(pm.vus).toHaveLength(2);
    await s.stop();
  });

  it('ESP injoignable : nouvelle tentative toutes les 5 minutes pendant 10 minutes (3 essais), puis abandon', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker(); const pm = poseurManuel(); const s = svc(ha2, pm);
    await s.start();
    ha2.publier(topics.pose('stfort', 'a'), JSON.stringify(poseMsg(1, 'a')), true);
    await flush();
    for (let essai = 1; essai <= 3; essai++) {
      expect(pm.vus).toHaveLength(essai);
      pm.liberer('a_reessayer'); await flush();
      if (essai < 3) {
        expect(s.getStatus().poseur.poses[0]).toMatchObject({ etat: 'a_reessayer', essais: essai });
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000); await flush();
      }
    }
    expect(s.getStatus().poseur.poses).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * 60_000); await flush();
    expect(pm.vus).toHaveLength(3);
    await s.stop();
  });

  it('publie l\'état et la suppression de la pose sur le broker du site', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ha2 = new FauxBroker(); const pm = poseurManuel(); const s = svc(ha2, pm);
    await s.start();
    ha2.publier(topics.pose('stfort', 'a'), JSON.stringify(poseMsg(4, 'a')), true);
    await flush();
    const pub = pm.publication();
    pub.statut('stfort', 'a', 'envoi', { detail: '192.168.1.44:3232' });
    expect(JSON.parse(ha2.conserves.get(topics.status('stfort', 'a'))!)).toMatchObject({ etat: 'envoi', revision: 4, detail: '192.168.1.44:3232' });
    pub.supprimerPose('stfort', 'a');
    expect(ha2.conserves.has(topics.pose('stfort', 'a'))).toBe(false);
    await s.stop();
  });
});

