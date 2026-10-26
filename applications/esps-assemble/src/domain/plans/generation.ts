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

import { ajuster, versPixels, boiteCentree, arrondi, type Ancrage, type Dimensions } from './coordonnees';
import { GENRES_REGLABLES, typeBoite, idBoite, boitesPage, FORMAT_TEMP, LAMBDA_TITRE, LAMBDA_LIBELLE_MODE, LAMBDA_LIBELLE_VOLET, type TypeBoite } from './reglages';

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

/** Fond noir des objets (fiche : `fond_plans: noir`) : chaque icône, valeur et texte est posé sur une boîte noire opaque, ajustée à son contenu
 *  (tailles de la fiche) pour rester lisible sur les traits du plan sans masquer les objets voisins. Absent = boîtes transparentes (défaut). */
export interface Fond { noir: boolean; tailleIcone: number; tailleValeur: number }

const FOND_NOIR = ['      bg_color: 0x000000', '      bg_opa: COVER'];
/** Hauteur de ligne d'une police Roboto, en multiple de sa taille ; une police Font Awesome (icônes) tient dans sa taille. */
const HAUTEUR_LIGNE_ROBOTO = 1.17;
/** LVGL écrit le texte d'un label EN HAUT de sa boîte : avec le fond noir, `pad_top` ramène le texte au milieu verticalement. */
const padHaut = (hauteurBoite: number, hauteurLigne: number): number => Math.max(0, Math.round((hauteurBoite - hauteurLigne) / 2));
const FOND_TRANSPARENT = ['      bg_opa: TRANSP'];
const fondDe = (fond?: Fond): string[] => (fond?.noir ? FOND_NOIR : FOND_TRANSPARENT);
/** Côté de la boîte d'une icône : 32 px nominaux (ancrage inchangé) ; avec le fond noir, la police + 8 px. */
const coteIcone = (fond?: Fond): number => (fond?.noir ? fond.tailleIcone + 8 : ICON_BG_DIAMETER);

export function widgetIcone(page: string, entityId: string, genre: Exclude<Genre, 'sensor'>, px: number, py: number, ecran: Dimensions, fond?: Fond): Blocs {
  const eid = `${page}_${slug(entityId)}`;
  const domaine = entityId.split('.', 1)[0];
  const [iconeOff, iconeOn] = ICON_BY_KIND[genre];
  const cote = coteIcone(fond);
  const b = boiteCentree(px, py, { largeur: cote, hauteur: cote }, ecran);
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
    '  - label:', `      id: icon_${eid}`, `      x: ${b.x}`, `      y: ${b.y}`, `      width: ${cote}`, `      height: ${cote}`,
    '      text_align: CENTER', '      text_font: font_icons', `      text: "${iconeOff}"`, `      text_color: ${COLOR_OFF}`, ...fondDe(fond),
    ...(fond?.noir ? [`      pad_top: ${padHaut(cote, fond.tailleIcone)}`] : [])
  ];
  if (TOUCHABLE_KINDS.has(genre)) {
    // clickable: true indispensable (un label LVGL n'est pas cliquable par défaut). Côté HA, l'appareil doit être autorisé à envoyer des
    // actions (option « Autoriser l'appareil à effectuer des actions Home Assistant ») : sans elle l'action est refusée en silence.
    widgets.push('      clickable: true', '      on_click:', '        - homeassistant.service:', `            service: ${domaine}.toggle`, '            data:', `              entity_id: ${entityId}`);
  }
  return { capteurs, widgets };
}

export interface BlocsReglage { capteursTexte: string[]; capteurs: string[]; widgets: string[] }

/** Lambda C++ du texte de valeur d'un thermostat sur le plan : « 21.5/19.0 » (température actuelle / consigne). */
const lambdaValeurThermostat = (eid: string, thermometre?: string): string =>
  `${preCourante(eid, thermometre)} float s = id(hasp_${eid}).state; if (std::isnan(c) && std::isnan(s)) return std::string("--"); char b[28]; const char* m = fb ? "*" : ""; ` +
  `if (std::isnan(c)) snprintf(b, sizeof(b), "--/%.1f", s); else if (std::isnan(s)) snprintf(b, sizeof(b), "%.1f%s/--", c, m); else snprintf(b, sizeof(b), "%.1f%s/%.1f", c, m, s); return std::string(b);`;

/**
 * Température actuelle d'un thermostat : celle du thermomètre de la pièce quand il est associé et disponible (un climatiseur au plafond mesure l'air
 * chaud du haut), sinon celle du thermostat lui-même ; `fb` (repli) est vrai quand un thermomètre est prévu mais indisponible (affiché avec « * »).
 */
const preCourante = (eid: string, thermometre?: string): string =>
  thermometre
    ? `float r = id(haref_${eid}).state; float c = std::isnan(r) ? id(hacur_${eid}).state : r; bool fb = std::isnan(r);`
    : `float c = id(hacur_${eid}).state; bool fb = false;`;
/** Texte de la température actuelle dans la boîte de réglage. */
const lambdaCourante = (eid: string, thermometre?: string): string =>
  `${preCourante(eid, thermometre)} if (std::isnan(c)) return std::string("--"); char b[16]; snprintf(b, sizeof(b), "%.1f%s", c, fb ? "*" : ""); return std::string(b);`;

const LAMBDA_POSITION = 'if (std::isnan(x)) return std::string("--"); char s[12]; snprintf(s, sizeof(s), "%d %%", (int) x); return std::string(s);';

/**
 * Objet qui ouvre une boîte de réglage à l'appui (fiche `reglages_plans`) : thermostat (icône + « actuelle/consigne » à côté) et volet (icône).
 * Les capteurs de l'objet tiennent la boîte à jour quand il en est l'entité sélectionnée.
 */
export function widgetReglable(page: string, entityId: string, genre: 'thermostat' | 'cover' | 'blind', px: number, py: number, ecran: Dimensions, fond?: Fond, thermometre?: string): BlocsReglage {
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) throw new Error(`entité invalide pour une boîte de réglage : ${entityId}`);
  if (thermometre !== undefined && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(thermometre)) throw new Error(`thermomètre invalide pour ${entityId} : ${thermometre}`);
  const eid = `${page}_${slug(entityId)}`;
  const t = typeBoite(genre) as TypeBoite;
  const b = idBoite(page, t);
  const [iconeOff, iconeOn] = ICON_BY_KIND[genre];
  const cote = coteIcone(fond);
  const bi = boiteCentree(px, py, { largeur: cote, hauteur: cote }, ecran);
  const selection = (action: string[]): string[] => [
    '      - if:', '          condition:', `            lambda: 'return id(${b}_ent) == "${entityId}";'`, '          then:', ...action.map((a) => '            ' + a)
  ];
  const capteursTexte: string[] = [], capteurs: string[] = [];
  const hanom = ['  - platform: homeassistant', `    id: hanom_${eid}`, `    entity_id: ${entityId}`, '    attribute: friendly_name', '    internal: true'];
  let ouverture: string[];
  const widgets: string[] = [];
  const iconeLabel = (clic: string[]): string[] => [
    '  - label:', `      id: icon_${eid}`, `      x: ${bi.x}`, `      y: ${bi.y}`, `      width: ${cote}`, `      height: ${cote}`,
    '      text_align: CENTER', '      text_font: font_icons', `      text: "${iconeOff}"`, `      text_color: ${COLOR_OFF}`, ...fondDe(fond),
    ...(fond?.noir ? [`      pad_top: ${padHaut(cote, fond.tailleIcone)}`] : []), '      clickable: true', '      on_click:', ...clic
  ];

  if (t === 'th') {
    ouverture = [
      '        - lambda: |-', `            id(${b}_ent) = "${entityId}";`, `            id(${b}_state) = id(ha_${eid}).state;`,
      `            id(${b}_modes) = id(hamodes_${eid}).state;`, `            id(${b}_cv) = id(hasp_${eid}).state;`,
      '        - lvgl.label.update:', `            id: ${b}_nom`, `            text: !lambda '${LAMBDA_TITRE(`id(hanom_${eid}).state`)}'`,
      '        - lvgl.label.update:', `            id: ${b}_cur`, `            text: !lambda '${lambdaCourante(eid, thermometre)}'`,
      '        - lvgl.label.update:', `            id: ${b}_cons`, `            text: !lambda 'float v = id(hasp_${eid}).state; ${FORMAT_TEMP('v')}'`,
      '        - lvgl.label.update:', `            id: ${b}_mode`, `            text: !lambda 'std::string x = id(ha_${eid}).state; ${LAMBDA_LIBELLE_MODE}'`,
      `        - lvgl.widget.show: ${b}`
    ];
    capteursTexte.push(
      '  - platform: homeassistant', `    id: ha_${eid}`, `    entity_id: ${entityId}`, '    internal: true', '    on_value:',
      '      - lvgl.label.update:', `          id: icon_${eid}`, '          text_color: !lambda |-',
      `            return (x != "off" && x != "unavailable" && x != "unknown") ? lv_color_hex(${COLOR_ON}) : lv_color_hex(${COLOR_OFF});`,
      ...selection([`- lambda: 'id(${b}_state) = x;'`, '- lvgl.label.update:', `    id: ${b}_mode`, `    text: !lambda '${LAMBDA_LIBELLE_MODE}'`]),
      ...hanom,
      '  - platform: homeassistant', `    id: hamodes_${eid}`, `    entity_id: ${entityId}`, '    attribute: hvac_modes', '    internal: true'
    );
    capteurs.push(
      '  - platform: homeassistant', `    id: hacur_${eid}`, `    entity_id: ${entityId}`, '    attribute: current_temperature', '    internal: true', '    on_value:',
      '      - lvgl.label.update:', `          id: lbl_${eid}`, `          text: !lambda '${lambdaValeurThermostat(eid, thermometre)}'`,
      ...selection(['- lvgl.label.update:', `    id: ${b}_cur`, `    text: !lambda '${lambdaCourante(eid, thermometre)}'`]),
      ...(thermometre ? [
        '  - platform: homeassistant', `    id: haref_${eid}`, `    entity_id: ${thermometre}`, '    internal: true', '    on_value:',
        '      - lvgl.label.update:', `          id: lbl_${eid}`, `          text: !lambda '${lambdaValeurThermostat(eid, thermometre)}'`,
        ...selection(['- lvgl.label.update:', `    id: ${b}_cur`, `    text: !lambda '${lambdaCourante(eid, thermometre)}'`])
      ] : []),
      '  - platform: homeassistant', `    id: hasp_${eid}`, `    entity_id: ${entityId}`, '    attribute: temperature', '    internal: true', '    on_value:',
      '      - lvgl.label.update:', `          id: lbl_${eid}`, `          text: !lambda '${lambdaValeurThermostat(eid, thermometre)}'`,
      ...selection([`- lambda: 'id(${b}_cv) = x;'`, '- lvgl.label.update:', `    id: ${b}_cons`, `    text: !lambda '${FORMAT_TEMP('x')}'`])
    );
    // Valeur « actuelle/consigne » à droite de l'icône, comme celle d'un capteur ; un appui dessus ouvre aussi la boîte.
    const largeur = fond?.noir ? Math.round(fond.tailleValeur * TEXT_CHAR_WIDTH_FACTOR * 9) + 8 : SENSOR_LABEL_WIDTH;
    const hauteur = fond?.noir ? Math.round(fond.tailleValeur * 1.4) : SENSOR_LABEL_HEIGHT;
    const gauche = px - Math.floor(cote / 2) + cote + SENSOR_ICON_LABEL_GAP_PX;
    const l = boiteCentree(gauche + Math.floor(largeur / 2), py, { largeur, hauteur }, ecran);
    widgets.push(...iconeLabel(ouverture),
      '  - label:', `      id: lbl_${eid}`, `      x: ${l.x}`, `      y: ${l.y}`, `      width: ${largeur}`, `      height: ${hauteur}`,
      '      text: "--"', '      text_align: LEFT', `      text_color: ${COLOR_SENSOR_TEXT}`, '      text_font: font_sensor', ...fondDe(fond),
      ...(fond?.noir ? [`      pad_top: ${padHaut(hauteur, fond.tailleValeur * HAUTEUR_LIGNE_ROBOTO)}`, '      pad_left: 4'] : []),
      '      clickable: true', '      on_click:', ...ouverture);
  } else {
    ouverture = [
      '        - lambda: |-', `            id(${b}_ent) = "${entityId}";`,
      '        - lvgl.label.update:', `            id: ${b}_nom`, `            text: !lambda '${LAMBDA_TITRE(`id(hanom_${eid}).state`)}'`,
      '        - lvgl.label.update:', `            id: ${b}_etat`, `            text: !lambda 'std::string x = id(ha_${eid}).state; ${LAMBDA_LIBELLE_VOLET}'`,
      '        - lvgl.label.update:', `            id: ${b}_pos`, `            text: !lambda 'float x = id(hapos_${eid}).state; ${LAMBDA_POSITION}'`,
      '        - lvgl.slider.update:', `            id: ${b}_slider`, `            value: !lambda 'float v = id(hapos_${eid}).state; return std::isnan(v) ? 0 : (int) v;'`,
      `        - lvgl.widget.show: ${b}`
    ];
    capteursTexte.push(
      '  - platform: homeassistant', `    id: ha_${eid}`, `    entity_id: ${entityId}`, '    internal: true', '    on_value:',
      '      - lvgl.label.update:', `          id: icon_${eid}`, '          text: !lambda |-', '            return (x == "open" || x == "opening")',
      `              ? std::string("${iconeOn}") : std::string("${iconeOff}");`,
      '      - lvgl.label.update:', `          id: icon_${eid}`, '          text_color: !lambda |-', '            return (x == "open" || x == "opening")',
      `              ? lv_color_hex(${COLOR_ON}) : lv_color_hex(${COLOR_OFF});`,
      ...selection(['- lvgl.label.update:', `    id: ${b}_etat`, `    text: !lambda '${LAMBDA_LIBELLE_VOLET}'`]),
      ...hanom
    );
    capteurs.push(
      '  - platform: homeassistant', `    id: hapos_${eid}`, `    entity_id: ${entityId}`, '    attribute: current_position', '    internal: true', '    on_value:',
      ...selection(['- lvgl.label.update:', `    id: ${b}_pos`, `    text: !lambda '${LAMBDA_POSITION}'`, '- lvgl.slider.update:', `    id: ${b}_slider`, "    value: !lambda 'return std::isnan(x) ? 0 : (int) x;'"])
    );
    widgets.push(...iconeLabel(ouverture));
  }
  return { capteursTexte, capteurs, widgets };
}

export function widgetCapteur(page: string, entityId: string, px: number, py: number, ecran: Dimensions, fond?: Fond): Blocs {
  const eid = `${page}_${slug(entityId)}`;
  const [glyphe, couleur] = ICON_AND_COLOR_BY_SENSOR_TYPE[typeCapteur(entityId)];
  const cote = coteIcone(fond);
  const i = boiteCentree(px, py, { largeur: cote, hauteur: cote }, ecran);
  // Fond noir : boîte de la valeur ajustée à 7 caractères (« 1234.5 ») ; sinon boîte large et transparente.
  const largeurValeur = fond?.noir ? Math.round(fond.tailleValeur * TEXT_CHAR_WIDTH_FACTOR * 7) + 8 : SENSOR_LABEL_WIDTH;
  const hauteurValeur = fond?.noir ? Math.round(fond.tailleValeur * 1.4) : SENSOR_LABEL_HEIGHT;
  // Valeur ancrée par son bord GAUCHE, juste après l'icône : « faux centre » = bord gauche voulu + moitié de la largeur.
  const labelLeft = px - Math.floor(cote / 2) + cote + SENSOR_ICON_LABEL_GAP_PX; // bord droit de la boîte de l'icône + 4 px
  const l = boiteCentree(labelLeft + Math.floor(largeurValeur / 2), py, { largeur: largeurValeur, hauteur: hauteurValeur }, ecran);
  const capteurs = [
    '  - platform: homeassistant', `    id: ha_${eid}`, `    entity_id: ${entityId}`, '    internal: true', '    on_value:',
    '      - lvgl.label.update:', `          id: lbl_${eid}`, '          text: !lambda |-',
    // x est NAN quand HA envoie un état non numérique (unavailable/unknown) : sans ce garde, snprintf affiche « nan » à l'écran.
    '            if (std::isnan(x)) return std::string("--");', '            char buf[16];', '            snprintf(buf, sizeof(buf), "%.1f", x);', '            return std::string(buf);'
  ];
  const widgets = [
    '  - label:', `      id: icon_${eid}`, `      x: ${i.x}`, `      y: ${i.y}`, `      width: ${cote}`, `      height: ${cote}`,
    '      text_align: CENTER', '      text_font: font_icons', `      text: "${glyphe}"`, `      text_color: ${couleur}`, ...fondDe(fond),
    ...(fond?.noir ? [`      pad_top: ${padHaut(cote, fond.tailleIcone)}`] : []),
    '  - label:', `      id: lbl_${eid}`, `      x: ${l.x}`, `      y: ${l.y}`, `      width: ${largeurValeur}`, `      height: ${hauteurValeur}`,
    '      text: "--"', '      text_align: LEFT', `      text_color: ${COLOR_SENSOR_TEXT}`, '      text_font: font_sensor',
    // Par défaut, boîte transparente : un fond opaque large masquerait des morceaux du plan et des icônes voisines (fond noir : boîte ajustée).
    ...fondDe(fond),
    ...(fond?.noir ? [`      pad_top: ${padHaut(hauteurValeur, fond.tailleValeur * HAUTEUR_LIGNE_ROBOTO)}`, '      pad_left: 4'] : [])
  ];
  return { capteurs, widgets };
}

export interface TexteLibre { id: string; text: string; x: number; y: number; size?: string; color?: string }

/** Boîte d'un texte libre, dimensionnée d'après le nombre de caractères (aucune mesure réelle possible hors du firmware). */
export function boiteTexte(texte: TexteLibre, ecran: Dimensions, tailleForcee?: number): { largeur: number; hauteur: number } {
  const taille = tailleForcee ?? TEXT_FONT_SIZE_BY_SIZE[texte.size || 'medium'] ?? TEXT_FONT_SIZE_BY_SIZE.medium;
  return { largeur: Math.min(ecran.largeur - 8, Math.max(taille * 2, arrondi([...texte.text].length * taille * TEXT_CHAR_WIDTH_FACTOR))), hauteur: arrondi(taille * 1.4) };
}

/** `idPolice` : identifiant de la police du palier (par plan, pour que deux plans ne définissent pas la même police). */
export function widgetTexte(page: string, texte: TexteLibre, px: number, py: number, ecran: Dimensions, idPolice: (taille: string) => string, tailleForcee?: number, fond?: Fond): string[] {
  const taille = texte.size || 'medium';
  const couleur = (texte.color || '#FFFFFF').replace(/^#+/, '').toUpperCase();
  const boite = boiteTexte(texte, ecran, tailleForcee);
  const b = boiteCentree(px, py, boite, ecran);
  return [
    '  - label:', `      id: text_${page}_${slug(texte.id)}`, `      x: ${b.x}`, `      y: ${b.y}`, `      width: ${boite.largeur}`, `      height: ${boite.hauteur}`,
    `      text: "${echapperLvgl(texte.text)}"`, '      text_align: CENTER', `      text_color: 0x${couleur}`, `      text_font: ${idPolice(taille)}`, ...fondDe(fond),
    ...(fond?.noir ? [`      pad_top: ${padHaut(boite.hauteur, (tailleForcee ?? TEXT_FONT_SIZE_BY_SIZE[texte.size || 'medium'] ?? TEXT_FONT_SIZE_BY_SIZE.medium) * HAUTEUR_LIGNE_ROBOTO)}`] : [])
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
  /** Taille forcée (px) de tous les textes libres de la page (fiche de l'appareil) ; absente = tailles du plan. */
  tailleTexte?: number;
  placees: number;
  hors: number;
  /** Variables globales (boîtes de réglage) — section `globals:` de l'élément. */
  globals: string[];
}

export function genererPage(plan: EntreePlan, ecran: Dimensions, ancrage: Ancrage = 'bas-gauche', tailleTexte?: number, fond?: Fond, reglages = false, thermometres: Record<string, string> = {}): PagePlan {
  const page = slug(plan.id) || 'plan';
  const a = ajuster(plan.image, ecran);
  const decalage = ancrage === 'bas-gauche' ? 1 : 0;
  const positions = plan.positions.filter((p) => p.x != null && p.y != null && !String(p.entity_id ?? '').startsWith('__'));
  const textes = plan.textes.filter((t) => t.text);
  const capteursTexte: string[] = [], capteurs: string[] = [], widgets: string[] = [];
  let hors = 0;
  const typesBoites = new Set<TypeBoite>();
  for (const pos of positions) {
    const p = versPixels(pos.x as number, pos.y as number, plan.image, a);
    const genre = classer(pos.entity_id, pos.quoi);
    // Coin bas-gauche → centre de l'icône (demi-boîte vers la droite et vers le haut), puis test « dans l'écran » sur le centre.
    // Coin bas-gauche de l'icône sur le point : la demi-boîte est celle de la boîte réellement dessinée (fond noir : police + 8 px).
    const demi = Math.floor(coteIcone(fond) / 2);
    const px = p.x + decalage * demi, py = p.y - decalage * demi;
    if (!(px >= 0 && px <= ecran.largeur && py >= 0 && py <= ecran.hauteur)) { hors++; continue; }
    if (reglages && GENRES_REGLABLES.has(genre)) {
      const r = widgetReglable(page, pos.entity_id, genre as 'thermostat' | 'cover' | 'blind', px, py, ecran, fond, thermometres[pos.entity_id]);
      capteursTexte.push(...r.capteursTexte); capteurs.push(...r.capteurs); widgets.push(...r.widgets); typesBoites.add(typeBoite(genre) as TypeBoite);
    } else if (genre === 'sensor') { const r = widgetCapteur(page, pos.entity_id, px, py, ecran, fond); capteurs.push(...r.capteurs); widgets.push(...r.widgets); }
    else { const r = widgetIcone(page, pos.entity_id, genre, px, py, ecran, fond); capteursTexte.push(...r.capteurs); widgets.push(...r.widgets); }
  }
  const textesUtilises: TexteLibre[] = [];
  for (const t of textes) {
    const p = versPixels(t.x, t.y, plan.image, a);
    const boite = boiteTexte(t, ecran, tailleTexte);
    const px = p.x + decalage * Math.floor(boite.largeur / 2), py = p.y - decalage * Math.floor(boite.hauteur / 2);
    if (!(px >= 0 && px <= ecran.largeur && py >= 0 && py <= ecran.hauteur)) { hors++; continue; }
    widgets.push(...widgetTexte(page, t, px, py, ecran, (s) => `font_text_${page}_${s}`, tailleTexte, fond));
    textesUtilises.push(t);
  }
  // Boîtes de réglage : en dernier, donc au-dessus de tout le plan.
  const boites = boitesPage(page, typesBoites);
  widgets.push(...boites.widgets);
  return { globals: boites.globals, page, imageFilename: `floorplan_${page}_${ecran.largeur}x${ecran.hauteur}.png`, capteursTexte, capteurs, widgets, textesUtilises, placees: positions.length + textes.length - hors, hors, tailleTexte };
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
    lignes.push('  - file: "gfonts://Roboto"', `    id: font_text_${r.page}_${s}`, `    size: ${r.tailleTexte ?? TEXT_FONT_SIZE_BY_SIZE[s]}`, `    glyphs: ${glyphesLitteral(c)}`);
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
  if (r.globals.length) lignes.push('globals:', ...r.globals);
  if (r.capteursTexte.length) lignes.push('text_sensor:', ...r.capteursTexte);
  if (r.capteurs.length) lignes.push('sensor:', ...r.capteurs);
  lignes.push('lvgl:', '  pages:', ...pageLvgl(r, ecran));
  return lignes.join('\n') + '\n';
}
