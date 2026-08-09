#!/usr/bin/env python3
"""
generate_esphome_floorplan.py

Outil autonome (hors runtime de l'app, exécuté à la main) : lit un plan HAPLAN existant
(data/haplan/config-haplan-floorplans-v1.0.yaml + son image dans data/haplan/images/) et produit,
pour l'écran 800x480 d'une carte ESP32-8048S070 :

1. Une image de fond ajustée à la résolution cible (contain-fit, ratio préservé, centrée sur fond
   noir) — les plans HAPLAN existants ont des ratios variés (ex: 620x818 portrait pour le plan
   "original"), différents du 800x480 (5:3) de l'écran ; un simple resize écraserait l'image.
2. Un fragment YAML ESPHome (`text_sensor:`/`sensor:` + `lvgl: widgets:`) plaçant une icône par
   position déjà définie dans HAPLAN, aux coordonnées pixel recalculées pour l'image ajustée —
   réutilise donc directement le travail de positionnement déjà fait dans l'UI HAPLAN, jamais
   ressaisi à la main.

Classification par domaine (préfixe de l'entity_id), volontairement simplifiée par rapport au
UnifiedObjectFactory réel de HAPLAN (fonctionnelles-haplan_specs §9.2, qui reclasse certains
light/switch en VMC/chauffe-eau/radiateur selon des mots-clés) : light/switch -> indicateur rond
coloré (on/off), sensor -> étiquette texte (valeur + unité), le reste (cover/climate/binary_sensor)
-> indicateur rond coloré comme un switch. À affiner si besoin une fois le premier écran validé.

Usage :
    python3 generate_esphome_floorplan.py original
    python3 generate_esphome_floorplan.py original --width 800 --height 480

Dépendances : PyYAML, Pillow (déjà présentes sur ce poste — aucune n'est ajoutée au projet Node,
cet outil est volontairement hors du runtime applicatif).
"""

import argparse
import sys
from pathlib import Path

import yaml
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
FLOORPLANS_CONFIG = REPO_ROOT / "data" / "haplan" / "config-haplan-floorplans-v1.0.yaml"
IMAGES_DIR = REPO_ROOT / "data" / "haplan" / "images"

# Couleurs par domaine — reprend l'esprit de fonctionnelles-haplan_specs §9.3 (état lu à la couleur)
COLOR_ON = "0xFFC107"   # ampoule dorée, lumière allumée (§9.3)
COLOR_OFF = "0x37474F"  # gris-bleu foncé, éteint
COLOR_SENSOR_BG = "0x000000"
COLOR_SENSOR_TEXT = "0xFFFFFF"

CIRCLE_DIAMETER = 28
LABEL_WIDTH = 90
LABEL_HEIGHT = 24


def slug(entity_id: str) -> str:
    return entity_id.replace(".", "_").replace("-", "_")


def classify(entity_id: str) -> str:
    domain = entity_id.split(".", 1)[0]
    if domain == "sensor":
        return "sensor"
    return "onoff"  # light/switch/cover/climate/binary_sensor -> indicateur rond (simplifié)


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


def build_lvgl_widget(entity_id: str, kind: str, px: int, py: int) -> tuple[list[str], list[str]]:
    """Retourne (lignes_capteur_esphome, lignes_widget_lvgl) pour une entité positionnée."""
    eid = slug(entity_id)

    if kind == "sensor":
        sensor_lines = [
            f"  - platform: homeassistant",
            f"    id: ha_{eid}",
            f"    entity_id: {entity_id}",
            f"    internal: true",
            f"    on_value:",
            f"      - lvgl.label.update:",
            f"          id: lbl_{eid}",
            f"          text: !lambda |-",
            f"            char buf[16];",
            f"            snprintf(buf, sizeof(buf), \"%.1f\", x);",
            f"            return std::string(buf);",
        ]
        widget_lines = [
            f"  - label:",
            f"      id: lbl_{eid}",
            f"      x: {px - LABEL_WIDTH // 2}",
            f"      y: {py - LABEL_HEIGHT // 2}",
            f"      width: {LABEL_WIDTH}",
            f"      height: {LABEL_HEIGHT}",
            f"      text: \"--\"",
            f"      text_color: {COLOR_SENSOR_TEXT}",
            f"      bg_color: {COLOR_SENSOR_BG}",
            f"      bg_opa: COVER",
            f"      align: CENTER",
        ]
        return sensor_lines, widget_lines

    # onoff : light/switch/cover/climate — mirror de l'état brut ("on"/"off"/...) en text_sensor,
    # couleur du rond mise à jour en conséquence.
    sensor_lines = [
        f"  - platform: homeassistant",
        f"    id: ha_{eid}",
        f"    entity_id: {entity_id}",
        f"    internal: true",
        f"    on_value:",
        f"      - lvgl.widget.update:",
        f"          id: dot_{eid}",
        f"          bg_color: !lambda |-",
        f"            return (x == \"on\" || x == \"open\" || x == \"heat\" || x == \"cool\")",
        f"              ? lv_color_hex({COLOR_ON}) : lv_color_hex({COLOR_OFF});",
    ]
    widget_lines = [
        f"  - obj:",
        f"      id: dot_{eid}",
        f"      x: {px - CIRCLE_DIAMETER // 2}",
        f"      y: {py - CIRCLE_DIAMETER // 2}",
        f"      width: {CIRCLE_DIAMETER}",
        f"      height: {CIRCLE_DIAMETER}",
        f"      radius: {CIRCLE_DIAMETER // 2}",
        f"      bg_color: {COLOR_OFF}",
        f"      bg_opa: COVER",
        f"      border_width: 2",
        f"      border_color: 0xFFFFFF",
    ]
    return sensor_lines, widget_lines


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("floorplan_id", help="Clé du plan dans config-haplan-floorplans-v1.0.yaml (ex: original)")
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--out-dir", default=str(Path(__file__).parent / "esphome"))
    args = parser.parse_args()

    if not FLOORPLANS_CONFIG.exists():
        sys.exit(f"Introuvable : {FLOORPLANS_CONFIG}")

    with open(FLOORPLANS_CONFIG, encoding="utf-8") as f:
        config = yaml.safe_load(f)

    floorplan = (config.get("floorplans") or {}).get(args.floorplan_id)
    if not floorplan:
        available = ", ".join((config.get("floorplans") or {}).keys())
        sys.exit(f"Plan '{args.floorplan_id}' introuvable. Plans disponibles : {available}")

    image_path = IMAGES_DIR / floorplan["filename"]
    if not image_path.exists():
        sys.exit(f"Image introuvable : {image_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    src_img = Image.open(image_path)
    final_img, scale, offset_x, offset_y = fit_and_pad(src_img, args.width, args.height)

    image_filename = f"floorplan_{slug(args.floorplan_id)}_{args.width}x{args.height}.png"
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
        sensor_lines, widget_lines = build_lvgl_widget(entity_id, kind, px, py)
        if kind == "sensor":
            sensor_block.extend(sensor_lines)
        else:
            text_sensor_block.extend(sensor_lines)
        widget_block.extend(widget_lines)

    lines: list[str] = []
    lines.append(f"# Généré par generate_esphome_floorplan.py --- {args.floorplan_id} ({len(positions) - skipped} entités, {skipped} hors cadre ignorées)")
    lines.append(f"# Image de fond : {image_filename} (voir image: ci-dessous, à copier dans le dossier du projet ESPHome)")
    lines.append("")
    lines.append("image:")
    lines.append(f"  - file: \"{image_filename}\"")
    lines.append(f"    id: floorplan_bg")
    lines.append(f"    type: RGB565")
    lines.append("")
    if text_sensor_block:
        lines.append("text_sensor:")
        lines.extend(text_sensor_block)
        lines.append("")
    if sensor_block:
        lines.append("sensor:")
        lines.extend(sensor_block)
        lines.append("")
    lines.append("# À fusionner dans le bloc `lvgl: pages: - widgets:` du fichier principal (voir haplan-display.yaml)")
    lines.append("lvgl_widgets_fragment:")
    lines.extend(widget_block)

    out_yaml = out_dir / f"floorplan_{slug(args.floorplan_id)}.yaml"
    out_yaml.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Image      : {out_dir / image_filename}")
    print(f"Fragment   : {out_yaml}")
    print(f"Entités    : {len(positions) - skipped} placées, {skipped} hors cadre ignorées")


if __name__ == "__main__":
    main()
