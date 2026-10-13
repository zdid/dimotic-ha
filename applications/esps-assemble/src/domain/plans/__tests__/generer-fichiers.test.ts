import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { genererFichiersPlans, cheminPagePlan, SourcePlansHaplan, PlanIntrouvable, type SourcePlans } from '../generer-fichiers';
import { assemblerPaquet } from '../../assembleur/paquet';
import { lireZip } from '../../../../../esphome/dist/domain/factory/zip';
import { verifierPaquet } from '../../../../../esphome/dist/domain/factory/manifest';
import { dimensionsPng } from '../image';

const ECRAN = { largeur: 800, hauteur: 480 };
const png = (l: number, h: number): Buffer => { const p = new PNG({ width: l, height: h }); p.data.fill(180); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255; return PNG.sync.write(p); };

let dossier: string;
beforeEach(() => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  fs.mkdirSync(path.join(dossier, 'images'));
  fs.writeFileSync(path.join(dossier, 'images', 'salon.png'), png(620, 412));
  fs.writeFileSync(path.join(dossier, 'config-haplan-floorplans-v1.0.yaml'),
    `floorplans:\n  "Rez de chaussée":\n    filename: salon.png\n    positions:\n      - { entity_id: light.salon, x: 0.5, y: 0.5 }\n      - { entity_id: sensor.salon_temperature, x: 0.2, y: 0.3 }\n    texts:\n      - { id: t1, text: "Poêle", x: 0.7, y: 0.7, size: medium, color: "#ffc107" }\n`);
});

describe('fichiers générés pour les plans', () => {
  it('image ramenée à l\'écran et élément de page, depuis des plans au format HAPLAN', async () => {
    const r = await genererFichiersPlans(['Rez de chaussée'], new SourcePlansHaplan(dossier), ECRAN);
    expect([...r.fichiers.keys()].sort()).toEqual(['floorplan_rez_de_chauss_e_800x480.png', 'generes/page-plan-rez_de_chauss_e.yaml']);
    expect(dimensionsPng(r.fichiers.get('floorplan_rez_de_chauss_e_800x480.png')!)).toEqual(ECRAN);
    const el = r.fichiers.get(cheminPagePlan('Rez de chaussée'))!.toString();
    expect(el).toContain('id: floorplan_bg_rez_de_chauss_e');
    expect(el).toContain('id: font_text_rez_de_chauss_e_medium');
    expect(el).toContain('text: "Poêle"');
    expect(r.resume).toEqual([{ plan: 'Rez de chaussée', page: 'rez_de_chauss_e', placees: 3, hors: 0 }]);
  });
  it('plan inconnu : erreur claire', async () => {
    await expect(genererFichiersPlans(['absent'], new SourcePlansHaplan(dossier), ECRAN)).rejects.toThrow(PlanIntrouvable);
  });
  it('deux plans qui donnent la même page : refusé', async () => {
    const source: SourcePlans = { lire: async (id) => ({ id, image: png(10, 10), positions: [], textes: [], ancrage: 'bas-gauche' }) };
    await expect(genererFichiersPlans(['Salon', 'salon'], source, ECRAN)).rejects.toThrow(/même page/);
  });
});

describe('assemblage d\'un appareil avec pages de plans générées', () => {
  let app: string;
  const ecrire = (rel: string, contenu: string) => { const f = path.join(app, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenu); };
  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-plans-'));
    ecrire('bibliotheque/materiels/carte/base.yaml', 'esp32:\n  board: esp32dev\n');
    ecrire('bibliotheque/materiels/carte/fiche.yaml', 'id: carte\nnom: Carte\nplateforme: esp32\npuce: esp32\ncadre: arduino\ncarte: esp32dev\nflash: 4MB\nmemoire: { emplacement_ota_octets: 1835008, ram_interne_octets: 327680 }\necran: { largeur: 800, hauteur: 480 }\n');
    ecrire('bibliotheque/elements/polices-plans/element.yaml', 'font:\n  - file: "gfonts://Roboto"\n    id: font_sensor\n    size: 20\n    glyphs: "0123"\n');
    ecrire('bibliotheque/elements/polices-plans/fiche.yaml', 'id: polices-plans\nnom: Polices\n');
    ecrire('appareils/ecran.yaml', 'esphome:\n  name: ecran\npackages:\n  materiel: !include bibliotheque/materiels/carte/base.yaml\n  polices: !include bibliotheque/elements/polices-plans/element.yaml\n  plan: !include generes/page-plan-rez_de_chauss_e.yaml\n');
  });
  const fiche = (extra = '') => ecrire('appareils/ecran.fiche.yaml', `nom: ecran\nnom_affichage: "Écran"\nmateriel: carte\n${extra}`);

  it('le paquet embarque l\'élément généré ET l\'image de fond, que l\'usine accepte', async () => {
    fiche('plans: ["Rez de chaussée"]\n');
    const g = await genererFichiersPlans(['Rez de chaussée'], new SourcePlansHaplan(dossier), ECRAN);
    const r = assemblerPaquet(app, 'ecran', 1, () => new Date('2026-10-14T10:00:00Z'), g.fichiers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.manifeste.fichiers)).toEqual(expect.arrayContaining(['generes/page-plan-rez_de_chauss_e.yaml', 'floorplan_rez_de_chauss_e_800x480.png', 'ecran.yaml']));
    expect(r.avertissements.filter((a) => a.includes('annexes'))).toEqual([]);
    expect(verifierPaquet(lireZip(r.zip)).ok).toBe(true);
  });
  it('refus : plans demandés sans l\'élément polices-plans, ou sans écran', async () => {
    fiche('plans: ["Rez de chaussée"]\n');
    ecrire('appareils/ecran.yaml', 'esphome:\n  name: ecran\npackages:\n  materiel: !include bibliotheque/materiels/carte/base.yaml\n  plan: !include generes/page-plan-rez_de_chauss_e.yaml\n');
    const g = await genererFichiersPlans(['Rez de chaussée'], new SourcePlansHaplan(dossier), ECRAN);
    const r = assemblerPaquet(app, 'ecran', 1, () => new Date(), g.fichiers);
    expect(!r.ok && r.erreurs[0]).toContain('polices-plans');
  });
  it('inclusion d\'un fichier généré absent : message clair', () => {
    fiche();
    const r = assemblerPaquet(app, 'ecran', 1);
    expect(!r.ok && r.erreurs[0]).toContain('fichier inclus introuvable : generes/page-plan-rez_de_chauss_e.yaml');
  });
});
