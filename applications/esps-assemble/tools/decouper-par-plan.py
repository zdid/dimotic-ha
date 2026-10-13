#!/usr/bin/env python3
"""Découpe fidèlement un fichier ESPHome en morceaux de bibliothèque selon un PLAN (JSON), sans réinterpréter le YAML.

Découpage textuel (commentaires et mise en forme conservés) :
- chaque section de premier niveau (`esp32:`, `wifi:`…) va entière dans un morceau ;
- une section peut être PARTAGÉE par sous-clés (`wifi:` → id/ssid… dans la base, on_connect… dans l'élément) :
  ESPHome refusionne les dictionnaires des `packages:` ;
- les commentaires qui précèdent une section ou une sous-clé la suivent.

Plan (JSON) : {
  "sorties": {"<nom>": {"fichier": "chemin relatif au dossier de sortie", "entete": "texte"}},
  "sections": {"<section>": "<nom de sortie>"},                       # section entière
  "partagees": {"<section>": {"<sous-clé>": "<nom de sortie>" | "-" (laissée à l'appareil), "*": "<défaut>"}},
  "remplacements": [{"sortie": "<nom>", "avant": "...", "apres": "..."}],
  "appareils": [{"fichier": "...", "entete": "...", "substitutions": {...}, "packages": {"<clé>": "<chemin>"}}]
}
Toute section ou sous-clé non prévue par le plan arrête l'outil (rien n'est perdu en silence).

Usage : decouper-par-plan.py <source.yaml> <plan.json> <dossier de sortie>
"""
import json
import re
import sys
from pathlib import Path

src, plan_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
plan = json.loads(plan_path.read_text())
lines = src.read_text().split("\n")
TOP = re.compile(r"^([a-z_0-9]+):")
SUB = re.compile(r"^  ([a-z_0-9]+):")


def blocks(seq, pattern, start=0):
    """[(nom, [lignes])] : chaque bloc commence à sa clé ; les commentaires/vides qui précèdent une clé lui sont rattachés."""
    out, pending, cur = [], [], None
    for l in seq[start:]:
        m = pattern.match(l)
        if m:
            if cur is not None:
                out.append(cur)
            cur = (m.group(1), pending + [l])
            pending = []
        elif not l.strip() or l.lstrip().startswith("#"):
            pending.append(l)
        else:
            if cur is None:
                raise SystemExit(f"ligne hors bloc : {l!r}")
            cur[1].extend(pending + [l])
            pending = []
    if cur is not None:
        cur[1].extend(pending)
        out.append(cur)
    return out, pending


chunks = {name: [] for name in plan["sorties"]}
top, trailing = blocks(lines, TOP)
for name, body in top:
    if name in plan["sections"]:
        chunks[plan["sections"][name]].extend(body)
    elif name in plan["partagees"]:
        rule = plan["partagees"][name]
        head_idx = next(i for i, l in enumerate(body) if TOP.match(l))
        pre, header, rest = body[:head_idx], body[head_idx], body[head_idx + 1:]
        subs, _ = blocks(rest, SUB)
        per_out = {}
        for sk, sbody in subs:
            dest = rule.get(sk, rule.get("*"))
            if dest == "-":
                continue  # fourni par le fichier de l'appareil (ex. device_name)
            if dest is None:
                raise SystemExit(f"sous-clé {name}.{sk} non prévue par le plan")
            per_out.setdefault(dest, []).extend(sbody)
        for i, (dest, sbody) in enumerate(per_out.items()):
            chunks[dest].extend((pre if i == 0 else []) + [header] + sbody)
    else:
        raise SystemExit(f"section {name!r} non prévue par le plan")

out_dir.mkdir(parents=True, exist_ok=True)
for name, spec in plan["sorties"].items():
    text = spec.get("entete", "").rstrip("\n") + "\n\n" + "\n".join(chunks[name]).strip("\n") + "\n"
    for r in plan.get("remplacements", []):
        if r["sortie"] == name:
            if r["avant"] not in text:
                raise SystemExit(f"remplacement introuvable dans {name} : {r['avant']!r}")
            text = text.replace(r["avant"], r["apres"], 1)
    p = out_dir / spec["fichier"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    print(f"{spec['fichier']} : {text.count(chr(10))} lignes")

for app in plan.get("appareils", []):
    body = [app.get("entete", "").rstrip("\n"), "", "substitutions:"]
    body += [f"  {k}: {v}" for k, v in app["substitutions"].items()]
    body += ["", "packages:"] + [f"  {k}: !include {v}" for k, v in app["packages"].items()]
    p = out_dir / app["fichier"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(body) + "\n")
    print(f"{app['fichier']} : appareil")
