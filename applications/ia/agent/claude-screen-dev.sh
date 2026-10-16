#!/bin/bash
# Lance (ou rattache) un Claude Code dans un `screen`, sur la machine de DÉVELOPPEMENT, relié au serveur MCP du dimotic-ha local.
# Prépare ~/claude-dev/ : CLAUDE.md (modèle versionné applications/ia/agent/claude-md + section site « dev »), .mcp.json.
#   bash claude-screen-dev.sh            -> prépare, crée la session si besoin, s'y rattache
#   bash claude-screen-dev.sh --detach   -> sans se rattacher
#   bash claude-screen-dev.sh --prepare  -> prépare seulement (CLAUDE.md, .mcp.json), sans lancer
# Prérequis (une fois) : dans l'UI de dimotic-ha, activer l'application `ia`, puis Paramètres techniques > ia > Accès Claude Code (MCP) :
#   activer, port 8765, adresse 127.0.0.1, jeton (openssl rand -hex 32). Mettre ce même jeton dans ~/claude-dev/.mcp_token (chmod 600).
# Affichage (16/10/2026, essai de tout retirer : les deux défauts sont revenus, donc ces réglages SONT nécessaires) :
#   - souris ignorée par Claude Code (CLAUDE_CODE_DISABLE_MOUSE=1) : sinon des séquences d'échappement (« 34;27M34;… ») s'impriment
#     dans la zone de saisie dès que le pointeur bouge au-dessus du terminal ; remise à zéro des modes souris à la sortie ;
#   - screenrc dédié : `defbce on` + 256 couleurs, sinon la couleur de fond bave sur tout l'écran (texte sur fond rouge) ;
#   - PAS d'écran alternatif (`altscreen`) : on peut remonter dans l'historique (Ctrl-A puis [).
# Remonter dans l'historique : Ctrl-A puis [ (mode copie), PgUp/PgDn ou flèches, Esc pour sortir ; dans Claude Code : Ctrl+O (transcription complète).
# Quitter sans arrêter : Ctrl-A puis D. Se rattacher : screen -r claude-dev
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL="$HERE/claude-md"
WORK="${CLAUDE_DEV_DIR:-$HOME/claude-dev}"
PORT="${DIMOTIC_MCP_PORT:-8765}"
SESSION="claude-dev"
mkdir -p "$WORK"
{
  printf '<!-- agent-claude-md v%s (dev) — généré le %s par claude-screen-dev -->\n\n' "$(tr -d '[:space:]' < "$TPL/VERSION")" "$(date +%Y-%m-%d)"
  sed -e 's|{{TARGET_HOST}}|falbala (développement)|g' "$TPL/00-role.md"; echo
  cat "$TPL/10-dimotic-mcp.md"; echo
  cat "$TPL/90-securite.md"; echo
  cat "$TPL/sites/dev.md"
} > "$WORK/CLAUDE.md"

cat > "$WORK/.mcp.json" <<JSON
{
  "mcpServers": {
    "dimotic": {
      "type": "http",
      "url": "http://127.0.0.1:${PORT}/mcp",
      "headers": { "Authorization": "Bearer \${DIMOTIC_MCP_TOKEN}" }
    }
  }
}
JSON
# Lanceur UNIQUE de Claude Code (à utiliser aussi à la main, dans le screen : `./claude.sh`) : jeton MCP lu dans le fichier, souris ignorée,
# marqueurs « session fille » retirés, modes souris remis à zéro à la sortie. Taper `claude` seul donne des défauts d'affichage.
cat > "$WORK/claude.sh" <<'LANCEUR'
#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -s .mcp_token ] || { echo "Jeton MCP absent : .mcp_token" >&2; exit 1; }
export DIMOTIC_MCP_TOKEN="$(cat .mcp_token)"
env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_DISABLE_MOUSE=1 claude "$@"
printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l'
LANCEUR
chmod 700 "$WORK/claude.sh"
# screenrc dédié : effacement avec la couleur de fond courante (bce) et 256 couleurs ; historique de 10 000 lignes
cat > "$WORK/screenrc" <<RC
term screen-256color
defbce on
defscrollback 10000
startup_message off
RC
echo "Préparé : $WORK/CLAUDE.md et $WORK/.mcp.json"
[ "${1:-}" = "--prepare" ] && exit 0

if [ ! -s "$WORK/.mcp_token" ]; then
  echo "Jeton MCP absent : écrire le jeton (celui saisi dans l'UI de dimotic-ha, ia > MCP) dans $WORK/.mcp_token (chmod 600)." >&2
  exit 1
fi
chmod 600 "$WORK/.mcp_token"
if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/"; then
  echo "AVERTISSEMENT : rien n'écoute sur 127.0.0.1:${PORT} — application ia activée et MCP activé dans l'UI ?" >&2
fi

if ! screen -ls | grep -q "[0-9]\.${SESSION}[[:space:]]"; then
  # Le jeton est lu dans le fichier au lancement, jamais écrit dans la ligne de commande visible.
  # `env -u` : retire les marqueurs « session fille » hérités d'un Claude Code parent (sinon l'historique des conversations n'est pas sauvegardé).
  screen -c "$WORK/screenrc" -dmS "$SESSION" bash -lc "cd '$WORK' && ./claude.sh; exec bash"
  echo "Session screen « $SESSION » créée (Claude Code dans $WORK)."
fi
[ "${1:-}" = "--detach" ] || exec screen -c "$WORK/screenrc" -r "$SESSION"
