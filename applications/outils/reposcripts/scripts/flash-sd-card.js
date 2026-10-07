#!/usr/bin/env node
/**
 * flash-sd-card.js — prépare ET écrit une carte SD/clé USB Raspberry Pi OS à partir d'un profil YAML
 * (fonctionnelles-outils_specs v1.2 §7.2). Un seul déroulé, toutes les questions posées au départ
 * (dans le script Outils qui génère le profil) :
 *
 *   1. Résout et télécharge l'image officielle (catalogue Raspberry Pi Imager) du modèle de Pi et de
 *      la distribution demandés, vérifie son SHA256.
 *   2. IMAGE DE BASE (commune à toutes les machines de même modèle/distribution/paquets/apps),
 *      gardée en CACHE : agrandie puis complétée DANS l'image, via chroot + QEMU sur CETTE machine
 *      (prepare-sd-card.sh base) — paquets, Node.js, Docker CE, dimotic-ha, apps, SSH root — puis
 *      nettoyée (clés d'hôte SSH, machine-id, état cloud-init) pour pouvoir être clonée.
 *   3. IMAGE DE LA MACHINE (quelques secondes) : copie de la base + personnalisation propre à la
 *      machine :
 *        - trixie-lite (cloud-init) : user-data (nom, utilisateur, mot de passe chiffré, clés SSH),
 *          network-config (WiFi), meta-data (identifiant unique) sur bootfs ;
 *        - bookworm-lite (pas de cloud-init) : fichier ssh + userconf.txt sur bootfs, nom d'hôte,
 *          clés et WiFi dans rootfs (prepare-sd-card.sh legacy-machine).
 *   4. CHOIX DE LA CARTE (liste des amovibles) — « q » pour s'arrêter là : l'image reste prête ;
 *      relancer avec la même machine et le même profil reprend directement à ce choix.
 *   5. Écriture (dd). L'agrandissement à la taille de la carte se fait au premier démarrage du Pi.
 *
 * ⭐ 07/10/2026 — fail2ban + durcissement SSH (comme stfort) : fail2ban (backend systemd, 5 essais/10 min, 12 h) installé dans
 * l'image de base ; SSH : root par clé seulement, mot de passe refusé sauf pour l'utilisateur du profil (champs `sshHardening`
 * oui/non, `fail2banIgnoreIp` = adresses jamais bannies).
 *
 * Usage : sudo node flash-sd-card.js <profil.yaml>
 *
 * ⭐ 26/09/2026 — refonte (demande utilisateur) : remplace les deux phases --prepare/--flash
 * (18/09/2026) où tout le lourd se faisait sur la carte physique après écriture. Ancienne version :
 * backups/applications/outils/reposcripts/scripts/flash-sd-card_backup_2026-09-26_refonte-carte-sd.js
 *
 * Prérequis : sudo apt install qemu-user-static binfmt-support parted e2fsprogs xz-utils file
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { spawnSync } = require('child_process');
const yaml = require(path.join(__dirname, '..', 'node_modules', 'js-yaml'));

const REPO_ROOT = path.join(__dirname, '..');
// Fichiers embarqués (clé dimotic-ha, compose.deploy.yaml, device-agents) : à la racine de l'archive
// auto-extractible (cas normal, via Outils), ou à la racine du dépôt en lancement direct depuis un
// clone (scripts/ est alors applications/outils/reposcripts/scripts/).
const BUNDLE_ROOT = fs.existsSync(path.join(REPO_ROOT, 'compose.deploy.yaml')) ? REPO_ROOT : path.join(__dirname, '..', '..', '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, 'data', '.sd-card-image-cache');
const BASE_DIR = path.join(CACHE_DIR, 'base');
const PREPARED_DIR = path.join(CACHE_DIR, 'prepared');
const CATALOG_URL = 'https://downloads.raspberrypi.org/os_list_imagingutility_v3.json';
const PREPARE_SH = path.join(__dirname, 'prepare-sd-card.sh');
/** Place ajoutée à l'image de base avant les installations (image officielle : ~370 Mo libres). */
const BASE_EXTRA_MB = 2048;
/** À incrémenter quand ce que contient l'image de base change (invalide le cache). */
const BASE_RECIPE_VERSION = 2; // 2 : fail2ban + durcissement SSH dans l'image (07/10/2026)

function machineSlug(machine) {
  return String(machine).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}
const preparedImagePath = (machine) => path.join(PREPARED_DIR, `${machineSlug(machine)}.img`);
const preparedProfilePath = (machine) => path.join(PREPARED_DIR, `${machineSlug(machine)}.profile.json`);

// ⭐ 05/09/2026, bug réel — sous sudo, HOME=/root : "~" des clés personnelles doit être résolu vers
// l'utilisateur réel (le script Outils le fait déjà en bash avant sudo ; repli ici pour la CLI).
function realUserHome() {
  const sudoUid = process.env.SUDO_UID ? Number(process.env.SUDO_UID) : undefined;
  if (sudoUid !== undefined) {
    try { return os.userInfo({ uid: sudoUid }).homedir; } catch (e) { /* repli ci-dessous */ }
  }
  if (process.env.SUDO_USER) {
    const r = spawnSync('getent', ['passwd', process.env.SUDO_USER], { encoding: 'utf8' });
    const home = (r.stdout || '').trim().split(':')[5];
    if (home) return home;
  }
  return process.env.HOME || os.homedir();
}

/** distribution (profil) -> nom exact au catalogue officiel, selon 32/64 bits. */
const DISTRO_NAME_BY_BITS = {
  'bookworm-lite': { 32: 'Raspberry Pi OS (Legacy, 32-bit) Lite', 64: 'Raspberry Pi OS (Legacy, 64-bit) Lite' },
  'trixie-lite': { 32: 'Raspberry Pi OS Lite (32-bit)', 64: 'Raspberry Pi OS Lite (64-bit)' }
};

// ⭐ 18/09/2026 — slugs du catalogue ; 64 bits pour tout modèle qui le supporte (demande utilisateur).
const PI_MODEL_TO_DEVICE = {
  'Raspberry Pi 1': { device: 'pi1', bits: 32 },
  'Raspberry Pi Zero': { device: 'pi1', bits: 32 },
  'Raspberry Pi Zero W': { device: 'pi1', bits: 32 },
  'Raspberry Pi Zero 2 W': { device: 'pi3', bits: 64 },
  'Raspberry Pi 2': { device: 'pi2', bits: 32 },
  'Raspberry Pi 3': { device: 'pi3', bits: 64 },
  'Raspberry Pi 4': { device: 'pi4', bits: 64 },
  'Raspberry Pi 400': { device: 'pi4', bits: 64 },
  'Raspberry Pi 5': { device: 'pi5', bits: 64 },
  'Raspberry Pi 500': { device: 'pi5', bits: 64 }
};

// ⭐ 07/10/2026 — Orange Pi : images officielles Debian bookworm (dérivées d'Armbian), téléchargées À LA MAIN par l'utilisateur
// (orangepi.org : liens Google Drive/Baidu, non automatisables) et fournies par le champ `image` du profil (.7z, .img.xz ou .img).
// Structure commune vérifiée sur Orangepi4pro 1.0.6 et Orangepizero2 3.1.0 : UNE partition (racine, /boot dedans), U-Boot avant
// la partition, utilisateur `orangepi` par défaut, assistant de premier lancement `/root/.not_logged_in_yet`, NetworkManager.
const ORANGEPI_MODELS = { 'Orange Pi Zero 2': 'orangepizero2', 'Orange Pi 4 Pro': 'orangepi4pro' };
const isOrangePi = (profile) => Object.prototype.hasOwnProperty.call(ORANGEPI_MODELS, profile.piModel);
const modelBits = (profile) => (isOrangePi(profile) ? 64 : PI_MODEL_TO_DEVICE[profile.piModel].bits);
/** Préfixe des images de base en cache (une seule gardée par préfixe) — le modèle d'Orange Pi en fait partie. */
const basePrefix = (profile) => (isOrangePi(profile)
  ? `orangepi-${ORANGEPI_MODELS[profile.piModel]}-64bit-`
  : `${profile.distro}-${modelBits(profile)}bit-`);

/** Apps dont l'agent est pré-installé dans l'image (voir prepare-sd-card.sh) -> device-agent. */
const APP_AGENT_DIRS = { teleinfo: path.join(BUNDLE_ROOT, 'applications', 'teleinfo', 'device-agent') };

function log(msg) { console.log(`[flash-sd-card] ${msg}`); }
// ⭐ 07/10/2026 — échec pendant la construction d'une image : on la GARDE (« .echec ») pour la consulter, et on affiche les
// commandes qui ouvrent un terminal dedans (chroot + qemu), en local ou par SSH (cas d'Outils : script lancé à distance).
function keepFailedImage(partial, layout, what, code) {
  const kept = partial.replace(/\.partial$/, '') + '.echec';
  try { fs.rmSync(kept, { force: true }); fs.renameSync(partial, kept); } catch (e) { fail(`${what} échouée (code ${code}) ; image non conservée : ${e.message}`); }
  const lay = layout ? ` --layout ${layout}` : '';
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.error(`\n[flash-sd-card] ${what} échouée (code ${code}).`);
  console.error(`[flash-sd-card] Image CONSERVÉE pour consultation : ${kept}`);
  console.error('[flash-sd-card] Terminal dans l\'image (émulation qemu, « exit » pour sortir ; à lancer depuis un vrai terminal) :');
  console.error(`    sudo bash ${PREPARE_SH} shell ${kept}${lay}`);
  if (ips.length) console.error(`  depuis un autre poste, par SSH :\n    ssh -t root@${ips[0]} "bash ${PREPARE_SH} shell ${kept}${lay}"`);
  console.error('[flash-sd-card] L\'image est supprimée au prochain essai ; à effacer à la main sinon (≈ 5 Go).');
  process.exit(1);
}

function fail(msg) { console.error(`[flash-sd-card] ERREUR: ${msg}`); process.exit(1); }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) fail(`Commande échouée (${result.status}): ${cmd} ${args.join(' ')}`);
  return result;
}

function runCapture(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) fail(`Commande échouée (${result.status}): ${cmd} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** Durées par étape (⭐ 05/09/2026, demande utilisateur : savoir quelle étape optimiser). */
const durations = [];
async function timedStep(label, fn) {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  durations.push({ label, ms });
  log(`⏱  ${label} : ${formatDuration(ms)}`);
  return result;
}
function printDurations() {
  log('--- Récapitulatif des durées ---');
  for (const { label, ms } of durations) log(`  ${label} : ${formatDuration(ms)}`);
  log(`  TOTAL (hors choix de la carte) : ${formatDuration(durations.reduce((t, d) => t + d.ms, 0))}`);
}

// ==========================================================================
// 1. Profil
// ==========================================================================

function loadProfile(profilePath) {
  if (!fs.existsSync(profilePath)) fail(`Profil introuvable: ${profilePath}`);
  const profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};
  for (const field of ['machine', 'piModel', 'distro', 'hostname', 'user', 'password']) {
    if (!profile[field]) fail(`Champ requis manquant dans le profil: ${field}`);
  }
  const home = realUserHome();
  profile.personalSshKeys = (profile.personalSshKeys || []).filter(Boolean).map((p) => String(p).replace(/^~/, home));
  profile.packages = (profile.packages || []).filter(Boolean).map(String);
  profile.apps = (profile.apps || []).filter(Boolean).map(String);
  // WiFi optionnel : SSID vide = pas de WiFi (Ethernet). Pays FR par défaut (régulateur radio —
  // sans pays défini, le WiFi peut rester bloqué).
  if (!profile.wifi || !profile.wifi.ssid) delete profile.wifi;
  else profile.wifi.country = profile.wifi.country || 'FR';
  for (const app of profile.apps) {
    if (!APP_AGENT_DIRS[app]) fail(`App inconnue: ${app} (câblées : ${Object.keys(APP_AGENT_DIRS).join(', ')})`);
  }
  if (isOrangePi(profile)) {
    if (!profile.image) fail(`Orange Pi : le champ "image" est obligatoire (chemin de l'archive .7z, .img.xz ou .img téléchargée sur orangepi.org).`);
    profile.image = String(profile.image).replace(/^~/, home);
    profile.distro = 'orangepi-bookworm';   // seule distribution : celle de l'image fournie
    if (profile.apps.length) fail('Orange Pi : les apps pré-installées (agents, console série) ne sont pas gérées sur ce type d\'image.');
  }
  // ⭐ 07/10/2026 — durcissement SSH + fail2ban (comme stfort) : activé par défaut. « oui »/« non », ou booléen.
  profile.sshHardening = !['non', 'no', 'false', '0'].includes(String(profile.sshHardening ?? 'oui').trim().toLowerCase());
  // Adresses jamais bannies par fail2ban (127.0.0.1 et ::1 toujours ajoutées) : séparées par espaces ou virgules.
  profile.fail2banIgnoreIp = String(Array.isArray(profile.fail2banIgnoreIp) ? profile.fail2banIgnoreIp.join(' ') : (profile.fail2banIgnoreIp || ''))
    .split(/[\s,]+/).filter(Boolean);
  return profile;
}

function readPersonalKeys(profile) {
  const keys = [];
  for (const p of profile.personalSshKeys) {
    if (fs.existsSync(p)) keys.push(fs.readFileSync(p, 'utf8').trim());
    else log(`Clé personnelle introuvable, ignorée : ${p}`);
  }
  return keys;
}

// ==========================================================================
// 2. Catalogue + téléchargement
// ==========================================================================

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpGetJson(res.headers.location)); return; }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur ${url}`)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function flattenCatalog(osList) {
  const out = [];
  const walk = (items) => { for (const it of items) { if (it.url) out.push(it); if (it.subitems) walk(it.subitems); } };
  walk(osList);
  return out;
}

/** Image Orange Pi fournie à la main : décompressée si besoin dans le cache, empreinte lue dans le fichier `.sha` d'Orange Pi. */
function resolveOrangePiImage(profile) {
  const src = profile.image;
  if (!fs.existsSync(src)) fail(`Image Orange Pi introuvable : ${src}`);
  const baseName = path.basename(src);
  let imgPath;
  if (/\.7z$/i.test(src)) {
    const outDir = path.join(CACHE_DIR, 'orangepi', baseName.replace(/\.7z$/i, ''));
    fs.mkdirSync(outDir, { recursive: true });
    let img = fs.readdirSync(outDir).find((n) => n.endsWith('.img'));
    if (!img) {
      log(`Décompression (7z) : ${baseName} — plusieurs minutes pour une image de plusieurs Go...`);
      run('7z', ['x', '-y', `-o${outDir}`, src]);
      img = fs.readdirSync(outDir).find((n) => n.endsWith('.img'));
      if (!img) fail(`Aucun fichier .img dans ${src}`);
    } else {
      log(`Image déjà décompressée en cache : ${path.join(outDir, img)}`);
    }
    imgPath = path.join(outDir, img);
  } else if (/\.img\.xz$/i.test(src)) {
    imgPath = path.join(CACHE_DIR, 'orangepi', baseName.replace(/\.xz$/i, ''));
    fs.mkdirSync(path.dirname(imgPath), { recursive: true });
    if (!fs.existsSync(imgPath)) { log('Décompression (xz)...'); run('xz', ['-dkc', '-T0', src], { stdio: ['ignore', fs.openSync(imgPath, 'w'), 'inherit'] }); }
  } else if (/\.img$/i.test(src)) {
    imgPath = src;
  } else {
    fail(`Image Orange Pi : extension non gérée (.7z, .img.xz ou .img attendus) : ${src}`);
  }
  // Empreinte attendue : fichier `<image>.img.sha` livré par Orange Pi (« <sha256> *<nom> »), à côté de l'image extraite ou de l'archive.
  let expected = null;
  for (const shaPath of [`${imgPath}.sha`, `${src}.sha`]) {
    if (fs.existsSync(shaPath)) { expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase(); break; }
  }
  log(`Image Orange Pi : ${path.basename(imgPath)} (${profile.piModel}, premier démarrage Orange Pi)${expected ? '' : ' — pas de fichier .sha : empreinte calculée, non vérifiée'}`);
  return { name: baseName, release_date: '', firstBoot: 'orangepi', localImage: imgPath, extract_sha256: expected };
}

async function resolveImageEntry(profile) {
  if (isOrangePi(profile)) return resolveOrangePiImage(profile);
  const modelInfo = PI_MODEL_TO_DEVICE[profile.piModel];
  if (!modelInfo) fail(`Modèle de Pi inconnu: "${profile.piModel}" (attendu: ${Object.keys(PI_MODEL_TO_DEVICE).join(', ')})`);
  const deviceSlug = `${modelInfo.device}-${modelInfo.bits}bit`;
  const namesByBits = DISTRO_NAME_BY_BITS[profile.distro];
  if (!namesByBits) fail(`Distribution inconnue: ${profile.distro} (attendu: ${Object.keys(DISTRO_NAME_BY_BITS).join(', ')})`);
  const wantedName = namesByBits[modelInfo.bits];

  log(`Catalogue officiel Raspberry Pi Imager : ${CATALOG_URL}`);
  const catalog = await httpGetJson(CATALOG_URL);
  const entry = flattenCatalog(catalog.os_list).find((it) => it.name === wantedName && Array.isArray(it.devices) && it.devices.includes(deviceSlug));
  if (!entry) fail(`Aucune image "${wantedName}" compatible avec ${profile.piModel} (${deviceSlug}) au catalogue.`);

  // Deux mécanismes de premier démarrage gérés : "systemd" (bookworm : fichier ssh + userconf.txt)
  // et "cloudinit-rpi" (trixie : user-data/network-config/meta-data). Tout autre : refus explicite.
  if (entry.init_format === 'cloudinit-rpi') entry.firstBoot = 'cloudinit';
  else if (!entry.init_format || entry.init_format === 'systemd') entry.firstBoot = 'legacy';
  else fail(`Image "${entry.name}" : init_format="${entry.init_format}" non géré.`);

  log(`Image résolue : ${entry.name} (${entry.release_date}, premier démarrage ${entry.firstBoot === 'cloudinit' ? 'cloud-init' : 'classique'}) — ${(entry.image_download_size / 1e6).toFixed(0)} Mo compressés`);
  return entry;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doGet(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur ${u}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        // ⭐ 26/09/2026 (demande utilisateur) : une ligne de progression tous les 250 blocs reçus
        // seulement — un bloc par ligne donnait ~29 000 messages pour 529 Mo, que la page Outils
        // mettait très longtemps à afficher (elle semblait figée sur « Décompression »).
        let chunks = 0;
        const progress = () => process.stdout.write(`\r  Téléchargement... ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} Mo (${((received / total) * 100).toFixed(0)}%)  `);
        const tmpPath = `${destPath}.partial`;
        const file = fs.createWriteStream(tmpPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          chunks++;
          if (total && chunks % 250 === 0) progress();
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (total) progress();
          process.stdout.write('\n');
          fs.renameSync(tmpPath, destPath);
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

async function ensureImageDownloaded(entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (entry.localImage) {   // Orange Pi : image locale, pas de téléchargement — seulement la vérification de l'empreinte
    log('Vérification SHA256 de l\'image...');
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => { fs.createReadStream(entry.localImage).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject); });
    const actual = h.digest('hex');
    if (entry.extract_sha256 && actual !== entry.extract_sha256) {
      fail(`SHA256 invalide pour ${entry.localImage}\n  attendu : ${entry.extract_sha256}\n  obtenu  : ${actual}\nImage corrompue ou incomplète : la retélécharger.`);
    }
    log(entry.extract_sha256 ? 'SHA256 vérifié OK (conforme au fichier .sha d\'Orange Pi).' : 'SHA256 calculé (pas de fichier .sha : non vérifié).');
    entry.extract_sha256 = actual;
    return entry.localImage;
  }
  const compressedPath = path.join(CACHE_DIR, path.basename(new URL(entry.url).pathname));
  const imgPath = compressedPath.replace(/\.xz$/, '');
  if (fs.existsSync(imgPath)) {
    log(`Image officielle déjà en cache : ${imgPath}`);
  } else {
    if (!fs.existsSync(compressedPath)) {
      log(`Téléchargement : ${entry.url}`);
      await downloadFile(entry.url, compressedPath);
    } else {
      log(`Archive déjà en cache : ${compressedPath}`);
    }
    log('Décompression (xz)...');
    run('xz', ['-dk', '-T0', compressedPath]);
  }
  log('Vérification SHA256 de l\'image décompressée...');
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(imgPath).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual !== entry.extract_sha256) {
    fail(`SHA256 invalide pour ${imgPath}\n  attendu : ${entry.extract_sha256}\n  obtenu  : ${actual}\nSupprimer le fichier et relancer pour retélécharger.`);
  }
  log('SHA256 vérifié OK.');
  return imgPath;
}

// ==========================================================================
// 3. Image de base (cache)
// ==========================================================================

function fileHash(p) {
  return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent';
}

/** Signature d'un répertoire (chemins + tailles + dates) — pour invalider le cache si un agent change. */
function dirSignature(dir) {
  if (!fs.existsSync(dir)) return 'absent';
  const parts = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === 'node_modules') continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else parts.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Tout ce qui détermine le contenu de l'image de base : même clé = même image, réutilisable. */
function baseKey(entry, profile) {
  const desc = {
    recipe: BASE_RECIPE_VERSION,
    image: entry.extract_sha256,
    packages: [...profile.packages].sort(),
    apps: [...profile.apps].sort(),
    dimoticKey: fileHash(path.join(BUNDLE_ROOT, 'data', 'core', 'machine_ssh', 'id_ed25519.pub')),
    compose: fileHash(path.join(BUNDLE_ROOT, 'compose.deploy.yaml')),
    sshHardening: profile.sshHardening,
    prepareScript: fileHash(PREPARE_SH),
    agents: Object.fromEntries(profile.apps.map((a) => [a, dirSignature(APP_AGENT_DIRS[a])]))
  };
  return crypto.createHash('sha256').update(JSON.stringify(desc)).digest('hex').slice(0, 12);
}

/** Copie creuse (les zones vides de l'image ne prennent pas de place sur le disque). */
function sparseCopy(src, dest) {
  run('cp', ['--sparse=always', src, dest]);
}

async function ensureBaseImage(entry, profile, officialImg) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const key = baseKey(entry, profile);
  const basePath = path.join(BASE_DIR, `${basePrefix(profile)}${key}.img`);
  if (fs.existsSync(basePath)) {
    log(`Image de base déjà en cache (mêmes image/paquets/apps) : ${basePath}`);
    return basePath;
  }
  log(`Image de base à construire (${basePath}) — installations dans l'image via QEMU, plusieurs minutes...`);
  const partial = `${basePath}.partial`;
  fs.rmSync(partial, { force: true });
  sparseCopy(officialImg, partial);
  const args = [PREPARE_SH, 'base', partial, '--extra-mb', String(BASE_EXTRA_MB)];
  if (profile.packages.length) args.push('--packages', profile.packages.join(','));
  if (profile.apps.length) args.push('--apps', profile.apps.join(','));
  args.push('--ssh-hardening', profile.sshHardening ? 'yes' : 'no');
  if (isOrangePi(profile)) args.push('--layout', 'single');
  const r = spawnSync('bash', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    keepFailedImage(partial, isOrangePi(profile) ? 'single' : '', "Construction de l'image de base", r.status);
  }
  fs.rmSync(`${basePath}.echec`, { force: true });
  fs.renameSync(partial, basePath);
  log(`Image de base prête et gardée en cache : ${basePath}`);
  // Une seule image de base gardée par distribution/architecture (~5 Go chacune) : les anciennes
  // (autres paquets/apps, ou script modifié depuis) sont supprimées.
  const prefix = basePrefix(profile);
  for (const name of fs.readdirSync(BASE_DIR)) {
    if (name.startsWith(prefix) && name.endsWith('.img') && path.join(BASE_DIR, name) !== basePath) {
      fs.rmSync(path.join(BASE_DIR, name), { force: true });
      log(`Ancienne image de base supprimée : ${name}`);
    }
  }
  return basePath;
}

// ==========================================================================
// 4. Image de la machine
// ==========================================================================

function withBootfs(imgPath, fn) {
  const loopDev = runCapture('losetup', ['-fP', '--show', imgPath]).trim();
  const mountDir = fs.mkdtempSync('/tmp/flash-sd-card-boot-');
  try {
    run('mount', [`${loopDev}p1`, mountDir]);
    try { fn(mountDir); } finally { run('umount', [mountDir]); }
  } finally {
    fs.rmdirSync(mountDir);
    spawnSync('losetup', ['-d', loopDev]);
  }
}

function hashPassword(password) {
  // Même format que Raspberry Pi Imager (SHA-512 crypt) — jamais en clair sur la carte.
  return runCapture('openssl', ['passwd', '-6', password]).trim();
}

/** Fichiers cloud-init (trixie) — format vérifié sur l'image officielle 2026-09-15 : NoCloud lu
 *  depuis /boot/firmware, module raspberry_pi, création de l'utilisateur via userconf-pi. */
function cloudInitFiles(profile, personalKeys) {
  const user = {
    name: profile.user,
    passwd: hashPassword(profile.password),
    lock_passwd: false
  };
  if (personalKeys.length) user.ssh_authorized_keys = personalKeys;
  const userData = {
    hostname: profile.hostname,
    manage_etc_hosts: true,
    timezone: 'Europe/Paris',
    keyboard: { model: 'pc105', layout: 'fr' },
    // Accès root par clé : la clé dimotic-ha est déjà dans l'image de base ; ne pas laisser
    // cloud-init « désactiver root ».
    disable_root: false,
    users: [user]
  };
  const writeFiles = [];
  if (personalKeys.length) {
    writeFiles.push({
      path: '/root/.ssh/authorized_keys',
      append: true,
      permissions: '0600',
      content: `${personalKeys.join('\n')}\n`
    });
  }
  if (profile.sshHardening) {
    // Durcissement SSH : l'image de base interdit déjà le mot de passe (drop-in 50-durcissement.conf) ; seul l'utilisateur du
    // profil le garde (bloc Match en FIN de sshd_config, comme stfort). `ssh_pwauth` n'est volontairement PAS écrit : cloud-init
    // ajouterait sa ligne PasswordAuthentication après le bloc Match, donc dans sa portée, et couperait le mot de passe de
    // cet utilisateur.
    writeFiles.push({
      path: '/etc/ssh/sshd_config',
      append: true,
      content: `\n# Durcissement (Outils dimotic-ha) : l'utilisateur ${profile.user} garde le mot de passe.\nMatch User ${profile.user}\n    PasswordAuthentication yes\n`
    });
  } else {
    userData.ssh_pwauth = true;
  }
  if (profile.fail2banIgnoreIp.length) {
    writeFiles.push({
      path: '/etc/fail2ban/jail.d/zz-ignoreip.local',
      permissions: '0644',
      content: `[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 ${profile.fail2banIgnoreIp.join(' ')}\n`
    });
  }
  if (writeFiles.length) userData.write_files = writeFiles;
  const instanceId = `${machineSlug(profile.machine)}-${Date.now()}`;
  const files = {
    'user-data': `#cloud-config\n# Généré par Outils (dimotic-ha) — machine "${profile.machine}".\n${yaml.dump(userData, { lineWidth: -1 })}`,
    'meta-data': yaml.dump({
      dsmode: 'local',
      // Identifiant unique : cloud-init considère chaque machine comme neuve et fait tout son travail.
      'instance-id': instanceId,
      instance_id: instanceId
    })
  };
  if (profile.wifi) {
    files['network-config'] = yaml.dump({
      network: {
        version: 2,
        wifis: {
          wlan0: {
            dhcp4: true,
            optional: true,
            'regulatory-domain': profile.wifi.country,
            'access-points': { [profile.wifi.ssid]: profile.wifi.password ? { password: String(profile.wifi.password) } : {} }
          }
        }
      }
    }, { lineWidth: -1 });
  }
  return files;
}

async function buildMachineImage(entry, profile, basePath) {
  fs.mkdirSync(PREPARED_DIR, { recursive: true });
  const outPath = preparedImagePath(profile.machine);
  const partial = `${outPath}.partial`;
  fs.rmSync(partial, { force: true });
  log(`Copie de l'image de base pour "${profile.machine}"...`);
  sparseCopy(basePath, partial);
  const personalKeys = readPersonalKeys(profile);

  if (entry.firstBoot === 'orangepi') {
    // Orange Pi : une seule partition, pas de bootfs ni de cloud-init — tout se fait dans l'image (utilisateur créé dans le chroot).
    const args = [PREPARE_SH, 'opi-machine', partial, '--layout', 'single', '--hostname', profile.hostname, '--user', profile.user,
      '--ssh-hardening', profile.sshHardening ? 'yes' : 'no'];
    for (const k of profile.personalSshKeys) args.push('--key', k);
    if (profile.fail2banIgnoreIp.length) args.push('--fail2ban-ignoreip', profile.fail2banIgnoreIp.join(' '));
    if (profile.wifi) {
      args.push('--wifi-ssid', profile.wifi.ssid);
      if (profile.wifi.password) args.push('--wifi-pass', String(profile.wifi.password));
    }
    // Le mot de passe haché passe par l'environnement (pas par la ligne de commande, visible dans `ps`).
    const r = spawnSync('bash', args, { stdio: 'inherit', env: { ...process.env, PASSWORD_HASH: hashPassword(profile.password) } });
    if (r.status !== 0) keepFailedImage(partial, 'single', 'Personnalisation de la machine (Orange Pi)', r.status);
  } else {
    withBootfs(partial, (boot) => {
      fs.writeFileSync(path.join(boot, 'ssh'), ''); // active SSH au premier démarrage (sshswitch)
      if (entry.firstBoot === 'cloudinit') {
        for (const [name, content] of Object.entries(cloudInitFiles(profile, personalKeys))) {
          fs.writeFileSync(path.join(boot, name), content);
        }
        log(`cloud-init écrit : user-data (nom "${profile.hostname}", utilisateur "${profile.user}", ${personalKeys.length} clé(s) perso), meta-data${profile.wifi ? `, network-config (WiFi "${profile.wifi.ssid}")` : ''}.`);
      } else {
        fs.writeFileSync(path.join(boot, 'userconf.txt'), `${profile.user}:${hashPassword(profile.password)}\n`);
        log(`bootfs : SSH activé, utilisateur "${profile.user}" (userconf.txt).`);
      }
    });

    if (entry.firstBoot === 'legacy') {
      const args = [PREPARE_SH, 'legacy-machine', partial, '--hostname', profile.hostname, '--user', profile.user,
        '--ssh-hardening', profile.sshHardening ? 'yes' : 'no'];
      if (profile.fail2banIgnoreIp.length) args.push('--fail2ban-ignoreip', profile.fail2banIgnoreIp.join(' '));
      for (const k of profile.personalSshKeys) args.push('--key', k);
      if (profile.wifi) {
        args.push('--wifi-ssid', profile.wifi.ssid, '--wifi-country', profile.wifi.country);
        if (profile.wifi.password) args.push('--wifi-pass', String(profile.wifi.password));
      }
      const r = spawnSync('bash', args, { stdio: 'inherit' });
      if (r.status !== 0) keepFailedImage(partial, '', 'Personnalisation de la machine', r.status);
    }

  }

  fs.renameSync(partial, outPath);
  return outPath;
}

/** Ce qui rend une image de machine réutilisable telle quelle à la relance (même profil, même base). */
function machineSignature(profile, basePath) {
  const { machine, piModel, distro, hostname, user, password, personalSshKeys, packages, apps, wifi, sshHardening, fail2banIgnoreIp } = profile;
  return JSON.stringify({ basePath, machine, piModel, distro, hostname, user, password, personalSshKeys, packages, apps, wifi: wifi || null, sshHardening, fail2banIgnoreIp });
}

// ==========================================================================
// 5. Choix de la carte + écriture
// ==========================================================================

function listRemovableDevices() {
  const { blockdevices } = JSON.parse(runCapture('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,RM,TRAN,MODEL,MOUNTPOINT']));
  // Taille 0 = lecteur sans carte ou pas encore prêt (⭐ 18/09/2026).
  return blockdevices.filter((d) => d.type === 'disk' && (d.rm === true || d.tran === 'usb') && Number(d.size) > 0);
}

/** Renvoie le périphérique choisi, ou null si l'utilisateur s'arrête là (« q » ou Entrée). */
async function pickDevice(imgPath) {
  const imgSize = fs.statSync(imgPath).size;
  for (;;) {
    const devices = listRemovableDevices();
    console.log(`\nImage prête : ${imgPath} (${(imgSize / 1e9).toFixed(1)} Go)`);
    if (devices.length === 0) {
      console.log('Aucune carte/clé détectée (lecteur vide ?).');
    } else {
      console.log('Périphériques amovibles détectés :');
      devices.forEach((d, i) => {
        const tooSmall = Number(d.size) < imgSize ? '  ⚠️ trop petit' : '';
        console.log(`  [${i}] /dev/${d.name} — ${(Number(d.size) / 1e9).toFixed(1)} Go — ${d.model || 'modèle inconnu'} (${d.tran || '?'})${tooSmall}`);
      });
    }
    const answer = (await ask('\nNuméro du périphérique à écrire, « r » pour relister, « q » (ou Entrée) pour s\'arrêter ici : ')).trim().toLowerCase();
    if (answer === '' || answer === 'q') return null;
    if (answer === 'r') continue;
    const idx = parseInt(answer, 10);
    if (Number.isNaN(idx) || !devices[idx]) { console.log('Sélection invalide.'); continue; }
    if (Number(devices[idx].size) < imgSize) { console.log('Ce périphérique est plus petit que l\'image.'); continue; }
    const device = `/dev/${devices[idx].name}`;
    console.log(`\n⚠️  TOUT le contenu de ${device} (${(Number(devices[idx].size) / 1e9).toFixed(1)} Go, ${devices[idx].model || '?'}) va être définitivement écrasé.`);
    const confirm = await ask(`Retape exactement "${device}" pour confirmer : `);
    if (confirm.trim() !== device) { console.log('Confirmation invalide — rien n\'a été écrit.'); continue; }
    return device;
  }
}

function flashImage(imgPath, device) {
  const { blockdevices } = JSON.parse(runCapture('lsblk', ['-J', '-o', 'NAME,MOUNTPOINT', device]));
  const collectMounts = (nodes) => nodes.flatMap((n) => [n.mountpoint, ...(n.children ? collectMounts(n.children) : [])]).filter(Boolean);
  for (const mp of collectMounts(blockdevices)) { log(`Démontage de ${mp}...`); spawnSync('umount', [mp]); }
  log(`Écriture de l'image sur ${device} (dd)...`);
  run('dd', [`if=${imgPath}`, `of=${device}`, 'bs=4M', 'status=progress', 'conv=fsync']);
  run('sync', []);
  spawnSync('partprobe', [device]);
  log('Écriture terminée.');
}

// ==========================================================================
// main
// ==========================================================================

async function main() {
  if (process.getuid && process.getuid() !== 0) fail('Ce script doit être lancé avec sudo (loop, montages, dd).');
  const profilePath = process.argv[2];
  if (!profilePath || profilePath.startsWith('--')) fail('Usage : sudo node flash-sd-card.js <profil.yaml>');

  const profile = loadProfile(profilePath);
  log(`Machine "${profile.machine}" — ${profile.piModel}, ${profile.distro}, nom "${profile.hostname}", utilisateur "${profile.user}"${profile.wifi ? `, WiFi "${profile.wifi.ssid}"` : ', sans WiFi'}`);

  const entry = await timedStep('Résolution du catalogue', () => resolveImageEntry(profile));
  const officialImg = await timedStep('Image officielle (téléchargement/décompression/SHA256)', () => ensureImageDownloaded(entry));
  const basePath = await timedStep('Image de base (installations dans l\'image, ou cache)', () => ensureBaseImage(entry, profile, officialImg));

  const imgPath = preparedImagePath(profile.machine);
  const sigPath = preparedProfilePath(profile.machine);
  const signature = machineSignature(profile, basePath);
  if (fs.existsSync(imgPath) && fs.existsSync(sigPath) && fs.readFileSync(sigPath, 'utf8') === signature) {
    log(`Image de "${profile.machine}" déjà prête avec ce même profil — reprise directe au choix de la carte.`);
  } else {
    await timedStep('Image de la machine (copie + personnalisation)', () => buildMachineImage(entry, profile, basePath));
    fs.writeFileSync(sigPath, signature, { mode: 0o600 });
    fs.chmodSync(sigPath, 0o600); // contient le mot de passe : root seulement, même si le fichier existait déjà
  }
  printDurations();

  const device = await pickDevice(imgPath);
  if (!device) {
    log(`Arrêt demandé — image prête : ${imgPath}`);
    log(`Pour l'écrire plus tard : relancer ce même script avec la même machine ("${profile.machine}") et les mêmes réponses — il reprendra directement au choix de la carte.`);
    return;
  }
  await timedStep('Écriture de l\'image (dd)', () => { flashImage(imgPath, device); });
  log(`Terminé — carte prête pour "${profile.machine}", à insérer dans le Pi.${entry.firstBoot === 'cloudinit' ? ' Premier démarrage un peu plus long (cloud-init) ; suivi : /var/log/cloud-init-output.log.' : ''}${entry.firstBoot === 'orangepi' ? ' Orange Pi : le système s\'agrandit seul à la taille de la carte au premier démarrage, et les clés SSH d\'hôte sont recréées.' : ''}`);
}

main().catch((err) => fail(err.stack || String(err)));
