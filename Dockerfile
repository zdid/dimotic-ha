# =============================================================================
# Image Docker pour ws-ha (socle + applications métier).
#
# Contrairement à un Dockerfile classique, cette image NE contient PAS le code
# applicatif : `applications/` et `applications_désactivées/` sont montés
# depuis l'hôte (voir compose.yaml), pas copiés dans l'image, pour deux
# raisons impératives propres à ce projet :
#
#  1. Activer/désactiver une application déplace son dossier ENTRE
#     `applications/` et `applications_désactivées/` (`fs.renameSync`,
#     ApplicationManager.ts) — un `rename()` POSIX échoue (EXDEV) entre deux
#     systèmes de fichiers différents. Si le code était figé dans l'image et
#     seul `applications_désactivées/` monté depuis l'hôte, ce mécanisme
#     casserait silencieusement. Les deux répertoires doivent donc rester sur
#     le même point de montage — ici, celui de l'hôte.
#  2. Il n'existe pas de build global fiable à la racine du projet (voir
#     CLAUDE.md) — chaque application (core comprise) a son propre
#     package.json/tsconfig/dist. Cette image sert donc de socle d'exécution
#     Node.js + outils de compilation natifs (voir ci-dessous), réutilisé à la
#     fois pour builder (service `build`, ponctuel) et pour exécuter
#     (service `app`) — voir compose.yaml pour le détail des deux usages.
#
# Base Debian (glibc) plutôt qu'Alpine (musl) : `serialport`/`rfxcom`
# (RFXCOM) embarquent des bindings natifs (.node) — les prebuilds ne sont pas
# garantis sur toutes les architectures avec musl, notamment sur les cibles
# ARM (Raspberry Pi) fréquentes pour ce projet. python3/make/g++ permettent la
# compilation depuis les sources si aucun prebuild n'est trouvé.
# =============================================================================
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       make \
       g++ \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

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

CMD ["node", "applications/core/dist/index.js"]
