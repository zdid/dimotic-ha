#!/usr/bin/env python3
"""Reclasse l'écran haplan-display (phase 1 : bases/ + communs/ + pages/ + screens/) dans l'organisation
materiels/ + elements/ + appareils/ (13/10/2026, fonctionnelles-espdisplay_specs v1.7).

- materiels/sunton-8048s070c/base.yaml : l'ancienne base SANS le wifi (élément wifi-simple ou wifi-multi-ap à part),
  plus la police de navigation (font_nav, utilisée par les flèches de la base) ;
- elements/polices-plans, elements/polices-climatisation : les polices partagées ;
- elements/page-<nom> : une page par élément (contenu inchangé) ;
- elements/page-climatisation : UNE page paramétrable (7 variables) qui remplace les 3 copies ; vérifiée ici par
  ré-instanciation textuelle exacte de chacune des 3 pages d'origine ;
- appareils/haplan-display.yaml : identité de l'écran + packages dans l'ordre d'affichage.

Usage : reclasser-ecran-phase1.py <dossier espdisplay> <dossier de sortie>
"""
import re
import sys
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
B = src / "bibliotheque"
TOP = re.compile(r"^([a-z_0-9]+):")


def top_blocks(text):
    lines, out_, cur, pending = text.split("\n"), [], None, []
    for l in lines:
        m = TOP.match(l)
        if m:
            if cur:
                out_.append(cur)
            cur = [m.group(1), pending + [l]]
            pending = []
        elif cur is None or not l.strip() or l.startswith("#"):
            (pending if cur is not None else pending).append(l)
        else:
            cur[1].extend(pending + [l])
            pending = []
    if cur:
        cur[1].extend(pending)
        out_.append(cur)
    return out_


def list_items(section_lines):
    """Éléments `  - ` d'une section liste (commentaires précédents rattachés)."""
    items, cur, pending = [], None, []
    for l in section_lines[1:]:
        if l.startswith("  - "):
            if cur:
                items.append(cur)
            cur = pending + [l]
            pending = []
        elif not l.strip() or l.lstrip().startswith("#"):
            pending.append(l)
        else:
            cur += pending + [l]
            pending = []
    if cur:
        items.append(cur + pending)
    return items


def item_id(item):
    m = re.search(r"\bid:\s*([A-Za-z0-9_]+)", "\n".join(item))
    return m.group(1) if m else None


def strip_header(text):
    """Retire l'en-tête de commentaires d'un fichier de la phase 1."""
    lines = text.split("\n")
    i = 0
    while i < len(lines) and (lines[i].startswith("#") or not lines[i].strip()):
        i += 1
    return "\n".join(lines[i:]).rstrip("\n") + "\n"


def write(rel, header, body):
    p = out / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(header.rstrip("\n") + "\n\n" + body.rstrip("\n") + "\n")
    print(f"{rel} : {p.read_text().count(chr(10))} lignes")


# --- polices
fonts = list_items([l for l in strip_header((B / "communs/haplan-display-communs.yaml").read_text()).split("\n")])
by_id = {item_id(i): i for i in fonts}
assert set(by_id) == {"font_icons", "font_nav", "font_sensor", "font_clim_title", "font_clim_text", "font_clim_value"}, by_id.keys()
font_block = lambda ids: "font:\n" + "\n".join(l for i in ids for l in by_id[i])

# --- base matérielle : ancienne base sans wifi + font_nav
base_text = (B / "bases/sunton-8048s070c.yaml").read_text()
blocks = top_blocks(strip_header(base_text))
names = [n for n, _ in blocks]
assert "wifi" in names and "font" not in names, names
base_body = "\n".join(l for n, ls in blocks if n != "wifi" for l in ls).rstrip("\n") + "\n\n" + font_block(["font_nav"])
write("bibliotheque/materiels/sunton-8048s070c/base.yaml",
      "# Matériel : Sunton ESP32-8048S070C (ESP32-S3, flash 16 Mo, écran RVB 800x480, tactile GT911, rétroéclairage GPIO2).\n"
      "# Comprend la couche LVGL commune (veille du rétroéclairage, flèches de navigation + leur police font_nav).\n"
      "# Le wifi est un élément à part (wifi-simple ou wifi-multi-ap). Reclassé le 13/10/2026 depuis bases/ (phase 1).",
      base_body)
write("bibliotheque/elements/polices-plans/element.yaml",
      "# Élément : polices des pages de plans (icônes Font Awesome font_icons, valeurs des capteurs font_sensor).", font_block(["font_icons", "font_sensor"]))
write("bibliotheque/elements/polices-climatisation/element.yaml",
      "# Élément : polices des pages de climatisation et de thermostats (font_clim_title, font_clim_text, font_clim_value).",
      font_block(["font_clim_title", "font_clim_text", "font_clim_value"]))

# --- pages inchangées
pages = [("original", "page-plan-original", "page de plan « original »"),
         ("rez-de-chauss-e", "page-plan-rez-de-chaussee", "page de plan « Rez de chaussée »"),
         ("premier", "page-plan-premier", "page de plan « Premier »"),
         ("energie-direct", "page-energie-direct", "page « énergie en direct »"),
         ("ballons-chauffe", "page-ballons-chauffe", "page « chauffe des ballons »"),
         ("thermostats", "page-thermostats", "page « thermostats »")]
for old, new, label in pages:
    write(f"bibliotheque/elements/{new}/element.yaml",
          f"# Élément : {label} de l'écran (LVGL 800x480), avec les capteurs HA, images et polices qu'elle seule utilise.\n"
          f"# Reclassé le 13/10/2026 depuis pages/{old}.yaml (phase 1).", strip_header((B / f"pages/{old}.yaml").read_text()))

# --- page de climatisation paramétrable
VALEURS = {
    "salle": {"clim_id": "salle", "clim_entite": "climate.153931629788358_climate", "clim_rang": "Climatisation 1/3",
              "clim_titre": "Salle", "clim_pas": "0.5", "clim_max": "30.0", "clim_mode_auto": "auto"},
    "bureau": {"clim_id": "bureau", "clim_entite": "climate.bureau_climatiseur", "clim_rang": "Climatisation 2/3",
               "clim_titre": "Bureau", "clim_pas": "1.0", "clim_max": "32.0", "clim_mode_auto": "heat_cool"},
    "ami": {"clim_id": "ami", "clim_entite": "climate.chambre_d_ami_climatiseur", "clim_rang": "Climatisation 3/3",
            "clim_titre": "Chambre d'ami", "clim_pas": "1.0", "clim_max": "32.0", "clim_mode_auto": "heat_cool"},
}
salle = strip_header((B / "pages/clim-salle.yaml").read_text())
REMPL = [  # (texte d'origine de la page « salle », gabarit)
    ("climate.153931629788358_climate", "${clim_entite}"),
    ("clim_salle", "clim_${clim_id}"),
    ('text: "Climatisation 1/3"', 'text: "${clim_rang}"'),
    ('text: "Salle"', 'text: "${clim_titre}"'),
    ("t = t - 0.5f;", "t = t - ${clim_pas}f;"),
    ("t = t + 0.5f;", "t = t + ${clim_pas}f;"),
    ("if (t > 30.0f) t = 30.0f;", "if (t > ${clim_max}f) t = ${clim_max}f;"),
    ('{"cool", "heat", "auto", "dry", "fan_only"}', '{"cool", "heat", "${clim_mode_auto}", "dry", "fan_only"}'),
]
gabarit = salle
for avant, apres in REMPL:
    assert avant in gabarit, avant
    gabarit = gabarit.replace(avant, apres)
assert "salle" not in gabarit.lower().replace("${clim_id}", ""), "reste « salle »"
# Contrôle : le gabarit ré-instancié redonne EXACTEMENT chaque page d'origine.
for nom, vals in VALEURS.items():
    inst = gabarit
    for k, v in vals.items():
        inst = inst.replace("${" + k + "}", v)
    origine = strip_header((B / f"pages/clim-{nom}.yaml").read_text())
    if inst != origine:
        import difflib
        print("\n".join(list(difflib.unified_diff(origine.split("\n"), inst.split("\n"), lineterm=""))[:20]))
        raise SystemExit(f"gabarit ≠ page clim-{nom}")
    print(f"page clim-{nom} : ré-instanciation exacte")
write("bibliotheque/elements/page-climatisation/element.yaml",
      "# Élément PARAMÉTRABLE : page de climatisation (LVGL 800x480) pour UNE entité climate. Remplace les trois copies\n"
      "# clim-salle / clim-bureau / clim-ami de la phase 1 (vérifié : la ré-instanciation redonne chacune à l'identique).\n"
      "# Variables (packages: <nom>: !include { file: …, vars: {…} }) :\n"
      "#   clim_id        suffixe des identifiants LVGL/capteurs (unique par instance) : salle, bureau, ami…\n"
      "#   clim_entite    entité HA climate (ex. climate.bureau_climatiseur)\n"
      "#   clim_rang      libellé du bandeau (ex. « Climatisation 2/3 »)\n"
      "#   clim_titre     titre affiché (ex. « Bureau »)\n"
      "#   clim_pas       pas des boutons -/+ en °C (ex. 0.5 ou 1.0)\n"
      "#   clim_max       consigne maximale en °C (ex. 30.0)\n"
      "#   clim_mode_auto nom du mode automatique de l'appareil (auto ou heat_cool)\n"
      "# Exige : écran 800x480, élément polices-climatisation.", gabarit)

# --- appareil haplan-display
scr = (src / "screens/haplan-display.yaml").read_text()
head = scr[:re.search(r"^packages:", scr, re.M).start()].rstrip("\n")  # début de LIGNE (le mot figure aussi dans un commentaire)
head = head.replace("# ⭐ 12/10/2026 — écran ASSEMBLÉ depuis la bibliothèque espdisplay",
                    "# ⭐ 13/10/2026 — reclassé en matériel + éléments (materiels/, elements/) ; 12/10/2026 — écran ASSEMBLÉ depuis la bibliothèque espdisplay")
pk = ["packages:",
      "  materiel: !include bibliotheque/materiels/sunton-8048s070c/base.yaml",
      "  wifi: !include bibliotheque/elements/wifi-simple/element.yaml",
      "  polices_plans: !include bibliotheque/elements/polices-plans/element.yaml",
      "  polices_climatisation: !include bibliotheque/elements/polices-climatisation/element.yaml",
      "  page_original: !include bibliotheque/elements/page-plan-original/element.yaml",
      "  page_rez_de_chaussee: !include bibliotheque/elements/page-plan-rez-de-chaussee/element.yaml",
      "  page_premier: !include bibliotheque/elements/page-plan-premier/element.yaml",
      "  page_energie_direct: !include bibliotheque/elements/page-energie-direct/element.yaml",
      "  page_ballons_chauffe: !include bibliotheque/elements/page-ballons-chauffe/element.yaml",
      "  page_thermostats: !include bibliotheque/elements/page-thermostats/element.yaml"]
for nom, vals in VALEURS.items():
    pk += [f"  page_clim_{nom}: !include",
           "    file: bibliotheque/elements/page-climatisation/element.yaml",
           "    vars:"] + [f"      {k}: \"{v}\"" for k, v in vals.items()]
p = out / "appareils/haplan-display.yaml"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(head + "\n\n" + "\n".join(pk) + "\n")
print("appareils/haplan-display.yaml : appareil")
