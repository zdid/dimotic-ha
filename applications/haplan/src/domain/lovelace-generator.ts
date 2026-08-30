/**
 * Génère le YAML d'un tableau de bord Lovelace HA (carte "Plan", type `picture-elements`) à partir
 * de TOUS les plans HAPLAN connus — une vue HA par plan (voir buildLovelaceDashboardYaml plus bas)
 * — voir fonctionnelles-haplan_specs_v1.6.md §17 pour la conception complète.
 *
 * Pas d'icône explicite par entité en général : le choix d'icône complet côté HAPLAN (Font
 * Awesome, UnifiedObjectFactory.ts) n'existe qu'à l'exécution côté navigateur, jamais persisté
 * (voir floorplans-config-schema.ts — seuls entity_id/x/y sont stockés) — le dupliquer entièrement
 * ici referait un gain cosmétique pour des domaines où HA choisit déjà une icône par défaut
 * pertinente (light/climate/cover, capteurs avec `device_class`). `state_color: true` (défaut de
 * `state-icon`) suffit pour la couleur dynamique par état dans tous les cas.
 *
 * Seule exception portée (⭐ 29/08/2026, retour utilisateur) : les sous-types de `switch.*` que HA
 * ne peut PAS deviner tout seul (VMC/ballon d'eau chaude/radiateur, aucun domaine ni device_class
 * dédié côté HA) — voir switch-icon.ts, détection par mots-clés dans l'entity_id (portée de
 * `SwitchTypeDetector` de HAPLAN, méthode par entity_id uniquement, pure).
 */

import * as yaml from 'js-yaml';
import type { HaplanFloorplanEntry } from './floorplans-config-schema';
import type { ImageDimensions } from './image-dimensions';
import { detectSwitchIconStyle } from './switch-icon';
import { getSensorIconColor, getSensorRoundDigits } from './sensor-color';

/** Valeur d'un style card_mod : soit du CSS brut (feuille), soit un niveau de perçage
 *  supplémentaire (`{'<sélecteur>$': ...}`, récursif) — voir buildIconColorCardMod plus bas. */
type CardModStyleValue = string | { [selector: string]: CardModStyleValue };

interface PictureElement {
  type: 'state-icon' | 'state-label';
  entity: string;
  icon?: string;
  style: Record<string, string>;
  card_mod?: { style: CardModStyleValue };
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
 *
 * ⭐ 30/08/2026, demande explicite (les deux HAPLAN : ici pour la carte HA, et pareillement dans
 * l'éditeur HAPLAN lui-même — voir Enhanced{Temperature,Humidity,Generic}Sensor.ts) : humidité et
 * pression sans décimale, température à 1 décimale — HA affiche par défaut la précision brute
 * renvoyée par l'intégration (ex: "23.973°C"). `roundDigits` (null = pas de règle, capteur affiché
 * tel quel comme avant) bascule vers un ::after CALCULÉ (texte source TOUJOURS masqué, pas
 * seulement si indisponible) — `{{ states(...)|float(0)|round(N) }}` ; `round(0)` d'un float reste
 * un float en Jinja ("68.0"), d'où `|int` en plus pour ce cas précis. Espace avant l'unité repris
 * de la convention HA (pas d'espace pour %/° , espace sinon — ex: "68%", "23.9°C", "1015 hPa").
 *
 * `:host { transform: translateY(-50%) !important; }` — ⭐ 30/08/2026, deuxième retour utilisateur
 * après le premier écart fixe (SENSOR_LABEL_OFFSET_PX) : valeur toujours partiellement superposée
 * à l'icône. Cause trouvée en direct : `hui-state-label-element` est nativement centré (HA lui
 * applique `transform: translate(-50%, -50%)`, vérifié via le style calculé) — un texte plus large
 * (ex: "1015 hPa", ~75px) déborde alors vers la GAUCHE de son point d'ancrage bien plus qu'un texte
 * court ("68%", ~40px), quel que soit l'écart ajouté avant. En ne gardant que le centrage VERTICAL
 * (translateY seul), le bord GAUCHE du texte se retrouve toujours exactement au point d'ancrage
 * (`left: calc(icône% + Npx)`), quelle que soit la largeur du texte — l'écart devient prévisible.
 */
function buildSensorLabelCardMod(entityId: string): string {
  const roundDigits = getSensorRoundDigits(entityId);
  const hostTransform = ':host { transform: translateY(-50%) !important; }';
  if (roundDigits === null) {
    return [
      hostTransform,
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
  }

  const roundedValueExpr = roundDigits === 0
    ? "{{ states(config.entity) | float(0) | round(0) | int }}"
    : `{{ states(config.entity) | float(0) | round(${roundDigits}) }}`;

  return [
    hostTransform,
    'div {',
    '  color: white;',
    '  text-shadow: 0 0 3px black, 0 0 3px black;',
    '  font-size: 0;',
    '}',
    'div::after {',
    '  font-size: 14px;',
    '  color: white;',
    '  text-shadow: 0 0 3px black, 0 0 3px black;',
    "  {% if is_state(config.entity, 'unavailable') or is_state(config.entity, 'unknown') %}",
    '  content: "—";',
    '  {% else %}',
    "  {% set unit = state_attr(config.entity, 'unit_of_measurement') or '' %}",
    `  content: "${roundedValueExpr}{{ '' if unit[:1] in ['%', '°'] else ' ' }}{{ unit }}";`,
    '  {% endif %}',
    '}'
  ].join('\n');
}

/** Décalage horizontal entre l'icône d'un capteur et sa valeur — ⭐ 28/08/2026, demande explicite :
 *  icône ET valeur, pas l'une ou l'autre (`state-icon` seul ne montre jamais l'état, `state-label`
 *  seul n'a pas d'icône — même patron que HAPLAN lui-même, qui affiche déjà les deux côte à côte).
 *
 * ⭐ 30/08/2026, retour utilisateur : valeur superposée à l'icône sur certains plans — un décalage
 * en % de la largeur de l'IMAGE (comme avant) donne un écart en pixels très variable : 3% d'un
 * plan portrait étroit (620px de large, ex: "original") ≈ 12px une fois rendu à l'écran, plus
 * petit que l'icône elle-même (~24px) ; 3% d'un plan large ≈ 48px, largement suffisant — l'écart
 * dépendait donc de la FORME du plan, pas de la taille réelle de l'icône (fixe, indépendante de
 * l'image). Remplacé par un décalage en pixels ABSOLUS via `calc()` (mélange %/px valide en CSS,
 * appliqué tel quel par `picture-elements` comme n'importe quelle valeur `left`) — même écart
 * visuel quel que soit le plan ou l'appareil.
 *
 * ⭐ 30/08/2026, deuxième retour : 28px donnait un écart bien trop grand. Cause trouvée en direct :
 * la boîte cliquable de `state-icon` fait 40px (± 20px de son centre), mais le GLYPHE visible
 * dedans ne fait que 24px de large et ~16px de haut, centré dans cette boîte — donc son bord droit
 * réel est à seulement ±12px du centre, pas ±20px (vérifié en mesurant `ha-icon` dans le shadow
 * DOM : 8px de marge invisible de chaque côté). 28px laissait donc 16px de vide visuel (28-12), pas
 * les 8px voulus.
 *
 * ⭐ 30/08/2026, troisième retour : encore trop loin avec 18px ("écart de 2 caractères"). Testé en
 * direct plusieurs valeurs sur la carte déjà déployée (mesure du bord droit du glyphe au bord
 * gauche du texte) : 12px donne un écart quasi nul (glyphe et texte pratiquement jointifs, aucun
 * chevauchement constaté), qui correspond à ce qui était demandé.
 */
const SENSOR_LABEL_OFFSET_PX = 12;

/**
 * Force la couleur de l'icône d'un `state-icon` (au lieu du `state_color` automatique de HA) — ⭐
 * 29/08/2026, retour utilisateur : "donner les couleurs de HAPLAN aux capteurs sous HA". Vérifié
 * en direct que l'icône réelle est enterrée 2 niveaux de shadow DOM sous l'élément `state-icon`
 * (`hui-state-icon-element` → `state-badge` → `ha-state-icon`, ce dernier portant la couleur via
 * `:host`) — un simple `color:` au niveau `.` (comme pour l'image de fond) n'atteindrait rien.
 * Syntaxe de perçage imbriqué confirmée sur la doc officielle de card_mod (chaque `$` = un niveau
 * de shadow root en plus, valeur = objet pour continuer à percer ou chaîne CSS pour s'arrêter).
 */
function buildIconColorCardMod(cssRule: string): CardModStyleValue {
  return { 'state-badge$': { 'ha-state-icon$': cssRule } };
}

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
  if (entityId.startsWith('switch.')) {
    const switchIconStyle = detectSwitchIconStyle(entityId);
    if (switchIconStyle) {
      icon.icon = switchIconStyle.icon;
      // Pas d'état "on/off" à refléter pour un capteur (voir plus bas), mais un switch en a un —
      // gabarit Jinja (déjà utilisé pour le texte "Indisponible", supporté nativement par
      // card_mod) plutôt qu'une couleur figée, pour retrouver le "bleu éteint / <couleur> allumé"
      // de HAPLAN.
      icon.card_mod = {
        style: buildIconColorCardMod(
          [
            ':host {',
            `  {% if is_state(config.entity, 'on') %} color: ${switchIconStyle.colorOn} !important;`,
            `  {% else %} color: ${switchIconStyle.colorOff} !important; {% endif %}`,
            '}'
          ].join('\n')
        )
      };
    }
  } else {
    const sensorColor = getSensorIconColor(entityId);
    if (sensorColor) {
      icon.card_mod = { style: buildIconColorCardMod(`:host { color: ${sensorColor} !important; }`) };
    }
  }
  if (!entityId.startsWith('sensor.')) return [icon];

  const label: PictureElement = {
    type: 'state-label',
    entity: entityId,
    style: { left: `calc(${leftPercent.toFixed(2)}% + ${SENSOR_LABEL_OFFSET_PX}px)`, top: `${topPercent.toFixed(2)}%` },
    card_mod: { style: buildSensorLabelCardMod(entityId) }
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
 *
 * ⭐ 28/08/2026, deuxième retour réel après ce correctif : `#root` en 100%/100% laisse `object-fit:
 * contain` faire son travail sur l'`<img>` DEDANS `#root`, mais les icônes superposées sont
 * positionnées en % de `#root` lui-même (verrouillé par `picture-elements`, hors de notre contrôle
 * — même quand `#root` a un ratio différent de l'image, donc que l'image est "letterboxée"
 * (bandes vides) dedans). Résultat : icônes décalées par rapport au plan, parfois visuellement en
 * dehors de l'image visible. Corrigé en donnant à `#root` lui-même le ratio EXACT de l'image
 * (`aspect-ratio`, calculé au dépôt à partir du PNG/JPEG réel — voir image-dimensions.ts) plutôt
 * que 100%/100% — combiné à `max-width/max-height: 100%` dans une `ha-card` flex centrée, c'est le
 * même calcul que `Math.min(widthRatio, heightRatio)` de `FloorPlan.ts` (l'éditeur HAPLAN
 * lui-même), mais en CSS pur puisqu'une carte HA est du YAML statique, sans JS à nous. `#root`
 * n'a alors plus jamais de bande vide : son bord EST le bord de l'image, donc les % des icônes
 * (calculés à partir de l'image dans HAPLAN) retombent exactement au bon endroit.
 */
function buildCardModStyle(imageWidth: number, imageHeight: number): Record<string, string> {
  const ratio = imageWidth / imageHeight;
  return {
    '.': [
      'ha-card {',
      '  height: calc(100vh - 56px) !important;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '}',
      '#root {',
      // ⭐ 28/08/2026, deux essais ratés avant celui-ci (vérifiés en direct) :
      // - `aspect-ratio` + `max-width/max-height:100%` (sans largeur/hauteur de départ) : `#root`
      //   n'a alors AUCUNE taille définie pour dériver l'autre axe — retombe sur une taille
      //   minuscule (~520×340, plus petit que l'image elle-même), pas sur la taille max disponible.
      // - `align-items: stretch` (hauteur = 100% de `ha-card`, largeur dérivée par aspect-ratio) :
      //   fonctionne pour un plan qui BUTE sur la hauteur, mais un plan très large sur un écran
      //   étroit (mobile portrait) déborderait en largeur (jamais bridé par la largeur dispo).
      // Formule symétrique ci-dessous — même calcul que `Math.min(widthRatio, heightRatio)` dans
      // `FloorPlan.ts` (l'éditeur HAPLAN lui-même), mais en CSS pur : `min(100%, ...)` compare la
      // largeur MAX disponible (100% de `ha-card`) à la largeur qu'aurait le plan s'il était
      // bridé par la HAUTEUR dispo (`(100vh - 56px) * ratio`) — le plus petit des deux gagne, quel
      // que soit l'axe qui bute réellement. `aspect-ratio` dérive ensuite la hauteur à partir de
      // cette largeur déjà correcte. Vérifié en direct sur un plan paysage (620×412, large) ET un
      // plan portrait (620×818, haut) : les deux remplissent l'espace dispo sans déborder.
      `  width: min(100%, calc((100vh - 56px) * ${ratio.toFixed(6)})) !important;`,
      `  aspect-ratio: ${imageWidth} / ${imageHeight} !important;`,
      '}'
    ].join('\n'),
    'hui-image$': [
      'img {',
      '  width: 100%;',
      '  height: 100%;',
      '  object-fit: contain !important;',
      '}'
    ].join('\n')
  };
}

function buildView(floorplanId: string, floorplan: HaplanFloorplanEntry, dimensions: ImageDimensions, cacheBust?: string | number) {
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
        card_mod: { style: buildCardModStyle(dimensions.width, dimensions.height) },
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
 *
 * `dimensions` : largeur/hauteur naturelle de CHAQUE image de plan (une entrée par floorplanId,
 * voir image-dimensions.ts) — nécessaire pour calculer le ratio exact injecté dans le CSS de
 * chaque vue (voir buildCardModStyle plus haut). Un plan absent de `dimensions` n'a pas son ratio
 * gravé (aspect-ratio omis, comportement d'avant ce correctif) plutôt que de faire échouer tout le
 * dépôt pour un seul plan illisible.
 */
export function buildLovelaceDashboardYaml(
  floorplans: Record<string, HaplanFloorplanEntry>,
  dimensions: Record<string, ImageDimensions>,
  cacheBust?: string | number
): string {
  const doc = {
    title: 'HAPLAN',
    views: Object.entries(floorplans).map(([floorplanId, floorplan]) =>
      buildView(floorplanId, floorplan, dimensions[floorplanId] ?? { width: 1, height: 1 }, cacheBust)
    )
  };

  // noRefs : le CSS est maintenant calculé par plan (ratio propre à chaque image), mais gardé par
  // prudence — sans lui, js-yaml pourrait factoriser toute structure identique par coïncidence
  // (ex: deux plans de mêmes dimensions) en ancrage/alias YAML (&ref_0/*ref_0), qu'on préfère
  // éviter plutôt que de compter sur le parseur YAML interne de HA (PyYAML) pour bien le résoudre.
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
