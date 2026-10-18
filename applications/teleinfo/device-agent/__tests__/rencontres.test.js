import { describe, it, expect } from 'vitest';
import { createRencontres } from '../rencontres.js';

function banc(declares) {
  const lignes = [];
  const r = createRencontres({ declares: () => declares, journal: (m) => lignes.push(m) });
  return { r, lignes };
}
const SPA = { adco: 111, quoi: 'compteur', lieuPrecis: 'spa', lieu: 'spa' };
const PAC = { adco: 222, quoi: 'compteur', lieuPrecis: 'Pompe à chaleur', lieu: 'Pompe à chaleur' };

describe('rencontres', () => {
  it('une ligne par compteur la première fois, puis un récapitulatif après le premier cycle', () => {
    const { r, lignes } = banc([SPA, PAC]);
    r.trame(111); r.trame(222);
    expect(lignes[0]).toBe('Compteur rencontré : ADCO 111 (déclaré : compteur / spa / spa)');
    expect(lignes[1]).toContain('ADCO 222 (déclaré : compteur / Pompe à chaleur / Pompe à chaleur)');
    expect(lignes[2]).toBe('Compteurs rencontrés au démarrage : 2 (ADCO 111, 222)');
    expect(lignes).toHaveLength(3);
  });

  it('plus aucun message ensuite (ni par trame, ni de nouveau récapitulatif)', () => {
    const { r, lignes } = banc([SPA, PAC]);
    r.trame(111); r.trame(222);
    const n = lignes.length;
    for (let i = 0; i < 20; i++) { r.trame(111); r.trame(222); }
    expect(lignes).toHaveLength(n);
  });

  it('compteur non déclaré signalé comme tel ; compteur déclaré mais pas vu signalé au récapitulatif', () => {
    const { r, lignes } = banc([SPA, PAC]);
    r.trame(999); r.trame(111);
    expect(lignes[0]).toBe('Compteur rencontré : ADCO 999 (NON déclaré dans config.yaml)');
    expect(lignes.at(-1)).toContain('2 (ADCO 999, 111)');
    expect(lignes.at(-1)).toContain('déclaré(s) mais pas encore vu(s) : 222');
  });

  it('aucune trame au premier cycle : récapitulatif « aucun »', () => {
    const { r, lignes } = banc([SPA]);
    r.erreur(); r.erreur();
    expect(lignes).toEqual(['Compteurs rencontrés au démarrage : 0 (ADCO aucun) — déclaré(s) mais pas encore vu(s) : 111']);
  });
});
