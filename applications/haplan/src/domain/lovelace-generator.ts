/**
 * Génère le YAML d'un tableau de bord Lovelace HA (carte "Plan", type `picture-elements`) à partir
 * de TOUS les plans HAPLAN connus — une vue HA par plan (voir buildLovelaceDashboardYaml plus bas)
 * — voir fonctionnelles-haplan_specs_v1.6.md §17 pour la conception complète.
 *
 * Pas d'icône explicite par entité pour cette première version : le choix d'icône côté HAPLAN
 * (Font Awesome, UnifiedObjectFactory.ts) n'existe qu'à l'exécution côté navigateur, jamais
 * persisté (voir floorplans-config-schema.ts — seuls entity_id/x/y sont stockés). Porter cette
 * logique côté serveur demanderait de dupliquer UnifiedObjectFactory.ts pour un gain cosmétique ;
 * `state_color: true` (défaut de `state-icon`) suffit pour la couleur dynamique par état, et HA
 * choisit déjà une icône par défaut sensée par domaine sans qu'on la précise.
 */

import * as yaml from 'js-yaml';
import type { HaplanFloorplanEntry } from './floorplans-config-schema';

interface PictureElement {
  type: 'state-icon' | 'state-label';
  entity: string;
  style: Record<string, string>;
  card_mod?: { style: string };
}

/**
 * ⭐ 28/08/2026, deux retours réels après premier déploiement :
 * - Couleur du texte des capteurs illisible — dépend du thème du visualiseur (noir sur fond très
 *   sombre sur un PC, blanc sur fond bleu sur un téléphone), imprévisible d'un appareil à l'autre.
 *   Fond de l'image toujours sombre (fusion `image-flatten.ts`, `#1a1a2e`) quel que soit le thème
 *   HA — texte blanc fixe + ombre portée noire (lisible même sur une zone claire de l'image).
 * - "Indisponible"/"Unavailable" trop long à côté de l'icône — remplacé par "—" via card_mod
 *   (template Jinja `is_state`, supporté nativement par card_mod) : masque le texte d'origine
 *   (`font-size: 0`) et affiche "—" à la place via un pseudo-élément, uniquement si indisponible/
 *   inconnu — la vraie valeur (ex: "23.97°C") s'affiche normalement sinon. Vérifié : `state-label`
 *   a son propre shadow root avec un simple `<div>` pour le texte, atteint directement (pas de
 *   piercing nécessaire, contrairement à `hui-image` pour l'image de fond).
 */
const SENSOR_LABEL_CARD_MOD_STYLE = [
  'div {',
  '  color: white;',
  '  text-shadow: 0 0 3px black, 0 0 3px black;',
  "  {% if is_state(config.entity, 'unavailable') or is_state(config.entity, 'unknown') %}",
  '  font-size: 0;',
  '  {% endif %}',
  '}',
  'div::after {',
  "  {% if is_state(config.entity, 'unavailable') or is_state(config.entity, 'unknown') %}",
  '  content: "—";',
  '  font-size: 14px;',
  '  color: white;',
  '  text-shadow: 0 0 3px black, 0 0 3px black;',
  '  {% endif %}',
  '}'
].join('\n');

/** Décalage horizontal (% de la largeur de l'image) entre l'icône d'un capteur et sa valeur —
 *  ⭐ 28/08/2026, demande explicite : icône ET valeur, pas l'une ou l'autre (`state-icon` seul ne
 *  montre jamais l'état, `state-label` seul n'a pas d'icône — même patron que HAPLAN lui-même,
 *  qui affiche déjà les deux côte à côte). */
const SENSOR_LABEL_OFFSET_PERCENT = 3;

/**
 * Construit le(s) élément(s) `picture-elements` pour UNE position. `sensor.*` (température,
 * humidité, pression...) n'a pas d'action (ni toggle, ni ouverture) et doit montrer sa valeur —
 * icône (`state-icon`) + valeur juste à côté (`state-label`, seul élément HA affichant l'état en
 * texte). Tous les autres domaines (light/switch/climate/cover/binary_sensor...) gardent une seule
 * icône (`state-icon`, avec action au clic).
 */
function buildElementsForPosition(entityId: string, leftPercent: number, topPercent: number): PictureElement[] {
  const icon: PictureElement = {
    type: 'state-icon',
    entity: entityId,
    style: { left: `${leftPercent.toFixed(2)}%`, top: `${topPercent.toFixed(2)}%` }
  };
  if (!entityId.startsWith('sensor.')) return [icon];

  const label: PictureElement = {
    type: 'state-label',
    entity: entityId,
    style: { left: `${(leftPercent + SENSOR_LABEL_OFFSET_PERCENT).toFixed(2)}%`, top: `${topPercent.toFixed(2)}%` },
    card_mod: { style: SENSOR_LABEL_CARD_MOD_STYLE }
  };
  return [icon, label];
}

/**
 * Une position sur deux (x/y nullables tant que non placée, voir floorplans-config-schema.ts) —
 * seules les positions effectivement placées produisent une ligne. Coordonnées déjà normalisées
 * 0-1 côté HAPLAN, identiques à la convention `left`/`top` en % de HA (§17.7 de la spec).
 */
/**
 * `cacheBust` (optionnel, ex: `Date.now()`) : ajouté en query string à l'URL de l'image —
 * ⭐ 28/08/2026, bug réel constaté : le navigateur (cache HTTP d'image, indépendant du hard-reload
 * de la page) continuait de servir l'ancienne version de l'image après un redéploiement sur la
 * MÊME URL `/local/<nom>` — le contenu servi par HA était pourtant à jour (vérifié par requête
 * directe). Un identifiant différent à chaque dépôt force le navigateur à retélécharger.
 */
/**
 * ⭐ 28/08/2026 : `picture-elements` remplit sa carte en largeur par défaut — sans borne de hauteur,
 * une image portrait dépasse l'écran (constaté en réel avec `panel: true` seul, capture montrant
 * l'image tronquée). Nécessite `card_mod` (HACS) — carte HA standard n'accepte aucun style
 * personnalisé nativement (vérifié en direct : un `style:` natif sur la carte est silencieusement
 * ignoré).
 *
 * Vrai coupable (trouvé en inspectant le DOM en direct, après plusieurs fausses pistes sur
 * `hui-image`/son `<img>`/sa `.container` interne — aucune des trois n'était en cause) : le
 * conteneur qui fixe réellement la taille du plan à sa taille naturelle (ex: 620×412) est
 * `#root`, une `<div>` du propre shadow root de `hui-picture-elements-card` elle-même (donc
 * atteignable par `.`, sans piercing) — c'est le parent DIRECT de `hui-image`. Une fois `#root`
 * forcé à 100%/100%, `hui-image` (et l'`<img>` dedans) suivent naturellement sans avoir besoin
 * d'aucune règle propre — vérifié en direct : aucune règle sur `hui-image`/`.container` n'était
 * nécessaire, seule `#root` comptait. `object-fit: contain` doit être en `!important` : HA fixe
 * `object-fit: cover` sur l'image en interne (rognage) et le regagne sans `!important` (vérifié en
 * direct : sans `!important`, la carte affichait `cover`, jamais `contain`).
 *
 * `calc(100vh - 56px)` plutôt que `100vh` tout court : `100vh` ignore la barre d'outils HA (bandeau
 * "original / Rez de chaussée / Premier..." en haut, 56px de haut) qui occupe le HAUT du viewport
 * sans être en position fixe/overlay — `ha-card` grandissait donc de 56px de trop sous le bas
 * visible de l'écran (vérifié en direct : bas de la carte à 1117px alors que le viewport ne fait
 * que 903px de haut). 56px est la hauteur standard du bandeau HA (mesurée en direct : `ha-card`
 * commence toujours à `top: 56px`). `!important` nécessaire aussi ici (vérifié en direct : sans
 * lui, HA regagne avec sa propre règle interne sur `ha-card`, résultat identique au bug d'origine).
 */
const CARD_MOD_STYLE: Record<string, string> = {
  '.': [
    'ha-card {',
    '  height: calc(100vh - 56px) !important;',
    '}',
    '#root {',
    '  width: 100% !important;',
    '  height: 100% !important;',
    '}'
  ].join('\n'),
  'hui-image$': [
    'img {',
    '  object-fit: contain !important;',
    '}'
  ].join('\n')
};

function buildView(floorplanId: string, floorplan: HaplanFloorplanEntry, cacheBust?: string | number) {
  const elements: PictureElement[] = floorplan.positions
    .filter((p) => p.x !== null && p.y !== null)
    .flatMap((p) => buildElementsForPosition(p.entity_id, p.x! * 100, p.y! * 100));

  return {
    title: floorplanId,
    path: floorplanId,
    // panel: true = la carte remplit tout l'écran (pas de grille masonry/sidebar HA autour) — sans
    // ça, picture-elements reste une petite carte au milieu de l'écran (constaté en réel le
    // 28/08/2026).
    panel: true,
    cards: [
      {
        type: 'picture-elements',
        image: cacheBust ? `/local/${floorplan.filename}?v=${cacheBust}` : `/local/${floorplan.filename}`,
        card_mod: { style: CARD_MOD_STYLE },
        elements
      }
    ]
  };
}

/**
 * ⭐ 28/08/2026 : un plan HAPLAN = une vue HA (`views:`), pas une carte unique — plusieurs plans
 * partagent alors le même tableau de bord, avec les onglets natifs de HA en haut de l'écran
 * (balayage déjà géré nativement par HA sur mobile, aucune dépendance de plus). Alternative
 * envisagée (carte "swipeable" tierce, sans barre d'onglets visible) écartée pour cette première
 * version — décidé avec l'utilisateur, onglets natifs par défaut.
 */
export function buildLovelaceDashboardYaml(floorplans: Record<string, HaplanFloorplanEntry>, cacheBust?: string | number): string {
  const doc = {
    title: 'HAPLAN',
    views: Object.entries(floorplans).map(([floorplanId, floorplan]) => buildView(floorplanId, floorplan, cacheBust))
  };

  // noRefs : sans ça, js-yaml factorise CARD_MOD_STYLE (partagé entre toutes les vues) en un
  // ancrage/alias YAML (&ref_0/*ref_0) — valide, mais évité par prudence plutôt que de compter sur
  // le parseur YAML interne de HA (PyYAML) pour bien le résoudre dans ce contexte imbriqué.
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
