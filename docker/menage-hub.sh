#!/usr/bin/env bash
# =============================================================================
# Ménage des anciennes versions de zdid2/dimotic-ha sur le Docker Hub (décision du 18/10/2026) :
# on GARDE 3.9.12 (actuelle), 3.9.11 (retour arrière), 3.8.0 et 3.7.2, plus le tag « latest » ; tout le reste est supprimé.
# L'image de l'agent (zdid2/dimotic-maj) n'est pas touchée.
#
# Usage :
#   ./docker/menage-hub.sh                 # ESSAI : liste ce qui serait supprimé, ne supprime rien
#   ./docker/menage-hub.sh --supprimer     # supprime (demande le nom d'utilisateur et un JETON Docker Hub, saisie masquée)
#
# Le jeton (Account settings > Personal access tokens) doit avoir la permission « Read, Write, Delete ». Il n'est JAMAIS affiché
# ni écrit : lu à la saisie (masquée), utilisé pour obtenir une session, puis oublié.
# Avant de supprimer : attendre que toutes les machines soient passées sur une version gardée (ha2, stfort, falbala, noisy, noisy2).
# =============================================================================
set -euo pipefail
REPO="zdid2/dimotic-ha"
GARDER=("3.9.12" "3.9.11" "3.8.0" "3.7.2" "latest")
MODE="essai"; [ "${1:-}" = "--supprimer" ] && MODE="supprimer"
command -v curl >/dev/null && command -v python3 >/dev/null || { echo "curl et python3 sont nécessaires" >&2; exit 1; }

# 1. Tags actuels (API publique, sans compte)
TAGS="$(python3 - <<PY
import json, urllib.request
url="https://hub.docker.com/v2/repositories/$REPO/tags?page_size=100"; out=[]
while url:
    d=json.load(urllib.request.urlopen(url, timeout=30)); out+=[x["name"] for x in d["results"]]; url=d.get("next")
print("\n".join(out))
PY
)"
estgarde() { local t; for t in "${GARDER[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

# Garde-fou : la version actuelle doit exister, sinon on ne supprime rien.
echo "$TAGS" | grep -qx "3.9.12" || { echo "ERREUR : 3.9.12 n'existe pas sur le hub — rien à supprimer." >&2; exit 1; }

A_SUPPRIMER=()
while IFS= read -r t; do [ -n "$t" ] && ! estgarde "$t" && A_SUPPRIMER+=("$t"); done <<< "$TAGS"
echo "Tags sur le hub : $(echo "$TAGS" | wc -l) — gardés : ${GARDER[*]} — à supprimer : ${#A_SUPPRIMER[@]}"
printf '  %s\n' "${A_SUPPRIMER[@]}" | column -c 100 2>/dev/null || printf '  %s\n' "${A_SUPPRIMER[@]}"
[ "$MODE" = "essai" ] && { echo; echo "(essai : rien supprimé. Relancer avec --supprimer pour agir.)"; exit 0; }

# 2. Suppression
read -rp "Nom d'utilisateur Docker Hub [zdid2] : " U; U="${U:-zdid2}"
read -rsp "Jeton (Read, Write, Delete) — saisie masquée : " P; echo
read -rp "Supprimer ${#A_SUPPRIMER[@]} tags de $REPO ? Taper « oui » : " R; [ "$R" = "oui" ] || { echo "Annulé."; exit 1; }
JWT="$(python3 -c "
import json,sys,urllib.request
b=json.dumps({'username':sys.argv[1],'password':sys.argv[2]}).encode()
r=urllib.request.Request('https://hub.docker.com/v2/users/login',b,{'Content-Type':'application/json'})
print(json.load(urllib.request.urlopen(r,timeout=30)).get('token',''))" "$U" "$P")" || { echo "Connexion refusée (jeton invalide ?)" >&2; exit 1; }
unset P
[ -n "$JWT" ] || { echo "Connexion refusée" >&2; exit 1; }
OK=0; KO=0
for t in "${A_SUPPRIMER[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: JWT $JWT" "https://hub.docker.com/v2/repositories/$REPO/tags/$t/")"
  if [ "$code" = "204" ] || [ "$code" = "200" ]; then OK=$((OK+1)); echo "  supprimé : $t"; else KO=$((KO+1)); echo "  ÉCHEC ($code) : $t"; fi
done
unset JWT
echo "Terminé : $OK supprimés, $KO échecs."
