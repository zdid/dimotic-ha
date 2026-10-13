import { describe, it, expect } from 'vitest';
import { FauxBroker } from './faux-broker';
import { SiteBus } from '../bus';
import { AgentPresence } from '../AgentPresence';
import { topics } from '../messages';

const maintenant = () => new Date('2026-10-13T18:00:00+02:00');
const sujet = topics.usine('falbala');

function agent(broker: FauxBroker, moi: { instance: string; port: number }) {
  const transport = broker.transport({ topic: sujet, payload: AgentPresence.testament(moi, maintenant()) });
  const bus = new SiteBus('stfort', transport);
  const presence = new AgentPresence(sujet, moi, [bus], maintenant);
  bus.connecter();
  return { transport, bus, presence };
}

describe('présence et garde-fou entre deux agents', () => {
  it('seul : actif, et sa présence est conservée', () => {
    const broker = new FauxBroker();
    const a = agent(broker, { instance: 'falbala_410210', port: 8087 });
    a.presence.annoncer();
    expect(a.presence.etat).toEqual({ actif: true });
    expect(JSON.parse(broker.conserves.get(sujet)!)).toMatchObject({ enLigne: true, instance: 'falbala_410210', port: 8087 });
  });

  it('le second agent (dev 8088) se met en retrait, avec la raison ; il reprend la main quand le premier tombe', () => {
    const broker = new FauxBroker();
    const reel = agent(broker, { instance: 'falbala_410210', port: 8087 });
    reel.presence.annoncer();

    const dev = agent(broker, { instance: 'falbala_817412', port: 8088 });
    expect(dev.presence.etat).toEqual({ actif: false, raison: 'un autre agent est déjà actif : instance falbala_410210, port 8087' });

    const changements: boolean[] = [];
    dev.presence.surChangement((d) => changements.push(d.actif));
    reel.transport.couper(); // coupure brutale : testament
    expect(dev.presence.etat).toEqual({ actif: true });
    expect(changements).toEqual([true]);
  });

  it('un redémarrage ne se bloque pas sur SA propre présence conservée', () => {
    const broker = new FauxBroker();
    const premier = agent(broker, { instance: 'falbala_410210', port: 8087 });
    premier.presence.annoncer();
    const apres = agent(broker, { instance: 'falbala_410210', port: 8087 });
    expect(apres.presence.etat).toEqual({ actif: true });
  });

  it('un arrêt propre (présence supprimée) rend la main', () => {
    const broker = new FauxBroker();
    const a = agent(broker, { instance: 'falbala_410210', port: 8087 });
    a.presence.annoncer();
    const b = agent(broker, { instance: 'falbala_817412', port: 8088 });
    expect(b.presence.etat.actif).toBe(false);
    a.bus.supprimer(sujet);
    expect(b.presence.etat.actif).toBe(true);
  });

  it('un agent en retrait n\'écrase pas la présence de l\'agent actif, et l\'agent installé ne lui cède pas la place', () => {
    const broker = new FauxBroker();
    const reel = agent(broker, { instance: 'falbala_410210', port: 8087 });
    reel.presence.annoncer();
    const dev = agent(broker, { instance: 'falbala_817412', port: 8088 });
    dev.presence.annoncer(); // en retrait : n'annonce rien
    expect(JSON.parse(broker.conserves.get(sujet)!)).toMatchObject({ instance: 'falbala_410210', port: 8087 });
    expect(reel.presence.etat).toEqual({ actif: true });
    expect(dev.presence.etat.actif).toBe(false);
  });

  it('l\'agent qui reprend la main annonce de lui-même sa présence', () => {
    const broker = new FauxBroker();
    const reel = agent(broker, { instance: 'falbala_410210', port: 8087 });
    reel.presence.annoncer();
    const dev = agent(broker, { instance: 'falbala_817412', port: 8088 });
    reel.transport.couper();
    expect(dev.presence.etat).toEqual({ actif: true });
    expect(JSON.parse(broker.conserves.get(sujet)!)).toMatchObject({ enLigne: true, instance: 'falbala_817412', port: 8088 });
  });
});
