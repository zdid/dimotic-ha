#!/usr/bin/env bash
# =============================================================================
# Déploie la dernière image Docker Hub (zdid2/dimotic-ha) sur une machine cible
# déjà installée (voir compose.deploy.yaml) — typiquement `ha2`, mais tout hôte
# suivant la même convention (/docker/dimotic-ha) fonctionne via les variables
# d'environnement ci-dessous.
#
# Depuis le 07/08/2026, plus de volume nommé sur /app (voir Dockerfile/
# compose.yaml) : /app vit dans les couches de l'image + la couche conteneur
# éphémère habituelle, `docker compose pull && up -d` suffit donc à appliquer
# une nouvelle version — Docker recrée automatiquement le conteneur dès qu'il
# détecte que l'image a changé. Avant cette date, un volume nommé dédié
# (`stack_app-code`) était obligatoire (activation/désactivation d'application
# via déplacement physique de dossier, `fs.renameSync`) mais n'était jamais
# resynchronisé avec une nouvelle image une fois créé — piège réel rencontré le
# 06/08/2026 (deux déploiements successifs sans effet, voir TODO.md), qui a
# motivé une première version de ce script (recréation explicite du volume).
# Ce script reste utile pour : le confort d'un point d'entrée unique, l'attente
# du healthcheck, et le statut final — mais ne fait plus rien de spécial.
#
# Usage : ./docker/deploy-remote.sh
# Variables d'environnement optionnelles (valeurs par défaut = ha2) :
#   DEPLOY_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_KEY, DEPLOY_REMOTE_DIR,
#   DEPLOY_CONTAINER_NAME
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
CONTAINER_NAME="${DEPLOY_CONTAINER_NAME:-dimotic-ha}"

ssh_cmd() {
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 "${SSH_USER}@${HOST}" "$@"
}

echo "==> Déploiement sur ${SSH_USER}@${HOST}:${REMOTE_DIR}"

echo "==> 1/2 Pull de la nouvelle image"
ssh_cmd "cd ${REMOTE_DIR} && sudo docker compose pull"

echo "==> 2/2 Démarrage avec le code neuf"
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

echo "==> Terminé. Statut final :"
ssh_cmd "sudo docker ps --filter name=${CONTAINER_NAME} --format '{{.Names}}: {{.Status}}'"
