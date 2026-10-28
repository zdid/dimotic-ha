#!/bin/bash
# Généré par l'application Outils — INSTALLE L'IA (Claude Code) sur une machine qui porte Home Assistant et dimotic-ha,
# À LANCER SUR CETTE MACHINE (sudo, ou « Exécution par SSH »). ⭐ 28/10/2026, remplace « Agent Claude Code » (agent-ha-deploy).
# But (MEMO_mise-en-place-ia-screen_2026-10-28) : l'IA marche du premier coup — panneau « IA » de Home Assistant
# (intégration screen_console) ET Remote Control de Claude Code, une seule session, branchée sur le MCP de dimotic-ha.
# Seule étape manuelle restante : la connexion au compte Claude par le web, au premier lancement.
#
# Tout est lu sur la machine (rien à saisir) : site (data/core/machine_config.yaml), adresse et jeton de Home Assistant
# (data/core), réglages MCP de ia (data/ia). Relançable sans dommage : chaque étape vérifie ce qui est déjà en place.
#   1. compte « claude » (sudo sans mot de passe, docker — décision du 28/10/2026), paquets screen/acl/python3 ;
#   2. Claude Code dans le compte (installeur natif) s'il n'est trouvé nulle part ;
#   3. serveur MCP de ia : activé, jeton généré s'il manque, à l'écoute sur l'IP réseau de la machine (jamais 127.0.0.1) ;
#   4. dossier de travail /dimotic-ha-addons/agent-ha : CLAUDE.md (modèle du dépôt + fiche du site), .mcp.json, permissions ;
#   5. premières questions de Claude Code pré-répondues (accueil, confiance du dossier, approbation du serveur « dimotic ») ;
#   6. service claude-screen : screen « claude » + Remote Control nommé « <site> automatisation HA », relancé après /exit ;
#   7. panneau « IA » : clé de screen_console, script de contrôle, ligne authorized_keys, entrée de l'intégration dans HA.
# --auto (minuteur posé par la carte SD, toutes les 5 minutes) : aucune question ; code 75 tant que dimotic-ha (arrêté ou pas
# encore restauré) ou Home Assistant ne sont pas prêts ; ensuite, ne touche à rien si rien n'a changé (la session n'est relancée que
# si sa configuration change) et suit un changement d'adresse de la machine (ex. remplacement de noisy2 : .25 -> .201).
# Ne démarre jamais dimotic-ha s'il est arrêté.
#
# @outils:bundle applications/ia/agent/claude-md => claude-md
# @outils:select MODE = installer, mettre_a_jour_claude_md
# @outils:default MODE = installer
# @outils:hint MODE = installer : tout (relançable). mettre_a_jour_claude_md : réécrit SEULEMENT le CLAUDE.md (modèle du dépôt) puis relance la session.
# @outils:default CLAUDE_USER = claude
# @outils:hint CLAUDE_USER = Compte Linux qui exécute Claude Code (créé s'il manque, sudo sans mot de passe et docker).
# @outils:default DIMOTIC_DIR = /docker/dimotic-ha
# @outils:hint DIMOTIC_DIR = Dossier de dimotic-ha sur la machine (contient compose.yaml et data/).
# @outils:default HA_CONFIG_DIR = /docker/homeassistant/config
# @outils:hint HA_CONFIG_DIR = Dossier de configuration de Home Assistant. Lecture autorisée de automations.yaml, scripts.yaml, scenes.yaml, configuration.yaml ; secrets.yaml et .storage interdits.
# @outils:select FICHE_SITE = automatique, aucune, ha2, noisy2, dev
# @outils:default FICHE_SITE = automatique
# @outils:hint FICHE_SITE = Connaissances propres au site ajoutées à la fin du CLAUDE.md (site.md, jamais écrasé s'il existe déjà). automatique : ha2 pour le site stfort, noisy2 pour noisy.
# @outils:hint NOM_SESSION = Nom de la session dans le Remote Control. Vide = « <site> automatisation HA » (ex. « stfort automatisation HA »).
# @outils:hint ADRESSE_MACHINE = IP réseau de cette machine pour le serveur MCP. Vide = détectée (adresse de la route par défaut).
# @outils:select PERMISSION_MODE = default, acceptEdits
# @outils:default PERMISSION_MODE = default

set -uo pipefail

MODE="__MODE__"
CLAUDE_USER="__CLAUDE_USER__"
DIMOTIC_DIR="__DIMOTIC_DIR__"
HA_CONFIG_DIR="__HA_CONFIG_DIR__"
FICHE_SITE="__FICHE_SITE__"
NOM_SESSION="__NOM_SESSION__"
ADRESSE_MACHINE="__ADRESSE_MACHINE__"
PERMISSION_MODE="__PERMISSION_MODE__"

AUTO=0; [ "${1:-}" = "--auto" ] && AUTO=1
PAS_PRET=75                                    # code « réessayer plus tard » (mode --auto)
AGENT_DIR="/dimotic-ha-addons/agent-ha"
SCREEN_NAME="claude"                           # nom court du screen (panneau « IA » : la session « claude » vient en tête)
SERVICE="claude-screen.service"
MCP_PORT_DEFAUT=8765
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DIMOTIC_DIR="${DIMOTIC_DIR%/}"; HA_CONFIG_DIR="${HA_CONFIG_DIR%/}"
DATA="$DIMOTIC_DIR/data"

etape() { echo; echo "=== $*"; }
pas_pret() { echo "PAS ENCORE PRÊT : $*" >&2; [ "$AUTO" = 1 ] && exit "$PAS_PRET"; exit 1; }
erreur() { echo "ERREUR : $*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || erreur "à lancer avec sudo (comptes, systemd, configuration de dimotic-ha)."
case "$MODE" in installer|mettre_a_jour_claude_md) ;; *) erreur "MODE inconnu « $MODE »." ;; esac
case "$PERMISSION_MODE" in default|acceptEdits) ;; *) erreur "PERMISSION_MODE inconnu « $PERMISSION_MODE »." ;; esac
[[ "$CLAUDE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$CLAUDE_USER" != root ] || erreur "compte « $CLAUDE_USER » refusé."

# Modèle du CLAUDE.md : à côté du script (archive Outils, ou copie posée sur la carte SD) ou dans le dépôt.
TPL_SRC=""
for c in "$SCRIPT_DIR/claude-md" "$SCRIPT_DIR/../../../ia/agent/claude-md" "$AGENT_DIR/claude-md"; do
  [ -f "$c/VERSION" ] && { TPL_SRC="$(cd "$c" && pwd)"; break; }
done
[ -n "$TPL_SRC" ] || erreur "modèle du CLAUDE.md introuvable (claude-md/) — régénérez le script depuis Outils."

# --- Lecture de la configuration de dimotic-ha (YAML simple : clé à une profondeur donnée, sans dépendance) ---
# yaml_val <fichier> <chemin a.b.c> : valeur scalaire, guillemets retirés ; vide si absente.
yaml_val() {
  awk -v chemin="$2" '
    BEGIN { n = split(chemin, cles, ".") }
    /^[[:space:]]*(#|$)/ { next }
    {
      match($0, /^ */); ind = RLENGTH; ligne = substr($0, ind + 1)
      if (index(ligne, ":") == 0) next
      cle = substr(ligne, 1, index(ligne, ":") - 1); val = substr(ligne, index(ligne, ":") + 1)
      niv = int(ind / 2) + 1
      if (niv > n) next
      pile[niv] = cle
      for (i = niv + 1; i <= n; i++) pile[i] = ""
      if (niv == n) {
        ok = 1; for (i = 1; i <= n; i++) if (pile[i] != cles[i]) ok = 0
        if (ok) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", val); gsub(/^["\x27]|["\x27]$/, "", val); print val; exit }
      }
    }' "$1" 2>/dev/null
}
# yaml_poser <fichier> <clé de 1er niveau> <valeur> : remplace ou ajoute une clé de premier niveau (fichier « objet nu »).
yaml_poser() {
  if grep -qE "^$2:" "$1" 2>/dev/null; then sed -i -E "s|^$2:.*|$2: $3|" "$1"; else printf '%s: %s\n' "$2" "$3" >> "$1"; fi
}

[ -f "$DATA/core/config.yaml" ] || pas_pret "dimotic-ha introuvable ou pas encore configuré ($DATA/core/config.yaml absent — restauration à faire ?)."
SITE="$(yaml_val "$DATA/core/machine_config.yaml" core.site)"
[ -n "$SITE" ] || SITE="$(yaml_val "$DATA/core/config.yaml" core.site)"
[ -n "$SITE" ] || SITE="$(hostname -s)"
HA_HOST="$(yaml_val "$DATA/core/config.yaml" ha.ws.host)"
HA_PORT="$(yaml_val "$DATA/core/config.yaml" ha.ws.port)"; HA_PORT="${HA_PORT:-8123}"
HA_TOKEN="$(yaml_val "$DATA/core/secrets_config.yaml" ha.ws.token)"
[ -n "$NOM_SESSION" ] || NOM_SESSION="$SITE automatisation HA"
if [ -z "$ADRESSE_MACHINE" ]; then
  ADRESSE_MACHINE="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
fi
case "$ADRESSE_MACHINE" in ""|127.*|localhost) pas_pret "adresse réseau de la machine introuvable (réseau pas encore monté ?) — renseignez ADRESSE_MACHINE." ;; esac
case "$FICHE_SITE" in
  automatique) case "$SITE" in stfort) FICHE_SITE=ha2 ;; noisy) FICHE_SITE=noisy2 ;; *) FICHE_SITE=aucune ;; esac ;;
esac
echo "Machine $(hostname) — site « $SITE », adresse $ADRESSE_MACHINE, Home Assistant ${HA_HOST:-?}:$HA_PORT, session « $NOM_SESSION »"

CLAUDE_HOME=""
as_claude() { runuser -u "$CLAUDE_USER" -- "$@"; }

# Écrit l'entrée standard dans $1 seulement si le contenu change ; SESSION_A_RELANCER=1 dans ce cas.
SESSION_A_RELANCER=0
ecrire_si_change() {
  local tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 0; fi
  mv "$tmp" "$1"; SESSION_A_RELANCER=1
}

# --- Rendu du CLAUDE.md (modèle du dépôt + fiche du site) -------------------------------------------------------------
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
render_section() {
  sed -e "s|{{TARGET_HOST}}|$(sed_escape "$(hostname) ($ADRESSE_MACHINE, site $SITE)")|g" \
      -e "s|{{HA_CONFIG_DIR}}|$(sed_escape "$HA_CONFIG_DIR")|g" "$1"
}
rendre_claude_md() {
  mkdir -p "$AGENT_DIR"
  rm -rf "$AGENT_DIR/claude-md.new" && cp -r "$TPL_SRC" "$AGENT_DIR/claude-md.new" \
    && rm -rf "$AGENT_DIR/claude-md" && mv "$AGENT_DIR/claude-md.new" "$AGENT_DIR/claude-md"
  if [ ! -s "$AGENT_DIR/site.md" ] && [ "$FICHE_SITE" != aucune ] && [ -f "$TPL_SRC/sites/$FICHE_SITE.md" ]; then
    cp "$TPL_SRC/sites/$FICHE_SITE.md" "$AGENT_DIR/site.md"; echo "Fiche du site : sites/$FICHE_SITE.md -> site.md"
  fi
  # (redirection et non tube : ecrire_si_change doit tourner dans ce shell pour garder SESSION_A_RELANCER)
  ecrire_si_change "$AGENT_DIR/CLAUDE.md" < <({
    printf '<!-- agent-claude-md v%s — généré par installer-ia -->\n\n' "$(tr -d '[:space:]' < "$TPL_SRC/VERSION")"
    render_section "$TPL_SRC/00-role.md"; echo
    render_section "$TPL_SRC/10-dimotic-mcp.md"; echo
    if [ -d "$HA_CONFIG_DIR" ]; then render_section "$TPL_SRC/20-ha-config.md"; echo; fi
    render_section "$TPL_SRC/90-securite.md"
    if [ -s "$AGENT_DIR/site.md" ]; then echo; cat "$AGENT_DIR/site.md"; fi
  })
  echo "CLAUDE.md : v$(tr -d '[:space:]' < "$TPL_SRC/VERSION") ($AGENT_DIR/CLAUDE.md)"
}

if [ "$MODE" = mettre_a_jour_claude_md ]; then
  id -u "$CLAUDE_USER" >/dev/null 2>&1 && [ -d "$AGENT_DIR" ] || erreur "aucune installation trouvée — lancez d'abord le mode « installer »."
  rendre_claude_md
  chown -R "$CLAUDE_USER:$CLAUDE_USER" "$AGENT_DIR"
  systemctl restart "$SERVICE" 2>/dev/null && echo "Session relancée : le nouveau CLAUDE.md est pris en compte."
  exit 0
fi

# === 1. Paquets et compte ===============================================================================================
etape "1. Paquets et compte « $CLAUDE_USER »"
manque=()
for p in screen:screen setfacl:acl python3:python3 curl:curl ssh-keygen:openssh-client; do
  command -v "${p%%:*}" >/dev/null 2>&1 || manque+=("${p#*:}")
done
if [ "${#manque[@]}" -gt 0 ]; then
  echo "Installation : ${manque[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${manque[@]}" >/dev/null 2>&1 \
    || { apt-get update >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y "${manque[@]}" >/dev/null; } \
    || pas_pret "installation de ${manque[*]} impossible (réseau ?)."
fi
if ! id -u "$CLAUDE_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$CLAUDE_USER" || erreur "création du compte impossible."
  echo "Compte créé."
fi
getent group docker >/dev/null && usermod -aG docker "$CLAUDE_USER"
if [ ! -f "/etc/sudoers.d/$CLAUDE_USER" ]; then
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$CLAUDE_USER" > "/etc/sudoers.d/$CLAUDE_USER"; chmod 440 "/etc/sudoers.d/$CLAUDE_USER"
  visudo -cf "/etc/sudoers.d/$CLAUDE_USER" >/dev/null || { rm -f "/etc/sudoers.d/$CLAUDE_USER"; erreur "règle sudo refusée par visudo."; }
fi
CLAUDE_HOME="$(getent passwd "$CLAUDE_USER" | cut -d: -f6)"
echo "Compte « $CLAUDE_USER » : $CLAUDE_HOME, groupes $(id -nG "$CLAUDE_USER" | tr ' ' ',')"

# Données de dimotic-ha : lecture/écriture par ACL PUIS secrets refusés (dans cet ordre, sinon rwX annulerait le refus).
setfacl -R -m "u:$CLAUDE_USER:rwX" "$DATA" && setfacl -R -d -m "u:$CLAUDE_USER:rwX" "$DATA"
secrets=(); while IFS= read -r -d '' f; do secrets+=("$f"); done < <(find "$DATA" -type f \( -name 'secrets_*' -o -name '.mcp_token' -o -name 'id_ed25519' -o -name 'id_rsa' \) -print0)
[ -f "$DATA/sauvegarde/config.yaml" ] && secrets+=("$DATA/sauvegarde/config.yaml")
[ "${#secrets[@]}" -gt 0 ] && setfacl -m "u:$CLAUDE_USER:---" "${secrets[@]}"
for d in "$DATA/core/machine_ssh" "$DATA/outils/saved-values"; do
  [ -d "$d" ] && setfacl -R -m "u:$CLAUDE_USER:---" "$d" && setfacl -R -d -m "u:$CLAUDE_USER:---" "$d"
done
echo "Données de dimotic-ha : lecture/écriture, ${#secrets[@]} fichier(s) de secrets refusés."

# === 2. Claude Code =====================================================================================================
etape "2. Claude Code"
find_claude() {
  local p c
  p="$(as_claude bash -lc 'command -v claude' 2>/dev/null || true)"
  for c in "$CLAUDE_HOME/.local/bin/claude" "$CLAUDE_HOME/.claude/local/claude" "$CLAUDE_HOME/.npm-global/bin/claude" "$(command -v claude 2>/dev/null)"; do
    [ -z "$p" ] && [ -n "$c" ] && [ -x "$c" ] && p="$c"
  done
  printf '%s' "$p"
}
CLAUDE_BIN="$(find_claude)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "Installation dans le compte (installeur natif)..."
  as_claude bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1 || pas_pret "installation de Claude Code impossible (réseau ?)."
  CLAUDE_BIN="$(find_claude)"
fi
[ -n "$CLAUDE_BIN" ] || erreur "Claude Code introuvable après installation."
echo "Claude Code : $CLAUDE_BIN ($(as_claude "$CLAUDE_BIN" --version 2>/dev/null | head -1))"

# === 3. Serveur MCP de ia ===============================================================================================
etape "3. Serveur MCP de dimotic-ha (application ia)"
IA_CONF="$DATA/ia/config.yaml"; IA_SECRETS="$DATA/ia/secrets_config.yaml"
[ -d "$DATA/ia" ] || pas_pret "application ia pas encore initialisée ($DATA/ia absent) — activez-la dans dimotic-ha."
# Jamais de démarrage de dimotic-ha : arrêté = volontaire (ex. machine de remplacement pas encore en service).
[ -n "$(cd "$DIMOTIC_DIR" && docker compose ps --status running -q 2>/dev/null)" ] \
  || pas_pret "dimotic-ha est arrêté — l'installation se terminera quand il tournera (il n'est jamais démarré par ce script)."
touch "$IA_CONF" "$IA_SECRETS"; chmod 600 "$IA_SECRETS"
MCP_TOKEN="$(yaml_val "$IA_SECRETS" mcpToken)"
MCP_PORT="$(yaml_val "$IA_CONF" mcpPort)"; MCP_PORT="${MCP_PORT:-$MCP_PORT_DEFAUT}"
change=0
if [ -z "$MCP_TOKEN" ]; then
  MCP_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cp -a "$IA_SECRETS" "$IA_SECRETS.avant-installer-ia-$(date +%Y%m%d%H%M%S)"
  yaml_poser "$IA_SECRETS" mcpToken "$MCP_TOKEN"; change=1; echo "Jeton MCP généré."
fi
if [ "$(yaml_val "$IA_CONF" mcpEnabled)" != true ] || [ "$(yaml_val "$IA_CONF" mcpHost)" != "$ADRESSE_MACHINE" ]; then
  cp -a "$IA_CONF" "$IA_CONF.avant-installer-ia-$(date +%Y%m%d%H%M%S)"
  yaml_poser "$IA_CONF" mcpEnabled true; yaml_poser "$IA_CONF" mcpHost "$ADRESSE_MACHINE"
  grep -qE '^mcpPort:' "$IA_CONF" || yaml_poser "$IA_CONF" mcpPort "$MCP_PORT"
  change=1; echo "MCP activé sur $ADRESSE_MACHINE:$MCP_PORT."
fi
MCP_URL="http://$ADRESSE_MACHINE:$MCP_PORT/mcp"
if [ "$change" = 1 ]; then
  echo "Redémarrage de dimotic-ha pour prendre en compte le MCP..."
  (cd "$DIMOTIC_DIR" && docker compose restart >/dev/null 2>&1) || echo "AVERTISSEMENT : redémarrage de dimotic-ha impossible — à faire à la main." >&2
fi
mcp_repond() {
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" -H "Authorization: Bearer $MCP_TOKEN" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"installer-ia","version":"1"}}}')" = 200 ]
}
MCP_OK=0
for _ in $(seq 1 24); do mcp_repond && { MCP_OK=1; break; }; sleep 5; done
if [ "$MCP_OK" = 1 ]; then echo "MCP : répond sur $MCP_URL."
else echo "AVERTISSEMENT : le MCP ne répond pas encore sur $MCP_URL (ia démarre après le référentiel de Home Assistant) — la session s'y branchera dès qu'il répondra." >&2; fi

# === 4. Dossier de travail ==============================================================================================
etape "4. Dossier de travail $AGENT_DIR"
mkdir -p "$AGENT_DIR/.claude"
rendre_claude_md
json_mcp() {
  python3 - "$MCP_URL" "$MCP_TOKEN" <<'PY'
import json, sys
url, jeton = sys.argv[1:3]
print(json.dumps({"mcpServers": {"dimotic": {"type": "http", "url": url, "headers": {"Authorization": "Bearer " + jeton}}}}, indent=2))
PY
}
json_reglages() {
  python3 - "$HA_CONFIG_DIR" <<'PY'
import json, os, sys
ha = sys.argv[1]
allow, deny = [], []
if os.path.isdir(ha):
    allow = ["Read(/%s/%s)" % (ha, f) for f in ("automations.yaml", "scripts.yaml", "scenes.yaml", "configuration.yaml")]
    deny = ["Read(/%s/secrets.yaml)" % ha, "Read(/%s/.storage/**)" % ha, "Edit(/%s/**)" % ha]
print(json.dumps({"enabledMcpjsonServers": ["dimotic"],
                  "permissions": {"allow": allow, "ask": ["mcp__dimotic__executer_action"], "deny": deny}}, indent=2, ensure_ascii=False))
PY
}
ecrire_si_change "$AGENT_DIR/.mcp.json" < <(json_mcp)
ecrire_si_change "$AGENT_DIR/.claude/settings.json" < <(json_reglages)
# Lanceur de la session (appelé par le service dans le screen) : env sans souris (terminal web), Remote Control nommé.
ecrire_si_change "$AGENT_DIR/lancer-claude.sh" <<EOF
#!/bin/bash
# Généré par installer-ia — lancé par $SERVICE dans le screen « $SCREEN_NAME ».
cd "$AGENT_DIR" || exit 1
export CLAUDE_CODE_DISABLE_MOUSE=1
exec "$CLAUDE_BIN" --remote-control "$NOM_SESSION" --permission-mode "$PERMISSION_MODE"
EOF
chmod 600 "$AGENT_DIR/.mcp.json" "$AGENT_DIR/.claude/settings.json"; chmod 750 "$AGENT_DIR/lancer-claude.sh"
chown -R "$CLAUDE_USER:$CLAUDE_USER" "$AGENT_DIR"; chmod 700 "$AGENT_DIR"
echo ".mcp.json (serveur « dimotic » pré-approuvé), .claude/settings.json, lancer-claude.sh : en place."

# === 5. Premières questions de Claude Code ==============================================================================
etape "5. Premières questions de Claude Code pré-répondues"
# reponses_claude <fichier> <dossier> [verifier] : avec « verifier », code 10 si quelque chose manque, sans rien écrire.
reponses_claude() {
  python3 - "$@" <<'PY'
import json, os, sys
f, d = sys.argv[1:3]
verifier = len(sys.argv) > 3
try:
    c = json.load(open(f))
except Exception:
    c = {}
avant = json.dumps(c, sort_keys=True)
c["hasCompletedOnboarding"] = True
c.setdefault("theme", "dark")
p = c.setdefault("projects", {}).setdefault(d, {})
p["hasTrustDialogAccepted"] = True
p["hasCompletedProjectOnboarding"] = True
p["enabledMcpjsonServers"] = sorted(set(p.get("enabledMcpjsonServers", [])) | {"dimotic"})
p["disabledMcpjsonServers"] = [s for s in p.get("disabledMcpjsonServers", []) if s != "dimotic"]
p.setdefault("allowedTools", [])
if verifier:
    sys.exit(0 if json.dumps(c, sort_keys=True) == avant else 10)
json.dump(c, open(f, "w"), indent=2)
os.chmod(f, 0o600)
PY
}
if reponses_claude "$CLAUDE_HOME/.claude.json" "$AGENT_DIR" verifier; then
  echo "Déjà en place (accueil, thème, confiance de $AGENT_DIR, serveur « dimotic »)."
else
  systemctl stop "$SERVICE" 2>/dev/null   # Claude Code réécrit ~/.claude.json en sortant : arrêté avant d'y toucher
  [ -f "$CLAUDE_HOME/.claude.json" ] && cp -a "$CLAUDE_HOME/.claude.json" "$CLAUDE_HOME/.claude.json.avant-installer-ia-$(date +%Y%m%d%H%M%S)"
  reponses_claude "$CLAUDE_HOME/.claude.json" "$AGENT_DIR"
  chown "$CLAUDE_USER:$CLAUDE_USER" "$CLAUDE_HOME/.claude.json"
  SESSION_A_RELANCER=1
  echo "Accueil, thème, confiance de $AGENT_DIR et serveur « dimotic » : acceptés d'avance."
fi

# === 6. Service de la session ===========================================================================================
etape "6. Service $SERVICE"
[ -f "/etc/systemd/system/$SERVICE" ] && ! grep -q 'installer-ia' "/etc/systemd/system/$SERVICE" \
  && cp -a "/etc/systemd/system/$SERVICE" "/etc/systemd/system/$SERVICE.avant-installer-ia-$(date +%Y%m%d%H%M%S)"
ecrire_si_change "/etc/systemd/system/$SERVICE" <<EOF
# Généré par installer-ia (application Outils) — session Claude Code de la maison : screen « $SCREEN_NAME »
# (panneau « IA » de Home Assistant) et Remote Control « $NOM_SESSION ». Relancée après /exit comme après un arrêt.
[Unit]
Description=Claude Code ($NOM_SESSION) dans screen
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$CLAUDE_USER
WorkingDirectory=$AGENT_DIR
ExecStart=/usr/bin/screen -DmS $SCREEN_NAME $AGENT_DIR/lancer-claude.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl is-active -q "$SERVICE" || SESSION_A_RELANCER=1
if [ "$SESSION_A_RELANCER" = 1 ]; then
  systemctl daemon-reload && systemctl enable "$SERVICE" >/dev/null 2>&1 && systemctl restart "$SERVICE"
  echo "Session (re)lancée : sa configuration a changé."
  sleep 3
else
  echo "Rien de changé : session laissée telle quelle."
fi
if as_claude screen -ls 2>/dev/null | grep -qE "\.$SCREEN_NAME[[:space:]]"; then echo "Session « $SCREEN_NAME » : démarrée."
else erreur "la session screen « $SCREEN_NAME » n'a pas démarré (journalctl -u $SERVICE)."; fi

# === 7. Panneau « IA » (intégration screen_console) =====================================================================
etape "7. Panneau « IA » de Home Assistant (screen_console)"
PANNEAU_OK=0
if [ ! -d "$HA_CONFIG_DIR/custom_components/screen_console" ]; then
  echo "Intégration screen_console absente de $HA_CONFIG_DIR/custom_components — panneau non installé (Remote Control seul)."
  PANNEAU_OK=1   # rien à attendre
else
  # Clé : créée ici, à l'endroit où l'intégration la lit (ensure_key la réutilise si elle existe).
  CLE="$HA_CONFIG_DIR/.storage/screen_console_ed25519"
  if [ ! -f "$CLE" ]; then
    mkdir -p "$HA_CONFIG_DIR/.storage"
    ssh-keygen -q -t ed25519 -N '' -C ha-screen-console -f "$CLE" && rm -f "$CLE.pub" && chmod 600 "$CLE"
    echo "Clé de la console créée ($CLE)."
  fi
  PUB="$(ssh-keygen -y -f "$CLE" | awk '{print $1" "$2}') ha-screen-console"
  # Script de contrôle (copie de host/screen-console-gate du dépôt dimotic-ha-screen-console) : list / attach seulement.
  GATE="$CLAUDE_HOME/bin/screen-console-gate"
  mkdir -p "$CLAUDE_HOME/bin"
  cat > "$GATE" <<'EOF'
#!/bin/bash
# Script de contrôle SSH de l'intégration « Screen Console » (dépôt zdid/dimotic-ha-screen-console), posé par installer-ia.
# La clé de l'intégration ne peut faire QUE : list (sessions screen) et attach <nom>.
cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  list) screen -ls; exit 0 ;;
  attach\ *)
    name="${cmd#attach }"
    if [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then exec screen -x "$name"; fi ;;
esac
echo "screen-console-gate : demande refusée" >&2
exit 1
EOF
  chmod 755 "$GATE"; chown -R "$CLAUDE_USER:$CLAUDE_USER" "$CLAUDE_HOME/bin"
  AK="$CLAUDE_HOME/.ssh/authorized_keys"
  mkdir -p "$CLAUDE_HOME/.ssh"; touch "$AK"
  LIGNE="from=\"127.0.0.1,::1\",command=\"$GATE\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding $PUB"
  if ! grep -qxF "$LIGNE" "$AK"; then
    cp -a "$AK" "$AK.avant-installer-ia-$(date +%Y%m%d%H%M%S)"
    grep -v 'ha-screen-console$' "$AK" > "$AK.new" || true
    echo "$LIGNE" >> "$AK.new"; mv "$AK.new" "$AK"
    echo "Clé de la console autorisée pour « $CLAUDE_USER » (list/attach seulement, depuis la machine elle-même)."
  fi
  chown -R "$CLAUDE_USER:$CLAUDE_USER" "$CLAUDE_HOME/.ssh"; chmod 700 "$CLAUDE_HOME/.ssh"; chmod 600 "$AK"
  # Entrée de l'intégration créée par l'API de HA (jeton de dimotic-ha), si elle n'existe pas encore.
  if [ -z "$HA_HOST" ] || [ -z "$HA_TOKEN" ]; then
    echo "AVERTISSEMENT : adresse ou jeton de Home Assistant absents de dimotic-ha — ajoutez « Screen Console » à la main (Paramètres > Appareils et services)." >&2
  else
    python3 - "http://$HA_HOST:$HA_PORT" "$HA_TOKEN" "$CLAUDE_USER" <<'PY'
import json, sys, urllib.request
base, jeton, compte = sys.argv[1:4]
def api(methode, chemin, corps=None):
    req = urllib.request.Request(base + chemin, method=methode, data=None if corps is None else json.dumps(corps).encode(),
                                 headers={"Authorization": "Bearer " + jeton, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)
try:
    entrees = api("GET", "/api/config/config_entries/entry?domain=screen_console")
except Exception as e:
    print("PAS_PRET Home Assistant injoignable (%s)" % e); sys.exit(3)
if entrees:
    print("Entrée « Screen Console » déjà présente dans Home Assistant."); sys.exit(0)
try:
    flux = api("POST", "/api/config/config_entries/flow", {"handler": "screen_console", "show_advanced_options": False})
    if flux.get("step_id") == "user":
        flux = api("POST", "/api/config/config_entries/flow/" + flux["flow_id"], {"host": "127.0.0.1", "port": 22, "username": compte})
    if flux.get("step_id") == "key":
        flux = api("POST", "/api/config/config_entries/flow/" + flux["flow_id"], {})
    if flux.get("type") == "create_entry":
        print("Entrée « Screen Console » créée dans Home Assistant (panneau dans le menu de gauche)."); sys.exit(0)
    print("AVERTISSEMENT réponse inattendue de Home Assistant : %s" % json.dumps(flux)[:300]); sys.exit(2)
except Exception as e:
    print("PAS_PRET intégration screen_console pas encore chargée par Home Assistant (%s) — redémarrez HA puis relancez." % e); sys.exit(3)
PY
    rc=$?
    [ "$rc" = 0 ] && PANNEAU_OK=1
  fi
fi

# === Bilan ==============================================================================================================
etape "Bilan"
echo "Session : screen « $SCREEN_NAME » du compte $CLAUDE_USER, Remote Control « $NOM_SESSION », dossier $AGENT_DIR"
echo "MCP : $MCP_URL ($([ "$MCP_OK" = 1 ] && echo répond || echo 'ne répond pas encore'))"
if [ "$AUTO" = 1 ]; then
  # Le minuteur reste en place : il suit un changement d'adresse ou de configuration sans relancer une session inchangée.
  [ "$MCP_OK" = 1 ] && [ "$PANNEAU_OK" = 1 ] && exit 0
  exit "$PAS_PRET"
fi
cat <<EOF

Seule étape manuelle : la connexion au compte Claude.
  Home Assistant > panneau « IA » > session « $SCREEN_NAME » : suivre le lien affiché par Claude Code (/login si rien ne s'affiche).
  Ensuite la même session est dans claude.ai/code ou l'application Claude (onglet « Code ») sous le nom « $NOM_SESSION ».
EOF
