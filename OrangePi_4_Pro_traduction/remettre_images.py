#!/usr/bin/env python3
"""Remet les images dans le document traduit, à la place des étiquettes [IMG-0001] (retrouvées par le
nom du cadre draw:name, posé à l'extraction — le texte de l'étiquette peut avoir été traduit ou abîmé).
Usage : python3 remettre_images.py document_traduit_sans_images.odg [document_final.odg]
Nécessite, dans le dossier courant : images/ et correspondance.csv (produits par extraire_images.py).
"""
import csv, mimetypes, os, re, sys, zipfile

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0].replace('_sans_images', '') + '_avec_images.odg'
rows = {r['etiquette']: r for r in csv.DictReader(open('correspondance.csv', encoding='utf8'), delimiter=';')}
zin = zipfile.ZipFile(src)
content = zin.read('content.xml').decode('utf8')
manifest = zin.read('META-INF/manifest.xml').decode('utf8')

found = set()
def repl(m):
    tag = m.group(2)
    r = rows.get(tag)
    if not r: return m.group(0)
    found.add(tag)
    href = f'Pictures/{r["fichier"]}'
    mime = mimetypes.guess_type(r['fichier'])[0] or 'image/png'
    return (f'{m.group(1)}<draw:image xlink:href="{href}" xlink:type="simple" xlink:show="embed" '
            f'xlink:actuate="onLoad" draw:mime-type="{mime}"><text:p/></draw:image></draw:frame>')
FRAME = re.compile(r'(<draw:frame [^>]*draw:name="(IMG-\d{4})"[^>]*>)\s*<draw:text-box>.*?</draw:text-box>\s*</draw:frame>', re.S)
content = FRAME.sub(repl, content)
missing = sorted(set(rows) - found)

files = sorted({rows[t]['fichier'] for t in found})
entries = ''.join(f'\n <manifest:file-entry manifest:full-path="Pictures/{f}" manifest:media-type="{mimetypes.guess_type(f)[0] or "image/png"}"/>' for f in files)
manifest = manifest.replace('</manifest:manifest>', entries + '\n</manifest:manifest>')

with zipfile.ZipFile(out, 'w') as zout:
    zout.writestr(zipfile.ZipInfo('mimetype'), zin.read('mimetype'), compress_type=zipfile.ZIP_STORED)
    for item in zin.infolist():
        if item.filename == 'mimetype': continue
        data = zin.read(item.filename)
        if item.filename == 'content.xml': data = content.encode('utf8')
        if item.filename == 'META-INF/manifest.xml': data = manifest.encode('utf8')
        zout.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)
    for f in files:
        zout.write(os.path.join('images', f), f'Pictures/{f}', compress_type=zipfile.ZIP_STORED)
print(f'{len(found)} images remises, {len(missing)} étiquette(s) introuvable(s){": " + ", ".join(missing[:20]) if missing else ""} ; document : {out}')
