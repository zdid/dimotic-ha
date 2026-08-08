#!/usr/bin/env bash
# =============================================================================
# Build multi-arch (amd64+arm64) + publication Docker Hub + déploiement sur les
# deux machines cibles (ha2, orangepi) — le cycle complet utilisé pendant la
# session du 08/08/2026 pour chaque correctif : commit/push déjà faits à part
# (git), ce script prend le relais à partir du build.
#
# Usage :
#   ./docker/rebuild-and-deploy.sh 0.2.7
#   ./docker/rebuild-and-deploy.sh 0.2.7 --skip-ha2       # ne déploie que sur orangepi
#   ./docker/rebuild-and-deploy.sh 0.2.7 --skip-orangepi  # ne déploie que sur ha2
#   ./docker/rebuild-and-deploy.sh 0.2.7 --build-only     # build + push, sans déployer
#
# Prérequis :
#   - `docker login` déjà fait (credential store), builder buildx `dimotic-builder` déjà créé
#     (docker buildx create --name dimotic-builder --use, une seule fois)
#   - Accès SSH par clé déjà en place vers les deux machines (~/.ssh/ha2-claude/,
#     ~/.ssh/orangepi-claude/) avec sudo NOPASSWD pour l'utilisateur `claude`
#
# Variables d'environnement optionnelles (valeurs par défaut = celles de cette session) :
#   DOCKER_IMAGE, HA2_HOST, HA2_SSH_KEY, ORANGEPI_HOST, ORANGEPI_SSH_KEY
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # racine du projet

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage : $0 <version> [--skip-ha2] [--skip-orangepi] [--build-only]"
  echo "Exemple : $0 0.2.7"
  exit 1
fi
shift || true

SKIP_HA2=false
SKIP_ORANGEPI=false
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-ha2) SKIP_HA2=true ;;
    --skip-orangepi) SKIP_ORANGEPI=true ;;
    --build-only) BUILD_ONLY=true ;;
    *) echo "Option inconnue : $arg" >&2; exit 1 ;;
  esac
done

DOCKER_IMAGE="${DOCKER_IMAGE:-zdid2/dimotic-ha}"

HA2_HOST="${HA2_HOST:-192.168.1.51}"
HA2_SSH_KEY="${HA2_SSH_KEY:-$HOME/.ssh/ha2-claude/id_ed25519}"

ORANGEPI_HOST="${ORANGEPI_HOST:-192.168.1.32}"
ORANGEPI_SSH_KEY="${ORANGEPI_SSH_KEY:-$HOME/.ssh/orangepi-claude/id_ed25519}"

SSH_USER="claude"
REMOTE_DIR="/docker/dimotic-ha"
CONTAINER_NAME="dimotic-ha"

# -----------------------------------------------------------------------------
# 1. Build multi-arch + push sur Docker Hub
# -----------------------------------------------------------------------------
echo "=== 1/2 Build + push ${DOCKER_IMAGE}:${VERSION} (+ :latest) ==="
docker buildx build \
  --builder dimotic-builder \
  --platform linux/amd64,linux/arm64 \
  -t "${DOCKER_IMAGE}:${VERSION}" \
  -t "${DOCKER_IMAGE}:latest" \
  --push \
  .

if [ "$BUILD_ONLY" = true ]; then
  echo "=== --build-only : pas de déploiement, terminé ==="
  exit 0
fi

# -----------------------------------------------------------------------------
# 2. Déploiement (pull + up -d) sur chaque machine, puis attente 'healthy'
# -----------------------------------------------------------------------------
deploy_to() {
  local label="$1" host="$2" ssh_key="$3"

  echo "=== 2/2 Déploiement sur ${label} (${SSH_USER}@${host}) ==="
  ssh -i "$ssh_key" -o ConnectTimeout=10 "${SSH_USER}@${host}" \
    "cd ${REMOTE_DIR} && sudo docker compose pull && sudo docker compose up -d"

  echo "    Attente du démarrage (${label})..."
  local status="starting"
  for _ in $(seq 1 30); do
    status="$(ssh -i "$ssh_key" "${SSH_USER}@${host}" "sudo docker inspect ${CONTAINER_NAME} --format '{{.State.Health.Status}}'" 2>/dev/null || echo starting)"
    [ "$status" = "healthy" ] && break
    sleep 3
  done

  if [ "$status" != "healthy" ]; then
    echo "    ⚠️  ${label} : conteneur pas 'healthy' après 90s (statut actuel : ${status}) — vérifier : sudo docker logs ${CONTAINER_NAME}"
  else
    echo "    ✅ ${label} : healthy"
  fi
}

[ "$SKIP_HA2" = false ] && deploy_to "ha2" "$HA2_HOST" "$HA2_SSH_KEY"
[ "$SKIP_ORANGEPI" = false ] && deploy_to "orangepi" "$ORANGEPI_HOST" "$ORANGEPI_SSH_KEY"

echo "=== Terminé (${DOCKER_IMAGE}:${VERSION}) ==="
