import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { genererPage, elementPlan, classer, typeCapteur, slug, glyphesLitteral, widgetTexte, boiteTexte, type EntreePlan } from '../generation';

const DOSSIER = path.join(__dirname, '..', '..', '..', '..', 'src', 'domain', 'plans', '__tests__', 'fixtures');
const lire = (n: string) => fs.readFileSync(path.join(DOSSIER, n), 'utf8');
const ECRAN = { largeur: 800, hauteur: 480 };
const plans = JSON.parse(lire('plans-haplan.json')) as Record<string, { image: { largeur: number; hauteur: number }; positions: { entity_id: string; x: number | null; y: number | null }[]; texts: any[] }>;
const entree = (id: string): EntreePlan => ({ id, image: plans[id].image, positions: plans[id].positions, textes: plans[id].texts });

/** Sections de premier niveau du fragment généré par l'ancien script (image:, font:, text_sensor:, sensor:, pages_fragment:). */
function sections(texte: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let courante = '';
  for (const l of texte.split('\n')) {
    const m = /^([a-z_]+):\s*$/.exec(l);
    if (m) { courante = m[1]; out[courante] = []; } else if (courante && !l.startsWith('#')) out[courante].push(l);
  }
  return out;
}

describe('port du générateur de pages de plans — comparé à la SORTIE RÉELLE du script Python (3 plans HAPLAN, ancrage centre)', () => {
  const ref = sections(lire('floorplan_pages.golden.yaml'));
  const pages = ['original', 'Rez de chaussée', 'Premier'].map((id) => genererPage(entree(id), ECRAN, 'centre'));

  it('capteurs d\'état (text_sensor) identiques ligne pour ligne', () => {
    expect(pages.flatMap((p) => p.capteursTexte)).toEqual(ref.text_sensor.filter((l) => l !== ''));
  });
  it('valeurs de capteurs (sensor) identiques ligne pour ligne', () => {
    expect(pages.flatMap((p) => p.capteurs)).toEqual(ref.sensor.filter((l) => l !== ''));
  });
  it('pages LVGL (effacement, image de fond, widgets) identiques ligne pour ligne', () => {
    // Le script Python indente les entrées sous `pages_fragment:` ; l'élément les place sous `lvgl: pages:` (2 espaces de plus).
    const attendu = ref.pages_fragment.filter((l) => l !== '').map((l) => '  ' + l);
    expect(pages.flatMap((p) => ((e) => e)(elementPlanPages(p)))).toEqual(attendu);
  });
  it('images de fond : une par plan, nom et identifiant comme l\'ancien script', () => {
    expect(pages.map((p) => `${p.imageFilename} floorplan_bg_${p.page}`)).toEqual([
      'floorplan_original_800x480.png floorplan_bg_original', 'floorplan_rez_de_chauss_e_800x480.png floorplan_bg_rez_de_chauss_e', 'floorplan_premier_800x480.png floorplan_bg_premier'
    ]);
    expect(ref.image.filter((l) => l.includes('file:')).map((l) => l.trim())).toEqual(pages.map((p) => `- file: "${p.imageFilename}"`));
  });
  it('comptes placées / hors cadre comme l\'ancien script (33, 17, 16 placées ; 0 hors cadre)', () => {
    expect(pages.map((p) => [p.placees, p.hors])).toEqual([[33, 0], [17, 0], [16, 0]]);
  });
});

import { pageLvgl } from '../generation';
function elementPlanPages(p: ReturnType<typeof genererPage>): string[] { return pageLvgl(p, ECRAN); }

describe('classification et identifiants', () => {
  it('genres comme UnifiedObjectFactory / SwitchTypeDetector', () => {
    expect(['light.lumiere_salon', 'switch.vmc_salle_de_bain', 'switch.chauffe_eau', 'switch.radiator_x', 'switch.prise', 'cover.volet_store_salon', 'cover.garage', 'climate.salon', 'sensor.x', 'binary_sensor.y'].map((e) => classer(e)))
      .toEqual(['light', 'vmc', 'water_heater', 'radiator', 'switch', 'blind', 'cover', 'thermostat', 'sensor', 'light']);
  });
  it('la taxonomie (« quoi ») sert de repli : switch.entree_salle de quoi Radiateur est un radiateur', () => {
    expect(classer('switch.entree_salle')).toBe('switch');
    expect(classer('switch.entree_salle', 'Radiateur')).toBe('radiator');
    expect(classer('switch.cuisine_radiateur_31', 'autre')).toBe('radiator');
  });
  it('types de capteurs et slug', () => {
    expect(['sensor.temperature_x', 'sensor.humidity_y', 'sensor.pressure', 'sensor.power_w', 'sensor.energy', 'sensor.autre'].map(typeCapteur)).toEqual(['temperature', 'humidity', 'pressure', 'power', 'power', 'default']);
    expect(slug('Rez de chaussée')).toBe('rez_de_chauss_e');
    expect(slug('  À  B--C ')).toBe('b_c');
  });
});

describe('ancrage coin bas-gauche (intégration Plans) : mêmes widgets que l\'ancrage centre décalé d\'une demi-icône', () => {
  it('un objet au coin bas-gauche de l\'icône tombe où l\'ancien générateur mettait son centre − 16, + 16', () => {
    const plan: EntreePlan = { id: 'p', image: { largeur: 660, hauteur: 790 }, positions: [{ entity_id: 'light.a', x: 0.5, y: 0.5 }], textes: [] };
    const centre = genererPage(plan, ECRAN, 'centre');
    const coin = genererPage(plan, ECRAN, 'bas-gauche');
    const xy = (p: typeof centre) => [Number(/x: (\d+)/.exec(p.widgets.join('\n'))![1]), Number(/y: (\d+)/.exec(p.widgets.join('\n'))![1])];
    // même point source : « centre » place l'icône centrée dessus, « bas-gauche » la place au-dessus et à droite (coin bas-gauche sur le point)
    expect(xy(coin)[0] - xy(centre)[0]).toBe(16);
    expect(xy(centre)[1] - xy(coin)[1]).toBe(16);
  });
  it('objets hors de l\'écran ignorés et comptés', () => {
    const plan: EntreePlan = { id: 'p', image: { largeur: 660, hauteur: 790 }, positions: [{ entity_id: 'light.a', x: 3, y: 0.5 }, { entity_id: 'light.b', x: 0.5, y: 0.5 }, { entity_id: '__trash_icon__', x: 0.1, y: 0.1 }, { entity_id: 'light.c', x: null, y: 0.1 }], textes: [] };
    const r = genererPage(plan, ECRAN, 'bas-gauche');
    expect(r.hors).toBe(1);
    expect(r.widgets.join('\n')).toContain('icon_p_light_b');
    expect(r.widgets.join('\n')).not.toContain('trash');
  });
});

describe('textes libres', () => {
  it('boîte dimensionnée d\'après le nombre de caractères, bornée à l\'écran ; couleur et échappements', () => {
    expect(boiteTexte({ id: 't', text: 'Poêle', x: 0, y: 0, size: 'medium' }, ECRAN)).toEqual({ largeur: 62, hauteur: 28 });
    expect(boiteTexte({ id: 't', text: 'x'.repeat(200), x: 0, y: 0, size: 'large' }, ECRAN).largeur).toBe(792);
    const l = widgetTexte('p', { id: 'Mon Texte', text: 'Salon "bleu" \\', x: 0, y: 0, size: 'small', color: '#ff8800' }, 400, 240, ECRAN, (s) => `font_text_p_${s}`);
    expect(l).toContain('      text: "Salon \\"bleu\\" \\\\"');
    expect(l).toContain('      text_color: 0xFF8800');
    expect(l).toContain('      text_font: font_text_p_small');
    expect(l).toContain('      id: text_p_mon_texte');
  });
  it('polices par plan : un palier par taille utilisée, glyphes = caractères des textes + espace, triés', () => {
    const plan: EntreePlan = { id: 'salon', image: { largeur: 800, hauteur: 480 }, positions: [], textes: [{ id: 'a', text: 'Poêle', x: 0.5, y: 0.5, size: 'medium' }, { id: 'b', text: 'ab', x: 0.2, y: 0.2, size: 'large' }] };
    const el = elementPlan(genererPage(plan, ECRAN), ECRAN);
    expect(el).toContain('id: font_text_salon_medium');
    expect(el).toContain('id: font_text_salon_large');
    expect(el).not.toContain('font_text_salon_small');
    expect(el).toContain('glyphs: " Peloê"'); // espace, P, e, l, o, ê : triés par point de code
    expect(glyphesLitteral(new Set(['b', 'a', ' ']))).toBe('" ab"');
  });
});

describe('élément complet', () => {
  it('image, capteurs puis page LVGL, dans cet ordre', () => {
    const p = genererPage(entree('Premier'), ECRAN, 'centre');
    const el = elementPlan(p, ECRAN, '# Élément généré');
    expect(el.startsWith('# Élément généré\n\nimage:\n  - file: "floorplan_premier_800x480.png"\n    id: floorplan_bg_premier\n    type: RGB565\ntext_sensor:\n')).toBe(true);
    expect(el.indexOf('\nsensor:\n')).toBeGreaterThan(el.indexOf('\ntext_sensor:\n'));
    expect(el.indexOf('\nlvgl:\n  pages:\n    - id: page_premier')).toBeGreaterThan(el.indexOf('\nsensor:\n'));
  });
});
