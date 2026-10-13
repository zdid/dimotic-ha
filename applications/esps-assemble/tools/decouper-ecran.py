#!/usr/bin/env python3
"""Découpe un écran ESPHome monolithique (haplan-display.yaml) en éléments de bibliothèque (découpage textuel fidèle).

Usage : split_screen.py <écran.yaml> <dossier bibliothèque> <fichier écran produit>
"""
import re
import sys
from pathlib import Path

src, libdir, screen_out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
lines = src.read_text().split("\n")

# --- sections de premier niveau -----------------------------------------------------------------------------------
TOP = re.compile(r"^([a-z_0-9]+):")
starts = [(i, TOP.match(l).group(1)) for i, l in enumerate(lines) if TOP.match(l)]
sections = {}
for n, (i, name) in enumerate(starts):
    end = starts[n + 1][0] if n + 1 < len(starts) else len(lines)
    # les commentaires juste avant la section suivante appartiennent à celle-ci : on les rattache à la suivante
    j = end
    while j - 1 > i and (lines[j - 1].startswith("#") or not lines[j - 1].strip()):
        j -= 1
    sections[name] = (i, j, end)
header_end = starts[0][0]


def block(name):
    i, j, end = sections[name]
    # commentaires précédant la section (entre la fin utile de la précédente et son début)
    prev = [s for s in sections.values() if s[2] == i]
    pre_start = prev[0][1] if prev else header_end
    return lines[pre_start:i], lines[i:j]


def items(body):
    """Éléments d'une liste de premier niveau (`  - `), chacun avec ses commentaires qui le précèdent."""
    out, cur, pending = [], None, []
    for l in body[1:]:
        if l.startswith("  - "):
            if cur is not None:
                out.append(cur)
            cur = pending + [l]
            pending = []
        elif l.startswith("  #") or l.startswith("#") or not l.strip():
            pending.append(l)
        else:
            if cur is None:
                raise SystemExit(f"ligne hors élément : {l!r}")
            cur += pending + [l]
            pending = []
    if cur is not None:
        out.append(cur + pending)
    return out


ID = re.compile(r"\bid:\s*([A-Za-z0-9_]+)")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# --- lvgl : en-tête + pages -----------------------------------------------------------------------------------------
lv_pre, lv = block("lvgl")
p0 = next(k for k, l in enumerate(lv) if l == "  pages:")
lv_head, lv_pages = lv[:p0], lv[p0 + 1:]
pages, cur = [], None
for l in lv_pages:
    m = re.match(r"^    - id: (page_[A-Za-z0-9_]+)", l)
    if m:
        cur = {"id": m.group(1), "lines": [l]}
        pages.append(cur)
    else:
        if cur is None:
            raise SystemExit(f"ligne avant la première page : {l!r}")
        cur["lines"].append(l)
for p in pages:
    text = "\n".join(p["lines"])
    p["defs"] = set(ID.findall(text))
    p["words"] = set(WORD.findall(text))

# --- rattachement des éléments de liste aux pages -------------------------------------------------------------------
LIST_SECTIONS = ["image", "font", "text_sensor", "sensor"]
per_page = {p["id"]: {s: [] for s in LIST_SECTIONS} for p in pages}
common = {s: [] for s in LIST_SECTIONS}
section_pre = {}
report = []
head_words = set(WORD.findall("\n".join(lv_head)))
for s in LIST_SECTIONS:
    pre, body = block(s)
    section_pre[s] = pre
    for it in items(body):
        text = "\n".join(it)
        own = ID.findall(text)
        refs = set(WORD.findall(text))
        owners = [p["id"] for p in pages if (refs & p["defs"]) or (set(own) & p["words"])]
        used_by_head = bool(set(own) & head_words)
        if len(owners) == 1 and not used_by_head:
            per_page[owners[0]][s].append(it)
        else:
            common[s].append(it)
            report.append(f"{s} {own[:1]} -> commun ({', '.join(owners) or 'aucune page'}{', navigation' if used_by_head else ''})")

# --- écriture ---------------------------------------------------------------------------------------------------------
BASE_SECTIONS = ["esp32", "psram", "wifi", "ota", "logger", "i2c", "display", "output", "light", "touchscreen"]
SCREEN_SECTIONS = ["esphome", "api"]
known = set(BASE_SECTIONS + SCREEN_SECTIONS + LIST_SECTIONS + ["lvgl"])
unknown = [n for n in sections if n not in known]
if unknown:
    raise SystemExit(f"sections non prévues : {unknown}")

(libdir / "bases").mkdir(parents=True, exist_ok=True)
(libdir / "pages").mkdir(parents=True, exist_ok=True)
(libdir / "communs").mkdir(parents=True, exist_ok=True)


def write(path, chunks):
    text = "\n".join(chunks).rstrip("\n") + "\n"
    path.write_text(text)


base = ["# Base matérielle : carte Sunton ESP32-8048S070C (ESP32-S3, 800x480, tactile capacitif GT911).",
        "# Élément de bibliothèque espdisplay — extrait de haplan-display.yaml le 12/10/2026 (découpage fidèle).",
        "# Contient aussi la couche LVGL commune à tous les écrans de ce modèle (veille du rétroéclairage, flèches de",
        "# navigation entre pages) ; les pages viennent d'autres éléments de la bibliothèque.", ""]
for n in BASE_SECTIONS:
    pre, body = block(n)
    base += pre + body
base += lv_pre + lv_head
write(libdir / "bases" / "sunton-8048s070c.yaml", base)

com = ["# Éléments partagés par plusieurs pages (ou par la navigation) de l'écran haplan-display :",
       "# polices, images et capteurs HA utilisés à plusieurs endroits.", ""]
for s in LIST_SECTIONS:
    if common[s]:
        com += [f"{s}:"] + [l for it in common[s] for l in it]
write(libdir / "communs" / "haplan-display-communs.yaml", com)

page_files = []
for p in pages:
    name = p["id"][len("page_"):].replace("_", "-")
    fn = f"{name}.yaml"
    page_files.append((p["id"], fn))
    out = [f"# Page LVGL « {p['id']} » — élément de bibliothèque espdisplay (extrait de haplan-display.yaml le 12/10/2026).",
           "# Contient la page et les capteurs HA, images et polices qu'elle seule utilise.", ""]
    for s in LIST_SECTIONS:
        if per_page[p["id"]][s]:
            out += [f"{s}:"] + [l for it in per_page[p["id"]][s] for l in it]
    out += ["lvgl:", "  pages:"] + p["lines"]
    write(libdir / "pages" / fn, out)

scr = lines[:header_end]
for n in SCREEN_SECTIONS:
    pre, body = block(n)
    scr += pre + body
scr += ["",
        "# Assemblage : base matérielle, éléments communs, puis les pages dans l'ordre d'affichage.",
        "packages:",
        "  base: !include bibliotheque/bases/sunton-8048s070c.yaml",
        "  communs: !include bibliotheque/communs/haplan-display-communs.yaml"]
scr += [f"  {pid}: !include bibliotheque/pages/{fn}" for pid, fn in page_files]
write(screen_out, scr)

print(f"{len(pages)} pages : {', '.join(p['id'] for p in pages)}")
for s in LIST_SECTIONS:
    print(f"{s}: {sum(len(v[s]) for v in per_page.values())} dans les pages, {len(common[s])} communs")
print("\n".join(report[:40]))
