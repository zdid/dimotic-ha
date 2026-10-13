import { describe, it, expect } from 'vitest';
import { decider } from '../presence';

const moi = { instance: 'falbala_410210', port: 8087 };
const at = '2026-10-13T18:00:00+02:00';

describe('garde-fou un seul agent actif', () => {
  it('actif quand personne d\'autre', () => {
    expect(decider(moi, null)).toEqual({ actif: true });
  });
  it('actif quand l\'autre agent est hors ligne (testament)', () => {
    expect(decider(moi, { v: 1, enLigne: false, instance: 'falbala_817412', port: 8088, at })).toEqual({ actif: true });
  });
  it('inactif, avec l\'instance et le port de l\'autre, quand il est en ligne', () => {
    const d = decider(moi, { v: 1, enLigne: true, instance: 'falbala_817412', port: 8088, at });
    expect(d).toEqual({ actif: false, raison: 'un autre agent est déjà actif : instance falbala_817412, port 8088' });
  });
  it('sa propre présence conservée d\'un lancement précédent ne le bloque pas', () => {
    expect(decider(moi, { v: 1, enLigne: true, instance: 'falbala_410210', port: 8087, at })).toEqual({ actif: true });
  });
  it('même instance sur un autre port = autre agent (réel 8087 / dev 8088)', () => {
    expect(decider(moi, { v: 1, enLigne: true, instance: 'falbala_410210', port: 8088, at }).actif).toBe(false);
  });
});
