#!/bin/bash
# Généré par l'application Outils — SE DÉPOSE LUI-MÊME (scp) sur la machine visée puis S'Y EXÉCUTE
# (ssh) pour lancer Claude Code ("claude remote-control") dans un screen détaché sur CETTE machine,
# briefé (CLAUDE.md généré) sur une instance Home Assistant donnée, joignable ensuite depuis un
# téléphone/autre poste via le Remote Control de Claude Code (claude.ai/code ou l'app mobile,
# onglet "Code") — pas de code/QR à transmettre, la découverte est automatique et liée au compte
# Claude.ai connecté.
#
# La MACHINE VISÉE est normalement celle d'où ce script a été téléchargé (voir TARGET_HOST
# ci-dessous) — pas de détection automatique, à saisir dans le formulaire comme les autres champs.
#
# Rupture volontaire avec la philosophie du dépôt dimotic-ha (fonctionnelles-ia_specs §6/§7) : là-bas
# aucun LLM ne reçoit d'accès HA brut, seul Mistral reçoit un jeu d'outils fixe et générique. Ici,
# Claude Code reçoit un accès complet, direct, via un canal séparé pour un usage ops/dev explicite.
#
# @outils:hint TARGET_HOST = Adresse de la machine visée — normalement celle que vous utilisez pour accéder à cette page (voir la barre d'adresse de votre navigateur).
# @outils:default TARGET_USER = root
# @outils:hint HA_URL = Adresse complète de l'instance Home Assistant sur la machine visée (ex: http://192.168.1.19:8123).
# @outils:hint HA_TOKEN = Jeton HA (Profil -> Sécurité -> Jetons d'accès de longue durée -> Créer un jeton). ATTENTION : accès COMPLET au compte qui l'a créé, sans expiration — compte HA dédié non-administrateur recommandé plutôt que le compte principal.
# @outils:default SESSION_NAME = agent-ha
# @outils:select PERMISSION_MODE = manual, acceptEdits
# @outils:default PERMISSION_MODE = manual

set -euo pipefail

TARGET_HOST="__TARGET_HOST__"
TARGET_USER="__TARGET_USER__"
HA_URL="__HA_URL__"
HA_TOKEN="__HA_TOKEN__"
SESSION_NAME="__SESSION_NAME__"
PERMISSION_MODE="__PERMISSION_MODE__"

# Même convention que duckdns-caddy.sh (ADDON_DIR) : fichiers propres à cet add-on regroupés à part.
REMOTE_DIR="/dimotic-ha-addons/agent-ha"

if [ "${1:-}" = "--remote-exec" ]; then
  # =====================================================================================
  # Exécuté SUR LA MACHINE CIBLE (relancé par le bloc local ci-dessous, via ssh)
  # =====================================================================================
  if ! command -v screen >/dev/null 2>&1; then
    echo "ERREUR : 'screen' introuvable sur cette machine. Installez-le : apt install screen" >&2
    exit 1
  fi

  if ! command -v claude >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
      echo "ERREUR : 'claude' introuvable et npm absent — impossible d'installer automatiquement." >&2
      echo "Installez Node.js d'abord (ex: https://github.com/nodesource/distributions)." >&2
      exit 1
    fi
    echo "'claude' introuvable — installation automatique (npm install -g @anthropic-ai/claude-code)..."
    npm install -g @anthropic-ai/claude-code
  fi

  if screen -ls 2>/dev/null | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
    echo "ERREUR : une session screen nommée '$SESSION_NAME' existe déjà sur cette machine." >&2
    echo "Choisissez un autre nom, ou 'screen -r $SESSION_NAME' pour vous y attacher." >&2
    exit 1
  fi

  mkdir -p "$REMOTE_DIR"
  printf '%s' "$HA_TOKEN" > "$REMOTE_DIR/ha_token"
  chmod 600 "$REMOTE_DIR/ha_token"

  # CLAUDE.md — Claude Code le charge automatiquement comme instructions projet dès l'ouverture
  # d'une session dans ce répertoire, aucune saisie manuelle requise côté utilisateur.
  cat > "$REMOTE_DIR/CLAUDE.md" <<EOF
# Environnement Home Assistant

Tu opères dans un environnement Home Assistant, en accès direct via son API REST/WebSocket. Ce
canal est volontairement distinct et parallèle au dépôt dimotic-ha (si jamais tu y touches aussi
dans une autre session) : là-bas, aucun LLM ne reçoit d'accès Home Assistant brut, tout passe par
un jeu d'outils restreint (voir fonctionnelles-ia_specs §6/§7 de ce dépôt si tu veux le contexte).
Ici, tu as un accès complet et direct — à utiliser avec la prudence en conséquence (voir Sécurité).

## Instance Home Assistant

- URL : ${HA_URL}
- Jeton d'authentification (Long-Lived Access Token) : fichier \`./ha_token\` à côté de ce
  CLAUDE.md — ne l'affiche jamais en clair dans tes réponses, ne le commite jamais dans un dépôt
  git, ne le partage jamais avec un service tiers.

## Exemples d'appels API

\`\`\`bash
# Lister tous les états
curl -s -H "Authorization: Bearer \$(cat ha_token)" -H "Content-Type: application/json" \\
  "${HA_URL}/api/states"

# Appeler un service (ex: allumer une lumière)
curl -s -X POST -H "Authorization: Bearer \$(cat ha_token)" -H "Content-Type: application/json" \\
  -d '{"entity_id": "light.salon"}' \\
  "${HA_URL}/api/services/light/turn_on"
\`\`\`

## Sécurité — à respecter

- Ce jeton donne un accès COMPLET au compte Home Assistant qui l'a créé, sans expiration.
- Avant toute action à impact réel (lumières, chauffage, volets, serrures, ou toute modification
  de configuration/automatisation HA), confirme avec l'utilisateur plutôt que d'enchaîner
  silencieusement — même logique que pour toute action destructive ou difficile à annuler.
- Ne colle jamais le contenu de \`./ha_token\` dans une réponse, un commit, ou un service tiers.
EOF

  (cd "$REMOTE_DIR" && screen -dmS "$SESSION_NAME" claude remote-control \
    --permission-mode "$PERMISSION_MODE" --name "$SESSION_NAME")

  sleep 1
  if ! screen -ls 2>/dev/null | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
    echo "ERREUR : la session screen '$SESSION_NAME' ne semble pas avoir démarré." >&2
    exit 1
  fi

  cat <<EOF

Session créée : $SESSION_NAME (répertoire: $REMOTE_DIR)

=== Première mise en œuvre (une seule fois) ===
1. Depuis VOTRE machine, connectez-vous en SSH à celle-ci puis attachez-vous au screen :
     ssh ${TARGET_USER}@${TARGET_HOST}
     screen -r $SESSION_NAME
2. Trois validations interactives apparaîtront successivement — répondez-y :
     a. Connexion Claude.ai (si jamais fait sur cette machine) : suivre le lien affiché par
        /login et se connecter avec le compte Claude.ai (Pro/Max/Team/Enterprise requis, une
        clé API seule ne suffit pas pour le Remote Control).
     b. Confiance du répertoire de travail : "Do you trust the files in this folder?" -> oui.
     c. Activation du Remote Control : "Enable Remote Control? (y/n)" -> y.
3. Une fois les 3 validées, détachez-vous SANS tuer la session : Ctrl-A puis D.
   (la session continue de tourner en arrière-plan sur cette machine)

=== Accès depuis votre téléphone (à chaque fois, après la première mise en œuvre) ===
1. Ouvrir claude.ai/code dans un navigateur, OU l'app mobile Claude Code -> onglet "Code".
2. Se connecter avec le MÊME compte Claude.ai que celui utilisé à l'étape 2a ci-dessus.
3. Dans la liste des sessions, chercher "$SESSION_NAME" (icône ordinateur + point vert = en ligne).
   Rien d'autre à saisir : pas de code ni d'adresse à recopier, la découverte est automatique,
   liée au compte.
4. Taper dessus pour s'y connecter et discuter avec cette instance.

Pour revenir dessus depuis cette machine plus tard : screen -r $SESSION_NAME (Ctrl-A D pour redétacher).
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
if [ -z "$HA_URL" ]; then
  echo "ERREUR : HA_URL est vide — renseignez-le dans le formulaire Outils." >&2
  exit 1
fi
if [ -z "$HA_TOKEN" ]; then
  echo "ERREUR : HA_TOKEN est vide — renseignez-le dans le formulaire Outils." >&2
  exit 1
fi

echo "Dépôt sur ${TARGET_USER}@${TARGET_HOST}..."
ssh "${TARGET_USER}@${TARGET_HOST}" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'"
scp -q "$0" "${TARGET_USER}@${TARGET_HOST}:${REMOTE_DIR}/agent-ha-deploy.sh"
ssh "${TARGET_USER}@${TARGET_HOST}" \
  "chmod 600 '${REMOTE_DIR}/agent-ha-deploy.sh' && bash '${REMOTE_DIR}/agent-ha-deploy.sh' --remote-exec"
