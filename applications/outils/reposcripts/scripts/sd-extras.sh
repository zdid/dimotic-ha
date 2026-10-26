#!/bin/bash
# sd-extras.sh — services, intégrations et options posés dans l'image par prepare-sd-card.sh (sourcé, jamais lancé seul).
# ⭐ 26/10/2026 (Outils v1.12) — cases à cocher : SERVICES (dossiers /docker/<service>/ avec leur compose, NON démarrés),
# INTEGRATIONS_HA (custom_components de Home Assistant), OPTIONS_SYSTEME (rotation des journaux Docker, fuseau Paris,
# dossier de sauvegarde Nextcloud, WireGuard), COMPTES (didier, claude), DuckDNS + Caddy.
#
# Les fonctions travaillent sur $ROOTFS (racine de l'image montée) ; seules les fonctions de comptes ont besoin de in_chroot.
# Modèles de compose : ./modeles/<service>/ (dans l'archive Outils comme dans le dépôt, à côté de ce fichier).

EXTRAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRAS_MODELES="${EXTRAS_MODELES:-$EXTRAS_DIR/modeles}"
EXTRAS_SERVICES_CONNUS="homeassistant zigbee2mqtt mosquitto portainer-agent whisper piper dimotic-maj caddy"
EXTRAS_INTEGRATIONS_CONNUES="hacs dimotic_taxonomie dimotic_plans screen_console"
EXTRAS_OPTIONS_CONNUES="rotation-journaux-docker fuseau-paris sauvegarde-nextcloud wireguard claude-code"

extras_contient() { # $1 = liste "a,b,c", $2 = élément
  case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac
}

extras_valider() { # $1 = nom du champ, $2 = liste choisie, $3 = valeurs connues (séparées par des espaces)
  local x
  [ -n "$2" ] || return 0
  IFS=',' read -ra _items <<< "$2"
  for x in "${_items[@]}"; do
    case " $3 " in *" $x "*) ;; *) echo "ERREUR : $1 : « $x » inconnu (connus : $3)." >&2; return 1 ;; esac
  done
}

# --------------------------------------------------------------------------
# Paquets que les options ajoutent à l'installation de l'image de base (avant apt-get)
# --------------------------------------------------------------------------
extras_paquets() { # $1 = options ; affiche les paquets, séparés par des espaces
  local out=""
  extras_contient "$1" wireguard && out="$out wireguard-tools"
  extras_contient "$1" sauvegarde-nextcloud && out="$out cron tar"
  echo "${out# }"
}

# --------------------------------------------------------------------------
# Services : /docker/<service>/ avec compose.yaml (jamais démarré dans l'image)
# --------------------------------------------------------------------------
extras_pose_services() { # $1 = services
  local s
  [ -n "$1" ] || return 0
  IFS=',' read -ra _svc <<< "$1"
  for s in "${_svc[@]}"; do
    case "$s" in
      homeassistant|zigbee2mqtt|mosquitto|portainer-agent|whisper|piper)
        [ -f "$EXTRAS_MODELES/$s/compose.yaml" ] || { echo "ERREUR : modèle introuvable : $EXTRAS_MODELES/$s/compose.yaml" >&2; return 1; }
        mkdir -p "$ROOTFS/docker/$s"
        cp -r "$EXTRAS_MODELES/$s/." "$ROOTFS/docker/$s/"
        case "$s" in
          homeassistant) mkdir -p "$ROOTFS/docker/$s/config" ;;
          zigbee2mqtt|whisper|piper) mkdir -p "$ROOTFS/docker/$s/data" ;;
          mosquitto) mkdir -p "$ROOTFS/docker/$s/data" "$ROOTFS/docker/$s/log" ;;
        esac
        echo "  Service $s : /docker/$s/ (compose posé, NON démarré)."
        ;;
      dimotic-maj)
        # Le service « maj » est déjà dans le compose de dimotic-ha (profil « maj ») : il suffit de l'activer pour qu'un
        # « docker compose up -d » le démarre aussi.
        mkdir -p "$ROOTFS/docker/dimotic-ha"
        if ! grep -qs '^COMPOSE_PROFILES=.*maj' "$ROOTFS/docker/dimotic-ha/.env"; then
          printf 'COMPOSE_PROFILES=maj\n' >> "$ROOTFS/docker/dimotic-ha/.env"
        fi
        echo "  Service dimotic-maj : profil « maj » activé dans /docker/dimotic-ha/.env (NON démarré)."
        ;;
      caddy) : ;;   # posé par machine avec les domaines DuckDNS (extras_machine_duckdns)
      *) echo "ERREUR : service inconnu : $s" >&2; return 1 ;;
    esac
  done
}

# --------------------------------------------------------------------------
# Intégrations Home Assistant : /docker/homeassistant/config/custom_components/<domaine>/
# --------------------------------------------------------------------------
# Extrait un dossier d'une archive zip : $1 = zip, $2 = préfixe dans l'archive ("" = racine), $3 = destination.
extras_extraire_zip() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys, zipfile, os
zpath, prefix, dest = sys.argv[1:4]
z = zipfile.ZipFile(zpath)
prefix = prefix.strip('/')
base = prefix + '/' if prefix else ''
names = [n for n in z.namelist() if n.startswith(base) and not n.endswith('/')]
if not names:
    sys.exit("archive sans « %s »" % prefix)
for n in names:
    rel = n[len(base):]
    if rel.startswith('/') or '..' in rel.split('/'):
        sys.exit("chemin refusé : " + n)
    target = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with z.open(n) as src, open(target, 'wb') as out:
        out.write(src.read())
PY
}

# Dernière version publiée d'un dépôt zdid : affiche le nom de l'étiquette (ex. v0.1.2).
extras_derniere_release() {
  curl -fsSL "https://api.github.com/repos/zdid/$1/releases/latest" | python3 -I -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])'
}

extras_pose_integrations() { # $1 = intégrations ; EXTRAS_ZIP_DIR (essais) : dossier de zips locaux au lieu de GitHub
  local i cc tmp tag dest
  [ -n "$1" ] || return 0
  cc="$ROOTFS/docker/homeassistant/config/custom_components"
  [ -d "$ROOTFS/docker/homeassistant" ] || { echo "ERREUR : les intégrations demandent le service « homeassistant » (à cocher aussi)." >&2; return 1; }
  mkdir -p "$cc"
  tmp="$(mktemp -d)"
  IFS=',' read -ra _int <<< "$1"
  for i in "${_int[@]}"; do
    dest="$cc/$i"
    rm -rf "$dest"
    case "$i" in
      hacs)
        if [ -n "${EXTRAS_ZIP_DIR:-}" ]; then cp "$EXTRAS_ZIP_DIR/hacs.zip" "$tmp/hacs.zip"
        else curl -fsSL -o "$tmp/hacs.zip" "https://github.com/hacs/integration/releases/latest/download/hacs.zip"; fi
        extras_extraire_zip "$tmp/hacs.zip" "" "$dest" || { rm -rf "$tmp"; return 1; }
        echo "  Intégration hacs : posée (dernière version)."
        ;;
      dimotic_taxonomie|dimotic_plans|screen_console)
        local repo="dimotic-ha-${i#dimotic_}"
        [ "$i" = dimotic_taxonomie ] && repo=dimotic-ha-taxonomie
        [ "$i" = dimotic_plans ] && repo=dimotic-ha-plans
        [ "$i" = screen_console ] && repo=dimotic-ha-screen-console
        if [ -n "${EXTRAS_ZIP_DIR:-}" ]; then
          tag="essai"; cp "$EXTRAS_ZIP_DIR/$repo.zip" "$tmp/$i.zip"
        else
          tag="$(extras_derniere_release "$repo")" || { echo "ERREUR : dernière version de $repo introuvable (réseau ?)" >&2; rm -rf "$tmp"; return 1; }
          curl -fsSL -o "$tmp/$i.zip" "https://github.com/zdid/$repo/archive/refs/tags/$tag.zip"
        fi
        extras_extraire_zip "$tmp/$i.zip" "$repo-${tag#v}/custom_components/$i" "$dest" \
          || extras_extraire_zip "$tmp/$i.zip" "$repo-$tag/custom_components/$i" "$dest" \
          || { echo "ERREUR : $i introuvable dans l'archive de $repo ($tag)" >&2; rm -rf "$tmp"; return 1; }
        echo "  Intégration $i : posée ($tag)."
        ;;
      *) echo "ERREUR : intégration inconnue : $i" >&2; rm -rf "$tmp"; return 1 ;;
    esac
  done
  rm -rf "$tmp"
}

# --------------------------------------------------------------------------
# Options du système
# --------------------------------------------------------------------------
extras_pose_options() { # $1 = options
  [ -n "$1" ] || return 0
  if extras_contient "$1" rotation-journaux-docker; then
    mkdir -p "$ROOTFS/etc/docker"
    cat > "$ROOTFS/etc/docker/daemon.json" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
    echo "  Rotation des journaux Docker : 10 Mo × 5 fichiers par conteneur (/etc/docker/daemon.json)."
  fi
  if extras_contient "$1" fuseau-paris; then
    mkdir -p "$ROOTFS/etc"
    ln -sf /usr/share/zoneinfo/Europe/Paris "$ROOTFS/etc/localtime"
    printf 'Europe/Paris\n' > "$ROOTFS/etc/timezone"
    echo "  Fuseau horaire : Europe/Paris."
  fi
  if extras_contient "$1" sauvegarde-nextcloud; then
    mkdir -p "$ROOTFS/dimotic-backup"
    echo "  Sauvegarde Nextcloud : /dimotic-backup/ et paquets (cron, tar, curl) ; le script, le mot de passe et l'horaire sont posés par machine."
  fi
  if extras_contient "$1" claude-code; then
    # Claude Code (CLI) installé pour tous les comptes, par npm (Node.js est déjà dans l'image de base). Binaire natif : 64 bits seulement.
    [ "${QEMU_BIN:-}" = "qemu-aarch64-static" ] || { echo "ERREUR : claude-code demande un système 64 bits (Raspberry Pi 64 bits ou Orange Pi) ; ce modèle est en 32 bits." >&2; return 1; }
    echo "  Claude Code : installation globale (npm install -g @anthropic-ai/claude-code)..."
    in_chroot "npm install -g @anthropic-ai/claude-code" || { echo "ERREUR : installation de Claude Code impossible (réseau ?)" >&2; return 1; }
    in_chroot "command -v claude >/dev/null" || { echo "ERREUR : la commande « claude » est introuvable après l'installation" >&2; return 1; }
    echo "  Claude Code installé — la connexion au compte Anthropic reste à faire (commande « claude », par l'utilisateur)."
  fi
  if extras_contient "$1" wireguard; then
    mkdir -p "$ROOTFS/etc/wireguard"; chmod 700 "$ROOTFS/etc/wireguard"
    echo "  WireGuard : outils installés, /etc/wireguard/ vide — la configuration (clés) du tunnel reste à poser."
  fi
}

# --------------------------------------------------------------------------
# Par machine : comptes didier / claude
# --------------------------------------------------------------------------
# $1 = comptes ; $2 = utilisateur déjà créé par le profil ; PERSONAL_KEYS (clés de didier) ; EXTRAS_CLAUDE_KEY (clé publique de claude)
extras_machine_comptes() {
  local a keyfile
  [ -n "$1" ] || return 0
  IFS=',' read -ra _cpt <<< "$1"
  for a in "${_cpt[@]}"; do
    case "$a" in didier|claude) ;; *) echo "ERREUR : compte inconnu : $a" >&2; return 1 ;; esac
    if [ "$a" = "$2" ]; then echo "  Compte $a : déjà créé par le profil (utilisateur principal)."; continue; fi
    in_chroot "id $a >/dev/null 2>&1 || adduser --disabled-password --gecos '' $a" >/dev/null
    in_chroot "usermod -aG sudo,docker $a 2>/dev/null || usermod -aG sudo $a"
    mkdir -p "$ROOTFS/home/$a/.ssh"
    : > "$ROOTFS/home/$a/.ssh/authorized_keys"
    if [ "$a" = claude ]; then
      [ -f "${EXTRAS_CLAUDE_KEY:-}" ] || { echo "ERREUR : compte claude : clé publique introuvable (${EXTRAS_CLAUDE_KEY:-non indiquée})" >&2; return 1; }
      cat "$EXTRAS_CLAUDE_KEY" >> "$ROOTFS/home/$a/.ssh/authorized_keys"
      printf 'claude ALL=(ALL) NOPASSWD:ALL\n' > "$ROOTFS/etc/sudoers.d/claude"
      chmod 440 "$ROOTFS/etc/sudoers.d/claude"
    else
      for keyfile in "${PERSONAL_KEYS[@]}"; do cat "$keyfile" >> "$ROOTFS/home/$a/.ssh/authorized_keys"; done
    fi
    in_chroot "chown -R $a:$a /home/$a/.ssh; chmod 700 /home/$a/.ssh; chmod 600 /home/$a/.ssh/authorized_keys"
    if [ "$a" = claude ]; then echo "  Compte $a : créé (sudo sans mot de passe, groupe docker, connexion par clé)."
    else echo "  Compte $a : créé (sudo, groupe docker, connexion par clé)."; fi
  done
}

# --------------------------------------------------------------------------
# Par machine : sauvegarde Nextcloud (script rendu par le générateur de l'application Sauvegarde, mot de passe d'application, cron 3 h 05)
# --------------------------------------------------------------------------
# $1 = site, $2 = machine, $3 = URL Nextcloud, $4 = utilisateur, $5 = dossier racine ; mot de passe d'application : variable
# NEXTCLOUD_PASSWORD (jamais en argument ni affiché). Même résultat que le bouton « Pousser » de l'application Sauvegarde : le cron est
# dans le crontab de root (et non dans /etc/cron.d), donc un « Pousser » ultérieur le retrouve et ne crée pas de doublon.
extras_machine_sauvegarde() {
  local site="$1" machine="$2" url="$3" user="$4" racine="$5"
  local secret="/dimotic-secrets/nextcloud-backup" script="/dimotic-backup/nextcloud-backup.sh"
  [ -n "${NEXTCLOUD_PASSWORD:-}" ] || { echo "ERREUR : sauvegarde Nextcloud : mot de passe d'application manquant." >&2; return 1; }
  [[ "$site" =~ ^[A-Za-z0-9_-]+$ && "$machine" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERREUR : sauvegarde Nextcloud : site ou machine invalide (« $site » / « $machine »)." >&2; return 1; }
  command -v node >/dev/null 2>&1 || { echo "ERREUR : sauvegarde Nextcloud : node introuvable sur cette machine (génération du script)." >&2; return 1; }
  mkdir -p "$ROOTFS/dimotic-backup" "$ROOTFS/dimotic-secrets" "$ROOTFS/var/spool/cron/crontabs"
  chmod 700 "$ROOTFS/dimotic-secrets"
  node "$EXTRAS_DIR/sauvegarde-rendu/rendre.js" "$site" "$machine" "$url" "$user" "$racine" "$secret" > "$ROOTFS$script" \
    || { echo "ERREUR : génération du script de sauvegarde impossible." >&2; return 1; }
  chmod 755 "$ROOTFS$script"
  printf '%s' "$NEXTCLOUD_PASSWORD" > "$ROOTFS$secret"
  chmod 600 "$ROOTFS$secret"
  printf '5 3 * * * %s >> /dimotic-backup/cron.log 2>&1\n' "$script" > "$ROOTFS/var/spool/cron/crontabs/root"
  chmod 600 "$ROOTFS/var/spool/cron/crontabs/root"
  in_chroot "chown root:crontab /var/spool/cron/crontabs/root 2>/dev/null || true"
  echo "  Sauvegarde Nextcloud : $site/$machine -> $url ($racine), tous les jours à 3 h 05 ; script $script, mot de passe dans $secret (600)."
}

# --------------------------------------------------------------------------
# Par machine : DuckDNS + Caddy
# --------------------------------------------------------------------------
# ⭐ 26/10/2026 (Outils v1.13) — saisie simplifiée : $1 = cases cochées « nom → hôte:port » séparées par des virgules,
# $2 = saisie libre « nom », « nom:port » ou « nom=hôte:port » (espaces ou virgules). Machine vide = cette carte
# (localhost : Caddy est en network_mode host), port vide = 8123. Sortie : une ligne « nom=hôte:port » par adresse.
extras_duckdns_entrees() {
  local item nom reste hote port
  local -a items=() libres=()
  IFS=',' read -ra items <<< "$1"
  for item in "${items[@]}"; do
    item="$(echo "$item" | sed 's/^ *//; s/ *$//')"; [ -n "$item" ] || continue
    nom="${item%%→*}"; reste="${item#*→}"
    printf '%s=%s\n' "$(echo "$nom" | tr -d ' ')" "$(echo "$reste" | tr -d ' ')"
  done
  read -ra libres <<< "${2//,/ }"
  for item in "${libres[@]}"; do
    if [[ "$item" == *=* ]]; then nom="${item%%=*}"; reste="${item#*=}"
    elif [[ "$item" == *:* ]]; then nom="${item%%:*}"; reste=":${item#*:}"
    else nom="$item"; reste=""; fi
    hote="${reste%%:*}"; port=""; [[ "$reste" == *:* ]] && port="${reste#*:}"
    nom="${nom%.duckdns.org}"
    [[ "$nom" =~ ^[a-z0-9-]+$ ]] || { echo "ERREUR : DuckDNS : nom invalide « $nom » (minuscules, chiffres, tirets, sans .duckdns.org)" >&2; return 1; }
    [[ -z "$port" || "$port" =~ ^[0-9]+$ ]] || { echo "ERREUR : DuckDNS : port invalide « $port » pour $nom" >&2; return 1; }
    printf '%s=%s:%s\n' "$nom" "${hote:-localhost}" "${port:-8123}"
  done
}

# Par machine : DuckDNS + Caddy (pose)
# --------------------------------------------------------------------------
# $1 = jeton DuckDNS ; $2... = "domaine=hôte:port" (domaine sans .duckdns.org). Le jeton est un secret : il n'est écrit
# que dans les scripts de mise à jour (mode 700), jamais affiché.
extras_machine_duckdns() {
  local token="$1" entree domaine cible n=0
  shift
  [ $# -gt 0 ] || return 0
  [ -n "$token" ] || { echo "ERREUR : DuckDNS : jeton manquant." >&2; return 1; }
  mkdir -p "$ROOTFS/dimotic-ha-addons/duckdns" "$ROOTFS/docker/caddy" "$ROOTFS/etc/cron.d"
  : > "$ROOTFS/docker/caddy/Caddyfile"
  for entree in "$@"; do
    domaine="${entree%%=*}"; cible="${entree#*=}"
    [[ "$domaine" =~ ^[a-z0-9-]+$ ]] || { echo "ERREUR : DuckDNS : nom de domaine invalide « $domaine »" >&2; return 1; }
    [[ "$cible" =~ ^[A-Za-z0-9.:_-]+:[0-9]+$ ]] || { echo "ERREUR : DuckDNS : cible invalide « $cible » (attendu hôte:port)" >&2; return 1; }
    n=$((n + 1))
    printf '#!/bin/bash\ncurl -fsS "https://www.duckdns.org/update?domains=%s&token=%s&ip=" -o /dev/null\n' "$domaine" "$token" \
      > "$ROOTFS/dimotic-ha-addons/duckdns/$domaine.sh"
    chmod 700 "$ROOTFS/dimotic-ha-addons/duckdns/$domaine.sh"
    printf '*/5 * * * * root /dimotic-ha-addons/duckdns/%s.sh >> /var/log/duckdns-%s.log 2>&1\n' "$domaine" "$domaine" \
      > "$ROOTFS/dimotic-ha-addons/duckdns/$domaine.cron"
    ln -sf "/dimotic-ha-addons/duckdns/$domaine.cron" "$ROOTFS/etc/cron.d/duckdns-${domaine//./-}"
    printf '%s.duckdns.org {\n    reverse_proxy %s\n}\n\n' "$domaine" "$cible" >> "$ROOTFS/docker/caddy/Caddyfile"
    echo "  DuckDNS : $domaine.duckdns.org -> $cible (mise à jour toutes les 5 min)."
  done
  cat > "$ROOTFS/docker/caddy/compose.yaml" <<'EOF'
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
  echo "  Caddy : /docker/caddy/ (compose et Caddyfile posés, NON démarré — TLS automatique au démarrage)."
}
