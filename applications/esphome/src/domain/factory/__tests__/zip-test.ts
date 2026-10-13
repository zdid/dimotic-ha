import * as zlib from 'node:zlib';

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fabrique une archive zip (méthodes stocké / deflate) pour les tests. */
export function faireZip(fichiers: Record<string, string | Buffer>, options: { deflate?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const centraux: Buffer[] = [];
  let pos = 0;
  for (const [nom, c] of Object.entries(fichiers)) {
    const contenu = Buffer.isBuffer(c) ? c : Buffer.from(c);
    const comp = options.deflate ? zlib.deflateRawSync(contenu) : contenu;
    const methode = options.deflate ? 8 : 0;
    const nomB = Buffer.from(nom);
    const crc = crc32(contenu);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(methode, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(contenu.length, 22); local.writeUInt16LE(nomB.length, 26);
    parts.push(local, nomB, comp);
    const centr = Buffer.alloc(46);
    centr.writeUInt32LE(0x02014b50, 0); centr.writeUInt16LE(20, 4); centr.writeUInt16LE(20, 6); centr.writeUInt16LE(methode, 10);
    centr.writeUInt32LE(crc, 16); centr.writeUInt32LE(comp.length, 20); centr.writeUInt32LE(contenu.length, 24); centr.writeUInt16LE(nomB.length, 28);
    centr.writeUInt32LE(pos, 42);
    centraux.push(centr, nomB);
    pos += 30 + nomB.length + comp.length;
  }
  const central = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(Object.keys(fichiers).length, 8); fin.writeUInt16LE(Object.keys(fichiers).length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...parts, central, fin]);
}
