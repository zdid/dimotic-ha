/** Écriture d'une archive zip en mémoire (méthode « deflate »), sans dépendance : paquets de l'assembleur. Entrées triées, dates fixes → paquet reproductible. */

import * as zlib from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00:00 en format DOS : datation fixe pour que deux assemblages identiques donnent le même zip.
const DOS_HEURE = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function ecrireZip(fichiers: { chemin: string; contenu: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const centraux: Buffer[] = [];
  let pos = 0;
  for (const f of [...fichiers].sort((a, b) => (a.chemin < b.chemin ? -1 : 1))) {
    const nom = Buffer.from(f.chemin, 'utf8');
    const comp = zlib.deflateRawSync(f.contenu, { level: 9 });
    const crc = crc32(f.contenu);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_HEURE, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.contenu.length, 22); local.writeUInt16LE(nom.length, 26);
    parts.push(local, nom, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_HEURE, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.contenu.length, 24); c.writeUInt16LE(nom.length, 28); c.writeUInt32LE(pos, 42);
    centraux.push(c, nom);
    pos += 30 + nom.length + comp.length;
  }
  const central = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(fichiers.length, 8); fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...parts, central, fin]);
}
