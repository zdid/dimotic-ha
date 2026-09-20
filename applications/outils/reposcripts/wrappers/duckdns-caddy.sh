#!/bin/bash
# Généré par l'application Outils — met en place, sur CETTE machine (sudo requis) : mise(s) à jour
# DuckDNS (cron dédié par domaine), un Caddyfile (reverse proxy), et le conteneur Docker Caddy.
#
# Jusqu'à 5 lignes indépendantes DOMAIN/DUCKDNS_TOKEN/TARGET/CRON_MINUTES — toutes ne sont pas
# obligatoires, mais AU MOINS UNE doit être complète (DOMAIN + DUCKDNS_TOKEN + TARGET). Une ligne
# avec DOMAIN vide est simplement ignorée. Un seul Caddy (plusieurs blocs dans le même Caddyfile),
# mais un cron + un script de mise à jour DuckDNS PAR domaine (jetons potentiellement différents).
#
# TARGET_n : adresse:port de ce que Caddy doit exposer pour ce domaine (ex: 127.0.0.1:8087 pour
# dimotic-ha lui-même, ou l'adresse de n'importe quel autre service sur le réseau local).
#
# @outils:hint DOMAIN_1 = Sous-domaine DuckDNS (ex: monsite -> monsite.duckdns.org). Vide = ligne ignorée.
# @outils:hint TARGET_1 = Adresse:port à exposer via ce domaine (ex: 127.0.0.1:8087).
# @outils:select CRON_MINUTES_1 = 5, 10, 15
# @outils:default CRON_MINUTES_1 = 5
# @outils:hint DOMAIN_2 = Sous-domaine DuckDNS. Vide = ligne ignorée.
# @outils:hint TARGET_2 = Adresse:port à exposer via ce domaine.
# @outils:select CRON_MINUTES_2 = 5, 10, 15
# @outils:default CRON_MINUTES_2 = 5
# @outils:hint DOMAIN_3 = Sous-domaine DuckDNS. Vide = ligne ignorée.
# @outils:hint TARGET_3 = Adresse:port à exposer via ce domaine.
# @outils:select CRON_MINUTES_3 = 5, 10, 15
# @outils:default CRON_MINUTES_3 = 5
# @outils:hint DOMAIN_4 = Sous-domaine DuckDNS. Vide = ligne ignorée.
# @outils:hint TARGET_4 = Adresse:port à exposer via ce domaine.
# @outils:select CRON_MINUTES_4 = 5, 10, 15
# @outils:default CRON_MINUTES_4 = 5
# @outils:hint DOMAIN_5 = Sous-domaine DuckDNS. Vide = ligne ignorée.
# @outils:hint TARGET_5 = Adresse:port à exposer via ce domaine.
# @outils:select CRON_MINUTES_5 = 5, 10, 15
# @outils:default CRON_MINUTES_5 = 5

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Ce script doit être lancé avec sudo (cron, /etc, Docker)." >&2
  exit 1
fi

MISSING=()
command -v docker >/dev/null 2>&1 || MISSING+=("docker.io (ou Docker CE, voir https://get.docker.com)")
docker compose version >/dev/null 2>&1 || MISSING+=("docker-compose-plugin")
command -v curl >/dev/null 2>&1 || MISSING+=("curl")
command -v crontab >/dev/null 2>&1 || MISSING+=("cron")
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "Paquet(s) manquant(s) sur cette machine :" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 1
fi

DOMAIN_1="__DOMAIN_1__"; DUCKDNS_TOKEN_1="__DUCKDNS_TOKEN_1__"; TARGET_1="__TARGET_1__"; CRON_MINUTES_1="__CRON_MINUTES_1__"
DOMAIN_2="__DOMAIN_2__"; DUCKDNS_TOKEN_2="__DUCKDNS_TOKEN_2__"; TARGET_2="__TARGET_2__"; CRON_MINUTES_2="__CRON_MINUTES_2__"
DOMAIN_3="__DOMAIN_3__"; DUCKDNS_TOKEN_3="__DUCKDNS_TOKEN_3__"; TARGET_3="__TARGET_3__"; CRON_MINUTES_3="__CRON_MINUTES_3__"
DOMAIN_4="__DOMAIN_4__"; DUCKDNS_TOKEN_4="__DUCKDNS_TOKEN_4__"; TARGET_4="__TARGET_4__"; CRON_MINUTES_4="__CRON_MINUTES_4__"
DOMAIN_5="__DOMAIN_5__"; DUCKDNS_TOKEN_5="__DUCKDNS_TOKEN_5__"; TARGET_5="__TARGET_5__"; CRON_MINUTES_5="__CRON_MINUTES_5__"

ADDON_DIR=/dimotic-ha-addons/duckdns
DOCKER_DIR=/docker/caddy
CADDYFILE="$DOCKER_DIR/Caddyfile"
mkdir -p "$ADDON_DIR" "$DOCKER_DIR"
: > "$CADDYFILE"

COUNT=0
for i in 1 2 3 4 5; do
  domain_var="DOMAIN_$i"; token_var="DUCKDNS_TOKEN_$i"; target_var="TARGET_$i"; cron_var="CRON_MINUTES_$i"
  domain="${!domain_var}"
  [ -z "$domain" ] && continue
  token="${!token_var}"
  target="${!target_var}"
  cron_minutes="${!cron_var:-5}"
  if [ -z "$token" ] || [ -z "$target" ]; then
    echo "Ligne $i : DOMAIN renseigné mais DUCKDNS_TOKEN ou TARGET manquant — ignorée." >&2
    continue
  fi
  COUNT=$((COUNT + 1))

  UPDATE_SCRIPT="$ADDON_DIR/${domain}.sh"
  cat > "$UPDATE_SCRIPT" <<EOF
#!/bin/bash
curl -fsS "https://www.duckdns.org/update?domains=${domain}&token=${token}&ip=" -o /dev/null
EOF
  chmod +x "$UPDATE_SCRIPT"

  # ⭐ Convention self-describing systemd/cron du projet : fichier canonique dans le dossier de
  # l'app, symlink vers /etc/cron.d — nom du symlink SANS point (sinon Debian l'ignore en silence).
  CRON_FILE="$ADDON_DIR/${domain}.cron"
  cat > "$CRON_FILE" <<EOF
*/${cron_minutes} * * * * root ${UPDATE_SCRIPT} >> /var/log/duckdns-${domain}.log 2>&1
EOF
  ln -sf "$CRON_FILE" "/etc/cron.d/duckdns-${domain//./-}"

  cat >> "$CADDYFILE" <<EOF
${domain}.duckdns.org {
    reverse_proxy ${target}
}

EOF

  echo "Ligne $i : ${domain}.duckdns.org -> ${target} (mise à jour DuckDNS toutes les ${cron_minutes} min)."
done

if [ "$COUNT" -eq 0 ]; then
  echo "ERREUR : aucune ligne complète (DOMAIN + DUCKDNS_TOKEN + TARGET) — rien à faire." >&2
  exit 1
fi

cat > "$DOCKER_DIR/compose.yaml" <<'EOF'
services:
  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF

(cd "$DOCKER_DIR" && docker compose up -d)

echo "Terminé — $COUNT domaine(s) configuré(s), Caddy démarré ($DOCKER_DIR)."
