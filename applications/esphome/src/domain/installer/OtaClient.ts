/**
 * Client de mise à jour d'ESPHome (protocole OTA « esphome », versions 1 et 2) — port TypeScript de `esphome/espota2.py`
 * (ESPHome 2025.11.2), sans Python ni ESPHome sur la machine du poseur (fonctionnelles-esphome_specs §6.1 étape 3).
 *
 *   magic (5 octets) → [0x00, version] → fonctionnalités (compression, SHA256) → réponse → authentification éventuelle
 *   (défi-réponse : hash(mot de passe + nonce + cnonce)) → taille (4 octets) → MD5 de la charge → blocs de 8 Ko
 *   (v2 : un accusé par bloc) → « reçu » → « mise à jour terminée » → octet de fin.
 *
 * Le firmware est compressé (gzip niveau 9) quand l'appareil l'annonce.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as zlib from 'node:zlib';

export class OtaError extends Error {}

const R = {
  OK: 0x00, REQUEST_AUTH: 0x01, REQUEST_SHA256_AUTH: 0x02, HEADER_OK: 0x40, AUTH_OK: 0x41, UPDATE_PREPARE_OK: 0x42,
  BIN_MD5_OK: 0x43, RECEIVE_OK: 0x44, UPDATE_END_OK: 0x45, SUPPORTS_COMPRESSION: 0x46, CHUNK_OK: 0x47
} as const;

const MAGIC = Buffer.from([0x6c, 0x26, 0xf7, 0x5c, 0x45]);
const FEATURE_COMPRESSION = 0x01;
const FEATURE_SHA256_AUTH = 0x02;
const TAILLE_BLOC = 8192;

const ERREURS: Record<number, string> = {
  0x80: 'octet magique invalide',
  0x81: "impossible de préparer la mémoire flash pour la mise à jour (firmware trop gros ? redémarrer l'ESP)",
  0x82: 'authentification refusée : le mot de passe OTA est-il correct ?',
  0x83: "l'écriture du firmware en flash a échoué (voir les journaux USB)",
  0x84: 'la fin de la mise à jour a échoué (voir les journaux)',
  0x85: "appuyer sur le bouton reset de l'ESP : un redémarrage manuel est exigé à la première mise à jour après un flash USB",
  0x86: "l'ESP a été flashé avec une mauvaise taille de flash : choisir la bonne carte puis reflasher par USB",
  0x87: "l'ESP n'a pas la taille de flash demandée (mauvaise carte)",
  0x88: "pas assez de place sur l'ESP8266 pour le fichier de mise à jour",
  0x89: "la partition de mise à jour de l'ESP32 est trop petite : reflasher par USB (ESPHome doit la redimensionner)",
  0x8a: "la partition de mise à jour est introuvable : reflasher par USB",
  0x8b: 'somme MD5 de l\'application différente : recommencer ou reflasher par USB avec un bon câble',
  0xff: "erreur inconnue de l'ESP"
};

/** Lecteur à promesses sur une socket : `lire(n)` rend exactement n octets ou échoue (fermeture, délai, erreur). */
class Lecteur {
  private tampon = Buffer.alloc(0);
  private attente: { n: number; ok: (b: Buffer) => void; ko: (e: Error) => void } | null = null;
  private erreur: Error | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (b) => { this.tampon = Buffer.concat([this.tampon, b]); this.servir(); });
    socket.on('error', (e) => this.echouer(new OtaError(`connexion : ${e.message}`)));
    socket.on('close', () => this.echouer(new OtaError("connexion fermée par l'ESP")));
    socket.on('timeout', () => this.echouer(new OtaError("délai dépassé en attendant l'ESP")));
  }

  private echouer(e: Error): void {
    this.erreur ??= e;
    if (this.attente) { const a = this.attente; this.attente = null; a.ko(e); }
  }

  private servir(): void {
    if (this.attente && this.tampon.length >= this.attente.n) {
      const a = this.attente; this.attente = null;
      const out = this.tampon.subarray(0, a.n);
      this.tampon = this.tampon.subarray(a.n);
      a.ok(out);
    }
  }

  lire(n: number): Promise<Buffer> {
    return new Promise((ok, ko) => {
      if (this.tampon.length >= n) { const out = this.tampon.subarray(0, n); this.tampon = this.tampon.subarray(n); return ok(out); }
      if (this.erreur) return ko(this.erreur);
      this.attente = { n, ok, ko };
    });
  }

  ecrire(donnees: Buffer | string | number[]): Promise<void> {
    const b = typeof donnees === 'string' ? Buffer.from(donnees, 'utf8') : Buffer.from(donnees as Buffer);
    return new Promise((ok, ko) => this.socket.write(b, (e) => (e ? ko(new OtaError(`envoi : ${e.message}`)) : ok())));
  }
}

function attendu(octet: number, attendus: number[], contexte: string): void {
  if (attendus.length === 0 || attendus.includes(octet)) return;
  const msg = ERREURS[octet];
  throw new OtaError(msg ? `${contexte} : ${msg}` : `${contexte} : réponse inattendue de l'ESP (0x${octet.toString(16).padStart(2, '0')})`);
}

export interface OptionsOta {
  hote: string;
  port?: number;
  motDePasse?: string;
  firmware: Buffer;
  /** Délai d'inactivité de la connexion (30 s par défaut, comme ESPHome). */
  delaiMs?: number;
  surProgres?: (octetsEnvoyes: number, total: number) => void;
}

export interface ResultatOta {
  versionProtocole: number;
  compresse: boolean;
  octetsEnvoyes: number;
}

export async function televerserOta(o: OptionsOta): Promise<ResultatOta> {
  const socket = net.connect({ host: o.hote, port: o.port ?? 3232 });
  socket.setNoDelay(true);
  socket.setTimeout(o.delaiMs ?? 30_000);
  const lecteur = new Lecteur(socket);
  try {
    await new Promise<void>((ok, ko) => { socket.once('connect', ok); socket.once('error', (e) => ko(new OtaError(`connexion à ${o.hote}:${o.port ?? 3232} impossible : ${e.message}`))); });

    await lecteur.ecrire(MAGIC);
    const [premier, version] = [...(await lecteur.lire(2))];
    attendu(premier, [R.OK], 'version');
    if (version !== 1 && version !== 2) throw new OtaError(`version OTA ${version} de l'ESP non prise en charge (1 et 2 seulement)`);

    await lecteur.ecrire([FEATURE_COMPRESSION | FEATURE_SHA256_AUTH]);
    const fonctions = (await lecteur.lire(1))[0];
    const compresse = fonctions === R.SUPPORTS_COMPRESSION;
    const charge = compresse ? zlib.gzipSync(o.firmware, { level: 9 }) : o.firmware;

    const auth = (await lecteur.lire(1))[0];
    attendu(auth, [R.REQUEST_AUTH, R.REQUEST_SHA256_AUTH, R.AUTH_OK], 'authentification');
    if (auth !== R.AUTH_OK) {
      if (o.motDePasse === undefined || o.motDePasse === '') throw new OtaError("l'ESP demande un mot de passe OTA et aucun n'est configuré");
      const [algo, tailleNonce] = auth === R.REQUEST_SHA256_AUTH ? (['sha256', 64] as const) : (['md5', 32] as const);
      const nonce = (await lecteur.lire(tailleNonce)).toString('utf8');
      const cnonce = crypto.createHash(algo).update(String(Math.random())).digest('hex');
      await lecteur.ecrire(cnonce);
      const reponse = crypto.createHash(algo).update(o.motDePasse, 'utf8').update(nonce).update(cnonce).digest('hex');
      await lecteur.ecrire(reponse);
      attendu((await lecteur.lire(1))[0], [R.AUTH_OK], 'authentification');
    }

    const taille = Buffer.alloc(4);
    taille.writeUInt32BE(charge.length);
    await lecteur.ecrire(taille);
    attendu((await lecteur.lire(1))[0], [R.UPDATE_PREPARE_OK], 'taille du firmware');

    await lecteur.ecrire(crypto.createHash('md5').update(charge).digest('hex'));
    attendu((await lecteur.lire(1))[0], [R.BIN_MD5_OK], 'somme de contrôle');

    socket.setNoDelay(false);
    for (let pos = 0; pos < charge.length; pos += TAILLE_BLOC) {
      await lecteur.ecrire(charge.subarray(pos, pos + TAILLE_BLOC));
      if (version >= 2) attendu((await lecteur.lire(1))[0], [R.CHUNK_OK], 'bloc de données');
      o.surProgres?.(Math.min(pos + TAILLE_BLOC, charge.length), charge.length);
    }

    attendu((await lecteur.lire(1))[0], [R.RECEIVE_OK], 'réception');
    attendu((await lecteur.lire(1))[0], [R.UPDATE_END_OK], 'fin de la mise à jour');
    await lecteur.ecrire([R.OK]);
    return { versionProtocole: version, compresse, octetsEnvoyes: charge.length };
  } finally {
    socket.destroy();
  }
}
