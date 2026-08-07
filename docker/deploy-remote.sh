#!/usr/bin/env bash
# =============================================================================
# Déploie la dernière image Docker Hub (zdid2/dimotic-ha) sur une machine cible
# déjà installée (voir compose.deploy.yaml) — typiquement `ha2`, mais tout hôte
# suivant la même convention (/docker/dimotic-ha, volume nommé `stack_app-code`)
# fonctionne via les variables d'environnement ci-dessous.
#
# ⚠️ Pourquoi ce script existe (pas juste `docker compose pull && up -d`) :
# `stack_app-code` (volume nommé, `external: true` dans compose.deploy.yaml) n'est
# peuplé par Docker qu'À SA CRÉATION — une fois rempli, un `docker compose up -d`
# ultérieur ne le resynchronise JAMAIS avec le contenu d'une nouvelle image, même
# après un `pull` réussi. Sans ce script, le conteneur change bien d'image mais
# continue de faire tourner l'ANCIEN code applicatif indéfiniment — piège réel
# rencontré le 06/08/2026 : deux déploiements successifs strictement sans effet,
# découvert seulement en comparant le contenu d'un fichier source dans le
# conteneur à celui du dépôt (voir TODO.md).
#
# Le volume est donc explicitement supprimé puis recréé vide avant `up -d`, pour
# forcer Docker à le repeupler depuis la nouvelle image. Comme l'activation/
# désactivation des applications (Paramètres Techniques > Gestion des
# applications) vit uniquement dans ce volume — dossier `applications_désactivées/`,
# jamais dans data/ — ce script sauvegarde la liste des applications désactivées
# AVANT de recréer le volume, puis la réapplique après (déplacement de dossier,
# méthode équivalente à l'UI, voir CLAUDE.md règle 7).
#
# Usage : ./docker/deploy-remote.sh
# Variables d'environnement optionnelles (valeurs par défaut = ha2) :
#   DEPLOY_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_KEY, DEPLOY_REMOTE_DIR,
#   DEPLOY_VOLUME_NAME, DEPLOY_CONTAINER_NAME
#
# Ne construit ni ne publie aucune image — suppose que `docker buildx build
# --platform linux/amd64,linux/arm64 -t zdid2/dimotic-ha:latest -t
# zdid2/dimotic-ha:X.Y.Z --push .` a déjà été exécuté séparément (voir
# techniques-socle-ha-mqtt_specs §11).
# =============================================================================
set -euo pipefail

HOST="${DEPLOY_HOST:-192.168.1.51}"
SSH_USER="${DEPLOY_SSH_USER:-claude}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/ha2-claude/id_ed25519}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/docker/dimotic-ha}"
VOLUME_NAME="${DEPLOY_VOLUME_NAME:-stack_app-code}"
CONTAINER_NAME="${DEPLOY_CONTAINER_NAME:-dimotic-ha}"

ssh_cmd() {
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "${SSH_USER}@${HOST}" "$@"
}

echo "==> Déploiement sur ${SSH_USER}@${HOST}:${REMOTE_DIR} (volume ${VOLUME_NAME})"

echo "==> 1/6 Sauvegarde de la liste des applications désactivées (avant recréation du volume)"
DISABLED_APPS="$(ssh_cmd "sudo docker exec ${CONTAINER_NAME} sh -c 'ls \"/app/applications_désactivées\" 2>/dev/null'" || true)"
if [ -n "$DISABLED_APPS" ]; then
  echo "    Actuellement désactivées : $(echo "$DISABLED_APPS" | tr '\n' ' ')"
else
  echo "    Aucune (ou premier déploiement — conteneur pas encore démarré)"
fi

echo "==> 2/6 Pull de la nouvelle image"
ssh_cmd "cd ${REMOTE_DIR} && sudo docker compose pull"

echo "==> 3/6 Arrêt du conteneur"
ssh_cmd "cd ${REMOTE_DIR} && sudo docker compose down"

echo "==> 4/6 Recréation du volume ${VOLUME_NAME} (sera repeuplé depuis la nouvelle image)"
ssh_cmd "sudo docker volume rm ${VOLUME_NAME}" || true
ssh_cmd "sudo docker volume create ${VOLUME_NAME}"

echo "==> 5/6 Démarrage avec le code neuf"
ssh_cmd "cd ${REMOTE_DIR} && sudo docker compose up -d"

echo "    Attente du démarrage..."
STATUS="starting"
for _ in $(seq 1 30); do
  STATUS="$(ssh_cmd "sudo docker inspect ${CONTAINER_NAME} --format '{{.State.Health.Status}}'" 2>/dev/null || echo starting)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
if [ "$STATUS" != "healthy" ]; then
  echo "    ⚠️  Le conteneur n'est pas 'healthy' après 60s (statut actuel : ${STATUS}) — vérifier les logs (docker logs ${CONTAINER_NAME})."
fi

if [ -n "$DISABLED_APPS" ]; then
  echo "==> 6/6 Réapplication des applications désactivées"
  RESTART_NEEDED=false
  while IFS= read -r app; do
    [ -z "$app" ] && continue
    echo "    Désactivation de ${app}"
    if ssh_cmd "sudo docker exec ${CONTAINER_NAME} sh -c 'mv \"/app/applications/${app}\" \"/app/applications_désactivées/${app}\"'"; then
      RESTART_NEEDED=true
    else
      echo "    ⚠️  Échec pour ${app} (déjà absente de applications/ ?)"
    fi
  done <<< "$DISABLED_APPS"

  if [ "$RESTART_NEEDED" = true ]; then
    echo "    Redémarrage pour appliquer la désactivation"
    ssh_cmd "sudo docker restart ${CONTAINER_NAME}"
    sleep 5
  fi
else
  echo "==> 6/6 Rien à réappliquer"
fi

echo "==> Terminé. Statut final :"
ssh_cmd "sudo docker ps --filter name=${CONTAINER_NAME} --format '{{.Names}}: {{.Status}}'"
