#!/bin/bash
#
# deploy-sender.sh — installe et démarre le "sender" AREXX (parle au dongle USB TL-500/BS500,
# pousse les relevés en HTTP vers le récepteur PushReceiver de dimotic-ha).
#
# Détecte l'architecture de CETTE machine :
#   - ARM 32 bits (armv6l/armv7l, typiquement un Raspberry Pi 1/2/3 en OS 32 bits) : déploie le
#     binaire précompilé rf_usb_http.elf (limite connue, documentée dans UsbBridge.ts : ne
#     fonctionne PAS sur RPi 3/4/5 en distribution arm64 — incident remonté à Arexx).
#   - Toute autre architecture (x86_64, aarch64/arm64...) : compile tl-500 sur place (base
#     mochad, portable, sans cette limite — vérifié sur x86_64, aarch64 et armv6l cette session).
#
# Ce script vit dans data/arexx/drivers/scripts/ (généré automatiquement par dimotic-ha,
# voir DriversBundle.ts) — copier tout le dossier data/arexx/drivers/ sur la machine cible, en
# conservant son arborescence :
#   drivers/scripts/deploy-sender.sh   (ce script)
#   drivers/rf_usb_http_rpi_0_6/       (binaire précompilé, chemin utilisé si ARM 32 bits)
#   drivers/tl-500/                    (sources C, chemin utilisé sinon)
#   drivers/target.txt                 (adresse host:port du récepteur AREXX à joindre — à éditer
#                                        AVANT de copier, voir ci-dessous)
#
# Usage : ./deploy-sender.sh
#   Pas d'argument — l'adresse est lue dans target.txt (fichier frère de ce dossier scripts/,
#   donc à la racine du dossier drivers/ copié). Format attendu : une ligne "host:port". Éditer ce
#   fichier avant de copier drivers/ sur la machine cible (ou après, avant de lancer ce script).
#
# Idempotent : ré-exécutable sans dupliquer/casser une installation existante.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RF_USB_SRC_DIR="$REPO_ROOT/rf_usb_http_rpi_0_6"
TL500_SRC_DIR="$REPO_ROOT/tl-500"

INSTALL_DIR="/opt/arexx-sender"

log() { echo "[deploy-sender] $*"; }
err() { echo "[deploy-sender] ERREUR: $*" >&2; }

TARGET_FILE="$REPO_ROOT/target.txt"
if [ ! -f "$TARGET_FILE" ]; then
  err "fichier introuvable: $TARGET_FILE"
  err "créer ce fichier avec une ligne host:port (ex: 192.168.1.51:49161) avant de relancer"
  exit 1
fi
TARGET="$(head -n1 "$TARGET_FILE" | tr -d '[:space:]')"
if [[ ! "$TARGET" =~ ^[^:]+:[0-9]+$ ]] || [[ "$TARGET" == A_REMPLACER:* ]]; then
  err "adresse invalide ou non renseignée dans $TARGET_FILE: '$TARGET'"
  err "éditer ce fichier avec une ligne host:port (ex: 192.168.1.51:49161) avant de relancer"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  err "ce script doit être lancé en root (écrit dans $INSTALL_DIR et /etc/systemd/system/)"
  exit 1
fi

ARCH="$(uname -m)"
log "architecture détectée: $ARCH"

# --------------------------------------------------------------------------
# Dépendances système — vérifiées avant toute action, installées seulement si absentes.
# --------------------------------------------------------------------------

have_pkg() { dpkg -s "$1" >/dev/null 2>&1; }

APT_PACKAGES=()
if ! have_pkg libusb-1.0-0; then
  # Nécessaire dans les DEUX chemins : tl-500 et rf_usb_http.elf sont tous deux liés
  # dynamiquement dessus (échec au lancement, pas seulement à la compilation, si absente).
  APT_PACKAGES+=(libusb-1.0-0)
fi

case "$ARCH" in
  armv6l|armv7l)
    MODE="rf_usb"
    ;;
  *)
    MODE="tl500"
    if ! command -v gcc >/dev/null 2>&1; then APT_PACKAGES+=(gcc); fi
    if ! command -v make >/dev/null 2>&1; then APT_PACKAGES+=(make); fi
    if ! have_pkg libusb-1.0-0-dev; then APT_PACKAGES+=(libusb-1.0-0-dev); fi
    ;;
esac

if [ "${#APT_PACKAGES[@]}" -gt 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installation des dépendances manquantes: ${APT_PACKAGES[*]}"
    apt-get update -qq
    apt-get install -y "${APT_PACKAGES[@]}"
  else
    err "apt-get introuvable — installez manuellement ces paquets avant de relancer: ${APT_PACKAGES[*]}"
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR"

# Arrête le service AVANT d'écraser les fichiers — une installation précédente encore en cours
# d'exécution empêche sinon l'écrasement du binaire ("Fichier texte occupé", constaté
# empiriquement le 21/08/2026 lors d'une réinstallation avec une nouvelle adresse cible).
systemctl stop arexx-sender.service 2>/dev/null || true

# --------------------------------------------------------------------------
# Chemin ARM 32 bits — rf_usb_http.elf (binaire précompilé)
# --------------------------------------------------------------------------
deploy_rf_usb() {
  log "mode: rf_usb_http.elf (32 bits ARM)"
  if [ ! -f "$RF_USB_SRC_DIR/rf_usb_http.elf" ]; then
    err "binaire introuvable: $RF_USB_SRC_DIR/rf_usb_http.elf (copier rf_usb_http_rpi_0_6/ à côté de ce script)"
    exit 1
  fi

  cp "$RF_USB_SRC_DIR/rf_usb_http.elf" "$INSTALL_DIR/rf_usb_http.elf"
  chmod +x "$INSTALL_DIR/rf_usb_http.elf"
  [ -f "$RF_USB_SRC_DIR/device.xml" ] && cp "$RF_USB_SRC_DIR/device.xml" "$INSTALL_DIR/device.xml"

  # Ligne Z conservée intentionnellement : la retirer fait planter le programme (constaté
  # empiriquement le 21/08/2026), malgré son statut "non supportée" dans le ReadMe officiel.
  cat > "$INSTALL_DIR/rulefile.txt" <<EOF
Vrulefile
A1push to templogger
B2
C0
E${TARGET}
Ztype==\$q&&id==\$i&&time==\$S&&v==\$v&&rssi==\$r&&missing==\$w
EOF

  cat > /etc/systemd/system/arexx-sender.service <<EOF
[Unit]
Description=AREXX sender (rf_usb_http.elf)
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/rf_usb_http.elf rulefile.txt
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
}

# --------------------------------------------------------------------------
# Chemin non-32-bits — compilation de tl-500 sur place
# --------------------------------------------------------------------------
deploy_tl500() {
  log "mode: tl-500 (compilation locale)"
  if [ ! -f "$TL500_SRC_DIR/tl-500.c" ]; then
    err "sources introuvables: $TL500_SRC_DIR/tl-500.c (copier tl-500/ à côté de ce script)"
    exit 1
  fi

  cp "$TL500_SRC_DIR"/tl-500.c "$TL500_SRC_DIR"/global500.h "$TL500_SRC_DIR"/Makefile "$INSTALL_DIR/"
  ( cd "$INSTALL_DIR" && make )

  echo "$TARGET" > "$INSTALL_DIR/url.txt"

  cat > /etc/systemd/system/arexx-sender.service <<EOF
[Unit]
Description=AREXX sender (tl-500)
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/tl-500 --urlfile url.txt
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$MODE" = "rf_usb" ]; then
  deploy_rf_usb
else
  deploy_tl500
fi

systemctl daemon-reload
systemctl enable --now arexx-sender.service

log "terminé — service arexx-sender actif, cible ${TARGET}"
log "vérification: systemctl status arexx-sender.service"
log "logs:          journalctl -u arexx-sender.service -f"
