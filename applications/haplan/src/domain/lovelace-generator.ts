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
import type { ImageDimensions } from './image-dimensions';

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
