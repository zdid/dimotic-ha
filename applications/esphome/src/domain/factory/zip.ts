/**
 * Lecture d'une archive zip en mémoire, sans dépendance (modes « stocké » et « deflate », ni zip64 ni chiffrement).
 * Sert à lire les paquets de l'assembleur (fonctionnelles-esphome_specs §4bis). Refuse les chemins qui sortent du
 * dossier de destination (`..`, chemin absolu, lettre de lecteur) : une archive est une donnée non fiable.
 */

import * as zlib from 'node:zlib';

export interface EntreeZip {
  chemin: string;
  contenu: Buffer;
}

const SIG_FIN = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipInvalide extends Error {}

/** Chemin d'entrée acceptable : relatif, sans `..`, sans segment vide ni caché de premier niveau problématique. */
export function cheminSur(chemin: string): boolean {
  if (!chemin || chemin.startsWith('/') || chemin.includes('\\') || /^[a-zA-Z]:/.test(chemin) || chemin.includes('\0')) return false;
  return chemin.split('/').every((s, i, tous) => s !== '..' && s !== '.' && (s !== '' || i === tous.length - 1));
}

export function lireZip(zip: Buffer, tailleMax = 200 * 1024 * 1024): EntreeZip[] {
  let fin = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === SIG_FIN) { fin = i; break; }
  }
  if (fin < 0) throw new ZipInvalide('fin d\'archive introuvable');
  const nombre = zip.readUInt16LE(fin + 10);
  let p = zip.readUInt32LE(fin + 16);
  const entrees: EntreeZip[] = [];
  let total = 0;
  for (let n = 0; n < nombre; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipInvalide('répertoire central corrompu');
    const flags = zip.readUInt16LE(p + 8);
    const methode = zip.readUInt16LE(p + 10);
    const tailleComp = zip.readUInt32LE(p + 20);
    const tailleOrig = zip.readUInt32LE(p + 24);
    const lNom = zip.readUInt16LE(p + 28);
    const lExtra = zip.readUInt16LE(p + 30);
    const lCom = zip.readUInt16LE(p + 32);
    const posLocal = zip.readUInt32LE(p + 42);
    const chemin = zip.toString('utf8', p + 46, p + 46 + lNom);
    p += 46 + lNom + lExtra + lCom;

    if (flags & 1) throw new ZipInvalide(`entrée chiffrée non prise en charge : ${chemin}`);
    if (chemin.endsWith('/')) continue; // dossier
    if (!cheminSur(chemin)) throw new ZipInvalide(`chemin dangereux refusé : ${chemin}`);
    total += tailleOrig;
    if (total > tailleMax) throw new ZipInvalide('archive trop volumineuse');

    if (posLocal + 30 > zip.length || zip.readUInt32LE(posLocal) !== SIG_LOCAL) throw new ZipInvalide(`entrée locale corrompue : ${chemin}`);
    const debut = posLocal + 30 + zip.readUInt16LE(posLocal + 26) + zip.readUInt16LE(posLocal + 28);
    const brut = zip.subarray(debut, debut + tailleComp);
    let contenu: Buffer;
    if (methode === 0) contenu = Buffer.from(brut);
    else if (methode === 8) contenu = zlib.inflateRawSync(brut, { maxOutputLength: tailleMax });
    else throw new ZipInvalide(`méthode de compression ${methode} non prise en charge : ${chemin}`);
    if (contenu.length !== tailleOrig) throw new ZipInvalide(`taille inattendue : ${chemin}`);
    entrees.push({ chemin, contenu });
  }
  return entrees;
}
