import { describe, it, expect, vi, afterEach } from 'vitest';
import { FauxBroker } from './faux-broker';
import { EsphomeService } from '../EsphomeService';
import { esphomeConfigSchema } from '../config-schema';
import { topics } from '../messages';
import { AgentPresence } from '../AgentPresence';

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const bus: any = { handlers: {} as Record<string, Function>, emitted: [] as { e: string; d: any }[], on(e: string, cb: Function) { this.handlers[e] = cb; }, onGeneric(e: string, cb: Function) { this.handlers[e] = cb; }, emit(e: string, d: any) { this.emitted.push({ e, d }); } };
const provider = (conf: unknown): any => ({ getAppConfig: () => conf, reload() {} });
const job = (rev: number, appareil = 'hasat4') => ({ v: 1, site: 'stfort', appareil, revision: rev, at: '2026-10-13T18:00:00+02:00', action: 'firmware', origine: 'x', paquet: 'http://h/p.zip', sha256: 'c'.repeat(64) });

afterEach(() => { vi.useRealTimers(); bus.emitted.length = 0; });

function service(brokers: Record<string, FauxBroker>, conf: unknown, identite = { instance: 'falbala_410210', port: 8087 }) {
  const fabrique = ({ broker, willTopic, willPayload }: any) => brokers[broker.hote].transport({ topic: willTopic, payload: willPayload });
  return EsphomeService.create(bus, logger, provider(conf), fabrique, identite);
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
