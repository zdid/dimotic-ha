import { describe, it, expect } from 'vitest';
import { faireZip } from './zip-test';
import { lireZip, cheminSur, ZipInvalide } from '../zip';
import { verifierPaquet, sha256, type Manifeste } from '../manifest';

const yaml = 'esphome:\n  name: hasat4\n';
const lib = 'a: 1\n';
const manifeste = (extra: Partial<Manifeste> = {}, fichiers: Record<string, string> = { 'hasat4.yaml': sha256(Buffer.from(yaml)), 'bibliotheque/x.yaml': sha256(Buffer.from(lib)) }) => ({
  v: 1, appareil: 'hasat4', nomAffichage: 'Satellite 4', revision: 2, assemble: '2026-10-13T18:00:00+02:00',
  modele: { id: 'waveshare-esp32-s3-audio', puce: 'esp32-s3', flash: '16MB', cadre: 'esp-idf' },
  esp: { adresse: '192.168.1.44' }, options: {}, wifi: ['stfort'], fichiers, ...extra
});
const paquet = (m: unknown, extra: Record<string, string> = {}) => faireZip({ 'manifest.json': JSON.stringify(m), 'hasat4.yaml': yaml, 'bibliotheque/x.yaml': lib, ...extra }, { deflate: true });

describe('lecture du zip', () => {
  it('lit les entrées stockées et compressées', () => {
    for (const deflate of [false, true]) {
      const e = lireZip(faireZip({ 'a.txt': 'bonjour', 'd/b.txt': 'x'.repeat(5000) }, { deflate }));
      expect(e.map((x) => x.chemin)).toEqual(['a.txt', 'd/b.txt']);
      expect(e[1].contenu.length).toBe(5000);
    }
  });
  it('refuse les chemins qui sortent du dossier', () => {
    for (const chemin of ['../evil.yaml', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b']) {
      expect(() => lireZip(faireZip({ [chemin]: 'x' })), chemin).toThrow(ZipInvalide);
    }
    expect(cheminSur('bibliotheque/elements/x/element.yaml')).toBe(true);
  });
  it('refuse une archive tronquée ou trop volumineuse', () => {
    expect(() => lireZip(Buffer.from('pas un zip'))).toThrow(ZipInvalide);
    expect(() => lireZip(faireZip({ 'a': 'x'.repeat(100) }), 50)).toThrow(/volumineuse/);
  });
});

describe('manifeste du paquet', () => {
  it('accepte un paquet cohérent', () => {
    const r = verifierPaquet(lireZip(paquet(manifeste())));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.manifeste.esp.port).toBe(6053); expect(r.fichiers.map((f) => f.chemin)).toEqual(['hasat4.yaml', 'bibliotheque/x.yaml']); }
  });
  it('refuse : manifeste absent, JSON cassé, champ manquant', () => {
    expect(verifierPaquet(lireZip(faireZip({ 'hasat4.yaml': yaml })))).toEqual({ ok: false, raison: 'manifest.json absent du paquet' });
    expect(verifierPaquet(lireZip(faireZip({ 'manifest.json': '{pas json' })))).toEqual({ ok: false, raison: 'manifest.json : JSON invalide' });
    const sans = { ...manifeste() } as any; delete sans.esp;
    const r = verifierPaquet(lireZip(paquet(sans)));
    expect(r.ok === false && r.raison).toContain('esp');
  });
  it('refuse : somme fausse, fichier déclaré absent, fichier non déclaré, fichier yaml de l\'appareil absent', () => {
    const faux = manifeste({}, { 'hasat4.yaml': 'f'.repeat(64), 'bibliotheque/x.yaml': sha256(Buffer.from(lib)) });
    expect(verifierPaquet(lireZip(paquet(faux)))).toEqual({ ok: false, raison: 'somme de contrôle fausse : hasat4.yaml' });
    const absent = manifeste({}, { 'hasat4.yaml': sha256(Buffer.from(yaml)), 'bibliotheque/x.yaml': sha256(Buffer.from(lib)), 'manquant.yaml': 'a'.repeat(64) });
    expect(verifierPaquet(lireZip(paquet(absent)))).toEqual({ ok: false, raison: 'fichier déclaré mais absent : manquant.yaml' });
    expect(verifierPaquet(lireZip(paquet(manifeste(), { 'intrus.yaml': 'x' })))).toEqual({ ok: false, raison: 'fichier non déclaré dans le manifeste : intrus.yaml' });
    const sansYaml = manifeste({}, { 'bibliotheque/x.yaml': sha256(Buffer.from(lib)) });
    const z = faireZip({ 'manifest.json': JSON.stringify(sansYaml), 'bibliotheque/x.yaml': lib });
    expect(verifierPaquet(lireZip(z))).toEqual({ ok: false, raison: 'hasat4.yaml absent du paquet' });
  });
});
