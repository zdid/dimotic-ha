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
qui charge la 6.0.0 par CDN). Les capteurs (sensor.*) restent une étiquette texte, comme sur le web
(EnhancedTemperatureSensor et consorts n'affichent qu'une valeur, sans icône).

Identifiants de widgets/capteurs préfixés par plan (ex: icon_original_light_xxx vs
icon_premier_light_xxx) — indispensable dès qu'un même entity_id apparaît sur plusieurs plans
("original" duplique tout le monde), sans quoi deux widgets porteraient le même id LVGL (erreur de
compilation ESPHome, id non unique).

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
import sys
from pathlib import Path

import yaml
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
FLOORPLANS_CONFIG = REPO_ROOT / "data" / "haplan" / "config-haplan-floorplans-v1.0.yaml"
IMAGES_DIR = REPO_ROOT / "data" / "haplan" / "images"
FONT_FILENAME = "fa-solid-900.ttf"

# Couleurs — reprend l'esprit de fonctionnelles-haplan_specs §9.3 (état lu à la couleur/l'icône)
COLOR_ON = "0xFFC107"   # ampoule dorée, allumé
COLOR_OFF = "0x9E9E9E"  # gris clair, éteint (plus lisible qu'un gris-bleu foncé sur fond sombre)
COLOR_SENSOR_TEXT = "0xFFFFFF"

ICON_BG_DIAMETER = 24   # réduit depuis 28 (retour utilisateur "icônes trop grosses")
ICON_FONT_SIZE = 14
LABEL_WIDTH = 110        # élargi depuis 90 (valeurs type "1016.6 hPa" coupées)
LABEL_HEIGHT = 26

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
ICON_THERMOMETER = chr(0xF2C9)  # thermostat


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
            f"              ? \"{icon_on}\" : \"{icon_off}\";",
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
            f"      clickable: true",
            f"      on_click:",
            f"        - homeassistant.service:",
            f"            service: {domain}.toggle",
            f"            data:",
            f"              entity_id: {entity_id}",
        ]
    return sensor_lines, widget_lines


def build_sensor_widget(page: str, entity_id: str, px: int, py: int, canvas_w: int, canvas_h: int) -> tuple[list[str], list[str]]:
    eid = f"{page}_{slug(entity_id)}"
    bx, by = clamp_box(px, py, LABEL_WIDTH, LABEL_HEIGHT, canvas_w, canvas_h)

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
        f"  - label:",
        f"      id: lbl_{eid}",
        f"      x: {bx}",
        f"      y: {by}",
        f"      width: {LABEL_WIDTH}",
        f"      height: {LABEL_HEIGHT}",
        f"      text: \"--\"",
        f"      text_align: CENTER",
        f"      text_color: {COLOR_SENSOR_TEXT}",
        # Boîte transparente — un fond opaque (essayé initialement) masquait des morceaux du plan
        # et des icônes voisines dès que la boîte, élargie pour ne plus couper le texte, débordait
        # sur des éléments proches. Le texte blanc seul reste lisible sur le plan sombre.
        f"      bg_opa: TRANSP",
    ]
    return sensor_lines, widget_lines


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

    positions = [p for p in floorplan.get("positions", []) if p.get("x") is not None and p.get("y") is not None]

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

    return {
        "page": page,
        "floorplan_id": floorplan_id,
        "image_filename": image_filename,
        "sensor_block": sensor_block,
        "text_sensor_block": text_sensor_block,
        "widget_block": widget_block,
        "placed": len(positions) - skipped,
        "skipped": skipped,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("floorplan_ids", nargs="*", help="Clés des plans à générer (ex: original 'Rez de chaussée')")
    parser.add_argument("--all", action="store_true", help="Générer tous les plans du fichier de config")
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--out-dir", default=str(Path(__file__).parent / "esphome"))
    args = parser.parse_args()

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

    lines: list[str] = []
    lines.append(f"# Généré par generate_esphome_floorplan.py --- {len(results)} plan(s) : {', '.join(r['floorplan_id'] for r in results)}")
    lines.append(f"# Images de fond ci-dessous (voir image:) — à copier dans le dossier du projet ESPHome.")
    lines.append(f"# Police d'icônes : {FONT_FILENAME} (voir fonts/, à copier aussi dans le dossier du projet ESPHome)")
    lines.append("")

    lines.append("image:")
    for r in results:
        lines.append(f"  - file: \"{r['image_filename']}\"")
        lines.append(f"    id: floorplan_bg_{r['page']}")
        lines.append(f"    type: RGB565")
    lines.append("")

    lines.append("font:")
    lines.append(f"  - file: \"{FONT_FILENAME}\"")
    lines.append(f"    id: font_icons")
    lines.append(f"    size: {ICON_FONT_SIZE}")
    all_glyphs = sorted(set(g for pair in ICON_BY_KIND.values() for g in pair))
    lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in all_glyphs)}]")
    lines.append(f"  - file: \"{FONT_FILENAME}\"")
    lines.append(f"    id: font_nav")
    lines.append(f"    size: {NAV_FONT_SIZE}")
    nav_glyphs = [ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT]
    lines.append(f"    glyphs: [{', '.join(repr(g).replace(chr(39), chr(34)) for g in nav_glyphs)}]")
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
        print(f"  - {r['floorplan_id']!r:30} page={r['page']:20} image={r['image_filename']:35} {r['placed']} placées, {r['skipped']} hors cadre")


if __name__ == "__main__":
    main()
