#!/bin/sh
# =============================================================================
# maj-dimotic.sh — agent de mise à jour de dimotic-ha (conception-mise-a-jour-dimotic_specs v1.1).
#
# Tourne dans un petit conteneur « maj » (compose.deploy.yaml, profil `maj`) qui seul reçoit le socket Docker de l'hôte ;
# le conteneur dimotic-ha, lui, n'y a jamais accès. Utilisable aussi à la main.
#
# Usage :
#   maj-dimotic.sh etat                         version installée, dernière version du hub
#   maj-dimotic.sh verifier X.Y.Z               la version existe-t-elle sur le hub pour cette architecture ?
#   maj-dimotic.sh mettre-a-jour X.Y.Z [--oui]  sans --oui : aperçu seulement ; avec --oui : exécute
#   maj-dimotic.sh revenir [--oui]              remet la version précédente
#   maj-dimotic.sh --ecouter                    écoute MQTT — mode du conteneur : ordres signés (…/commande/+) et
#                                               bouton « Installer » de HA (…/installer, payload INSTALL)
#
# Réglages (variables d'environnement) : MAJ_DIR (/docker/dimotic-ha), MAJ_SERVICE (app), MAJ_CONTAINER (dimotic-ha),
# MAJ_REPO (zdid2/dimotic-ha), MAJ_HEALTH_TIMEOUT (300 s), MAJ_DOCKER, MAJ_CURL (pour les essais).
# Ne touche jamais à data/ ni logs/.
# =============================================================================
set -u

DIR="${MAJ_DIR:-/docker/dimotic-ha}"
SERVICE="${MAJ_SERVICE:-app}"
CONTAINER="${MAJ_CONTAINER:-dimotic-ha}"
REPO="${MAJ_REPO:-zdid2/dimotic-ha}"
HEALTH_TIMEOUT="${MAJ_HEALTH_TIMEOUT:-300}"
DOCKER="${MAJ_DOCKER:-docker}"
CURL="${MAJ_CURL:-curl}"
ENV_FILE="$DIR/.env"
PRECEDENT="$DIR/.maj-precedent"
LOCK="$DIR/.maj.lock"
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

log() {
  mkdir -p "$DIR/logs" 2>/dev/null
  printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$DIR/logs/maj.log" 2>/dev/null
  printf '%s\n' "$*" >&2
}

version_courante() {
  v="$(grep '^DIMOTIC_TAG=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2)"
  printf '%s' "${v:-latest}"
}

architecture() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    armv7l|armv7) echo arm ;;
    *) uname -m ;;
  esac
}

version_valide() { printf '%s' "$1" | grep -Eq "$SEMVER"; }

# Le tag existe sur le hub pour l'architecture de cette machine (0 = oui).
existe_sur_hub() {
  rep="$($CURL -fsS -m 20 "https://hub.docker.com/v2/repositories/$REPO/tags/$1" 2>/dev/null)" || return 1
  arch="$(architecture)"
  printf '%s' "$rep" | jq -e --arg a "$arch" '[.images[]?.architecture] | index($a) != null' >/dev/null 2>&1
}

derniere_version_hub() {
  $CURL -fsS -m 20 "https://hub.docker.com/v2/repositories/$REPO/tags?page_size=100&ordering=last_updated" 2>/dev/null \
    | jq -r '.results[].name' 2>/dev/null | grep -E "$SEMVER" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

# --- configuration (MQTT, identité) lue dans data/ -----------------------------------------------------------------
cfg() {  # fichier clé-yq
  yq "$2 // \"\"" "$DIR/data/core/$1" 2>/dev/null
}
machine_id() { if [ -n "${MAJ_MACHINE_ID:-}" ]; then printf '%s' "$MAJ_MACHINE_ID"; else cfg machine_config.yaml '.core.machineId'; fi; }
site() { s="$(cfg machine_config.yaml '.core.site')"; [ -n "$s" ] && printf '%s' "$s" || printf '%s' "$(machine_id)"; }
secret_maj() { if [ -n "${MAJ_SECRET:-}" ]; then printf '%s' "$MAJ_SECRET"; else cfg secrets_config.yaml '.core.maj.secret'; fi; }

# Même découpage que le cœur (segmentSite : minuscules, [a-z0-9_-]).
segment() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]/_/g'; }
racine_topics() { printf 'dimotic/%s/maj/%s' "$(segment "$(site)")" "$(machine_id)"; }

mqtt_args() {
  host="$(cfg config.yaml '.ha.mqtt.host')"; port="$(cfg config.yaml '.ha.mqtt.port')"
  user="$(cfg config.yaml '.ha.mqtt.username')"; pass="$(cfg secrets_config.yaml '.ha.mqtt.password')"
  [ -z "$pass" ] && pass="$(cfg config.yaml '.ha.mqtt.password')"
  printf -- '-h %s -p %s' "${host:-127.0.0.1}" "${port:-1883}"
  [ -n "$user" ] && printf -- ' -u %s -P %s' "$user" "$pass"
}

publier() {  # topic payload retenu(0|1)
  [ "${MAJ_SANS_MQTT:-0}" = 1 ] && return 0
  # shellcheck disable=SC2046
  mosquitto_pub $(mqtt_args) -t "$1" -m "$2" $([ "${3:-0}" = 1 ] && printf -- '-r') -q 1 >/dev/null 2>&1 || true
}

# État retenu : { etat, version, cible?, etape?, date }
publier_etat() {  # etat [cible] [etape]
  [ "${MAJ_SANS_MQTT:-0}" = 1 ] && return 0
  json="$(jq -cn --arg etat "$1" --arg v "$(version_courante)" --arg cible "${2:-}" --arg etape "${3:-}" --arg d "$(date -u '+%FT%TZ')" \
    '{etat:$etat, version:$v, date:$d} + (if $cible != "" then {cible:$cible} else {} end) + (if $etape != "" then {etape:$etape} else {} end)')"
  publier "$(racine_topics)/etat" "$json" 1
}

verrouiller() {
  mkdir "$LOCK" 2>/dev/null || { log "ERREUR : une mise à jour est déjà en cours ($LOCK)"; return 1; }
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
}

attendre_sante() {
  fin=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$fin" ]; do
    s="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans-sonde{{end}}' "$CONTAINER" 2>/dev/null)"
    case "$s" in
      healthy) return 0 ;;
      sans-sonde) [ "$($DOCKER inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] && return 0 ;;
    esac
    sleep "${MAJ_SONDE_SEC:-3}"
  done
  return 1
}

definir_tag() {  # fixe DIMOTIC_TAG dans .env (le crée / l'ajoute si besoin)
  if [ -f "$ENV_FILE" ] && grep -q '^DIMOTIC_TAG=' "$ENV_FILE"; then
    sed -i "s/^DIMOTIC_TAG=.*/DIMOTIC_TAG=$1/" "$ENV_FILE"
  else
    printf 'DIMOTIC_TAG=%s\n' "$1" >> "$ENV_FILE"
  fi
}

relancer() { $DOCKER compose --project-directory "$DIR" -f "$DIR/compose.yaml" up -d "$SERVICE" >/dev/null 2>&1; }

# --- ordres ---------------------------------------------------------------------------------------------------------
cmd_etat() {
  jq -cn --arg v "$(version_courante)" --arg l "$(derniere_version_hub)" --arg a "$(architecture)" '{version:$v, derniere_hub:$l, architecture:$a}'
}

cmd_verifier() {
  version_valide "${1:-}" || { log "ERREUR : version « ${1:-} » invalide (X.Y.Z attendu)"; return 2; }
  if existe_sur_hub "$1"; then jq -cn --arg v "$1" '{version:$v, existe:true}'; else jq -cn --arg v "$1" '{version:$v, existe:false}'; return 1; fi
}

cmd_mettre_a_jour() {
  cible="${1:-}"; oui="${2:-}"
  version_valide "$cible" || { log "ERREUR : version « $cible » invalide (X.Y.Z attendu)"; return 2; }
  actuelle="$(version_courante)"
  [ "$cible" = "$actuelle" ] && { jq -cn --arg v "$cible" '{effectue:false, raison:"déjà à cette version", version:$v}'; return 0; }
  existe_sur_hub "$cible" || { log "ERREUR : la version $cible n'existe pas sur le hub pour $(architecture)"; return 3; }
  if [ "$oui" != "--oui" ]; then
    jq -cn --arg de "$actuelle" --arg vers "$cible" --arg a "$(architecture)" \
      '{effectue:false, apercu:true, de:$de, vers:$vers, architecture:$a, redemarre:"dimotic-ha (cœur et applications, environ une minute)", message:"Aucune modification faite. Relancer avec confirmation."}'
    return 0
  fi
  verrouiller || return 4
  log "Mise à jour $actuelle -> $cible"
  publier_etat en_cours "$cible" telechargement
  cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  if ! $DOCKER pull "$REPO:$cible" >/dev/null 2>&1; then
    log "ÉCHEC du téléchargement de $REPO:$cible : rien n'a été modifié"
    publier_etat echec "$cible" telechargement
    return 5
  fi
  printf '%s\n' "$actuelle" > "$PRECEDENT"
  publier_etat en_cours "$cible" bascule
  definir_tag "$cible"
  if relancer && attendre_sante; then
    log "OK : dimotic-ha est en $cible"
    publier_etat libre
    jq -cn --arg de "$actuelle" --arg vers "$cible" '{effectue:true, de:$de, vers:$vers}'
    return 0
  fi
  log "ÉCHEC : retour à $actuelle"
  publier_etat en_cours "$actuelle" retour_arriere
  definir_tag "$actuelle"
  relancer && attendre_sante
  publier_etat echec "$cible" retour_arriere
  jq -cn --arg de "$actuelle" --arg vers "$cible" '{effectue:false, raison:"le nouveau conteneur n a pas démarré correctement", retour:$de}'
  return 6
}

cmd_revenir() {
  [ -f "$PRECEDENT" ] || { log "ERREUR : aucune version précédente enregistrée"; return 2; }
  prec="$(cat "$PRECEDENT")"
  version_valide "$prec" || { log "ERREUR : version précédente illisible"; return 2; }
  cmd_mettre_a_jour "$prec" "${1:-}"
}

# --- écoute MQTT ---------------------------------------------------------------------------------------------------
signature_attendue() {  # JSON-sans-signature
  printf '%s' "$1" | jq -S -c 'del(.signature)' | tr -d '\n' | openssl dgst -sha256 -hmac "$(secret_maj)" | sed 's/^.*= //'
}

repondre() {  # id json
  publier "$(racine_topics)/reponse/$1" "$2" 0
}

traiter_commande() {  # charge JSON
  charge="$1"
  id="$(printf '%s' "$charge" | jq -r '.id // ""')"
  [ -n "$id" ] || return 0
  secret="$(secret_maj)"
  if [ -z "$secret" ]; then repondre "$id" '{"ok":false,"erreur":"aucun secret de mise à jour défini sur cette machine"}'; return 0; fi
  [ "$(printf '%s' "$charge" | jq -r '.machine // ""')" = "$(machine_id)" ] || { repondre "$id" '{"ok":false,"erreur":"autre machine"}'; return 0; }
  recu="$(printf '%s' "$charge" | jq -r '.signature // ""')"
  [ "$recu" = "$(signature_attendue "$charge")" ] || { log "Ordre $id refusé : signature fausse"; repondre "$id" '{"ok":false,"erreur":"signature invalide"}'; return 0; }
  ts="$(printf '%s' "$charge" | jq -r '.ts // 0')"; maintenant="$(date +%s)"
  ecart=$(( maintenant - ts )); [ "$ecart" -lt 0 ] && ecart=$(( -ecart ))
  [ "$ecart" -le 60 ] || { log "Ordre $id refusé : trop ancien"; repondre "$id" '{"ok":false,"erreur":"ordre trop ancien"}'; return 0; }
  vus="$DIR/.maj-ids-vus"
  grep -qx "$id" "$vus" 2>/dev/null && { repondre "$id" '{"ok":false,"erreur":"ordre déjà reçu"}'; return 0; }
  printf '%s\n' "$id" >> "$vus"; tail -n 200 "$vus" > "$vus.tmp" 2>/dev/null && mv "$vus.tmp" "$vus"

  ordre="$(printf '%s' "$charge" | jq -r '.ordre // ""')"
  version="$(printf '%s' "$charge" | jq -r '.parametres.version // ""')"
  confirme="$(printf '%s' "$charge" | jq -r '.confirme // false')"
  log "Ordre $id : $ordre $version"
  case "$ordre" in
    etat) res="$(cmd_etat)"; repondre "$id" "$(jq -cn --argjson r "$res" '{ok:true, resultat:$r}')" ;;
    verifier) res="$(cmd_verifier "$version")"; repondre "$id" "$(jq -cn --argjson r "${res:-null}" '{ok:true, resultat:$r}')" ;;
    mettre_a_jour)
      if [ "$confirme" = true ]; then arg="--oui"; else arg=""; fi
      res="$(cmd_mettre_a_jour "$version" $arg 2>/dev/null)"; code=$?
      repondre "$id" "$(jq -cn --argjson r "${res:-null}" --argjson c "$code" '{ok:($c==0), code:$c, resultat:$r}')" ;;
    *) repondre "$id" '{"ok":false,"erreur":"ordre inconnu"}' ;;
  esac
}

# Demande d'installation venant du bouton « Installer » de HA (payload INSTALL) : n'installe QUE la dernière version
# officielle du hub, si elle est plus récente que l'installée — aucun paramètre, donc rien à signer.
traiter_installation_ha() {
  [ "${MAJ_INSTALL_HA:-1}" = 1 ] || { log "Demande de HA ignorée (MAJ_INSTALL_HA=0)"; return 0; }
  derniere="$(derniere_version_hub)"
  actuelle="$(version_courante)"
  version_valide "$derniere" || { log "Demande de HA : dernière version du hub illisible"; return 0; }
  plus_recente="$(printf '%s\n%s\n' "$actuelle" "$derniere" | grep -E "$SEMVER" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
  if [ "$derniere" = "$actuelle" ] || [ "$plus_recente" != "$derniere" ]; then
    log "Demande de HA : rien à installer ($actuelle, hub $derniere)"; return 0
  fi
  log "Demande de HA : installation de $derniere"
  cmd_mettre_a_jour "$derniere" --oui >/dev/null 2>&1
}

ecouter() {
  command -v mosquitto_sub >/dev/null && command -v jq >/dev/null && command -v openssl >/dev/null && command -v yq >/dev/null \
    || { log "ERREUR : mosquitto, jq, openssl et yq sont nécessaires"; exit 1; }
  while :; do
    [ -n "$(machine_id)" ] || { log "machine_config.yaml sans machineId : nouvel essai dans 30 s"; sleep 30; continue; }
    log "Écoute de $(racine_topics) (ordres signés : secret $( [ -n "$(secret_maj)" ] && echo défini || echo ABSENT ) ; bouton HA : $( [ "${MAJ_INSTALL_HA:-1}" = 1 ] && echo actif || echo inactif ))"
    publier_etat libre
    # shellcheck disable=SC2046
    mosquitto_sub $(mqtt_args) -q 1 -t "$(racine_topics)/commande/+" -t "$(racine_topics)/installer" -F '%t %p' 2>/dev/null | while IFS= read -r ligne; do
      sujet="${ligne%% *}"; charge="${ligne#* }"
      case "$sujet" in
        */installer) [ "$charge" = INSTALL ] && traiter_installation_ha ;;
        */commande/*) traiter_commande "$charge" ;;
      esac
    done
    log "Connexion MQTT perdue : nouvel essai dans 10 s"; sleep 10
  done
}

[ "${MAJ_SOURCE_ONLY:-0}" = 1 ] && return 0 2>/dev/null

case "${1:-}" in
  etat) cmd_etat ;;
  verifier) shift; cmd_verifier "${1:-}" ;;
  mettre-a-jour) shift; cmd_mettre_a_jour "${1:-}" "${2:-}" ;;
  revenir) shift; cmd_revenir "${1:-}" ;;
  --ecouter) ecouter ;;
  *) sed -n '3,15p' "$0"; exit 1 ;;
esac
