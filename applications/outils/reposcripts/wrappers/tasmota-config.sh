#!/bin/bash
# Généré par l'application Outils — CONFIGURE À DISTANCE un appareil Tasmota déjà connecté au Wi-Fi.
# Rien à saisir sur l'appareil lui-même : seulement les variables ci-dessous.
#
# Communication (⭐ 28/09/2026, décision utilisateur) :
#  - PAR MQTT en priorité : l'appareil est retrouvé à partir de son adresse IP dans sa découverte
#    retenue (tasmota/discovery/<MAC>/config, champ "ip"), sur le broker MQTT_HOST puis sur ha2 ; ses
#    commandes partent sur cmnd/…, les réponses reviennent sur stat/…. Aucun mot de passe : marche
#    même quand l'interface web est protégée (WebPassword), ce qui est voulu.
#  - PAR LE WEB (http://<IP>/cm) seulement pour un appareil neuf, pas encore sur MQTT, sans mot de
#    passe web.
#
# Étapes : 1) état actuel (version, modèle, nom, topics, MQTT) ; 2) réglages prévus et CONFIRMATION ;
# 3) mise à jour OTA si demandée ; 4) modèle d'appareil (ex. Sonoff Basic R4 avec Magic Switch) ;
# 5) MQTT, noms, heure, position (un seul envoi, un seul redémarrage) ; 6) relecture et vérification
# (nom non tronqué, connexion au broker).
#
# Réglages TOUJOURS appliqués (installation standard, voir TODO « TASMOTA ») : broker MQTT, Topic et
# FullTopic `%prefix%/<site>/%topic%/`, DeviceName selon la convention QUOI---LIEU, découverte Tasmota
# native (SetOption19 0), heure de France (été/hiver), latitude/longitude. JAMAIS SetOption30 ni
# FriendlyName : c'est nommage qui les fixe dans la découverte réécrite.
#
# @outils:hint IP = Adresse IP de l'appareil Tasmota (déjà connecté au Wi-Fi), ex. 192.168.1.60.
# @outils:hint DEVICENAME = Nom selon la convention de nommage, ex. « lumière---plan de travail--cuisine d'été--rez de chaussée ».
# @outils:hint TOPIC = Nom court de l'appareil dans les topics MQTT : minuscules, chiffres, « _ », sans accents ni espaces (ex. plan_travail_cuisine_ete).
# @outils:select SITE = cuisine_ete, garage, maison, exterieur
# @outils:hint SITE = Site de l'appareil — mis dans les topics (FullTopic %prefix%/<site>/%topic%/) : le pont Mosquitto du garage filtre sur « garage ».
# @outils:default MQTT_HOST = 192.168.1.51
# @outils:hint MQTT_HOST = Broker MQTT : ha2 (192.168.1.51) pour la maison et la cuisine d'été ; le Pi du garage pour le garage.
# @outils:select MODELE = Sonoff Basic R4 (Magic Switch), ne pas changer
# @outils:hint MODELE = « Sonoff Basic R4 (Magic Switch) » applique le modèle officiel avec GPIO5 = MagicSwitch (commande par l'interrupteur mural). « ne pas changer » garde le modèle actuel.
# @outils:select MAGIC_PULSE = 4000 (standard Tasmota), 8000, 15000, 30000, ne pas changer
# @outils:default MAGIC_PULSE = 4000 (standard Tasmota)
# @outils:hint MAGIC_PULSE = Sensibilité du Magic Switch (MagicSwitchPulse, en µs) : durée minimale de coupure comptée comme un appui sur l'interrupteur mural. 4000 = valeur standard de Tasmota (aucune autre valeur conseillée trouvée). Augmenter si le relais « rebondit » après une commande à distance, puis vérifier que l'interrupteur mural fonctionne toujours.
# @outils:checklist OTA = mise à jour
# @outils:hint OTA = Coché = mise à jour de Tasmota (OTA, serveur officiel) avant la configuration. Le Magic Switch demande Tasmota 13.3 ou plus récent.
# @outils:default LATITUDE = 45.4609
# @outils:default LONGITUDE = -0.718
# @outils:hint LATITUDE = Pour les minuteries au lever/coucher du soleil — défaut : Saint Fort (domo.properties de stfort : gps=45.460850,-0.71798 ; longitude négative = ouest).

set -euo pipefail

IP="__IP__"
DEVICENAME="__DEVICENAME__"
TOPIC="__TOPIC__"
SITE="__SITE__"
MQTT_HOST="__MQTT_HOST__"
MODELE="__MODELE__"
OTA="__OTA__"
LATITUDE="__LATITUDE__"
LONGITUDE="__LONGITUDE__"
MAGIC_PULSE="__MAGIC_PULSE__"

HA2_BROKER="192.168.1.51"
TEMPLATE_R4='{"NAME":"Sonoff Basic R4","GPIO":[0,0,0,0,224,10560,544,0,0,32,0,0,0,0,0,0,0,0,0,0,0,0],"FLAG":0,"BASE":1}'

for c in curl jq mosquitto_pub mosquitto_sub; do
  command -v "$c" >/dev/null 2>&1 || { echo "Prérequis manquant sur CETTE machine : $c — sudo apt install -y curl jq mosquitto-clients" >&2; exit 1; }
done
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "ERREUR : adresse IP invalide « $IP »." >&2; exit 1; }
[[ "$TOPIC" =~ ^[a-z0-9_]+$ ]] || { echo "ERREUR : TOPIC « $TOPIC » : minuscules, chiffres et « _ » seulement." >&2; exit 1; }
[[ "$SITE" =~ ^[a-z0-9_]+$ ]] || { echo "ERREUR : SITE « $SITE » : minuscules, chiffres et « _ » seulement." >&2; exit 1; }
[[ "$DEVICENAME" == *"---"* ]] || { echo "ERREUR : DEVICENAME doit suivre la convention QUOI---LIEU (contient « --- »)." >&2; exit 1; }
[ -n "$MQTT_HOST" ] || { echo "ERREUR : MQTT_HOST est obligatoire." >&2; exit 1; }
# Valeur choisie dans la liste : le nombre en tête (« 4000 (standard Tasmota) » → 4000), ou rien.
MAGIC_PULSE="$(grep -oE '^[0-9]+' <<<"$MAGIC_PULSE" || true)"

# --------------------------------------------------------------------------------------------------
# Transport : MQTT (BROKER + CMND_BASE + STAT_BASE) ou web (MODE=http)
# --------------------------------------------------------------------------------------------------
MODE=""; BROKER=""; CMND_BASE=""; STAT_BASE=""

# Topic de commande/réponse d'après FullTopic + Topic (ex. %prefix%/cuisine_ete/%topic%/).
bases_depuis() {
  local ft="$1" t="$2" b
  b="${ft//%topic%/$t}"; b="${b%/}"
  CMND_BASE="${b//%prefix%/cmnd}"
  STAT_BASE="${b//%prefix%/stat}"
}

# Retrouve l'appareil par son IP dans les découvertes retenues d'un broker.
trouver_mqtt() {
  local broker="$1" d
  d="$(timeout 6 mosquitto_sub -h "$broker" -t 'tasmota/discovery/+/config' -W 4 2>/dev/null \
      | jq -c --arg ip "$IP" 'select(.ip == $ip)' 2>/dev/null | tail -1)" || true
  [ -n "$d" ] || return 1
  MODE=mqtt; BROKER="$broker"
  bases_depuis "$(jq -r '.ft' <<<"$d")" "$(jq -r '.t' <<<"$d")"
}

# Envoie une commande et affiche la réponse JSON. En MQTT, la réponse arrive sur RESULT, ou STATUS<n>
# pour « Status <n> ».
cmnd() {
  local cmd="${1%% *}" arg="" rep="RESULT"
  [[ "$1" == *" "* ]] && arg="${1#* }"
  if [ "$MODE" = http ]; then
    curl -fsS --max-time 15 -G "http://${IP}/cm" --data-urlencode "cmnd=$1"
    return
  fi
  if [[ "$cmd" =~ ^[Ss]tatus$ ]]; then rep="STATUS${arg}"; [ "$arg" = 0 ] && rep="STATUS"; fi
  local tmp; tmp="$(mktemp)"
  mosquitto_sub -h "$BROKER" -t "${STAT_BASE}/${rep}" -C 1 -W 8 > "$tmp" 2>/dev/null &
  local sub=$!
  sleep 0.5
  mosquitto_pub -h "$BROKER" -t "${CMND_BASE}/${cmd}" -m "$arg"
  wait "$sub" 2>/dev/null || true
  cat "$tmp"; rm -f "$tmp"
}

repond() { [ -n "$(cmnd "Status" 2>/dev/null)" ]; }

attendre() {
  local max="${1:-90}" i=0
  sleep 8
  until repond; do
    i=$((i + 5)); [ "$i" -ge "$max" ] && { echo "ERREUR : l'appareil ne répond plus après ${max} s." >&2; exit 1; }
    sleep 5
  done
}

etat() {
  local s s2 s5 s6
  s="$(cmnd "Status")"; s2="$(cmnd "Status 2")"; s5="$(cmnd "Status 5")"; s6="$(cmnd "Status 6")"
  echo "  Version    : $(jq -r '.StatusFWR.Version' <<<"$s2")"
  echo "  Modèle     : $(jq -r '.Status.Module' <<<"$s") ($(cmnd "Template" | jq -r '.NAME // "?"'))"
  echo "  DeviceName : $(jq -r '.Status.DeviceName' <<<"$s")"
  echo "  Topic      : $(jq -r '.Status.Topic' <<<"$s")   FullTopic : $(cmnd "FullTopic" | jq -r '.FullTopic')"
  echo "  MQTT       : $(jq -r '.StatusMQT.MqttHost' <<<"$s6"):$(jq -r '.StatusMQT.MqttPort' <<<"$s6") (connexions : $(jq -r '.StatusMQT.MqttCount' <<<"$s6"))"
  echo "  Hostname   : $(jq -r '.StatusNET.Hostname' <<<"$s5")"
  echo "  MagicSwitch: $(cmnd "MagicSwitchPulse" | jq -r '.MagicSwitchPulse // "absent"') µs"
}

echo "=== 1. Recherche de ${IP} ==="
if trouver_mqtt "$MQTT_HOST" || { [ "$MQTT_HOST" != "$HA2_BROKER" ] && trouver_mqtt "$HA2_BROKER"; }; then
  echo "  Trouvé par MQTT sur ${BROKER} (commandes : ${CMND_BASE}/…)"
elif curl -fsS --max-time 8 -G "http://${IP}/cm" --data-urlencode "cmnd=Status" >/dev/null 2>&1; then
  MODE=http; echo "  Pas sur MQTT : configuration par l'interface web."
else
  echo "ERREUR : ${IP} introuvable — ni sa découverte sur ${MQTT_HOST}/${HA2_BROKER}, ni son interface web (mot de passe web ?)." >&2
  exit 1
fi
repond || { echo "ERREUR : l'appareil ne répond pas aux commandes." >&2; exit 1; }
echo; echo "=== État actuel ==="
etat

FULLTOPIC="%prefix%/${SITE}/%topic%/"
HOSTNAME_VALUE="$(tr '_' '-' <<<"$TOPIC" | cut -c1-32)"
echo
echo "=== 2. Réglages qui vont être appliqués ==="
[ -n "$OTA" ] && echo "  Mise à jour OTA de Tasmota (serveur officiel)"
[ "$MODELE" = "Sonoff Basic R4 (Magic Switch)" ] && echo "  Modèle     : Sonoff Basic R4, GPIO5 = MagicSwitch"
echo "  MQTT       : ${MQTT_HOST}:1883"
echo "  Topic      : ${TOPIC}   FullTopic : ${FULLTOPIC}"
echo "  DeviceName : ${DEVICENAME}"
echo "  Hostname   : ${HOSTNAME_VALUE}"
[ -n "$MAGIC_PULSE" ] && echo "  MagicSwitchPulse : ${MAGIC_PULSE} µs"
echo "  Découverte Tasmota native (SetOption19 0), heure de France, position ${LATITUDE}/${LONGITUDE}"
read -rp "Appliquer ? [o/N] " OK
[ "$OK" = "o" ] || [ "$OK" = "O" ] || { echo "Abandon — rien n'a été modifié."; exit 0; }

if [ -n "$OTA" ]; then
  echo; echo "=== 3. Mise à jour OTA (1 à 3 minutes) ==="
  AVANT="$(cmnd "Status 2" | jq -r '.StatusFWR.Version')"
  cmnd "Upgrade 1" >/dev/null || true
  attendre 300
  echo "  Version : ${AVANT} → $(cmnd "Status 2" | jq -r '.StatusFWR.Version')"
fi

if [ "$MODELE" = "Sonoff Basic R4 (Magic Switch)" ]; then
  echo; echo "=== 4. Modèle Sonoff Basic R4 avec Magic Switch (redémarrage) ==="
  cmnd "Backlog Template ${TEMPLATE_R4}; Module 0" >/dev/null || true
  attendre 90
fi

echo; echo "=== 5. MQTT, noms, heure, position (redémarrage) ==="
MAGIC_CMD=""; [ -n "$MAGIC_PULSE" ] && MAGIC_CMD="MagicSwitchPulse ${MAGIC_PULSE}; "
cmnd "Backlog ${MAGIC_CMD}SetOption19 0; Timezone 99; TimeDST 0,0,3,1,2,120; TimeSTD 0,0,10,1,3,60; Latitude ${LATITUDE}; Longitude ${LONGITUDE}; DeviceName ${DEVICENAME}; Hostname ${HOSTNAME_VALUE}; MqttHost ${MQTT_HOST}; MqttPort 1883; FullTopic ${FULLTOPIC}; Topic ${TOPIC}" >/dev/null || true
# Nouvelles adresses : le nouveau topic, et éventuellement un autre broker.
if [ "$MODE" = mqtt ]; then BROKER="$MQTT_HOST"; bases_depuis "$FULLTOPIC" "$TOPIC"; fi
attendre 120

echo; echo "=== 6. Vérification ==="
etat
LU="$(cmnd "DeviceName" | jq -r '.DeviceName')"
if [ "$LU" = "$DEVICENAME" ]; then
  echo "  ✅ DeviceName complet (${#DEVICENAME} caractères)."
else
  echo "  ⚠️  DeviceName TRONQUÉ ou modifié : « ${LU} » (${#LU}/${#DEVICENAME} caractères) — raccourcir le nom (ex. sans l'étage)."
fi
[ "$(cmnd "Status 6" | jq -r '.StatusMQT.MqttCount')" -ge 1 ] 2>/dev/null \
  && echo "  ✅ Connecté au broker MQTT ${MQTT_HOST}." \
  || echo "  ⚠️  Pas (encore) connecté au broker ${MQTT_HOST} — vérifier l'adresse et le port."
echo
echo "Terminé. La découverte part sous tasmota/discovery/… ; nommage la republie pour HA (préfixe tasmota-ha/discovery)."
