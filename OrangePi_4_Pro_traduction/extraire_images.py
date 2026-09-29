#!/usr/bin/env python3
"""Extrait toutes les images d'un document Draw (.odg) et les remplace, dans leur cadre (même page,
même position, même taille), par une étiquette [IMG-0001]. Les numéros de page ne bougent pas (pages
fixes dans Draw). Produit :
  - <nom>_sans_images.odg   : le document à traduire
  - images/                 : les fichiers d'image d'origine (noms inchangés)
  - correspondance.csv      : étiquette ; page ; fichier ; largeur ; hauteur ; x ; y
Usage : python3 extraire_images.py document.odg
"""
import csv, os, re, shutil, sys, zipfile

src = sys.argv[1]
base = os.path.splitext(os.path.basename(src))[0]
out = f'{base}_sans_images.odg'
zin = zipfile.ZipFile(src)
content = zin.read('content.xml').decode('utf8')
manifest = zin.read('META-INF/manifest.xml').decode('utf8')

os.makedirs('images', exist_ok=True)
rows, n = [], 0
page = 0
FRAME = re.compile(r'(<draw:page [^>]*>)|(<draw:frame )([^>]*)(>)\s*<draw:image [^>]*xlink:href="([^"]+)"[^>]*>(.*?)</draw:image>', re.S)

def repl(m):
    global n, page
    if m.group(1):
        page += 1
        return m.group(1)
    n += 1
    tag = f'IMG-{n:04d}'
    attrs, href = m.group(3), m.group(5)
    g = lambda a: (re.search(fr'{a}="([^"]*)"', attrs) or [None, ''])[1]
    rows.append([tag, page, os.path.basename(href), g('svg:width'), g('svg:height'), g('svg:x'), g('svg:y')])
    # draw:name porte l'étiquette (réinsertion fiable même si le texte de l'étiquette est traduit/abîmé)
    attrs = re.sub(r'\s*draw:name="[^"]*"', '', attrs) + f' draw:name="{tag}"'
    return f'{m.group(2)}{attrs}{m.group(4)}<draw:text-box><text:p>[{tag}]</text:p></draw:text-box>'

new_content = FRAME.sub(repl, content)
assert '<draw:image ' not in new_content, 'image restante'

used = {r[2] for r in rows}
for name in zin.namelist():
    if name.startswith('Pictures/') and os.path.basename(name) in used:
        with zin.open(name) as f, open(os.path.join('images', os.path.basename(name)), 'wb') as g:
            shutil.copyfileobj(f, g)
new_manifest = re.sub(r'\s*<manifest:file-entry [^>]*manifest:full-path="Pictures/[^"]*"[^>]*/>', '', manifest)

with zipfile.ZipFile(out, 'w') as zout:
    zout.writestr(zipfile.ZipInfo('mimetype'), zin.read('mimetype'), compress_type=zipfile.ZIP_STORED)
    for item in zin.infolist():
        if item.filename in ('mimetype',) or item.filename.startswith('Pictures/'):
            continue
        data = zin.read(item.filename)
        if item.filename == 'content.xml': data = new_content.encode('utf8')
        if item.filename == 'META-INF/manifest.xml': data = new_manifest.encode('utf8')
        zout.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)

with open('correspondance.csv', 'w', newline='', encoding='utf8') as f:
    w = csv.writer(f, delimiter=';')
    w.writerow(['etiquette', 'page', 'fichier', 'largeur', 'hauteur', 'x', 'y'])
    w.writerows(rows)
print(f'{n} images remplacées sur {page} pages ; {len(used)} fichiers dans images/ ; document : {out}')
