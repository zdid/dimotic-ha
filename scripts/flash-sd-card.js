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
 *
 * Usage : sudo node scripts/flash-sd-card.js scripts/sd-card-profiles/teleinfo-rpi1.yaml
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
const CATALOG_URL = 'https://downloads.raspberrypi.org/os_list_imagingutility_v3.json';

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
    try { return os.userInfo({ uid: sudoUid }).homedir; } catch { /* repli ci-dessous */ }
  }
  if (process.env.SUDO_USER) {
    try {
      const line = runCapture('getent', ['passwd', process.env.SUDO_USER]).trim();
      const home = line.split(':')[5];
      if (home) return home;
    } catch { /* repli ci-dessous */ }
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

function loadProfile(profilePath) {
  if (!fs.existsSync(profilePath)) fail(`Profil introuvable: ${profilePath}`);
  const raw = fs.readFileSync(profilePath, 'utf8');
  const profile = yaml.load(raw);
  for (const field of ['machine', 'piModel', 'distro', 'hostname', 'user', 'password']) {
    if (!profile[field]) fail(`Champ requis manquant dans le profil: ${field}`);
  }
  const home = realUserHome();
  log(`Résolution "~" pour les clés personnelles : ${home} (SUDO_UID=${process.env.SUDO_UID || '?'}, SUDO_USER=${process.env.SUDO_USER || '?'}, HOME=${process.env.HOME || '?'})`);
  profile.personalSshKeys = (profile.personalSshKeys || []).map((p) => p.replace(/^~/, home));
  profile.packages = profile.packages || [];
  profile.apps = profile.apps || [];
  return profile;
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
  const is64 = profile.piModel.includes('64bit');
  const bits = is64 ? 64 : 32;
  const namesByBits = DISTRO_NAME_BY_BITS[profile.distro];
  if (!namesByBits) fail(`distro inconnue dans le profil: ${profile.distro} (attendu: ${Object.keys(DISTRO_NAME_BY_BITS).join(', ')})`);
  const wantedName = namesByBits[bits];

  log(`Catalogue officiel Raspberry Pi Imager : ${CATALOG_URL}`);
  const catalog = await httpGetJson(CATALOG_URL);
  const all = flattenCatalog(catalog.os_list);
  const entry = all.find((it) => it.name === wantedName && Array.isArray(it.devices) && it.devices.includes(profile.piModel));
  if (!entry) fail(`Aucune image "${wantedName}" compatible avec ${profile.piModel} trouvée dans le catalogue.`);

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
  return blockdevices.filter((d) => d.type === 'disk' && (d.rm === true || d.tran === 'usb'));
}

async function pickDevice() {
  const devices = listRemovableDevices();
  if (devices.length === 0) fail('Aucun périphérique amovible détecté (USB/SD) — carte insérée ?');

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

function customizeBootfs(device, profile) {
  log(`Montage de bootfs (${bootfsPartition(device)}) pour personnalisation...`);
  const bootPart = bootfsPartition(device);
  const mountDir = fs.mkdtempSync('/tmp/flash-sd-card-boot-');
  run('mount', [bootPart, mountDir]);
  try {
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
  } finally {
    log('Démontage de bootfs...');
    run('umount', [mountDir]);
    fs.rmdirSync(mountDir);
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

async function main() {
  if (process.getuid && process.getuid() !== 0) fail('Ce script doit être lancé avec sudo (dd + montage de périphérique bloc).');

  const profilePath = process.argv[2];
  if (!profilePath) fail('Usage: sudo node scripts/flash-sd-card.js <profil.yaml>');

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

  log('Image flashée et personnalisée. Enchaînement sur prepare-sd-card.sh (agrandissement + SSH root + paquets)...');
  const prepareArgs = [path.join(__dirname, 'prepare-sd-card.sh'), device];
  for (const key of profile.personalSshKeys) prepareArgs.push('--key', key);
  if (profile.packages.length > 0) prepareArgs.push('--packages', profile.packages.join(','));
  // ⭐ 05/09/2026, bug réel corrigé — voir le commentaire dans prepare-sd-card.sh : userconf.txt
  // (customizeBootfs ci-dessus) ne configure jamais le nom d'hôte, seulement l'utilisateur/SSH.
  if (profile.hostname) prepareArgs.push('--hostname', profile.hostname);
  // ⭐ 05/09/2026 (demande utilisateur) — pré-installe device-agent + node_modules dans l'image pour
  // les apps listées, voir le commentaire détaillé dans prepare-sd-card.sh.
  if (profile.apps.length > 0) prepareArgs.push('--apps', profile.apps.join(','));
  const { elapsed: ePrepare } = await timedStep('prepare-sd-card.sh (agrandissement + SSH root + paquets apt)', () => { run('bash', prepareArgs); });
  record('prepare-sd-card.sh (resize + SSH root + paquets)', ePrepare);

  // Somme des étapes chronométrées, PAS Date.now() - totalStart : ce dernier inclurait l'attente
  // interactive du choix de périphérique (pickDevice), dont la durée ne dit rien sur les
  // performances du script/de la machine.
  const totalElapsed = stepDurations.reduce((sum, { ms }) => sum + ms, 0);
  log('--- Récapitulatif des durées ---');
  for (const { label, ms } of stepDurations) log(`  ${label} : ${formatDuration(ms)}`);
  log(`  TOTAL (hors choix interactif du périphérique) : ${formatDuration(totalElapsed)}`);

  log('Terminé — carte prête, à insérer dans le Pi cible.');
}

main().catch((err) => fail(err.stack || String(err)));
