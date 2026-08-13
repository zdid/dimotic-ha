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
        f"      text_font: font_sensor",
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
    # Police texte des valeurs de capteurs (température/humidité/pression...) — auparavant sans
    # police dédiée (taille par défaut LVGL, jugée trop petite). Jeu de glyphes restreint aux
    # caractères réellement produits par build_sensor_widget ("%.1f" -> chiffres, point, signe -).
    lines.append('  - file: "gfonts://Roboto"')
    lines.append(f"    id: font_sensor")
    lines.append(f"    size: {SENSOR_FONT_SIZE}")
    lines.append('    glyphs: "0123456789.-"')
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
