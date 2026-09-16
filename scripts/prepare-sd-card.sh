#!/usr/bin/env bash
#
# prepare-sd-card.sh — pré-provisionne une carte SD Raspberry Pi OS fraîchement flashée, AVANT le
# premier boot, quel que soit le modèle de Pi (1/2/3/4/5) et son architecture (armhf ARMv6/v7 ou
# arm64) : agrandissement de rootfs à la taille réelle de la carte, accès SSH root (clé dimotic-ha +
# clé(s) personnelle(s)), optionnellement apt-get update + une liste de paquets, et optionnellement le
# WiFi de la machine cible — via chroot + émulation QEMU (qemu-user-static), même technique que pi-gen
# (l'outil officiel de fabrication d'images Raspberry Pi OS). Voir aussi
# PROCEDURE_preprovisioning-ssh-root-carte-sd_2026-09-05.md (version manuelle, pas-à-pas, non-git,
# écrite le même jour) pour le détail de chaque étape.
#
# ⭐ 16/09/2026 — WiFi : réutilise `/usr/lib/raspberrypi-sys-mods/imager_custom set_wlan` (déjà
# présent dans l'image, c'est lui qu'utilise Raspberry Pi Imager pour son option "Configurer le
# WiFi") — écrit un fichier NetworkManager (`/etc/NetworkManager/system-connections/
# preconfigured.nmconnection`) et configure le pays régulateur. Vérifié en inspectant l'image réelle
# (bookworm-lite) : NetworkManager est le stack actif sur cette génération, pas dhcpcd/wpa_supplicant
# autonome — un simple wpa_supplicant.conf déposé sur bootfs (mécanisme des générations précédentes
# de Raspberry Pi OS) n'aurait pas été repris.
#
# Usage :
#   sudo ./scripts/prepare-sd-card.sh <device ex: /dev/sda> [--key <clé_publique.pub>]... \
#     [--packages pkg1,pkg2,...] [--hostname <nom>] [--apps app1,app2,...] \
#     [--wifi-ssid <ssid> --wifi-pass <mot_de_passe> [--wifi-country <FR>]]
#
# Exemple (RPi1 teleinfo, avec Node.js + device-agent + node_modules pré-installés) :
#   sudo ./scripts/prepare-sd-card.sh /dev/sda --key ~/.ssh/id_rsa.pub --packages nodejs --apps teleinfo
#
# ⭐ 05/09/2026 (demande utilisateur, après avoir constaté en conditions réelles que `npm install`
# (rpio/serialport, compilation native) pouvait dépasser plusieurs minutes ET le timeout d'inactivité
# du vrai déploiement en ligne, laissant un process orphelin sur le RPi1 à chaque fois) — `--apps`
# copie le device-agent de la ou des app(s) listée(s) DANS L'IMAGE et y lance `npm install
# --production` dans le chroot (donc à la vitesse de CETTE machine, pas celle du Pi). Le vrai
# déploiement en ligne (DeployService.ts::ensureNodeModules) détecte alors que node_modules existe
# déjà et saute directement à l'écriture/démarrage du service — quasi instantané.
#
# Toujours au moins 2 clés dans authorized_keys :
#  - la clé unique dimotic-ha (data/core/ssh/id_ed25519.pub, générée automatiquement au démarrage,
#    voir core/infrastructure/remote/SshClient.ts) — déploiement automatique depuis l'IHM
#  - la/les clé(s) personnelle(s) passée(s) via --key — accès manuel de secours
#
# Pas de mot de passe root créé — cohérent avec le mécanisme existant (jamais de mot de passe,
# uniquement des clés).
#
# ⭐ L'agrandissement de rootfs est une optimisation, pas une correction : Raspberry Pi OS le fait
# déjà tout seul au premier démarrage (service firstboot/resize2fs_once). Le faire ici évite juste
# cette étape (potentiellement lente sur du matériel faible, même thème que l'installation npm — voir
# TODO.md) au moment critique du tout premier boot.
#
# Prérequis (une fois, sur cette machine hôte) :
#   sudo apt install qemu-user-static binfmt-support parted e2fsprogs

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Ce script doit être lancé avec sudo (partitionnement + écriture de fichiers root)." >&2
  exit 1
fi

usage() {
  echo "Usage: $0 <device ex: /dev/sda> [--key <clé_publique.pub>]... [--packages pkg1,pkg2,...] [--hostname <nom>] [--apps app1,app2,...] [--wifi-ssid <ssid> --wifi-pass <mot_de_passe> [--wifi-country <FR>]] [--user <nom_utilisateur>]" >&2
  exit 1
}

DEVICE="${1:-}"
[ -n "$DEVICE" ] || usage
shift

PERSONAL_KEYS=()
PACKAGES=""
HOSTNAME_ARG=""
APPS=""
WIFI_SSID=""
WIFI_PASS=""
WIFI_COUNTRY=""
USER_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key)
      PERSONAL_KEYS+=("$2")
      shift 2
      ;;
    --packages)
      PACKAGES="$2"
      shift 2
      ;;
    --hostname)
      HOSTNAME_ARG="$2"
      shift 2
      ;;
    --apps)
      APPS="$2"
      shift 2
      ;;
    --wifi-ssid)
      WIFI_SSID="$2"
      shift 2
      ;;
    --wifi-pass)
      WIFI_PASS="$2"
      shift 2
      ;;
    --wifi-country)
      WIFI_COUNTRY="$2"
      shift 2
      ;;
    --user)
      USER_ARG="$2"
      shift 2
      ;;
    *)
      echo "Argument inconnu: $1" >&2
      usage
      ;;
  esac
done

[ -z "$WIFI_PASS" ] || [ -n "$WIFI_SSID" ] || { echo "--wifi-pass fourni sans --wifi-ssid." >&2; usage; }

# --- Table app -> (répertoire local device-agent, répertoire distant) — voir --apps ci-dessus.
# ⭐ Seul `teleinfo` est câblé pour l'instant : seule app vérifiée avec ce patron exact (agent copié
# tel quel + npm install --production, PAS de config.yaml généré ici — écrit par le vrai déploiement
# en ligne, qui connaît les compteurs/réglages réels). Pour ajouter une app future avec le même
# patron (ex: arexx), ajouter une entrée ici ET s'assurer que son remoteDir par défaut
# (config-schema.ts de cette app) correspond exactement à la valeur utilisée ci-dessous.
app_local_dir() {
  case "$1" in
    teleinfo) echo "$SCRIPT_DIR/../applications/teleinfo/device-agent" ;;
    *) echo "" ;;
  esac
}
app_remote_dir() {
  case "$1" in
    # ⭐ 16/09/2026 — synchronisé avec le nouveau défaut de teleinfo/src/domain/config-schema.ts
    # (remoteDir), voir fonctionnelles-sauvegarde_specs_v1.0.md §4ter.
    teleinfo) echo "/dimotic-ha-addons/teleinfo" ;;
    *) echo "" ;;
  esac
}
# ⭐ 06/09/2026, bug réel corrigé en conditions réelles — sur une image Raspberry Pi OS non
# personnalisée, /dev/ttyAMA0 sert AUSSI de console série de login (serial-getty@ttyAMA0.service +
# `console=serial0,115200` dans cmdline.txt sur bootfs, modifié séparément côté
# flash-sd-card.js::customizeBootfs). teleinfo a besoin de l'UART en exclusivité (protocole 1200
# bauds) : partagé avec le getty, quasi tous les octets sont perdus/corrompus (constaté : 0 à
# quelques octets reçus par cycle de 25s au lieu d'une trame complète, alors que le même matériel
# fonctionnait très bien sur l'ancienne carte SD, où ce réglage avait été fait manuellement il y a
# longtemps). Masquage par symlink direct (équivalent de `systemctl mask`), sans dépendre d'un
# systemd actif dans le chroot.
app_needs_serial_console_disabled() {
  case "$1" in
    teleinfo) echo "yes" ;;
    *) echo "" ;;
  esac
}

[ -b "$DEVICE" ] || { echo "$DEVICE n'est pas un périphérique bloc valide." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIMOTIC_KEY_PATH="$SCRIPT_DIR/../data/core/ssh/id_ed25519.pub"
[ -f "$DIMOTIC_KEY_PATH" ] || { echo "Clé dimotic-ha introuvable: $DIMOTIC_KEY_PATH (l'app a-t-elle déjà démarré au moins une fois ?)" >&2; exit 1; }

if [ -n "$APPS" ]; then
  IFS=',' read -ra APPS_ARR <<< "$APPS"
  for app in "${APPS_ARR[@]}"; do
    local_dir="$(app_local_dir "$app")"
    [ -n "$local_dir" ] || { echo "App inconnue de --apps: $app (seule 'teleinfo' est câblée pour l'instant — voir app_local_dir/app_remote_dir en tête de script)" >&2; exit 1; }
    [ -d "$local_dir" ] || { echo "Répertoire device-agent introuvable pour $app: $local_dir" >&2; exit 1; }
  done
  # node-gyp (rpio/serialport) a besoin d'un compilateur — absent d'une image Lite de base. Ajouté
  # automatiquement plutôt que de compter sur l'utilisateur pour y penser dans son profil.
  case ",$PACKAGES," in
    *,build-essential,*) ;;
    *) PACKAGES="${PACKAGES:+$PACKAGES,}build-essential" ;;
  esac
fi

# --- Nom des 2 partitions (bootfs/rootfs) — gère les 2 conventions de nommage (/dev/sda1 vs
# /dev/mmcblk0p1 pour un lecteur intégré). ---
if [[ "$DEVICE" =~ [0-9]$ ]]; then
  PART_SUFFIX="p"
else
  PART_SUFFIX=""
fi
BOOTFS_PART="${DEVICE}${PART_SUFFIX}1"
ROOTFS_PART="${DEVICE}${PART_SUFFIX}2"
[ -b "$BOOTFS_PART" ] && [ -b "$ROOTFS_PART" ] || { echo "Partitions attendues introuvables ($BOOTFS_PART / $ROOTFS_PART) — carte pas au format Raspberry Pi OS standard ?" >&2; exit 1; }

echo "Périphérique : $DEVICE (bootfs=$BOOTFS_PART, rootfs=$ROOTFS_PART)"

# --- Démonter si déjà monté (l'environnement de bureau monte souvent automatiquement à l'insertion) ---
echo "Vérification des montages existants..."
for p in "$BOOTFS_PART" "$ROOTFS_PART"; do
  mp="$(findmnt -n -o TARGET "$p" 2>/dev/null || true)"
  if [ -n "$mp" ]; then
    echo "Démontage de $p ($mp)..."
    umount "$mp"
  fi
done

# --- Agrandissement de rootfs à la taille réelle de la carte (voir note en en-tête — optimisation,
# pas une correction). resizepart doit s'appliquer sur le périphérique ENTIER, pas la partition. ---
echo "Agrandissement de la partition rootfs ($ROOTFS_PART) à la taille de la carte (parted)..."
parted -s "$DEVICE" resizepart 2 100%
echo "Vérification du système de fichiers avant redimensionnement (e2fsck)..."
e2fsck -f -p "$ROOTFS_PART" || true   # -p: corrige automatiquement, code retour non-fatal attendu si déjà propre
echo "Redimensionnement du système de fichiers ext4 (resize2fs, peut prendre un moment sur une grande carte)..."
resize2fs "$ROOTFS_PART"
echo "rootfs agrandi."

# --- Montage contrôlé (pas de dépendance à un montage automatique de bureau) ---
echo "Montage de rootfs pour la suite (SSH root, paquets, apps)..."
MOUNT_DIR="$(mktemp -d /tmp/prepare-sd-card.XXXXXX)"
mount "$ROOTFS_PART" "$MOUNT_DIR"
ROOTFS="$MOUNT_DIR"

cleanup() {
  for d in sys proc dev; do
    mountpoint -q "$ROOTFS/$d" 2>/dev/null && umount "$ROOTFS/$d" || true
  done
  mountpoint -q "$ROOTFS" 2>/dev/null && umount "$ROOTFS" || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# --- Détection de l'architecture cible — lecture d'en-tête ELF, SANS exécution. ---
echo "Détection de l'architecture cible (lecture d'en-tête ELF, sans exécution)..."
ARCH_PROBE="$ROOTFS/bin/bash"
[ -f "$ARCH_PROBE" ] || ARCH_PROBE="$ROOTFS/usr/bin/dpkg"
[ -f "$ARCH_PROBE" ] || { echo "Impossible de détecter l'architecture (ni bin/bash ni usr/bin/dpkg trouvés dans rootfs)." >&2; exit 1; }
ARCH_INFO="$(file -b "$ARCH_PROBE")"
case "$ARCH_INFO" in
  *aarch64*) QEMU_BIN=qemu-aarch64-static ;;
  *ARM,*)    QEMU_BIN=qemu-arm-static ;;
  *)
    echo "Architecture non reconnue pour $ARCH_PROBE: $ARCH_INFO" >&2
    exit 1
    ;;
esac
QEMU_SRC="/usr/bin/$QEMU_BIN"
[ -x "$QEMU_SRC" ] || { echo "$QEMU_SRC introuvable — installer d'abord: sudo apt install qemu-user-static binfmt-support" >&2; exit 1; }
echo "Architecture détectée : $ARCH_INFO -> $QEMU_BIN"

# --- Nom d'hôte (optionnel) — bug réel corrigé (05/09/2026) : la personnalisation du premier boot
# faite côté flash-sd-card.js (userconf.txt + fichier ssh, sur bootfs) crée bien l'utilisateur et
# active SSH, mais NE touche PAS au nom d'hôte — mécanisme complètement différent côté Raspberry Pi
# OS (le script firstrun.sh de l'Imager officiel, jamais reproduit ici). Plus simple et plus fiable
# d'écrire directement /etc/hostname + /etc/hosts sur rootfs, déjà monté ici pour l'agrandissement. ---
if [ -n "$HOSTNAME_ARG" ]; then
  echo "$HOSTNAME_ARG" > "$ROOTFS/etc/hostname"
  # Convention Raspbian : 127.0.1.1 <hostname> — remplace la ligne existante si présente (image de
  # base livrée avec 127.0.1.1 raspberrypi), l'ajoute sinon.
  if grep -q '^127\.0\.1\.1' "$ROOTFS/etc/hosts" 2>/dev/null; then
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_ARG/" "$ROOTFS/etc/hosts"
  else
    echo -e "127.0.1.1\t$HOSTNAME_ARG" >> "$ROOTFS/etc/hosts"
  fi
  echo "Nom d'hôte configuré : $HOSTNAME_ARG"
fi

# --- SSH root : drop-in + clés autorisées (aucune exécution nécessaire pour cette partie). ---
mkdir -p "$ROOTFS/etc/ssh/sshd_config.d"
echo "PermitRootLogin yes" > "$ROOTFS/etc/ssh/sshd_config.d/permit-root-login.conf"

mkdir -p "$ROOTFS/root/.ssh"
cat "$DIMOTIC_KEY_PATH" > "$ROOTFS/root/.ssh/authorized_keys"
for k in "${PERSONAL_KEYS[@]}"; do
  if [ -f "$k" ]; then
    cat "$k" >> "$ROOTFS/root/.ssh/authorized_keys"
  else
    echo "Clé personnelle introuvable, ignorée: $k" >&2
  fi
done
chmod 700 "$ROOTFS/root/.ssh"
chmod 600 "$ROOTFS/root/.ssh/authorized_keys"
chown -R 0:0 "$ROOTFS/root/.ssh"
echo "SSH root prêt. Clés dans authorized_keys :"
cat "$ROOTFS/root/.ssh/authorized_keys"

# --- SSH utilisateur (⭐ 16/09/2026, demande utilisateur — manquait jusqu'ici, seul root recevait
# des clés) : clés PERSONNELLES uniquement, jamais la clé dimotic-ha (l'automatisation reste
# exclusivement en root direct, voir les commentaires "Toujours en root direct" des config-schema.ts
# de teleinfo/arexx/rpigpio — pas de raison de la donner aussi à l'utilisateur humain).
#
# Pas de user/groupe "$USER_ARG" dans /etc/passwd de ce rootfs à ce stade : le compte n'est créé
# qu'au vrai premier boot du Pi (userconfig.service, à partir de userconf.txt déposé sur bootfs par
# flash-sd-card.js::customizeBootfs — mécanisme séparé, pas encore appliqué ici). `chown` numérique
# sur l'UID/GID 1000 plutôt que par nom : c'est la convention Raspberry Pi OS pour le premier
# utilisateur créé via ce mécanisme (même hypothèse que imager_custom lui-même, qui résout
# `getent passwd 1000` pour ce même premier utilisateur). ---
if [ -n "$USER_ARG" ]; then
  USER_HOME="$ROOTFS/home/$USER_ARG"
  mkdir -p "$USER_HOME/.ssh"
  : > "$USER_HOME/.ssh/authorized_keys"
  for k in "${PERSONAL_KEYS[@]}"; do
    if [ -f "$k" ]; then
      cat "$k" >> "$USER_HOME/.ssh/authorized_keys"
    else
      echo "Clé personnelle introuvable, ignorée: $k" >&2
    fi
  done
  chmod 700 "$USER_HOME/.ssh"
  chmod 600 "$USER_HOME/.ssh/authorized_keys"
  chown -R 1000:1000 "$USER_HOME/.ssh"
  echo "SSH utilisateur ($USER_ARG) prêt. Clés dans authorized_keys :"
  cat "$USER_HOME/.ssh/authorized_keys"
fi

# --- Désactivation du login série (getty) pour les apps qui ont besoin de l'UART en exclusivité
# (voir app_needs_serial_console_disabled ci-dessus). ---
if [ -n "$APPS" ]; then
  for app in "${APPS_ARR[@]}"; do
    if [ "$(app_needs_serial_console_disabled "$app")" = "yes" ]; then
      echo "Désactivation du login série sur ttyAMA0 (app $app a besoin de l'UART en exclusivité)..."
      mkdir -p "$ROOTFS/etc/systemd/system"
      ln -sf /dev/null "$ROOTFS/etc/systemd/system/serial-getty@ttyAMA0.service"
      break
    fi
  done
fi

# --- Paquets apt + apps (optionnels) — nécessitent le chroot+QEMU, exécutés sur CETTE machine
# (rapide), pas sur le Pi cible (voir TODO.md : apt/npm sur un RPi1 ARMv6 peuvent être extrêmement
# lents — jusqu'à laisser un process orphelin sur la cible si le timeout d'inactivité du vrai
# déploiement en ligne est dépassé, constaté en conditions réelles le 05/09/2026). Montages
# communs aux deux, faits une seule fois. ---
if [ -n "$PACKAGES" ] || [ -n "$APPS" ] || [ -n "$WIFI_SSID" ]; then
  echo "Préparation de l'environnement d'émulation ($QEMU_BIN) — copie dans rootfs et montage de /dev, /proc, /sys..."
  cp "$QEMU_SRC" "$ROOTFS/usr/bin/$QEMU_BIN"
  for d in dev proc sys; do
    mountpoint -q "$ROOTFS/$d" || mount --bind "/$d" "$ROOTFS/$d"
  done
  echo "Environnement d'émulation prêt — entrée dans le chroot pour les étapes suivantes."
fi

# --- WiFi : réutilise le script OFFICIEL Raspberry Pi imager_custom (déjà présent dans l'image,
# c'est lui qu'utilise Raspberry Pi Imager pour son option "Configurer le WiFi") plutôt que de
# reconstruire le format NetworkManager nous-mêmes — écrit /etc/NetworkManager/system-connections/
# preconfigured.nmconnection (chmod 600) + configure le pays régulateur via raspi-config. ⭐
# 16/09/2026, vérifié en inspectant l'image réelle (bookworm-lite) : cette image utilise déjà
# NetworkManager (pas dhcpcd/wpa_supplicant autonome) — un simple wpa_supplicant.conf déposé sur
# bootfs, envisagé initialement, n'aurait pas été repris. ---
if [ -n "$WIFI_SSID" ]; then
  echo "Configuration WiFi (SSID: $WIFI_SSID) via imager_custom (mécanisme officiel Raspberry Pi Imager)..."
  chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c \
    "/usr/lib/raspberrypi-sys-mods/imager_custom set_wlan $(printf '%q' "$WIFI_SSID") $(printf '%q' "$WIFI_PASS") $(printf '%q' "$WIFI_COUNTRY")"
  echo "WiFi configuré."
fi

if [ -n "$PACKAGES" ]; then
  echo "Installation de paquets via chroot : $PACKAGES"
  PACKAGES_SPACED="$(echo "$PACKAGES" | tr ',' ' ')"
  chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c \
    "export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y $PACKAGES_SPACED"
fi

# ⭐ 05/09/2026 (demande utilisateur) — copie le device-agent de chaque app listée dans l'image ET
# pré-compile node_modules dans le chroot, pour que le vrai déploiement en ligue (DeployService.ts::
# ensureNodeModules, `test -d remoteDir/node_modules`) le trouve déjà prêt et saute directement à
# l'écriture/démarrage du service. npm PAS installé via apt ici non plus — même tarball autonome que
# DeployService.ts::ensureNode (voir son commentaire détaillé), pour ne pas gonfler l'image avec les
# ~400 paquets Debian sans rapport (eslint/webpack/git/X11...). Version tenue synchronisée à la main
# avec NPM_STANDALONE_VERSION dans applications/teleinfo/src/domain/DeployService.ts.
NPM_STANDALONE_VERSION="10.8.2"
if [ -n "$APPS" ]; then
  # ⭐ bug réel corrigé en conditions réelles (05/09/2026) : `chroot rootfs qemu-arm-static node -v`
  # échouait ("node introuvable") même juste après un `apt-get install nodejs` réussi — QEMU en mode
  # utilisateur n'exécute pas de shell, donc ne fait AUCUNE résolution de $PATH ; il attend un CHEMIN
  # (relatif au chroot) vers l'exécutable. `node -v` sans /bin/bash -c cherchait donc littéralement
  # "./node" depuis "/", pas "/usr/bin/node". Toutes les commandes chroot+QEMU de ce script DOIVENT
  # passer par `/bin/bash -c "..."` (comme déjà fait pour apt-get et npm install ci-dessous) — cette
  # vérification était la seule exception, oubliée.
  chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c "node -v" >/dev/null 2>&1 || { echo "node introuvable dans le chroot — ajouter 'nodejs' à --packages." >&2; exit 1; }
  chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c "npm -v" >/dev/null 2>&1 || {
    echo "npm absent du chroot — installation autonome (tarball, pas le paquet Debian)..."
    chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c \
      "mkdir -p /usr/lib/node_modules/npm && curl -fsSL https://registry.npmjs.org/npm/-/npm-${NPM_STANDALONE_VERSION}.tgz | tar -xz -C /usr/lib/node_modules/npm --strip-components=1 && chmod +x /usr/lib/node_modules/npm/bin/npm-cli.js && ln -sf /usr/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm"
  }

  for app in "${APPS_ARR[@]}"; do
    local_dir="$(app_local_dir "$app")"
    remote_dir="$(app_remote_dir "$app")"
    echo "App $app : copie de $local_dir vers rootfs$remote_dir, puis npm install --production dans le chroot..."
    mkdir -p "$ROOTFS$remote_dir"
    cp -r "$local_dir"/. "$ROOTFS$remote_dir"/
    chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c "cd '$remote_dir' && npm install --production"
    echo "App $app : node_modules pré-installé ($(chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash -c "ls '$remote_dir/node_modules' | wc -l") paquets)."
  done
fi

sync
echo "Terminé — carte prête (rootfs agrandi, SSH root configuré$( [ -n "$PACKAGES" ] && echo ", paquets installés" )$( [ -n "$APPS" ] && echo ", apps pré-installées: $APPS" )$( [ -n "$WIFI_SSID" ] && echo ", WiFi configuré ($WIFI_SSID)" )). Démontage automatique en sortie de script, puis insérer la carte dans le Pi cible."
