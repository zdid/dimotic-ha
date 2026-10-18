#!/usr/bin/env bash
# =============================================================================
# Installe l'agent de mise à jour `maj` (conception-mise-a-jour-dimotic_specs v1.1) dans le compose EXISTANT d'une machine,
# sans toucher au reste : ajoute le service `maj` (profil `maj`) s'il est absent, vérifie le compose, démarre SEULEMENT `maj`
# (le conteneur dimotic-ha n'est ni arrêté ni recréé).
#
# À lancer en root sur la machine : sudo ./installer-agent-maj.sh [dossier]    (défaut : /docker/dimotic-ha)
# Sauvegarde : compose.yaml.bak-AAAAMMJJ-HHMMSS. Retour arrière : remettre cette sauvegarde, puis `docker rm -f dimotic-maj`.
# Le socket Docker de l'hôte (équivalent root) n'est monté que dans ce conteneur.
# =============================================================================
set -euo pipefail
DIR="${1:-/docker/dimotic-ha}"
F="$DIR/compose.yaml"
[ "$(id -u)" = 0 ] || { echo "À lancer en root (sudo)." >&2; exit 1; }
[ -f "$F" ] || { echo "Introuvable : $F" >&2; exit 1; }
grep -q '^services:' "$F" || { echo "$F n'a pas de section « services: »" >&2; exit 1; }

if grep -qE '^  maj:\s*$' "$F"; then
  echo "Le service maj existe déjà dans $F : rien à ajouter."
else
  cp -p "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
  cat >> "$F" <<'YAML'

  # Agent de mise à jour (conception-mise-a-jour-dimotic_specs v1.1) — profil `maj` : docker compose --profile maj up -d maj
  maj:
    image: zdid2/dimotic-maj:${DIMOTIC_MAJ_TAG:-1}
    container_name: dimotic-maj
    restart: unless-stopped
    profiles: ["maj"]
    network_mode: host
    environment:
      - TZ=Europe/Paris
      - MAJ_DIR=${DIMOTIC_DIR:-/docker/dimotic-ha}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DIMOTIC_DIR:-/docker/dimotic-ha}:${DIMOTIC_DIR:-/docker/dimotic-ha}
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
YAML
  echo "Service maj ajouté à $F"
fi
cd "$DIR"
docker compose --profile maj config -q
docker compose --profile maj up -d maj
sleep 6
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E 'dimotic'
echo "--- journal de l'agent :"; docker logs --tail 5 dimotic-maj 2>&1 | cut -c1-200
