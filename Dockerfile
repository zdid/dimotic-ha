# =============================================================================
# Image Docker pour Dimotic-HA (socle + applications métier) — autosuffisante :
# `docker pull` + `docker run`/`docker compose up` suffisent, aucun clone git ni
# build séparé sur la machine cible.
#
# Le code applicatif est construit PENDANT le build de l'image (étape `builder`
# ci-dessous, `docker/build-apps.sh`) et copié dans l'image finale — pas monté
# depuis l'hôte. Ce choix (repris après discussion, voir TODO.md/historique git)
# corrige le défaut de la première version de ce Dockerfile, qui montait le code
# depuis l'hôte et obligeait donc à cloner le dépôt à côté de l'image sur chaque
# machine cible, à l'encontre même de l'intérêt de publier sur Docker Hub.
#
# ⚠️ Le mécanisme d'activation/désactivation d'application (`fs.renameSync`
# entre `applications/` et `applications_désactivées/`, `ApplicationManager.ts`)
# NE fonctionne PAS avec le seul contenu de cette image (vérifié empiriquement,
# 03/08/2026) : overlay2 refuse de renommer un répertoire encore uniquement
# présent dans une couche d'image (même en lecture seule), avec une erreur
# `EXDEV` — quelle que soit la façon dont les couches sont organisées. Un volume
# NOMMÉ unique couvrant tout `/app` (voir compose.yaml, service `app`) est donc
# OBLIGATOIRE à l'exécution, pas une option — Docker le peuple automatiquement
# avec le contenu de cette image au premier démarrage (aucun clone git
# nécessaire malgré tout), et un vrai volume (pas des couches d'image) permet au
# renommage de fonctionner normalement, comme sur n'importe quel système de
# fichiers unique.
#
# Base Debian (glibc) plutôt qu'Alpine (musl) : `serialport`/`rfxcom`
# (RFXCOM) embarquent des bindings natifs (.node) — prebuilds glibc confirmés
# disponibles pour linux/amd64 ET linux/arm64 (Raspberry Pi 3/4/5 en OS 64 bits),
# jamais garantis avec musl. python3/make/g++ en filet de sécurité si jamais
# aucun prebuild n'est trouvé pour une plateforme donnée (compilation depuis les
# sources), présents uniquement dans l'étape de build, pas dans l'image finale.
#
# Exécution via `tsx` (TypeScript direct), PAS `node dist/index.js` compilé —
# voir TODO.md "AppService : le chargement dynamique des modules en production
# suppose un dist/domain/index.js à plat, faux pour 7 apps sur 8" (cause de fond
# non corrigée à ce jour, contournement délibéré). `build:ui` (assets navigateur)
# reste nécessaire et s'exécute normalement — seul le côté serveur est interprété
# plutôt que précompilé.
# =============================================================================

# ---------------------------------------------------------------------------
# Étape 1 : builder — construit toutes les applications (core + apps métier)
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       make \
       g++ \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY tsconfig.json ./
COPY docker ./docker
COPY applications ./applications

RUN chmod +x docker/build-apps.sh && ./docker/build-apps.sh

# ---------------------------------------------------------------------------
# Étape 2 : runtime — image finale, sans outils de compilation
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/applications ./applications

# `applications_désactivées/` (accents intentionnels — nom réel attendu par
# ApplicationManager.ts) : vide à l'image, peuplé dynamiquement par l'UI.
RUN mkdir -p "/app/applications_désactivées" /app/data /app/logs \
    && chown -R node:node /app

# Utilisateur intégré à l'image officielle Node (uid/gid 1000) plutôt que root —
# coïncide avec le premier utilisateur par défaut de Raspberry Pi OS et de la
# plupart des distributions Linux mono-utilisateur, donc les fichiers écrits sur
# les volumes hôte (data/, logs/) restent possédés par l'utilisateur attendu sans
# configuration supplémentaire dans le cas courant. Si l'hôte utilise un uid/gid
# différent, l'ajuster via `user:` dans compose.yaml (voir son commentaire).
USER node

# Purement informatif (network_mode: host en usage réel, voir compose.yaml — EXPOSE n'a alors
# aucun effet sur la publication des ports, mais documente ce que l'image écoute) :
#   8080  : core — UI web + API Socket.io (fixe)
#   49161 : AREXX — serveur HTTP local, modes push/usb (configurable, data/arexx/config.yaml)
#   11434 : ia — serveur HTTP émulant le protocole Ollama pour l'intégration HA (configurable,
#           data/ia/config.yaml) — ⚠️ collision possible avec un vrai serveur Ollama sur le même
#           hôte (même port par défaut), voir compose.yaml.
EXPOSE 8080 49161 11434

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["applications/core/node_modules/.bin/tsx", "applications/core/src/index.ts"]
