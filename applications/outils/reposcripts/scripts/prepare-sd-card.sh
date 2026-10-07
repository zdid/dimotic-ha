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
#   shell <image.img> [--layout rpi|single]
#     Ouvre un TERMINAL INTERACTIF dans l'image (chroot + émulation QEMU, comme les autres modes), pour consulter une image
#     laissée par un échec (flash-sd-card.js la conserve en « .echec » et affiche la commande). « exit » pour sortir : l'image
#     est démontée. À lancer avec sudo, depuis un vrai terminal (ssh -t).
#
# ⭐ 07/10/2026 — ORANGE PI (Zero 2, 4 Pro) : images officielles Orange Pi Debian bookworm (dérivées d'Armbian) à UNE seule
# partition (racine = partition 1, /boot dedans, U-Boot avant la partition) : `--layout single` en mode base (agrandit et monte
# la partition 1) ; mode `opi-machine` pour la personnalisation propre à la machine (nom, utilisateur créé dans l'image,
# utilisateur `orangepi` par défaut supprimé, mot de passe root verrouillé, assistant de premier lancement désactivé, WiFi
# NetworkManager). Le système s'agrandit seul à la taille de la carte au premier démarrage (orangepi-resize-filesystem).
#
#   opi-machine <image.img> [--hostname H] [--user U] [--key k.pub]... [--wifi-ssid S --wifi-pass P]
#     [--ssh-hardening yes|no] [--fail2ban-ignoreip "ip ip"]   (hachage du mot de passe : variable d'environnement PASSWORD_HASH)
#
# ⭐ 07/10/2026 — fail2ban + durcissement SSH (comme stfort) : en mode base, fail2ban (backend systemd, nftables, 5 essais en
# 10 min -> 12 h) et SSH (root par clé seulement, pas de mot de passe — `--ssh-hardening no` pour l'ancien comportement) ;
# en mode legacy-machine, l'utilisateur du profil garde le mot de passe (bloc Match en fin de sshd_config) et
# `--fail2ban-ignoreip` ajoute les adresses jamais bannies. Contrôlé DANS l'image (sshd -T, fail2ban-client -t).
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
  echo "  $0 base <image.img> [--packages p1,p2] [--apps a1,a2] [--extra-mb N] [--ssh-hardening yes|no]" >&2
  echo "  $0 shell <image.img> [--layout rpi|single]   (terminal interactif dans l'image, via qemu)" >&2
  echo "  $0 base ... --layout single   (images Orange Pi : racine = partition 1, pas de bootfs séparé)" >&2
  echo "  $0 opi-machine <image.img> [--hostname H] [--user U] [--key k.pub]... [--wifi-ssid S --wifi-pass P] [--ssh-hardening yes|no] [--fail2ban-ignoreip \"ip ip\"]  (PASSWORD_HASH en environnement)" >&2
  echo "  $0 legacy-machine <image.img> [--hostname H] [--user U] [--key k.pub]... [--wifi-ssid S --wifi-pass P --wifi-country FR] [--ssh-hardening yes|no] [--fail2ban-ignoreip \"ip ip\"]" >&2
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
SSH_HARDENING="yes"
F2B_IGNOREIP=""
LAYOUT="rpi"            # rpi : bootfs=partition 1 + rootfs=partition 2 ; single : rootfs=partition 1 (Orange Pi)
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
    --layout) LAYOUT="$2"; shift 2 ;;
    --ssh-hardening) SSH_HARDENING="$2"; shift 2 ;;
    --fail2ban-ignoreip) F2B_IGNOREIP="$2"; shift 2 ;;
    *) echo "Argument inconnu : $1" >&2; usage ;;
  esac
done

case "$LAYOUT" in rpi|single) ;; *) echo "--layout : rpi ou single (reçu : $LAYOUT)" >&2; exit 1 ;; esac
if [ "$LAYOUT" = "single" ]; then ROOT_PART=1; else ROOT_PART=2; fi

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
  mount "${LOOP_DEV}p${ROOT_PART}" "$ROOTFS"
  if [ "$LAYOUT" = "rpi" ]; then
    BOOTFS="$(mktemp -d /tmp/sd-bootfs.XXXXXX)"
    mount "${LOOP_DEV}p1" "$BOOTFS"
  fi
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
    if [ -e "$ROOTFS/etc/resolv.conf.sd-card-orig" ] || [ -L "$ROOTFS/etc/resolv.conf.sd-card-orig" ]; then
      rm -f "$ROOTFS/etc/resolv.conf"       # image laissée par un échec : la vraie sauvegarde est déjà là
    else
      mv "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/resolv.conf.sd-card-orig"
    fi
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
  # fail2ban + son lecteur du journal systemd (pas de /var/log/auth.log sur ces images) + nftables (action de bannissement).
  add_package_if_missing fail2ban
  add_package_if_missing python3-systemd
  add_package_if_missing nftables

  echo "Agrandissement de l'image de ${EXTRA_MB} Mo (place pour Docker, Node, paquets)..."
  truncate -s "+${EXTRA_MB}M" "$IMAGE"
  parted -s "$IMAGE" resizepart "$ROOT_PART" 100%
  LOOP_DEV="$(losetup -fP --show "$IMAGE")"
  e2fsck -f -p "${LOOP_DEV}p${ROOT_PART}" || true
  resize2fs "${LOOP_DEV}p${ROOT_PART}"
  losetup -d "$LOOP_DEV"; LOOP_DEV=""

  attach_and_mount
  setup_chroot

  echo "Installation des paquets : $PACKAGES"
  # Acquire::Retries : les miroirs Raspbian redirigent vers des serveurs tiers parfois
  # injoignables (constaté le 26/09/2026 : échec sur mirror.netzwerge.de) — nouvelles tentatives.
  if [ "$LAYOUT" = "single" ]; then
    # Images Orange Pi : dépôts Orange Pi en plus de Debian, parfois injoignables — un échec de « update » ne doit pas tout arrêter
    # (le paquet manquant fera échouer « install », lui, explicitement).
    in_chroot "export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=5 update || echo 'AVERTISSEMENT : apt-get update incomplet'; apt-get -o Acquire::Retries=5 install -y $(echo "$PACKAGES" | tr ',' ' ')"
  else
    in_chroot "export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y $(echo "$PACKAGES" | tr ',' ' ')"
  fi

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
  # ⭐ 07/10/2026 — le script get.docker.com finit par « systemctl enable --now docker.service », qui échoue dans un chroot
  # (« unable to enable the docker service ») : pas de systemd en cours d'exécution. On active donc explicitement SANS --now
  # (simple création des liens de démarrage), puis on vérifie qu'ils existent.
  echo "Docker : activation au démarrage (sans --now, impossible dans un chroot)..."
  in_chroot "systemctl enable docker.service docker.socket containerd.service" 2>&1 | sed 's/^/  /' || true
  if [ -e "$ROOTFS/etc/systemd/system/multi-user.target.wants/docker.service" ] \
     || [ -e "$ROOTFS/etc/systemd/system/sockets.target.wants/docker.socket" ]; then
    echo "  Docker : démarrage automatique activé — OK."
  else
    echo "ERREUR : docker.service n'est pas activé au démarrage dans l'image (liens systemd absents)" >&2
    exit 1
  fi

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
      [ -n "$BOOTFS" ] || { echo "App $app : la console série ne se désactive pas sur ce type d'image (pas de bootfs) — non géré" >&2; exit 1; }
      echo "App $app : console série désactivée (cmdline.txt + login série) — UART en exclusivité."
      sed -i -E 's/console=(serial0|ttyAMA0),115200 ?//g' "$BOOTFS/cmdline.txt"
      mkdir -p "$ROOTFS/etc/systemd/system"
      ln -sf /dev/null "$ROOTFS/etc/systemd/system/serial-getty@ttyAMA0.service"
    fi
  done

  echo "Accès SSH root : clé dimotic-ha (les clés personnelles sont ajoutées par machine)..."
  mkdir -p "$ROOTFS/etc/ssh/sshd_config.d" "$ROOTFS/root/.ssh"
  cat "$dimotic_key" > "$ROOTFS/root/.ssh/authorized_keys"
  chmod 700 "$ROOTFS/root/.ssh"; chmod 600 "$ROOTFS/root/.ssh/authorized_keys"; chown -R 0:0 "$ROOTFS/root/.ssh"

  if [ "$SSH_HARDENING" = "yes" ]; then
    echo "Durcissement SSH : root par clé seulement, pas de mot de passe (l'utilisateur du profil le garde, ajouté par machine)..."
    printf '%s\n' '# Durcissement (Outils dimotic-ha) : root par clé uniquement.' 'PermitRootLogin prohibit-password' \
      > "$ROOTFS/etc/ssh/sshd_config.d/permit-root-login.conf"
    printf '%s\n' '# Durcissement (Outils dimotic-ha) : pas de mot de passe — sauf le bloc Match User en fin de sshd_config (par machine).' \
      'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > "$ROOTFS/etc/ssh/sshd_config.d/50-durcissement.conf"
  else
    echo "PermitRootLogin yes" > "$ROOTFS/etc/ssh/sshd_config.d/permit-root-login.conf"
  fi

  echo "fail2ban : configuration (comme stfort, adaptée à Debian : journal systemd + nftables)..."
  cat > "$ROOTFS/etc/fail2ban/jail.local" <<'EOF'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
findtime = 600
maxretry = 5
bantime  = 43200
banaction = nftables
backend = systemd

[sshd]
enabled = true
port    = ssh
EOF

  echo "Contrôle dans l'image : configuration SSH et fail2ban..."
  in_chroot "mkdir -p /run/sshd; ssh-keygen -A >/dev/null 2>&1; /usr/sbin/sshd -t" || { echo "ERREUR : sshd_config invalide dans l'image" >&2; exit 1; }
  local sshd_eff
  sshd_eff="$(in_chroot "/usr/sbin/sshd -T -C user=root,host=essai,addr=127.0.0.1")"
  if [ "$SSH_HARDENING" = "yes" ]; then
    echo "$sshd_eff" | grep -Eq '^permitrootlogin (without-password|prohibit-password)' || { echo "ERREUR : PermitRootLogin n'est pas « prohibit-password » dans l'image" >&2; exit 1; }
    echo "$sshd_eff" | grep -q '^passwordauthentication no' || { echo "ERREUR : le mot de passe SSH n'est pas refusé dans l'image" >&2; exit 1; }
    echo "  SSH : root par clé uniquement, mot de passe refusé — OK."
  fi
  in_chroot "fail2ban-client -t" >/dev/null 2>&1 && echo "  fail2ban : configuration valide — OK." \
    || { echo "ERREUR : fail2ban-client -t refuse la configuration dans l'image" >&2; exit 1; }

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
# Durcissement SSH / fail2ban propres à la machine (partagé legacy-machine et opi-machine)
# ==========================================================================

# Seul l'utilisateur du profil garde le mot de passe SSH : bloc Match tout à la FIN de sshd_config (comme stfort) ; adresses
# jamais bannies par fail2ban dans un drop-in zz-ignoreip.local.
# ⭐ 07/10/2026 — Pré-chargement de l'image Docker dimotic-ha : impossible de « docker pull » dans le chroot (pas de dockerd),
# donc téléchargement sur l'hôte (--platform de l'image cible), enregistrement en archive dans /docker/dimotic-ha/, et service
# systemd à usage unique qui fait « docker load » au premier démarrage (puis supprime l'archive). Non bloquant : sans Docker sur
# l'hôte ou sans réseau, un avertissement est affiché et la carte fera son « docker pull » normal au premier « compose up ».
preload_dimotic_image() {
  local tag="${DIMOTIC_TAG:-latest}" ref plat tar
  ref="$(grep -m1 '^ *image: *zdid2/dimotic-ha' "$ROOTFS/docker/dimotic-ha/compose.yaml" | awk '{print $2}' | sed "s/\${DIMOTIC_TAG:-latest}/$tag/")"
  [ -n "$ref" ] || ref="zdid2/dimotic-ha:$tag"
  case "$QEMU_BIN" in qemu-aarch64-static) plat=linux/arm64 ;; *) plat=linux/arm/v7 ;; esac
  if ! command -v docker >/dev/null 2>&1; then
    echo "AVERTISSEMENT : docker absent de l'hôte — image $ref non pré-chargée (téléchargée au premier démarrage)." >&2; return 0
  fi
  echo "Pré-chargement de l'image Docker $ref ($plat)..."
  tar="$ROOTFS/docker/dimotic-ha/dimotic-ha-image.tar.gz"
  if docker pull --platform "$plat" "$ref" >/dev/null && docker save "$ref" | gzip -1 > "$tar"; then
    cat > "$ROOTFS/etc/systemd/system/dimotic-ha-image-load.service" <<UNIT
[Unit]
Description=Charge l'image Docker dimotic-ha pré-installée (une seule fois)
After=docker.service
Requires=docker.service
ConditionPathExists=/docker/dimotic-ha/dimotic-ha-image.tar.gz

[Service]
Type=oneshot
ExecStart=/usr/bin/docker load -i /docker/dimotic-ha/dimotic-ha-image.tar.gz
ExecStartPost=/bin/rm -f /docker/dimotic-ha/dimotic-ha-image.tar.gz

[Install]
WantedBy=multi-user.target
UNIT
    mkdir -p "$ROOTFS/etc/systemd/system/multi-user.target.wants"
    ln -sf /etc/systemd/system/dimotic-ha-image-load.service "$ROOTFS/etc/systemd/system/multi-user.target.wants/dimotic-ha-image-load.service"
    echo "  Image pré-chargée ($(du -h "$tar" | cut -f1)) — chargée au premier démarrage."
  else
    rm -f "$tar"
    echo "AVERTISSEMENT : pré-chargement de $ref impossible (réseau ?) — téléchargée au premier démarrage." >&2
  fi
}

apply_machine_ssh_f2b() {
  if [ "$SSH_HARDENING" = "yes" ] && [ -n "$USER_ARG" ]; then
    if ! grep -q "^Match User $USER_ARG\$" "$ROOTFS/etc/ssh/sshd_config"; then
      printf '\n# Durcissement (Outils dimotic-ha) : l utilisateur %s garde le mot de passe.\nMatch User %s\n    PasswordAuthentication yes\n' \
        "$USER_ARG" "$USER_ARG" >> "$ROOTFS/etc/ssh/sshd_config"
    fi
    echo "SSH : mot de passe refusé sauf pour $USER_ARG."
  fi
  if [ -n "$F2B_IGNOREIP" ]; then
    mkdir -p "$ROOTFS/etc/fail2ban/jail.d"
    printf '[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 %s\n' "$F2B_IGNOREIP" > "$ROOTFS/etc/fail2ban/jail.d/zz-ignoreip.local"
    echo "fail2ban : adresses jamais bannies : $F2B_IGNOREIP"
  fi
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

  apply_machine_ssh_f2b
  preload_dimotic_image

  if [ -n "$WIFI_SSID" ]; then
    setup_chroot
    echo "WiFi (SSID : $WIFI_SSID) via imager_custom (mécanisme officiel Raspberry Pi Imager)..."
    in_chroot "/usr/lib/raspberrypi-sys-mods/imager_custom set_wlan $(printf '%q' "$WIFI_SSID") $(printf '%q' "$WIFI_PASS") $(printf '%q' "$WIFI_COUNTRY")"
    teardown_chroot
  fi
  sync
  echo "Personnalisation machine (bookworm) terminée."
}


# ==========================================================================
# Mode opi-machine (Orange Pi : image à une seule partition, dérivée d'Armbian)
# ==========================================================================

run_opi_machine() {
  [ "$LAYOUT" = "single" ] || { echo "opi-machine exige --layout single" >&2; exit 1; }
  [ -n "$USER_ARG" ] || { echo "opi-machine : --user est obligatoire" >&2; exit 1; }
  [ -n "${PASSWORD_HASH:-}" ] || { echo "opi-machine : variable d'environnement PASSWORD_HASH (mot de passe haché) manquante" >&2; exit 1; }
  attach_and_mount
  setup_chroot

  if [ -n "$HOSTNAME_ARG" ]; then
    echo "$HOSTNAME_ARG" > "$ROOTFS/etc/hostname"
    if grep -q '^127\.0\.1\.1' "$ROOTFS/etc/hosts" 2>/dev/null; then
      sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_ARG/" "$ROOTFS/etc/hosts"
    else
      echo -e "127.0.1.1\t$HOSTNAME_ARG" >> "$ROOTFS/etc/hosts"
    fi
    echo "Nom d'hôte : $HOSTNAME_ARG"
  fi

  # Fuseau horaire (comme les autres machines)
  in_chroot "ln -sf /usr/share/zoneinfo/Europe/Paris /etc/localtime && echo Europe/Paris > /etc/timezone"

  # Utilisateur du profil. L'utilisateur par défaut « orangepi » (mot de passe connu publiquement) est supprimé, sauf si c'est
  # justement celui du profil (on lui change alors le mot de passe).
  if [ "$USER_ARG" != "orangepi" ]; then
    in_chroot "id orangepi >/dev/null 2>&1 && userdel -r orangepi || true"
  fi
  if ! in_chroot "id '$USER_ARG' >/dev/null 2>&1"; then
    in_chroot "useradd -m -s /bin/bash '$USER_ARG'"
  fi
  for g in sudo adm dialout audio video plugdev users netdev input docker gpio i2c spi; do
    in_chroot "getent group $g >/dev/null 2>&1 && usermod -aG $g '$USER_ARG' || true"
  done
  printf '%s:%s\n' "$USER_ARG" "$PASSWORD_HASH" | in_chroot "chpasswd -e"
  echo "Utilisateur « $USER_ARG » créé (groupes sudo, docker, dialout…), « orangepi » par défaut retiré."

  # Mot de passe root verrouillé (l'accès root reste possible par clé) : le mot de passe par défaut d'Orange Pi est public.
  in_chroot "passwd -l root >/dev/null 2>&1 || true"

  # Assistant de premier lancement Orange Pi (crée un utilisateur à la première connexion en console) : désactivé, l'utilisateur
  # existe déjà. Sans ce fichier, orangepi-firstrun-config.service est aussi sans objet.
  rm -f "$ROOTFS/root/.not_logged_in_yet" "$ROOTFS/root/.desktop_autologin"

  # Clés personnelles : root + utilisateur
  mkdir -p "$ROOTFS/root/.ssh"
  for k in "${PERSONAL_KEYS[@]}"; do
    if [ -f "$k" ]; then cat "$k" >> "$ROOTFS/root/.ssh/authorized_keys"; else echo "Clé personnelle introuvable, ignorée : $k" >&2; fi
  done
  chmod 700 "$ROOTFS/root/.ssh"; chmod 600 "$ROOTFS/root/.ssh/authorized_keys"; chown -R 0:0 "$ROOTFS/root/.ssh"
  if [ ${#PERSONAL_KEYS[@]} -gt 0 ]; then
    local uid gid home="$ROOTFS/home/$USER_ARG"
    uid="$(in_chroot "id -u '$USER_ARG'")"; gid="$(in_chroot "id -g '$USER_ARG'")"
    mkdir -p "$home/.ssh"; : > "$home/.ssh/authorized_keys"
    for k in "${PERSONAL_KEYS[@]}"; do [ -f "$k" ] && cat "$k" >> "$home/.ssh/authorized_keys"; done
    chmod 700 "$home/.ssh"; chmod 600 "$home/.ssh/authorized_keys"; chown -R "$uid:$gid" "$home/.ssh"
    echo "Clés personnelles installées pour root et $USER_ARG."
  fi

  apply_machine_ssh_f2b
  preload_dimotic_image

  # WiFi : connexion NetworkManager (comme le fait l'assistant d'Orange Pi / Armbian).
  if [ -n "$WIFI_SSID" ]; then
    local nm="$ROOTFS/etc/NetworkManager/system-connections" uuid
    mkdir -p "$nm"
    uuid="$(cat /proc/sys/kernel/random/uuid)"
    {
      printf '[connection]\nid=%s\nuuid=%s\ntype=wifi\nautoconnect=true\n\n' "$WIFI_SSID" "$uuid"
      printf '[wifi]\nmode=infrastructure\nssid=%s\n\n' "$WIFI_SSID"
      if [ -n "$WIFI_PASS" ]; then printf '[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n\n' "$WIFI_PASS"; fi
      printf '[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n'
    } > "$nm/dimotic-wifi.nmconnection"
    chmod 600 "$nm/dimotic-wifi.nmconnection"; chown 0:0 "$nm/dimotic-wifi.nmconnection"
    echo "WiFi (SSID : $WIFI_SSID) : connexion NetworkManager écrite."
  fi

  # Contrôle dans l'image : sshd valide, effet réel sur l'utilisateur du profil et sur root.
  in_chroot "mkdir -p /run/sshd; ssh-keygen -A >/dev/null 2>&1; /usr/sbin/sshd -t" || { echo "ERREUR : sshd_config invalide dans l'image" >&2; exit 1; }
  if [ "$SSH_HARDENING" = "yes" ]; then
    in_chroot "/usr/sbin/sshd -T -C user=$USER_ARG,host=essai,addr=127.0.0.1" | grep -q '^passwordauthentication yes' \
      || { echo "ERREUR : le mot de passe SSH n'est pas autorisé pour $USER_ARG dans l'image" >&2; exit 1; }
    in_chroot "/usr/sbin/sshd -T -C user=root,host=essai,addr=127.0.0.1" | grep -q '^passwordauthentication no' \
      || { echo "ERREUR : le mot de passe SSH n'est pas refusé pour root dans l'image" >&2; exit 1; }
    echo "  SSH : mot de passe autorisé pour $USER_ARG seulement — OK."
  fi
  rm -f "$ROOTFS"/etc/ssh/ssh_host_*      # recréées au premier démarrage par orangepi-firstrun
  teardown_chroot
  sync
  echo "Personnalisation machine (Orange Pi) terminée."
}

# ==========================================================================
# Mode shell : terminal interactif dans une image (consultation après un échec)
# ==========================================================================

run_shell() {
  [ -t 0 ] || { echo "Le mode shell exige un vrai terminal (en SSH : ssh -t ...)" >&2; exit 1; }
  attach_and_mount
  setup_chroot
  echo
  echo "== Terminal dans l'image ($(basename "$IMAGE")) — architecture émulée par $QEMU_BIN"
  echo "   Racine montée sur $ROOTFS ; « exit » pour sortir (l'image est alors démontée, ses modifications restent)."
  echo
  # Invite explicite : le chroot affiche sinon le nom d'hôte de la machine hôte (même noyau).
  printf '%s\n' 'PS1="(IMAGE) \u@image:\w\$ "' > "$ROOTFS/tmp/.shell-rc"
  LC_ALL=C LANG=C chroot "$ROOTFS" "/usr/bin/$QEMU_BIN" /bin/bash --rcfile /tmp/.shell-rc -i || true
  rm -f "$ROOTFS/tmp/.shell-rc"
  teardown_chroot
  echo "Terminal fermé — image démontée : $IMAGE"
}

case "$MODE" in
  base) run_base ;;
  shell) run_shell ;;
  legacy-machine) run_legacy_machine ;;
  opi-machine) run_opi_machine ;;
  *) usage ;;
esac
