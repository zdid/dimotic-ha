#!/bin/bash
# Généré par l'application Outils — PRÉPARE puis ÉCRIT une carte SD/clé USB Raspberry Pi, en une
# seule fois (⭐ 26/09/2026 : réunit les anciennes étapes 1/2 « préparer » et 2/2 « flasher »).
# Toutes les questions sont posées ICI, WiFi compris ; le script s'arrête ensuite une seule fois,
# pour choisir la carte — avec la possibilité de s'arrêter là (image prête, écriture plus tard en
# relançant ce même script avec les mêmes réponses : il reprend directement au choix de la carte).
#
# ⭐ 07/10/2026 — ORANGE PI (Zero 2, 4 Pro) : même déroulé avec l'image officielle Orange Pi (Debian bookworm) fournie à la main
# (champ IMAGE_ORANGEPI) : racine sur la partition 1, utilisateur du profil créé dans l'image, utilisateur « orangepi » par défaut
# supprimé, mot de passe root verrouillé, WiFi NetworkManager, agrandissement automatique au premier démarrage.
#
# Déroulé (voir scripts/flash-sd-card.js) :
#   1. image officielle téléchargée (catalogue Raspberry Pi Imager) et vérifiée ;
#   2. IMAGE DE BASE construite UNE fois dans qemu sur CETTE machine puis gardée en cache — y sont
#      installés SYSTÉMATIQUEMENT : Docker CE (get.docker.com), /docker/dimotic-ha/ (compose.yaml
#      prêt, non démarré), Node.js+npm+serialport+mqtt (globaux), mosquitto-clients,
#      build-essential, accès SSH root par la clé dimotic-ha, fail2ban (journal systemd, 5 essais en
#      10 min -> 12 h) + durcissement SSH (root par clé seulement, pas de mot de passe sauf pour
#      l'utilisateur ci-dessous — comme stfort), + les paquets et apps cochés ;
#   3. image de LA machine en quelques secondes : nom, utilisateur/mot de passe, clés SSH, WiFi
#      (cloud-init sur trixie-lite ; ancien mécanisme sur bookworm-lite) ;
#   4. choix de la carte (ou arrêt), puis écriture.
#
# Archive auto-extractible : embarque le moteur, js-yaml, la clé SSH publique dimotic-ha,
# compose.deploy.yaml et le device-agent teleinfo — pas besoin de cloner le dépôt. Paquets requis
# sur CETTE machine : vérifiés ci-dessous (commande exacte indiquée si besoin).
#
# @outils:bundle applications/outils/reposcripts/scripts/flash-sd-card.js => scripts/flash-sd-card.js
# @outils:bundle applications/outils/reposcripts/scripts/prepare-sd-card.sh => scripts/prepare-sd-card.sh
# @outils:bundle applications/outils/node_modules/js-yaml => node_modules/js-yaml
# @outils:bundle data/core/machine_ssh/id_ed25519.pub
# @outils:bundle compose.deploy.yaml
# @outils:bundle applications/teleinfo/device-agent
#
# @outils:hint MACHINE = Nom qui identifie cette carte (image gardée sous ce nom) — relancer avec le même nom et les mêmes réponses reprend directement au choix de la carte.
# @outils:select PI_MODEL = Raspberry Pi 1, Raspberry Pi Zero, Raspberry Pi Zero W, Raspberry Pi Zero 2 W, Raspberry Pi 2, Raspberry Pi 3, Raspberry Pi 4, Raspberry Pi 400, Raspberry Pi 5, Raspberry Pi 500, Orange Pi Zero 2, Orange Pi 4 Pro
# @outils:hint PI_MODEL = Orange Pi Zero 2 / 4 Pro : image officielle Debian bookworm à télécharger À LA MAIN sur orangepi.org (champ IMAGE_ORANGEPI) ; la distribution ci-dessous est alors ignorée (bookworm, celle de l'image).
# @outils:hint IMAGE_ORANGEPI = Orange Pi UNIQUEMENT : chemin de l'image téléchargée (.7z, .img.xz ou .img), ex. ~/Téléchargements/Orangepizero2_3.1.0_debian_bookworm_server_linux6.1.31.7z. Laisser vide pour un Raspberry Pi.
# @outils:select DISTRO = trixie-lite, bookworm-lite
# @outils:default DISTRO = trixie-lite
# @outils:hint DISTRO = trixie-lite = version actuelle (cloud-init) ; bookworm-lite = version précédente (« Legacy »), pour rester identique aux machines déjà installées.
# @outils:select SSH_DURCISSEMENT = oui, non
# @outils:default SSH_DURCISSEMENT = oui
# @outils:hint SSH_DURCISSEMENT = oui = root par clé seulement et mot de passe refusé SAUF pour l'utilisateur ci-dessous (qui le garde, comme stfort) ; non = ancien comportement (root ET mots de passe acceptés).
# @outils:default FAIL2BAN_IGNOREIP = 192.168.0.0/16
# @outils:hint FAIL2BAN_IGNOREIP = Adresses jamais bannies par fail2ban, séparées par des espaces (127.0.0.1 et ::1 toujours incluses). Ajoutez vos adresses publiques ; réseau local par défaut. Vide = aucune en plus.
# @outils:checklist PERSONAL_SSH_KEY = ~/.ssh/id_rsa.pub
# @outils:hint PERSONAL_SSH_KEY = Coché = votre clé SSH personnelle est aussi autorisée (root et utilisateur), en plus de la clé dimotic-ha.
# @outils:checklist PACKAGES = nano, htop, tmux
# @outils:hint PACKAGES = Docker, Node.js, mosquitto-clients, build-essential et curl sont TOUJOURS installés (voir en-tête) — inutile de les ajouter.
# @outils:checklist APPS = teleinfo
# @outils:hint APPS = Agent pré-installé dans l'image (seule 'teleinfo' est câblée) — désactive aussi la console série (UART réservé à l'app).
# @outils:hint WIFI_SSID = Laisser vide si le Pi est relié par câble Ethernet.
# @outils:default WIFI_COUNTRY = FR
# @outils:hint WIFI_COUNTRY = Code pays radio (FR) — sans lui le WiFi peut rester bloqué.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/flash-sd-card.js" ]; then
  ENGINE_JS="$SCRIPT_DIR/scripts/flash-sd-card.js"
  REPO_ROOT="$SCRIPT_DIR"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  ENGINE_JS="$REPO_ROOT/applications/outils/reposcripts/scripts/flash-sd-card.js"
fi
if [ -z "$REPO_ROOT" ] || [ ! -f "$ENGINE_JS" ]; then
  echo "ERREUR: scripts/flash-sd-card.js introuvable — retéléchargez ce script depuis l'app Outils." >&2
  exit 1
fi

# --- Prérequis de CETTE machine (celle qui prépare, pas le Raspberry Pi), vérifiés avant tout. ---
MISSING_PREREQS=()
command -v node >/dev/null 2>&1 || MISSING_PREREQS+=("nodejs")
command -v xz >/dev/null 2>&1 || MISSING_PREREQS+=("xz-utils")
command -v qemu-arm-static >/dev/null 2>&1 || MISSING_PREREQS+=("qemu-user-static")
[ -d /proc/sys/fs/binfmt_misc ] && ls /proc/sys/fs/binfmt_misc 2>/dev/null | grep -q qemu-arm || MISSING_PREREQS+=("binfmt-support")
command -v parted >/dev/null 2>&1 || MISSING_PREREQS+=("parted")
command -v resize2fs >/dev/null 2>&1 || MISSING_PREREQS+=("e2fsprogs")
command -v file >/dev/null 2>&1 || MISSING_PREREQS+=("file")
command -v openssl >/dev/null 2>&1 || MISSING_PREREQS+=("openssl")
if [ ${#MISSING_PREREQS[@]} -gt 0 ]; then
  echo "Paquet(s) manquant(s) sur CETTE machine (pas sur le Raspberry Pi) :" >&2
  echo "  sudo apt update && sudo apt install -y ${MISSING_PREREQS[*]}" >&2
  echo "Puis relancez ce script." >&2
  exit 1
fi

MACHINE="__MACHINE__"
PI_MODEL="__PI_MODEL__"
DISTRO="__DISTRO__"
HOSTNAME_VALUE="__HOSTNAME__"
SSH_USER="__USER__"
SSH_PASSWORD="__PASSWORD__"
PERSONAL_SSH_KEY="__PERSONAL_SSH_KEY__"
# ⭐ 18/09/2026, bug réel — "~" résolu ICI (avant sudo, $HOME = l'utilisateur réel).
[ -n "$PERSONAL_SSH_KEY" ] && PERSONAL_SSH_KEY="${PERSONAL_SSH_KEY/#\~/$HOME}"
PACKAGES="__PACKAGES__"
APPS="__APPS__"
WIFI_SSID="__WIFI_SSID__"
WIFI_PASSWORD="__WIFI_PASSWORD__"
WIFI_COUNTRY="__WIFI_COUNTRY__"
SSH_DURCISSEMENT="__SSH_DURCISSEMENT__"
FAIL2BAN_IGNOREIP="__FAIL2BAN_IGNOREIP__"
IMAGE_ORANGEPI="__IMAGE_ORANGEPI__"
# "~" résolu ICI (avant sudo, $HOME = l'utilisateur réel), comme pour la clé SSH.
[ -n "$IMAGE_ORANGEPI" ] && IMAGE_ORANGEPI="${IMAGE_ORANGEPI/#\~/$HOME}"

# --- Orange Pi : image fournie à la main + outils supplémentaires sur CETTE machine ---
case "$PI_MODEL" in
  "Orange Pi"*)
    [ -n "$IMAGE_ORANGEPI" ] || { echo "ERREUR : pour une Orange Pi, indiquez le chemin de l'image téléchargée (champ IMAGE_ORANGEPI)." >&2; exit 1; }
    [ -f "$IMAGE_ORANGEPI" ] || { echo "ERREUR : image Orange Pi introuvable : $IMAGE_ORANGEPI" >&2; exit 1; }
    OPI_MISSING=()
    case "$IMAGE_ORANGEPI" in *.7z) command -v 7z >/dev/null 2>&1 || OPI_MISSING+=("p7zip-full") ;; esac
    command -v qemu-aarch64-static >/dev/null 2>&1 || OPI_MISSING+=("qemu-user-static")
    if [ ${#OPI_MISSING[@]} -gt 0 ]; then
      echo "Paquet(s) manquant(s) pour une Orange Pi : sudo apt install -y ${OPI_MISSING[*]}" >&2; exit 1
    fi
    [ -z "$APPS" ] || { echo "ERREUR : les apps pré-installées (teleinfo) ne sont pas gérées sur Orange Pi — décochez-les." >&2; exit 1; }
    ;;
  *) IMAGE_ORANGEPI="" ;;
esac

PROFILE_FILE=$(mktemp --suffix=.yaml)
trap 'rm -f "$PROFILE_FILE"' EXIT

# Valeurs entre guillemets (JSON est du YAML valide) : un mot de passe ou un SSID avec « : » ou
# « # » ne casse pas le profil.
q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
{
  echo "machine: $(q "$MACHINE")"
  echo "piModel: $(q "$PI_MODEL")"
  echo "distro: $(q "$DISTRO")"
  echo "hostname: $(q "$HOSTNAME_VALUE")"
  echo "user: $(q "$SSH_USER")"
  echo "password: $(q "$SSH_PASSWORD")"
  echo "personalSshKeys: [${PERSONAL_SSH_KEY:+$(q "$PERSONAL_SSH_KEY")}]"
  echo "packages: [${PACKAGES}]"
  echo "apps: [${APPS}]"
  echo "sshHardening: $(q "${SSH_DURCISSEMENT:-oui}")"
  echo "fail2banIgnoreIp: $(q "$FAIL2BAN_IGNOREIP")"
  if [ -n "$IMAGE_ORANGEPI" ]; then echo "image: $(q "$IMAGE_ORANGEPI")"; fi
  if [ -n "$WIFI_SSID" ]; then
    echo "wifi:"
    echo "  ssid: $(q "$WIFI_SSID")"
    echo "  password: $(q "$WIFI_PASSWORD")"
    echo "  country: $(q "${WIFI_COUNTRY:-FR}")"
  fi
} > "$PROFILE_FILE"

echo "--- Profil généré ($PROFILE_FILE), dépôt détecté: $REPO_ROOT ---"
cat "$PROFILE_FILE"
echo "---"

sudo node "$ENGINE_JS" "$PROFILE_FILE"
