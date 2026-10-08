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

if [ "${1:-}" = "--remote-exec" ]; then
  # =====================================================================================
  # Exécuté SUR LA MACHINE CIBLE (relancé par le bloc local ci-dessous, via ssh)
  # =====================================================================================
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
  {
    cat <<EOF
# Rôle et règles de cet agent

Tu es l'agent Claude Code de cette maison (machine : ${TARGET_HOST}). Niveau d'autorisation actuel :
**niveau 0 — tu LIS et tu PROPOSES.** Tu n'écris jamais dans la configuration de Home Assistant et tu ne
déploies rien toi-même : pour une automatisation, tu rédiges le YAML, tu le soumets, l'utilisateur
l'applique. Toute action qui agit sur la maison (lumières, volets, chauffage, serrures…) se confirme
avec l'utilisateur avant d'être exécutée.

EOF
    if [ -n "$MCP_TOKEN" ]; then
      cat <<EOF
## dimotic-ha (serveur MCP « dimotic »)

Tu disposes des mêmes outils que l'assistant vocal Mistral, plus des outils de lecture :
- \`lister_entites\`, \`obtenir_etat\`, \`obtenir_details\` — entités, état, attributs réels, classement ;
- \`diagnostiquer_resolution\` — pourquoi un quoi/lieux ne ressort pas ;
- \`tester_phrase\` — simule une phrase SANS rien exécuter ;
- \`lire_planificateur\` — planifications, macros, actions reçues, commandes réellement envoyées à HA ;
- \`executer_action\` — AGIT RÉELLEMENT sur la maison (confirmation demandée à chaque appel).

Le vocabulaire (quoi/lieux, valeurs absolues, un lieu précis et sa pièce en UN seul élément) et le
catalogue de cette maison te sont transmis à la connexion ; règles complètes : ressource
\`dimotic://regles\`. Le catalogue est propre à CETTE maison : n'y suppose pas les entités d'un autre site.

EOF
    fi
    if [ -n "$HA_CONFIG_DIR" ]; then
      cat <<EOF
## Configuration de Home Assistant (lecture seule)

Dossier : \`${HA_CONFIG_DIR}\` — tu peux lire \`automations.yaml\`, \`scripts.yaml\`, \`scenes.yaml\`,
\`configuration.yaml\` pour connaître l'existant et éviter les doublons. \`secrets.yaml\` et \`.storage\`
sont interdits ; tu n'écris rien dans ce dossier.

EOF
    fi
    if [ -n "$HA_TOKEN" ]; then
      cat <<EOF
## Accès direct à Home Assistant — pour CONTRÔLER des résultats

- URL : ${HA_URL}
- Jeton (Long-Lived Access Token) : fichier \`./ha_token\` à côté de ce CLAUDE.md — ne l'affiche jamais
  en clair, ne le commite jamais, ne le partage jamais avec un service tiers.
- Usage prévu : **lecture** pour vérifier ce qu'on vient de mettre au point (états, historique, journal).
- Tout appel qui modifie quelque chose (services, configuration, automatisations) se confirme avec
  l'utilisateur AVANT, comme pour executer_action.

\`\`\`bash
# États / un état
curl -s -H "Authorization: Bearer \$(cat ha_token)" "${HA_URL}/api/states"
curl -s -H "Authorization: Bearer \$(cat ha_token)" "${HA_URL}/api/states/light.salon"
# Historique d'une entité depuis une date
curl -s -H "Authorization: Bearer \$(cat ha_token)" "${HA_URL}/api/history/period/2026-10-08T00:00:00?filter_entity_id=light.salon"
# Journal
curl -s -H "Authorization: Bearer \$(cat ha_token)" "${HA_URL}/api/logbook"
\`\`\`

EOF
    fi
    cat <<EOF
## Sécurité

- Ne colle jamais un jeton (dimotic, Home Assistant) dans une réponse, un commit ou un service tiers.
- Un jeton Home Assistant donne un accès COMPLET au compte qui l'a créé, sans expiration.
- Toute action à impact réel ou difficile à annuler : confirme d'abord.
EOF
  } > "$REMOTE_DIR/CLAUDE.md"

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
if [ -z "$MCP_TOKEN" ] && [ -z "$HA_TOKEN" ]; then
  echo "ERREUR : ni MCP_TOKEN ni HA_TOKEN — Claude Code n'aurait accès à rien. Renseignez au moins l'un des deux." >&2
  exit 1
fi
if [ -n "$HA_TOKEN" ] && [ -z "$HA_URL" ]; then
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
# La copie déposée contient les jetons saisis : supprimée dès la fin, succès ou échec.
ssh "${TARGET_USER}@${TARGET_HOST}" \
  "chmod 600 '${REMOTE_DIR}/agent-ha-deploy.sh'; bash '${REMOTE_DIR}/agent-ha-deploy.sh' --remote-exec; rc=\$?; rm -f '${REMOTE_DIR}/agent-ha-deploy.sh'; exit \$rc"
