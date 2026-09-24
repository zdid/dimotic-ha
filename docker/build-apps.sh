#!/usr/bin/env bash
# =============================================================================
# Construit toutes les applications (core + apps métier actives), dans l'ordre
# requis. Exécutable directement sur l'hôte (npm/node classiques) ou dans le
# conteneur "build" (voir compose.yaml, service `build`, profil "build").
#
# Ordre impératif : `core` en premier (build ET build:ui). Chaque app métier
# référence, dans son propre src/presentation/tsconfig.ui.json, le fichier de
# déclarations compilé de core (.../core/dist/presentation/ui/js/ts/services/
# SocketService.d.ts) — voir techniques-socle-ha-mqtt_specs §4.2.1. Sans core
# déjà construit, `npm run build:ui` de n'importe quelle app métier échoue.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # racine du projet

# `nommage` n'a pas de package-lock.json généré à ce jour (voir specs) — `npm install`
# fonctionne dans tous les cas (avec ou sans lockfile), contrairement à `npm ci`.
build_app() {
  local app="$1"
  echo "==> ${app}"
  (
    cd "applications/${app}"
    npm install --no-audit --no-fund
    npm run build
    # --if-present : espdisplay n'a pas de couche presentation/UI (pas de script build:ui déclaré,
    # voir son package.json) — sans ce flag, `npm run build:ui` échoue avec "missing script" et
    # casse tout le build (set -e) pour un cas parfaitement normal, pas une erreur.
    npm run build:ui --if-present
    # ⭐ 25/08/2026 : retire les devDependencies (typescript/tsx/@types/*/vitest) une fois la
    # compilation de CETTE app terminée — plus jamais lues à l'exécution (CMD tourne en `node` pur
    # sur dist/, voir supervisor.js/ProcessSupervisor.ts). Sans risque pour les autres apps métier
    # dont le build:ui référence les .d.ts déjà émis par core (fichiers sur disque, indépendants de
    # node_modules) — voir le commentaire d'ordre de build en tête de fichier.
    npm prune --omit=dev
  )
}

echo "=== Construction de core (préalable obligatoire) ==="
build_app core

echo "=== Construction des applications métier ==="
# ⭐ 24/09/2026 : BOUCLE sur applications/*/ au lieu d'une liste fixe (demande explicite) — la liste
# fixe a oublié des applications deux fois : espdisplay/rpigpio/scriptsha/teleinfo (corrigé le
# 25/08/2026) puis sauvegarde/outils (constaté le 24/09/2026). L'oubli restait invisible parce que
# le dist/ compilé sur la machine de dev passait dans l'image (.dockerignore n'excluait que le dist/
# racine — désormais `**/dist/`, voir .dockerignore) : toute application présente dans le dépôt est
# maintenant construite (build serveur + build:ui de sa présentation), core en premier (ci-dessus).
# Une application nouvelle y arrive DÉSACTIVÉE (ApplicationManager.reconcile()), testcycle comprise.
for dir in applications/*/; do
  app="$(basename "${dir}")"
  [ "${app}" = "core" ] && continue
  [ -f "${dir}package.json" ] || continue
  build_app "${app}"
done

echo "=== Terminé ==="
