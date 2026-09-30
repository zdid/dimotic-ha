# Spécifications — Application TASMOTA

**Version :** 1.4
**Date :** 30 Septembre 2026 (v1.4 : **thermostat** — relais + thermomètre, consigne réglable par mode ; moteur Berry sur ESP32, règles sur ESP8266 — **réalisé** : moteur Berry validé en réel sur le R4, moteur à règles écrit mais non essayé en réel)
**Version précédente :** 1.3 — 30 Septembre 2026 (voies)
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

### 4.1bis Voies : une voie = un appareil Home Assistant (v1.3)

**Problème** : un module Tasmota porte souvent des objets sans rapport (un thermomètre du garage et un
autre de la cave, deux lampes de deux endroits, un moteur…). Avec un seul `DeviceName`, tout partageait
la même taxonomie et la même pièce (v1.0–v1.2). Tasmota n'émet qu'**une** découverte par module et n'a
pas de champ de nom par capteur ; `FriendlyName` est limité à 32 caractères (la convention dépasse). La
taxonomie de chaque voie est donc **tenue par l'application**.

**Voie** = un relais (`relais<n>`), un volet (`volet<k>`) ou **une mesure d'un capteur**
(`<capteur>_<mesure>`, ex. `si7021_temperature`). Clé stable :
- relais / volet : leur numéro ;
- capteur : `<groupe>_<mesure>` ; quand le module en porte plusieurs de même type (`DS18B20-1`,
  `DS18B20-2`, dont le rang peut changer quand on en ajoute un), la clé utilise l'**identifiant matériel**
  (`Id` du capteur) : `ds18b20_<id>_temperature`.

**Stockage** : `voies` par MAC dans `data/tasmota/devices.yaml` (§3.4, donc diffusé) :
`{ <clé de voie>: { nom, deviceClass?, unit? } }` — `nom` = nom au format `QUOI---lieu précis--lieu--père--
grand-père` (mêmes règles que §4.1, 60 caractères au plus) ; `deviceClass` / `unit` seulement pour une
mesure **inconnue** (saisis dans la fiche).

**Publication** (par appareil, `buildHaDiscovery`) :
- **Voie nommée** : son **propre appareil HA** — `identifiers: [tasmota_<MAC>_<voie>]`,
  `via_device: tasmota_<MAC>`, `name` = nom affiché de la voie, `suggested_area` = lieu de la voie,
  `json_attributes_topic` **propre à la voie** (`dimotic/tasmota/<MAC>/voie/<voie>/attributs`,
  `attributs_taxonomie` de la voie). L'entité porte le nom de l'appareil (`name: null`). Composant :
  relais → `light` si QUOI = lumière, sinon `switch` (**le QUOI de la voie décide**, même si Tasmota déclare le relais « lumière », `rl` = 2 ; une voie non nommée garde la règle du §4.2) ; volet → `cover` ; mesure → `sensor`.
- **Voie non nommée** : comme en v1.2 (rien à saisir dans le cas courant) — le premier relais / volet prend
  la taxonomie du module, les autres relais (« Relais n ») et les capteurs (« Température DS18B20 ») restent
  des entités de l'appareil du module. Aucune migration forcée : module par module, voie par voie.
- **Module** : reste l'appareil `tasmota_<MAC>` (IP, firmware, modèle). Nom : taxonomie du `DeviceName`
  s'il suit la convention, sinon `Tasmota <topic>` (nom technique). Dès qu'une voie est nommée, une entité
  **diagnostic** « Connexion » (`binary_sensor`, `device_class: connectivity`, `tele/…/LWT`) est ajoutée à
  l'appareil du module, pour que `via_device` pointe toujours un appareil existant.
- **Module « à nommer »** (`DeviceName` hors convention) : ses voies **nommées** sont publiées quand même
  (sinon rien ne serait publié) ; les voies non nommées ne le sont pas (§3.3, inchangé).
- **Identifiants d'entité inchangés** (`unique_id` `tasmota_<MAC>_relais1`, `…_volet1`, `…_<groupe>_<mesure>`) :
  une entité qui change d'appareil garde son historique. Exception : un capteur passé à la clé par `Id`
  (plusieurs capteurs de même type) change de `unique_id`.

**Type d'un capteur** : imposé par la **mesure** (`MEASURES` : Temperature → température °C, Humidity →
humidité %, DewPoint, Pressure, Illuminance, Power, ApparentPower, ReactivePower, Voltage, Current, Factor,
Total, Today, Yesterday). Mesure inconnue : la fiche demande le type (`deviceClass` parmi une liste) et
l'unité ; sans réponse, publiée sans type comme avant. **QUOI proposé** par mesure (modifiable, listes des
QUOI déjà utilisés dans HA) : Temperature → « température », Humidity → « humidité », DewPoint → « point de
rosée », Pressure → « pression », Illuminance → « luminosité », les mesures électriques → « compteur »
(comme les compteurs existants).

**Fiche** (§5) : nouvelle section **Voies** — une ligne par voie (type, libellé technique, valeur de
saisie QUOI / lieu précis / lieu / père / grand-père, « hérite du module » quand vide) et un bouton
**Enregistrer les voies** (`tasmota:voies:save`) : stockage, republication immédiate, retrait des
découvertes devenues inutiles (topics d'attributs compris).

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
- `json_attributes_topic` = `dimotic/tasmota/<MAC>/attributs` (retenu ; **un topic par voie nommée**, §4.1bis) ← `{attributs_taxonomie: {…}}`
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
**Remise d'usine** (`Reset 1`, confirmation ; l'appareil redevient « neuf », §6 ; ⭐ v1.4 : efface aussi les fichiers déposés, §7bis.6), **Oublier** (§3.3).

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

## 7bis. Thermostat (v1.4)

**Besoin** (30/09/2026) : un module qui porte un relais **et** un thermomètre doit pouvoir servir de
thermostat, avec une **température souhaitée réglable** — depuis HA comme pour les autres thermostats de la
maison (`climate`) — et qui continue de fonctionner si HA, le broker ou le réseau tombent. Le modèle de
règle « Thermostat » de la v1.0 (§7.1) écrivait la consigne **en dur** dans le texte de la règle : il est
remplacé par ce qui suit (les règles déjà écrites restent valables).

### 7bis.1 Décisions (utilisateur, 30/09/2026)

| # | Décision |
|---|---|
| T1 | **Deux moteurs selon la puce** : **Berry** sur ESP32 (script complet), **règles + mémoires** sur ESP8266 (plus limité). L'application choisit d'après le module lu (§3.4 : `Module`, puce, présence de Berry). |
| T2 | La **consigne suit les modes de la maison** (§7.2) : une température par mode (`présence`, `absence`, `confort`, `éco`…) pour chaque thermostat. |
| T3 | **Chauffage seul** (le relais s'allume sous la consigne) ; pas de rafraîchissement. |
| T4 | **Sécurité capteur muet** : sans mesure valide pendant un délai (défaut **30 min**), le relais est éteint et le défaut signalé. |
| T5 | Réalisation demandée le 30/09/2026 : moteur Berry essayé en réel sur le R4 ; le poêle (production, sans capteur) n'est pas touché, le moteur à règles n'est donc pas essayé en réel. |

### 7bis.2 Le thermostat est une voie

Nouvelle sorte de **voie** (§4.1bis) : `thermostat<n>`, qui **combine** un relais (sortie) et une mesure de
température (entrée, une voie capteur du même module). Elle devient un **appareil HA** propre (taxonomie
`thermostat---…` saisie comme les autres voies), relié au module par `via_device`. Réglages stockés dans
`voies` (§3.4, donc diffusés) :

```yaml
voies:
  thermostat1:
    nom: thermostat---bureau--bureau--1er étage      # taxonomie de la voie
    relais: 1                                          # numéro du relais commandé
    capteur: ds18b20_0119a1_temperature                # clé de la voie capteur (§4.1bis)
    hysteresis: 0.5                                    # °C, marge totale autour de la consigne
    consignes: { présence: 19, confort: 21, éco: 17, absence: 15 }
    minOn: 180                                         # s — durée minimale allumé (ESP32 seulement)
    minOff: 180                                        # s — durée minimale éteint (ESP32 seulement)
    capteurMuet: 1800                                  # s — délai avant arrêt de sécurité (T4)
```

- **Le thermostat possède son relais** : l'entité `switch`/`light` du relais n'est **plus publiée** tant
  qu'il est utilisé (pas de commande manuelle qui se battrait avec la régulation) ; l'état du relais se
  lit dans l'action du thermostat (`heating` / `idle`). La voie capteur reste publiée normalement
  (thermomètre indépendant, avec sa propre taxonomie).
- Nombre de thermostats par module : au plus le nombre de relais ; sur ESP8266 limité par les
  emplacements de règles libres (§7bis.4).
- Valeurs par défaut proposées à la création : présence 19, confort 21, éco 17, absence 15 (°C) ;
  marge 0,5 °C ; `minOn` = `minOff` = 180 s ; `capteurMuet` 1800 s. Toutes modifiables dans la fiche.

### 7bis.3 Moteur Berry (ESP32)

Vérifié le 30/09/2026 sur le Sonoff Basic R4 (ESP32-C3) : `Br 1+1` répond, système de fichiers présent
(`UfsType` 3). Sur le poêle (ESP8266) : `Br` et `UfsType` inconnus.

- **Fichiers déposés dans le module** par l'application : `autoexec.be` (charge le thermostat par
  `tasmota.load`), `dimotic_thermostat.be` (le programme, **versionné** : la version est publiée dans
  l'état), `dimotic_thermostat.json` (la configuration de §7bis.2, réécrite à chaque enregistrement de la
  fiche puis rechargée sans redémarrer). **Dépôt par la commande `Br`** (`open(...).write(bytes('<hex>'))`),
  **pas** par le téléversement web : blocs de 300 octets en hexadécimal (aucun souci de guillemets ni
  d'accents, commandes de 600 caractères), taille relue et comparée (8 413 octets en 28 blocs). Un
  `autoexec.be` qui ne porte pas la marque `# dimotic-ha` appartient à l'utilisateur : jamais écrasé, message
  d'aide. Nouvelle version du moteur → redémarrage du module ; configuration seule → `load_config(true)`.
- **Régulation** (relevé toutes les 10 s par `tasmota.read_sensors()`, durées comptées en ticks : pas de
  dérive au débordement de `millis()`) : lit la mesure du capteur (repéré par son `Id` matériel, pas par son rang) ; allume sous
  `consigne − marge/2`, éteint au-dessus de `consigne + marge/2` ; respecte `minOn` / `minOff` (protège
  radiateur ou chaudière) ; **ignore les mesures invalides** (`null`, 85 °C d'erreur du DS18B20, hors
  −30…90 °C).
- **Persistance dans la flash du module** (module Berry `persist`, clé `dt`) : consigne de chaque mode
  modifiée depuis HA, mode de la maison, mode thermostat. **La configuration de la fiche est prioritaire** :
  un enregistrement de la fiche remplace les consignes réglées depuis HA ; l'état publié
  (`consignes`) contient les consignes **effectives** et l'application les recopie dans sa configuration.
  Le fichier de configuration porte aussi `modeDefaut` (le premier mode de l'application) : consigne prise
  tant qu'aucun mode de maison n'est connu. Au redémarrage le thermostat reprend **sans attendre** HA ni le broker ; le
  relais reste éteint tant qu'aucune mesure valide n'est arrivée.
- **MQTT natif** (le module s'abonne / publie lui-même) :

  | Topic | Sens | Contenu |
  |---|---|---|
  | `dimotic/tasmota/<MAC>/thermostat<n>/etat` | module → | JSON retenu : `{version, temperature, consigne, mode, mode_maison, action, defaut}` ; `mode` = `heat` / `off`, `action` = `heating` / `idle` / `off`, `defaut` = `capteur_muet` ou absent |
  | `dimotic/tasmota/<MAC>/thermostat<n>/consigne/set` | → module | température (°C) : **règle la consigne du mode maison courant** (persistée) |
  | `dimotic/tasmota/<MAC>/thermostat<n>/mode/set` | → module | `heat` / `off` |
  | `dimotic/tasmota/mode` | → module | mode de la maison (§7.2), déjà retenu par l'application |

- **Mode de la maison** : le module applique la consigne du mode reçu et **garde le dernier mode connu**
  en flash (essayé : mode conservé après redémarrage). Un mode **retenu sur le broker fait foi** dès la
  reconnexion (constaté : il remplace le dernier mode du module). Le broker repart vide à chaque redémarrage : l'application **republie le mode courant
  (retenu) à chaque connexion au broker** (à ajouter, §7.2 ne le fait aujourd'hui que si aucun mode n'est
  connu).
- **Capteur muet** (T4) : sans mesure valide pendant `capteurMuet`, relais éteint, `defaut` publié ; reprise
  **automatique** à la première mesure valide.

### 7bis.4 Moteur règles (ESP8266)

Sans Berry, sans système de fichiers, 20 ko de mémoire libre, 3 emplacements de règles de 511 caractères.
Le texte de la règle **ne contient plus de chiffres** : il compare la mesure aux mémoires persistantes de
Tasmota `Mem1` (seuil bas) et `Mem2` (seuil haut) :

`ON <capteur>#Temperature<%mem1% DO Power<r> 1 ENDON ON <capteur>#Temperature>%mem2% DO Power<r> 0 ENDON`

- **C'est l'application qui écrit `Mem1` / `Mem2`** (consigne du mode courant ∓ marge/2) à chaque changement
  de consigne ou de mode maison (`Backlog Mem1 …; Mem2 …`) ; les mémoires étant enregistrées, le
  thermostat **continue avec les derniers seuils** si l'application ou le réseau tombe (il ne suit alors
  plus les changements de mode).
- **Capteur muet** (T4) : un second emplacement arme un `RuleTimer` remis à `capteurMuet` à chaque mesure ;
  à l'échéance, relais éteint.
- **Non disponible sur ESP8266** : `minOn` / `minOff`, mode `off` sans l'application (le mode thermostat
  « arrêt » est appliqué par l'application en désactivant la règle, `Rule<k> 0`), défaut publié par le
  module lui-même (l'application le déduit du silence du capteur).
- **Emplacements** : un thermostat occupe **un seul** emplacement de règle (la sécurité capteur muet tient
  dans la même règle, 4 blocs `ON … ENDON`) ; **2 thermostats au plus** (`Mem1`…`Mem4`). Ils sont
  choisis parmi les emplacements libres ; conflit avec des règles saisies dans la fiche : refusé avec un
  message clair (§7.1). Numéro de mémoire choisi pour ne pas heurter les autres règles.
- À valider en réel sur un ESP8266 avec capteur (comparaison à `%mem1%` dans le déclencheur, effet de
  `RuleTimer`).

### 7bis.5 Entité HA `climate`

Publiée **par l'application** (découverte standard, comme §4.2) pour chaque voie thermostat :

- appareil propre de la voie (§7bis.2), `name: null`, `unique_id: tasmota_<MAC>_thermostat<n>` ;
- `modes: [off, heat]`, `min_temp` 5, `max_temp` 30, `temp_step` 0,5, `temperature_unit: C` ;
- **ESP32** : `current_temperature_topic`, `temperature_state_topic`, `mode_state_topic`, `action_topic`
  lus dans `…/thermostat<n>/etat` (`value_template`) ; `temperature_command_topic` =
  `…/consigne/set`, `mode_command_topic` = `…/mode/set` (le module reçoit directement) ;
- **ESP8266** : mêmes topics d'état **republiés par l'application** (elle lit `tele/…/SENSOR` et l'état du
  relais) ; les commandes de HA passent par l'application, qui écrit `Mem1` / `Mem2` ou désactive la
  règle ;
- `json_attributes_topic` propre à la voie (`attributs_taxonomie`, §4.1bis) ;
- règler la température dans HA **modifie la consigne du mode maison courant** (pas une dérogation
  temporaire) ; les consignes des autres modes se règlent dans la fiche.

### 7bis.6 Fiche, remise d'usine, dialogue avec ia

- **Fiche** (§5) : section **Thermostats** (sous « Voies ») — relais commandé, capteur (liste des voies
  capteur de température), nom (QUOI + lieux, QUOI proposé « thermostat »), marge, consigne par mode,
  `minOn` / `minOff` (masqués sur ESP8266), délai capteur muet. Bouton **Enregistrer les thermostats** :
  stockage, dépôt / mise à jour des fichiers (ESP32) ou des règles et mémoires (ESP8266), relecture et
  comparaison, republication HA. Le moteur utilisé est indiqué.
- **Version du script** : lue dans l'état à chaque annonce ; différente de celle de l'application →
  redéposée (avec confirmation dans le journal).
- **Remise d'usine** (§5) : **efface aussi les fichiers déposés** (`UfsDelete`) et la clé `dt` de la mémoire persistante
  de Berry (elle survit aussi) ; **refusée si l'un d'eux ne s'efface pas** (pas de thermostat orphelin), et
  l'état local (thermostats, HA) n'est nettoyé qu'**une fois la remise d'usine confirmée** par le module.
  Le Wi-Fi et le broker sont effacés eux aussi (décision de l'utilisateur : la recherche des Tasmota
  inconnus, §6bis, les remet). ⚠️ **Correction du 30/09/2026** : « Remise d'usine » et « Mettre à jour (OTA) »
  n'avaient **jamais fonctionné** depuis l'application (l'argument `1` était dans le nom du topic MQTT,
  pas dans le payload) ; corrigés. Une remise d'usine de
  Tasmota **conserve le système de fichiers** (constaté le 29/09/2026), donc un ancien thermostat
  repartirait tout seul sur un module « neuf ». Les voies thermostat du module sont retirées de
  `devices.yaml` et de HA.
- **Oublier un appareil** (§3.3) : n'efface pas les fichiers du module (il n'est plus joignable par
  l'application) ; le thermostat continue de tourner en autonomie, mode et consigne compris.
- **Dialogue avec ia** (§8) : requêtes ajoutées `tasmota:thermostat:set` `{correlation_id, device,
  thermostat?, consigne?, mode?, mode_maison?}` → `…:reply` `{correlation_id, accepted, reason?}` (refusée :
  appareil ou thermostat inconnu, hors ligne, consigne hors 5…30 °C, mode inconnu). Le catalogue
  (`tasmota:catalog:get`) ajoute les thermostats (nom, consigne courante, action, défaut).

### 7bis.7 Firmware requis et disponibilité (vérifié le 30/09/2026)

**Aucune compilation ni version spéciale** : le firmware **standard** suffit.

| Puce | Firmware | Vérifié sur | Briques présentes |
|---|---|---|---|
| ESP32 | `tasmota32` standard (15.6.0, ESP32-C3) | Sonoff Basic R4 | Berry, modules `mqtt`, `persist`, `json`, `path`, `string`, minuteries (`set_timer`), système de fichiers (320 Ko libres) |
| ESP8266 | `tasmota` standard (15.1.0, puis **15.6.0** après la mise à jour du 30/09/2026) | poêle (carte 4 relais) | `Mem1`, `RuleTimer1`, `Rule1` (511 caractères libres), `Var1` ; **pas** de Berry ni de système de fichiers |

À **éviter** : sur ESP8266 les variantes `tasmota-lite` / `tasmota-minimal` (sans règles) ; sur ESP32 un firmware
sans Berry (variantes dépouillées) ; un firmware ancien (Berry moderne : version 12 ou plus, les modules
actuels sont en 15.x).

**Disponibilité** : à la lecture d'un module (§5) l'application teste `Br` et `UfsType` (ESP32) ou `Mem1` et
`Rule1` (ESP8266) et n'offre le moteur que s'il répond ; sinon la fiche affiche « thermostat indisponible :
<raison> » (ex. « firmware sans Berry »). Résultat mémorisé avec le modèle (§3.4).

### 7bis.8 Points à valider en réel (état au 30/09/2026)

| # | Point | État |
|---|---|---|
| 1 | Dépôt de fichiers sur un module ESP32 | ✅ **par `Br`** (le téléversement web n'est pas nécessaire), taille contrôlée — R4 |
| 2 | Effacement à distance et **remise d'usine** | ✅ **essayés le 30/09/2026** avec le bouton de l'application : fichiers effacés, `Reset and Restarting`, module revenu neuf (point d'accès), retrouvé par la recherche des Tasmota inconnus et remis sur le Wi-Fi et le broker par l'application ; ni fichier, ni `autoexec.be`, ni moteur en mémoire, ni entité HA après coup |
| 3 | `persist` et abonnement MQTT natif de Berry | ✅ essayés : consignes et mode conservés après redémarrage, commandes reçues, **reprise après reconnexion** |
| 4 | Clé du capteur par `Id` lue par Berry (plusieurs DS18B20) | ❌ non essayé (le R4 n'a pas de capteur : mesures simulées par `feed`) |
| 5 | ESP8266 : `%mem1%` dans un déclencheur, `RuleTimer` | ❌ non essayé (poêle en production, sans capteur) — le texte de la règle est testé, pas son effet |
| 6 | Mode de la maison conservé et rejoué | ✅ conservé en flash ; le mode retenu du broker fait foi à la reconnexion |
| 7 | Chaîne complète depuis HA (`climate.set_temperature`, `set_hvac_mode`) | ✅ essayée sur le vrai HA (consigne, arrêt, reprise, action) |
| 8 | Requête ia `tasmota:thermostat:set` | ⚠️ écrite (publie sur les topics de commande), non essayée de bout en bout |
| 9 | Écran (section Thermostats) | ✅ vu dans un navigateur : moteur détecté, relais et thermomètres par identifiant, consignes par mode |

### 7bis.9 Réalisation (30/09/2026)

1. ✅ Voie `thermostat`, fiche, entité `climate`, moteur Berry (essayé sur le R4).
2. ✅ Mode de la maison republié à chaque connexion ; effacement à la remise d'usine (non essayé en réel).
3. ✅ Moteur à règles ESP8266 (texte des règles testé ; effet non essayé, §7bis.8).
4. ✅ Requête ia `tasmota:thermostat:set` et thermostats dans le catalogue (`tasmota:catalog:get`).

Fichiers : `thermostat-berry.ts` (moteur, dépôt), `thermostat-rules.ts` (règles ESP8266), `ha-discovery.ts`
(voie, `climate`), `TasmotaService.ts` (détection du moteur, enregistrement, états, mode).

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
- Thermostat (§7bis) : chauffage seul ; ESP8266 sans `minOn` / `minOff` ni arrêt autonome ; script Berry à
  déposer et à tenir à jour sur chaque ESP32 concerné.
- Évolutions : outils d'ia (§8), variantes de règles, factorisation du parseur dans le core.

## 12. Historique

| Version | Date | Auteur | Modifications |
|---|---|---|---|
| 1.4 | 30/09/2026 | Claude | **Thermostat** (§7bis, réalisé — Berry essayé en réel sur le R4, règles ESP8266 non essayées) : voie `thermostat` (relais + capteur), consigne par mode de la maison, chauffage seul, sécurité capteur muet (30 min) ; moteur **Berry** sur ESP32 (fichiers déposés, persistance flash, MQTT natif, `minOn`/`minOff`), **règles + `Mem1`/`Mem2`** sur ESP8266 ; entité `climate` ; effacement des fichiers à la remise d'usine ; requête ia `tasmota:thermostat:set`. Spécification seulement. Remplace le modèle de règle « Thermostat » à consigne en dur. v1.3 archivée. |
| 1.3 | 30/09/2026 | Claude | **Voies** (§4.1bis) : une voie (relais, volet, mesure de capteur) = un appareil HA avec sa propre taxonomie, `via_device` vers le module ; stockage dans `devices.yaml` ; type des capteurs par la mesure (mesure inconnue : saisie du type) ; entité « Connexion » sur le module ; section Voies dans la fiche ; module « à nommer » publie ses voies nommées. Les voies non nommées gardent le comportement v1.2. v1.2 archivée. |
| 1.2 | 29/09/2026 | Claude | Liste stockée (`devices.yaml`, §3.4) : le broker repart vide à chaque redémarrage ; entités HA republiées à chaque connexion ; modèle, puce et contenu du modèle (`Module`, `Status 2`, `Gpio 255`) lus, stockés, affichés ; recherche unique des Tasmota inconnus (§6bis), en-tête `Referer` sur `/cm`. |
| 1.1 | 28/09/2026 | Claude | D7/§9 corrigés : la diffusion des fichiers de `data/` n'existe pas encore (core) ; règle `machine_` (non reproduit) / autres fichiers reproduits ; config et règles locales en attendant. |
| 1.0 | 28/09/2026 | Claude | Création : liste, nommage + publication HA comme RFXCOM, fiche réinjectée, mise en service d'un neuf (nmcli), règles préétablies + modes (select HA), dialogue ia. |
