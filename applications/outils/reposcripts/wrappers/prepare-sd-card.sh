#!/bin/bash
# Généré par l'application Outils — PHASE 1/2 : prépare une image Raspberry Pi OS complète (image
# officielle + SSH + utilisateur) SANS écrire sur une carte/clé physique. Aucun périphérique requis.
#
# ⭐ 18/09/2026 — TÉLÉCHARGEMENT AUTONOME : ce fichier est une archive auto-extractible, pas un
# simple script texte — elle embarque déjà scripts/flash-sd-card.js et le module js-yaml dont il a
# besoin. PAS besoin de cloner le dépôt dimotic-ha ni d'installer de module npm : lancez-le
# directement depuis votre dossier de téléchargements (bash prepare-sd-card.sh). Seul Node.js
# lui-même doit déjà être installé sur CETTE machine (voir la vérification ci-dessous) — le script
# vous indique la commande exacte si besoin.
#
# @outils:bundle applications/outils/reposcripts/scripts/flash-sd-card.js => scripts/flash-sd-card.js
# @outils:bundle applications/outils/node_modules/js-yaml => node_modules/js-yaml
#
# DISTRO : "bookworm-lite" par défaut — ⭐ 18/09/2026, bug réel constaté : "trixie-lite" (32 ET
# 64 bits) utilise cloud-init (init_format="cloudinit-rpi") au catalogue officiel Raspberry Pi
# Imager, alors que ce script ne gère que l'ancien mécanisme userconf.txt/fichier "ssh" — trixie-lite
# échoue donc systématiquement ("... non géré par ce script pour l'instant"), quel que soit le
# modèle de Pi. "bookworm-lite" (Legacy, mises à jour de sécurité uniquement) reste seul compatible
# pour l'instant — "trixie-lite" resterait un choix valide seulement si ce script gérait cloud-init
# un jour (pas fait à ce jour).
#
# PERSONAL_SSH_KEY : case à cocher — coché, votre clé SSH personnelle (~/.ssh/id_rsa.pub) sera aussi
# autorisée sur la carte, en plus de la clé dimotic-ha. La valeur transmise au script cœur est déjà
# le chemin littéral "~/.ssh/id_rsa.pub" (pas un champ texte à remplir) : c'est flash-sd-card.js qui
# résout ensuite ce "~" vers le VRAI utilisateur qui lance ce script (via sudo), pas vers root.
#
# Paquets/apps installés SYSTÉMATIQUEMENT, sans case à cocher (voir prepare-sd-card.sh, le script
# cœur, pas celui-ci) : Docker CE (script officiel get.docker.com), /docker/dimotic-ha/ (compose.yaml
# provisionné, PAS démarré), Node.js+npm, paquets npm globaux serialport+mqtt, paquet apt
# mosquitto-clients (mosquitto_pub/mosquitto_sub), build-essential (nécessaire à la compilation de
# serialport). Tout ceci est installé à l'étape 2/2 (flashage), pas ici.
#
# ⚠️  Une fois ce script terminé, l'image est prête mais AUCUNE carte/clé n'a encore été écrite —
# passer ensuite au script "Flasher une carte SD/clé USB Raspberry Pi" (phase 2/2), avec EXACTEMENT
# la même valeur de MACHINE (elle sert à retrouver l'image préparée par cette étape).
#
# @outils:hint MACHINE = Nom qui identifie cette carte — DOIT être IDENTIQUE à celui saisi ensuite dans le script de flashage (phase 2/2), c'est lui qui permet de retrouver l'image préparée ici.
# @outils:select PI_MODEL = Raspberry Pi 1, Raspberry Pi Zero, Raspberry Pi Zero W, Raspberry Pi Zero 2 W, Raspberry Pi 2, Raspberry Pi 3, Raspberry Pi 4, Raspberry Pi 400, Raspberry Pi 5, Raspberry Pi 500
# @outils:hint PI_MODEL = Doit correspondre exactement à un device du catalogue Raspberry Pi Imager — vérifier sur https://downloads.raspberrypi.org/os_list_imagingutility_v3.json en cas de doute.
# @outils:select DISTRO = bookworm-lite, trixie-lite
# @outils:default DISTRO = bookworm-lite
# @outils:hint DISTRO = bookworm-lite = seul compatible actuellement (trixie-lite utilise cloud-init, non géré par ce script — échoue systématiquement, quel que soit le modèle de Pi).
# @outils:checklist PERSONAL_SSH_KEY = ~/.ssh/id_rsa.pub
# @outils:hint PERSONAL_SSH_KEY = Coché = votre clé SSH personnelle sera aussi autorisée sur la carte, en plus de la clé dimotic-ha — résolue automatiquement pour l'utilisateur qui lance ce script (pas de chemin à saisir).
# @outils:checklist PACKAGES = nano, htop, tmux, curl
# @outils:hint PACKAGES = build-essential, nodejs, mosquitto-clients sont déjà installés systématiquement (voir en-tête), inutile de les ajouter ici.
# @outils:checklist APPS = teleinfo
# @outils:hint APPS = Seule 'teleinfo' est câblée pour l'instant dans prepare-sd-card.sh (voir app_local_dir/app_remote_dir en tête de ce script). Docker/dimotic-ha sont provisionnés automatiquement (voir en-tête), pas besoin de les lister ici.

set -euo pipefail

# ⭐ 18/09/2026 — double mode : si scripts/flash-sd-card.js est juste à côté de CE fichier (cas
# normal, archive auto-extractible embarquant déjà tout ce qu'il faut), on l'utilise directement ;
# sinon repli sur la détection historique d'un clone du dépôt (utile en développement, lancé
# directement depuis applications/outils/reposcripts/wrappers/ sans passer par l'app Outils) — le
# moteur vit alors dans applications/outils/reposcripts/scripts/ (⭐ 20/09/2026, déplacé depuis
# scripts/ racine, voir CHANGELOG).
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

# --- Vérification des prérequis de CETTE machine (celle qui prépare l'image), AVANT toute action —
# message actionnable plutôt qu'un échec en cours d'exécution. ---
MISSING_PREREQS=()
command -v node >/dev/null 2>&1 || MISSING_PREREQS+=("nodejs")
command -v xz >/dev/null 2>&1 || MISSING_PREREQS+=("xz-utils")
if [ ${#MISSING_PREREQS[@]} -gt 0 ]; then
  echo "Paquet(s) manquant(s) sur CETTE machine (pas sur le Raspberry Pi cible) :" >&2
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
# ⭐ 18/09/2026, bug réel corrigé — résolu ICI (bash, AVANT sudo, $HOME = le vrai utilisateur qui
# lance ce script) plutôt que de compter sur flash-sd-card.js pour deviner l'utilisateur une fois
# déjà root sous sudo (SUDO_UID/getent, constaté peu fiable en conditions réelles : résolvait vers
# /root au lieu de /home/<user>). Le profil généré contient donc directement le chemin absolu réel,
# vérifiable à l'œil dans l'affichage du profil ci-dessous, avant exécution.
[ -n "$PERSONAL_SSH_KEY" ] && PERSONAL_SSH_KEY="${PERSONAL_SSH_KEY/#\~/$HOME}"
PACKAGES="__PACKAGES__"
APPS="__APPS__"

PROFILE_FILE=$(mktemp --suffix=.yaml)
trap 'rm -f "$PROFILE_FILE"' EXIT

cat > "$PROFILE_FILE" <<EOF
machine: ${MACHINE}
piModel: ${PI_MODEL}
distro: ${DISTRO}
hostname: ${HOSTNAME_VALUE}
user: ${SSH_USER}
password: ${SSH_PASSWORD}
personalSshKeys: [${PERSONAL_SSH_KEY}]
packages: [${PACKAGES}]
apps: [${APPS}]
EOF

echo "--- Profil généré ($PROFILE_FILE), dépôt détecté: $REPO_ROOT ---"
cat "$PROFILE_FILE"
echo "---"

sudo node "$ENGINE_JS" --prepare "$PROFILE_FILE"
