#!/usr/bin/env bash
#
# prepare-sd-card.sh — travaille sur un FICHIER IMAGE Raspberry Pi OS (jamais sur la carte
# physique), via un périphérique loop + chroot/émulation QEMU (qemu-user-static, même technique que
# pi-gen). Appelé par flash-sd-card.js (fonctionnelles-outils_specs v1.2 §7.2), deux modes :
#
#   base <image.img> [--packages p1,p2] [--apps a1,a2] [--extra-mb N]
#     Image de BASE, commune à toutes les machines de même modèle/distribution/paquets/apps —
#     gardée en cache par flash-sd-card.js. Agrandit l'image de N Mo, puis installe DANS l'image
#     (vitesse de CETTE machine, pas celle du Pi) : paquets apt, Node.js+npm, npm globaux
#     serialport+mqtt, Docker CE (get.docker.com), /docker/dimotic-ha/ (compose.yaml, NON démarré),
#     device-agent des apps (+ npm install --production), accès SSH root avec la clé dimotic-ha,
#     console série désactivée pour les apps qui ont besoin de l'UART. Termine par un NETTOYAGE
#     indispensable avant de cloner l'image sur plusieurs machines : clés d'hôte SSH, machine-id,
#     état cloud-init, cache apt, binaire QEMU copié.
#
#   legacy-machine <image.img> [--hostname H] [--user U] [--key k.pub]... [--wifi-ssid S
#     --wifi-pass P --wifi-country FR]
#     Personnalisation propre à UNE machine, pour bookworm uniquement (pas de cloud-init) : nom
#     d'hôte, clés personnelles (root + utilisateur), WiFi via imager_custom (mécanisme officiel
#     Raspberry Pi Imager, NetworkManager). Sur Trixie, tout ceci passe par cloud-init
#     (user-data/network-config, écrits par flash-sd-card.js sur bootfs) — ce mode n'est pas appelé.
#
# Prérequis (une fois, sur cette machine) :
#   sudo apt install qemu-user-static binfmt-support parted e2fsprogs file
#
# ⭐ 26/09/2026 — refonte (demande utilisateur) : avant, tout le lourd (Docker, Node, paquets, apps,
# WiFi) se faisait APRÈS l'écriture, sur la carte physique elle-même (lent, à refaire pour chaque
# carte). Désormais dans l'image de base, une fois, puis cache. Ancienne version :
# backups/applications/outils/reposcripts/scripts/prepare-sd-card_backup_2026-09-26_refonte-carte-sd.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Ce script doit être lancé avec sudo (périphérique loop + montages)." >&2
  exit 1
fi

usage() {
  echo "Usage:" >&2
  echo "  $0 base <image.img> [--packages p1,p2] [--apps a1,a2] [--extra-mb N]" >&2
  echo "  $0 legacy-machine <image.img> [--hostname H] [--user U] [--key k.pub]... [--wifi-ssid S --wifi-pass P --wifi-country FR]" >&2
  exit 1
}

MODE="${1:-}"
IMAGE="${2:-}"
[ -n "$MODE" ] && [ -n "$IMAGE" ] || usage
shift 2
[ -f "$IMAGE" ] || { echo "Image introuvable : $IMAGE" >&2; exit 1; }

PERSONAL_KEYS=()
PACKAGES=""
APPS=""
EXTRA_MB=2048
HOSTNAME_ARG=""
USER_ARG=""
WIFI_SSID=""
WIFI_PASS=""
WIFI_COUNTRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --packages) PACKAGES="$2"; shift 2 ;;
    --apps) APPS="$2"; shift 2 ;;
    --extra-mb) EXTRA_MB="$2"; shift 2 ;;
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --user) USER_ARG="$2"; shift 2 ;;
    --key) PERSONAL_KEYS+=("$2"); shift 2 ;;
    --wifi-ssid) WIFI_SSID="$2"; shift 2 ;;
    --wifi-pass) WIFI_PASS="$2"; shift 2 ;;
    --wifi-country) WIFI_COUNTRY="$2"; shift 2 ;;
    *) echo "Argument inconnu : $1" >&2; usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Racine du bundle (archive auto-extractible) ou du dépôt : scripts/ est juste en dessous dans le
# bundle, applications/outils/reposcripts/scripts/ dans un clone.
if [ -f "$SCRIPT_DIR/../data/core/machine_ssh/id_ed25519.pub" ] || [ -f "$SCRIPT_DIR/../compose.deploy.yaml" ]; then
  BUNDLE_ROOT="$SCRIPT_DIR/.."
else
  BUNDLE_ROOT="$SCRIPT_DIR/../../../.."
fi

# --- Table app -> (device-agent local, répertoire distant, besoin de l'UART en exclusivité).
# Seul `teleinfo` est câblé (seule app vérifiée avec ce patron : agent copié + npm install
# --production ; config.yaml écrit ensuite par le vrai déploiement en ligne). ---
app_local_dir() { case "$1" in teleinfo) echo "$BUNDLE_ROOT/applications/teleinfo/device-agent" ;; *) echo "" ;; esac; }
app_remote_dir() { case "$1" in teleinfo) echo "/dimotic-ha-addons/teleinfo" ;; *) echo "" ;; esac; }
# ⭐ 06/09/2026, bug réel — teleinfo a besoin de /dev/ttyAMA0 en exclusivité (1200 bauds) : console
# série du noyau (cmdline.txt) et login série (getty) désactivés, sinon quasi tous les octets sont
# perdus.
app_needs_serial_console_disabled() { case "$1" in teleinfo) echo "yes" ;; *) echo "" ;; esac; }

# ==========================================================================
# Loop + montages communs
# ==========================================================================

LOOP_DEV=""
ROOTFS=""
BOOTFS=""
cleanup() {
  if [ -n "$ROOTFS" ]; then
    for d in sys proc dev/pts dev; do
      mountpoint -q "$ROOTFS/$d" 2>/dev/null && umount "$ROOTFS/$d" || true
    done
    mountpoint -q "$ROOTFS" 2>/dev/null && umount "$ROOTFS" || true
    rmdir "$ROOTFS" 2>/dev/null || true
  fi
  if [ -n "$BOOTFS" ]; then
    mountpoint -q "$BOOTFS" 2>/dev/null && umount "$BOOTFS" || true
    rmdir "$BOOTFS" 2>/dev/null || true
  fi
  [ -n "$LOOP_DEV" ] && losetup -d "$LOOP_DEV" 2>/dev/null || true
}
trap cleanup EXIT

attach_and_mount() {
  LOOP_DEV="$(losetup -fP --show "$IMAGE")"
  echo "Image attachée : $LOOP_DEV"
  ROOTFS="$(mktemp -d /tmp/sd-rootfs.XXXXXX)"
  BOOTFS="$(mktemp -d /tmp/sd-bootfs.XXXXXX)"
  mount "${LOOP_DEV}p2" "$ROOTFS"
  mount "${LOOP_DEV}p1" "$BOOTFS"
}

setup_chroot() {
  echo "Détection de l'architecture cible (en-tête ELF, sans exécution)..."
  local probe="$ROOTFS/usr/bin/dpkg"
  [ -f "$probe" ] || probe="$ROOTFS/bin/bash"
  local info
  info="$(file -bL "$probe")"
  case "$info" in
    *aarch64*) QEMU_BIN=qemu-aarch64-static ;;
    *ARM,*)    QEMU_BIN=qemu-arm-static ;;
    *) echo "Architecture non reconnue : $info" >&2; exit 1 ;;
  esac
  [ -x "/usr/bin/$QEMU_BIN" ] || { echo "/usr/bin/$QEMU_BIN introuvable — sudo apt install qemu-user-static binfmt-support" >&2; exit 1; }
  echo "Architecture : $QEMU_BIN"
  cp "/usr/bin/$QEMU_BIN" "$ROOTFS/usr/bin/$QEMU_BIN"
  for d in dev dev/pts proc sys; do
    mountpoint -q "$ROOTFS/$d" || mount --bind "/$d" "$ROOTFS/$d"
  done
  # Résolution DNS dans le chroot (apt, curl) : celle de CETTE machine, le temps de l'installation.
  if [ -e "$ROOTFS/etc/resolv.conf" ] || [ -L "$ROOTFS/etc/resolv.conf" ]; then
    mv "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/resolv.conf.sd-card-orig"
  fi
  cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
}

# ⭐ bug réel corrigé (05/09/2026) : QEMU en mode utilisateur ne résout pas $PATH — toujours passer
# par /bin/bash -c "...".
# LC_ALL=C : la langue de CETTE machine (fr_FR) n'existe pas dans l'image — sans ça, apt/perl
# inondent le journal d'avertissements « Setting locale failed ».
in_chroot() { LC_ALL=C LANG=C LANGUAGE= chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c "$1"; }

teardown_chroot() {
  rm -f "$ROOTFS/etc/resolv.conf"
  if [ -e "$ROOTFS/etc/resolv.conf.sd-card-orig" ] || [ -L "$ROOTFS/etc/resolv.conf.sd-card-orig" ]; then
    mv "$ROOTFS/etc/resolv.conf.sd-card-orig" "$ROOTFS/etc/resolv.conf"
  fi
  rm -f "$ROOTFS/usr/bin/$QEMU_BIN"
}

# ==========================================================================
# Mode base
# ==========================================================================

add_package_if_missing() {
  case ",$PACKAGES," in
    *",$1,"*) ;;
    *) PACKAGES="${PACKAGES:+$PACKAGES,}$1" ;;
  esac
}

run_base() {
  local dimotic_key="$BUNDLE_ROOT/data/core/machine_ssh/id_ed25519.pub"
  local compose="$BUNDLE_ROOT/compose.deploy.yaml"
  [ -f "$dimotic_key" ] || { echo "Clé dimotic-ha introuvable : $dimotic_key" >&2; exit 1; }
  [ -f "$compose" ] || { echo "compose.deploy.yaml introuvable : $compose" >&2; exit 1; }

  local apps_arr=()
  if [ -n "$APPS" ]; then
    IFS=',' read -ra apps_arr <<< "$APPS"
    for app in "${apps_arr[@]}"; do
      local d
      d="$(app_local_dir "$app")"
      [ -n "$d" ] || { echo "App inconnue : $app (seule 'teleinfo' est câblée)" >&2; exit 1; }
      [ -d "$d" ] || { echo "device-agent introuvable pour $app : $d" >&2; exit 1; }
    done
  fi

  # Systématiques (voir en-tête) — build-essential pour la compilation native de serialport.
  add_package_if_missing build-essential
  add_package_if_missing nodejs
  add_package_if_missing mosquitto-clients
  add_package_if_missing curl

  echo "Agrandissement de l'image de ${EXTRA_MB} Mo (place pour Docker, Node, paquets)..."
  truncate -s "+${EXTRA_MB}M" "$IMAGE"
  parted -s "$IMAGE" resizepart 2 100%
  LOOP_DEV="$(losetup -fP --show "$IMAGE")"
  e2fsck -f -p "${LOOP_DEV}p2" || true
  resize2fs "${LOOP_DEV}p2"
  losetup -d "$LOOP_DEV"; LOOP_DEV=""

  attach_and_mount
  setup_chroot

  echo "Installation des paquets : $PACKAGES"
  # Acquire::Retries : les miroirs Raspbian redirigent vers des serveurs tiers parfois
  # injoignables (constaté le 26/09/2026 : échec sur mirror.netzwerge.de) — nouvelles tentatives.
  in_chroot "export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y $(echo "$PACKAGES" | tr ',' ' ')"

  # npm : tarball autonome (pas le paquet Debian, ~400 paquets sans rapport) — version tenue
  # synchronisée avec NPM_STANDALONE_VERSION de applications/teleinfo/src/domain/DeployService.ts.
  local npm_version="10.8.2"
  in_chroot "node -v" >/dev/null 2>&1 || { echo "node introuvable dans l'image après apt-get install nodejs" >&2; exit 1; }
  in_chroot "npm -v" >/dev/null 2>&1 || {
    echo "npm absent — installation autonome (tarball)..."
    in_chroot "mkdir -p /usr/lib/node_modules/npm && curl -fsSL https://registry.npmjs.org/npm/-/npm-${npm_version}.tgz | tar -xz -C /usr/lib/node_modules/npm --strip-components=1 && chmod +x /usr/lib/node_modules/npm/bin/npm-cli.js && ln -sf /usr/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm"
  }
  echo "npm globaux : serialport, mqtt..."
  in_chroot "npm install -g serialport mqtt"

  echo "Docker CE (script officiel get.docker.com)..."
  in_chroot "curl -fsSL https://get.docker.com | sh"

  echo "/docker/dimotic-ha/ (compose.yaml, NON démarré)..."
  mkdir -p "$ROOTFS/docker/dimotic-ha/data" "$ROOTFS/docker/dimotic-ha/logs"
  cp "$compose" "$ROOTFS/docker/dimotic-ha/compose.yaml"

  for app in "${apps_arr[@]}"; do
    local local_dir remote_dir
    local_dir="$(app_local_dir "$app")"
    remote_dir="$(app_remote_dir "$app")"
    echo "App $app : $remote_dir + npm install --production..."
    mkdir -p "$ROOTFS$remote_dir"
    cp -r "$local_dir"/. "$ROOTFS$remote_dir"/
    in_chroot "cd '$remote_dir' && npm install --production"
    if [ "$(app_needs_serial_console_disabled "$app")" = "yes" ]; then
      echo "App $app : console série désactivée (cmdline.txt + login série) — UART en exclusivité."
      sed -i -E 's/console=(serial0|ttyAMA0),115200 ?//g' "$BOOTFS/cmdline.txt"
      mkdir -p "$ROOTFS/etc/systemd/system"
      ln -sf /dev/null "$ROOTFS/etc/systemd/system/serial-getty@ttyAMA0.service"
    fi
  done

  echo "Accès SSH root : clé dimotic-ha (les clés personnelles sont ajoutées par machine)..."
  mkdir -p "$ROOTFS/etc/ssh/sshd_config.d" "$ROOTFS/root/.ssh"
  echo "PermitRootLogin yes" > "$ROOTFS/etc/ssh/sshd_config.d/permit-root-login.conf"
  cat "$dimotic_key" > "$ROOTFS/root/.ssh/authorized_keys"
  chmod 700 "$ROOTFS/root/.ssh"; chmod 600 "$ROOTFS/root/.ssh/authorized_keys"; chown -R 0:0 "$ROOTFS/root/.ssh"

  # --- Nettoyage : l'image sera clonée sur plusieurs machines. ---
  echo "Nettoyage avant clonage : cache apt, clés d'hôte SSH, machine-id, état cloud-init..."
  in_chroot "apt-get clean" || true
  rm -rf "$ROOTFS/var/lib/apt/lists/"* 2>/dev/null || true
  rm -f "$ROOTFS"/etc/ssh/ssh_host_*
  printf 'uninitialized\n' > "$ROOTFS/etc/machine-id"
  if [ -f "$ROOTFS/var/lib/dbus/machine-id" ] && [ ! -L "$ROOTFS/var/lib/dbus/machine-id" ]; then
    rm -f "$ROOTFS/var/lib/dbus/machine-id"
  fi
  rm -rf "$ROOTFS/var/lib/cloud" 2>/dev/null || true
  teardown_chroot

  echo "Place restante dans l'image : $(df -h --output=avail "$ROOTFS" | tail -1 | tr -d ' ')"
  sync
  echo "Image de base prête."
}

# ==========================================================================
# Mode legacy-machine (bookworm, pas de cloud-init)
# ==========================================================================

run_legacy_machine() {
  attach_and_mount

  if [ -n "$HOSTNAME_ARG" ]; then
    echo "$HOSTNAME_ARG" > "$ROOTFS/etc/hostname"
    if grep -q '^127\.0\.1\.1' "$ROOTFS/etc/hosts" 2>/dev/null; then
      sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_ARG/" "$ROOTFS/etc/hosts"
    else
      echo -e "127.0.1.1\t$HOSTNAME_ARG" >> "$ROOTFS/etc/hosts"
    fi
    echo "Nom d'hôte : $HOSTNAME_ARG"
  fi

  for k in "${PERSONAL_KEYS[@]}"; do
    if [ -f "$k" ]; then cat "$k" >> "$ROOTFS/root/.ssh/authorized_keys"; else echo "Clé personnelle introuvable, ignorée : $k" >&2; fi
  done

  # Utilisateur : créé au premier démarrage à partir de userconf.txt (bootfs) — UID 1000 par
  # convention Raspberry Pi OS, d'où le chown numérique.
  if [ -n "$USER_ARG" ] && [ ${#PERSONAL_KEYS[@]} -gt 0 ]; then
    local home="$ROOTFS/home/$USER_ARG"
    mkdir -p "$home/.ssh"
    : > "$home/.ssh/authorized_keys"
    for k in "${PERSONAL_KEYS[@]}"; do [ -f "$k" ] && cat "$k" >> "$home/.ssh/authorized_keys"; done
    chmod 700 "$home/.ssh"; chmod 600 "$home/.ssh/authorized_keys"; chown -R 1000:1000 "$home/.ssh"
    echo "Clés personnelles installées pour root et $USER_ARG."
  fi

  if [ -n "$WIFI_SSID" ]; then
    setup_chroot
    echo "WiFi (SSID : $WIFI_SSID) via imager_custom (mécanisme officiel Raspberry Pi Imager)..."
    in_chroot "/usr/lib/raspberrypi-sys-mods/imager_custom set_wlan $(printf '%q' "$WIFI_SSID") $(printf '%q' "$WIFI_PASS") $(printf '%q' "$WIFI_COUNTRY")"
    teardown_chroot
  fi
  sync
  echo "Personnalisation machine (bookworm) terminée."
}

case "$MODE" in
  base) run_base ;;
  legacy-machine) run_legacy_machine ;;
  *) usage ;;
esac
