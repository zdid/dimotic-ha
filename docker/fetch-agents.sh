#!/usr/bin/env bash
# =============================================================================
# Récupère dans scripts/agents/<nom>/ la version FIGÉE (tag de docker/agents.lock) des agents distants publiés
# dans des dépôts indépendants (ex. DDSU666-h-mqtt). Appelé par la compilation (build-all.sh), la vérification de
# commit-push-docker.sh et la construction de l'image (rebuild-and-deploy.sh) ; scripts/ est déjà copié dans l'image.
#
# Source : le dépôt local indiqué (colonne 4) SI le tag y existe, sinon un clone du tag depuis GitHub.
# `git archive <tag>` : on prend exactement la version taguée, jamais l'état courant du dossier de travail.
# Le dossier scripts/agents/ n'est pas commité (.gitignore). Un fichier .agent-version y note la version utilisée.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOCK="docker/agents.lock"
[ -f "$LOCK" ] || { echo "ERREUR : $LOCK introuvable." >&2; exit 1; }

while read -r NAME REPO TAG LOCAL_DIR _; do
  case "${NAME:-}" in ''|'#'*) continue ;; esac
  LOCAL_DIR="$(eval echo "${LOCAL_DIR:-}")"
  DEST="scripts/agents/${NAME}"
  rm -rf "$DEST"; mkdir -p "$DEST"

  if [ -n "$LOCAL_DIR" ] && [ -d "$LOCAL_DIR/.git" ] && git -C "$LOCAL_DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    SOURCE="local ($LOCAL_DIR)"
    git -C "$LOCAL_DIR" archive "$TAG" | tar -x -C "$DEST"
    COMMIT="$(git -C "$LOCAL_DIR" rev-parse "$TAG^{commit}")"
    if [ -n "$(git -C "$LOCAL_DIR" status --porcelain)" ]; then
      echo "Attention : $LOCAL_DIR a des modifications non commitées — ignorées, la version taguée $TAG est utilisée."
    fi
  else
    SOURCE="GitHub ($REPO)"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "https://github.com/${REPO}.git" "$TMP/src" \
      || { echo "ERREUR : agent ${NAME} ${TAG} introuvable (ni en local, ni sur GitHub ${REPO})." >&2; exit 1; }
    COMMIT="$(git -C "$TMP/src" rev-parse HEAD)"
    git -C "$TMP/src" archive HEAD | tar -x -C "$DEST"
    rm -rf "$TMP"
  fi

  echo "${NAME} ${TAG} ${COMMIT} source=${SOURCE} $(date +%F)" > "$DEST/.agent-version"
  echo "Agent ${NAME} ${TAG} (${COMMIT:0:7}) <- ${SOURCE}"
done < "$LOCK"
