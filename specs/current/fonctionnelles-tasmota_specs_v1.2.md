# Spécifications — Application TASMOTA

**Version :** 1.2
**Date :** 29 Septembre 2026 (v1.2 : liste stockée, modèle et contenu du modèle, recherche unique des Tasmota inconnus)
**Version précédente :** 1.1 — 28 Septembre 2026
**Statut :** Première version — conception décidée avec l'utilisateur le 28/09/2026 (voir `TODO.md`,
section TASMOTA), essais réels préalables sur un Sonoff Basic R4 (Tasmota 15.6.0, ESP32-C3).
**Remplace :** le script Outils « Configurer un appareil Tasmota (à distance) »
(`fonctionnelles-outils_specs_v1.3.md` §7.3), provisoire jusqu'à la livraison de cette application.

---

## 📚 Table des Matières

1. [Présentation](#1-présentation)
2. [Décisions de conception](#2-décisions-de-conception)
3. [Liste des appareils](#3-liste-des-appareils)
4. [Nommage et publication vers Home Assistant](#4-nommage-et-publication-vers-home-assistant)
5. [Fiche appareil — réglages réinjectés](#5-fiche-appareil--réglages-réinjectés)
6. [Mise en service d'un Tasmota neuf](#6-mise-en-service-dun-tasmota-neuf)
7. [Règles et modes](#7-règles-et-modes)
8. [Dialogue avec ia](#8-dialogue-avec-ia)
9. [Configuration et données](#9-configuration-et-données)
10. [Déclaration du module et événements](#10-déclaration-du-module-et-événements)
11. [Limites connues et évolutions](#11-limites-connues-et-évolutions)
12. [Historique](#12-historique)

---

## 1. Présentation

TASMOTA gère la flotte d'appareils Tasmota (relais Wi-Fi, volets, capteurs) du site, **depuis
l'interface dimotic-ha**, sans passer par l'interface web de chaque appareil :

- **liste tenue à jour** automatiquement (découverte native Tasmota + disponibilité) ; les appareils
  dont le nom ne suit pas la convention sont **signalés « à nommer »** ;
- **nommage** selon la convention QUOI---LIEU (`nommage_specs_v1.0.md`), **fait par l'application
  elle-même** (pas par l'application NOMMAGE) ;
- **publication vers Home Assistant** en découverte MQTT HA standard, **comme RFXCOM** ;
- **fiche appareil** à libellés clairs, chaque réglage modifié est **réinjecté dans l'appareil** par
  MQTT puis relu ;
- **mise en service d'un Tasmota neuf** (Wi-Fi + MQTT) par HTTP, depuis la machine par laquelle on
  accède à l'application ;
- **règles** préétablies (minuterie, thermostat, programmation horaire, masquage anti-rebond),
  paramétrables, activables, dépendant de **modes** (présence, absence, confort…) pilotables depuis HA.

Public : l'utilisateur de la domotique (page « Tasmota », menu Applications).

## 2. Décisions de conception

| # | Décision (28/09/2026) |
|---|---|
| D1 | **Intégration identique à RFXCOM** : l'application publie elle-même des découvertes HA standard (`homeassistant/<composant>/…/config`). L'intégration Tasmota de HA **n'est pas utilisée** (retirée de ha2 le 28/09/2026). |
| D2 | Le **nommage** des Tasmota est fait par l'application (mêmes règles que NOMMAGE, intervention différente). Parseur QUOI---LIEU et `buildDisplayName` **recopiés** de RFXCOM (`taxonomy.ts`), pas factorisés dans le core pour l'instant. |
| D3 | Tout passe par la **connexion MQTT du core** (bridge passthrough, broker de HA) — pas de client MQTT propre. |
| D4 | **Tout se lance depuis l'application** (mise en service d'un neuf comprise) — plus depuis Outils. |
| D5 | Mise en service d'un neuf **sur la machine par laquelle on accède** : Ethernet = domotique, Wi-Fi basculé sur le point d'accès du Tasmota puis **remis dans son état d'origine** (succès, échec ou abandon). Machine sans NetworkManager (ex. stfort, Raspbian buster) : **rien de prévu**, action indisponible avec la raison. |
| D6 | **Mot de passe Wi-Fi en clair** dans la configuration de l'application, saisi en clair à l'écran (pour l'instant). |
| D7 | ⭐ v1.1 — Partage entre machines par la **diffusion des fichiers de `data/`, mécanisme du core NON ENCORE SPÉCIFIÉ NI IMPLÉMENTÉ** (conception du 06/09/2026 à reprendre). Règle de nommage décidée le 28/09/2026 : un fichier dont le nom commence par **`machine_`** n'est **jamais reproduit** ; **tous les autres** fichiers de `data/` le sont. Cette application n'a aucun fichier `machine_` : `config.yaml` et `rules.yaml` seront reproduits. D'ici là, seuls la liste des appareils, leur publication HA et le mode courant sont partagés (messages retenus sur le broker). |
| D8 | Règles stockées **selon le standard Tasmota** (`Rule1`…`Rule3`, 511 caractères chacune) — il y aura des **ESP8266** : pas de Berry comme base. |
| D9 | L'application **ne gère pas les automatismes zigbee2mqtt**. |
| D10 | **Modes** déclenchables depuis HA : l'état du mode **remonte dans HA** (entité `select`). |
| D11 | **ia** définit des règles par **messages avec réponse** : acceptée / refusée + raison. |
| D12 | **Capteurs** publiés vers HA, entités **déduites d'elles-mêmes** de la découverte native. |
| D13 | **Volets** : paramétrage (mode volet, temps de course, sens) dans l'application. |
| D14 | `DeviceName` : **60 caractères** maximum. |
| D15 | Masquage anti-rebond Magic Switch : **paramètre de l'appareil** dans l'application (règle préétablie « masquage »), sauf reflashage d'un firmware à fenêtre plus longue. |

## 3. Liste des appareils

### 3.1 Sources

Chaque Tasmota publie (retenu, préfixe **codé en dur**, indépendant du `FullTopic`) :
- `tasmota/discovery/<MAC>/config` — identité et topics : `ip`, `dn` (DeviceName), `fn` (FriendlyName
  par relais), `hn`, `mac`, `md` (modèle), `sw` (version), `t` (Topic), `ft` (FullTopic), `tp`
  (préfixes `cmnd`/`stat`/`tele`), **`rl`** (type de chaque relais : 0 aucun, 1 relais, 2 lumière,
  **3 volet** — constantes `RL_*` de `hatasmota`), `sho`/`sht` (options/inclinaison des volets), `so`
  (quelques SetOption) ;
- `tasmota/discovery/<MAC>/sensors` — `sn` : dernier relevé des capteurs (même forme que
  `tele/…/SENSOR`).

**Préalable côté Tasmota** : `SetOption19 0` (découverte native, valeur par défaut).

### 3.2 Topics d'un appareil

Préfixe d'un appareil = `ft` où `%prefix%` ← `tp[0|1|2]`, `%topic%` ← `t`, `%hostname%` ← `hn`,
`%id%` ← MAC. Ex. `ft = %prefix%/cuisine_ete/%topic%/`, `t = essai_r4` →
`cmnd/cuisine_ete/essai_r4/`, `stat/cuisine_ete/essai_r4/`, `tele/cuisine_ete/essai_r4/`.

Disponibilité : `tele/…/LWT` (`Online`/`Offline`, retenu).

### 3.3 Contenu de la liste

Pour chaque MAC : nom (`dn`), QUOI et lieux décodés, IP, modèle, version, en ligne/hors ligne,
relais / volets / capteurs détectés, état de publication vers HA.

**« À nommer »** : `dn` ne suit pas la convention (pas de `---`, ou QUOI ou lieu vide) — typiquement
`Tasmota` après une remise d'usine. Un appareil à nommer **n'est pas publié vers HA** (voulu : un
appareil n'apparaît dans HA qu'une fois nommé).

### 3.4 Liste stockée — `data/tasmota/devices.yaml` (v1.2)

Le broker repart **vide** à chaque redémarrage (persistance désactivée, voulu) : un Tasmota débranché ne
se réannonce pas et disparaissait de la liste et de HA. La liste est donc **stockée** par MAC :
annonce (`cfg`), capteurs (`sn`), date de dernière annonce, **modèle** (commande `Module`, ex.
« Sonoff Basic R4 », « Generic »), **puce** (`Status 2` → `StatusFWR.Hardware`), **contenu du modèle**
(`Gpio 255` : broches utilisées et leur rôle, dans la langue du firmware — `Gpio` seul répond « Not
supported » pour un modèle figé) et firmware au moment de la lecture.

- Relue au démarrage ; un appareil débranché reste affiché (sans point vert, date de dernière annonce).
- À chaque connexion au broker, les entités HA de **tous** les appareils connus sont republiées.
- Modèle lu par MQTT quand l'appareil s'annonce ou revient en ligne, si l'information manque ou si le
  firmware a changé ; complété aussi par la recherche réseau (§6bis).
- Pas de préfixe `machine_` : reproduite sur toutes les machines par la diffusion ; reçue d'une autre
  machine, elle est fusionnée (un appareil oublié là-bas est retiré ici, sauf s'il est en ligne).

**Oublier un appareil** (retiré du parc) : efface les découvertes retenues (native et HA) et ses
attributs. S'il est encore en service, il réapparaît à son prochain redémarrage.

## 4. Nommage et publication vers Home Assistant

### 4.1 Nom

`DeviceName` = `QUOI---lieu précis--lieu--lieu père--lieu grand-père` (`nommage_specs_v1.0.md`),
60 caractères au plus (D14). Saisie **en morceaux** dans la fiche (§5), listes de choix :
- QUOI : les QUOI déjà utilisés dans HA (`attributs_taxonomie.quoi` des entités du référentiel,
  via `HaBridgeClient`) ;
- lieux : `getLieuCatalog()` (pièces, étages… connus du référentiel).

Décodage : `extractTaxonomy()` recopié de RFXCOM (lieu précis égal au lieu → vidé).
Nom affiché dans HA : `buildDisplayName()` (lieu précis capitalisé, sinon le QUOI).

### 4.2 Entités publiées

Découverte HA standard, publiée par le passthrough « découverte » du core (`integration:tasmota:
passthrough:discovery`, topic source `tasmota/<composant>/tasmota_<MAC>/<objet>/config`, premier
segment réécrit en `homeassistant` ; la pièce suggérée est créée si besoin par le core,
comme pour RFXCOM).

| Détecté | Composant | Commande / état |
|---|---|---|
| relais `rl[i]` = 1 ou 2 | `light` si `rl[i]` = 2 **ou** QUOI = lumière, sinon `switch` | `cmnd/…/POWER<n>` ; état `stat/…/POWER<n>` (`POWER` seul pour un appareil à un relais) |
| paire `rl[i]` = `rl[i+1]` = 3 | `cover` (`device_class: shutter`) | `cmnd/…/Backlog` avec `ShutterOpen<k>` / `ShutterClose<k>` / `ShutterStop<k>`, position `cmnd/…/ShutterPosition<k>` ; position lue par l'application dans `Shutter<k>.Position` (`stat/…/RESULT`, `tele/…/SENSOR`) et republiée, retenue, sur `dimotic/tasmota/<MAC>/volet<k>` |
| valeur numérique de `sn.<capteur>.<mesure>` | `sensor` | `tele/…/SENSOR`, `value_template` sur le chemin ; unité / `device_class` / `state_class` déduits du nom de la mesure (Temperature, Humidity, Pressure, Illuminance, DewPoint, Power, ApparentPower, ReactivePower, Voltage, Current, Factor, Total, Today, Yesterday) |

Communs à toutes les entités :
- `availability_topic` = `tele/…/LWT` ;
- `json_attributes_topic` = `dimotic/tasmota/<MAC>/attributs` (retenu) ← `{attributs_taxonomie: {…}}`
  (même forme que RFXCOM/NOMMAGE → classement par `TaxonomyHaClassifier`) ;
- `device` : `identifiers: [tasmota_<MAC>]`, `connections: [[mac, …]]`, `name` = nom affiché,
  `suggested_area` = lieu (appliqué **une seule fois** par HA, à la création : un changement manuel
  de pièce dans HA est respecté), `manufacturer: Tasmota`, `model`, `sw_version`,
  `configuration_url: http://<ip>/` ;
- nom d'entité : `null` pour le premier relais (l'entité prend le nom de l'appareil, comme RFXCOM),
  `fn[i]` (ou « Relais n ») pour les suivants, libellé français de la mesure pour les capteurs.

Changement de composant (`switch` ↔ `light`, QUOI modifié) : la découverte de l'autre composant est
effacée (retenu vide). État initial : après publication, l'application interroge `POWER<n>` pour que
HA ait un état tout de suite ; même chose quand HA annonce `homeassistant/status = online`.

## 5. Fiche appareil — réglages réinjectés

Ouverture de la fiche → **relecture** de l'appareil par MQTT (`Status 0`, `Template`,
`MagicSwitchPulse`, `Rule1..3`, `ShutterRelay1`, temps de course…). Bouton **Appliquer** → un
`Backlog` (ou quelques commandes successives), puis **relecture et comparaison** ; le compte rendu
affiche chaque étape et la réponse de l'appareil.

| Section | Réglages (libellés clairs) | Commandes Tasmota |
|---|---|---|
| Nom | QUOI, lieu précis, lieu, lieu père, lieu grand-père | `DeviceName`, `FriendlyName1` (= même nom) |
| Réseau / MQTT | Site (liste de la configuration), nom technique (`Topic`, sans accents, ≤ 32, proposé d'après le nom), broker | `Topic`, `FullTopic %prefix%/<site>/%topic%/`, `Hostname`, `MqttHost`, `MqttPort` |
| Modèle | « ne pas changer » / « Sonoff Basic R4 (Magic Switch) » | `Template {…GPIO5 = 10560…}` + `Module 0` |
| Magic Switch | Sensibilité (µs, 4000 = standard) | `MagicSwitchPulse` |
| Volet | Mode volet (oui/non), durée d'ouverture, durée de fermeture (s), sens inversé | `Interlock 1,2` + `Interlock 1`, `ShutterRelay1 1`, `ShutterOpenDuration1`, `ShutterCloseDuration1`, `ShutterInvert1` (redémarrage) |
| Lieu | (automatique) | `Latitude`, `Longitude`, fuseau Europe/Paris (`Timezone 99`, `TimeDST`/`TimeSTD`) |

Actions : **Identifier** (le relais clignote 3 fois — `BlinkCount 3`, `BlinkTime 5`, `Power1 Blink` ;
refusé sur un volet), **Relire**, **Mettre à jour** (OTA, `Upgrade 1` sur l'`OtaUrl` de l'appareil),
**Remise d'usine** (`Reset 1`, confirmation ; l'appareil redevient « neuf », §6), **Oublier** (§3.3).

## 6. Mise en service d'un Tasmota neuf

Validé en réel le 28/09/2026 (falbala, conteneur Docker compris).

1. **Conditions**, vérifiées et affichées : `nmcli` disponible et NetworkManager joignable (D-Bus),
   une interface Ethernet **connectée**, une interface Wi-Fi gérée. Sinon : action indisponible,
   raison affichée.
2. **Recherche** : scan Wi-Fi, points d'accès `tasmota-*` listés.
3. **Mise en service** du point d'accès choisi :
   1. état d'origine du Wi-Fi relevé (connexion active, ou « déconnecté ») ;
   2. connexion temporaire `dimotic-tasmota-neuf` (sans mot de passe, `autoconnect no`,
      `ipv4.never-default yes` — la route par défaut reste sur l'Ethernet) ;
   3. lecture `http://192.168.4.1/cm?cmnd=Status 0` (contrôle : appareil sorti d'usine) ;
   4. envoi `Backlog SSID1 <ssid>; Password1 <mot de passe>; MqttHost <hôte>; MqttPort <port>` —
      **rien d'autre** ; mot de passe masqué dans tout affichage et journal ;
   5. **restauration dans tous les cas** : suppression de la connexion temporaire, puis
      reconnexion de la connexion d'origine, ou `nmcli device disconnect` si le Wi-Fi était
      déconnecté (sinon NetworkManager reconnecte seul un profil existant — constaté) ;
   6. attente de l'appareil sur le broker (`tasmota/discovery/<MAC>/config`), jusqu'à 90 s.
4. L'appareil apparaît ensuite dans la liste, **à nommer** (§3.3).

Limites constatées : en mode `WifiConfig 2` (gestionnaire Wi-Fi), Tasmota refuse `/cm` → la mise en
service ne vaut que pour un appareil **sorti d'usine** (ou remis d'usine). Docker : `nmcli` dans
l'image, `network_mode: host`, volume `/run/dbus/system_bus_socket`, `privileged` (ou
`apparmor=unconfined`) — en place depuis le 28/09/2026 (Dockerfile, compose).

## 6bis. Recherche des Tasmota inconnus (v1.2)

Un seul bouton, deux sortes de résultats :
- **neufs** : points d'accès Wi-Fi `tasmota-…` à portée de la machine (§6, si nmcli le permet) ;
- **déjà sur le réseau mais hors de notre broker** (aucun, un autre, une ancienne machine) : requête
  `Status 0` à chaque adresse du `/24` de l'adresse principale de la machine, puis `Module` et
  `Gpio 255` pour ceux trouvés. **En-tête `Referer` obligatoire** sur `/cm` (Tasmota récents, sinon
  connexion fermée sans réponse). Écarté seulement s'il est connu **et** pointe vers notre broker ; un
  appareil connu qui pointe ailleurs porte « déjà dans la liste ». Action : « Pointer vers notre
  broker » (`Backlog MqttHost …; MqttPort …` en HTTP). Limites : un seul sous-réseau, un Tasmota
  protégé par mot de passe web n'est pas trouvé.

## 7. Règles et modes

### 7.1 Règles préétablies

Une règle = un **modèle** du catalogue + ses **paramètres**, placée dans un emplacement `Rule<k>`
(k = 1..3) d'un appareil, **activée ou non**, **active dans certains modes** (liste vide = tous).

| Modèle | Paramètres | Texte généré (k = emplacement) |
|---|---|---|
| Minuterie | relais, durée (s) | `ON Power<r>#State=1 DO RuleTimer<k> <d> ENDON ON Power<r>#State=0 DO RuleTimer<k> 0 ENDON ON Rules#Timer=<k> DO Power<r> 0 ENDON` |
| Thermostat | relais, capteur (ex. `DS18B20#Temperature`), consigne, hystérésis | `ON <capteur><<bas> DO Power<r> 1 ENDON ON <capteur>><haut> DO Power<r> 0 ENDON` (bas/haut = consigne ∓ hystérésis/2) |
| Programmation horaire | relais, heure (HH:MM), action (allumer/éteindre) | `ON Time#Minute=<minutes depuis minuit> DO Power<r> <1\|0> ENDON` |
| Masquage anti-rebond (Magic Switch) | durée (s) | `ON Power1#State DO Backlog Var<k> 1; RuleTimer<k> <d> ENDON ON Rules#Timer=<k> DO Var<k> 0 ENDON ON Switch1#State DO IF (Var<k>==0) Power1 TOGGLE ENDIF ENDON` — validé en réel (0 rebond sur 20 à 2 s) ; `IF` exige un firmware ESP32 ou compilé avec les expressions |

Écriture : `Rule<k> <texte>` puis `Rule<k> 1|0`, relecture `Rule<k>` et comparaison. Texte > 511
caractères ou emplacement déjà pris : refusé avec la raison.

### 7.2 Modes

- Liste des modes dans la configuration (défaut : `présence`, `absence`, `confort`, `éco`), mode
  courant **partagé** : retenu sur `dimotic/tasmota/mode`.
- **Entité HA `select`** « Mode » (`homeassistant/select/dimotic_tasmota/mode/config`,
  commande `dimotic/tasmota/mode/set`) : changer le mode dans HA (ou dans l'application) →
  l'application publie le nouveau mode (retenu) puis **active / désactive** (`Rule<k> 1|0`) les règles
  de chaque appareil selon leurs modes.
- Un appareil qui revient en ligne est remis en conformité avec le mode courant.

## 8. Dialogue avec ia

Requêtes corrélées (`CorrelatedRequester`, guide §3.2bis) ; l'application répond :

- `tasmota:catalog:get` → `tasmota:catalog:get:reply` `{correlation_id, templates, devices, modes,
  currentMode}` (appareils : MAC, nom, relais, capteurs, emplacements libres) ;
- `tasmota:rule:define` `{correlation_id, device (MAC ou nom), template, params, slot?, modes?,
  enabled?}` → `tasmota:rule:define:reply` `{correlation_id, accepted, reason?, slot?}` — refusée si
  appareil inconnu / hors ligne, modèle inconnu, paramètre invalide, plus d'emplacement libre, texte
  trop long, ou relecture non conforme ;
- `tasmota:mode:set` `{correlation_id, mode}` → `tasmota:mode:set:reply` `{correlation_id, accepted,
  reason?}`.

Côté ia : outils à ajouter (évolution d'ia, hors de cette version).

## 9. Configuration et données

`data/tasmota/config.yaml` (section `tasmota`) :

| Clé | Défaut | Rôle |
|---|---|---|
| `wifi.ssid` / `wifi.password` | `zdid2` / vide | Wi-Fi donné aux neufs (D6 : en clair) |
| `mqtt.host` / `mqtt.port` | `192.168.1.51` / `1883` | broker donné aux neufs et dans la fiche |
| `sites` | `maison`, `cuisine_ete`, `garage`, `exterieur` | sites proposés (`FullTopic`) |
| `latitude` / `longitude` | `45.4609` / `-0.718` | réglés dans chaque appareil |
| `modes` | `présence`, `absence`, `confort`, `éco` | modes proposés |
| `publishToHa` | `true` | publication des découvertes HA |

`data/tasmota/rules.yaml` : règles par MAC (`slot`, `template`, `params`, `modes`, `enabled`).
Aucun fichier `machine_` : les deux fichiers seront reproduits sur toutes les machines quand la diffusion du
core existera (D7) ; **en attendant ils restent locaux** — une règle définie depuis une machine n'est connue
(pour l'application des modes) que de cette machine. La liste des appareils est stockée dans
`data/tasmota/devices.yaml` (§3.4, v1.2) ; le mode courant est retenu sur le broker.

## 10. Déclaration du module et événements

`TASMOTA_APP` : `type: 'integration'`, `audience: 'end-user'`, `requiredMqtt: true`,
`requiredHaWs: false` (le référentiel HA sert aux listes de choix, via `HaBridgeClient`, facultatif),
`runsAsSeparateProcess: true`, menu « Tasmota » (🔌), désactivée à l'arrivée (règle générale).
`bridgedEvents` : `tasmota:catalog:get`, `tasmota:rule:define`, `tasmota:mode:set`.

Socket.io (préfixe `tasmota:`) : `state` (persistant : appareils, modes, config sans mot de passe
masqué), `device:read`/`device:details`, `device:apply`, `device:action`, `device:forget`,
`rules:save`, `mode:set`, `config:save`, `provision:check`/`provision:scan`/`provision:start`,
`log` (compte rendu pas à pas).

## 11. Limites connues et évolutions

- Plusieurs instances actives publient les mêmes découvertes et appliquent les mêmes modes : sans
  conséquence (messages identiques, commandes idempotentes).
- Capteurs multivoies (valeurs en tableau) non publiés.
- Machine du garage (GARAGE3) : à construire après cette application ; un neuf « derrière le
  garage » se met en service depuis cette machine.
- Évolutions : outils d'ia (§8), variantes de règles, factorisation du parseur dans le core.

## 12. Historique

| Version | Date | Auteur | Modifications |
|---|---|---|---|
| 1.2 | 29/09/2026 | Claude | Liste stockée (`devices.yaml`, §3.4) : le broker repart vide à chaque redémarrage ; entités HA republiées à chaque connexion ; modèle, puce et contenu du modèle (`Module`, `Status 2`, `Gpio 255`) lus, stockés, affichés ; recherche unique des Tasmota inconnus (§6bis), en-tête `Referer` sur `/cm`. |
| 1.1 | 28/09/2026 | Claude | D7/§9 corrigés : la diffusion des fichiers de `data/` n'existe pas encore (core) ; règle `machine_` (non reproduit) / autres fichiers reproduits ; config et règles locales en attendant. |
| 1.0 | 28/09/2026 | Claude | Création : liste, nommage + publication HA comme RFXCOM, fiche réinjectée, mise en service d'un neuf (nmcli), règles préétablies + modes (select HA), dialogue ia. |
