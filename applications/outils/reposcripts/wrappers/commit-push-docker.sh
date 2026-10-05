#!/bin/bash
# Généré par l'application Outils — commit + push + (optionnel) tag de version + build/publication
# Docker Hub, à lancer SOI-MÊME depuis un clone du dépôt (utilise git + docker/rebuild-and-deploy.sh
# déjà présents dans le clone — pas un script portable "auto-extractible" comme prepare-sd-card.sh).
#
# Volontairement INTERACTIF (confirmations) plutôt qu'automatique de bout en bout : ce script touche
# des dépôts partagés (remote git, Docker Hub) — jamais d'action à l'aveugle.
#
# Le numéro de tag n'est PAS calculable au moment du remplissage du formulaire (le navigateur ne
# connaît pas le dernier tag réel du dépôt) — il est calculé à L'EXÉCUTION à partir du plus haut
# tag vX.Y.Z du dépôt (par numéro de version) et du type choisi (mineur par défaut), affiché, et
# modifiable avant confirmation.
#
# ⭐ 25/09/2026 — COMPILATION DE VÉRIFICATION de toutes les applications AVANT le tag : la vraie
# compilation se fait dans l'image (Dockerfile → docker/build-apps.sh) ; sans cette vérification, une
# application qui ne compile pas faisait échouer l'image APRÈS le push du tag (tag sans image).
#
# --build-only sur docker/rebuild-and-deploy.sh : construit et publie l'image, SANS déployer sur
# aucune machine (ha2/orangepi/stfort/noisy/noisy2) — déploiement volontairement laissé à part,
# machine par machine.
#
# @outils:hint COMMIT_TITLE = Résumé court du commit, à la voix active (pourquoi plutôt que quoi).
# @outils:hint COMMIT_BODY = Détail optionnel (une ligne) — laisser vide si le titre suffit.
# @outils:checklist BUILD_DOCKER = oui
# @outils:hint BUILD_DOCKER = Coché = après le commit/push, compile toutes les applications pour vérification, crée un tag de version et construit/publie l'image Docker Hub. Décoché = commit + push uniquement.
# @outils:select VERSION_BUMP = mineur, patch, majeur
# @outils:default VERSION_BUMP = mineur
# @outils:hint VERSION_BUMP = Partie du numéro de version à incrémenter (3.2.1 → mineur 3.3.0, patch 3.2.2, majeur 4.0.0) — le numéro reste modifiable à l'exécution, saisi sous la forme X.Y.Z (le « v » est accepté).

set -euo pipefail

COMMIT_TITLE="__COMMIT_TITLE__"
COMMIT_BODY="__COMMIT_BODY__"
BUILD_DOCKER="__BUILD_DOCKER__"
VERSION_BUMP="__VERSION_BUMP__"

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
  # ⭐ 25/09/2026 — rien à committer : on continue quand même vers le tag + Docker (cas courant :
  # tout déjà commité/poussé, il ne reste qu'à publier une image).
  echo "Rien à committer (working tree propre)."
  if [ -z "$BUILD_DOCKER" ]; then exit 0; fi
else
  if [ -z "$COMMIT_TITLE" ]; then
    echo "ERREUR : il y a des modifications — le titre du commit est obligatoire." >&2
    exit 1
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
fi

echo
echo "=== push ==="
git push

if [ -z "$BUILD_DOCKER" ]; then
  echo
  echo "Terminé : commit poussé. Pas de tag ni de build Docker (case non cochée)."
  exit 0
fi

# --- Compilation de vérification (⭐ 25/09/2026) : AVANT tout tag -----------------------------
# Même ordre que docker/build-apps.sh (core d'abord), sans `npm prune` (machine de dev). Un échec
# arrête tout ici : rien n'est taggé ni publié.
echo
echo "=== Agents distants (docker/agents.lock) ==="
./docker/fetch-agents.sh || { echo "ÉCHEC de la récupération des agents — ni tag ni image (le commit est déjà poussé)." >&2; exit 1; }

echo
echo "=== Compilation de vérification de toutes les applications ==="
build_app() {
  local app="$1"
  echo "==> ${app}"
  ( cd "applications/${app}" && npm run build && npm run build:ui --if-present ) \
    || { echo; echo "ÉCHEC de la compilation : ${app} — ni tag ni image (le commit est déjà poussé)." >&2; exit 1; }
}
build_app core
for dir in applications/*/; do
  app="$(basename "$dir")"
  [ "$app" = "core" ] && continue
  [ -f "${dir}package.json" ] || continue
  build_app "$app"
done
echo "Compilation OK."

# --- Tag + Docker (case cochée) : version calculée ICI, à l'exécution, sur le vrai dépôt ---
# Plus haut tag PAR NUMÉRO DE VERSION (pas par date de création).
LAST_TAG="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [ -n "$LAST_TAG" ]; then
  IFS=. read -r MAJOR MINOR PATCH <<< "${LAST_TAG#v}"
  case "$VERSION_BUMP" in
    majeur) SUGGESTED="$((MAJOR + 1)).0.0" ;;
    patch)  SUGGESTED="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
    *)      SUGGESTED="${MAJOR}.$((MINOR + 1)).0" ;;
  esac
else
  SUGGESTED="0.1.0"
fi

# ⭐ 30/09/2026 — UN SEUL format affiché et saisi : X.Y.Z (comme l'image Docker). Le script proposait
# « v3.3.4 » puis annonçait « la version 3.3.4 » : taper 3.4.0 était refusé (« format attendu vX.Y.Z »).
# Le « v » saisi est désormais accepté aussi ; le tag git garde son « v » (vX.Y.Z), ajouté ici.
echo
if [ -n "$LAST_TAG" ]; then echo "Dernière version : ${LAST_TAG#v}"; else echo "Dernière version : aucune"; fi
read -rp "Numéro de la nouvelle version [$SUGGESTED] : " VERSION_INPUT
NUMBER="${VERSION_INPUT:-$SUGGESTED}"
NUMBER="${NUMBER#v}"; NUMBER="${NUMBER#V}"
if ! [[ "$NUMBER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERREUR : format attendu X.Y.Z, par exemple $SUGGESTED (reçu : $NUMBER)." >&2
  exit 1
fi
VERSION="v${NUMBER}"
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "ERREUR : la version $NUMBER existe déjà (tag $VERSION)." >&2
  exit 1
fi

echo "Attention: Aucune machine ne sera mise à jour."
# ⭐ 04/10/2026 — Entrée = oui : la case « Docker » cochée vaut déjà intention de publier ; un Entrée
# machinal annulait silencieusement la publication (image restée sur l'ancienne version).
read -rp "Publier la version ${NUMBER} (tag ${VERSION} + image Docker) ? [O/n] " CONFIRM2
if [ "$CONFIRM2" = "n" ] || [ "$CONFIRM2" = "N" ]; then
  echo "Tag/Docker annulés — le commit est déjà poussé."
  exit 0
fi

git tag -a "$VERSION" -m "$VERSION${COMMIT_TITLE:+ — $COMMIT_TITLE}"
git push origin "$VERSION"

./docker/rebuild-and-deploy.sh "${VERSION#v}" --build-only

echo
echo "Terminé : commit poussé, tag $VERSION créé/poussé, image zdid2/dimotic-ha:${VERSION#v} (+ :latest) publiée."
echo "Déploiement sur les machines : à faire séparément (pas automatique depuis ce script)."
