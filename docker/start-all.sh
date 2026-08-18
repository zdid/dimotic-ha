#!/usr/bin/env bash
# =============================================================================
# Cycle de test "HA vierge" — étape 2/2 : relance HA, intégration MQTT, token,
# puis relance de tout le reste. Voir docker/stop-all.sh pour l'étape 1.
#
# Déroulé :
#   1. Démarre homeassistant (ha2) seul — config vierge, prêt pour l'assistant
#      de configuration initiale.
#   2. Si aucun token n'est passé en argument, attend que tu fasses l'onboarding
#      dans le navigateur (créer le compte, Paramètres > Compte > Sécurité >
#      Jetons d'accès longue durée) puis le demande interactivement.
#   3. Ajoute l'intégration MQTT directement dans le stockage interne de HA
#      (.storage/core.config_entries, HA arrêté le temps de l'édition) — évite
#      de le faire à la main dans l'UI à chaque cycle. Best-effort : format de
#      stockage interne non documenté par HA, peut casser à une future version ;
#      idempotent (ne fait rien si l'intégration existe déjà), et l'ajout manuel
#      reste toujours possible si ça échoue.
#   4. Relance homeassistant, puis mosquitto (ha2).
#   5. Met à jour le long-lived token à ses 3 emplacements (local, ha2, orangepi).
#   6. Demande "essai" (dimotic-ha en local, tsx watch) ou "réel" (dimotic-ha sur
#      ha2+orangepi, Docker) — un seul des deux, jamais les deux en même temps
#      (même bridgeInstance MQTT sur le même broker -> collision "session taken
#      over" déjà rencontrée cette session). Relance zigbee2mqtt (ha2) dans les
#      deux cas.
#   7. Vérifie : pas de tempête de reconnexion MQTT, rfxcom bien désactivé sur ha2
#      (mode "réel" uniquement — pas de conteneur à inspecter en mode "essai").
#
# Usage :
#   ./docker/start-all.sh                    # demande le token puis essai/réel, de manière interactive
#   ./docker/start-all.sh <long_lived_token>  # token déjà en main, demande quand même essai/réel
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # racine du projet

HA2_HOST="${HA2_HOST:-192.168.1.51}"
ORANGEPI_HOST="${ORANGEPI_HOST:-192.168.1.32}"
HA_CONFIG_DIR="/docker/homeassistant/config"
LOCAL_CONFIG="data/core/config.yaml"
HA2_CONFIG="/docker/dimotic-ha/data/core/config.yaml"
ORANGEPI_CONFIG="/docker/dimotic-ha/data/core/config.yaml"

# Identité SSH par défaut de l'utilisateur qui lance le script (didier), sudo NOPASSWD requis
# sur les deux machines — voir README/CLAUDE.md ou :
#   echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/$(whoami)-nopasswd
#   sudo chmod 0440 /etc/sudoers.d/$(whoami)-nopasswd
ssh_ha2() { ssh -o ConnectTimeout=10 "root@${HA2_HOST}" "$@"; }
ssh_orangepi() { ssh -o ConnectTimeout=10 "root@${ORANGEPI_HOST}" "$@"; }

echo "=== 1/7 Démarrage de homeassistant (ha2), config vierge ==="
ssh_ha2 "sudo docker start homeassistant"
echo "    -> http://${HA2_HOST}:8123 : crée le compte, puis Paramètres > Compte > Sécurité >"
echo "       Jetons d'accès longue durée, pour générer le long-lived token."

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  read -r -p "Colle le long-lived token une fois généré : " TOKEN
fi
if [ -z "$TOKEN" ]; then
  echo "Aucun token fourni, abandon." >&2
  exit 1
fi

echo "=== 2/7 Intégration MQTT (best-effort, HA arrêté le temps de l'édition) ==="
ssh_ha2 "sudo docker stop homeassistant"
ssh_ha2 "sudo python3 - <<'PYEOF'
import json, secrets, datetime

path = '${HA_CONFIG_DIR}/.storage/core.config_entries'
with open(path) as f:
    d = json.load(f)

entries = d['data']['entries']
if any(e['domain'] == 'mqtt' for e in entries):
    print('MQTT déjà présent, rien à faire.')
else:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    entries.append({
        'created_at': now,
        'data': {'broker': '${HA2_HOST}', 'port': 1883, 'protocol': '5', 'transport': 'tcp'},
        'disabled_by': None,
        'discovery_keys': {},
        'domain': 'mqtt',
        'entry_id': secrets.token_hex(16),
        'minor_version': 1,
        'modified_at': now,
        'options': {
            'birth_message': {'payload': 'online', 'qos': 0, 'retain': True, 'topic': 'homeassistant/status'},
            'discovery': True,
            'discovery_prefix': 'homeassistant',
            'discovery_qos': 0,
            'will_message': {'payload': 'offline', 'qos': 0, 'retain': True, 'topic': 'homeassistant/status'}
        },
        'pref_disable_new_entities': False,
        'pref_disable_polling': False,
        'source': 'user',
        'subentries': [],
        'title': '${HA2_HOST}',
        'unique_id': None,
        'version': 2
    })
    with open(path, 'w') as f:
        json.dump(d, f)
    print('Intégration MQTT ajoutée.')
PYEOF" || echo "    ⚠️  Échec de l'injection MQTT — à ajouter manuellement dans l'UI (Paramètres > Appareils et services)."

echo "=== 3/7 Relance de homeassistant (ha2) ==="
ssh_ha2 "sudo docker start homeassistant"

echo "=== 4/7 Relance de mosquitto (ha2) ==="
ssh_ha2 "sudo docker start mosquitto"

echo "=== 5/7 Mise à jour du token (local, ha2, orangepi) ==="
sed -i -E "s|^(\s*token: ).*|\1${TOKEN}|" "$LOCAL_CONFIG"
ssh_ha2 "sudo sed -i -E 's|^(\s*token: ).*|\1${TOKEN}|' ${HA2_CONFIG}"
ssh_orangepi "sudo sed -i -E 's|^(\s*token: ).*|\1${TOKEN}|' ${ORANGEPI_CONFIG}"

echo "=== 6/7 Relance zigbee2mqtt (ha2) ==="
ssh_ha2 "sudo docker start zigbee2mqtt"

MODE=""
while [ "$MODE" != "essai" ] && [ "$MODE" != "reel" ]; do
  read -r -p "dimotic-ha : essai (local) ou réel (ha2+orangepi, Docker) ? [essai/reel] " reply
  case "$reply" in
    essai|Essai|ESSAI) MODE="essai" ;;
    reel|réel|Reel|Réel|REEL|RÉEL) MODE="reel" ;;
    *) echo "Réponds 'essai' ou 'reel'." ;;
  esac
done

if [ "$MODE" = "essai" ]; then
  echo "=== 6bis/7 Relance de dimotic-ha en local (tsx watch) ==="
  LOG_FILE="logs/local-dimotic-ha-console.log"
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  > "$LOG_FILE"
  (cd applications/core && CONFIG_PATH=../../data/core/config.yaml nohup npm exec tsx watch src/index.ts >> "../../${LOG_FILE}" 2>&1 &)
  sleep 3
  if pgrep -f "tsx watch src/index.ts" > /dev/null; then
    echo "Démarré (PID $(pgrep -f 'tsx watch src/index.ts' | head -1)). Log : tail -f ${LOG_FILE}"
  else
    echo "⚠️  Le process local ne semble pas avoir démarré — voir ${LOG_FILE}" >&2
  fi

  echo "=== 7/7 Terminé (mode essai) === dimotic-ha tourne en local uniquement."
else
  echo "=== 6bis/7 Relance de dimotic-ha (ha2, orangepi) ==="
  ssh_ha2 "sudo docker start dimotic-ha"
  ssh_orangepi "sudo docker start dimotic-ha"

  echo "=== 7/7 Vérification (10s) ==="
  sleep 10
  DISCONNECTS_HA2=$(ssh_ha2 "sudo docker logs --since 15s dimotic-ha 2>&1" | grep -c "Bridge déconnecté" || true)
  DISCONNECTS_ORANGEPI=$(ssh_orangepi "sudo docker logs --since 15s dimotic-ha 2>&1" | grep -c "Bridge déconnecté" || true)
  RFXCOM_STATUS=$(ssh_ha2 "sudo docker logs dimotic-ha 2>&1" | grep 'Liste des applications' | tail -1)

  echo "Déconnexions MQTT (15s) : ha2=${DISCONNECTS_HA2}, orangepi=${DISCONNECTS_ORANGEPI} (0 attendu des deux côtés)"
  echo "Applications ha2 : ${RFXCOM_STATUS}"
  if [ "$DISCONNECTS_HA2" != "0" ] || [ "$DISCONNECTS_ORANGEPI" != "0" ]; then
    echo "⚠️  Tempête de reconnexion détectée — vérifier les bridgeInstance MQTT (collision possible)."
  fi

  echo
  echo "=== Terminé (mode réel) ==="
fi
