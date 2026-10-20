import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composerNom, validerNom, lireNom } from '../convention-nom';
import { assemblerPaquet } from '../paquet';
import { resoudreAppareil, ResolutionImpossible } from '../resolution';

describe('convention de nom', () => {
  it('compose le nom en ignorant les parties vides', () => {
    expect(composerNom({ quoi: 'poêle', lieuPrecis: 'switch thermostat', lieu: 'salle', pere: 'rez de chaussée', grandPere: 'maison' })).toBe('poêle---switch thermostat--salle--rez de chaussée--maison');
    expect(composerNom({ quoi: 'Température', lieu: 'salle de bain' })).toBe('Température---salle de bain');
    expect(composerNom({ quoi: 'lumière', lieuPrecis: '', lieu: 'cuisine d\'été', pere: 'étage' })).toBe('lumière---cuisine d\'été--étage');
  });
  it('relit un nom (précis absent = lieu) et refuse ce qui ne suit pas la convention', () => {
    expect(lireNom('Température---salon')).toEqual({ quoi: 'Température', lieu: 'salon' });
    expect(lireNom('lumière---plafonnier--chambre--étage')).toMatchObject({ quoi: 'lumière', lieuPrecis: 'plafonnier', lieu: 'chambre', pere: 'étage' });
    expect(lireNom('Thermostat')).toBeNull();
    expect(lireNom('x---')).toBeNull();
  });
  it('valide : QUOI et lieu obligatoires, grand-père avec un père, pas de séparateur ni de caractère interdit dans une partie', () => {
    expect(validerNom({ quoi: 'a', lieu: 'b' })).toEqual([]);
    expect(validerNom({ quoi: '', lieu: 'b' })).toContain('le QUOI est vide');
    expect(validerNom({ quoi: 'a', lieu: '' })).toContain('le lieu est vide');
    expect(validerNom({ quoi: 'a', lieu: 'b', grandPere: 'maison' }).join(' ')).toMatch(/grand-père sans père/);
    expect(validerNom({ quoi: 'a', lieu: 'b--c' }).join(' ')).toMatch(/--/);
    expect(validerNom({ quoi: 'a/b', lieu: 'c' }).join(' ')).toMatch(/interdit/);
    expect(validerNom({ quoi: 'a', lieu: '-c' }).join(' ')).toMatch(/tiret/);
  });
});

let racine: string;
const ecrire = (rel: string, contenu: string) => { const f = path.join(racine, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenu); };
const FICHE_MATERIEL = 'id: carte\nnom: Carte\nplateforme: esp8266\npuce: esp8266\ncadre: arduino\ncarte: d1_mini\nflash: 4MB\nmemoire: { emplacement_ota_octets: 1000000, ram_interne_octets: 80000 }\nbroches_prises: [5]\n';
const FICHE_APPAREIL = 'nom: test\nnom_affichage: "Test"\nmateriel: carte\nesp:\n  adresse: 192.168.1.9\nwifi: []\n';
const IDENTITE_FICHE = 'id: identite-taxonomie\nnom: Identité\nparametres:\n  - nom: quoi\n  - nom: lieu_precis\n    requis: false\n    defaut: ""\n  - nom: lieu\n  - nom: pere\n    requis: false\n    defaut: ""\n  - nom: grand_pere\n    requis: false\n    defaut: ""\n';
const appareil = (vars: string, transports: string) => `substitutions:\n  device_name: test\npackages:\n  materiel: !include bibliotheque/materiels/carte/base.yaml\n  identite: !include\n    file: bibliotheque/elements/identite-taxonomie/element.yaml\n    vars:\n${vars}\n${transports}`;
const MQTT = '  transport: !include bibliotheque/elements/transport-mqtt/element.yaml\n';

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-conv-'));
  ecrire('bibliotheque/materiels/carte/base.yaml', 'esp8266:\n  board: d1_mini\n');
  ecrire('bibliotheque/materiels/carte/fiche.yaml', FICHE_MATERIEL);
  ecrire('bibliotheque/elements/identite-taxonomie/element.yaml', 'esphome:\n  friendly_name: x\n');
  ecrire('bibliotheque/elements/identite-taxonomie/fiche.yaml', IDENTITE_FICHE);
  ecrire('bibliotheque/elements/transport-mqtt/element.yaml', 'mqtt:\n  broker: 1.2.3.4\n');
  ecrire('bibliotheque/elements/transport-mqtt/fiche.yaml', 'id: transport-mqtt\nnom: MQTT\n');
  ecrire('appareils/test.fiche.yaml', FICHE_APPAREIL);
});

describe('transport et identité à l\'assemblage', () => {
  it('MQTT + identité valide : paquet produit, sans avertissement', () => {
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: salle\n      pere: rez de chaussée', MQTT));
    const r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.avertissements).toEqual([]); expect(resoudreAppareil(racine, 'test').transports).toEqual({ api: false, mqtt: true }); }
  });
  it('api: ET mqtt: dans le même appareil : refusé (un seul transport)', () => {
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: salle', MQTT) + 'api:\n');
    const r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(' ')).toMatch(/un seul transport/);
  });
  it('nom hors convention (grand-père sans père, séparateur dans une partie) : refusé avec la cause', () => {
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: salle\n      grand_pere: maison', MQTT));
    let r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(' ')).toMatch(/grand-père sans père/);
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: "salle--x"', MQTT));
    r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok).toBe(false);
  });
  it('MQTT sans identité : avertissement ; identité sans MQTT (api seule) : avertissement', () => {
    ecrire('appareils/test.yaml', 'packages:\n  materiel: !include bibliotheque/materiels/carte/base.yaml\n' + MQTT);
    let r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok && r.avertissements.join(' ')).toMatch(/MQTT sans élément identite-taxonomie/);
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: salle', '') + 'api:\n');
    r = assemblerPaquet(racine, 'test', 1);
    expect(r.ok && r.avertissements.join(' ')).toMatch(/sans MQTT la taxonomie n'est pas calculée/);
  });
  it('composant local embarqué sous components/<id>/ ; absent : refusé', () => {
    ecrire('bibliotheque/composants/mon_composant/__init__.py', '# composant\n');
    ecrire('bibliotheque/composants/mon_composant/mon.h', '// h\n');
    ecrire('bibliotheque/materiels/carte/base.yaml', 'external_components:\n  - source:\n      type: local\n      path: components\n    components: [mon_composant]\n');
    ecrire('appareils/test.yaml', appareil('      quoi: poêle\n      lieu: salle', MQTT));
    const s = resoudreAppareil(racine, 'test');
    expect(s.composants).toEqual(['mon_composant']);
    expect([...s.fichiers.keys()]).toEqual(expect.arrayContaining(['components/mon_composant/__init__.py', 'components/mon_composant/mon.h']));
    fs.rmSync(path.join(racine, 'bibliotheque/composants'), { recursive: true });
    expect(() => resoudreAppareil(racine, 'test')).toThrow(ResolutionImpossible);
  });
});
