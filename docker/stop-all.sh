#!/usr/bin/env bash
# =============================================================================
# Cycle de test "HA vierge" — étape 1/2 : tout arrêter + effacer la config HA.
# Voir docker/start-all.sh pour la suite (relance + token + intégration MQTT ; choix
# essai local / réel distant pour dimotic-ha).
#
# Arrête (portainer/portainer-agent jamais touchés, hors cycle de test) :
#   local    : dimotic-ha (tsx watch, si en cours — évite toute collision de
#              bridgeInstance MQTT avec une instance Docker restée up)
#   ha2      : dimotic-ha, zigbee2mqtt, mosquitto, homeassistant
#   orangepi : dimotic-ha
# Puis supprime /docker/homeassistant/config sur ha2 (⚠️ DESTRUCTIF, confirmation demandée)
# — c'est le vrai chemin monté par /docker/homeassistant/compose.yaml, PAS
# /home/claude/stack/ha-config (piège rencontré le 09/08/2026, vérifié avec
# `docker inspect homeassistant --format '{{.Mounts}}'` avant de committer ce script).
#
# Usage :
#   ./docker/stop-all.sh          # demande confirmation avant l'étape destructive
#   ./docker/stop-all.sh --yes    # pas de confirmation
# =============================================================================
set -euo pipefail

HA2_HOST="${HA2_HOST:-192.168.1.51}"
ORANGEPI_HOST="${ORANGEPI_HOST:-192.168.1.32}"
HA_CONFIG_DIR="/docker/homeassistant/config"

# Identité SSH par défaut de l'utilisateur qui lance le script (didier), sudo NOPASSWD requis
# sur les deux machines — voir README/CLAUDE.md ou :
#   echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/$(whoami)-nopasswd
#   sudo chmod 0440 /etc/sudoers.d/$(whoami)-nopasswd
ssh_ha2() { ssh -o ConnectTimeout=10 "root@${HA2_HOST}" "$@"; }
ssh_orangepi() { ssh -o ConnectTimeout=10 "root@${ORANGEPI_HOST}" "$@"; }

SKIP_CONFIRM=false
for arg in "$@"; do
  [ "$arg" = "--yes" ] && SKIP_CONFIRM=true
done

echo "=== 1/4 Arrêt de dimotic-ha en local (tsx watch), si en cours ==="
if pkill -f "tsx watch src/index.ts" 2>/dev/null; then
  echo "Instance locale arrêtée."
else
  echo "Aucune instance locale trouvée (déjà arrêtée ?)."
fi

echo "=== 2/4 Arrêt ha2 (dimotic-ha, zigbee2mqtt, mosquitto, homeassistant) ==="
ssh_ha2 "sudo docker stop dimotic-ha zigbee2mqtt mosquitto homeassistant"

echo "=== 3/4 Arrêt orangepi (dimotic-ha) ==="
ssh_orangepi "sudo docker stop dimotic-ha"

echo "=== 4/4 Suppression de ${HA_CONFIG_DIR} (ha2) ==="
if [ "$SKIP_CONFIRM" = false ]; then
  read -r -p "⚠️  Supprime définitivement ${HA_CONFIG_DIR} sur ha2 — confirmer (o/N) ? " reply
  case "$reply" in
    o|O|oui|Oui) ;;
    *) echo "Annulé (tout reste arrêté, rien de supprimé)."; exit 1 ;;
  esac
fi
ssh_ha2 "sudo rm -rf ${HA_CONFIG_DIR} && echo 'Répertoire config supprimé.'"

echo
echo "=== Terminé === Tout est arrêté (local + ha2 + orangepi), config HA effacée."
echo "    Suite : ./docker/start-all.sh"
