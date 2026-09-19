#!/usr/bin/env node
/**
 * flash-sd-card.js — orchestrateur complet de préparation d'une carte SD Raspberry Pi OS, à partir
 * d'un profil YAML (scripts/sd-card-profiles/*.yaml, voir teleinfo-rpi1.yaml pour un exemple) :
 *
 *   1. Résout et télécharge l'image officielle (catalogue Raspberry Pi Imager) correspondant au
 *      modèle de Pi + à la distribution demandés dans le profil.
 *   2. Vérifie son intégrité (SHA256 fourni par le catalogue, sur l'image DÉCOMPRESSÉE).
 *   3. Liste les périphériques amovibles (USB/SD uniquement — jamais les disques internes de cette
 *      machine, même filtre que Raspberry Pi Imager) pour que l'utilisateur choisisse.
 *   4. Écrit l'image sur le périphérique choisi (`dd`) — étape irréversible, confirmation
 *      renforcée obligatoire (retype du chemin exact).
 *   5. Personnalise utilisateur/mot de passe + active SSH sur `bootfs` (équivalent de l'option
 *      "Personnaliser" de Raspberry Pi Imager — mécanisme `userconf.txt`, PAS cloud-init : voir
 *      la vérification `init_format` ci-dessous, ce script refuse une image cloud-init plutôt que
 *      de deviner un format non testé).
 *   6. Enchaîne automatiquement sur prepare-sd-card.sh (déjà existant) pour l'agrandissement de
 *      rootfs, l'accès SSH root (clé dimotic-ha + clés perso du profil), l'installation des
 *      paquets apt, et — pour chaque app listée dans `apps` du profil — la copie de son
 *      device-agent et le `npm install --production` (compilation native incluse) DANS LE CHROOT,
 *      pas sur le Pi cible (voir TODO.md : jusqu'à plusieurs minutes et un risque de process
 *      orphelin sur un vrai RPi1 pour ce même npm install). Le vrai déploiement en ligne détecte
 *      alors que node_modules existe déjà et saute directement à l'écriture/démarrage du service.
 *      ⭐ 16/09/2026 — `profile.wifi.{ssid,password,country}` (optionnel) configure aussi le WiFi
 *      de la cible via ce même enchaînement (voir prepare-sd-card.sh, imager_custom set_wlan).
 *
 * Usage (tout en un, historique) : sudo node scripts/flash-sd-card.js <profil.yaml>
 *
 * ⭐ 18/09/2026, demande explicite — deux phases séparées, pour découpler le téléchargement/la
 * personnalisation (lents, indépendants du matériel) de l'écriture physique (rapide, dépend d'une
 * carte/clé insérée) :
 *   sudo node scripts/flash-sd-card.js --prepare <profil.yaml>
 *     Résout+télécharge+vérifie l'image, la personnalise (SSH + utilisateur) via un périphérique
 *     loop — AUCUN périphérique physique requis. Écrit l'image prête sous
 *     data/.sd-card-image-cache/prepared/<machine>.img (chemin déterministe, dérivé de
 *     profile.machine — la phase flash le retrouve sans rien à copier/coller).
 *   sudo node scripts/flash-sd-card.js --flash <profil.yaml> [--image <chemin>]
 *     Sélectionne le périphérique (carte/clé, liste des amovibles), écrit l'image déjà préparée
 *     (--image, ou le chemin déterministe ci-dessus si omis), puis enchaîne sur prepare-sd-card.sh
 *     (agrandissement, SSH root, paquets, apps, Docker CE + dimotic-ha — voir son en-tête).
 *
 * Nécessite root (montage/écriture sur périphérique bloc + rootfs) — mêmes prérequis que
 * prepare-sd-card.sh (qemu-user-static, binfmt-support, parted, e2fsprogs) plus `xz-utils`.
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
const CACHE_DIR = path.join(REPO_ROOT, 'data', '.sd-card-image-cache');
const PREPARED_DIR = path.join(CACHE_DIR, 'prepared');
const CATALOG_URL = 'https://downloads.raspberrypi.org/os_list_imagingutility_v3.json';

/** Chemin déterministe de l'image déjà préparée pour `machine` — dérivé du profil, pas d'argument
 *  à faire circuler entre les deux phases (--prepare puis --flash). */
function machineSlug(machine) {
  return String(machine).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}

function preparedImagePath(machine) {
  return path.join(PREPARED_DIR, `${machineSlug(machine)}.img`);
}

// ⭐ 18/09/2026, demande explicite ("il repose les mêmes questions, où est la limite entre les 2 ?")
// — la phase --prepare persiste ICI le profil COMPLET qu'elle a reçu, pour que --flash n'ait plus
// besoin de le redemander : la vraie limite entre les deux phases n'est pas "quelles infos", c'est
// "carte/clé physiquement branchée ou non" (voir en-tête du fichier). --flash n'a donc plus besoin
// que de `machine` (+ WiFi, jamais interrogé côté bootfs en phase 1, voir writeBootfsCustomization).
function preparedProfilePath(machine) {
  return path.join(PREPARED_DIR, `${machineSlug(machine)}.profile.json`);
}

// ⭐ 05/09/2026, bug réel corrigé en conditions réelles — ce script s'exécute via `sudo`, qui
// réinitialise HOME à celui de root (/root, sudoers "env_reset" + "always_set_home", réglage par
// défaut Debian/Ubuntu). `~/.ssh/id_rsa.pub` dans le profil se résolvait donc en
// `/root/.ssh/id_rsa.pub` (inexistant) — prepare-sd-card.sh l'ignorait silencieusement (juste un
// avertissement stderr, noyé dans le reste de la sortie), donc la clé personnelle n'était jamais
// copiée alors que tout semblait avoir réussi.
//
// ⭐ Premier correctif (SUDO_UID + os.userInfo) insuffisant en conditions réelles — retesté, la clé
// perso a de nouveau résolu vers /root/... : SUDO_UID n'était apparemment pas propagé dans ce
// contexte d'exécution précis (raison exacte non confirmée — invocation sudo différente ? shell
// racine déjà actif où `sudo` n'a rien à réinitialiser ?). Repli supplémentaire ajouté via
// SUDO_USER + `getent passwd` (indépendant de HOME et de SUDO_UID), et le résultat est maintenant
// logué explicitement pour ne plus avoir à deviner silencieusement la prochaine fois.
function realUserHome() {
  const sudoUid = process.env.SUDO_UID ? Number(process.env.SUDO_UID) : undefined;
  if (sudoUid !== undefined) {
    try { return os.userInfo({ uid: sudoUid }).homedir; } catch (e) {
      log(`realUserHome: os.userInfo({uid:${sudoUid}}) a échoué (${e.message}), repli sur SUDO_USER/getent.`);
    }
  }
  if (process.env.SUDO_USER) {
    try {
      const line = runCapture('getent', ['passwd', process.env.SUDO_USER]).trim();
      const home = line.split(':')[5];
      if (home) return home;
      log(`realUserHome: "getent passwd ${process.env.SUDO_USER}" n'a renvoyé aucun champ home, repli sur \$HOME.`);
    } catch (e) {
      log(`realUserHome: "getent passwd ${process.env.SUDO_USER}" a échoué (${e.message}), repli sur \$HOME.`);
    }
  }
  return process.env.HOME || os.homedir();
}

// ⭐ 05/09/2026 — mapping distro (profil YAML) -> nom exact dans le catalogue officiel. "bookworm-
// lite" pointe vers la piste "Legacy" du catalogue (le nom "Legacy" désigne juste la génération
// Debian précédente, PAS une limite d'architecture — vérifié en conditions réelles : le RPi1 de ce
// projet tourne déjà sur cette image précise, voir project_teleinfo_app). "trixie-lite" est la
// piste mainline actuelle, non testée sur ARMv6 par ce projet à ce jour.
const DISTRO_NAME_BY_BITS = {
  'bookworm-lite': { 32: 'Raspberry Pi OS (Legacy, 32-bit) Lite', 64: 'Raspberry Pi OS (Legacy, 64-bit) Lite' },
  'trixie-lite': { 32: 'Raspberry Pi OS Lite (32-bit)', 64: 'Raspberry Pi OS Lite (64-bit)' }
};

// ⭐ 18/09/2026, bug réel corrigé — profile.piModel (ex: "Raspberry Pi 3", valeurs du select PI_MODEL
// de l'app outils) n'a jamais correspondu aux slugs du catalogue officiel ("pi3-64bit" etc.),
// vérifiés en conditions réelles (https://downloads.raspberrypi.org/os_list_imagingutility_v3.json,
// device slugs existants : pi1-32bit, pi2-32bit, pi3-32bit, pi3-64bit, pi4-32bit, pi4-64bit,
// pi5-32bit, pi5-64bit — pas de slug séparé pour Zero/Zero W/Zero 2 W/400/500, qui partagent le
// SoC — donc le slug — d'un modèle "de base"). 64 bits pris par défaut pour tout modèle qui le
// supporte (demande explicite utilisateur : "si ce sont des pi3 ou 4 ou 5 ce sont des images 64
// bits qu'il faut prendre") — seuls Pi 1/Zero/Zero W/Pi 2 (ARMv6/v7 sans variante 64 bits au
// catalogue) restent en 32 bits.
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

function log(msg) { console.log(`[flash-sd-card] ${msg}`); }
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

// ==========================================================================
// 1. Profil
// ==========================================================================

/** Lecture brute, SANS validation des champs requis — voir normalizeProfile(). Séparé pour
 *  --flash (⭐ 18/09/2026) : un profil "léger" (juste `machine` + `wifi`) doit pouvoir être fusionné
 *  avec le profil complet persisté par --prepare AVANT d'exiger tous les champs. */
function parseProfileFile(profilePath) {
  if (!fs.existsSync(profilePath)) fail(`Profil introuvable: ${profilePath}`);
  const raw = fs.readFileSync(profilePath, 'utf8');
  return yaml.load(raw) || {};
}

/** Valide + normalise un profil déjà complet (fusionné si besoin, voir runFlashOnly). */
function normalizeProfile(profile) {
  for (const field of ['machine', 'piModel', 'distro', 'hostname', 'user', 'password']) {
    if (!profile[field]) fail(`Champ requis manquant dans le profil: ${field}`);
  }
  const home = realUserHome();
  log(`Résolution "~" pour les clés personnelles : ${home} (SUDO_UID=${process.env.SUDO_UID || '?'}, SUDO_USER=${process.env.SUDO_USER || '?'}, HOME=${process.env.HOME || '?'})`);
  profile.personalSshKeys = (profile.personalSshKeys || []).map((p) => p.replace(/^~/, home));
  profile.packages = profile.packages || [];
  profile.apps = profile.apps || [];
  // ⭐ 16/09/2026 — WiFi optionnel (voir prepare-sd-card.sh --wifi-ssid/--wifi-pass/--wifi-country) :
  // wifi.ssid seul suffit (réseau ouvert) ; country recommandé (régulateur radio, sinon le WiFi peut
  // rester bloqué tant qu'aucun pays n'a été défini) — pas déduit automatiquement du profil, à
  // renseigner explicitement.
  if (profile.wifi && !profile.wifi.ssid) fail('profile.wifi présent mais profile.wifi.ssid manquant.');
  return profile;
}

function loadProfile(profilePath) {
  return normalizeProfile(parseProfileFile(profilePath));
}

// ==========================================================================
// 2. Catalogue Raspberry Pi Imager -> résolution de l'image
// ==========================================================================

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGetJson(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur ${url}`)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function flattenCatalog(osList) {
  const out = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.url) out.push(it);
      if (it.subitems) walk(it.subitems);
    }
  };
  walk(osList);
  return out;
}

async function resolveImageEntry(profile) {
  const modelInfo = PI_MODEL_TO_DEVICE[profile.piModel];
  if (!modelInfo) fail(`Modèle de Pi inconnu: "${profile.piModel}" (attendu: ${Object.keys(PI_MODEL_TO_DEVICE).join(', ')})`);
  const deviceSlug = `${modelInfo.device}-${modelInfo.bits}bit`;

  const namesByBits = DISTRO_NAME_BY_BITS[profile.distro];
  if (!namesByBits) fail(`distro inconnue dans le profil: ${profile.distro} (attendu: ${Object.keys(DISTRO_NAME_BY_BITS).join(', ')})`);
  const wantedName = namesByBits[modelInfo.bits];

  log(`Catalogue officiel Raspberry Pi Imager : ${CATALOG_URL}`);
  const catalog = await httpGetJson(CATALOG_URL);
  const all = flattenCatalog(catalog.os_list);
  const entry = all.find((it) => it.name === wantedName && Array.isArray(it.devices) && it.devices.includes(deviceSlug));
  if (!entry) fail(`Aucune image "${wantedName}" compatible avec ${profile.piModel} (${deviceSlug}) trouvée dans le catalogue.`);

  // ⭐ Ce script ne gère que l'ancien mécanisme de personnalisation premier-boot (userconf.txt +
  // fichier "ssh" vide sur bootfs) — pas cloud-init (images plus récentes, "init_format":
  // "cloudinit-rpi"). Refuser explicitement plutôt que d'écrire des fichiers qu'un cloud-init
  // ignorerait silencieusement.
  if (entry.init_format && entry.init_format !== 'systemd') {
    fail(`Image "${entry.name}" utilise init_format="${entry.init_format}" (cloud-init) — non géré par ce script pour l'instant (voir l'en-tête). Personnalisation manuelle nécessaire après flashage.`);
  }

  log(`Image résolue : ${entry.name} (${entry.release_date}) — ${(entry.image_download_size / 1e6).toFixed(0)} Mo compressés`);
  return entry;
}

// ==========================================================================
// 3. Téléchargement + vérification
// ==========================================================================

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doGet(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur ${u}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) process.stdout.write(`\r  Téléchargement... ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} Mo (${((received / total) * 100).toFixed(0)}%)  `);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

async function ensureImageDownloaded(entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const compressedName = path.basename(new URL(entry.url).pathname);
  const compressedPath = path.join(CACHE_DIR, compressedName);
  const imgPath = compressedPath.replace(/\.xz$/, '');

  if (fs.existsSync(imgPath)) {
    log(`Image déjà présente en cache (décompressée) : ${imgPath}`);
  } else {
    if (!fs.existsSync(compressedPath)) {
      log(`Téléchargement : ${entry.url}`);
      await downloadFile(entry.url, compressedPath);
    } else {
      log(`Archive déjà en cache : ${compressedPath}`);
    }
    log('Décompression (xz)...');
    run('xz', ['-dk', compressedPath]);
  }

  log('Vérification SHA256 de l\'image décompressée...');
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(imgPath);
  await new Promise((resolve, reject) => {
    stream.on('data', (d) => hash.update(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual !== entry.extract_sha256) {
    fail(`SHA256 invalide pour ${imgPath}\n  attendu : ${entry.extract_sha256}\n  obtenu  : ${actual}\nSupprimer le fichier et relancer pour retélécharger.`);
  }
  log('SHA256 vérifié OK.');
  return imgPath;
}

// ==========================================================================
// 4. Sélection du périphérique (amovibles uniquement, comme Raspberry Pi Imager)
// ==========================================================================

function listRemovableDevices() {
  const out = runCapture('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,RM,TRAN,MODEL,MOUNTPOINT']);
  const { blockdevices } = JSON.parse(out);
  // ⭐ 18/09/2026, demande explicite — taille 0 = périphérique non prêt/mal détecté (lecteur de
  // carte sans carte insérée, énumération USB pas encore stabilisée...) : jamais un choix valide.
  return blockdevices.filter((d) => d.type === 'disk' && (d.rm === true || d.tran === 'usb') && Number(d.size) > 0);
}

async function pickDevice() {
  const devices = listRemovableDevices();
  if (devices.length === 0) fail('Aucun périphérique amovible avec une taille détectée (USB/SD) — carte insérée ? lecteur reconnu ?');

  console.log('\nPériphériques amovibles détectés :');
  devices.forEach((d, i) => {
    const sizeGb = (Number(d.size) / 1e9).toFixed(1);
    console.log(`  [${i}] /dev/${d.name} — ${sizeGb} Go — ${d.model || 'modèle inconnu'} (${d.tran || '?'})`);
  });

  const idxAnswer = await ask('\nNuméro du périphérique à flasher : ');
  const idx = parseInt(idxAnswer, 10);
  if (Number.isNaN(idx) || !devices[idx]) fail('Sélection invalide.');
  const device = `/dev/${devices[idx].name}`;

  console.log(`\n⚠️  TOUT le contenu de ${device} (${(Number(devices[idx].size) / 1e9).toFixed(1)} Go, ${devices[idx].model || '?'}) va être définitivement écrasé.`);
  const confirm = await ask(`Retape exactement "${device}" pour confirmer : `);
  if (confirm.trim() !== device) fail('Confirmation invalide — arrêt, rien n\'a été écrit.');

  return device;
}

// ==========================================================================
// 5. Flashage + personnalisation bootfs
// ==========================================================================

function flashImage(imgPath, device) {
  // Démonter toute partition déjà montée sur ce périphérique avant d'écrire.
  const out = runCapture('lsblk', ['-J', '-o', 'NAME,MOUNTPOINT', device]);
  const { blockdevices } = JSON.parse(out);
  const collectMounts = (nodes) => nodes.flatMap((n) => [n.mountpoint, ...(n.children ? collectMounts(n.children) : [])]).filter(Boolean);
  for (const mp of collectMounts(blockdevices)) {
    log(`Démontage de ${mp}...`);
    spawnSync('umount', [mp]);
  }

  log(`Écriture de l'image sur ${device} (dd, peut prendre plusieurs minutes)...`);
  run('dd', [`if=${imgPath}`, `of=${device}`, 'bs=4M', 'status=progress', 'conv=fsync']);
  log('Image écrite. Synchronisation du disque (sync)...');
  run('sync', []);
  log('Relecture de la table de partitions (partprobe)...');
  spawnSync('partprobe', [device]);
  log('Écriture de l\'image terminée.');
}

// ⭐ 06/09/2026, bug réel corrigé en conditions réelles — voir le commentaire détaillé dans
// prepare-sd-card.sh (app_needs_serial_console_disabled) : teleinfo a besoin de /dev/ttyAMA0 en
// exclusivité, or le kernel y attache aussi une console série par défaut (`console=serial0,115200`
// dans cmdline.txt, sur bootfs — hors de portée de prepare-sd-card.sh qui ne monte que rootfs).
const APPS_NEEDING_SERIAL_CONSOLE_DISABLED = ['teleinfo'];

function bootfsPartition(device) {
  const suffix = /[0-9]$/.test(device) ? 'p' : '';
  return `${device}${suffix}1`;
}

/** Logique de personnalisation partagée entre customizeBootfs (périphérique physique) et
 *  customizeBootfsOnImage (image via loop, ⭐ 18/09/2026) — même contenu écrit, seule la façon dont
 *  `mountDir` a été obtenu diffère entre les deux appelants. */
function writeBootfsCustomization(mountDir, profile) {
  // Active SSH au premier boot (mécanisme historique Raspberry Pi OS : fichier vide "ssh" à la
  // racine de bootfs).
  fs.writeFileSync(path.join(mountDir, 'ssh'), '');
  log('SSH activé (fichier "ssh" déposé sur bootfs).');

  // userconf.txt : "<user>:<mot de passe hashé SHA-512 crypt>" — même format que Raspberry Pi
  // Imager lui-même (openssl passwd -6). Mot de passe jamais écrit en clair sur la carte.
  log(`Génération du hash de mot de passe pour l'utilisateur "${profile.user}" (openssl passwd -6)...`);
  const hashed = runCapture('openssl', ['passwd', '-6', profile.password]).trim();
  fs.writeFileSync(path.join(mountDir, 'userconf.txt'), `${profile.user}:${hashed}\n`);

  if (profile.apps.some((a) => APPS_NEEDING_SERIAL_CONSOLE_DISABLED.includes(a))) {
    const cmdlinePath = path.join(mountDir, 'cmdline.txt');
    const original = fs.readFileSync(cmdlinePath, 'utf8');
    const updated = original.replace(/console=(serial0|ttyAMA0),115200\s*/g, '');
    fs.writeFileSync(cmdlinePath, updated);
    log('Console série (cmdline.txt) désactivée — une app du profil a besoin de l\'UART en exclusivité.');
  }

  log(`bootfs personnalisé : SSH activé, utilisateur "${profile.user}" configuré.`);
}

function customizeBootfs(device, profile) {
  log(`Montage de bootfs (${bootfsPartition(device)}) pour personnalisation...`);
  const bootPart = bootfsPartition(device);
  const mountDir = fs.mkdtempSync('/tmp/flash-sd-card-boot-');
  run('mount', [bootPart, mountDir]);
  try {
    writeBootfsCustomization(mountDir, profile);
  } finally {
    log('Démontage de bootfs...');
    run('umount', [mountDir]);
    fs.rmdirSync(mountDir);
  }
}

/**
 * ⭐ 18/09/2026, demande explicite (phase "préparation" séparée) — même personnalisation que
 * customizeBootfs, mais sur le FICHIER image directement via un périphérique loop, sans carte/clé
 * physique : `losetup -fP` attache l'image et fait apparaître ses partitions
 * (`${loopDev}p1`=bootfs), qu'on monte/démonte comme n'importe quel périphérique bloc. Toujours
 * détacher le loop dans `finally`, sans quoi il reste occupé (visible dans `losetup -l`) même après
 * une erreur.
 */
function customizeBootfsOnImage(imgPath, profile) {
  log(`Attachement de l'image en loop (${imgPath})...`);
  const loopDev = runCapture('losetup', ['-fP', '--show', imgPath]).trim();
  log(`Périphérique loop : ${loopDev}`);
  try {
    const bootPart = `${loopDev}p1`;
    const mountDir = fs.mkdtempSync('/tmp/flash-sd-card-boot-');
    run('mount', [bootPart, mountDir]);
    try {
      writeBootfsCustomization(mountDir, profile);
    } finally {
      log('Démontage de bootfs (loop)...');
      run('umount', [mountDir]);
      fs.rmdirSync(mountDir);
    }
  } finally {
    log(`Détachement du périphérique loop (${loopDev})...`);
    spawnSync('losetup', ['-d', loopDev]);
  }
}

// ==========================================================================
// main
// ==========================================================================

// ⭐ 05/09/2026 (demande utilisateur) — mesure de bout en bout, par étape : ce script existe en
// bonne partie pour ÉVITER la lenteur observée sur le RPi1 réel (voir TODO.md) ; avoir des durées
// chiffrées ici (téléchargement/flashage vs agrandissement/SSH/paquets dans prepare-sd-card.sh)
// permet de vérifier que le gain est réel plutôt que supposé, et de savoir quelle étape optimiser
// en premier si une carte reste lente.
function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return min > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

async function timedStep(label, fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  log(`⏱  ${label} : ${formatDuration(elapsed)}`);
  return { result, elapsed };
}

/** Construit les arguments de prepare-sd-card.sh à partir du profil — partagé entre le mode complet
 *  historique et le nouveau mode `--flash` (⭐ 18/09/2026). Docker CE et dimotic-ha ne sont PAS des
 *  options ici : prepare-sd-card.sh les installe désormais inconditionnellement (voir son en-tête). */
function buildPrepareArgs(device, profile) {
  const prepareArgs = [path.join(__dirname, 'prepare-sd-card.sh'), device];
  for (const key of profile.personalSshKeys) prepareArgs.push('--key', key);
  if (profile.packages.length > 0) prepareArgs.push('--packages', profile.packages.join(','));
  // ⭐ 05/09/2026, bug réel corrigé — voir le commentaire dans prepare-sd-card.sh : userconf.txt
  // (customizeBootfs) ne configure jamais le nom d'hôte, seulement l'utilisateur/SSH.
  if (profile.hostname) prepareArgs.push('--hostname', profile.hostname);
  // ⭐ 16/09/2026 (demande utilisateur) — jusqu'ici seul root recevait les clés personnelles
  // (`--key` ci-dessus) ; userconf.txt crée l'utilisateur mais ne lui donne aucune clé, forçant un
  // ssh-copy-id manuel après le premier boot. Voir le commentaire détaillé dans prepare-sd-card.sh.
  if (profile.user) prepareArgs.push('--user', profile.user);
  // ⭐ 05/09/2026 (demande utilisateur) — pré-installe device-agent + node_modules dans l'image pour
  // les apps listées, voir le commentaire détaillé dans prepare-sd-card.sh.
  if (profile.apps.length > 0) prepareArgs.push('--apps', profile.apps.join(','));
  // ⭐ 16/09/2026 (demande utilisateur) — WiFi de la machine cible réelle, voir le commentaire
  // détaillé dans prepare-sd-card.sh (réutilise imager_custom, mécanisme officiel Raspberry Pi
  // Imager — NetworkManager, pas wpa_supplicant.conf sur cette génération d'image).
  if (profile.wifi && profile.wifi.ssid) {
    prepareArgs.push('--wifi-ssid', profile.wifi.ssid);
    if (profile.wifi.password) prepareArgs.push('--wifi-pass', profile.wifi.password);
    if (profile.wifi.country) prepareArgs.push('--wifi-country', profile.wifi.country);
  }
  return prepareArgs;
}

/**
 * ⭐ 18/09/2026, phase "préparation" (demande explicite) — résout+télécharge+vérifie l'image et la
 * personnalise via loop, SANS périphérique physique. Écrit le résultat sous un chemin déterministe
 * (preparedImagePath) pour que la phase "flashage" le retrouve sans argument à faire circuler.
 */
async function runPrepareOnly(profilePath) {
  const stepDurations = [];
  const record = (label, ms) => stepDurations.push({ label, ms });

  const profile = loadProfile(profilePath);
  log(`[préparation] Profil "${profile.machine}" — modèle ${profile.piModel}, distribution ${profile.distro}`);

  const { result: entry, elapsed: eResolve } = await timedStep('Résolution du catalogue', () => resolveImageEntry(profile));
  record('Résolution du catalogue', eResolve);

  const { result: baseImgPath, elapsed: eDownload } = await timedStep('Téléchargement + décompression + vérification SHA256', () => ensureImageDownloaded(entry));
  record('Téléchargement/décompression/vérification', eDownload);

  const outputPath = preparedImagePath(profile.machine);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Copie plutôt que personnalisation directe du cache : `baseImgPath` est partagé entre profils
  // (même modèle/distro) — le modifier en place corromprait la personnalisation d'un AUTRE profil
  // réutilisant la même image de base.
  log(`Copie de l'image de base vers ${outputPath} (avant personnalisation)...`);
  fs.copyFileSync(baseImgPath, outputPath);

  const { elapsed: eCustom } = await timedStep('Personnalisation bootfs via loop (SSH + utilisateur)', () => { customizeBootfsOnImage(outputPath, profile); });
  record('Personnalisation bootfs (loop)', eCustom);

  // ⭐ 18/09/2026, demande explicite ("il repose les mêmes questions, où est la limite entre les 2 ?")
  // — persiste le profil COMPLET à côté de l'image : --flash n'aura plus besoin de redemander
  // modèle/distro/hostname/utilisateur/mot de passe/clé perso/paquets/apps, juste `machine` (+
  // WiFi, jamais interrogé ici puisque appliqué sur le rootfs réel, pas sur bootfs — voir
  // prepare-sd-card.sh). C'est ÇA la vraie limite entre les deux phases : pas "quelles infos", mais
  // "carte/clé physiquement branchée ou non".
  fs.writeFileSync(preparedProfilePath(profile.machine), JSON.stringify(profile, null, 2));

  const totalElapsed = stepDurations.reduce((sum, { ms }) => sum + ms, 0);
  log('--- Récapitulatif des durées ---');
  for (const { label, ms } of stepDurations) log(`  ${label} : ${formatDuration(ms)}`);
  log(`  TOTAL : ${formatDuration(totalElapsed)}`);

  log(`Terminé — image prête : ${outputPath}`);
  log(`Prochaine étape : téléchargez et lancez le script "2/2 — Flasher" (app Outils) avec le même MACHINE ("${profile.machine}") — il ne redemandera que le WiFi.`);
}

/**
 * ⭐ 18/09/2026, phase "flashage" (demande explicite) — reprend une image déjà préparée (via
 * --image, ou le chemin déterministe de runPrepareOnly si omis), choisit un périphérique physique
 * (voir pickDevice), l'écrit, puis enchaîne sur prepare-sd-card.sh — plus besoin de personnaliser
 * bootfs ici, déjà fait en phase préparation.
 */
async function runFlashOnly(profilePath, imageOverride) {
  const stepDurations = [];
  const record = (label, ms) => stepDurations.push({ label, ms });

  // ⭐ 18/09/2026 — le profil passé ici peut être "léger" (juste `machine` + `wifi`, cas normal via
  // l'app Outils) : fusionné avec le profil COMPLET persisté par --prepare (voir runPrepareOnly),
  // ses propres champs (s'il en a) gagnant sur ceux du profil persisté — utile en CLI directe pour
  // changer un réglage sans repasser par --prepare. Repli sur le profil brut seul si aucun profil
  // persisté ne correspond (compatibilité : un profil complet fourni directement fonctionne encore).
  const rawProfile = parseProfileFile(profilePath);
  if (!rawProfile.machine) fail('Le profil doit au moins contenir "machine" (voir --prepare).');
  const persistedPath = preparedProfilePath(rawProfile.machine);
  let merged = rawProfile;
  if (fs.existsSync(persistedPath)) {
    const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    merged = { ...persisted, ...rawProfile };
    log(`Profil complet retrouvé (${persistedPath}) — seuls les champs présents dans ${profilePath} le surchargent.`);
  }
  const profile = normalizeProfile(merged);
  const imgPath = imageOverride || preparedImagePath(profile.machine);
  if (!fs.existsSync(imgPath)) {
    fail(`Image préparée introuvable: ${imgPath}\nLancer d'abord: sudo node scripts/flash-sd-card.js --prepare ${profilePath}`);
  }
  log(`[flashage] Profil "${profile.machine}" — image préparée: ${imgPath}`);

  const device = await pickDevice(); // interactif — pas chronométré, ne dépend pas du script

  const { elapsed: eFlash } = await timedStep('Écriture de l\'image (dd)', () => { flashImage(imgPath, device); });
  record('Écriture de l\'image (dd)', eFlash);

  log('Image écrite (déjà personnalisée en phase préparation). Enchaînement sur prepare-sd-card.sh...');
  const prepareArgs = buildPrepareArgs(device, profile);
  const { elapsed: ePrepare } = await timedStep('prepare-sd-card.sh (agrandissement + SSH root + paquets + Docker + dimotic-ha)', () => { run('bash', prepareArgs); });
  record('prepare-sd-card.sh', ePrepare);

  const totalElapsed = stepDurations.reduce((sum, { ms }) => sum + ms, 0);
  log('--- Récapitulatif des durées ---');
  for (const { label, ms } of stepDurations) log(`  ${label} : ${formatDuration(ms)}`);
  log(`  TOTAL (hors choix interactif du périphérique) : ${formatDuration(totalElapsed)}`);

  log('Terminé — carte prête, à insérer dans le Pi cible.');
}

/** Mode historique, tout en un (conservé pour compatibilité CLI directe) — inchangé dans son
 *  comportement, réutilise juste buildPrepareArgs() désormais partagé avec runFlashOnly(). */
async function runFull(profilePath) {
  const stepDurations = [];
  const record = (label, ms) => stepDurations.push({ label, ms });

  const profile = loadProfile(profilePath);
  log(`Profil "${profile.machine}" — modèle ${profile.piModel}, distribution ${profile.distro}`);

  const { result: entry, elapsed: eResolve } = await timedStep('Résolution du catalogue', () => resolveImageEntry(profile));
  record('Résolution du catalogue', eResolve);

  const { result: imgPath, elapsed: eDownload } = await timedStep('Téléchargement + décompression + vérification SHA256', () => ensureImageDownloaded(entry));
  record('Téléchargement/décompression/vérification', eDownload);

  const device = await pickDevice(); // interactif — pas chronométré, ne dépend pas du script

  const { elapsed: eFlash } = await timedStep('Écriture de l\'image (dd)', () => { flashImage(imgPath, device); });
  record('Écriture de l\'image (dd)', eFlash);

  const { elapsed: eCustom } = await timedStep('Personnalisation bootfs (SSH + utilisateur)', () => { customizeBootfs(device, profile); });
  record('Personnalisation bootfs', eCustom);

  log('Image flashée et personnalisée. Enchaînement sur prepare-sd-card.sh (agrandissement + SSH root + paquets + Docker + dimotic-ha)...');
  const prepareArgs = buildPrepareArgs(device, profile);
  const { elapsed: ePrepare } = await timedStep('prepare-sd-card.sh', () => { run('bash', prepareArgs); });
  record('prepare-sd-card.sh', ePrepare);

  const totalElapsed = stepDurations.reduce((sum, { ms }) => sum + ms, 0);
  log('--- Récapitulatif des durées ---');
  for (const { label, ms } of stepDurations) log(`  ${label} : ${formatDuration(ms)}`);
  log(`  TOTAL (hors choix interactif du périphérique) : ${formatDuration(totalElapsed)}`);

  log('Terminé — carte prête, à insérer dans le Pi cible.');
}

async function main() {
  if (process.getuid && process.getuid() !== 0) fail('Ce script doit être lancé avec sudo (dd + montage de périphérique bloc).');

  const args = process.argv.slice(2);
  const usage = () => fail(
    'Usage:\n' +
    '  sudo node scripts/flash-sd-card.js --prepare <profil.yaml>\n' +
    '  sudo node scripts/flash-sd-card.js --flash <profil.yaml> [--image <chemin>]\n' +
    '  sudo node scripts/flash-sd-card.js <profil.yaml>   (mode historique, tout en un)'
  );

  if (args[0] === '--prepare') {
    if (!args[1]) usage();
    await runPrepareOnly(args[1]);
    return;
  }
  if (args[0] === '--flash') {
    if (!args[1]) usage();
    let imageOverride;
    const imgIdx = args.indexOf('--image');
    if (imgIdx !== -1) imageOverride = args[imgIdx + 1];
    await runFlashOnly(args[1], imageOverride);
    return;
  }
  if (args[0] && !args[0].startsWith('--')) {
    await runFull(args[0]);
    return;
  }
  usage();
}

main().catch((err) => fail(err.stack || String(err)));
