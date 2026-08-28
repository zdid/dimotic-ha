#!/usr/bin/env bash
# =============================================================================
# Maintenance ha2 (⭐ 28/08/2026) : réorganisation de l'arborescence docker
# Home Assistant + Mosquitto, qui était imbriquée par erreur
# (/docker/homeassistant/{homeassistant,mosquitto}/ — un défaut de config
# erroné, voir schema.ts#haStackTargetSchema) au lieu d'être à plat comme
# toute autre application du projet (/docker/<app>/) :
#   /docker/homeassistant/homeassistant/  ->  /docker/homeassistant/
#   /docker/homeassistant/mosquitto/      ->  /docker/mosquitto/
#
# Pendant l'opération, tout ce qui parle à mosquitto/HA sur le site doit être
# silencieux (stfort, orangepi, ha2) — sinon reconnexions/erreurs pendant la
# coupure. Ce script coordonne l'arrêt, la réorganisation, puis la relance
# dans l'ordre demandé (mosquitto D'ABORD au redémarrage — sa config
# `persistence false` veut dire qu'il ne rejoue rien, tout ce qui se
# connecterait avant lui échouerait/reconnecterait pour rien).
#
# Usage (à faire les trois dans l'ordre, à ton rythme) :
#   ./docker/flatten-ha-maintenance.sh stop      # arrête tout (stfort, orangepi, ha2)
#   ./docker/flatten-ha-maintenance.sh flatten   # sauvegarde + réorganise homeassistant/mosquitto (ha2)
#   ./docker/flatten-ha-maintenance.sh start     # relance tout : mosquitto, puis homeassistant, puis le reste
#
# Prérequis : accès SSH root@ direct déjà en place vers les 3 machines (identité déjà utilisée
# pendant la session du 28/08/2026 — mêmes clés que docker/start-all.sh / stop-all.sh).
# =============================================================================
set -euo pipefail

STFORT_HOST="${STFORT_HOST:-192.168.1.53}"
ORANGEPI_HOST="${ORANGEPI_HOST:-192.168.1.130}"
HA2_HOST="${HA2_HOST:-192.168.1.51}"

ssh_stfort()   { ssh -o ConnectTimeout=10 "root@${STFORT_HOST}" "$@"; }
ssh_orangepi() { ssh -o ConnectTimeout=10 "root@${ORANGEPI_HOST}" "$@"; }
ssh_ha2()      { ssh -o ConnectTimeout=10 "root@${HA2_HOST}" "$@"; }

CMD="${1:-}"

case "$CMD" in
  stop)
    echo "=== 1/7 stfort : service dimotic (legacy) ==="
    ssh_stfort "systemctl stop dimotic"

    echo "=== 2/7 stfort : docker dimotic-ha ==="
    ssh_stfort "docker stop dimotic-ha"

    echo "=== 3/7 orangepi : docker dimotic-ha ==="
    ssh_orangepi "docker stop dimotic-ha"

    echo "=== 4/7 ha2 : docker dimotic-ha ==="
    ssh_ha2 "docker stop dimotic-ha"

    echo "=== 5/7 ha2 : docker zigbee2mqtt ==="
    ssh_ha2 "docker stop zigbee2mqtt"

    echo "=== 6/7 ha2 : docker homeassistant ==="
    ssh_ha2 "docker stop homeassistant"

    echo "=== 7/7 ha2 : docker mosquitto ==="
    ssh_ha2 "docker stop mosquitto"

    echo
    echo "=== Tout est arrêté === Suite : ./docker/flatten-ha-maintenance.sh flatten"
    ;;

  flatten)
    echo "=== Vérification : homeassistant et mosquitto bien arrêtés sur ha2 ==="
    RUNNING=$(ssh_ha2 "docker ps --filter name=homeassistant --filter name=mosquitto --format '{{.Names}}'")
    if [ -n "$RUNNING" ]; then
      echo "⚠️  Encore en cours d'exécution : ${RUNNING} — lance d'abord '$0 stop'." >&2
      exit 1
    fi

    echo "=== Sauvegarde avant réorganisation ==="
    ssh_ha2 "tar czf /docker/_backup_pre_flatten_\$(date +%Y-%m-%d).tar.gz -C /docker homeassistant && ls -lh /docker/_backup_pre_flatten_\$(date +%Y-%m-%d).tar.gz"

    echo "=== Réorganisation /docker/homeassistant/{homeassistant,mosquitto} -> /docker/{homeassistant,mosquitto} ==="
    ssh_ha2 "
      set -e
      mv /docker/homeassistant/mosquitto /docker/mosquitto
      mv /docker/homeassistant/homeassistant /docker/homeassistant_tmp
      rmdir /docker/homeassistant
      mv /docker/homeassistant_tmp /docker/homeassistant
      echo 'Réorganisation terminée :'
      ls -d /docker/homeassistant /docker/mosquitto
    "

    echo
    echo "=== Terminé === Suite : ./docker/flatten-ha-maintenance.sh start"
    ;;

  start)
    # mosquitto et homeassistant ont changé de répertoire (flatten ci-dessus) : on les relance
    # via `docker compose up -d` depuis leur NOUVEAU chemin (recrée le conteneur avec le bon
    # point de montage) — un simple `docker start <nom>` réutiliserait l'ANCIEN chemin absolu
    # enregistré à la création du conteneur, qui n'existe plus après le déplacement (risque de
    # recréation silencieuse d'un dossier vide par Docker — piège déjà rencontré le 09/08/2026,
    # voir commentaire de docker/stop-all.sh). Les autres conteneurs n'ont pas bougé : `docker
    # start` par nom suffit pour eux.
    echo "=== 1/7 ha2 : mosquitto (obligatoire en premier — non persistant) ==="
    ssh_ha2 "cd /docker/mosquitto && docker compose up -d"

    echo "=== 2/7 ha2 : homeassistant ==="
    ssh_ha2 "cd /docker/homeassistant && docker compose up -d"

    echo "=== 3/7 ha2 : dimotic-ha ==="
    ssh_ha2 "docker start dimotic-ha"

    echo "=== 4/7 ha2 : zigbee2mqtt ==="
    ssh_ha2 "docker start zigbee2mqtt"

    echo "=== 5/7 orangepi : dimotic-ha ==="
    ssh_orangepi "docker start dimotic-ha"

    echo "=== 6/7 stfort : dimotic-ha ==="
    ssh_stfort "docker start dimotic-ha"

    echo "=== 7/7 stfort : service dimotic (legacy) ==="
    ssh_stfort "systemctl start dimotic"

    echo
    echo "=== Terminé === Vérifie : docker ps sur les 3 machines, logs HA/mosquitto,"
    echo "    absence de tempête de reconnexion MQTT (voir docker/start-all.sh, étape 7/7,"
    echo "    pour l'idée du grep 'Bridge déconnecté')."
    ;;

  *)
    echo "Usage : $0 {stop|flatten|start}" >&2
    exit 1
    ;;
esac
