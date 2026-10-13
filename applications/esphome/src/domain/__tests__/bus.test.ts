import { describe, it, expect } from 'vitest';
import { FauxBroker } from './faux-broker';
import { SiteBus, correspond } from '../bus';
import { jobSchema, topics } from '../messages';

const job = { v: 1, site: 'stfort', appareil: 'hasat4', revision: 3, at: '2026-10-13T18:00:00+02:00', action: 'firmware', origine: '192.168.1.51:8087', paquet: 'http://192.168.1.51:8087/p.zip', sha256: 'b'.repeat(64) };

describe('filtres MQTT', () => {
  it('+ et # ', () => {
    expect(correspond('dimotic/esphome/stfort/jobs/+', 'dimotic/esphome/stfort/jobs/hasat4')).toBe(true);
    expect(correspond('dimotic/esphome/stfort/jobs/+', 'dimotic/esphome/noisy/jobs/hasat4')).toBe(false);
    expect(correspond('dimotic/esphome/stfort/jobs/+', 'dimotic/esphome/stfort/jobs/a/b')).toBe(false);
    expect(correspond('dimotic/#', 'dimotic/esphome/x')).toBe(true);
  });
});

describe('SiteBus', () => {
  it('livre une demande conservée à un abonné arrivé APRÈS sa publication (la machine éteinte n\'empêche rien)', () => {
    const broker = new FauxBroker();
    const assembleur = new SiteBus('stfort', broker.transport());
    assembleur.connecter();
    assembleur.publier(topics.job('stfort', 'hasat4'), job, true);

    const usine = new SiteBus('stfort', broker.transport());
    const recues: string[] = [];
    usine.connecter();
    usine.abonner(topics.jobs('stfort'), jobSchema, (j) => recues.push(`${j.appareil}@${j.revision}`));
    expect(recues).toEqual(['hasat4@3']);
  });

  it('une charge invalide est signalée sans exception, une charge vide dit « supprimé »', () => {
    const broker = new FauxBroker();
    const bus = new SiteBus('stfort', broker.transport());
    const autre = new SiteBus('stfort', broker.transport());
    const evts: string[] = [];
    bus.connecter(); autre.connecter();
    bus.abonner(topics.jobs('stfort'), jobSchema, () => evts.push('ok'), { vide: (t) => evts.push('vide'), invalide: (t, r) => evts.push('invalide') });
    autre.publier(topics.job('stfort', 'x'), { v: 1, nimporte: 'quoi' }, true);
    autre.supprimer(topics.job('stfort', 'x'));
    expect(evts).toEqual(['invalide', 'vide']);
    expect(broker.conserves.has(topics.job('stfort', 'x'))).toBe(false);
  });

  it('ne livre pas à l\'abonné d\'un autre site (sites étanches : un bus par broker)', () => {
    const brokerStfort = new FauxBroker();
    const brokerNoisy = new FauxBroker();
    const noisy = new SiteBus('noisy', brokerNoisy.transport());
    const recues: unknown[] = [];
    noisy.connecter();
    noisy.abonner(topics.jobs('noisy'), jobSchema, (j) => recues.push(j));
    new SiteBus('stfort', brokerStfort.transport()).publier(topics.job('stfort', 'hasat4'), job, true);
    expect(recues).toEqual([]);
  });
});
