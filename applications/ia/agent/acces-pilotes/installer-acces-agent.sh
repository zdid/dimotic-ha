#!/bin/bash
# installer-acces-agent.sh — met en place l'accès RESTREINT de l'agent Claude d'un site aux pilotes d'une machine
# (AREXX, RFXCOM, GPIO…), par SSH avec une clé dédiée dont la seule commande permise est dimotic-pilotes.
# Fourni dans l'image dimotic-ha : /app/applications/ia/agent/acces-pilotes/ (docker cp dimotic-ha:/app/applications/ia/agent/acces-pilotes /tmp/).
# Ne s'exécute que lancé à la main.
#
#   Côté AGENT (noisy2, ha2 — compte « claude », sans root) :
#     ./installer-acces-agent.sh agent --nom noisy --hote 192.168.1.62      crée ~/.ssh/noisy-pilotes et affiche la clé publique
#   Côté PILOTES (noisy, stfort — root) :
#     sudo ./installer-acces-agent.sh pilotes --cle-publique "ssh-ed25519 AAAA… agent" [--apps "arexx rfxcom"] [--donnees /docker/dimotic-ha/data] [--conteneur dimotic-ha] [--port 8087]
#     sudo ./installer-acces-agent.sh pilotes --annuler                     retire la clé autorisée, le script et la config
set -eu
ICI="$(cd "$(dirname "$0")" && pwd)"
MARQUE="dimotic-pilotes-agent"
CIBLE=/usr/local/bin/dimotic-pilotes
CONF=/etc/dimotic-pilotes.conf
AUTH=/root/.ssh/authorized_keys
SIMUL=0
die() { echo "ERREUR : $*" >&2; exit 1; }
MODE="${1:-}"; [ -n "$MODE" ] && shift || die "mode : agent | pilotes"

NOM=""; HOTE=""; CLEPUB=""; APPS=""; DATA=/docker/dimotic-ha/data; CONT=dimotic-ha; PORT=8087; ANNULER=0
while [ $# -gt 0 ]; do case "$1" in
  --nom) NOM="$2"; shift 2;; --hote) HOTE="$2"; shift 2;; --cle-publique) CLEPUB="$2"; shift 2;;
  --apps) APPS="$2"; shift 2;; --donnees) DATA="$2"; shift 2;; --conteneur) CONT="$2"; shift 2;; --port) PORT="$2"; shift 2;;
  --annuler) ANNULER=1; shift;; *) die "option inconnue : $1";; esac; done

case "$MODE" in
agent)
  [ -n "$NOM" ] || die "--nom requis (ex. noisy, stfort)"
  CLE="$HOME/.ssh/${NOM}-pilotes"
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  [ -f "$CLE" ] && echo "Clé déjà présente : $CLE (conservée)" || ssh-keygen -t ed25519 -N '' -C "agent $(hostname) -> pilotes $NOM" -f "$CLE" >/dev/null
  echo "Clé publique à donner à la machine des pilotes (option --cle-publique) :"; echo; cat "$CLE.pub"; echo
  echo "Essai, une fois l'étape « pilotes » faite :"
  echo "  ssh -i $CLE -o IdentitiesOnly=yes root@${HOTE:-<adresse>} lister"
  ;;
pilotes)
  [ "$(id -u)" = 0 ] || die "à lancer en root (sudo)"
  if [ "$ANNULER" = 1 ]; then
    [ -f "$AUTH" ] && sed -i "/$MARQUE/d" "$AUTH" && echo "clé autorisée retirée"
    rm -f "$CIBLE" "$CONF"; echo "script et config retirés (le journal /var/log/dimotic-pilotes.log est conservé)"; exit 0
  fi
  [ -n "$CLEPUB" ] || die "--cle-publique requis"
  case "$CLEPUB" in ssh-ed25519\ *|ssh-rsa\ *) ;; *) die "clé publique invalide";; esac
  command -v docker >/dev/null || die "docker absent"
  [ -d "$DATA" ] || die "dossier de données absent : $DATA"
  if [ -z "$APPS" ]; then for a in arexx rfxcom rpigpio teleinfo; do [ -d "$DATA/$a" ] && APPS="$APPS $a"; done; APPS="${APPS# }"; fi
  [ -n "$APPS" ] || die "aucune application de pilote trouvée dans $DATA (utiliser --apps)"
  install -m 755 "$ICI/dimotic-pilotes.sh" "$CIBLE"
  printf 'DATA=%s\nCONTENEUR=%s\nPORT=%s\nAPPS="%s"\n' "$DATA" "$CONT" "$PORT" "$APPS" > "$CONF"
  touch /var/log/dimotic-pilotes.log; chmod 600 /var/log/dimotic-pilotes.log
  mkdir -p /root/.ssh; chmod 700 /root/.ssh; touch "$AUTH"; chmod 600 "$AUTH"
  cp -p "$AUTH" "$AUTH.bak-$(date +%Y%m%d-%H%M%S)"
  sed -i "/$MARQUE/d" "$AUTH"
  echo "command=\"$CIBLE\",restrict $CLEPUB $MARQUE" >> "$AUTH"
  echo "Installé : $CIBLE ; applications autorisées : $APPS ; données : $DATA ; conteneur : $CONT:$PORT"
  echo "Retour arrière : sudo $0 pilotes --annuler"
  ;;
*) die "mode : agent | pilotes";;
esac
