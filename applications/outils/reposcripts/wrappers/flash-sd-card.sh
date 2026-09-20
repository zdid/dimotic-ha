#!/bin/bash
# Généré par l'application Outils — PHASE 2/2 : écrit sur une carte SD/clé USB physique l'image déjà
# préparée par le script "Préparer une image carte SD/clé USB Raspberry Pi" (phase 1/2), puis
# enchaîne agrandissement du rootfs, clé SSH dimotic-ha, paquets, apps et WiFi via prepare-sd-card.sh.
#
# ⭐ 18/09/2026 — TÉLÉCHARGEMENT AUTONOME : ce fichier est une archive auto-extractible, pas un
# simple script texte — elle embarque déjà tout ce qu'il faut (scripts/flash-sd-card.js +
# prepare-sd-card.sh, js-yaml, la clé SSH publique dimotic-ha, compose.deploy.yaml, le device-agent
# teleinfo). PAS besoin de cloner le dépôt : lancez-le directement depuis votre dossier de
# téléchargements (bash flash-sd-card.sh). Seuls des paquets système doivent déjà être installés sur
# CETTE machine (Node.js, qemu-user-static, parted, e2fsprogs) — voir la vérification ci-dessous, qui
# vous indique la commande exacte si besoin.
#
# @outils:bundle applications/outils/reposcripts/scripts/flash-sd-card.js => scripts/flash-sd-card.js
# @outils:bundle applications/outils/reposcripts/scripts/prepare-sd-card.sh => scripts/prepare-sd-card.sh
# @outils:bundle applications/outils/node_modules/js-yaml => node_modules/js-yaml
# @outils:bundle data/core/ssh/id_ed25519.pub
# @outils:bundle compose.deploy.yaml
# @outils:bundle applications/teleinfo/device-agent
#
# ⭐ 18/09/2026 (demande explicite, "où est la limite entre les 2 phases ?") — MACHINE est
# DÉSORMAIS LA SEULE information à redonner ici : le script de préparation (phase 1/2) a persisté
# le profil complet (modèle, distro, hostname, utilisateur, mot de passe, clé perso, paquets, apps)
# à côté de l'image, retrouvé automatiquement via MACHINE. Rien à ressaisir. La vraie limite entre
# les deux phases n'est pas "quelles informations", c'est "carte/clé physiquement branchée ou non" —
# WiFi est demandé ICI (pas en phase 1) car appliqué sur le rootfs réel, jamais sur bootfs.
#
# WIFI_SSID vide = WiFi non configuré (machine cible sur Ethernet). Renseigné = WiFi configuré via le
# mécanisme officiel Raspberry Pi Imager (imager_custom set_wlan) lors de cette phase de flashage.
#
# @outils:hint MACHINE = DOIT être IDENTIQUE à celui saisi dans le script de préparation (phase 1/2) — retrouve automatiquement tout le reste du profil, rien d'autre à ressaisir.
# @outils:hint WIFI_SSID = Laisser vide si la machine cible est sur Ethernet.
# @outils:hint WIFI_COUNTRY = Code pays régulateur (ex: FR) — recommandé dès qu'un SSID est renseigné, sinon le WiFi peut rester bloqué.

set -euo pipefail

# ⭐ 18/09/2026 — double mode, voir le commentaire identique dans prepare-sd-card.sh (phase 1/2).
# ⭐ 20/09/2026 — moteur déplacé depuis scripts/ racine vers applications/outils/reposcripts/scripts/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/flash-sd-card.js" ]; then
  ENGINE_JS="$SCRIPT_DIR/scripts/flash-sd-card.js"
  REPO_ROOT="$SCRIPT_DIR"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  ENGINE_JS="$REPO_ROOT/applications/outils/reposcripts/scripts/flash-sd-card.js"
fi
if [ -z "$REPO_ROOT" ] || [ ! -f "$ENGINE_JS" ]; then
  echo "ERREUR: scripts/flash-sd-card.js introuvable — ce fichier a-t-il été modifié/déplacé hors de son archive ? Retéléchargez-le depuis l'app Outils." >&2
  exit 1
fi

# --- Vérification des prérequis de CETTE machine (celle qui flashe la carte, pas le Raspberry Pi
# cible), AVANT toute action — message actionnable plutôt qu'un échec en cours d'exécution. ---
MISSING_PREREQS=()
command -v node >/dev/null 2>&1 || MISSING_PREREQS+=("nodejs")
command -v qemu-arm-static >/dev/null 2>&1 || MISSING_PREREQS+=("qemu-user-static")
command -v parted >/dev/null 2>&1 || MISSING_PREREQS+=("parted")
command -v mkfs.ext4 >/dev/null 2>&1 || MISSING_PREREQS+=("e2fsprogs")
if [ ${#MISSING_PREREQS[@]} -gt 0 ]; then
  echo "Paquet(s) manquant(s) sur CETTE machine (pas sur le Raspberry Pi cible) :" >&2
  echo "  sudo apt update && sudo apt install -y ${MISSING_PREREQS[*]}" >&2
  echo "Puis relancez ce script." >&2
  exit 1
fi

MACHINE="__MACHINE__"
WIFI_SSID="__WIFI_SSID__"
WIFI_PASSWORD="__WIFI_PASSWORD__"
WIFI_COUNTRY="__WIFI_COUNTRY__"

PROFILE_FILE=$(mktemp --suffix=.yaml)
trap 'rm -f "$PROFILE_FILE"' EXIT

cat > "$PROFILE_FILE" <<EOF
machine: ${MACHINE}
EOF

if [ -n "$WIFI_SSID" ]; then
  cat >> "$PROFILE_FILE" <<EOF
wifi:
  ssid: ${WIFI_SSID}
  password: ${WIFI_PASSWORD}
  country: ${WIFI_COUNTRY}
EOF
fi

echo "--- Profil généré ($PROFILE_FILE), dépôt détecté: $REPO_ROOT ---"
cat "$PROFILE_FILE"
echo "--- (le reste du profil est retrouvé automatiquement depuis la phase 1/2, voir MACHINE ci-dessus) ---"

sudo node "$ENGINE_JS" --flash "$PROFILE_FILE"
