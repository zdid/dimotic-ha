#!/bin/bash
# Généré par l'application Outils — SE DÉPOSE LUI-MÊME (scp) sur la machine visée puis S'Y EXÉCUTE
# (ssh) pour lancer Claude Code ("claude remote-control") dans un screen détaché sur CETTE machine,
# sous un compte Linux DÉDIÉ sans sudo (par défaut « claude »), briefé (CLAUDE.md généré), relié au
# serveur MCP de dimotic-ha de cette machine (mêmes outils que l'assistant Mistral + lecture du
# planificateur) et, au choix, à l'API Home Assistant pour contrôler des résultats. Joignable ensuite
# depuis un téléphone/autre poste via le Remote Control de Claude Code (claude.ai/code ou l'app mobile,
# onglet "Code") — pas de code/QR à transmettre, la découverte est automatique et liée au compte
# Claude.ai connecté.
#
# La MACHINE VISÉE est normalement celle d'où ce script a été téléchargé (voir TARGET_HOST
# ci-dessous) — pas de détection automatique, à saisir dans le formulaire comme les autres champs.
#
# Conception : specs conception-claude-code-automatisations (échelle d'autorisations, §5-§6) —
# niveau 0 : Claude Code LIT (Home Assistant, dimotic-ha) et PROPOSE ; il n'écrit pas dans la
# configuration de Home Assistant (règles de refus posées dans .claude/settings.json), et les outils
# qui agissent sur la maison (executer_action) demandent une confirmation à chaque appel.
#
# Le jeton Home Assistant reste FACULTATIF : il sert aux phases de mise au point, pour contrôler un
# résultat directement dans Home Assistant (états, historique, journal). Vide = pas d'accès direct.
#
# @outils:bundle applications/ia/agent/claude-md => claude-md
# @outils:select MODE = installer, mettre_a_jour_claude_md
# @outils:default MODE = installer
# @outils:hint MODE = installer : tout (compte, liaison MCP, permissions, CLAUDE.md, session). mettre_a_jour_claude_md : réécrit SEULEMENT le CLAUDE.md d'une installation existante (version du dépôt) — ne touche ni au compte, ni aux jetons, ni à la session ; prise en compte au prochain démarrage de la session Claude Code.
# @outils:hint TARGET_HOST = Adresse de la machine visée — normalement celle que vous utilisez pour accéder à cette page (voir la barre d'adresse de votre navigateur).
# @outils:default TARGET_USER = root
# @outils:hint CLAUDE_USER = Compte Linux dédié qui exécutera Claude Code (créé s'il n'existe pas, sans sudo). Vide = exécuter sous le compte de connexion (déconseillé).
# @outils:default CLAUDE_USER = claude
# @outils:hint MCP_TOKEN = Jeton du serveur MCP de dimotic-ha de CETTE machine (Paramètres Techniques > IA > Accès Claude Code). Vide = pas de liaison avec dimotic-ha.
# @outils:hint MCP_URL = Adresse du serveur MCP de dimotic-ha, vue depuis la machine visée (127.0.0.1 si Claude Code et dimotic-ha sont sur la même machine).
# @outils:default MCP_URL = http://127.0.0.1:8765/mcp
# @outils:hint HA_URL = Facultatif — adresse de l'instance Home Assistant pour contrôler des résultats directement (ex: http://192.168.1.19:8123). Vide = pas d'accès direct.
# @outils:hint HA_TOKEN = Facultatif — jeton HA (Profil -> Sécurité -> Jetons d'accès de longue durée). ATTENTION : accès COMPLET au compte qui l'a créé, sans expiration — compte HA dédié non-administrateur recommandé. Vide = pas d'accès direct.
# @outils:hint HA_CONFIG_DIR = Facultatif — dossier de configuration de Home Assistant sur la machine visée (ex: /docker/homeassistant/config). Renseigné : lecture autorisée de automations.yaml, scripts.yaml, scenes.yaml, configuration.yaml ; secrets.yaml et .storage interdits ; aucune écriture.
# @outils:default SESSION_NAME = agent-ha
# @outils:select PERMISSION_MODE = manual, acceptEdits
# @outils:default PERMISSION_MODE = manual

set -euo pipefail

MODE="__MODE__"
TARGET_HOST="__TARGET_HOST__"
TARGET_USER="__TARGET_USER__"
CLAUDE_USER="__CLAUDE_USER__"
MCP_TOKEN="__MCP_TOKEN__"
MCP_URL="__MCP_URL__"
HA_URL="__HA_URL__"
HA_TOKEN="__HA_TOKEN__"
HA_CONFIG_DIR="__HA_CONFIG_DIR__"
SESSION_NAME="__SESSION_NAME__"
PERMISSION_MODE="__PERMISSION_MODE__"

# Même convention que duckdns-caddy.sh (ADDON_DIR) : fichiers propres à cet add-on regroupés à part.
REMOTE_DIR="/dimotic-ha-addons/agent-ha"

# Échappe une valeur pour l'insérer dans une chaîne JSON entre guillemets.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Éléments d'un tableau JSON, un par ligne : json_list "a" "b" -> \n      "a",\n      "b"
json_list() {
  local out="" item
  for item in "$@"; do out+="${out:+,}"$'\n'"      \"$(json_escape "$item")\""; done
  printf '%s' "$out"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Modèle du CLAUDE.md (source unique : applications/ia/agent/claude-md/, voir son LISEZ-MOI.md) ----------
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

render_section() {
  sed -e "s|{{TARGET_HOST}}|$(sed_escape "$TARGET_HOST")|g" \
      -e "s|{{HA_URL}}|$(sed_escape "$HA_URL")|g" \
      -e "s|{{HA_CONFIG_DIR}}|$(sed_escape "$HA_CONFIG_DIR")|g" \
      -e "s|{{HA_TOKEN_FILE}}|$(sed_escape "$HA_TOKEN_FILE_SHOWN")|g" "$1"
}

# Écrit le CLAUDE.md sur la sortie standard. Variables attendues : TPL_DIR, HAS_MCP, HAS_HA_TOKEN,
# HA_CONFIG_DIR, HA_URL, TARGET_HOST.
render_claude_md() {
  # Jeton HA : ./ha_token (installé par ce script) ; sinon ~/.ha_token si c'est celui qui est déjà en place sur la machine.
  HA_TOKEN_FILE_SHOWN="./ha_token"
  local uhome; uhome="$(getent passwd "${CLAUDE_USER:-}" 2>/dev/null | cut -d: -f6)"
  if [ ! -f "$REMOTE_DIR/ha_token" ] && [ -n "$uhome" ] && [ -f "$uhome/.ha_token" ]; then HA_TOKEN_FILE_SHOWN="~/.ha_token"; fi
  printf '<!-- agent-claude-md v%s — généré le %s par agent-ha-deploy -->\n\n' \
    "$(tr -d '[:space:]' < "$TPL_DIR/VERSION")" "$(date +%Y-%m-%d)"
  render_section "$TPL_DIR/00-role.md"; echo
  if [ "$HAS_MCP" = 1 ]; then render_section "$TPL_DIR/10-dimotic-mcp.md"; echo; fi
  if [ -n "$HA_CONFIG_DIR" ]; then render_section "$TPL_DIR/20-ha-config.md"; echo; fi
  if [ "$HAS_HA_TOKEN" = 1 ]; then render_section "$TPL_DIR/30-ha-direct.md"; echo; fi
  render_section "$TPL_DIR/90-securite.md"
  # Section « Site » (connaissances propres à la machine) : site.md à côté du CLAUDE.md, jamais écrasé par le modèle.
  if [ -s "$REMOTE_DIR/site.md" ]; then echo; cat "$REMOTE_DIR/site.md"; fi
}

if [ "${1:-}" = "--remote-exec" ]; then
  # =====================================================================================
  # Exécuté SUR LA MACHINE CIBLE (relancé par le bloc local ci-dessous, via ssh)
  # =====================================================================================
  TPL_DIR="$SCRIPT_DIR/claude-md"

  if [ "$MODE" = "mettre_a_jour_claude_md" ]; then
    # Réécrit SEULEMENT le CLAUDE.md d'une installation existante, avec les choix mémorisés à
    # l'installation (agent.conf — aucun secret). Ne touche ni au compte, ni aux jetons, ni au screen.
    if [ ! -f "$REMOTE_DIR/agent.conf" ]; then
      echo "ERREUR : aucune installation trouvée ($REMOTE_DIR/agent.conf absent) — lancez d'abord le mode « installer »." >&2
      exit 1
    fi
    # shellcheck disable=SC1091
    . "$REMOTE_DIR/agent.conf"
    OLD_VERSION="$(sed -n 's/.*agent-claude-md v\([0-9][0-9.]*\).*/\1/p' "$REMOTE_DIR/CLAUDE.md" 2>/dev/null | head -1)"
    render_claude_md > "$REMOTE_DIR/CLAUDE.md.new"
    mv "$REMOTE_DIR/CLAUDE.md.new" "$REMOTE_DIR/CLAUDE.md"
    if [ -n "$CLAUDE_USER" ]; then chown "$CLAUDE_USER":"$CLAUDE_USER" "$REMOTE_DIR/CLAUDE.md"; fi
    NEW_VERSION="$(tr -d '[:space:]' < "$TPL_DIR/VERSION")"
    echo "CLAUDE.md mis à jour : v${OLD_VERSION:-inconnue} -> v${NEW_VERSION}  ($REMOTE_DIR/CLAUDE.md)"
    echo "Pris en compte au prochain démarrage de la session Claude Code (la session en cours garde l'ancien texte)."
    exit 0
  fi

  if ! command -v screen >/dev/null 2>&1; then
    echo "ERREUR : 'screen' introuvable sur cette machine. Installez-le : apt install screen" >&2
    exit 1
  fi

  # --- Compte d'exécution : dédié, sans sudo --------------------------------------------
  RUN_AS=""
  if [ -n "$CLAUDE_USER" ]; then
    if ! id -u "$CLAUDE_USER" >/dev/null 2>&1; then
      echo "Création du compte dédié '$CLAUDE_USER' (sans sudo)..."
      useradd -m -s /bin/bash "$CLAUDE_USER"
    fi
    if id -nG "$CLAUDE_USER" | tr ' ' '\n' | grep -qxE 'sudo|wheel|root'; then
      echo "ERREUR : le compte '$CLAUDE_USER' a des droits d'administration (sudo/wheel/root) — refusé." >&2
      echo "Retirez-le de ce groupe ou choisissez un autre compte." >&2
      exit 1
    fi
    RUN_AS="$CLAUDE_USER"
  fi

  as_claude() {
    if [ -n "$RUN_AS" ]; then
      if command -v runuser >/dev/null 2>&1; then runuser -u "$RUN_AS" -- "$@"; else su -s /bin/bash "$RUN_AS" -c "$(printf '%q ' "$@")"; fi
    else
      "$@"
    fi
  }

  # Claude Code est normalement installé DANS le compte dédié (installeur natif : ~/.local/bin, ou npm
  # utilisateur) — pas dans le PATH de root. On le cherche donc d'abord là (PATH de connexion du
  # compte, puis emplacements usuels), ensuite dans le PATH global ; installation en dernier recours.
  find_claude() {
    local p="" home="" c
    p="$(as_claude bash -lc 'command -v claude' 2>/dev/null || true)"
    if [ -z "$p" ] && [ -n "$RUN_AS" ]; then
      home="$(getent passwd "$RUN_AS" | cut -d: -f6)"
      for c in "$home/.local/bin/claude" "$home/.claude/local/claude" "$home/.npm-global/bin/claude" "$home/node_modules/.bin/claude"; do
        if [ -x "$c" ]; then p="$c"; break; fi
      done
    fi
    if [ -z "$p" ]; then p="$(command -v claude 2>/dev/null || true)"; fi
    printf '%s' "$p"
  }
  CLAUDE_BIN="$(find_claude)"
  if [ -z "$CLAUDE_BIN" ]; then
    if command -v npm >/dev/null 2>&1; then
      echo "'claude' introuvable — installation globale (npm install -g @anthropic-ai/claude-code)..."
      npm install -g @anthropic-ai/claude-code
      CLAUDE_BIN="$(find_claude)"
    fi
  fi
  if [ -z "$CLAUDE_BIN" ]; then
    echo "ERREUR : 'claude' introuvable (ni pour le compte '${RUN_AS:-$TARGET_USER}', ni globalement) et npm absent." >&2
    echo "Installez Claude Code sous ce compte (voir https://code.claude.com/docs), puis relancez ce script." >&2
    exit 1
  fi
  echo "Claude Code : $CLAUDE_BIN"

  if as_claude screen -ls 2>/dev/null | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
    echo "ERREUR : une session screen nommée '$SESSION_NAME' existe déjà pour ce compte." >&2
    echo "Choisissez un autre nom, ou 'screen -r $SESSION_NAME' pour vous y attacher." >&2
    exit 1
  fi

  mkdir -p "$REMOTE_DIR/.claude"
  chmod 700 "$REMOTE_DIR"

  # --- Liaison avec dimotic-ha (serveur MCP) --------------------------------------------
  if [ -n "$MCP_TOKEN" ]; then
    printf '{\n  "mcpServers": {\n    "dimotic": {\n      "type": "http",\n      "url": "%s",\n      "headers": { "Authorization": "Bearer %s" }\n    }\n  }\n}\n' \
      "$(json_escape "$MCP_URL")" "$(json_escape "$MCP_TOKEN")" > "$REMOTE_DIR/.mcp.json"
    chmod 600 "$REMOTE_DIR/.mcp.json"
  else
    rm -f "$REMOTE_DIR/.mcp.json"
  fi

  # --- Accès direct Home Assistant (facultatif) -----------------------------------------
  if [ -n "$HA_TOKEN" ]; then
    printf '%s' "$HA_TOKEN" > "$REMOTE_DIR/ha_token"
    chmod 600 "$REMOTE_DIR/ha_token"
  else
    rm -f "$REMOTE_DIR/ha_token"
  fi

  # --- Permissions (.claude/settings.json) ----------------------------------------------
  # deny : prioritaire sur tout ; ask : confirmation à chaque appel ; allow : lecture ciblée.
  # NB : les règles de refus sont une barrière « au mieux » (outils intégrés et commandes de lecture
  # reconnues) — la barrière réelle est le compte Linux dédié et les droits de fichiers.
  ALLOW_ITEMS=(); DENY_ITEMS=(); ASK_ITEMS=()
  if [ -n "$MCP_TOKEN" ]; then
    ASK_ITEMS+=("mcp__dimotic__executer_action")
  fi
  if [ -n "$HA_CONFIG_DIR" ]; then
    HA_CONFIG_DIR="${HA_CONFIG_DIR%/}"
    # Chemin absolu = deux barres obliques en tête dans une règle (« / » + « /docker/... »).
    for f in automations.yaml scripts.yaml scenes.yaml configuration.yaml; do
      ALLOW_ITEMS+=("Read(/${HA_CONFIG_DIR}/$f)")
    done
    DENY_ITEMS+=("Read(/${HA_CONFIG_DIR}/secrets.yaml)" "Read(/${HA_CONFIG_DIR}/.storage/**)" "Edit(/${HA_CONFIG_DIR}/**)")
  fi
  printf '{\n  "permissions": {\n    "allow": [%s\n    ],\n    "ask": [%s\n    ],\n    "deny": [%s\n    ]\n  }\n}\n' \
    "$(json_list ${ALLOW_ITEMS[@]+"${ALLOW_ITEMS[@]}"})" \
    "$(json_list ${ASK_ITEMS[@]+"${ASK_ITEMS[@]}"})" \
    "$(json_list ${DENY_ITEMS[@]+"${DENY_ITEMS[@]}"})" > "$REMOTE_DIR/.claude/settings.json"
  chmod 600 "$REMOTE_DIR/.claude/settings.json"

  # --- CLAUDE.md ------------------------------------------------------------------------
  # Chargé automatiquement comme instructions projet à l'ouverture d'une session dans ce répertoire.
  # Rendu à partir du modèle versionné du dépôt (claude-md/, déposé à côté de ce script).
  HAS_MCP=0; if [ -n "$MCP_TOKEN" ]; then HAS_MCP=1; fi
  HAS_HA_TOKEN=0; if [ -n "$HA_TOKEN" ]; then HAS_HA_TOKEN=1; fi
  render_claude_md > "$REMOTE_DIR/CLAUDE.md"

  # Choix de l'installation (aucun secret) — relus par le mode « mettre_a_jour_claude_md ».
  {
    printf 'TARGET_HOST=%q\nCLAUDE_USER=%q\nHA_URL=%q\nHA_CONFIG_DIR=%q\nHAS_MCP=%q\nHAS_HA_TOKEN=%q\n' \
      "$TARGET_HOST" "$CLAUDE_USER" "$HA_URL" "$HA_CONFIG_DIR" "$HAS_MCP" "$HAS_HA_TOKEN"
  } > "$REMOTE_DIR/agent.conf"
  chmod 600 "$REMOTE_DIR/agent.conf"

  if [ -n "$RUN_AS" ]; then
    chown -R "$RUN_AS":"$RUN_AS" "$REMOTE_DIR"
  fi

  as_claude bash -lc "cd '$REMOTE_DIR' && screen -dmS '$SESSION_NAME' '$CLAUDE_BIN' remote-control --permission-mode '$PERMISSION_MODE' --name '$SESSION_NAME'"

  sleep 1
  if ! as_claude screen -ls 2>/dev/null | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
    echo "ERREUR : la session screen '$SESSION_NAME' ne semble pas avoir démarré." >&2
    exit 1
  fi

  if [ -n "$RUN_AS" ]; then
    ATTACH="su - ${RUN_AS} -c 'screen -r ${SESSION_NAME}'"
  else
    ATTACH="screen -r ${SESSION_NAME}"
  fi

  cat <<EOF

Session créée : $SESSION_NAME (répertoire: $REMOTE_DIR, compte: ${RUN_AS:-$TARGET_USER})

=== Première mise en œuvre (une seule fois) ===
1. Depuis VOTRE machine, connectez-vous en SSH à celle-ci puis attachez-vous au screen :
     ssh ${TARGET_USER}@${TARGET_HOST}
     ${ATTACH}
2. Des validations interactives apparaîtront successivement — répondez-y :
     a. Connexion Claude.ai (si jamais fait pour ce compte) : suivre le lien affiché par
        /login et se connecter avec le compte Claude.ai (Pro/Max/Team/Enterprise requis, une
        clé API seule ne suffit pas pour le Remote Control).
     b. Confiance du répertoire de travail : "Do you trust the files in this folder?" -> oui.
     c. Serveur MCP « dimotic » du projet (.mcp.json) : demande d'approbation -> approuver.
     d. Activation du Remote Control : "Enable Remote Control? (y/n)" -> y.
3. Une fois validées, détachez-vous SANS tuer la session : Ctrl-A puis D.
   (la session continue de tourner en arrière-plan sur cette machine)

=== Accès depuis votre téléphone (à chaque fois, après la première mise en œuvre) ===
1. Ouvrir claude.ai/code dans un navigateur, OU l'app mobile Claude Code -> onglet "Code".
2. Se connecter avec le MÊME compte Claude.ai que celui utilisé à l'étape 2a ci-dessus.
3. Dans la liste des sessions, chercher "$SESSION_NAME" (icône ordinateur + point vert = en ligne).
4. Taper dessus pour s'y connecter et discuter avec cette instance.

Rappel : la session s'arrête si la machine redémarre — relancer ce script. Pour revenir dessus
depuis cette machine plus tard : ${ATTACH} (Ctrl-A D pour redétacher).
EOF
  exit 0
fi

# =====================================================================================
# Exécuté EN LOCAL, juste après le téléchargement (poste de l'utilisateur)
# =====================================================================================
if [ -z "$TARGET_HOST" ]; then
  echo "ERREUR : TARGET_HOST est vide — renseignez-le dans le formulaire Outils." >&2
  exit 1
fi
# Modèle du CLAUDE.md : à côté du script (archive Outils) ou, lancé depuis le dépôt, dans applications/ia/agent.
TPL_SRC=""
for c in "$SCRIPT_DIR/claude-md" "$SCRIPT_DIR/../../../ia/agent/claude-md"; do
  if [ -f "$c/VERSION" ]; then TPL_SRC="$c"; break; fi
done
if [ -z "$TPL_SRC" ]; then
  echo "ERREUR : modèle du CLAUDE.md introuvable (claude-md/) — régénérez le script depuis l'application Outils." >&2
  exit 1
fi
if [ "$MODE" != "installer" ] && [ "$MODE" != "mettre_a_jour_claude_md" ]; then
  echo "ERREUR : MODE inconnu « $MODE » (installer ou mettre_a_jour_claude_md)." >&2
  exit 1
fi

if [ "$MODE" = "installer" ] && [ -z "$MCP_TOKEN" ] && [ -z "$HA_TOKEN" ]; then
  echo "ERREUR : ni MCP_TOKEN ni HA_TOKEN — Claude Code n'aurait accès à rien. Renseignez au moins l'un des deux." >&2
  exit 1
fi
if [ "$MODE" = "installer" ] && [ -n "$HA_TOKEN" ] && [ -z "$HA_URL" ]; then
  echo "ERREUR : HA_TOKEN renseigné mais HA_URL vide — renseignez l'adresse de Home Assistant." >&2
  exit 1
fi
if [ -n "$HA_CONFIG_DIR" ] && [ "${HA_CONFIG_DIR#/}" = "$HA_CONFIG_DIR" ]; then
  echo "ERREUR : HA_CONFIG_DIR doit être un chemin absolu (commençant par /)." >&2
  exit 1
fi
if [ -n "$MCP_TOKEN" ] && [ -z "$MCP_URL" ]; then
  echo "ERREUR : MCP_TOKEN renseigné mais MCP_URL vide." >&2
  exit 1
fi

echo "Dépôt sur ${TARGET_USER}@${TARGET_HOST}..."
ssh "${TARGET_USER}@${TARGET_HOST}" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'"
scp -q "$0" "${TARGET_USER}@${TARGET_HOST}:${REMOTE_DIR}/agent-ha-deploy.sh"
# Modèle du CLAUDE.md (aucun secret) : remplacé à chaque fois, et conservé sur la machine.
ssh "${TARGET_USER}@${TARGET_HOST}" "rm -rf '${REMOTE_DIR}/claude-md'"
scp -q -r "$TPL_SRC" "${TARGET_USER}@${TARGET_HOST}:${REMOTE_DIR}/claude-md"
# La copie déposée contient les jetons saisis : supprimée dès la fin, succès ou échec.
ssh "${TARGET_USER}@${TARGET_HOST}" \
  "chmod 600 '${REMOTE_DIR}/agent-ha-deploy.sh'; bash '${REMOTE_DIR}/agent-ha-deploy.sh' --remote-exec; rc=\$?; rm -f '${REMOTE_DIR}/agent-ha-deploy.sh'; exit \$rc"
