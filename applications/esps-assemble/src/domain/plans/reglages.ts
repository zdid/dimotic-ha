/**
 * Boîtes de réglage des pages de plans (fiche : `reglages_plans: oui`) — un appui sur un objet qui ne se commande pas par un simple
 * « bascule » ouvre une boîte par-dessus le plan : thermostat (température actuelle, consigne − / +, marche / arrêt, mode) et volet
 * (ouvrir / stop / fermer, position). Une boîte PAR PAGE ET PAR TYPE, partagée par tous les objets de ce type de la page : l'entité
 * visée est mémorisée dans une variable globale au moment de l'appui, et les boutons l'utilisent.
 *
 * Ce module ne produit que du texte (aucune dépendance) ; les fragments propres à chaque objet (capteurs, ouverture de la boîte) sont dans
 * generation.ts. Polices : élément `polices-reglages` (font_reglage_titre / _texte / _valeur, glyphes français complets).
 */

/** Types d'objets qui ouvrent une boîte de réglage à l'appui (au lieu de la bascule ou de rien). */
export const GENRES_REGLABLES = new Set<string>(['thermostat', 'cover', 'blind']);

export type TypeBoite = 'th' | 'cv';
export const typeBoite = (genre: string): TypeBoite | null => (genre === 'thermostat' ? 'th' : genre === 'cover' || genre === 'blind' ? 'cv' : null);

export const idBoite = (page: string, t: TypeBoite): string => `pop_${page}_${t}`;

/** Texte français d'un état de thermostat (lambda C++ sur `x`, la chaîne d'état). */
export const LAMBDA_LIBELLE_MODE =
  'if (x == "unavailable") return std::string("Indisponible"); if (x == "off") return std::string("Arrêt"); if (x == "heat") return std::string("Chauffage"); ' +
  'if (x == "cool") return std::string("Froid"); if (x == "auto") return std::string("Auto"); if (x == "dry") return std::string("Déshumid."); ' +
  'if (x == "fan_only") return std::string("Ventil."); if (x == "heat_cool") return std::string("Auto"); return x;';

/** Texte français d'un état de volet (lambda C++ sur `x`). */
export const LAMBDA_LIBELLE_VOLET =
  'if (x == "unavailable") return std::string("Indisponible"); if (x == "open") return std::string("Ouvert"); if (x == "closed") return std::string("Fermé"); ' +
  'if (x == "opening") return std::string("Ouverture…"); if (x == "closing") return std::string("Fermeture…"); return x;';

/** Corps C++ (sans `return` final) qui met une valeur flottante `v` au format « 21.5 » ou « -- ». */
export const FORMAT_TEMP = (v: string): string => `if (std::isnan(${v})) return std::string("--"); char b[16]; snprintf(b, sizeof(b), "%.1f", ${v}); return std::string(b);`;

/**
 * Titre d'une boîte d'après le nom de l'entité dans HA. Un nom à la convention `quoi---[précis--]lieu[--père[--grand-père]]` (appareils
 * passés par NOMMAGE) est ramené à « Quoi précis lieu » (le lieu précis seulement s'il diffère du lieu) ; un autre nom est gardé tel quel.
 * Lambda C++ sur l'expression `nom` (une std::string).
 */
export const LAMBDA_TITRE = (nom: string): string =>
  `std::string n = ${nom}; size_t i = n.find("---"); if (i == std::string::npos) return n; std::string t = n.substr(0, i); std::string r = n.substr(i + 3); ` +
  `std::vector<std::string> s; size_t p = 0; while (true) { size_t q = r.find("--", p); if (q == std::string::npos) { s.push_back(r.substr(p)); break; } s.push_back(r.substr(p, q - p)); p = q + 2; } ` +
  `if (s.size() >= 2 && !s[0].empty() && s[0] != s[1]) t += " " + s[0]; if (s.size() >= 2) t += " " + s[1]; else if (!s.empty()) t += " " + s[0]; ` +
  `if (!t.empty() && t[0] >= 97 && t[0] <= 122) t[0] = t[0] - 32; return t;`;

const COULEUR_TH = '0x00BCD4';
const COULEUR_CV = '0x4CAF50';

/** Variables globales d'une page : entité sélectionnée dans la boîte, et ce qu'il faut savoir d'elle (état, modes, consigne). */
export function globalesPage(page: string, types: Set<TypeBoite>): string[] {
  const l: string[] = [];
  if (types.has('th')) {
    const b = idBoite(page, 'th');
    l.push(`  - id: ${b}_ent`, '    type: std::string', "    initial_value: '\"\"'",
      `  - id: ${b}_state`, '    type: std::string', "    initial_value: '\"\"'",
      `  - id: ${b}_modes`, '    type: std::string', "    initial_value: '\"\"'",
      `  - id: ${b}_cv`, '    type: float', "    initial_value: '16.0'");
  }
  if (types.has('cv')) {
    const b = idBoite(page, 'cv');
    l.push(`  - id: ${b}_ent`, '    type: std::string', "    initial_value: '\"\"'");
  }
  return l;
}

/** Bouton rectangulaire cliquable : étiquette à bord, centrée verticalement (pad_top). */
function bouton(id: string, x: number, y: number, w: number, h: number, police: string, texte: string, padHaut: number, actions: string[]): string[] {
  return [
    '        - label:', `            id: ${id}`, `            x: ${x}`, `            y: ${y}`, `            width: ${w}`, `            height: ${h}`,
    '            text_align: CENTER', `            text_font: ${police}`, `            pad_top: ${padHaut}`, `            text: "${texte}"`,
    '            text_color: 0xFFFFFF', '            bg_opa: TRANSP', '            radius: 14', '            border_width: 3', '            border_color: 0x888888',
    '            clickable: true', '            on_click:', ...actions.map((a) => '              ' + a)
  ];
}

function etiquette(id: string, x: number, y: number, w: number, h: number, police: string, texte: string, couleur: string, extra: string[] = []): string[] {
  return [
    '        - label:', `            id: ${id}`, `            x: ${x}`, `            y: ${y}`, `            width: ${w}`, `            height: ${h}`,
    '            text_align: CENTER', `            text_font: ${police}`, `            text: "${texte}"`, `            text_color: ${couleur}`, '            bg_opa: TRANSP', ...extra
  ];
}

/** Conteneur plein écran masqué (fond assombri, un appui à côté de la carte le ferme) + carte + contenu. */
function boite(id: string, carte: { x: number; y: number; w: number; h: number; couleur: string }, contenu: string[]): string[] {
  return [
    '  - obj:', `      id: ${id}`, '      hidden: true', '      x: 0', '      y: 0', '      width: 800', '      height: 480', '      bg_color: 0x000000', '      bg_opa: 70%',
    '      border_width: 0', '      radius: 0', '      pad_all: 0', '      clickable: true', '      on_click:', `        - lvgl.widget.hide: ${id}`, '      widgets:',
    '        - obj:', `            id: ${id}_carte`, `            x: ${carte.x}`, `            y: ${carte.y}`, `            width: ${carte.w}`, `            height: ${carte.h}`,
    '            radius: 16', '            bg_color: 0x000000', '            bg_opa: COVER', `            border_color: ${carte.couleur}`, '            border_width: 3',
    ...contenu
  ];
}

const fermer = (id: string, x: number, y: number): string[] => bouton(`${id}_x`, x, y, 44, 40, 'font_reglage_texte', 'x', 6, [`- lvgl.widget.hide: ${id}`]);

const ENTITE = (id: string): string => `entity_id: !lambda 'return id(${id}_ent);'`;

/** Boîte thermostat : température actuelle, consigne − / +, marche / arrêt, mode (cycle sur les modes que l'appareil annonce). */
export function boiteThermostat(page: string): string[] {
  const b = idBoite(page, 'th');
  const consigne = (signe: '-' | '+'): string[] => [
    '- lambda: |-',
    '    float t = id(' + b + '_cv);',
    '    if (std::isnan(t)) t = 16.0f;',
    `    t = t ${signe} 0.5f;`,
    '    if (t < 5.0f) t = 5.0f;',
    '    if (t > 35.0f) t = 35.0f;',
    '    id(' + b + '_cv) = t;',
    '- lvgl.label.update:', `    id: ${b}_cons`, "    text: !lambda 'float v = id(" + b + "_cv); " + FORMAT_TEMP('v') + "'",
    '- homeassistant.service:', '    service: climate.set_temperature', '    data:', `      ${ENTITE(b)}`,
    "      temperature: !lambda 'char s[12]; snprintf(s, sizeof(s), \"%.1f\", id(" + b + "_cv)); return std::string(s);'"
  ];
  const contenu = [
    ...etiquette(`${b}_nom`, 120, 56, 520, 30, 'font_reglage_titre', '--', COULEUR_TH, ['            long_mode: DOT']),
    ...fermer(b, 636, 52),
    ...etiquette(`${b}_leg_cur`, 120, 96, 560, 24, 'font_reglage_texte', 'Température', '0xBBBBBB'),
    ...etiquette(`${b}_cur`, 120, 120, 560, 58, 'font_reglage_valeur', '--', '0xFFFFFF'),
    ...etiquette(`${b}_leg_cons`, 120, 188, 560, 24, 'font_reglage_texte', 'Consigne', '0xBBBBBB'),
    ...etiquette(`${b}_cons`, 220, 214, 360, 58, 'font_reglage_valeur', '--', COULEUR_TH),
    ...bouton(`${b}_moins`, 140, 214, 80, 64, 'font_reglage_valeur', '-', 4, consigne('-')),
    ...bouton(`${b}_plus`, 580, 214, 80, 64, 'font_reglage_valeur', '+', 4, consigne('+')),
    ...etiquette(`${b}_mode`, 120, 284, 560, 28, 'font_reglage_texte', '--', '0xFFFFFF'),
    ...bouton(`${b}_onoff`, 140, 328, 250, 80, 'font_reglage_texte', 'Marche / Arrêt', 26, [
      '- if:', '    condition:', `      lambda: 'return id(${b}_state) != "off";'`, '    then:', '      - homeassistant.service:', '          service: climate.turn_off', '          data:', `            ${ENTITE(b)}`,
      '    else:', '      - homeassistant.service:', '          service: climate.turn_on', '          data:', `            ${ENTITE(b)}`
    ]),
    ...bouton(`${b}_modebtn`, 410, 328, 250, 80, 'font_reglage_texte', 'Mode', 26, [
      '- homeassistant.service:', '    service: climate.set_hvac_mode', '    data:', `      ${ENTITE(b)}`, '      hvac_mode: !lambda |-',
      '        static const char* modes[] = {"heat", "cool", "heat_cool", "auto", "dry", "fan_only"};',
      `        const std::string m = id(${b}_modes);`,
      `        const std::string cur = id(${b}_state);`,
      '        int n = 6; int i = -1;',
      '        for (int k = 0; k < n; k++) if (cur == modes[k]) i = k;',
      '        for (int s = 1; s <= n; s++) {',
      '          const char* c = modes[(i + s + n) % n];',
      '          if (m.empty() || m.find(std::string("\'") + c + "\'") != std::string::npos) return std::string(c);',
      '        }',
      '        return cur;'
    ])
  ];
  return boite(b, { x: 120, y: 48, w: 560, h: 380, couleur: COULEUR_TH }, contenu);
}

/** Boîte volet : ouvrir / stop / fermer et curseur de position (0 = fermé, 100 = ouvert). */
export function boiteVolet(page: string): string[] {
  const b = idBoite(page, 'cv');
  const service = (s: string): string[] => ['- homeassistant.service:', `    service: ${s}`, '    data:', `      ${ENTITE(b)}`];
  const contenu = [
    ...etiquette(`${b}_nom`, 120, 98, 520, 30, 'font_reglage_titre', '--', COULEUR_CV, ['            long_mode: DOT']),
    ...fermer(b, 636, 94),
    ...etiquette(`${b}_etat`, 120, 140, 560, 28, 'font_reglage_texte', '--', '0xBBBBBB'),
    ...etiquette(`${b}_pos`, 120, 170, 560, 58, 'font_reglage_valeur', '--', '0xFFFFFF'),
    ...bouton(`${b}_ouvrir`, 140, 244, 160, 80, 'font_reglage_texte', 'Ouvrir', 26, service('cover.open_cover')),
    ...bouton(`${b}_stop`, 320, 244, 160, 80, 'font_reglage_texte', 'Stop', 26, service('cover.stop_cover')),
    ...bouton(`${b}_fermer`, 500, 244, 160, 80, 'font_reglage_texte', 'Fermer', 26, service('cover.close_cover')),
    '        - slider:', `            id: ${b}_slider`, '            x: 160', '            y: 350', '            width: 480', '            height: 22',
    '            min_value: 0', '            max_value: 100', '            value: 0', '            on_release:',
    '              - homeassistant.service:', '                  service: cover.set_cover_position', '                  data:', `                    ${ENTITE(b)}`,
    `                    position: !lambda 'return to_string((int) lv_slider_get_value(id(${b}_slider)));'`
  ];
  return boite(b, { x: 120, y: 90, w: 560, h: 330, couleur: COULEUR_CV }, contenu);
}

/** Boîtes à poser en fin de page (au-dessus du plan) pour les types d'objets présents, avec leurs variables globales. */
export function boitesPage(page: string, types: Set<TypeBoite>): { widgets: string[]; globals: string[] } {
  const widgets: string[] = [];
  if (types.has('th')) widgets.push(...boiteThermostat(page));
  if (types.has('cv')) widgets.push(...boiteVolet(page));
  return { widgets, globals: globalesPage(page, types) };
}
