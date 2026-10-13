import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resoudreAppareil, ResolutionImpossible } from '../resolution';
import { assemblerPaquet } from '../paquet';
import { Bibliotheque, FicheInvalide } from '../fiches';
import { ecrireZip, crc32 } from '../zip-ecriture';
// Contrôle croisé : le paquet doit être accepté tel quel par l'usine de l'application esphome.
import { lireZip } from '../../../../../esphome/dist/domain/factory/zip';
import { verifierPaquet } from '../../../../../esphome/dist/domain/factory/manifest';

let racine: string;
const ecrire = (rel: string, contenu: string) => { const f = path.join(racine, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenu); };

const FICHE_MATERIEL = `id: carte-test
nom: Carte de test
plateforme: esp32
puce: esp32-s3
cadre: esp-idf
carte: esp32-s3-devkitc-1
flash: 16MB
memoire: { emplacementOtaOctets: 6000000, ramInterneOctets: 327680, psram: true }
ecran: { largeur: 800, hauteur: 480, tactile: gt911 }
broches_prises: [1, 2, 3]
`;
const FICHE_ELEMENT = (id: string, extra = '') => `id: ${id}\nnom: Élément ${id}\n${extra}`;
const APPAREIL = `esphome:
  name: ecran-salon
  friendly_name: "Écran salon"
api:
  encryption:
    key: !secret api_ecran-salon
packages:
  materiel: !include bibliotheque/materiels/carte-test/base.yaml
  wifi: !include bibliotheque/elements/wifi-simple/element.yaml
  page_a: !include
    file: bibliotheque/elements/page-clim/element.yaml
    vars:
      clim_id: "salle"
      clim_entite: "climate.salle"
  page_b: !include
    file: bibliotheque/elements/page-clim/element.yaml
    vars:
      clim_id: "bureau"
      clim_entite: "climate.bureau"
`;

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-'));
  ecrire('bibliotheque/materiels/carte-test/base.yaml', 'esp32:\n  board: esp32-s3-devkitc-1\nota:\n  - platform: esphome\n    password: !secret ota_password\n');
  ecrire('bibliotheque/materiels/carte-test/fiche.yaml', FICHE_MATERIEL);
  ecrire('bibliotheque/elements/wifi-simple/element.yaml', 'wifi:\n  ssid: !secret wifi_ssid\n  password: !secret wifi_password\n');
  ecrire('bibliotheque/elements/wifi-simple/fiche.yaml', FICHE_ELEMENT('wifi-simple'));
  ecrire('bibliotheque/elements/page-clim/element.yaml', 'lvgl:\n  pages:\n    - id: page_${clim_id}\n      widgets:\n        - label:\n            text: !lambda |-\n              return std::string("x");\n    - id: img\n      bg_image_src: img_fond\nimage:\n  - file: fond.png\n    id: img_fond\n    type: RGB565\n');
  ecrire('bibliotheque/elements/page-clim/fiche.yaml', FICHE_ELEMENT('page-clim', `parametres:\n  - nom: clim_id\n  - nom: clim_entite\n  - nom: clim_titre\n    requis: false\n    defaut: "Clim"\nexigences:\n  plateformes: [esp32]\n  ecran: { largeur: 800, hauteur: 480 }\n  elements: [wifi-simple]\n`));
  ecrire('bibliotheque/annexes/fond.png', 'PNGDATA');
  ecrire('appareils/ecran-salon.yaml', APPAREIL);
  ecrire('appareils/ecran-salon.fiche.yaml', `nom: ecran-salon\nnom_affichage: "Écran salon"\nmateriel: carte-test\nesp:\n  adresse: 192.168.1.40\nwifi: [stfort]\noptions:\n  autoriserAppelsService: true\n`);
});

describe('résolution des sources', () => {
  it('suit les packages, classe matériel et éléments (avec leurs variables), embarque les annexes locales', () => {
    const s = resoudreAppareil(racine, 'ecran-salon');
    expect(s.materiel).toBe('carte-test');
    expect(s.elements.map((e) => e.id)).toEqual(['wifi-simple', 'page-clim', 'page-clim']);
    expect(s.elements[1].vars).toEqual({ clim_id: 'salle', clim_entite: 'climate.salle' });
    expect([...s.fichiers.keys()].sort()).toEqual(['appareils/x'.replace('appareils/x', 'bibliotheque/elements/page-clim/element.yaml'), 'bibliotheque/elements/wifi-simple/element.yaml', 'bibliotheque/materiels/carte-test/base.yaml', 'ecran-salon.yaml', 'fond.png'].sort());
    expect(s.annexesManquantes).toEqual([]);
  });
  it('annexe introuvable : signalée, pas bloquante ; fichier inclus absent ou inclusion hors racine : refusés', () => {
    fs.rmSync(path.join(racine, 'bibliotheque/annexes/fond.png'));
    expect(resoudreAppareil(racine, 'ecran-salon').annexesManquantes).toEqual(['fond.png']);
    ecrire('appareils/mauvais.yaml', 'packages:\n  x: !include bibliotheque/elements/absent/element.yaml\n');
    expect(() => resoudreAppareil(racine, 'mauvais')).toThrow(/introuvable/);
    ecrire('appareils/evade.yaml', 'packages:\n  x: !include ../../etc/passwd\n');
    expect(() => resoudreAppareil(racine, 'evade')).toThrow(ResolutionImpossible);
    expect(() => resoudreAppareil(racine, 'inconnu')).toThrow(/introuvable/);
  });
  it('inclusion circulaire détectée', () => {
    ecrire('bibliotheque/elements/a/element.yaml', 'packages:\n  b: !include ../b/element.yaml\n');
    ecrire('bibliotheque/elements/b/element.yaml', 'packages:\n  a: !include ../a/element.yaml\n');
    ecrire('appareils/boucle.yaml', 'packages:\n  a: !include bibliotheque/elements/a/element.yaml\n');
    expect(() => resoudreAppareil(racine, 'boucle')).toThrow(/circulaire/);
  });
});

describe('fiches', () => {
  it('lues avec les clés snake_case du YAML', () => {
    const b = new Bibliotheque(racine);
    expect(b.materiel('carte-test')).toMatchObject({ brochesPrises: [1, 2, 3], memoire: { psram: true }, portOta: 3232 });
    expect(b.appareil('ecran-salon')).toMatchObject({ nomAffichage: 'Écran salon', options: { autoriserAppelsService: true } });
    expect(b.appareils()).toEqual(['ecran-salon']);
  });
  it('fiche invalide : message avec le champ fautif ; id différent du dossier refusé', () => {
    ecrire('bibliotheque/materiels/carte-test/fiche.yaml', FICHE_MATERIEL.replace('flash: 16MB', 'flash: beaucoup'));
    expect(() => new Bibliotheque(racine).materiel('carte-test')).toThrow(/flash/);
    ecrire('bibliotheque/materiels/carte-test/fiche.yaml', FICHE_MATERIEL.replace('id: carte-test', 'id: autre'));
    expect(() => new Bibliotheque(racine).materiel('carte-test')).toThrow(FicheInvalide);
  });
});

describe('assemblage du paquet', () => {
  it('paquet complet : manifeste conforme et accepté par l\'usine de l\'application esphome', () => {
    const r = assemblerPaquet(racine, 'ecran-salon', 4, () => new Date('2026-10-14T10:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifeste).toMatchObject({
      v: 1, appareil: 'ecran-salon', nomAffichage: 'Écran salon', revision: 4, assemble: '2026-10-14T10:00:00.000Z',
      modele: { id: 'carte-test', puce: 'esp32-s3', flash: '16MB', cadre: 'esp-idf', memoire: { emplacementOtaOctets: 6000000 } },
      esp: { adresse: '192.168.1.40', port: 6053, portOta: 3232 }, options: { autoriserAppelsService: true }, wifi: ['stfort']
    });
    // Contrôle croisé avec l'usine : mêmes sommes, mêmes fichiers.
    const verif = verifierPaquet(lireZip(r.zip));
    expect(verif.ok).toBe(true);
    if (verif.ok) expect(Object.keys(verif.manifeste.fichiers).sort()).toEqual(Object.keys(r.manifeste.fichiers).sort());
  });
  it('reproductible : deux assemblages identiques donnent le même paquet', () => {
    const f = () => new Date('2026-10-14T10:00:00Z');
    const a = assemblerPaquet(racine, 'ecran-salon', 1, f), b = assemblerPaquet(racine, 'ecran-salon', 1, f);
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
  });
  it('adresse par défaut <nom>.local et port OTA du matériel', () => {
    ecrire('appareils/ecran-salon.fiche.yaml', `nom: ecran-salon\nnom_affichage: "Écran salon"\nmateriel: carte-test\n`);
    const r = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(r.ok && r.manifeste.esp).toEqual({ adresse: 'ecran-salon.local', port: 6053, portOta: 3232 });
  });
  it('refus avec raisons lisibles : paramètre manquant, écran incompatible, élément exigé absent, conflit de broche, nom d\'affichage déjà pris', () => {
    ecrire('appareils/ecran-salon.yaml', APPAREIL.replace('      clim_entite: "climate.bureau"\n', ''));
    const sansParam = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!sansParam.ok && sansParam.erreurs).toContain('l\'élément page-clim : paramètre « clim_entite » manquant');

    ecrire('appareils/ecran-salon.yaml', APPAREIL);
    ecrire('bibliotheque/materiels/carte-test/fiche.yaml', FICHE_MATERIEL.replace('ecran: { largeur: 800, hauteur: 480, tactile: gt911 }', 'ecran: { largeur: 240, hauteur: 320 }'));
    const mauvaisEcran = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!mauvaisEcran.ok && mauvaisEcran.erreurs[0]).toBe('l\'élément page-clim demande un écran 800x480 : le matériel carte-test a 240x320');

    ecrire('bibliotheque/materiels/carte-test/fiche.yaml', FICHE_MATERIEL);
    ecrire('bibliotheque/elements/page-clim/fiche.yaml', FICHE_ELEMENT('page-clim', `parametres:\n  - nom: clim_id\n  - nom: clim_entite\nexigences:\n  elements: [polices-inconnues]\nbroches: [2, 9]\n`));
    const diverses = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!diverses.ok && diverses.erreurs).toEqual(expect.arrayContaining([
      'l\'élément page-clim exige aussi l\'élément polices-inconnues',
      'conflit de broche GPIO2 : l\'élément page-clim la demande, elle est déjà prise par le matériel carte-test'
    ]));

    ecrire('appareils/ecran-salon.fiche.yaml', `nom: ecran-salon\nnom_affichage: "Écran salon"\nmateriel: carte-test\n`);
    ecrire('appareils/ecran-bureau.fiche.yaml', `nom: ecran-bureau\nnom_affichage: "écran salon"\nmateriel: carte-test\n`);
    ecrire('bibliotheque/elements/page-clim/fiche.yaml', FICHE_ELEMENT('page-clim', `parametres:\n  - nom: clim_id\n  - nom: clim_entite\n`));
    const doublon = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!doublon.ok && doublon.erreurs).toEqual(['le nom d\'affichage « Écran salon » est déjà celui de l\'appareil ecran-bureau']);
  });
  it('matériel déclaré par la fiche différent du matériel inclus : refusé', () => {
    ecrire('bibliotheque/materiels/autre/base.yaml', 'esp32:\n  board: x\n');
    ecrire('bibliotheque/materiels/autre/fiche.yaml', FICHE_MATERIEL.replace('id: carte-test', 'id: autre'));
    ecrire('appareils/ecran-salon.fiche.yaml', `nom: ecran-salon\nnom_affichage: "Écran salon"\nmateriel: autre\n`);
    const r = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!r.ok && r.erreurs[0]).toBe('la fiche déclare le matériel « autre » mais le fichier inclut « carte-test »');
  });
  it('fiche d\'appareil absente : erreur claire, pas d\'exception', () => {
    fs.rmSync(path.join(racine, 'appareils/ecran-salon.fiche.yaml'));
    const r = assemblerPaquet(racine, 'ecran-salon', 1);
    expect(!r.ok && r.erreurs[0]).toContain('fiche de l\'appareil ecran-salon illisible');
  });
});

describe('écriture du zip', () => {
  it('crc32 connu ("123456789" → cbf43926)', () => {
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
  });
  it('entrées triées : ordre de départ sans effet', () => {
    const a = ecrireZip([{ chemin: 'b', contenu: Buffer.from('2') }, { chemin: 'a', contenu: Buffer.from('1') }]);
    const b = ecrireZip([{ chemin: 'a', contenu: Buffer.from('1') }, { chemin: 'b', contenu: Buffer.from('2') }]);
    expect(a.equals(b)).toBe(true);
  });
});
