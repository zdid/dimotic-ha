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
    npm run build:ui
  )
}

echo "=== Construction de core (préalable obligatoire) ==="
build_app core

echo "=== Construction des applications métier ==="
for app in arbreouquoi arexx evoo7 haplan ia nommage planificateur rfxcom; do
  build_app "${app}"
done

echo "=== Terminé ==="
