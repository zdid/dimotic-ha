#!/usr/bin/env bash
# Script agent ESPHome, à installer sur la machine qui héberge le conteneur esphome :
#   ~/bin/espdisplay-agent-run.sh  (chmod +x)
# Appelé par SSH par l'application espdisplay (EspDisplayService.runPipelineRemote), avec la clé
# SSH unique de dimotic-ha (⭐ 29/09/2026, spec espdisplay v1.3) :
#   espdisplay-agent-run.sh <plan|--all> [conteneur] [dossier config] [python] [script]
# Compatibilité : appelé sans argument par une ancienne commande forcée (clé dédiée), le plan est lu
# dans $SSH_ORIGINAL_COMMAND.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../ownCloud/dimotic-ha/applications/haplan/tools" 2>/dev/null \
  || cd /home/didier/ownCloud/dimotic-ha/applications/haplan/tools

arg="${1:-${SSH_ORIGINAL_COMMAND:-}}"
container="${2:-esphome}"
configdir="${3:-/docker/esphome/config}"
python="${4:-python3}"
script="${5:-generate_esphome_floorplan.py}"
if [ -z "$arg" ] || [ "${#arg}" -gt 200 ]; then
  echo "Argument invalide (vide ou trop long)" >&2
  exit 2
fi

exec "$python" "$script" "$arg" --compile --esphome-container "$container" --esphome-config-dir "$configdir"
