#!/usr/bin/env bash
# =============================================================================
# Définit le secret du canal « gestion des pilotes » (core.pilotes.secret) — le MÊME sur ha2, stfort et le dev (falbala).
# conception-gestion-pilotes_specs v1.6 §11 : signature HMAC des ordres ; sans secret, les pilotes sont en lecture seule.
#
# Le secret est généré ici (openssl rand -hex 32), JAMAIS affiché ni passé en argument de commande : il circule par
# l'entrée standard (ssh) et par une variable d'environnement du seul processus qui édite le fichier.
# Fichier visé : data/core/secrets_config.yaml de chaque machine (écrit sur place : droits et propriétaire conservés).
# Une copie `secrets_config.yaml.bak-AAAAMMJJ-HHMMSS` est faite avant chaque modification.
#
# Usage :
#   ./docker/definir-secret-pilotes.sh                  # ha2 + stfort + dev, avec confirmation avant chaque redémarrage
#   ./docker/definir-secret-pilotes.sh --sans-redemarrage
#   ./docker/definir-secret-pilotes.sh --seulement dev|ha2|stfort   # (répétable)
#   ./docker/definir-secret-pilotes.sh --essai          # n'écrit rien : montre seulement ce qui serait fait
#
# Le secret n'est lu qu'au DÉMARRAGE du cœur : sans redémarrage, il ne sert qu'après le prochain démarrage.
# Le redémarrage d'un cœur coupe ses pilotes environ une minute (stfort : RFXCOM) — d'où la confirmation.
# Le dev (falbala) n'est jamais redémarré par ce script : relance-le toi-même.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEV_DIR="${DEV_DIR:-$PWD}"
HA2_HOST="${HA2_HOST:-192.168.1.51}"
HA2_KEY="${HA2_SSH_KEY:-$HOME/.ssh/ha2-claude/id_ed25519}"
STFORT_HOST="${STFORT_HOST:-192.168.1.53}"
REMOTE_FILE="/docker/dimotic-ha/data/core/secrets_config.yaml"

REDEMARRER=ask
ESSAI=false
ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --sans-redemarrage) REDEMARRER=no ;;
    --essai) ESSAI=true ;;
    --seulement) shift; ONLY+=("${1:-}") ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
  shift
done
voulu() { [ ${#ONLY[@]} -eq 0 ] && return 0; local x; for x in "${ONLY[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

command -v openssl >/dev/null || { echo "openssl est nécessaire" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 est nécessaire" >&2; exit 1; }

# Édition du texte YAML (entrée standard → sortie standard) : core.pilotes.secret, le reste du fichier est conservé tel quel.
EDITEUR='
import os, re, sys
secret = os.environ["PILOTES_SECRET"]
lignes = sys.stdin.read().split("\n")
ligne_secret = "    secret: \"%s\"" % secret
# cherche core: / pilotes: / secret: (indentation 0 / 2 / 4)
def bloc(debut, indent):
    """fin (exclue) du bloc enfant de la ligne `debut` d indentation `indent`"""
    i = debut + 1
    while i < len(lignes) and (lignes[i].strip() == "" or len(lignes[i]) - len(lignes[i].lstrip()) > indent):
        i += 1
    return i
core = next((i for i, l in enumerate(lignes) if re.match(r"^core:\s*$", l)), None)
if core is None:
    lignes = ["core:", "  pilotes:", ligne_secret, ""] + lignes
else:
    fin_core = bloc(core, 0)
    pil = next((i for i in range(core + 1, fin_core) if re.match(r"^  pilotes:\s*$", lignes[i])), None)
    if pil is None:
        lignes[core + 1:core + 1] = ["  pilotes:", ligne_secret]
    else:
        fin_pil = bloc(pil, 2)
        sec = next((i for i in range(pil + 1, fin_pil) if re.match(r"^    secret:", lignes[i])), None)
        if sec is None:
            lignes.insert(pil + 1, ligne_secret)
        else:
            lignes[sec] = ligne_secret
sys.stdout.write("\n".join(lignes))
'

SECRET="$(openssl rand -hex 32)"
export PILOTES_SECRET="$SECRET"
unset SECRET
STAMP="$(date +%Y%m%d-%H%M%S)"

edite() { python3 -c "$EDITEUR"; }

# --- dev (falbala) : fichier local ---------------------------------------------------------------------------------
if voulu dev; then
  F="$DEV_DIR/data/core/secrets_config.yaml"
  echo "=== dev (falbala) : $F"
  if [ ! -f "$F" ]; then echo "    fichier absent : rien fait" >&2
  elif $ESSAI; then echo "    (essai) secret à écrire dans core.pilotes.secret"
  else
    cp -p "$F" "$F.bak-$STAMP"
    NOUVEAU="$(edite < "$F")" && printf '%s' "$NOUVEAU" > "$F"
    chmod 600 "$F"
    echo "    ✅ écrit (sauvegarde $F.bak-$STAMP). Redémarrer le cœur de dev toi-même pour le prendre en compte."
  fi
fi

# --- machines distantes -----------------------------------------------------------------------------------------------
distant() {  # nom  commande-ssh  [préfixe sudo]
  local nom="$1" ssh_cmd="$2" sudo_cmd="${3:-}"
  echo "=== $nom"
  if $ESSAI; then echo "    (essai) secret à écrire dans $REMOTE_FILE"; return 0; fi
  $ssh_cmd "${sudo_cmd}cp -p $REMOTE_FILE $REMOTE_FILE.bak-$STAMP" || { echo "    ÉCHEC de la sauvegarde : rien modifié" >&2; return 1; }
  local nouveau
  nouveau="$($ssh_cmd "${sudo_cmd}cat $REMOTE_FILE" | edite)" || { echo "    ÉCHEC de l'édition : rien modifié" >&2; return 1; }
  [ -n "$nouveau" ] || { echo "    résultat vide : rien modifié" >&2; return 1; }
  printf '%s' "$nouveau" | $ssh_cmd "${sudo_cmd}tee $REMOTE_FILE >/dev/null"
  echo "    ✅ écrit (sauvegarde $REMOTE_FILE.bak-$STAMP)"
  local rep="n"
  if [ "$REDEMARRER" = ask ]; then read -rp "    Redémarrer le cœur de $nom maintenant (coupe ses pilotes ~1 min) ? [o/N] " rep; fi
  if [[ "$rep" =~ ^[oOyY]$ ]]; then
    $ssh_cmd "${sudo_cmd}docker restart dimotic-ha >/dev/null"
    echo "    ↻ redémarré"
  else
    echo "    (non redémarré : le secret ne sera pris en compte qu'au prochain démarrage)"
  fi
}

voulu ha2 && distant "ha2" "ssh -i $HA2_KEY -o ConnectTimeout=10 claude@$HA2_HOST" "sudo " || true
voulu stfort && distant "stfort" "ssh -o ConnectTimeout=10 root@$STFORT_HOST" "" || true

unset PILOTES_SECRET
echo "=== Terminé. Vérification : les ordres modifiants (adopter, supprimer…) sont acceptés quand le même secret est chargé partout."
