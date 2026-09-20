#!/bin/bash
# Généré par l'application Outils — commit + push + (optionnel) tag de version + build/publication
# Docker Hub, à lancer SOI-MÊME depuis un clone du dépôt (utilise git + docker/rebuild-and-deploy.sh
# déjà présents dans le clone — pas un script portable "auto-extractible" comme prepare-sd-card.sh).
#
# Volontairement INTERACTIF (confirmations) plutôt qu'automatique de bout en bout : ce script touche
# des dépôts partagés (remote git, Docker Hub) — jamais d'action à l'aveugle.
#
# Le numéro de tag n'est PAS calculable au moment du remplissage du formulaire (le navigateur ne
# connaît pas le dernier tag réel du dépôt) — il est calculé à L'EXÉCUTION (bump patch automatique
# depuis le dernier tag vX.Y.Z du dépôt où le script tourne), affiché, et modifiable avant
# confirmation.
#
# --build-only sur docker/rebuild-and-deploy.sh : construit et publie l'image, SANS déployer sur
# aucune machine (ha2/orangepi/stfort/noisy/noisy2) — déploiement volontairement laissé à part,
# machine par machine.
#
# @outils:hint COMMIT_TITLE = Résumé court du commit, à la voix active (pourquoi plutôt que quoi).
# @outils:hint COMMIT_BODY = Détail optionnel (une ligne) — laisser vide si le titre suffit.
# @outils:checklist BUILD_DOCKER = oui
# @outils:hint BUILD_DOCKER = Coché = après le commit/push, crée un tag de version et construit/publie l'image Docker Hub. Décoché = commit + push uniquement.

set -euo pipefail

COMMIT_TITLE="__COMMIT_TITLE__"
COMMIT_BODY="__COMMIT_BODY__"
BUILD_DOCKER="__BUILD_DOCKER__"

if [ -z "$COMMIT_TITLE" ]; then
  echo "ERREUR : le titre du commit est obligatoire." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERREUR : ce script doit être lancé depuis un clone git de dimotic-ha." >&2
  exit 1
fi
cd "$REPO_ROOT"

if [ -n "$BUILD_DOCKER" ] && [ ! -f docker/rebuild-and-deploy.sh ]; then
  echo "ERREUR : docker/rebuild-and-deploy.sh introuvable — clone incomplet ?" >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "Rien à committer (working tree propre)."
  exit 0
fi

echo "=== git status ==="
git status
echo
echo "=== git diff --stat ==="
git diff --stat
echo

read -rp "Ajouter TOUS les fichiers modifiés/nouveaux (git add -A) et committer ? [o/N] " CONFIRM
if [ "$CONFIRM" != "o" ] && [ "$CONFIRM" != "O" ]; then
  echo "Annulé."
  exit 1
fi

git add -A
echo "--- Staged ---"
git status --short

if [ -n "$COMMIT_BODY" ]; then
  git commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY"
else
  git commit -m "$COMMIT_TITLE"
fi

echo
echo "=== push ==="
git push

if [ -z "$BUILD_DOCKER" ]; then
  echo
  echo "Terminé : commit poussé. Pas de tag ni de build Docker (case non cochée)."
  exit 0
fi

# --- Tag + Docker (case cochée) : version calculée ICI, à l'exécution, sur le vrai dépôt ---
LAST_TAG="$(git tag --sort=-creatordate | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [ -n "$LAST_TAG" ]; then
  MAJOR=$(echo "$LAST_TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\1/')
  MINOR=$(echo "$LAST_TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\2/')
  PATCH=$(echo "$LAST_TAG" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+)$/\3/')
  SUGGESTED="v${MAJOR}.${MINOR}.$((PATCH + 1))"
else
  SUGGESTED="v0.1.0"
fi

echo
echo "Dernier tag : ${LAST_TAG:-aucun}"
read -rp "Numéro du nouveau tag [$SUGGESTED] : " VERSION_INPUT
VERSION="${VERSION_INPUT:-$SUGGESTED}"

read -rp "Créer/pousser le tag $VERSION puis construire+publier l'image Docker (--build-only, pas de déploiement) ? [o/N] " CONFIRM2
if [ "$CONFIRM2" != "o" ] && [ "$CONFIRM2" != "O" ]; then
  echo "Tag/Docker annulés — le commit est déjà poussé."
  exit 0
fi

git tag -a "$VERSION" -m "$VERSION — $COMMIT_TITLE"
git push origin "$VERSION"

./docker/rebuild-and-deploy.sh "${VERSION#v}" --build-only

echo
echo "Terminé : commit poussé, tag $VERSION créé/poussé, image zdid2/dimotic-ha:${VERSION#v} (+ :latest) publiée."
echo "Déploiement sur les machines : à faire séparément (pas automatique depuis ce script)."
