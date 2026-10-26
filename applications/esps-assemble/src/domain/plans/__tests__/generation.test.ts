import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chargerYamlTexte } from '../../assembleur/resolution';
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

describe('fond noir des objets (fiche : fond_plans: noir)', () => {
  const fond = { noir: true, tailleIcone: 17, tailleValeur: 17 };
  const sans = genererPage(entree('Premier'), ECRAN);
  const avec = genererPage(entree('Premier'), ECRAN, 'bas-gauche', 17, fond);
  const sansFond = genererPage(entree('Premier'), ECRAN, 'bas-gauche', 17);

  it('sans option : toutes les boîtes restent transparentes (comportement inchangé)', () => {
    expect(sans.widgets.some((l) => l.includes('bg_color: 0x000000') && !l.includes('bg_opa: COVER'))).toBe(false);
    expect(sansFond.widgets.filter((l) => l === '      bg_opa: TRANSP').length).toBeGreaterThan(0);
    expect(sansFond.widgets.filter((l) => l.includes('bg_color: 0x000000'))).toHaveLength(0);
  });

  it('avec le fond noir : chaque icône, valeur et texte a un fond noir opaque, plus aucune boîte transparente', () => {
    const etiquettes = avec.widgets.filter((l) => l === '  - label:').length;
    expect(etiquettes).toBeGreaterThan(0);
    expect(avec.widgets.filter((l) => l === '      bg_color: 0x000000')).toHaveLength(etiquettes);
    expect(avec.widgets.filter((l) => l === '      bg_opa: COVER')).toHaveLength(etiquettes);
    expect(avec.widgets.filter((l) => l === '      bg_opa: TRANSP')).toHaveLength(0);
  });

  it('les boîtes sont ajustées au contenu : icône = police + 8, valeur plus étroite que la boîte transparente de 130 px', () => {
    const largeurs = avec.widgets.filter((l) => l.startsWith('      width: ')).map((l) => Number(l.slice(13)));
    expect(largeurs).toContain(25);                    // icône : 17 + 8
    expect(largeurs).not.toContain(130);               // plus de boîte de valeur large
    expect(largeurs).not.toContain(32);                // plus de boîte d'icône de 32 px
    expect(sansFond.widgets.filter((l) => l === '      width: 32').length).toBeGreaterThan(0);
  });

  it('le centre des icônes ne bouge pas : même nombre d\'objets placés, même ordre', () => {
    expect(avec.placees).toBe(sansFond.placees);
    expect(avec.widgets.filter((l) => l.startsWith('      id: icon_'))).toEqual(sansFond.widgets.filter((l) => l.startsWith('      id: icon_')));
  });

  it('texte libre : fond noir aussi', () => {
    const t = widgetTexte('p', { id: 't1', text: 'Salon', x: 10, y: 10 }, 100, 100, ECRAN, (s) => `f_${s}`, 17, fond);
    expect(t).toContain('      bg_color: 0x000000');
    expect(t).toContain('      bg_opa: COVER');
    expect(widgetTexte('p', { id: 't1', text: 'Salon', x: 10, y: 10 }, 100, 100, ECRAN, (s) => `f_${s}`, 17)).toContain('      bg_opa: TRANSP');
  });
});

describe('fond noir : icône posée coin bas-gauche sur le point, glyphe centré dans sa boîte', () => {
  const fond = { noir: true, tailleIcone: 17, tailleValeur: 17 };
  // Image de la taille de l'écran : échelle 1, aucun décalage ; point au centre (400, 240).
  const plan: EntreePlan = { id: 'p', image: ECRAN, positions: [{ entity_id: 'light.salon', x: 0.5, y: 0.5 }], textes: [] };
  const valeur = (lignes: string[], cle: string, apres: string): number => {
    const i = lignes.findIndex((l) => l === `      id: ${apres}`);
    return Number(lignes.slice(i).find((l) => l.startsWith(`      ${cle}: `))!.split(': ')[1]);
  };

  it('icône : coin bas-gauche de la boîte sur le point, centrage vertical du glyphe (pad_top)', () => {
    const w = genererPage(plan, ECRAN, 'bas-gauche', 17, fond).widgets;
    expect(valeur(w, 'x', 'icon_p_light_salon')).toBe(400);                         // bord gauche = point
    expect(Math.abs(valeur(w, 'y', 'icon_p_light_salon') + 25 - 240)).toBeLessThanOrEqual(1); // bord bas = point (±1 px, côté impair)
    expect(w).toContain('      pad_top: 4');                                          // (25 − 17) / 2
  });

  it('sans fond noir : placement historique inchangé (boîte de 32 px centrée à +16 / −16 du point)', () => {
    const w = genererPage(plan, ECRAN, 'bas-gauche', 17).widgets;
    expect(valeur(w, 'x', 'icon_p_light_salon')).toBe(400);
    expect(valeur(w, 'y', 'icon_p_light_salon')).toBe(208);
    expect(w.some((l) => l.startsWith('      pad_top'))).toBe(false);
  });

  it('valeur de capteur : à droite de la boîte noire de l\'icône, texte centré verticalement', () => {
    const c: EntreePlan = { ...plan, positions: [{ entity_id: 'sensor.salon_temperature', x: 0.5, y: 0.5 }] };
    const w = genererPage(c, ECRAN, 'bas-gauche', 17, fond).widgets;
    expect(valeur(w, 'x', 'lbl_p_sensor_salon_temperature')).toBe(400 + 25 + 4);     // bord droit de l'icône + 4 px
    expect(w).toContain('      pad_left: 4');
    expect(w.filter((l) => l.startsWith('      pad_top: ')).length).toBe(2);          // icône + valeur
  });
});

describe('boîtes de réglage (fiche : reglages_plans) — thermostat et volet', () => {
  const fond = { noir: true, tailleIcone: 17, tailleValeur: 17 };
  const plan: EntreePlan = {
    id: 'p', image: ECRAN, textes: [],
    positions: [
      { entity_id: 'climate.salon', x: 0.2, y: 0.5 }, { entity_id: 'climate.chambre', x: 0.4, y: 0.5 },
      { entity_id: 'cover.volet_salon', x: 0.6, y: 0.5 }, { entity_id: 'light.salon', x: 0.8, y: 0.5 }
    ]
  };
  const avec = genererPage(plan, ECRAN, 'bas-gauche', 17, fond, true);
  const sans = genererPage(plan, ECRAN, 'bas-gauche', 17, fond);
  const texte = (l: string[]) => l.join('\n');

  it('sans l\'option : aucune boîte, thermostat sans action, volet = simple bascule (comportement historique)', () => {
    expect(texte(sans.widgets)).not.toContain('pop_p_');
    expect(sans.globals).toEqual([]);
    expect(texte(sans.widgets)).toContain('cover.toggle');
    expect(texte(sans.capteurs)).not.toContain('hacur_');
  });

  it('thermostat : valeur « actuelle/consigne » sur le plan, appui → boîte ; capteurs de la température et de la consigne', () => {
    const w = texte(avec.widgets);
    expect(w).toContain('id: lbl_p_climate_salon');
    expect(w).toContain('- lvgl.widget.show: pop_p_th');
    expect(texte(avec.capteurs)).toContain('attribute: current_temperature');
    expect(texte(avec.capteurs)).toContain('attribute: temperature');
    expect(texte(avec.capteursTexte)).toContain('attribute: friendly_name');
    expect(texte(avec.capteursTexte)).toContain('attribute: hvac_modes');
    // la valeur affiche l'actuelle ET la consigne
    expect(texte(avec.capteurs)).toContain('"%.1f%s/%.1f", c, m, s');
  });

  it('volet : plus de bascule directe, l\'appui ouvre la boîte (ouvrir / stop / fermer / position)', () => {
    const w = texte(avec.widgets);
    expect(w).not.toContain('cover.toggle');
    expect(w).toContain('- lvgl.widget.show: pop_p_cv');
    expect(w).toContain('service: cover.open_cover');
    expect(w).toContain('service: cover.stop_cover');
    expect(w).toContain('service: cover.close_cover');
    expect(w).toContain('service: cover.set_cover_position');
    expect(texte(avec.capteurs)).toContain('attribute: current_position');
  });

  it('une seule boîte par type et par page, posée en dernier (au-dessus du plan) ; la lumière reste une simple bascule', () => {
    const w = texte(avec.widgets);
    expect(w.match(/id: pop_p_th$/gm)).toHaveLength(1);
    expect(w.match(/id: pop_p_cv$/gm)).toHaveLength(1);
    expect(w.lastIndexOf('id: pop_p_cv')).toBeGreaterThan(w.lastIndexOf('id: icon_p_light_salon'));
    expect(w).toContain('light.toggle');
    expect(avec.globals.join('\n')).toContain('id: pop_p_th_ent');
    expect(avec.globals.join('\n')).toContain('id: pop_p_cv_ent');
  });

  it('une page sans thermostat ni volet n\'a pas de boîte, ni de variable globale', () => {
    const p = genererPage({ ...plan, positions: [{ entity_id: 'light.salon', x: 0.5, y: 0.5 }] }, ECRAN, 'bas-gauche', 17, fond, true);
    expect(texte(p.widgets)).not.toContain('pop_p_');
    expect(p.globals).toEqual([]);
  });

  it('boîte du thermostat : consigne − / + par pas de 0,5 °C, marche / arrêt, mode parmi ceux que l\'appareil annonce', () => {
    const w = texte(avec.widgets);
    expect(w).toContain('t = t - 0.5f;');
    expect(w).toContain('t = t + 0.5f;');
    expect(w).toContain('service: climate.set_temperature');
    expect(w).toContain('service: climate.turn_off');
    expect(w).toContain('service: climate.turn_on');
    expect(w).toContain('service: climate.set_hvac_mode');
    expect(w).toContain('static const char* modes[] = {"heat", "cool", "heat_cool", "auto", "dry", "fan_only"};');
  });

  it('l\'élément complet porte la section globals, et le YAML produit est lisible', () => {
    const el = elementPlan(avec, ECRAN);
    expect(el).toContain('\nglobals:\n');
    expect(() => chargerYamlTexte(el, 'essai.yaml')).not.toThrow();
  });

  it('identifiant d\'entité douteux refusé (jamais injecté dans le code C++)', () => {
    expect(() => genererPage({ ...plan, positions: [{ entity_id: 'climate.x"; system("rm"); "', x: 0.5, y: 0.5 }] }, ECRAN, 'bas-gauche', 17, fond, true)).toThrow(/invalide/);
  });
});

describe('titre des boîtes de réglage : nom à la convention ramené à « Quoi précis lieu »', () => {
  const fond = { noir: true, tailleIcone: 17, tailleValeur: 17 };
  const plan: EntreePlan = { id: 'p', image: ECRAN, textes: [], positions: [{ entity_id: 'climate.poele', x: 0.3, y: 0.5 }, { entity_id: 'cover.volet', x: 0.6, y: 0.5 }] };
  const w = genererPage(plan, ECRAN, 'bas-gauche', 17, fond, true).widgets.join('\n');

  it('le titre n\'est plus le nom complet de HA : une conversion est faite dans la boîte du thermostat comme du volet', () => {
    expect(w).not.toMatch(/text: !lambda 'return id\(hanom_[a-z0-9_]+\)\.state;'/);
    // thermostat : icône ET valeur ouvrent la boîte (2 fois) ; volet : icône (1 fois)
    expect(w.match(/n\.find\("---"\)/g)).toHaveLength(3);
  });

  it('le calcul C++ garde le nom tel quel s\'il ne suit pas la convention, et saute le lieu précis égal au lieu', () => {
    expect(w).toContain('if (i == std::string::npos) return n;');
    expect(w).toContain('s[0] != s[1]');
  });
});

describe('thermomètre de la pièce pour un thermostat / climatiseur', () => {
  const fond = { noir: true, tailleIcone: 17, tailleValeur: 17 };
  const plan: EntreePlan = { id: 'p', image: ECRAN, textes: [], positions: [{ entity_id: 'climate.clim_salle', x: 0.3, y: 0.5 }, { entity_id: 'climate.clim_bureau', x: 0.6, y: 0.5 }] };
  const pg = genererPage(plan, ECRAN, 'bas-gauche', 17, fond, true, { 'climate.clim_salle': 'sensor.salle_temperature' });
  const capt = pg.capteurs.join('\n');

  it('l\'entité associée est suivie ; la température affichée est celle du thermomètre, avec repli signalé par « * »', () => {
    expect(capt).toContain('id: haref_p_climate_clim_salle');
    expect(capt).toContain('entity_id: sensor.salle_temperature');
    expect(capt).toContain('float r = id(haref_p_climate_clim_salle).state; float c = std::isnan(r) ? id(hacur_p_climate_clim_salle).state : r; bool fb = std::isnan(r);');
    expect(capt).toContain('const char* m = fb ? "*" : "";');
  });

  it('un climatiseur sans thermomètre garde sa propre température, sans marqueur', () => {
    expect(capt).not.toContain('haref_p_climate_clim_bureau');
    expect(capt).toContain('float c = id(hacur_p_climate_clim_bureau).state; bool fb = false;');
  });

  it('identifiant de thermomètre douteux refusé', () => {
    expect(() => genererPage(plan, ECRAN, 'bas-gauche', 17, fond, true, { 'climate.clim_salle': 'sensor.x"; rm' })).toThrow(/thermomètre invalide/);
  });
});
