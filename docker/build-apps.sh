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
# ⭐ 25/08/2026 : espdisplay/rpigpio/scriptsha/teleinfo ajoutées — absentes de cette liste depuis
# leur création, jamais construites par le build Docker. Sans dist/domain/index.js, AppService
# retombe sur src/domain/index.ts (lecture des métadonnées) et ProcessSupervisor sur
# src/standalone.ts (exécution) — les deux nécessitent tsx. Le bug était invisible car un dist/
# local (construit à la main sur la machine de dev) traîne dans le contexte de build malgré
# .dockerignore (qui liste bien dist/, mais ne l'exclut pas pour applications/*/dist/ imbriqués —
# cause exacte non creusée) : un build Docker sur un clone strictement neuf, sans ce dist/ résiduel,
# aurait révélé le problème immédiatement.
for app in arbreouquoi arexx espdisplay evoo7 haplan ia nommage planificateur rfxcom rpigpio scriptsha teleinfo; do
  build_app "${app}"
done

echo "=== Terminé ==="
