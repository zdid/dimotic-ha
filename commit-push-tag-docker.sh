#!/bin/bash
# Commit de TOUT + push + tag de version MINEUR (vX.Y.Z → vX.(Y+1).0) + construction/publication de
# l'image Docker (docker/rebuild-and-deploy.sh --build-only : aucune machine n'est déployée).
#
# Usage (depuis n'importe où dans le dépôt) :
#   ./commit-push-tag-docker.sh "Titre du commit" ["Détail optionnel"]
#   ./commit-push-tag-docker.sh                 # rien à committer : tag + Docker seulement
#
# Interactif : confirmation avant le commit, et avant le tag + Docker (numéro de tag modifiable).
# S'arrête à la première erreur (set -e).

set -euo pipefail

COMMIT_TITLE="${1:-}"
COMMIT_BODY="${2:-}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERREUR : à lancer depuis le dépôt dimotic-ha." >&2
  exit 1
fi
cd "$REPO_ROOT"

if [ ! -x docker/rebuild-and-deploy.sh ]; then
  echo "ERREUR : docker/rebuild-and-deploy.sh introuvable ou non exécutable." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Branche : $BRANCH"

# --- 1. Commit + push -------------------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  if [ -z "$COMMIT_TITLE" ]; then
    echo "ERREUR : il y a des modifications — donne un titre de commit :" >&2
    echo "  $0 \"Titre du commit\" [\"Détail\"]" >&2
    exit 1
  fi
  echo
  echo "=== Modifications ==="
  git status --short
  echo
  read -rp "Tout ajouter (git add -A) et committer « $COMMIT_TITLE » ? [o/N] " OK
  [[ "$OK" =~ ^[oO]$ ]] || { echo "Annulé."; exit 1; }

  git add -A
  if [ -n "$COMMIT_BODY" ]; then
    git commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY"
  else
    git commit -m "$COMMIT_TITLE"
  fi
else
  echo "Rien à committer."
fi

echo
echo "=== push ($BRANCH) ==="
git push origin "$BRANCH"

# --- 2. Tag mineur ----------------------------------------------------------------------------
LAST_TAG="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
if [ -n "$LAST_TAG" ]; then
  IFS=. read -r MAJOR MINOR _PATCH <<< "${LAST_TAG#v}"
  SUGGESTED="v${MAJOR}.$((MINOR + 1)).0"
else
  SUGGESTED="v0.1.0"
fi

echo
echo "Dernier tag : ${LAST_TAG:-aucun}"
read -rp "Nouveau tag [$SUGGESTED] : " VERSION_INPUT
VERSION="${VERSION_INPUT:-$SUGGESTED}"
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERREUR : format attendu vX.Y.Z (reçu : $VERSION)." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "ERREUR : le tag $VERSION existe déjà." >&2
  exit 1
fi

read -rp "Créer/pousser le tag $VERSION puis construire et publier l'image Docker ${VERSION#v} (sans déploiement) ? [o/N] " OK2
[[ "$OK2" =~ ^[oO]$ ]] || { echo "Tag/Docker annulés — le commit est déjà poussé."; exit 0; }

git tag -a "$VERSION" -m "$VERSION${COMMIT_TITLE:+ — $COMMIT_TITLE}"
git push origin "$VERSION"

# --- 3. Image Docker --------------------------------------------------------------------------
./docker/rebuild-and-deploy.sh "${VERSION#v}" --build-only

echo
echo "Terminé : tag $VERSION poussé, image Docker ${VERSION#v} (+ latest) publiée."
echo "Déploiement sur les machines : à faire séparément, machine par machine."
