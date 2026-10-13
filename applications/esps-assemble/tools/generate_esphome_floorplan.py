#!/usr/bin/env python3
"""
generate_esphome_floorplan.py

Outil autonome (hors runtime de l'app, exécuté à la main) : lit TOUS les plans HAPLAN existants
(data/haplan/config-haplan-floorplans-v1.0.yaml + leurs images dans data/haplan/images/) et produit,
pour l'écran 800x480 d'une carte ESP32-8048S070 :

1. Une image de fond par plan, ajustée à la résolution cible (contain-fit, ratio préservé, centrée
   sur fond noir) — les plans HAPLAN existants ont des ratios variés, différents du 800x480 (5:3)
   de l'écran ; un simple resize écraserait l'image.
2. Un fragment YAML ESPHome (`text_sensor:`/`sensor:` + une page LVGL par plan) plaçant une icône
   par position déjà définie dans HAPLAN, aux coordonnées pixel recalculées pour l'image ajustée —
   réutilise donc directement le travail de positionnement déjà fait dans l'UI HAPLAN, jamais
   ressaisi à la main. Une page par plan (multi-plans, tous embarqués — décision utilisateur du
   13/08/2026 : cohérent avec la navigation circulaire du plan web, même si "original" duplique
   entièrement le contenu de "Rez de chaussée"+"Premier").

Classification et icônes calquées sur le vrai `UnifiedObjectFactory`/`SwitchTypeDetector` de HAPLAN
(fonctionnelles-haplan_specs §9.2) — mêmes glyphes Font Awesome Solid que le plan web (lumière,
interrupteur, VMC, ballon, radiateur, volet, thermostat), rendus via un sous-ensemble de police
embarqué dans le firmware (fonts/fa-solid-900.ttf, Font Awesome Free 5.15.4 Solid — licence SIL OFL
1.1 — les codepoints utilisés ici sont identiques en Font Awesome 6, donc cohérents avec le plan web
qui charge la 6.0.0 par CDN). Les capteurs (sensor.*) affichent désormais aussi une icône (⭐
30/08/2026, même retour utilisateur que côté carte HA Lovelace — voir lovelace-generator.ts) : une
icône statique colorée par type (température/humidité/pression/puissance/générique, voir
detect_sensor_type()) devant la valeur, cette dernière restant une étiquette texte blanche.

Identifiants de widgets/capteurs préfixés par plan (ex: icon_original_light_xxx vs
icon_premier_light_xxx) — indispensable dès qu'un même entity_id apparaît sur plusieurs plans
("original" duplique tout le monde), sans quoi deux widgets porteraient le même id LVGL (erreur de
compilation ESPHome, id non unique).

⭐ 08/09/2026, texte libre (fonctionnalité "page libre") : chaque texte de `floorplan["texts"]`
devient un `label:` LVGL statique (build_text_widget()), même transformation de coordonnées que les
icônes. Une "page libre" (créée sans image, voir HaplanService.handleFloorplanCreate) est une vraie
image PNG générée une fois à la création (fond transparent) — traitée ici EXACTEMENT comme n'importe
quel autre plan, aucun cas spécial : fit_and_pad() la ramène déjà correctement au 800x480 cible avec
son propre ratio préservé. Police par palier de taille (small/medium/large) plutôt que par texte,
glyphes restreints aux caractères réellement utilisés à ce palier (voir build_glyphs_literal()),
même principe que font_sensor pour les valeurs de capteur.

Corrige plusieurs bugs réels trouvés en testant sur écran physique le 13/08/2026 (voir mémoire
projet `project_haplan_esphome_s3_display` pour le détail complet) :
- `align: CENTER` sur un widget LVGL positionne le WIDGET par rapport à son PARENT, pas le texte
  dans sa propre boîte. Remplacé par `text_align: CENTER` + position absolue.
- Bornage des positions par rapport au centre du widget seulement, pas son emprise réelle une fois
  sa taille prise en compte. Corrigé par un clampage de la position finale de la boîte.
- Icônes composées de 2 widgets superposés (cercle de fond fixe + glyphe réactif) donnaient
  l'impression d'"une ancienne icône figée sous la nouvelle" — supprimé, un seul widget par icône.

Usage :
    python3 generate_esphome_floorplan.py --all
    python3 generate_esphome_floorplan.py original "Rez de chaussée" Premier
    python3 generate_esphome_floorplan.py --all --width 800 --height 480

Dépendances : PyYAML, Pillow (déjà présentes sur ce poste — aucune n'est ajoutée au projet Node,
cet outil est volontairement hors du runtime applicatif).
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
FLOORPLANS_CONFIG = REPO_ROOT / "data" / "haplan" / "config-haplan-floorplans-v1.0.yaml"
IMAGES_DIR = REPO_ROOT / "data" / "haplan" / "images"
FONT_FILENAME = "fa-solid-900.ttf"
PARTITIONS_FILENAME = "partitions-haplan.csv"
DEFAULT_TEMPLATE = Path(__file__).parent / "esphome" / "haplan-display.yaml"
DEFAULT_ESPHOME_CONFIG_DIR = Path("/docker/esphome/config")
DEFAULT_ESPHOME_CONTAINER = "esphome"

# Couleurs — reprend l'esprit de fonctionnelles-haplan_specs §9.3 (état lu à la couleur/l'icône)
COLOR_ON = "0xFFC107"   # ampoule dorée, allumé
COLOR_OFF = "0x9E9E9E"  # gris clair, éteint (plus lisible qu'un gris-bleu foncé sur fond sombre)
COLOR_SENSOR_TEXT = "0xFFFFFF"

ICON_BG_DIAMETER = 32   # agrandi depuis 24 (retour utilisateur 13/08/2026 : icônes/textes un peu plus gros)
ICON_FONT_SIZE = 20     # agrandi depuis 14, idem
SENSOR_FONT_SIZE = 20   # texte des capteurs — auparavant sans police dédiée (taille par défaut LVGL ~14)
LABEL_WIDTH = 130        # élargi depuis 110 pour accueillir le texte agrandi sans coupure
LABEL_HEIGHT = 32        # élargi depuis 26, idem

# ⭐ 30/08/2026 : écart entre le bord de l'icône de capteur et le début du texte de la valeur — même
# raisonnement que SENSOR_LABEL_OFFSET_PX côté lovelace-generator.ts (texte toujours ancré au même
# point, quelle que soit sa largeur, plutôt que centré dans une boîte qui ferait varier l'écart
# visible selon le nombre de chiffres affichés).
SENSOR_ICON_LABEL_GAP_PX = 4

# ⭐ 08/09/2026, texte libre (fonctionnalité "page libre") — mêmes trois paliers en px que
# HA_TEXT_FONT_SIZE_PX côté web (HAText.ts) et TEXT_FONT_SIZE_PX côté carte Lovelace
# (lovelace-generator.ts), pour un rendu cohérent d'un rendu à l'autre même si le DPI réel de
# l'écran ESP32 diffère de celui d'un navigateur/téléphone.
TEXT_FONT_SIZE_BY_SIZE = {"small": 14, "medium": 20, "large": 28}
# Largeur moyenne d'un caractère en fraction de la taille de police (Roboto, proportionnelle) —
# approximation généreuse pour dimensionner la boîte du label à partir du nombre de caractères
# (aucune mesure réelle possible hors du firmware, contrairement à un navigateur/une carte HA qui
# mesurent le texte réellement rendu).
TEXT_CHAR_WIDTH_FACTOR = 0.62

# Flèches de navigation entre plans (top_layer, voir haplan-display.yaml) — police et taille
# séparées de font_icons (14px, pensée pour des pastilles de 24px) : "4 fois trop petites" au
# premier essai (retour utilisateur 13/08/2026), d'où une police dédiée bien plus grande.
NAV_FONT_SIZE = 40
ICON_CHEVRON_LEFT = chr(0xF053)
ICON_CHEVRON_RIGHT = chr(0xF054)

# Glyphes Font Awesome Solid — mêmes classes que UnifiedObjectFactory.ts / SwitchTypeDetector.ts
ICON_LIGHTBULB = chr(0xF0EB)
ICON_TOGGLE_ON = chr(0xF205)
ICON_TOGGLE_OFF = chr(0xF204)
ICON_WINDOW_MAX = chr(0xF2D0)   # volet ouvert
ICON_WINDOW_MIN = chr(0xF2D1)   # volet fermé
ICON_WATER = chr(0xF773)        # ballon d'eau chaude
ICON_WIND = chr(0xF72E)         # VMC
ICON_FIRE = chr(0xF06D)         # radiateur en chauffe
ICON_SNOWFLAKE = chr(0xF2DC)    # radiateur à l'arrêt
ICON_THERMOMETER = chr(0xF2C9)  # thermostat / capteur de température
ICON_TINT = chr(0xF043)         # capteur d'humidité (goutte)
ICON_TACHOMETER = chr(0xF3FD)   # capteur de pression
ICON_BOLT = chr(0xF0E7)         # capteur de puissance/énergie
ICON_INFO_CIRCLE = chr(0xF05A)  # capteur générique (type non reconnu)

# Couleurs par type de capteur — reprises telles quelles de sensor-color.ts (getSensorIconColor(),
# lui-même copié de HAPLAN Enhanced*Sensor.ts/getColorSchemeForType()), pour que l'écran physique et
# la carte HA Lovelace affichent la même couleur pour un même type de capteur (⭐ 29-30/08/2026).
# Dupliqué ici plutôt que partagé : ce script tourne hors du runtime Node (voir en-tête du fichier),
# volontairement indépendant — à resynchroniser à la main si sensor-color.ts change.
COLOR_SENSOR_TEMPERATURE = "0xF44336"   # Rouge
COLOR_SENSOR_HUMIDITY = "0x00BCD4"      # Cyan
COLOR_SENSOR_PRESSURE = "0x9C27B0"      # Violet
COLOR_SENSOR_POWER_ENERGY = "0xFFC107"  # Jaune/ambre
COLOR_SENSOR_DEFAULT = "0x607D8B"       # Bleu gris


def slug(text: str) -> str:
    """Identifiant ESPHome-safe : minuscules, chiffres, underscores uniquement."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower())
    return re.sub(r"_+", "_", s).strip("_")


def classify(entity_id: str) -> str:
    """Reproduit UnifiedObjectFactory.getEntityType() + SwitchTypeDetector.detectByEntityId()."""
    domain, _, rest = entity_id.partition(".")
    low = entity_id.lower()

    if domain == "sensor":
        return "sensor"

    if domain in ("light", "switch"):
        if "ventilation" in low or "vmc" in low or "fan" in low:
            return "vmc"
        if "water_heater" in low or "chauffe_eau" in low or "ballon" in low:
            return "water_heater"
        if "radiator" in low or "heating" in low or "chauffage" in low:
            return "radiator"
        return "light" if domain == "light" else "switch"

    if domain == "cover":
        return "blind" if ("blind" in low or "store" in low) else "cover"

    if domain == "climate":
        return "thermostat"

    return "light"  # repli par défaut, comme UnifiedObjectFactory.getEntityType()


def detect_sensor_type(entity_id: str) -> str:
    """Reproduit detectSensorType() de sensor-color.ts (mot-clé dans l'entity_id, domaine sensor.*
    déjà garanti par classify() avant l'appel) — mêmes mots-clés des deux côtés (Python ici, TS pour
    la carte HA), dupliqués volontairement (voir COLOR_SENSOR_* ci-dessus) plutôt que partagés."""
    low = entity_id.lower()
    if "temperature" in low:
        return "temperature"
    if "humidity" in low:
        return "humidity"
    if "pressure" in low:
        return "pressure"
    if "power" in low or "energy" in low:
        return "power"
    return "default"


# Icône + couleur par type de capteur détecté (voir detect_sensor_type()) — statique, un capteur n'a
# pas d'état "on/off" à refléter contrairement aux switchs (ICON_BY_KIND ci-dessous).
ICON_AND_COLOR_BY_SENSOR_TYPE = {
    "temperature": (ICON_THERMOMETER, COLOR_SENSOR_TEMPERATURE),
    "humidity": (ICON_TINT, COLOR_SENSOR_HUMIDITY),
    "pressure": (ICON_TACHOMETER, COLOR_SENSOR_PRESSURE),
    "power": (ICON_BOLT, COLOR_SENSOR_POWER_ENERGY),
    "default": (ICON_INFO_CIRCLE, COLOR_SENSOR_DEFAULT),
}


# Pour chaque kind : glyphe statique, ou paire (glyphe_off, glyphe_on) si l'icône elle-même change
# avec l'état (comme sur le plan web) plutôt que juste sa couleur.
ICON_BY_KIND = {
    "light": (ICON_LIGHTBULB, ICON_LIGHTBULB),
    "switch": (ICON_TOGGLE_OFF, ICON_TOGGLE_ON),
    "vmc": (ICON_WIND, ICON_WIND),
    "water_heater": (ICON_WATER, ICON_WATER),
    "radiator": (ICON_SNOWFLAKE, ICON_FIRE),
    "cover": (ICON_WINDOW_MIN, ICON_WINDOW_MAX),
    "blind": (ICON_WINDOW_MIN, ICON_WINDOW_MAX),
    "thermostat": (ICON_THERMOMETER, ICON_THERMOMETER),
}

TOUCHABLE_KINDS = {"light", "switch", "vmc", "water_heater", "radiator", "cover", "blind"}
# thermostat exclu : pas d'action simple "toggle" côté HA pour climate.* (nécessite consigne/mode,
# hors périmètre d'un tap sur un écran de lecture — sensor.* n'a de toute façon aucune action).


def fit_and_pad(img: Image.Image, target_w: int, target_h: int) -> tuple[Image.Image, float, int, int]:
    """Redimensionne en conservant le ratio (contain), centre sur un fond noir target_w x target_h.
    Retourne (image_finale, échelle_appliquée, offset_x, offset_y) — offset/échelle nécessaires
    pour convertir les coordonnées normalisées 0-1 d'origine en pixels sur l'image finale."""
    scale = min(target_w / img.width, target_h / img.height)
    scaled_w = round(img.width * scale)
    scaled_h = round(img.height * scale)
    resized = img.convert("RGBA").resize((scaled_w, scaled_h), Image.LANCZOS)

    canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
    offset_x = (target_w - scaled_w) // 2
    offset_y = (target_h - scaled_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)
    return canvas, scale, offset_x, offset_y


def clamp_box(px: int, py: int, box_w: int, box_h: int, canvas_w: int, canvas_h: int) -> tuple[int, int]:
    """Position (x,y) du coin haut-gauche d'une boîte de taille box_w x box_h centrée sur (px,py),
    clampée pour que la boîte entière reste dans [0,canvas_w] x [0,canvas_h] — pas seulement son
    centre (bug trouvé le 13/08/2026 : un widget centré près d'un bord dépassait du canevas)."""
    x = px - box_w // 2
    y = py - box_h // 2
    x = max(0, min(x, canvas_w - box_w))
    y = max(0, min(y, canvas_h - box_h))
    return x, y


def build_icon_widget(page: str, entity_id: str, kind: str, px: int, py: int, canvas_w: int, canvas_h: int) -> tuple[list[str], list[str]]:
    eid = f"{page}_{slug(entity_id)}"
    domain = entity_id.split(".", 1)[0]
    icon_off, icon_on = ICON_BY_KIND[kind]
    bx, by = clamp_box(px, py, ICON_BG_DIAMETER, ICON_BG_DIAMETER, canvas_w, canvas_h)

    sensor_lines = [
        f"  - platform: homeassistant",
        f"    id: ha_{eid}",
        f"    entity_id: {entity_id}",
        f"    internal: true",
        f"    on_value:",
    ]
    if icon_off != icon_on:
        sensor_lines += [
            f"      - lvgl.label.update:",
            f"          id: icon_{eid}",
            f"          text: !lambda |-",
            f"            return (x == \"on\" || x == \"open\" || x == \"heat\" || x == \"cool\")",
            # std::string(...) obligatoire : ESPHome 2025.11 appelle .c_str() sur le résultat du lambda,
            # inutilisable sur un `const char*` issu d'un `? "a" : "b"` (compilation refusée sinon).
            f"              ? std::string(\"{icon_on}\") : std::string(\"{icon_off}\");",
        ]
    sensor_lines += [
        f"      - lvgl.label.update:",
        f"          id: icon_{eid}",
        f"          text_color: !lambda |-",
        f"            return (x == \"on\" || x == \"open\" || x == \"heat\" || x == \"cool\")",
        f"              ? lv_color_hex({COLOR_ON}) : lv_color_hex({COLOR_OFF});",
    ]

    # Aucun cercle de fond/bordure — juste le glyphe de l'icône, rien d'autre (retour utilisateur
    # explicite : même en un seul widget, un cercle visible en permanence donnait l'impression
    # d'une "icône figée" sous celle qui réagit).
    widget_lines = [
        f"  - label:",
        f"      id: icon_{eid}",
        f"      x: {bx}",
        f"      y: {by}",
        f"      width: {ICON_BG_DIAMETER}",
        f"      height: {ICON_BG_DIAMETER}",
        f"      text_align: CENTER",
        f"      text_font: font_icons",
        f"      text: \"{icon_off}\"",
        f"      text_color: {COLOR_OFF}",
        f"      bg_opa: TRANSP",
    ]
    if kind in TOUCHABLE_KINDS:
        widget_lines += [
            # clickable: true est indispensable — un label LVGL n'est pas cliquable par défaut,
            # on_click seul ne suffit pas (constaté en direct le 13/08/2026 : coordonnées de
            # tap correctes à l'écran, mais aucune action déclenchée tant que ce flag manquait).
            #
            # ⭐ 30/08/2026, étape manuelle HORS de ce script mais indispensable pour que
            # `homeassistant.service:` ci-dessous fonctionne réellement : chaque appareil ESPHome
            # doit être explicitement autorisé côté HA à envoyer des actions — case à cocher
            # SÉPARÉE de l'ajout de l'intégration elle-même, décochée par défaut (Paramètres →
            # Appareils et services → ESPHome → l'appareil → ⚙️ Options → "Autoriser l'appareil à
            # effectuer des actions Home Assistant"). Sans elle, l'action est refusée
            # SILENCIEUSEMENT (aucune erreur ni côté HA ni côté écran) — l'affichage/lecture des
            # états fonctionne normalement (cette case ne concerne qu'ENVOYER des actions), seul le
            # tap ne fait rien. Voir TODO.md, section "Services post-installation : ajouter
            # l'intégration ESPHome", pour le détail complet.
            f"      clickable: true",
            f"      on_click:",
            f"        - homeassistant.service:",
            f"            service: {domain}.toggle",
            f"            data:",
            f"              entity_id: {entity_id}",
        ]
    return sensor_lines, widget_lines


def build_sensor_widget(page: str, entity_id: str, px: int, py: int, canvas_w: int, canvas_h: int) -> tuple[list[str], list[str]]:
    """⭐ 30/08/2026 : icône devant la valeur, comme sur la carte HA Lovelace (voir docstring en tête
    de fichier). L'icône reste exactement au point placé dans HAPLAN (celui du collage à la grille en
    mode édition) ; la valeur est décalée à droite et alignée à gauche (`text_align: LEFT`, plus
    centrée dans sa boîte) pour garder un écart constant quel que soit le nombre de chiffres affichés
    — même raisonnement que SENSOR_LABEL_OFFSET_PX côté lovelace-generator.ts."""
    eid = f"{page}_{slug(entity_id)}"
    sensor_type = detect_sensor_type(entity_id)
    icon_glyph, icon_color = ICON_AND_COLOR_BY_SENSOR_TYPE[sensor_type]

    ibx, iby = clamp_box(px, py, ICON_BG_DIAMETER, ICON_BG_DIAMETER, canvas_w, canvas_h)

    # Boîte de la valeur, ancrée par son bord GAUCHE (juste après l'icône) plutôt que son centre —
    # clamp_box ne connaît que des boîtes centrées, donc on lui passe un "faux centre" égal au bord
    # gauche voulu + moitié de la largeur : son calcul interne (x = centre - largeur/2) retombe alors
    # exactement sur ce bord gauche avant d'être borné aux limites du canevas.
    label_left = px + ICON_BG_DIAMETER // 2 + SENSOR_ICON_LABEL_GAP_PX
    lbx, lby = clamp_box(label_left + LABEL_WIDTH // 2, py, LABEL_WIDTH, LABEL_HEIGHT, canvas_w, canvas_h)

    sensor_lines = [
        f"  - platform: homeassistant",
        f"    id: ha_{eid}",
        f"    entity_id: {entity_id}",
        f"    internal: true",
        f"    on_value:",
        f"      - lvgl.label.update:",
        f"          id: lbl_{eid}",
        f"          text: !lambda |-",
        # x est NAN quand HA envoie un état non numérique (unavailable/unknown) — sans ce garde,
        # snprintf affiche littéralement "nan" à l'écran (constaté en direct le 13/08/2026).
        f"            if (std::isnan(x)) return std::string(\"--\");",
        f"            char buf[16];",
        f"            snprintf(buf, sizeof(buf), \"%.1f\", x);",
        f"            return std::string(buf);",
    ]
    widget_lines = [
        # Icône statique — pas de lvgl.label.update sur on_value : contrairement aux switchs, un
        # capteur n'a pas d'état on/off à refléter, la couleur/le glyphe ne changent jamais.
        f"  - label:",
        f"      id: icon_{eid}",
        f"      x: {ibx}",
        f"      y: {iby}",
        f"      width: {ICON_BG_DIAMETER}",
        f"      height: {ICON_BG_DIAMETER}",
        f"      text_align: CENTER",
        f"      text_font: font_icons",
        f"      text: \"{icon_glyph}\"",
        f"      text_color: {icon_color}",
        f"      bg_opa: TRANSP",
        f"  - label:",
        f"      id: lbl_{eid}",
        f"      x: {lbx}",
        f"      y: {lby}",
        f"      width: {LABEL_WIDTH}",
        f"      height: {LABEL_HEIGHT}",
        f"      text: \"--\"",
        f"      text_align: LEFT",
        f"      text_color: {COLOR_SENSOR_TEXT}",
        f"      text_font: font_sensor",
        # Boîte transparente — un fond opaque (essayé initialement) masquait des morceaux du plan
        # et des icônes voisines dès que la boîte, élargie pour ne plus couper le texte, débordait
        # sur des éléments proches. Le texte blanc seul reste lisible sur le plan sombre.
        f"      bg_opa: TRANSP",
    ]
    return sensor_lines, widget_lines


def escape_lvgl_string(text: str) -> str:
    """Échappe pour insertion dans une chaîne YAML/C++ entre guillemets doubles — un texte libre
    est saisi librement par l'utilisateur, peut contenir des guillemets ou antislashs."""
    return text.replace("\\", "\\\\").replace('"', '\\"')


def build_text_widget(page: str, text_entry: dict, px: int, py: int, canvas_w: int, canvas_h: int) -> list[str]:
    """Texte libre — un seul `label:` LVGL statique, contenu figé au moment de la génération
    (jamais recalculé à l'exécution, contrairement aux icônes/capteurs : ⭐ 08/09/2026, fonctionnalité
    "page libre"/texte libre, voir fonctionnelles-haplan_specs). Boîte dimensionnée à partir du
    nombre de caractères (voir TEXT_CHAR_WIDTH_FACTOR) plutôt qu'une largeur fixe, qui tronquerait
    un texte long ou laisserait un vide excessif pour un texte court — même souci que LABEL_WIDTH
    pour les capteurs, mais le contenu variable ici interdit une constante unique."""
    size = text_entry.get("size") or "medium"
    font_size = TEXT_FONT_SIZE_BY_SIZE.get(size, TEXT_FONT_SIZE_BY_SIZE["medium"])
    color = (text_entry.get("color") or "#FFFFFF").lstrip("#").upper()
    content = text_entry["text"]

    box_w = min(canvas_w - 8, max(font_size * 2, round(len(content) * font_size * TEXT_CHAR_WIDTH_FACTOR)))
    box_h = round(font_size * 1.4)
    bx, by = clamp_box(px, py, box_w, box_h, canvas_w, canvas_h)

    return [
        f"  - label:",
        f"      id: text_{page}_{slug(text_entry['id'])}",
        f"      x: {bx}",
        f"      y: {by}",
        f"      width: {box_w}",
        f"      height: {box_h}",
        f"      text: \"{escape_lvgl_string(content)}\"",
        f"      text_align: CENTER",
        f"      text_color: 0x{color}",
        f"      text_font: font_text_{size}",
        # Boîte transparente — même raisonnement que les capteurs plus haut : un fond opaque
        # masquerait le plan/les icônes voisines dès que la boîte déborde légèrement.
        f"      bg_opa: TRANSP",
    ]


def build_glyphs_literal(chars: set) -> str:
    """Construit la valeur `glyphs: "..."` d'une police à partir d'un ensemble de caractères
    réellement utilisés (voir font_text_<size> dans main()) — même technique que font_sensor
    (glyphes restreints au contenu réel plutôt qu'une police complète), généralisée : le contenu
    d'un texte libre est saisi librement par l'utilisateur (accents français compris), calculé
    dynamiquement ici plutôt que codé en dur. Échappé pour rester une chaîne YAML/C++ valide."""
    ordered = "".join(sorted(chars))
    escaped = ordered.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


# ⭐ 06/10/2026 — page « Énergie en direct » : schéma de flux dessiné en LVGL (aucune image de fond),
# mêmes capteurs que le tableau HA « Énergie en direct » (power-flow-card-plus). Signes vérifiés sur
# l'installation : réseau + = achat / − = vente ; batterie + = charge / − = décharge ; la maison est lue
# directement (emma_puissance_de_soutiree) et non recalculée, comme dans la carte HA.
ENERGY_PAGE_ID = "energie_direct"
ENERGY_TITLE = "Énergie en direct"
ENERGY_NODES = {
    # nom: (entité, centre x, centre y, couleur, glyphe, légende statique)
    # Production = puissance des PANNEAUX (DC), pas `onduleur_puissance_active` : celle-ci est la sortie AC de l'onduleur
    # hybride, qui inclut la décharge de la batterie (627 W affichés à 19:54 avec des panneaux à 0 W — 06/10/2026).
    "solar":   ("sensor.emma_puissance_de_sortie_des_panneaux", 400, 115, "0xFFC107", chr(0xF185), "Solaire"),
    "grid":    ("sensor.emma_puissance_active", 150, 255, "0x9C27B0", chr(0xF0E7), None),
    "home":    ("sensor.emma_puissance_de_soutiree", 650, 255, "0x2196F3", chr(0xF015), "Maison"),
    "battery": ("sensor.batteries_puissance_de_charge_decharge", 400, 395, "0x4CAF50", chr(0xF241), None),
}
ENERGY_SOC_ENTITY = "sensor.batteries_etat_de_la_capacite"
ENERGY_HUB = (400, 255)
ENERGY_NODE_DIAMETER = 130
ENERGY_ARROWS = {"right": chr(0xF061), "left": chr(0xF060), "up": chr(0xF062), "down": chr(0xF063)}
ENERGY_ICON_FONT_SIZE = 34
ENERGY_ARROW_FONT_SIZE = 30
ENERGY_VALUE_FONT_SIZE = 26
ENERGY_TEXT_FONT_SIZE = 20
ENERGY_DEADBAND_W = 10   # en dessous, flux considéré nul (pas de flèche)
ENERGY_TEXTS = ["Achat", "Vente", "Charge", "Décharge", "Repos", "Réseau", "Batterie"]


def _cstr(glyph: str) -> str:
    """Glyphe -> chaîne C échappée en octets UTF-8 (pour un lambda ESPHome)."""
    return "".join(f"\\x{b:02x}" for b in glyph.encode("utf-8"))


def build_energy_page(width: int, height: int) -> dict:
    assert width == 800 and height == 480, "page énergie dessinée pour 800x480"
    r = ENERGY_NODE_DIAMETER // 2
    hx, hy = ENERGY_HUB
    widgets: list[str] = []
    sensors: list[str] = []

    def add(*lines: str) -> None:
        widgets.extend(lines)

    add("  - label:",
        "      id: energie_titre",
        "      x: 0", "      y: 8", "      width: 800", "      height: 30",
        "      text_align: CENTER", "      text_font: font_energy_text",
        f"      text: \"{ENERGY_TITLE}\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP")

    # Traits (dessinés d'abord, recouverts par les disques opaques)
    for name, (_e, cx, cy, _c, _g, _l) in ENERGY_NODES.items():
        add("  - line:",
            f"      id: energie_trait_{name}",
            "      points:", f"        - {cx}, {cy}", f"        - {hx}, {hy}",
            "      line_width: 3", "      line_color: 0x444444")

    arrow_pos = {  # centre de la flèche sur chaque trait
        "solar": (400, 200), "grid": (290, 255), "home": (510, 255), "battery": (400, 322),
    }
    for name, (_e, cx, cy, color, glyph, legend) in ENERGY_NODES.items():
        add("  - obj:",
            f"      id: energie_cercle_{name}",
            f"      x: {cx - r}", f"      y: {cy - r}", f"      width: {ENERGY_NODE_DIAMETER}", f"      height: {ENERGY_NODE_DIAMETER}",
            f"      radius: {r}", "      bg_color: 0x000000", "      bg_opa: COVER",
            f"      border_color: {color}", "      border_width: 4")
        add("  - label:",
            f"      id: energie_icone_{name}",
            f"      x: {cx - 30}", f"      y: {cy - r + 12}", "      width: 60", "      height: 40",
            "      text_align: CENTER", "      text_font: font_energy_icons",
            f"      text: \"{glyph}\"", f"      text_color: {color}", "      bg_opa: TRANSP")
        add("  - label:",
            f"      id: energie_valeur_{name}",
            f"      x: {cx - r + 5}", f"      y: {cy - 8}", f"      width: {ENERGY_NODE_DIAMETER - 10}", "      height: 32",
            "      text_align: CENTER", "      text_font: font_energy_value",
            "      text: \"--\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP")
        add("  - label:",
            f"      id: energie_legende_{name}",
            f"      x: {cx - r + 5}", f"      y: {cy + 28}", f"      width: {ENERGY_NODE_DIAMETER - 10}", "      height: 26",
            "      text_align: CENTER", "      text_font: font_energy_text",
            f"      text: \"{legend or '--'}\"", "      text_color: 0xBBBBBB", "      bg_opa: TRANSP")
        ax, ay = arrow_pos[name]
        add("  - label:",
            f"      id: energie_fleche_{name}",
            f"      x: {ax - 20}", f"      y: {ay - 20}", "      width: 40", "      height: 40",
            "      text_align: CENTER", "      text_font: font_energy_arrow",
            "      text: \"\"", f"      text_color: {color}", "      bg_opa: TRANSP")

    # Niveau de charge de la batterie, à droite du disque
    bx, by = ENERGY_NODES["battery"][1], ENERGY_NODES["battery"][2]
    add("  - label:",
        "      id: energie_soc",
        f"      x: {bx + r + 12}", f"      y: {by - 16}", "      width: 110", "      height: 32",
        "      text_align: LEFT", "      text_font: font_energy_value",
        "      text: \"--\"", "      text_color: 0x4CAF50", "      bg_opa: TRANSP")

    fmt = [
        "            if (std::isnan(x)) return std::string(\"--\");",
        "            char buf[16];",
        "            if (fabsf(x) >= 1000.0f) snprintf(buf, sizeof(buf), \"%.2f kW\", fabsf(x) / 1000.0f);",
        "            else snprintf(buf, sizeof(buf), \"%.0f W\", fabsf(x));",
        "            return std::string(buf);",
    ]
    dz = f"{ENERGY_DEADBAND_W}.0f"
    a = {k: _cstr(v) for k, v in ENERGY_ARROWS.items()}
    # Pour chaque noeud : (expression de la flèche, expression de la légende ou None)
    logic = {
        "solar": (f'x > {dz} ? std::string("{a["down"]}") : std::string("")', None),
        "grid": (f'x > {dz} ? std::string("{a["right"]}") : (x < -{dz} ? std::string("{a["left"]}") : std::string(""))',
                 f'x > {dz} ? std::string("Achat") : (x < -{dz} ? std::string("Vente") : std::string("Réseau"))'),
        "home": (f'x > {dz} ? std::string("{a["right"]}") : std::string("")', None),
        "battery": (f'x > {dz} ? std::string("{a["down"]}") : (x < -{dz} ? std::string("{a["up"]}") : std::string(""))',
                    f'x > {dz} ? std::string("Charge") : (x < -{dz} ? std::string("Décharge") : std::string("Repos"))'),
    }
    for name, (entity, *_rest) in ENERGY_NODES.items():
        arrow_expr, legend_expr = logic[name]
        sensors += [
            "  - platform: homeassistant",
            f"    id: ha_energie_{name}",
            f"    entity_id: {entity}",
            "    internal: true",
            "    on_value:",
            # Trace de diagnostic : prouve dans le journal de l'appareil que HA pousse bien la valeur.
            "      - logger.log:",
            f"          format: \"energie {name} = %.1f\"",
            "          args: ['x']",
            "      - lvgl.label.update:",
            f"          id: energie_valeur_{name}",
            "          text: !lambda |-", *fmt,
            "      - lvgl.label.update:",
            f"          id: energie_fleche_{name}",
            f"          text: !lambda 'return {arrow_expr};'",
        ]
        if legend_expr:
            sensors += [
                "      - lvgl.label.update:",
                f"          id: energie_legende_{name}",
                f"          text: !lambda 'return {legend_expr};'",
            ]
    sensors += [
        "  - platform: homeassistant",
        "    id: ha_energie_soc",
        f"    entity_id: {ENERGY_SOC_ENTITY}",
        "    internal: true",
        "    on_value:",
        "      - lvgl.label.update:",
        "          id: energie_soc",
        "          text: !lambda |-",
        "            if (std::isnan(x)) return std::string(\"--\");",
        "            char buf[12];",
        "            snprintf(buf, sizeof(buf), \"%.0f %%\", x);",
        "            return std::string(buf);",
    ]

    chars = set(ENERGY_TITLE) | set("Solaire Maison") | set(" ".join(ENERGY_TEXTS))
    return {
        "page": ENERGY_PAGE_ID,
        "floorplan_id": ENERGY_TITLE,
        "image_filename": None,
        "text_entries_used": [],
        "sensor_block": sensors,
        "text_sensor_block": [],
        "widget_block": widgets,
        "placed": len(ENERGY_NODES) + 1,
        "skipped": 0,
        "energy_text_chars": chars,
    }


# ⭐ 06/10/2026 — page « Chauffe des ballons » : reprend le tableau de bord HA `chauffe-ballons` (état, puissance,
# durées du jour de chaque ballon + ordre de chauffe commandable au toucher). Pas de graphiques d'historique
# (impossibles en LVGL ESPHome) ni d'« énergie du jour » (carte statistique HA, pas de capteur).
# Greffée dans une configuration déjà déployée (graft_page), JAMAIS régénérée avec les plans : voir
# --graft-ballons. Les capteurs d'état passent par `text_sensor` (valeur "on"/"off"), comme les interrupteurs.
BALLONS_PAGE_ID = "ballons_chauffe"
BALLONS_TITLE = "Chauffe des ballons"
BALLONS = {
    # clé: (nom, couleur, x carte, switch, binary_sensor chauffe, puissance W, durée sur on h, durée chauffe h)
    "gros": ("Gros ballon", "0x2196F3", 80,
             "switch.gros_ballon_maison_maison_rez_de_chaussee", "binary_sensor.gros_ballon_en_chauffe",
             "sensor.gros_ballon_maison_maison_rez_de_chaussee_power",
             "sensor.maison_gros_ballon_duree_sur_on_aujourd_hui", "sensor.gros_ballon_duree_de_chauffe_aujourd_hui"),
    "petit": ("Petit ballon", "0xFF9800", 410,
              "switch.petit_ballon_maison_maison_rez_de_chaussee", "binary_sensor.petit_ballon_en_chauffe",
              "sensor.petit_ballon_maison_maison_rez_de_chaussee_power",
              "sensor.maison_petit_ballon_duree_sur_on_aujourd_hui", "sensor.petit_ballon_duree_de_chauffe_aujourd_hui"),
}
BALLONS_ORDER_PREMIER = "input_boolean.petit_ballon_en_premier"
BALLONS_ORDER_UNIQUE = "input_boolean.un_seul_ballon"
BALLONS_CARD_W = 310
BALLONS_TEXTS = [
    "Ordre de chauffe", "En premier : Petit ballon", "En premier : Gros ballon",
    "Un seul ballon : OUI", "Un seul ballon : NON",
    "Commande", "Marche", "Arrêt", "Chauffe réelle", "Oui", "Non", "Sur « on »", "Chauffe",
]
BALLONS_COLOR_OFF = "0x777777"
BALLONS_COLOR_HEAT = "0xFF5722"


def build_ballons_page() -> dict:
    w = BALLONS_CARD_W
    widgets: list[str] = []
    sensors: list[str] = []
    text_sensors: list[str] = []

    def add(*lines: str) -> None:
        widgets.extend(lines)

    add("  - label:", "      id: ballons_titre",
        "      x: 0", "      y: 8", "      width: 800", "      height: 30",
        "      text_align: CENTER", "      text_font: font_ballons_title",
        f"      text: \"{BALLONS_TITLE}\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP")

    def label(wid, x, y, wd, h, text, font, color, align="LEFT"):
        add("  - label:", f"      id: {wid}", f"      x: {x}", f"      y: {y}", f"      width: {wd}", f"      height: {h}",
            f"      text_align: {align}", f"      text_font: {font}", f"      text: \"{text}\"",
            f"      text_color: {color}", "      bg_opa: TRANSP")

    g_water, g_fire = chr(0xF773), chr(0xF06D)
    for key, (name, color, x0, sw, chauffe, power, d_on, d_heat) in BALLONS.items():
        add("  - obj:", f"      id: ballons_carte_{key}",
            f"      x: {x0}", "      y: 48", f"      width: {w}", "      height: 272",
            "      radius: 16", "      bg_color: 0x000000", "      bg_opa: COVER",
            f"      border_color: {color}", "      border_width: 3")
        label(f"ballons_nom_{key}", x0, 54, w, 30, name, "font_ballons_title", color, "CENTER")
        label(f"ballons_icone_{key}", x0 + 125, 88, 60, 46, g_water, "font_ballons_icon", BALLONS_COLOR_OFF, "CENTER")
        label(f"ballons_puissance_{key}", x0, 134, w, 48, "--", "font_ballons_value", "0xFFFFFF", "CENTER")
        rows = [("commande", 188, "Commande"), ("chauffe", 214, "Chauffe réelle"), ("duree_on", 240, "Sur « on »"), ("duree_chauffe", 266, "Chauffe")]
        for rid, ry, caption in rows:
            label(f"ballons_leg_{rid}_{key}", x0 + 16, ry, 160, 26, caption, "font_ballons_text", "0xBBBBBB")
            label(f"ballons_val_{rid}_{key}", x0 + 170, ry, 124, 26, "--", "font_ballons_text", "0xFFFFFF", "RIGHT")

        glyph_water, glyph_fire = _cstr(g_water), _cstr(g_fire)
        text_sensors += [
            "  - platform: homeassistant", f"    id: ha_ballons_cmd_{key}", f"    entity_id: {sw}", "    internal: true",
            "    on_value:", "      - lvgl.label.update:", f"          id: ballons_val_commande_{key}",
            "          text: !lambda 'return x == \"on\" ? std::string(\"Marche\") : std::string(\"Arrêt\");'",
            "  - platform: homeassistant", f"    id: ha_ballons_chauffe_{key}", f"    entity_id: {chauffe}", "    internal: true",
            "    on_value:",
            "      - lvgl.label.update:", f"          id: ballons_val_chauffe_{key}",
            "          text: !lambda 'return x == \"on\" ? std::string(\"Oui\") : std::string(\"Non\");'",
            "      - lvgl.label.update:", f"          id: ballons_icone_{key}",
            f"          text: !lambda 'return x == \"on\" ? std::string(\"{glyph_fire}\") : std::string(\"{glyph_water}\");'",
            f"          text_color: !lambda 'return x == \"on\" ? lv_color_hex({BALLONS_COLOR_HEAT}) : lv_color_hex({color});'",
        ]
        hm = [
            "            if (std::isnan(x)) return std::string(\"--\");",
            "            int t = (int) roundf(x * 60.0f);",
            "            char buf[12];",
            "            snprintf(buf, sizeof(buf), \"%dh%02d\", t / 60, t % 60);",
            "            return std::string(buf);",
        ]
        sensors += [
            "  - platform: homeassistant", f"    id: ha_ballons_puissance_{key}", f"    entity_id: {power}", "    internal: true",
            "    on_value:", "      - lvgl.label.update:", f"          id: ballons_puissance_{key}",
            "          text: !lambda |-",
            "            if (std::isnan(x)) return std::string(\"--\");",
            "            char buf[16];",
            "            if (fabsf(x) >= 1000.0f) snprintf(buf, sizeof(buf), \"%.2f kW\", x / 1000.0f);",
            "            else snprintf(buf, sizeof(buf), \"%.0f W\", x);",
            "            return std::string(buf);",
            "  - platform: homeassistant", f"    id: ha_ballons_duree_on_{key}", f"    entity_id: {d_on}", "    internal: true",
            "    on_value:", "      - lvgl.label.update:", f"          id: ballons_val_duree_on_{key}",
            "          text: !lambda |-", *hm,
            "  - platform: homeassistant", f"    id: ha_ballons_duree_chauffe_{key}", f"    entity_id: {d_heat}", "    internal: true",
            "    on_value:", "      - lvgl.label.update:", f"          id: ballons_val_duree_chauffe_{key}",
            "          text: !lambda |-", *hm,
        ]

    # Ordre de chauffe : deux « boutons » (labels bordés) qui basculent un input_boolean au toucher
    label("ballons_ordre_titre", 80, 330, 640, 26, "Ordre de chauffe", "font_ballons_text", "0xBBBBBB", "CENTER")
    for bid, x0, entity, on_txt, off_txt in (
        ("premier", 80, BALLONS_ORDER_PREMIER, "En premier : Petit ballon", "En premier : Gros ballon"),
        ("unique", 410, BALLONS_ORDER_UNIQUE, "Un seul ballon : OUI", "Un seul ballon : NON"),
    ):
        add("  - label:", f"      id: ballons_btn_{bid}", f"      x: {x0}", "      y: 360", f"      width: {w}", "      height: 88",
            "      text_align: CENTER", "      text_font: font_ballons_title", "      pad_top: 28",
            f"      text: \"--\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP",
            "      radius: 14", "      border_width: 3", "      border_color: 0x666666",
            "      clickable: true", "      on_click:", "        - homeassistant.service:",
            "            service: input_boolean.toggle", "            data:", f"              entity_id: {entity}")
        text_sensors += [
            "  - platform: homeassistant", f"    id: ha_ballons_btn_{bid}", f"    entity_id: {entity}", "    internal: true",
            "    on_value:", "      - lvgl.label.update:", f"          id: ballons_btn_{bid}",
            f"          text: !lambda 'return x == \"on\" ? std::string(\"{on_txt}\") : std::string(\"{off_txt}\");'",
            "      - lvgl.widget.update:", f"          id: ballons_btn_{bid}",
            "          border_color: !lambda 'return x == \"on\" ? lv_color_hex(0x4CAF50) : lv_color_hex(0x666666);'",
        ]

    # Chiffres et « h » indispensables : les durées (« 1h05 ») sont écrites avec font_ballons_text — sans eux, rectangles verticaux.
    chars = set(BALLONS_TITLE) | set("".join(BALLONS_TEXTS)) | set("".join(b[0] for b in BALLONS.values())) | set("-0123456789h")
    fonts = [
        f"  - file: \"{FONT_FILENAME}\"", "    id: font_ballons_icon", "    size: 40",
        f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in (g_water, g_fire))}]",
        '  - file: "gfonts://Roboto"', "    id: font_ballons_title", "    size: 24",
        f"    glyphs: {build_glyphs_literal(chars)}",
        '  - file: "gfonts://Roboto"', "    id: font_ballons_text", "    size: 20",
        f"    glyphs: {build_glyphs_literal(chars)}",
        '  - file: "gfonts://Roboto"', "    id: font_ballons_value", "    size: 40",
        '    glyphs: "0123456789.-WkV% "',
    ]
    entities = [e for b in BALLONS.values() for e in b[3:]] + [BALLONS_ORDER_PREMIER, BALLONS_ORDER_UNIQUE]
    return {"font_lines": fonts, "sensor_block": sensors, "text_sensor_block": text_sensors,
            "widget_block": widgets, "page": BALLONS_PAGE_ID, "entities": entities,
            "floorplan_id": BALLONS_TITLE, "image_filename": None, "text_entries_used": [],
            "placed": len(entities), "skipped": 0}


def graft_page(existing: str, page: dict, width: int = 800, height: int = 480) -> str:
    """Greffe une page native (polices, capteurs, text_sensors, page LVGL) dans une configuration ESPHome déjà
    fusionnée/déployée, sans toucher aux plans existants. Refuse si la page y figure déjà."""
    lines = existing.split("\n")
    if any(l.strip() == f"- id: page_{page['page']}" for l in lines):
        sys.exit(f"Greffe : la page {page['page']} existe déjà dans la configuration.")

    def find(pred, start=0):
        for i in range(start, len(lines)):
            if pred(lines[i]):
                return i
        sys.exit("Greffe : ancre introuvable (format de la configuration inattendu).")

    def before_comments(i):
        while i > 0 and (not lines[i - 1].strip() or lines[i - 1].lstrip().startswith("#")):
            i -= 1
        return i

    # Dernier bloc de haut en bas pour garder des indices valides : page, sensor, text_sensor, font
    page_lines = [f"    - id: page_{page['page']}", "      widgets:",
                  "        - obj:", f"            id: full_screen_clear_{page['page']}",
                  "            x: 0", "            y: 0", f"            width: {width}", f"            height: {height}",
                  "            bg_color: 0x000000", "            bg_opa: COVER", "            border_width: 0", "            radius: 0"]
    page_lines += ["      " + l if l.strip() else l for l in page["widget_block"]]
    while not lines[-1].strip():
        lines.pop()
    lines += page_lines
    i_lvgl = find(lambda l: l.startswith("lvgl:"))
    i_sensor = find(lambda l: l.startswith("sensor:"))
    lines[before_comments(i_lvgl):before_comments(i_lvgl)] = page["sensor_block"]
    i_sensor = find(lambda l: l.startswith("sensor:"))
    i_text = find(lambda l: l.startswith("text_sensor:"))
    pos = before_comments(i_sensor)
    lines[pos:pos] = page["text_sensor_block"]
    i_text = find(lambda l: l.startswith("text_sensor:"))
    pos = before_comments(i_text)
    lines[pos:pos] = page["font_lines"]
    return "\n".join(lines) + "\n"


def _ha_defaults() -> tuple[str, str]:
    """URL et jeton du HA visé, lus dans la configuration de cette machine (data/core) — c'est le HA auquel l'écran est
    appairé tant que le noyau de cette machine pointe sur lui. Redéfinissables par --ha-url / --ha-token-file."""
    cfg = yaml.safe_load((REPO_ROOT / "data" / "core" / "config.yaml").read_text(encoding="utf-8")) or {}
    ws = ((cfg.get("ha") or {}).get("ws")) or {}
    url = f"http://{ws.get('host', '127.0.0.1')}:{ws.get('port', 8123)}"
    token = ""

    def find(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if "token" in str(k).lower() and isinstance(v, str) and v:
                    return v
                r = find(v)
                if r:
                    return r
        return ""

    sec = REPO_ROOT / "data" / "core" / "secrets_config.yaml"
    if sec.exists():
        token = find(yaml.safe_load(sec.read_text(encoding="utf-8")) or {})
    return url, token


def check_entities_in_ha(entity_ids: set, url: str, token: str) -> None:
    """Refuse de continuer si des entités des pages générées n'existent pas dans le HA visé : une erreur de ce type
    (plans d'un autre site) a déployé le 06/10/2026 des plans de noisy sur l'écran de Saint Fort — plus aucune valeur."""
    import json
    import urllib.request

    req = urllib.request.Request(url.rstrip("/") + "/api/states", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ha = {s["entity_id"] for s in json.load(resp)}
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Garde-fou : lecture des entités de {url} impossible ({e}). --skip-ha-check pour passer outre, à vos risques.")
    missing = sorted(e for e in entity_ids if e not in ha)
    if missing:
        sys.exit(
            f"Garde-fou : {len(missing)} entité(s) sur {len(entity_ids)} absentes du HA {url} — plans d'un autre site ?\n  "
            + "\n  ".join(missing[:15]) + ("\n  …" if len(missing) > 15 else "")
            + "\nRien n'a été déployé. --skip-ha-check pour passer outre."
        )
    print(f"Garde-fou : {len(entity_ids)} entités vérifiées dans {url} — toutes présentes.")


# ⭐ 06/10/2026 — pages « Thermostats » (poêle + pompe à chaleur) et « Climatisation » (une page par climatiseur, la salle en
# premier ; la navigation circulaire de la tablette les enchaîne). Commandes au toucher via les services `climate.*` de HA :
# marche/arrêt (turn_on/turn_off), consigne −/+ (set_temperature, bornée), mode (set_hvac_mode, en boucle) pour les climatiseurs.
CLIMATE_THERMOSTATS = [
    # clé, nom, entité, couleur, pas, min, max
    ("poele", "Poêle", "climate.salle_a_manger_poele", "0xFF9800", 0.5, 15.0, 25.0),
    ("pac", "Pompe à chaleur", "climate.infra_evoo7_control_thermostat", "0x2196F3", 0.5, 10.0, 30.0),
]
CLIMATE_CLIMS = [
    # clé, nom, entité, pas, min, max, modes cyclables
    ("clim_salle", "Salle", "climate.153931629788358_climate", 0.5, 16.0, 30.0, ["cool", "heat", "auto", "dry", "fan_only"]),
    ("clim_bureau", "Bureau", "climate.bureau_climatiseur", 1.0, 16.0, 32.0, ["cool", "heat", "heat_cool", "dry", "fan_only"]),
    ("clim_ami", "Chambre d'ami", "climate.chambre_d_ami_climatiseur", 1.0, 16.0, 32.0, ["cool", "heat", "heat_cool", "dry", "fan_only"]),
]
CLIMATE_COLOR_CLIM = "0x00BCD4"
CLIMATE_MODE_FR = {
    "off": "Arrêt", "heat": "Chauffage", "cool": "Froid", "auto": "Auto", "dry": "Déshumid.", "fan_only": "Ventil.", "heat_cool": "Auto",
}
CLIMATE_TEXT_CHARS = set("Thermostats Climatisation Poêle Pompe à chaleur Température Consigne Mode Marche Arrêt ") \
    | set("".join(CLIMATE_MODE_FR.values())) | set(" ".join(n for _k, n, *_r in CLIMATE_THERMOSTATS + CLIMATE_CLIMS)) \
    | set("0123456789.-+/°C ")


def _climate_card(key, name, entity, color, x0, w, step, tmin, tmax, modes):
    """Une carte de thermostat/climatiseur : retourne (widgets, sensors, text_sensors)."""
    widgets, sensors, text_sensors = [], [], []
    y0 = 48
    cx = x0 + w // 2

    def label(wid, x, y, wd, h, text, font, col, align="CENTER"):
        widgets.extend(["  - label:", f"      id: {wid}", f"      x: {x}", f"      y: {y}", f"      width: {wd}", f"      height: {h}",
                        f"      text_align: {align}", f"      text_font: {font}", f"      text: \"{text}\"",
                        f"      text_color: {col}", "      bg_opa: TRANSP"])

    def button(wid, x, y, wd, h, text, font, border, pad, on_click_lines):
        widgets.extend(["  - label:", f"      id: {wid}", f"      x: {x}", f"      y: {y}", f"      width: {wd}", f"      height: {h}",
                        "      text_align: CENTER", f"      text_font: {font}", f"      pad_top: {pad}", f"      text: \"{text}\"",
                        "      text_color: 0xFFFFFF", "      bg_opa: TRANSP", "      radius: 14", "      border_width: 3",
                        f"      border_color: {border}", "      clickable: true", "      on_click:"] + on_click_lines)

    widgets.extend(["  - obj:", f"      id: {key}_carte", f"      x: {x0}", f"      y: {y0}", f"      width: {w}", "      height: 380",
                    "      radius: 16", "      bg_color: 0x000000", "      bg_opa: COVER", f"      border_color: {color}", "      border_width: 3"])
    label(f"{key}_nom", x0, y0 + 8, w, 30, name, "font_clim_title", color)
    label(f"{key}_leg_temp", x0, y0 + 48, w, 24, "Température", "font_clim_text", "0xBBBBBB")
    label(f"{key}_temp", x0, y0 + 72, w, 58, "--", "font_clim_value", "0xFFFFFF")
    label(f"{key}_leg_cons", x0, y0 + 140, w, 24, "Consigne", "font_clim_text", "0xBBBBBB")
    label(f"{key}_cons", x0 + 100, y0 + 166, w - 200, 58, "--", "font_clim_value", color)
    ent = f"              entity_id: {entity}"
    st = f"id({key}_tgt).state"
    lam = lambda sign: [
        "              temperature: !lambda |-",
        f"                float t = {st};",
        f"                if (std::isnan(t)) t = {tmin}f;",
        f"                t = t {sign} {step}f;",
        f"                if (t < {tmin}f) t = {tmin}f;",
        f"                if (t > {tmax}f) t = {tmax}f;",
        "                char buf[12]; snprintf(buf, sizeof(buf), \"%.1f\", t); return std::string(buf);"]
    for sign, bid, bx, txt in (("-", f"{key}_moins", x0 + 20, "-"), ("+", f"{key}_plus", x0 + w - 100, "+")):
        button(bid, bx, y0 + 166, 80, 64, txt, "font_clim_value", "0x888888", 4,
               ["        - homeassistant.service:", "            service: climate.set_temperature", "            data:", ent] + lam(sign))
    label(f"{key}_mode", x0, y0 + 236, w, 28, "--", "font_clim_text", "0xFFFFFF")
    # Marche / Arrêt (bascule selon l'état courant) ; bouton de mode en plus pour les climatiseurs
    bw = (w - 60) // 2 if modes else w - 40
    onoff = ["        - if:", "            condition:", f"              lambda: 'return id({key}_state).state != \"off\";'",
             "            then:", "              - homeassistant.service:", "                  service: climate.turn_off", "                  data:",
             f"                    entity_id: {entity}", "            else:", "              - homeassistant.service:",
             "                  service: climate.turn_on", "                  data:", f"                    entity_id: {entity}"]
    button(f"{key}_onoff", x0 + 20, y0 + 280, bw, 80, "Marche / Arrêt", "font_clim_text", "0x666666", 26, onoff)
    if modes:
        arr = ", ".join(f'"{m}"' for m in modes)
        cyc = ["        - homeassistant.service:", "            service: climate.set_hvac_mode", "            data:", ent,
               "              hvac_mode: !lambda |-",
               f"                static const char* modes[] = {{{arr}}};",
               f"                const std::string cur = id({key}_state).state;",
               f"                int n = {len(modes)}; int i = -1;",
               "                for (int k = 0; k < n; k++) if (cur == modes[k]) i = k;",
               "                return std::string(modes[(i + 1) % n]);"]
        button(f"{key}_modebtn", x0 + 40 + bw, y0 + 280, bw, 80, "Mode", "font_clim_text", "0x666666", 26, cyc)

    fr = "; ".join(f'if (x == "{k}") return std::string("{v}")' for k, v in CLIMATE_MODE_FR.items())
    text_sensors += ["  - platform: homeassistant", f"    id: {key}_state", f"    entity_id: {entity}", "    internal: true", "    on_value:",
                     "      - lvgl.label.update:", f"          id: {key}_mode",
                     f"          text: !lambda 'if (x == \"unavailable\") return std::string(\"Indisponible\"); {fr}; return x;'",
                     "      - lvgl.widget.update:", f"          id: {key}_onoff",
                     "          border_color: !lambda 'return (x != \"off\" && x != \"unavailable\" && x != \"unknown\") ? lv_color_hex(0x4CAF50) : lv_color_hex(0x666666);'"]
    deg = ["            if (std::isnan(x)) return std::string(\"--\");", "            char buf[16];",
           "            snprintf(buf, sizeof(buf), \"%.1f°C\", x);", "            return std::string(buf);"]
    sensors += ["  - platform: homeassistant", f"    id: {key}_cur", f"    entity_id: {entity}", "    attribute: current_temperature", "    internal: true",
                "    on_value:", "      - lvgl.label.update:", f"          id: {key}_temp", "          text: !lambda |-", *deg,
                "  - platform: homeassistant", f"    id: {key}_tgt", f"    entity_id: {entity}", "    attribute: temperature", "    internal: true",
                "    on_value:", "      - lvgl.label.update:", f"          id: {key}_cons", "          text: !lambda |-", *deg]
    return widgets, sensors, text_sensors


def build_climate_pages() -> tuple[list, list]:
    """Pages « Thermostats » (poêle + PAC côte à côte) puis une page « Climatisation » par climatiseur. Retourne (pages, polices)."""
    pages = []

    # Page thermostats
    widgets = ["  - label:", "      id: thermostats_titre", "      x: 0", "      y: 8", "      width: 800", "      height: 30",
               "      text_align: CENTER", "      text_font: font_clim_title", "      text: \"Thermostats\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP"]
    sensors, text_sensors, entities = [], [], []
    for (key, name, entity, color, step, tmin, tmax), x0 in zip(CLIMATE_THERMOSTATS, (80, 410)):
        w, s_, t_ = _climate_card(key, name, entity, color, x0, 310, step, tmin, tmax, None)
        widgets += w; sensors += s_; text_sensors += t_; entities.append(entity)
    pages.append({"page": "thermostats", "floorplan_id": "Thermostats", "image_filename": None, "text_entries_used": [],
                  "widget_block": widgets, "sensor_block": sensors, "text_sensor_block": text_sensors, "entities": entities,
                  "placed": len(entities), "skipped": 0})

    # Une page par climatiseur
    n = len(CLIMATE_CLIMS)
    for idx, (key, name, entity, step, tmin, tmax, modes) in enumerate(CLIMATE_CLIMS, start=1):
        widgets = ["  - label:", f"      id: {key}_titre", "      x: 0", "      y: 8", "      width: 800", "      height: 30",
                   "      text_align: CENTER", "      text_font: font_clim_title",
                   f"      text: \"Climatisation {idx}/{n}\"", "      text_color: 0xFFFFFF", "      bg_opa: TRANSP"]
        w, s_, t_ = _climate_card(key, name, entity, CLIMATE_COLOR_CLIM, 120, 560, step, tmin, tmax, modes)
        pages.append({"page": key, "floorplan_id": f"Climatisation {name}", "image_filename": None, "text_entries_used": [],
                      "widget_block": widgets + w, "sensor_block": s_, "text_sensor_block": t_, "entities": [entity],
                      "placed": 1, "skipped": 0})

    chars = CLIMATE_TEXT_CHARS
    glyphs = build_glyphs_literal(chars)
    fonts = ['  - file: "gfonts://Roboto"', "    id: font_clim_title", "    size: 24", f"    glyphs: {glyphs}",
             '  - file: "gfonts://Roboto"', "    id: font_clim_text", "    size: 20", f"    glyphs: {glyphs}",
             '  - file: "gfonts://Roboto"', "    id: font_clim_value", "    size: 44", f"    glyphs: {glyphs}"]
    return pages, fonts


def process_floorplan(floorplan_id: str, floorplan: dict, args, out_dir: Path) -> dict:
    """Génère l'image + les widgets d'un plan. Retourne un résumé (page id, lignes générées)."""
    page = slug(floorplan_id) or "plan"

    image_path = IMAGES_DIR / floorplan["filename"]
    if not image_path.exists():
        sys.exit(f"Image introuvable : {image_path}")

    src_img = Image.open(image_path)
    final_img, scale, offset_x, offset_y = fit_and_pad(src_img, args.width, args.height)

    image_filename = f"floorplan_{page}_{args.width}x{args.height}.png"
    final_img.save(out_dir / image_filename)

    # `__trash_icon__` (et tout identifiant « __x__ ») : marqueurs d'interface du mode édition HAPLAN
    # (corbeille), parfois enregistrés dans les positions — pas des entités HA, ESPHome les refuse.
    positions = [
        p for p in floorplan.get("positions", [])
        if p.get("x") is not None and p.get("y") is not None and not str(p.get("entity_id", "")).startswith("__")
    ]
    texts = [t for t in floorplan.get("texts", []) if t.get("text")]

    sensor_block: list[str] = []
    text_sensor_block: list[str] = []
    widget_block: list[str] = []
    skipped = 0

    for pos in positions:
        entity_id = pos["entity_id"]
        px = round(offset_x + pos["x"] * src_img.width * scale)
        py = round(offset_y + pos["y"] * src_img.height * scale)
        if not (0 <= px <= args.width and 0 <= py <= args.height):
            skipped += 1
            continue

        kind = classify(entity_id)
        if kind == "sensor":
            sensor_lines, widget_lines = build_sensor_widget(page, entity_id, px, py, args.width, args.height)
            sensor_block.extend(sensor_lines)
        else:
            sensor_lines, widget_lines = build_icon_widget(page, entity_id, kind, px, py, args.width, args.height)
            text_sensor_block.extend(sensor_lines)
        widget_block.extend(widget_lines)

    # ⭐ 08/09/2026, texte libre — même transformation de coordonnées que les positions ci-dessus
    # (même espace normalisé 0-1 relatif à l'image source). `text_entries_used` remonté à main()
    # pour agréger les polices réellement nécessaires (voir build font: dans main()) : les textes
    # hors cadre (skip) ne doivent pas réserver une police pour rien.
    text_entries_used: list[dict] = []
    for t in texts:
        px = round(offset_x + t["x"] * src_img.width * scale)
        py = round(offset_y + t["y"] * src_img.height * scale)
        if not (0 <= px <= args.width and 0 <= py <= args.height):
            skipped += 1
            continue
        widget_block.extend(build_text_widget(page, t, px, py, args.width, args.height))
        text_entries_used.append(t)

    return {
        "page": page,
        "floorplan_id": floorplan_id,
        "image_filename": image_filename,
        "text_entries_used": text_entries_used,
        "sensor_block": sensor_block,
        "text_sensor_block": text_sensor_block,
        "widget_block": widget_block,
        "placed": len(positions) + len(texts) - skipped,
        "skipped": skipped,
    }


def _extract_anchor(pattern: str, text: str, label: str) -> str:
    m = re.search(pattern, text, re.S | re.M)
    if not m:
        sys.exit(f"Fusion : bloc '{label}' introuvable dans le fragment généré (format inattendu).")
    return m.group(1)


def _replace_anchor_once(template: str, anchor: str, replacement: str, label: str) -> str:
    """Remplace `anchor` par `replacement`, en exigeant exactement une occurrence — évite une
    fusion silencieusement no-op si le template a changé de forme depuis l'écriture des ancres."""
    count = template.count(anchor)
    if count != 1:
        sys.exit(
            f"Fusion : ancre '{label}' trouvée {count} fois dans le template (attendu 1). "
            f"Le template esphome/haplan-display.yaml a probablement changé de forme — "
            f"mettre à jour les ancres dans merge_config()."
        )
    return template.replace(anchor, replacement)


def merge_config(template_text: str, fragment_text: str) -> str:
    """Fusionne le fragment généré (image:/font:/text_sensor:/sensor:/pages_fragment:) dans le
    template haplan-display.yaml, aux emplacements marqués par des ancres en commentaire.

    Fusion textuelle (pas de parsing YAML réel) car le fragment et le template utilisent des tags
    ESPHome non standard (!secret, !lambda) que PyYAML ne sait pas re-sérialiser fidèlement — même
    approche que la fusion manuelle faite pendant les essais sur écran physique le 13/08/2026,
    désormais stabilisée ici pour ne plus dépendre de heredocs tapés à la main à chaque itération.
    """
    image_block = _extract_anchor(r"^image:\n(.*?)\n\n", fragment_text, "image")
    font_block = _extract_anchor(r"^font:\n(.*?)\n\n", fragment_text, "font")
    text_sensor_block = _extract_anchor(r"^text_sensor:\n(.*?)^sensor:\n", fragment_text, "text_sensor")
    sensor_block = _extract_anchor(r"^sensor:\n(.*?)\n\n#", fragment_text, "sensor")
    pages_block = _extract_anchor(r"^pages_fragment:\n(.*)\Z", fragment_text, "pages_fragment")

    out = template_text
    out = _replace_anchor_once(out, "# image:\n#   ...\n", f"image:\n{image_block}\n", "image")
    out = _replace_anchor_once(out, "# font:\n#   ...\n", f"font:\n{font_block}\n", "font")
    out = _replace_anchor_once(
        out, "# text_sensor:\n#   ...\n", f"text_sensor:\n{text_sensor_block}\n", "text_sensor"
    )
    out = _replace_anchor_once(out, "# sensor:\n#   ...\n", f"sensor:\n{sensor_block}\n", "sensor")

    # Widgets de page indentés à 2 espaces dans le fragment ("  - id: page_x") ; il en faut 4 une
    # fois placés sous `lvgl: pages:` (elle-même à 2 espaces) du template.
    pages_reindented = "\n".join("  " + line if line.strip() else line for line in pages_block.splitlines())
    pages_anchor = (
        '    # COLLER ICI le contenu de "pages_fragment:" (généré par le script, --all) — une entrée de\n'
        "    # cette liste par plan (id + widgets), voir floorplan_pages.yaml.\n"
    )
    out = _replace_anchor_once(out, pages_anchor, pages_reindented + "\n", "pages")

    # Nom du secret API attendu par secrets.yaml (convention api_<nom-esphome>, voir
    # data/esphome/secrets.yaml) — dérivé du nom de l'appareil déclaré dans le template plutôt que
    # codé en dur, pour rester valable si ce script sert un jour à d'autres écrans ESP.
    name_match = re.search(r"^esphome:\s*\n\s*name:\s*(\S+)", template_text, re.M)
    device_name = name_match.group(1) if name_match else "esphome-display"
    out = out.replace("api_encryption_key", f"api_{device_name}")

    return out


def run_compile_pipeline(merged_text: str, results: list[dict], out_dir: Path, args) -> None:
    """Copie le YAML fusionné + les assets (images/police/partitions) dans le répertoire de config
    du conteneur esphome déjà en service sur cette machine, puis lance `esphome compile` dedans."""
    config_dir = Path(args.esphome_config_dir)
    if not config_dir.is_dir():
        sys.exit(f"Répertoire de config esphome introuvable : {config_dir}")

    # Déployé sous le même nom que le template ("haplan-display.yaml") — c'est ce nom de fichier
    # qui identifie l'appareil dans le registre HA/tableau de bord ESPHome (device "haplan-display-1"
    # -> configuration "haplan-display.yaml"), pas un nom "-merged" distinct qui ne correspondrait à
    # aucun appareil apparié. Redéfinissable via --esphome-deploy-filename si un jour plusieurs
    # appareils partagent le même template avec des noms de fichiers différents.
    merged_filename = args.esphome_deploy_filename or Path(args.template).name
    (config_dir / merged_filename).write_text(merged_text, encoding="utf-8")

    font_src = Path(__file__).parent / "esphome" / "fonts" / FONT_FILENAME
    shutil.copy2(font_src, config_dir / FONT_FILENAME)

    partitions_src = Path(__file__).parent / "esphome" / PARTITIONS_FILENAME
    if partitions_src.exists():
        shutil.copy2(partitions_src, config_dir / PARTITIONS_FILENAME)

    for r in results:
        if r["image_filename"]:
            shutil.copy2(out_dir / r["image_filename"], config_dir / r["image_filename"])

    print(f"Assets copiés dans : {config_dir}")
    print(f"Compilation : docker exec {args.esphome_container} esphome compile /config/{merged_filename}")

    proc = subprocess.run(
        ["docker", "exec", args.esphome_container, "esphome", "compile", f"/config/{merged_filename}"]
    )
    if proc.returncode != 0:
        sys.exit(f"Échec de la compilation ESPHome (code {proc.returncode}).")
    print("Compilation réussie.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("floorplan_ids", nargs="*", help="Clés des plans à générer (ex: original 'Rez de chaussée')")
    parser.add_argument("--all", action="store_true", help="Générer tous les plans du fichier de config")
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--out-dir", default=str(Path(__file__).parent / "esphome"))
    parser.add_argument(
        "--merge", action="store_true",
        help="Fusionne le fragment généré dans le template esphome/haplan-display.yaml "
             "(produit <nom-template>-merged.yaml dans --out-dir)",
    )
    parser.add_argument(
        "--compile", action="store_true",
        help="Implique --merge ; copie aussi le YAML fusionné + les assets dans "
             "--esphome-config-dir puis lance `esphome compile` dans le conteneur Docker",
    )
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="Template ESPHome à fusionner")
    parser.add_argument("--esphome-config-dir", default=str(DEFAULT_ESPHOME_CONFIG_DIR))
    parser.add_argument("--esphome-container", default=DEFAULT_ESPHOME_CONTAINER)
    parser.add_argument(
        "--esphome-deploy-filename", default=None,
        help="Nom de fichier sous lequel déployer le YAML fusionné dans --esphome-config-dir "
             "(défaut : même nom que --template, pour matcher l'appareil déjà apparié dans HA)",
    )
    parser.add_argument("--energy", action="store_true", help="Ajoute la page « Énergie en direct » (déjà incluse par --all)")
    parser.add_argument("--no-energy", action="store_true", help="Exclut la page « Énergie en direct » même avec --all")
    parser.add_argument("--no-ballons", action="store_true", help="Exclut la page « Chauffe des ballons » (incluse avec --all)")
    parser.add_argument("--no-climate", action="store_true", help="Exclut les pages « Thermostats » et « Climatisation » (incluses avec --all)")
    parser.add_argument("--ha-url", default=None, help="HA visé pour le garde-fou (défaut : celui de data/core/config.yaml)")
    parser.add_argument("--ha-token-file", default=None, help="Fichier YAML contenant le jeton (défaut : data/core/secrets_config.yaml)")
    parser.add_argument("--skip-ha-check", action="store_true", help="Désactive le garde-fou « entités présentes dans le HA visé »")
    parser.add_argument(
        "--graft-ballons", metavar="YAML", default=None,
        help="Greffe la page « Chauffe des ballons » dans cette configuration ESPHome déjà déployée (modifiée sur place, "
             "SANS régénérer les plans) puis quitte. Faire une copie de sauvegarde avant.",
    )
    args = parser.parse_args()

    if args.graft_ballons:
        target = Path(args.graft_ballons)
        target.write_text(graft_page(target.read_text(encoding="utf-8"), build_ballons_page(), args.width, args.height), encoding="utf-8")
        print(f"Page « {BALLONS_TITLE} » greffée dans {target}")
        return

    if not FLOORPLANS_CONFIG.exists():
        sys.exit(f"Introuvable : {FLOORPLANS_CONFIG}")

    with open(FLOORPLANS_CONFIG, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    all_floorplans = config.get("floorplans") or {}

    if args.all:
        ids = list(all_floorplans.keys())
    elif args.floorplan_ids:
        ids = args.floorplan_ids
    else:
        sys.exit("Indiquer --all ou au moins un identifiant de plan (voir --help).")

    for fid in ids:
        if fid not in all_floorplans:
            available = ", ".join(all_floorplans.keys())
            sys.exit(f"Plan '{fid}' introuvable. Plans disponibles : {available}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    font_src = Path(__file__).parent / "esphome" / "fonts" / FONT_FILENAME
    if not font_src.exists():
        sys.exit(f"Police introuvable : {font_src} (voir en-tête du script)")

    results = [process_floorplan(fid, all_floorplans[fid], args, out_dir) for fid in ids]
    with_energy = (args.all or args.energy) and not args.no_energy
    if with_energy:
        results.append(build_energy_page(args.width, args.height))
    with_ballons = with_energy and not args.no_ballons
    if with_ballons:
        results.append(build_ballons_page())
    with_climate = with_energy and not args.no_climate
    climate_fonts: list[str] = []
    if with_climate:
        climate_pages, climate_fonts = build_climate_pages()
        results.extend(climate_pages)

    # Garde-fou : toutes les entités des pages générées doivent exister dans le HA visé (obligatoire avec --compile)
    if (args.compile or args.merge) and not args.skip_ha_check:
        wanted = set()
        for fid in ids:
            for pos in all_floorplans[fid].get("positions", []):
                eid = str(pos.get("entity_id", ""))
                if eid and not eid.startswith("__"):
                    wanted.add(eid)
        if with_energy:
            wanted |= {n[0] for n in ENERGY_NODES.values()} | {ENERGY_SOC_ENTITY}
        if with_ballons:
            wanted |= set(next(r for r in results if r["page"] == BALLONS_PAGE_ID)["entities"])
        if with_climate:
            wanted |= {e for r in climate_pages for e in r["entities"]}
        d_url, d_token = _ha_defaults()
        url = args.ha_url or d_url
        token = d_token
        if args.ha_token_file:
            token = yaml.safe_load(Path(args.ha_token_file).read_text(encoding="utf-8")).get("token", d_token)
        check_entities_in_ha(wanted, url, token)

    lines: list[str] = []
    lines.append(f"# Généré par generate_esphome_floorplan.py --- {len(results)} plan(s) : {', '.join(r['floorplan_id'] for r in results)}")
    lines.append(f"# Images de fond ci-dessous (voir image:) — à copier dans le dossier du projet ESPHome.")
    lines.append(f"# Police d'icônes : {FONT_FILENAME} (voir fonts/, à copier aussi dans le dossier du projet ESPHome)")
    lines.append("")

    lines.append("image:")
    for r in (r for r in results if r["image_filename"]):
        lines.append(f"  - file: \"{r['image_filename']}\"")
        lines.append(f"    id: floorplan_bg_{r['page']}")
        lines.append(f"    type: RGB565")
    lines.append("")

    lines.append("font:")
    lines.append(f"  - file: \"{FONT_FILENAME}\"")
    lines.append(f"    id: font_icons")
    lines.append(f"    size: {ICON_FONT_SIZE}")
    all_glyphs = sorted(
        set(g for pair in ICON_BY_KIND.values() for g in pair)
        | set(icon for icon, _color in ICON_AND_COLOR_BY_SENSOR_TYPE.values())
    )
    lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in all_glyphs)}]")
    lines.append(f"  - file: \"{FONT_FILENAME}\"")
    lines.append(f"    id: font_nav")
    lines.append(f"    size: {NAV_FONT_SIZE}")
    nav_glyphs = [ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT]
    lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in nav_glyphs)}]")
    # Police texte des valeurs de capteurs (température/humidité/pression...) — auparavant sans
    # police dédiée (taille par défaut LVGL, jugée trop petite). Jeu de glyphes restreint aux
    # caractères réellement produits par build_sensor_widget ("%.1f" -> chiffres, point, signe -).
    lines.append('  - file: "gfonts://Roboto"')
    lines.append(f"    id: font_sensor")
    lines.append(f"    size: {SENSOR_FONT_SIZE}")
    lines.append('    glyphs: "0123456789.-"')

    # ⭐ 08/09/2026, texte libre — une police par PALIER DE TAILLE réellement utilisé (pas par
    # texte : LVGL référence une police par id, pas par caractères), glyphes = union des caractères
    # de tous les textes de ce palier à travers TOUS les plans générés. Un palier non utilisé par
    # aucun texte n'a pas d'entrée (évite une police vide, refusée par ESPHome).
    text_sizes_used: dict[str, set] = {}
    for r in results:
        for t in r["text_entries_used"]:
            size = t.get("size") or "medium"
            chars = text_sizes_used.setdefault(size, set())
            chars.update(t["text"])
            chars.add(" ")  # toujours inclus (texte multi-mots), même si un texte isolé n'en a pas
    for size in ("small", "medium", "large"):
        if size not in text_sizes_used:
            continue
        lines.append('  - file: "gfonts://Roboto"')
        lines.append(f"    id: font_text_{size}")
        lines.append(f"    size: {TEXT_FONT_SIZE_BY_SIZE[size]}")
        lines.append(f"    glyphs: {build_glyphs_literal(text_sizes_used[size])}")

    if with_energy:
        energy = next(r for r in results if r["page"] == ENERGY_PAGE_ID)
        lines.append(f"  - file: \"{FONT_FILENAME}\"")
        lines.append("    id: font_energy_icons")
        lines.append(f"    size: {ENERGY_ICON_FONT_SIZE}")
        icon_glyphs = [n[4] for n in ENERGY_NODES.values()]
        lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in icon_glyphs)}]")
        lines.append(f"  - file: \"{FONT_FILENAME}\"")
        lines.append("    id: font_energy_arrow")
        lines.append(f"    size: {ENERGY_ARROW_FONT_SIZE}")
        lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in ENERGY_ARROWS.values())}]")
        lines.append('  - file: "gfonts://Roboto"')
        lines.append("    id: font_energy_value")
        lines.append(f"    size: {ENERGY_VALUE_FONT_SIZE}")
        lines.append('    glyphs: "0123456789.-WkV% "')
        lines.append('  - file: "gfonts://Roboto"')
        lines.append("    id: font_energy_text")
        lines.append(f"    size: {ENERGY_TEXT_FONT_SIZE}")
        lines.append(f"    glyphs: {build_glyphs_literal(energy['energy_text_chars'] | set('-'))}")
        if with_ballons:
            lines.extend(next(r for r in results if r["page"] == BALLONS_PAGE_ID)["font_lines"])
        if with_climate:
            lines.extend(climate_fonts)

    lines.append("")

    all_text_sensor = [l for r in results for l in r["text_sensor_block"]]
    all_sensor = [l for r in results for l in r["sensor_block"]]
    if all_text_sensor:
        lines.append("text_sensor:")
        lines.extend(all_text_sensor)
        lines.append("")
    if all_sensor:
        lines.append("sensor:")
        lines.extend(all_sensor)
        lines.append("")

    lines.append("# À fusionner comme valeur de `lvgl: pages:` dans haplan-display.yaml — une entrée de")
    lines.append("# cette liste par plan, chacune avec son propre effacement plein écran + image de fond +")
    lines.append("# widgets (voir commentaire sur pages_fragment plus bas pour le détail par page).")
    lines.append("pages_fragment:")
    for r in results:
        lines.append(f"  - id: page_{r['page']}")
        lines.append(f"    widgets:")
        lines.append(f"      - obj:")
        lines.append(f"          id: full_screen_clear_{r['page']}")
        lines.append(f"          x: 0")
        lines.append(f"          y: 0")
        lines.append(f"          width: {args.width}")
        lines.append(f"          height: {args.height}")
        lines.append(f"          bg_color: 0x000000")
        lines.append(f"          bg_opa: COVER")
        lines.append(f"          border_width: 0")
        lines.append(f"          radius: 0")
        if r["image_filename"]:
            lines.append(f"      - image:")
            lines.append(f"          src: floorplan_bg_{r['page']}")
            lines.append(f"          x: 0")
            lines.append(f"          y: 0")
            lines.append(f"          width: {args.width}")
            lines.append(f"          height: {args.height}")
        for wline in r["widget_block"]:
            # Widgets déjà indentés à 2 espaces (style "  - label:") — les widgets de page ESPHome
            # veulent 6 espaces sous `widgets:` (2 de base + 4 pour rentrer dans `- id:/widgets:`).
            lines.append("    " + wline if wline.strip() else wline)

    out_yaml = out_dir / "floorplan_pages.yaml"
    out_yaml.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Fragment   : {out_yaml}")
    for r in results:
        print(f"  - {r['floorplan_id']!r:30} page={r['page']:20} image={(r['image_filename'] or '(aucune)'):35} {r['placed']} placées, {r['skipped']} hors cadre")

    if args.merge or args.compile:
        template_path = Path(args.template)
        if not template_path.exists():
            sys.exit(f"Template introuvable : {template_path}")
        merged_text = merge_config(template_path.read_text(encoding="utf-8"), out_yaml.read_text(encoding="utf-8"))
        merged_path = out_dir / (template_path.stem + "-merged.yaml")
        merged_path.write_text(merged_text, encoding="utf-8")
        print(f"Fusionné   : {merged_path}")

        if args.compile:
            run_compile_pipeline(merged_text, results, out_dir, args)


if __name__ == "__main__":
    main()
