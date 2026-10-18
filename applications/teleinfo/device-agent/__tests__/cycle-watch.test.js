import { describe, it, expect } from 'vitest';
import { createCycleWatch } from '../cycle-watch.js';

function banc(attendus = [111, 222], options = {}) {
  const signaux = [];
  const rappels = [];
  let t = 0;
  const w = createCycleWatch({
    attendus: () => attendus,
    signaler: (a) => signaux.push(a),
    journal: (m) => rappels.push(m),
    maintenant: () => t,
    ...options
  });
  return { w, signaux, rappels, avancer: (ms) => { t += ms; } };
}
// un cycle = 2 lectures
const cycleComplet = (w) => { w.trame(111); w.trame(222); };
const cycleUnSeul = (w) => { w.trame(111); w.erreur(); };
const cycleVide = (w) => { w.erreur(); w.erreur(); };

describe('cycle-watch', () => {
  it('cycles normaux : aucun message', () => {
    const { w, signaux } = banc();
    for (let i = 0; i < 10; i++) cycleComplet(w);
    expect(signaux).toEqual([]);
  });

  it('aucune trame pendant 3 cycles : une alerte « aucune_trame » (une seule)', () => {
    const { w, signaux } = banc();
    cycleVide(w); cycleVide(w);
    expect(signaux).toEqual([]); // pas encore
    cycleVide(w);
    expect(signaux).toHaveLength(1);
    expect(signaux[0]).toMatchObject({ niveau: 'alerte', raison: 'aucune_trame', attendus: 2, recus: 0 });
    cycleVide(w); cycleVide(w);
    expect(signaux).toHaveLength(1); // pas de répétition
  });

  it('un seul compteur sur deux : alerte « compteur_manquant » avec l\'ADCO absent', () => {
    const { w, signaux } = banc();
    cycleUnSeul(w); cycleUnSeul(w); cycleUnSeul(w);
    expect(signaux).toHaveLength(1);
    expect(signaux[0]).toMatchObject({ niveau: 'alerte', raison: 'compteur_manquant', attendus: 2, recus: 1, manquants: [222] });
    expect(signaux[0].message).toContain('1 compteur reçu sur 2 attendus');
  });

  it('un cycle isolé raté ne déclenche rien ; le retour à la normale est signalé une fois', () => {
    const { w, signaux } = banc();
    cycleUnSeul(w); cycleComplet(w); cycleUnSeul(w); cycleComplet(w);
    expect(signaux).toEqual([]);
    cycleVide(w); cycleVide(w); cycleVide(w);
    expect(signaux).toHaveLength(1);
    cycleComplet(w);
    expect(signaux).toHaveLength(2);
    expect(signaux[1]).toMatchObject({ niveau: 'ok', manquants: [] });
    cycleComplet(w);
    expect(signaux).toHaveLength(2);
  });

  it('rappel au journal toutes les 10 minutes pendant une alerte', () => {
    const { w, signaux, rappels, avancer } = banc();
    cycleVide(w); cycleVide(w); cycleVide(w);
    expect(signaux).toHaveLength(1);
    avancer(5 * 60 * 1000); cycleVide(w);
    expect(rappels).toHaveLength(0);
    avancer(6 * 60 * 1000); cycleVide(w);
    expect(rappels).toHaveLength(1);
    expect(signaux).toHaveLength(1);
  });

  it('un seul compteur déclaré : pas d\'alerte tant que celui-là répond ; aucun déclaré : alerte seulement sans trame', () => {
    const a = banc([111]);
    for (let i = 0; i < 5; i++) { a.w.trame(111); a.w.erreur(); }
    expect(a.signaux).toEqual([]);
    const b = banc([]);
    for (let i = 0; i < 5; i++) b.w.trame(999), b.w.trame(999);
    expect(b.signaux).toEqual([]);
    const c = banc([]);
    cycleVide(c.w); cycleVide(c.w); cycleVide(c.w);
    expect(c.signaux[0]).toMatchObject({ raison: 'aucune_trame' });
  });
});
