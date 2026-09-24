#!/bin/bash
# Généré par l'application Outils — compilation LOCALE de toutes les applications dimotic-ha
# (core d'abord : les autres utilisent sa version compilée core/dist), à lancer SOI-MÊME depuis un
# clone du dépôt.
#
# Différence volontaire avec docker/build-apps.sh (compilation DANS l'image) : pas de
# `npm prune --omit=dev` ici — sur une machine de développement, il supprimerait TypeScript et les
# outils de développement de chaque application.
#
# @outils:checklist NPM_INSTALL = oui
# @outils:hint NPM_INSTALL = Coché = « npm install » avant chaque compilation (clone neuf, dépendances modifiées). Décoché = compilation seule (plus rapide).

set -euo pipefail

NPM_INSTALL="oui"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/applications/core" ]; then
  echo "ERREUR : à lancer depuis un clone du dépôt dimotic-ha." >&2
  exit 1
fi
cd "$REPO_ROOT"

build_app() {
  local app="$1"
  echo "==> ${app}"
  # Commandes chaînées par && : dans un bloc suivi de `|| …`, bash désactive l'arrêt sur erreur
  # (set -e) — une compilation en échec était sinon masquée par la suivante qui réussit.
  (
    cd "applications/${app}" \
      && { [ -z "$NPM_INSTALL" ] || npm install --no-audit --no-fund; } \
      && npm run build \
      && npm run build:ui --if-present
  ) || { echo; echo "ÉCHEC de la compilation : ${app}" >&2; exit 1; }
}

build_app core
COUNT=1
for dir in applications/*/; do
  app="$(basename "$dir")"
  [ "$app" = "core" ] && continue
  [ -f "${dir}package.json" ] || continue
  build_app "$app"
  COUNT=$((COUNT + 1))
done

echo
echo "Terminé : ${COUNT} application(s) compilée(s) sans erreur."
