#!/bin/bash
# dimotic-pilotes — commande RESTREINTE de noisy pour l'agent Claude de noisy2 (15/10/2026).
# Installée sur noisy en /usr/local/bin/dimotic-pilotes et appelée par SSH comme « commande forcée » de la clé
# de l'agent (authorized_keys : command="/usr/local/bin/dimotic-pilotes",restrict ...). Aucune autre commande n'est possible.
#
# Usage (SSH_ORIGINAL_COMMAND) :
#   lister [<app>]              applications autorisées, ou fichiers d'une application
#   lire <app> <fichier>        affiche un fichier du dossier data/<app>/
#   ecrire <app> <fichier>      remplace le fichier par l'entrée standard (sauvegarde .bak-… automatique, YAML/JSON contrôlé)
#   arreter <app> | demarrer <app> | redemarrer <app>     désactive / active à chaud l'application (jamais le cœur)
set -u
DATA=/docker/dimotic-ha/data
CONTENEUR=dimotic-ha
APPS="arexx rfxcom rpigpio teleinfo"
LOG=/var/log/dimotic-pilotes.log

set -- ${SSH_ORIGINAL_COMMAND:-}
CMD="${1:-}"; APP="${2:-}"; FIC="${3:-}"
echo "$(date '+%F %T') $CMD $APP $FIC" >> "$LOG" 2>/dev/null

echec() { echo "REFUSÉ : $*" >&2; exit 2; }
app_ok() { [[ "$APP" =~ ^[a-z0-9_-]+$ ]] && [[ " $APPS " == *" $APP "* ]] || echec "application « $APP » non autorisée (autorisées : $APPS)"; }
fic_ok() {
  [[ -n "$FIC" && "$FIC" =~ ^[A-Za-z0-9._/-]+$ && "$FIC" != /* && "$FIC" != *..* ]] || echec "nom de fichier invalide"
  [[ "$FIC" =~ (secret|token|password|\.pem|\.key) ]] && echec "fichier de secrets interdit"
  [[ -d "$DATA/$APP" ]] || echec "dossier $DATA/$APP absent"
}
evenement() {   # $1 = enable|disable
  docker exec -i "$CONTENEUR" node -e '
    const WebSocket=require("/app/applications/core/node_modules/ws");const ev="app:applications:"+process.argv[1],appId=process.argv[2];
    const ws=new WebSocket("ws://127.0.0.1:8087/socket.io/?EIO=4&transport=websocket");
    setTimeout(()=>{console.log("délai dépassé");process.exit(4)},90000);
    ws.on("message",m=>{const s=m.toString();if(s[0]==="0")ws.send("40");else if(s==="2")ws.send("3");
      else if(s.startsWith("40"))ws.send("42"+JSON.stringify([ev,{appId}]));
      else if(s.startsWith("42")){const [n,d]=JSON.parse(s.slice(2));if(n===ev+":result"){console.log(JSON.stringify(d));process.exit(d.success?0:3)}}});
    ws.on("error",e=>{console.log("erreur",e.message);process.exit(5)});' "$1" "$APP"
}

case "$CMD" in
  lister)
    if [[ -z "$APP" ]]; then echo "$APPS" | tr ' ' '\n'; else app_ok; (cd "$DATA/$APP" && find . -maxdepth 3 -type f -printf '%TY-%Tm-%Td %TH:%TM  %s  %p\n' | sort -k4); fi ;;
  lire)
    app_ok; fic_ok; [[ -f "$DATA/$APP/$FIC" ]] || echec "fichier absent"
    head -c 1000000 "$DATA/$APP/$FIC" ;;
  ecrire)
    app_ok; fic_ok
    cible="$DATA/$APP/$FIC"; tmp=$(mktemp)
    head -c 1000000 > "$tmp"; [[ -s "$tmp" ]] || { rm -f "$tmp"; echec "contenu vide"; }
    case "$FIC" in
      *.yaml|*.yml) docker exec -i "$CONTENEUR" node -e 'const y=require("/app/applications/core/node_modules/js-yaml");y.load(require("fs").readFileSync(0,"utf8"))' < "$tmp" 2>/dev/null || { rm -f "$tmp"; echec "YAML invalide, fichier NON modifié"; } ;;
      *.json) python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null || { rm -f "$tmp"; echec "JSON invalide, fichier NON modifié"; } ;;
    esac
    if [[ -f "$cible" ]]; then sauv="$cible.bak-$(date +%Y%m%d-%H%M%S)"; cp -p "$cible" "$sauv" && echo "sauvegarde : $sauv"; fi
    mkdir -p "$(dirname "$cible")"; cat "$tmp" > "$cible"; rm -f "$tmp"; echo "écrit : $cible" ;;
  arreter)    app_ok; evenement disable ;;
  demarrer)   app_ok; evenement enable ;;
  redemarrer) app_ok; evenement disable && sleep 3 && evenement enable ;;
  *) echec "commande inconnue — lister | lire | ecrire | arreter | demarrer | redemarrer" ;;
esac
