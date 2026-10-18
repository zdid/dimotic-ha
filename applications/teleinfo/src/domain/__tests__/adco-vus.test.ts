import { describe, it, expect } from 'vitest';
import { AdcoVus, adcoDuTopic } from '../adco-vus';

const SPA = { adco: 111, quoi: 'compteur', lieu: 'spa', lieuPrecis: 'spa' };
const PAC = { adco: 222, quoi: 'compteur', lieu: 'Pompe à chaleur' };

describe('adcoDuTopic', () => {
  it('reconnaît le topic d\'état d\'un compteur, pas les autres topics', () => {
    expect(adcoDuTopic('homeassist/sensor/teleinfo_20828398450/state', 'homeassist')).toBe(20828398450);
    expect(adcoDuTopic('homeassist/sensor/teleinfo_20828398450_IINST/config', 'homeassist')).toBeNull();
    expect(adcoDuTopic('autre/sensor/teleinfo_1/state', 'homeassist')).toBeNull();
    expect(adcoDuTopic('homeassist/sensor/linky_1/state', 'homeassist')).toBeNull();
  });
});

describe('AdcoVus', () => {
  it('déclarés jamais vus : présents avec derniereTrame null', () => {
    const l = new AdcoVus().liste([SPA, PAC]);
    expect(l.map((x) => [x.adco, x.declare, x.derniereTrame])).toEqual([[111, true, null], [222, true, null]]);
    expect(l[0].nom).toBe('compteur / spa / spa');
  });

  it('une trame renseigne l\'heure et les mesures du compteur', () => {
    const v = new AdcoVus();
    v.enregistrer(111, { IINST: 4, PAPP: 870, BASE: 1 }, new Date('2026-10-18T13:00:00Z'));
    const spa = v.liste([SPA, PAC])[0];
    expect(spa).toMatchObject({ derniereTrame: '2026-10-18T13:00:00.000Z', papp: 870, iinst: 4 });
  });

  it('un ADCO inconnu vu par l\'agent est listé après les déclarés, marqué non déclaré', () => {
    const v = new AdcoVus();
    v.enregistrer(999, { PAPP: 10 });
    const l = v.liste([SPA]);
    expect(l.map((x) => [x.adco, x.declare])).toEqual([[111, true], [999, false]]);
    expect(l[1].nom).toBeNull();
  });

  it('mesures absentes ou invalides : null', () => {
    const v = new AdcoVus();
    v.enregistrer(111, { PAPP: 'x' });
    expect(v.liste([SPA])[0]).toMatchObject({ papp: null, iinst: null });
  });
});
