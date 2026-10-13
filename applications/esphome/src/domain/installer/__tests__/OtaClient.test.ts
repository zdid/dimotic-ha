import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { televerserOta, OtaError } from '../OtaClient';

/** Faux ESP : côté appareil du protocole OTA d'ESPHome (ota_esphome.cpp), configurable pour provoquer chaque cas. */
interface Reglages { version?: 1 | 2; compression?: boolean; motDePasse?: string; algo?: 'sha256' | 'md5'; tailleMax?: number; md5Faux?: boolean; erreurFlash?: boolean; magicAttendu?: boolean }
let serveur: net.Server | null = null;
afterEach(() => new Promise<void>((r) => (serveur ? serveur.close(() => r()) : r())));

function fauxEsp(r: Reglages = {}): Promise<{ port: number; recu: () => Buffer | null; evenements: string[] }> {
  const version = r.version ?? 2;
  const evenements: string[] = [];
  let recu: Buffer | null = null;
  serveur = net.createServer((s) => {
    let tampon = Buffer.alloc(0);
    let attente: { n: number; ok: (b: Buffer) => void } | null = null;
    s.on('data', (b) => { tampon = Buffer.concat([tampon, b]); if (attente && tampon.length >= attente.n) { const a = attente; attente = null; const o = tampon.subarray(0, a.n); tampon = tampon.subarray(a.n); a.ok(o); } });
    s.on('error', () => undefined);
    const lire = (n: number) => new Promise<Buffer>((ok) => { if (tampon.length >= n) { const o = tampon.subarray(0, n); tampon = tampon.subarray(n); ok(o); } else attente = { n, ok }; });
    (async () => {
      const magic = await lire(5);
      if (!magic.equals(Buffer.from([0x6c, 0x26, 0xf7, 0x5c, 0x45]))) { s.end(Buffer.from([0x80])); return; }
      s.write(Buffer.from([0x00, version]));
      const fonctions = (await lire(1))[0];
      const compresse = (fonctions & 1) !== 0 && !!r.compression;
      s.write(Buffer.from([compresse ? 0x46 : 0x40]));
      if (r.motDePasse !== undefined) {
        const algo = r.algo ?? 'sha256';
        const nonce = crypto.createHash(algo).update('nonce' + Math.random()).digest('hex');
        s.write(Buffer.concat([Buffer.from([algo === 'sha256' ? 0x02 : 0x01]), Buffer.from(nonce)]));
        const cnonce = (await lire(nonce.length)).toString();
        const reponse = (await lire(nonce.length)).toString();
        const attendu = crypto.createHash(algo).update(r.motDePasse).update(nonce).update(cnonce).digest('hex');
        if (reponse !== attendu) { evenements.push('auth refusée'); s.end(Buffer.from([0x82])); return; }
        s.write(Buffer.from([0x41]));
      } else s.write(Buffer.from([0x41]));
      const taille = (await lire(4)).readUInt32BE();
      if (r.tailleMax !== undefined && taille > r.tailleMax) { s.end(Buffer.from([0x89])); return; }
      s.write(Buffer.from([0x42]));
      const md5 = (await lire(32)).toString();
      s.write(Buffer.from([0x43]));
      const morceaux: Buffer[] = [];
      let total = 0;
      while (total < taille) {
        const n = Math.min(8192, taille - total);
        morceaux.push(await lire(n)); total += n;
        if (version >= 2) s.write(Buffer.from([0x47]));
      }
      const charge = Buffer.concat(morceaux);
      if (r.md5Faux || crypto.createHash('md5').update(charge).digest('hex') !== md5) { s.end(Buffer.from([0x8b])); return; }
      if (r.erreurFlash) { s.end(Buffer.from([0x83])); return; }
      recu = compresse ? zlib.gunzipSync(charge) : charge;
      evenements.push(compresse ? 'compressé' : 'brut');
      s.write(Buffer.from([0x44])); s.write(Buffer.from([0x45]));
      await lire(1);
      evenements.push('fin');
      s.end();
    })().catch(() => s.destroy());
  });
  return new Promise((ok) => serveur!.listen(0, '127.0.0.1', () => ok({ port: (serveur!.address() as net.AddressInfo).port, recu: () => recu, evenements })));
}

const firmware = crypto.randomBytes(30_000);
const envoyer = (port: number, extra: Record<string, unknown> = {}) => televerserOta({ hote: '127.0.0.1', port, firmware, delaiMs: 3000, ...extra });

describe('OtaClient (protocole OTA d\'ESPHome)', () => {
  it('version 2, sans mot de passe, sans compression : le firmware arrive intact', async () => {
    const e = await fauxEsp();
    const progres: number[] = [];
    const r = await envoyer(e.port, { surProgres: (o: number) => progres.push(o) });
    expect(r).toEqual({ versionProtocole: 2, compresse: false, octetsEnvoyes: 30_000 });
    await new Promise((r) => setTimeout(r, 50)); // l'ESP lit l'octet de fin juste après le retour du client
    expect(e.recu()!.equals(firmware)).toBe(true);
    expect(e.evenements).toEqual(['brut', 'fin']);
    expect(progres.at(-1)).toBe(30_000);
  });

  it('compression annoncée par l\'ESP : le firmware est envoyé compressé et décompressé à l\'arrivée', async () => {
    const e = await fauxEsp({ compression: true });
    const compressible = Buffer.alloc(50_000, 9);
    const r = await televerserOta({ hote: '127.0.0.1', port: e.port, firmware: compressible, delaiMs: 3000 });
    expect(r.compresse).toBe(true);
    expect(r.octetsEnvoyes).toBeLessThan(1000);
    expect(e.recu()!.equals(compressible)).toBe(true);
  });

  it('version 1 (sans accusé par bloc)', async () => {
    const e = await fauxEsp({ version: 1 });
    expect((await envoyer(e.port)).versionProtocole).toBe(1);
    expect(e.recu()!.equals(firmware)).toBe(true);
  });

  it('authentification SHA256 et MD5 avec le bon mot de passe', async () => {
    for (const algo of ['sha256', 'md5'] as const) {
      const e = await fauxEsp({ motDePasse: 'secret-ota', algo });
      await envoyer(e.port, { motDePasse: 'secret-ota' });
      expect(e.recu()!.equals(firmware), algo).toBe(true);
      await new Promise<void>((r) => serveur!.close(() => r())); serveur = null;
    }
  });

  it('mauvais mot de passe : message clair ; mot de passe absent : refus avant d\'envoyer', async () => {
    let e = await fauxEsp({ motDePasse: 'bon' });
    await expect(envoyer(e.port, { motDePasse: 'mauvais' })).rejects.toThrow(/mot de passe OTA est-il correct/);
    await new Promise<void>((r) => serveur!.close(() => r())); serveur = null;
    e = await fauxEsp({ motDePasse: 'bon' });
    await expect(envoyer(e.port)).rejects.toThrow(/aucun n'est configuré/);
  });

  it('partition trop petite, écriture flash en échec, MD5 : erreurs lisibles', async () => {
    let e = await fauxEsp({ tailleMax: 1000 });
    await expect(envoyer(e.port)).rejects.toThrow(/partition de mise à jour de l'ESP32 est trop petite/);
    await new Promise<void>((r) => serveur!.close(() => r())); serveur = null;
    e = await fauxEsp({ erreurFlash: true });
    await expect(envoyer(e.port)).rejects.toThrow(/écriture du firmware en flash a échoué/);
    await new Promise<void>((r) => serveur!.close(() => r())); serveur = null;
    e = await fauxEsp({ md5Faux: true });
    await expect(envoyer(e.port)).rejects.toThrow(/MD5/);
  });

  it('ESP injoignable ou qui coupe : OtaError, jamais de blocage', async () => {
    const libre = await new Promise<number>((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
    await expect(envoyer(libre)).rejects.toThrow(OtaError);
    serveur = net.createServer((s) => { s.once('data', () => s.destroy()); });
    const port = await new Promise<number>((ok) => serveur!.listen(0, '127.0.0.1', () => ok((serveur!.address() as net.AddressInfo).port)));
    await expect(envoyer(port)).rejects.toThrow(/fermée/);
  });
});
