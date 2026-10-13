import { describe, it, expect } from 'vitest';
import { jobSchema, poseSchema, statusSchema, presenceSchema, topics, appareilDuSujet, lire, revisionAcceptee } from '../messages';

const base = { v: 1, site: 'stfort', appareil: 'haplan-display', revision: 7, at: '2026-10-13T18:00:00+02:00' };
const sha = 'a'.repeat(64);

describe('messages', () => {
  it('lit une demande valide', () => {
    const r = lire(jobSchema, JSON.stringify({ ...base, action: 'firmware', origine: '192.168.1.51:8087', paquet: 'http://192.168.1.51:8087/api/apps/espdisplay/partage/paquets/haplan-display/r7.zip', sha256: sha }));
    expect(r.ok).toBe(true);
  });

  it('refuse une demande sans somme de contrôle valide, avec la raison', () => {
    const r = lire(jobSchema, JSON.stringify({ ...base, action: 'firmware', origine: 'x', paquet: 'http://h/p.zip', sha256: 'abc' }));
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.raison).toContain('sha256');
  });

  it('une charge vide est « message supprimé » ; un JSON cassé est signalé', () => {
    expect(lire(jobSchema, '')).toEqual({ ok: false, raison: 'vide' });
    expect(lire(jobSchema, '{pas du json')).toEqual({ ok: false, raison: 'JSON invalide' });
  });

  it('refuse une version de format inconnue', () => {
    expect(lire(statusSchema, JSON.stringify({ ...base, v: 2, etat: 'termine' })).ok).toBe(false);
  });

  it('le message de pose porte la clé seulement pour un appareil neuf', () => {
    const sans = lire(poseSchema, JSON.stringify({ ...base, firmware: 'http://f/x.bin', sha256: sha, tailleOctets: 1234567, esp: '192.168.1.40', nomAffichage: 'Plan HAPLAN' }));
    expect(sans.ok && sans.valeur.cle).toBeUndefined();
    expect(sans.ok && sans.valeur.options.autoriserAppelsService).toBe(false);
    const avec = lire(poseSchema, JSON.stringify({ ...base, firmware: 'http://f/x.bin', sha256: sha, tailleOctets: 1234567, esp: '192.168.1.40', nomAffichage: 'Plan HAPLAN', cle: 'k', options: { autoriserAppelsService: true } }));
    expect(avec.ok && avec.valeur.cle).toBe('k');
  });

  it('refuse un état inconnu et un appareil au nom dangereux', () => {
    expect(lire(statusSchema, JSON.stringify({ ...base, etat: 'bizarre' })).ok).toBe(false);
    expect(lire(statusSchema, JSON.stringify({ ...base, appareil: '../x', etat: 'termine' })).ok).toBe(false);
  });

  it('présence : le testament publie enLigne:false', () => {
    expect(lire(presenceSchema, JSON.stringify({ v: 1, enLigne: false, instance: 'falbala_410210', port: 8087, at: base.at })).ok).toBe(true);
  });

  it('sujets, avec le site dans chacun', () => {
    expect(topics.job('noisy', 'ecran-salon')).toBe('dimotic/esphome/noisy/jobs/ecran-salon');
    expect(topics.pose('noisy', 'ecran-salon')).toBe('dimotic/esphome/noisy/pose/ecran-salon');
    expect(topics.status('noisy', 'ecran-salon')).toBe('dimotic/esphome/noisy/status/ecran-salon');
    expect(topics.usine('falbala')).toBe('dimotic/esphome/agent/falbala');
    expect(topics.poseur('noisy')).toBe('dimotic/esphome/noisy/poseur');
    expect(topics.appareilsAssembleur('stfort')).toBe('dimotic/esps-assemble/stfort/appareils');
  });

  it('retrouve l\'appareil d\'un sujet', () => {
    expect(appareilDuSujet('dimotic/esphome/stfort/jobs/hasat4')).toBe('hasat4');
    expect(appareilDuSujet('dimotic/esphome/stfort/pose/haplan-display')).toBe('haplan-display');
    expect(appareilDuSujet('dimotic/esphome/stfort/poseur')).toBeNull();
  });

  it('révisions : périmée ou déjà traitée ignorée, plus récente acceptée', () => {
    expect(revisionAcceptee(5, undefined)).toBe(true);
    expect(revisionAcceptee(6, 5)).toBe(true);
    expect(revisionAcceptee(5, 5)).toBe(false);
    expect(revisionAcceptee(4, 5)).toBe(false);
  });
});
