#!/usr/bin/env bash
# =============================================================================
# Prépare, SUR FALBALA et en root, la clé USB / carte SD d'un RPi3 qui servira uniquement à faire tourner Claude Code
# relié par un tunnel SSH au MCP de dimotic-ha de noisy2 (plan : conversation du 19/10/2026).
#
# À lancer APRÈS la fin du flashage d'Outils (image « noisyia »), clé branchée sur falbala, AVANT de la mettre dans le RPi3 :
#     sudo ./scripts/preparer-rpi3-claude.sh /dev/sdX [--adresse-wg 10.10.10.5/24] [--simulation]
# (/dev/sdX = la clé, vérifiez avec « lsblk » ; jamais un disque NVMe ni le disque de falbala).
#
# Ce que fait le script (tout sur la clé montée, aucune action sur falbala hors montages temporaires) :
#   1. contrôles : périphérique amovible, deux partitions (boot/rootfs), système Debian arm64 ;
#   2. swap de 1 Go (dphys-swapfile) ;
#   3. dans un chroot qemu : paquets wireguard-tools, screen, curl, autossh, jq ; clés WireGuard du RPi3 ; compte « claude »
#      sans sudo avec sa clé SSH (pour le tunnel) ;
#   4. /etc/wireguard/wg0.conf : le pair « noisy » est repris de CELUI de falbala (clé publique, point d'accès, keepalive),
#      seul 10.10.10.0/24 est routé (le réseau 192.168.1.x de Saint Fort n'est JAMAIS touché) ; activé au démarrage ;
#   5. dossier de l'agent /dimotic-ha-addons/agent-ha (modèle des consignes + site noisy2 + .mcp.json à compléter) et script
#      de tunnel vers le MCP de noisy2 (lancé à la main au début, service fourni mais NON activé) ;
#   6. récapitulatif /root/RECAP-INSTALLATION.txt sur la clé et à l'écran : ce qu'il reste à faire.
# Ne fait PAS : installation de Claude Code (nécessite le réseau, faite après le premier démarrage), démarrage de dimotic-ha
# (le compose préinstallé n'est de toute façon pas démarré), ajout du pair sur noisy, jeton MCP.
# =============================================================================
set -euo pipefail

DEV=""; ADRESSE_WG="10.10.10.5/24"; SIMULATION=false; WIFI_SSID=""; WIFI_PAYS="FR"
while [ $# -gt 0 ]; do
  case "$1" in
    --adresse-wg) ADRESSE_WG="$2"; shift ;;
    --simulation) SIMULATION=true ;;
    --wifi-ssid) WIFI_SSID="$2"; shift ;;
    --wifi-pays) WIFI_PAYS="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    /dev/*) DEV="$1" ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { echo "ERREUR : à lancer en root (sudo)." >&2; exit 1; }
[ -n "$DEV" ] || { echo "ERREUR : indiquez le périphérique de la clé (ex : /dev/sdb)." >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_FALBALA="/etc/wireguard/wg0.conf"
etape() { echo; echo "=== $* ==="; }
agir() { if $SIMULATION; then echo "  [simulation] $*"; else "$@"; fi; }

# ---- 1. Contrôles ---------------------------------------------------------------------------------------------------
etape "1/6 Contrôles"
[ -b "$DEV" ] || { echo "ERREUR : $DEV n'est pas un périphérique bloc." >&2; exit 1; }
case "$DEV" in /dev/nvme*|/dev/mmcblk0) echo "ERREUR : $DEV ressemble à un disque système de falbala — refus." >&2; exit 1 ;; esac
[ "$(cat "/sys/block/$(basename "$DEV")/removable" 2>/dev/null || echo 0)" = "1" ] || \
  [ "$(lsblk -dno TRAN "$DEV" 2>/dev/null)" = "usb" ] || { echo "ERREUR : $DEV n'est ni amovible ni USB — refus." >&2; exit 1; }
if findmnt -rn -S "${DEV}1" >/dev/null || findmnt -rn -S "${DEV}2" >/dev/null || findmnt -rn -S "${DEV}p2" >/dev/null; then
  echo "ERREUR : une partition de $DEV est déjà montée (démontez-la : umount ${DEV}*)." >&2; exit 1
fi
P1="${DEV}1"; P2="${DEV}2"; [ -b "$P2" ] || { P1="${DEV}p1"; P2="${DEV}p2"; }
[ -b "$P1" ] && [ -b "$P2" ] || { echo "ERREUR : partitions boot/rootfs introuvables sur $DEV (flashage terminé ?)." >&2; exit 1; }
command -v qemu-aarch64-static >/dev/null || { echo "ERREUR : qemu-aarch64-static absent (sudo apt install qemu-user-static)." >&2; exit 1; }
[ -f "$WG_FALBALA" ] || { echo "ERREUR : $WG_FALBALA introuvable : impossible de reprendre le pair noisy." >&2; exit 1; }
lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL "$DEV"
echo "Adresse WireGuard du RPi3 : $ADRESSE_WG  (vérifiez qu'elle est LIBRE : falbala=10.10.10.2, noisy=.1, noisy2=.3)"
$SIMULATION || { read -rp "Préparer $DEV ? (oui/non) " rep; [ "$rep" = "oui" ] || { echo "Abandon."; exit 1; }; }

ROOTFS="$(mktemp -d /tmp/rpi3-rootfs.XXXXXX)"; BOOTFS="$(mktemp -d /tmp/rpi3-bootfs.XXXXXX)"
nettoyer() {
  set +e
  rm -f "$ROOTFS/usr/bin/qemu-aarch64-static" 2>/dev/null
  if [ -e "$ROOTFS/etc/resolv.conf.rpi3-orig" ] || [ -L "$ROOTFS/etc/resolv.conf.rpi3-orig" ]; then
    rm -f "$ROOTFS/etc/resolv.conf"; mv "$ROOTFS/etc/resolv.conf.rpi3-orig" "$ROOTFS/etc/resolv.conf"
  fi
  for d in dev/pts dev proc sys; do mountpoint -q "$ROOTFS/$d" && umount "$ROOTFS/$d"; done
  sync; mountpoint -q "$ROOTFS" && umount "$ROOTFS"; mountpoint -q "$BOOTFS" && umount "$BOOTFS"
  rmdir "$ROOTFS" "$BOOTFS" 2>/dev/null
}
trap nettoyer EXIT
mount "$P2" "$ROOTFS"; mount "$P1" "$BOOTFS"

[ -f "$ROOTFS/etc/os-release" ] && grep -q 'Debian' "$ROOTFS/etc/os-release" || { echo "ERREUR : pas un système Debian/Raspberry Pi OS." >&2; exit 1; }
PROBE="$ROOTFS/usr/bin/dpkg"; [ -f "$PROBE" ] || PROBE="$ROOTFS/bin/bash"
file -bL "$PROBE" | grep -q aarch64 || { echo "ERREUR : système 32 bits : Claude Code exige du 64 bits (arm64)." >&2; exit 1; }
echo "Wi-Fi déjà configuré dans l'image : $(ls "$ROOTFS"/etc/NetworkManager/system-connections/ 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)"
echo "Système : $(grep PRETTY_NAME "$ROOTFS/etc/os-release" | cut -d= -f2) — arm64 — nom d'hôte : $(cat "$ROOTFS/etc/hostname")"

# ---- 2. Swap --------------------------------------------------------------------------------------------------------
etape "2/6 Swap de 1 Go"
if [ -f "$ROOTFS/etc/dphys-swapfile" ]; then
  agir sed -i -e 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' -e 's/^#\?CONF_MAXSWAP=.*/CONF_MAXSWAP=1024/' "$ROOTFS/etc/dphys-swapfile"
  grep -E '^CONF_(SWAPSIZE|MAXSWAP)' "$ROOTFS/etc/dphys-swapfile" || true
else
  echo "AVERTISSEMENT : /etc/dphys-swapfile absent — swap à régler après le démarrage." >&2
fi

# ---- 3. Chroot qemu : paquets, clés, compte -------------------------------------------------------------------------
etape "3/6 Paquets, clés WireGuard, compte claude (chroot qemu, quelques minutes)"
in_chroot() { LC_ALL=C LANG=C LANGUAGE= chroot "$ROOTFS" /usr/bin/qemu-aarch64-static /bin/bash -c "$1"; }
if ! $SIMULATION; then
  cp /usr/bin/qemu-aarch64-static "$ROOTFS/usr/bin/qemu-aarch64-static"
  for d in dev dev/pts proc sys; do mountpoint -q "$ROOTFS/$d" || mount --bind "/$d" "$ROOTFS/$d"; done
  if [ -e "$ROOTFS/etc/resolv.conf" ] || [ -L "$ROOTFS/etc/resolv.conf" ]; then mv "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/resolv.conf.rpi3-orig"; fi
  cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
  in_chroot "export DEBIAN_FRONTEND=noninteractive; apt-get -y -qq update && apt-get -y -qq install wireguard-tools screen curl autossh jq ca-certificates >/dev/null"
  in_chroot "mkdir -p /etc/wireguard && chmod 700 /etc/wireguard && umask 077 && wg genkey > /etc/wireguard/rpi3.key && wg pubkey < /etc/wireguard/rpi3.key > /etc/wireguard/rpi3.pub"
  in_chroot "id claude >/dev/null 2>&1 || useradd -m -s /bin/bash claude; passwd -l claude >/dev/null; mkdir -p /home/claude/.ssh; [ -f /home/claude/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C 'claude@noisyia' -f /home/claude/.ssh/id_ed25519; chown -R claude:claude /home/claude; chmod 700 /home/claude/.ssh"
else
  echo "  [simulation] apt-get install wireguard-tools screen curl autossh jq ; wg genkey ; useradd claude ; ssh-keygen"
fi

# ---- 3bis. Wi-Fi (facultatif) ---------------------------------------------------------------------------------------
if [ -n "$WIFI_SSID" ]; then
  etape "3bis Wi-Fi « $WIFI_SSID » (pays $WIFI_PAYS)"
  if $SIMULATION; then echo "  [simulation] imager_custom set_wlan"; else
    read -rsp "Mot de passe Wi-Fi de « $WIFI_SSID » (saisie masquée) : " WIFI_PASS; echo
    [ -n "$WIFI_PASS" ] || { echo "ERREUR : mot de passe vide." >&2; exit 1; }
    in_chroot "/usr/lib/raspberrypi-sys-mods/imager_custom set_wlan $(printf '%q' "$WIFI_SSID") $(printf '%q' "$WIFI_PASS") $(printf '%q' "$WIFI_PAYS")"
    unset WIFI_PASS
    ls "$ROOTFS"/etc/NetworkManager/system-connections/ 2>/dev/null | sed 's/^/  connexion : /'
  fi
fi

# ---- 4. WireGuard ---------------------------------------------------------------------------------------------------
etape "4/6 WireGuard (pair noisy repris de falbala, seul 10.10.10.0/24 routé)"
PEER_PUB="$(awk '/^\[Peer\]/{p=1} p&&/^PublicKey/{print $3; exit}' "$WG_FALBALA")"
PEER_END="$(awk '/^\[Peer\]/{p=1} p&&/^Endpoint/{print $3; exit}' "$WG_FALBALA")"
PEER_KA="$(awk '/^\[Peer\]/{p=1} p&&/^PersistentKeepalive/{print $3; exit}' "$WG_FALBALA")"
[ -n "$PEER_PUB" ] && [ -n "$PEER_END" ] || { echo "ERREUR : pair (PublicKey/Endpoint) introuvable dans $WG_FALBALA." >&2; exit 1; }
echo "Pair : $PEER_END  (clé publique ${PEER_PUB:0:8}…)"
if ! $SIMULATION; then
  PRIV="$(cat "$ROOTFS/etc/wireguard/rpi3.key")"
  umask 077
  cat > "$ROOTFS/etc/wireguard/wg0.conf" <<EOF
# RPi3 « noisyia » — Claude Code relié au MCP de noisy2. Généré le $(date +%F) par preparer-rpi3-claude.sh
[Interface]
Address = ${ADRESSE_WG}
PrivateKey = ${PRIV}

[Peer]
# noisy (hub WireGuard)
PublicKey = ${PEER_PUB}
Endpoint = ${PEER_END}
AllowedIPs = 10.10.10.0/24
PersistentKeepalive = ${PEER_KA:-25}
EOF
  chmod 600 "$ROOTFS/etc/wireguard/wg0.conf"
  in_chroot "systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true"
fi

# ---- 5. Dossier de l'agent + tunnel ---------------------------------------------------------------------------------
etape "5/6 Dossier de l'agent et tunnel vers le MCP de noisy2"
AGENT="$ROOTFS/dimotic-ha-addons/agent-ha"
if ! $SIMULATION; then
  mkdir -p "$AGENT"
  cp -r "$REPO/applications/ia/agent/claude-md" "$AGENT/claude-md"
  [ -f "$REPO/applications/ia/agent/claude-md/sites/noisy2.md" ] && cp "$REPO/applications/ia/agent/claude-md/sites/noisy2.md" "$AGENT/site.md"
  umask 077
  cat > "$AGENT/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "dimotic": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer __JETON_MCP_NOISY2__" }
    }
  }
}
EOF
  cat > "$ROOTFS/usr/local/bin/tunnel-mcp-noisy2.sh" <<'EOF'
#!/bin/sh
# Tunnel vers le MCP de dimotic-ha de noisy2 (écoute 127.0.0.1:8765 sur noisy2) — à lancer en tant que « claude ».
exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new \
  -L 8765:127.0.0.1:8765 claude@10.10.10.3
EOF
  chmod 755 "$ROOTFS/usr/local/bin/tunnel-mcp-noisy2.sh"
  cat > "$ROOTFS/etc/systemd/system/tunnel-mcp-noisy2.service" <<'EOF'
[Unit]
Description=Tunnel SSH vers le MCP de noisy2 (NON activé : à lancer à la main au début)
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Service]
User=claude
ExecStart=/usr/local/bin/tunnel-mcp-noisy2.sh
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
  in_chroot "chown -R claude:claude /dimotic-ha-addons/agent-ha"
fi

# ---- 6. Récapitulatif -----------------------------------------------------------------------------------------------
etape "6/6 Récapitulatif"
if $SIMULATION; then echo "  [simulation] récapitulatif"; exit 0; fi
WG_PUB="$(cat "$ROOTFS/etc/wireguard/rpi3.pub")"
SSH_PUB="$(cat "$ROOTFS/home/claude/.ssh/id_ed25519.pub")"
RECAP="$ROOTFS/root/RECAP-INSTALLATION.txt"
cat > "$RECAP" <<EOF
RPi3 « noisyia » préparé le $(date '+%F %T') par preparer-rpi3-claude.sh

À FAIRE (dans l'ordre) :
1. Sur NOISY (hub WireGuard 10.10.10.1), ajouter ce pair :
     [Peer]
     PublicKey = ${WG_PUB}
     AllowedIPs = ${ADRESSE_WG%/*}/32
2. Sur NOISY2, ajouter dans /home/claude/.ssh/authorized_keys (compte claude, sans sudo) :
     ${SSH_PUB}
3. Démarrer le RPi3 et me donner son adresse IP (Claude fera l'installation de Claude Code, le test du tunnel et le .mcp.json).
4. Jeton MCP de noisy2 à mettre dans /dimotic-ha-addons/agent-ha/.mcp.json (remplacer __JETON_MCP_NOISY2__).
5. Au premier lancement de « claude » : /login, confiance du dossier, approbation du serveur MCP « dimotic ».
EOF
cat "$RECAP"
echo
echo "Terminé. La clé est démontée automatiquement : retirez-la et mettez-la dans le RPi3."
