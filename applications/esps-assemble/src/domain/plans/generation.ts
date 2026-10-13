/**
 * Génération d'une page de plan LVGL (800x480 ou autre écran) pour ESPHome — port TypeScript de `tools/generate_esphome_floorplan.py`
 * (partie « plans » ; les pages Énergie, Ballons et Climatisation sont des éléments de la bibliothèque, déjà écrits).
 *
 * Entrée : un plan (positions `{entity_id, x, y}` et textes libres, fractions 0–1 de l'image) et les dimensions de l'écran.
 * Sortie : lignes de capteurs `text_sensor:` / `sensor:` (état poussé par HA), widgets d'une page LVGL, textes (polices), et l'élément
 * ESPHome complet (`element.yaml`) d'une page de plan. Mêmes chaînes que l'ancien script, caractère pour caractère (voir les tests,
 * comparés à la sortie réelle du script Python).
 *
 * Deux conventions de position : `centre` (anciens plans HAPLAN) et `bas-gauche` (intégration Plans) — voir coordonnees.ts.
 */

import { ajuster, versPixels, boiteCentree, arrondi, type Dimensions } from './coordonnees';

export const COLOR_ON = '0xFFC107';
export const COLOR_OFF = '0x9E9E9E';
export const COLOR_SENSOR_TEXT = '0xFFFFFF';
export const ICON_BG_DIAMETER = 32;
export const SENSOR_LABEL_WIDTH = 130;
export const SENSOR_LABEL_HEIGHT = 32;
export const SENSOR_ICON_LABEL_GAP_PX = 4;
export const TEXT_FONT_SIZE_BY_SIZE: Record<string, number> = { small: 14, medium: 20, large: 28 };
export const TEXT_CHAR_WIDTH_FACTOR = 0.62;

const g = (code: number): string => String.fromCodePoint(code);
const ICON = {
  lightbulb: g(0xf0eb), toggleOn: g(0xf205), toggleOff: g(0xf204), windowMax: g(0xf2d0), windowMin: g(0xf2d1), water: g(0xf773), wind: g(0xf72e),
  fire: g(0xf06d), snowflake: g(0xf2dc), thermometer: g(0xf2c9), tint: g(0xf043), tachometer: g(0xf3fd), bolt: g(0xf0e7), infoCircle: g(0xf05a)
};

const COLOR_SENSOR: Record<string, string> = { temperature: '0xF44336', humidity: '0x00BCD4', pressure: '0x9C27B0', power: '0xFFC107', default: '0x607D8B' };
const ICON_AND_COLOR_BY_SENSOR_TYPE: Record<string, [string, string]> = {
  temperature: [ICON.thermometer, COLOR_SENSOR.temperature], humidity: [ICON.tint, COLOR_SENSOR.humidity], pressure: [ICON.tachometer, COLOR_SENSOR.pressure],
  power: [ICON.bolt, COLOR_SENSOR.power], default: [ICON.infoCircle, COLOR_SENSOR.default]
};

export type Genre = 'light' | 'switch' | 'vmc' | 'water_heater' | 'radiator' | 'cover' | 'blind' | 'thermostat' | 'sensor';
const ICON_BY_KIND: Record<Exclude<Genre, 'sensor'>, [string, string]> = {
  light: [ICON.lightbulb, ICON.lightbulb], switch: [ICON.toggleOff, ICON.toggleOn], vmc: [ICON.wind, ICON.wind], water_heater: [ICON.water, ICON.water],
  radiator: [ICON.snowflake, ICON.fire], cover: [ICON.windowMin, ICON.windowMax], blind: [ICON.windowMin, ICON.windowMax], thermostat: [ICON.thermometer, ICON.thermometer]
};
// thermostat exclu : pas d'action simple « toggle » pour climate.* ; sensor.* n'a aucune action.
const TOUCHABLE_KINDS = new Set<string>(['light', 'switch', 'vmc', 'water_heater', 'radiator', 'cover', 'blind']);

/** Identifiant ESPHome sûr : minuscules, chiffres, soulignés (`re.sub(r"[^a-zA-Z0-9]+", "_", …)`). */
export function slug(texte: string): string {
  return texte.trim().toLowerCase().replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Type d'objet d'après l'identifiant d'entité (comme UnifiedObjectFactory / SwitchTypeDetector de HAPLAN) ; `quoi` (taxonomie de
 * l'intégration Plans) sert de repli quand l'identifiant ne contient aucun mot-clé (ex. `switch.entree_salle` dont le « quoi » est Radiateur).
 */
export function classer(entityId: string, quoi?: string | null): Genre {
  const domaine = entityId.split('.', 1)[0];
  const low = entityId.toLowerCase();
  if (domaine === 'sensor') return 'sensor';
  if (domaine === 'light' || domaine === 'switch') {
    const par = (t: string): Genre | null =>
      /ventilation|vmc|fan/.test(t) ? 'vmc' : /water_heater|chauffe_eau|ballon/.test(t) ? 'water_heater' : /radiator|radiateur|heating|chauffage/.test(t) ? 'radiator' : null;
    return par(low) ?? (quoi ? par(quoi.toLowerCase()) : null) ?? (domaine === 'light' ? 'light' : 'switch');
  }
  if (domaine === 'cover') return /blind|store/.test(low) ? 'blind' : 'cover';
  if (domaine === 'climate') return 'thermostat';
  return 'light';
}

export function typeCapteur(entityId: string): string {
  const low = entityId.toLowerCase();
  if (low.includes('temperature')) return 'temperature';
  if (low.includes('humidity')) return 'humidity';
  if (low.includes('pressure')) return 'pressure';
  if (low.includes('power') || low.includes('energy')) return 'power';
  return 'default';
}

export interface Blocs { capteurs: string[]; widgets: string[] }

export function echapperLvgl(texte: string): string {
  return texte.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function widgetIcone(page: string, entityId: string, genre: Exclude<Genre, 'sensor'>, px: number, py: number, ecran: Dimensions): Blocs {
  const eid = `${page}_${slug(entityId)}`;
  const domaine = entityId.split('.', 1)[0];
  const [iconeOff, iconeOn] = ICON_BY_KIND[genre];
  const b = boiteCentree(px, py, { largeur: ICON_BG_DIAMETER, hauteur: ICON_BG_DIAMETER }, ecran);
  const capteurs = ['  - platform: homeassistant', `    id: ha_${eid}`, `    entity_id: ${entityId}`, '    internal: true', '    on_value:'];
  if (iconeOff !== iconeOn) {
    capteurs.push(
      '      - lvgl.label.update:', `          id: icon_${eid}`, '          text: !lambda |-',
      '            return (x == "on" || x == "open" || x == "heat" || x == "cool")',
      `              ? std::string("${iconeOn}") : std::string("${iconeOff}");`
    );
  }
  capteurs.push(
    '      - lvgl.label.update:', `          id: icon_${eid}`, '          text_color: !lambda |-',
    '            return (x == "on" || x == "open" || x == "heat" || x == "cool")',
    `              ? lv_color_hex(${COLOR_ON}) : lv_color_hex(${COLOR_OFF});`
  );
  const widgets = [
    '  - label:', `      id: icon_${eid}`, `      x: ${b.x}`, `      y: ${b.y}`, `      width: ${ICON_BG_DIAMETER}`, `      height: ${ICON_BG_DIAMETER}`,
    '      text_align: CENTER', '      text_font: font_icons', `      text: "${iconeOff}"`, `      text_color: ${COLOR_OFF}`, '      bg_opa: TRANSP'
  ];
  if (TOUCHABLE_KINDS.has(genre)) {
    // clickable: true indispensable (un label LVGL n'est pas cliquable par défaut). Côté HA, l'appareil doit être autorisé à envoyer des
    // actions (option « Autoriser l'appareil à effectuer des actions Home Assistant ») : sans elle l'action est refusée en silence.
    widgets.push('      clickable: true', '      on_click:', '        - homeassistant.service:', `            service: ${domaine}.toggle`, '            data:', `              entity_id: ${entityId}`);
  }
  return { capteurs, widgets };
}

export function widgetCapteur(page: string, entityId: string, px: number, py: number, ecran: Dimensions): Blocs {
  const eid = `${page}_${slug(entityId)}`;
  const [glyphe, couleur] = ICON_AND_COLOR_BY_SENSOR_TYPE[typeCapteur(entityId)];
  const i = boiteCentree(px, py, { largeur: ICON_BG_DIAMETER, hauteur: ICON_BG_DIAMETER }, ecran);
  // Valeur ancrée par son bord GAUCHE, juste après l'icône : « faux centre » = bord gauche voulu + moitié de la largeur.
  const labelLeft = px + Math.floor(ICON_BG_DIAMETER / 2) + SENSOR_ICON_LABEL_GAP_PX;
  const l = boiteCentree(labelLeft + Math.floor(SENSOR_LABEL_WIDTH / 2), py, { largeur: SENSOR_LABEL_WIDTH, hauteur: SENSOR_LABEL_HEIGHT }, ecran);
  const capteurs = [
    '  - platform: homeassistant', `    id: ha_${eid}`, `    entity_id: ${entityId}`, '    internal: true', '    on_value:',
    '      - lvgl.label.update:', `          id: lbl_${eid}`, '          text: !lambda |-',
    // x est NAN quand HA envoie un état non numérique (unavailable/unknown) : sans ce garde, snprintf affiche « nan » à l'écran.
    '            if (std::isnan(x)) return std::string("--");', '            char buf[16];', '            snprintf(buf, sizeof(buf), "%.1f", x);', '            return std::string(buf);'
  ];
  const widgets = [
    '  - label:', `      id: icon_${eid}`, `      x: ${i.x}`, `      y: ${i.y}`, `      width: ${ICON_BG_DIAMETER}`, `      height: ${ICON_BG_DIAMETER}`,
    '      text_align: CENTER', '      text_font: font_icons', `      text: "${glyphe}"`, `      text_color: ${couleur}`, '      bg_opa: TRANSP',
    '  - label:', `      id: lbl_${eid}`, `      x: ${l.x}`, `      y: ${l.y}`, `      width: ${SENSOR_LABEL_WIDTH}`, `      height: ${SENSOR_LABEL_HEIGHT}`,
    '      text: "--"', '      text_align: LEFT', `      text_color: ${COLOR_SENSOR_TEXT}`, '      text_font: font_sensor',
    // Boîte transparente : un fond opaque masquerait des morceaux du plan et des icônes voisines.
    '      bg_opa: TRANSP'
  ];
  return { capteurs, widgets };
}

export interface TexteLibre { id: string; text: string; x: number; y: number; size?: string; color?: string }

/** Boîte d'un texte libre, dimensionnée d'après le nombre de caractères (aucune mesure réelle possible hors du firmware). */
export function boiteTexte(texte: TexteLibre, ecran: Dimensions): { largeur: number; hauteur: number } {
  const taille = TEXT_FONT_SIZE_BY_SIZE[texte.size || 'medium'] ?? TEXT_FONT_SIZE_BY_SIZE.medium;
  return { largeur: Math.min(ecran.largeur - 8, Math.max(taille * 2, arrondi([...texte.text].length * taille * TEXT_CHAR_WIDTH_FACTOR))), hauteur: arrondi(taille * 1.4) };
}

/** `idPolice` : identifiant de la police du palier (par plan, pour que deux plans ne définissent pas la même police). */
export function widgetTexte(page: string, texte: TexteLibre, px: number, py: number, ecran: Dimensions, idPolice: (taille: string) => string): string[] {
  const taille = texte.size || 'medium';
  const couleur = (texte.color || '#FFFFFF').replace(/^#+/, '').toUpperCase();
  const boite = boiteTexte(texte, ecran);
  const b = boiteCentree(px, py, boite, ecran);
  return [
    '  - label:', `      id: text_${page}_${slug(texte.id)}`, `      x: ${b.x}`, `      y: ${b.y}`, `      width: ${boite.largeur}`, `      height: ${boite.hauteur}`,
    `      text: "${echapperLvgl(texte.text)}"`, '      text_align: CENTER', `      text_color: 0x${couleur}`, `      text_font: ${idPolice(taille)}`, '      bg_opa: TRANSP'
  ];
}

/** Valeur `glyphs: "…"` d'une police : caractères triés par point de code, échappés. */
export function glyphesLitteral(caracteres: Set<string>): string {
  const tries = [...caracteres].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('');
  return `"${tries.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface PositionPlan { entity_id: string; x: number | null; y: number | null; quoi?: string | null }

export interface EntreePlan {
  /** Identifiant du plan (« original », « Rez de chaussée »…) : la page s'appelle `slug(id)`. */
  id: string;
  image: Dimensions;
  positions: PositionPlan[];
  textes: TexteLibre[];
}

export interface PagePlan {
  page: string;
  imageFilename: string;
  capteursTexte: string[];
  capteurs: string[];
  widgets: string[];
  textesUtilises: TexteLibre[];
  placees: number;
  hors: number;
}

export type Ancrage = 'centre' | 'bas-gauche';

export function genererPage(plan: EntreePlan, ecran: Dimensions, ancrage: Ancrage = 'bas-gauche'): PagePlan {
  const page = slug(plan.id) || 'plan';
  const a = ajuster(plan.image, ecran);
  const decalage = ancrage === 'bas-gauche' ? 1 : 0;
  const positions = plan.positions.filter((p) => p.x != null && p.y != null && !String(p.entity_id ?? '').startsWith('__'));
  const textes = plan.textes.filter((t) => t.text);
  const capteursTexte: string[] = [], capteurs: string[] = [], widgets: string[] = [];
  let hors = 0;
  for (const pos of positions) {
    const p = versPixels(pos.x as number, pos.y as number, plan.image, a);
    const genre = classer(pos.entity_id, pos.quoi);
    // Coin bas-gauche → centre de l'icône (demi-boîte vers la droite et vers le haut), puis test « dans l'écran » sur le centre.
    const px = p.x + decalage * Math.floor(ICON_BG_DIAMETER / 2), py = p.y - decalage * Math.floor(ICON_BG_DIAMETER / 2);
    if (!(px >= 0 && px <= ecran.largeur && py >= 0 && py <= ecran.hauteur)) { hors++; continue; }
    if (genre === 'sensor') { const r = widgetCapteur(page, pos.entity_id, px, py, ecran); capteurs.push(...r.capteurs); widgets.push(...r.widgets); }
    else { const r = widgetIcone(page, pos.entity_id, genre, px, py, ecran); capteursTexte.push(...r.capteurs); widgets.push(...r.widgets); }
  }
  const textesUtilises: TexteLibre[] = [];
  for (const t of textes) {
    const p = versPixels(t.x, t.y, plan.image, a);
    const boite = boiteTexte(t, ecran);
    const px = p.x + decalage * Math.floor(boite.largeur / 2), py = p.y - decalage * Math.floor(boite.hauteur / 2);
    if (!(px >= 0 && px <= ecran.largeur && py >= 0 && py <= ecran.hauteur)) { hors++; continue; }
    widgets.push(...widgetTexte(page, t, px, py, ecran, (s) => `font_text_${page}_${s}`));
    textesUtilises.push(t);
  }
  return { page, imageFilename: `floorplan_${page}_${ecran.largeur}x${ecran.hauteur}.png`, capteursTexte, capteurs, widgets, textesUtilises, placees: positions.length + textes.length - hors, hors };
}

/** Polices des textes libres d'UNE page : un palier par taille utilisée, glyphes = caractères des textes de ce palier (+ espace). */
export function policesTextes(r: PagePlan): string[] {
  const parTaille = new Map<string, Set<string>>();
  for (const t of r.textesUtilises) {
    const s = t.size || 'medium';
    const c = parTaille.get(s) ?? new Set<string>();
    for (const ch of t.text) c.add(ch);
    c.add(' ');
    parTaille.set(s, c);
  }
  const lignes: string[] = [];
  for (const s of ['small', 'medium', 'large']) {
    const c = parTaille.get(s);
    if (!c) continue;
    lignes.push('  - file: "gfonts://Roboto"', `    id: font_text_${r.page}_${s}`, `    size: ${TEXT_FONT_SIZE_BY_SIZE[s]}`, `    glyphs: ${glyphesLitteral(c)}`);
  }
  return lignes;
}

/** Entrée de page LVGL : effacement plein écran, image de fond, widgets (indentés comme `pages_fragment` de l'ancien script). */
export function pageLvgl(r: PagePlan, ecran: Dimensions): string[] {
  const l = [
    `    - id: page_${r.page}`, '      widgets:', '        - obj:', `            id: full_screen_clear_${r.page}`, '            x: 0', '            y: 0',
    `            width: ${ecran.largeur}`, `            height: ${ecran.hauteur}`, '            bg_color: 0x000000', '            bg_opa: COVER', '            border_width: 0', '            radius: 0',
    '        - image:', `            src: floorplan_bg_${r.page}`, '            x: 0', '            y: 0', `            width: ${ecran.largeur}`, `            height: ${ecran.hauteur}`
  ];
  for (const w of r.widgets) l.push(w.trim() ? '      ' + w : w);
  return l;
}

/** Élément ESPHome complet d'une page de plan (`element.yaml`). */
export function elementPlan(r: PagePlan, ecran: Dimensions, entete = ''): string {
  const lignes: string[] = [];
  if (entete) lignes.push(entete.trimEnd(), '');
  lignes.push('image:', `  - file: "${r.imageFilename}"`, `    id: floorplan_bg_${r.page}`, '    type: RGB565');
  const polices = policesTextes(r);
  if (polices.length) lignes.push('font:', ...polices);
  if (r.capteursTexte.length) lignes.push('text_sensor:', ...r.capteursTexte);
  if (r.capteurs.length) lignes.push('sensor:', ...r.capteurs);
  lignes.push('lvgl:', '  pages:', ...pageLvgl(r, ecran));
  return lignes.join('\n') + '\n';
}
