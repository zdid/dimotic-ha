#!/usr/bin/env bash
# =============================================================================
# Récupère dans scripts/agents/<nom>/ la version indiquée (tag de docker/agents.lock) des agents distants publiés
# dans des dépôts indépendants (ex. DDSU666-h-mqtt). Appelé par la compilation (build-all.sh), la vérification de
# commit-push-docker.sh et la construction de l'image (rebuild-and-deploy.sh) ; scripts/ est déjà copié dans l'image.
#
# Tag : un tag précis (v0.9.0, version figée) ou « latest » = le plus récent tag de version vX.Y.Z (jamais l'état
# non taguée de la branche) ; le tag réellement utilisé est noté dans .agent-version et affiché.
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

  if [ "$TAG" = "latest" ]; then
    # Le plus récent tag de version : on compare le dossier local ET GitHub (le local peut être en retard ou en avance).
    LOCAL_LATEST=""; REMOTE_LATEST=""
    if [ -n "$LOCAL_DIR" ] && [ -d "$LOCAL_DIR/.git" ]; then
      LOCAL_LATEST="$(git -C "$LOCAL_DIR" tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
    fi
    REMOTE_LATEST="$(git ls-remote --tags --refs --sort=-v:refname "https://github.com/${REPO}.git" 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null | head -1 | sed 's#.*refs/tags/##' || true)"
    TAG="$(printf '%s\n%s\n' "$LOCAL_LATEST" "$REMOTE_LATEST" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
    [ -n "$TAG" ] || { echo "ERREUR : aucun tag de version trouvé pour ${NAME} (ni en local, ni sur GitHub ${REPO})." >&2; exit 1; }
  fi

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
