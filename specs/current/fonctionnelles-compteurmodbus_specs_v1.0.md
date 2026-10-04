# Spécifications Fonctionnelles - Application COMPTEURMODBUS

*Version 1.0 - 1er Octobre 2026*
*Première spécification — **conception seulement, aucun code de l'application n'est écrit**. Un prototype
manuel (script unique + service systemd installés à la main sur noisy) fonctionne en réel depuis le
01/10/2026 ; cette spec décrit l'application qui le remplace (§12).*

---

## 📌 Table des Matières

1. Objet et périmètre
2. Pourquoi une application (et pas modbus2mqtt)
3. Architecture
4. Modèle de données
5. Profils de compteur (cartes de registres)
6. L'agent déployé
7. Publication MQTT et découverte Home Assistant
8. Déploiement SSH + systemd
9. Configuration
10. Interface et Socket.io
11. Sécurité du bus, limites, hors périmètre
12. Du prototype à l'application — migration de noisy
13. Points ouverts
14. Plan de mise en œuvre
15. Historique

---

## 1. Objet et périmètre

Lire des **compteurs électriques Modbus RTU (RS485)** branchés sur une machine du parc et publier leurs
mesures vers Home Assistant, avec **la même mécanique que `teleinfo` et `rpigpio`** : une application
dimotic-ha porte la configuration, déploie un petit agent sur la machine où est branché l'adaptateur, le
supervise, et la configuration est diffusée entre les machines comme celle des autres applications
(`techniques-diffusion-data_specs`).

**But final** (décision utilisateur, 01/10/2026) : fournir la **puissance du réseau** à l'intégration
`Omnibattery` (HA) qui pilote une batterie Marstek Venus E 3.0 chargée sur l'excédent solaire. Le compteur
de départ est un **DDSU666-H** (Huawei/Chint monophasé, RS485 seul, sans Wi-Fi) ; le modèle de **profil** (§5)
permet d'en ajouter d'autres plus tard.

**Dans le périmètre** : lecture seule en fonction 3 ; plusieurs compteurs et plusieurs machines ; découverte
HA ; déploiement, démarrage, arrêt, redémarrage et lecture de la log depuis l'IHM ; sonde de réglages
(adresse, parité) en lecture seule.

**Hors périmètre** (§11) : toute écriture Modbus ; les compteurs interrogés par un module Wi-Fi qui reste
maître du bus (le **DDZY422-D2** de noisy) ; la régulation de la batterie elle-même.

---

## 2. Pourquoi une application (et pas modbus2mqtt)

- Décision du 14/09/2026 : `modbus2mqtt` en conteneur compagnon plutôt qu'une application. **Réexaminée le
  01/10/2026** : sur **noisy** (RPi3, **Raspbian 10 32 bits, `armv7l`**) son image n'existe pas
  (`no matching manifest for linux/arm/v7`) ; noisy fait tourner Docker (dimotic-ha, mosquitto, mqtt-io), mais
  l'architecture 32 bits exclut les images publiées seulement pour arm64/amd64.
- Un script sans dépendance (`python3` seul) couvre le besoin : lecture, découverte, état. Il se déploie par
  SSH + systemd, **exactement comme l'agent de teleinfo**.
- `modbus2mqtt` reste valable sur une machine 64 bits (noisy2, ha2…) : une cible pourrait choisir ce moteur plus
  tard (§13, point 7). Hors v1.0.

---

## 3. Architecture

```
IHM (compteurs + cibles)  ──socket.io──>  CompteurModbusService (process séparé, standalone.ts)
        |                                        |
        | « Déployer »                           | DeployService (SSH/SCP + SystemdUnitController du socle)
        v                                        v
 data/compteurmodbus/config.yaml        <machine cible> /dimotic-ha-addons/compteurmodbus/
 (diffusé entre machines)                 agent/compteurmodbus-agent.py + config.yaml + .service
                                                 |  RS485 (lecture seule, fonction 3)
                                                 v
                                          compteur(s) ──> MQTT (broker de destination) ──> nommage ──> HA
```

### 3.1 Composants dimotic-ha (`applications/compteurmodbus/src/domain/`)

| Fichier | Rôle |
|---|---|
| `index.ts` | `COMPTEURMODBUS_APP: ApplicationModule` (`runsAsSeparateProcess: true`, `bridgedEvents` à établir) + factory |
| `CompteurModbusService.ts` | Orchestrateur : CRUD des compteurs et des cibles, événements Socket.io, valeurs en direct |
| `DeployService.ts` | `deploy()` / `start()` / `stop()` / `restart()` / `logs()` — même patron que teleinfo §7 |
| `generator.ts` | Construit le `config.yaml` de l'agent d'une cible à partir des compteurs qui lui sont rattachés |
| `profiles/` | Cartes de registres (§5), un fichier par modèle |
| `probe.ts` | Sonde de réglages : lance l'agent en mode `--sonde` par SSH (§10.3) |
| `config-schema.ts` / `storage-schema.ts` | Schémas Zod (§4, §9) |

### 3.2 Process séparé

Comme `teleinfo`/`rpigpio` (`fonctionnelles-supervisor_specs` §2), le service dimotic-ha tourne dans son propre
process. L'**agent** déployé sur la cible n'a **aucun rapport** avec ce mécanisme : c'est un déploiement distinct
(SSH + systemd).

---

## 4. Modèle de données

### 4.1 Cible (`targets[]`) — une machine = une ligne

| Champ | Type | Défaut | Rôle |
|---|---|---|---|
| `id` | string | — | Identifiant de la cible (ex. `noisy`), unique |
| `site` / `machine` | string | — | Même sens que dans `sauvegarde` / les gossips |
| `host` | string | — | Hôte SSH (root direct, clé unique de l'installation — guide §6) |
| `remoteDir` | string | `/dimotic-ha-addons/compteurmodbus` | Convention du guide §6 pour un agent non-Docker |
| `serviceName` | string | `compteurmodbus` | Nom du service systemd |
| `mqtt.host` / `mqtt.port` | string / number | — / `1883` | **Broker de destination** : celui que lit le HA concerné (pour noisy : le broker de noisy2, `192.168.1.201`) |
| `mqtt.discoveryPrefix` | string | `homeassist` | Jamais `homeassistant` directement (teleinfo §6.1) |

Le broker de destination est un attribut **de la cible**, pas de la machine qui exécute dimotic-ha : il décrit
où l'agent publie, valable pour toutes les machines qui voient cette cible (leçon de l'incident du 01/10/2026 :
rien de propre à la machine locale dans ce qui est diffusé, `techniques-diffusion-data_specs` §8).

### 4.2 Compteur (`compteurs[]`)

| Champ | Type | Défaut | Rôle |
|---|---|---|---|
| `id` | string | — | Identifiant unique (ex. `reseau-noisy`) ; sert au `unique_id` HA (§7.3) |
| `targetId` | string | — | Cible qui porte l'adaptateur |
| `profil` | string | `ddsu666h` | Carte de registres (§5) |
| `quoi` / `lieu…` | strings | — | Nom `QUOI---LIEU` du device HA (`teleinfo` §6.1, convention `nommage`) |
| `port` | string | — | Chemin **stable** (`/dev/serial/by-id/…` ou `by-path/…`, jamais `ttyUSBn`) |
| `vitesse` | number | `9600` | Bauds |
| `parite` | `N` \| `E` | `N` | 8 bits de données, 1 bit d'arrêt |
| `adresse` | number | `11` | Adresse esclave (1-247) |
| `intervalleSec` | number | `5` | Lecture (1 à 60) |

Contraintes : un même `(targetId, port)` ne porte qu'un seul bus ; plusieurs compteurs d'adresses différentes
peuvent partager un port (bus multipoint), lus l'un après l'autre.

---

## 5. Profils de compteur (cartes de registres)

Un profil décrit **quoi lire et comment l'interpréter** ; il est embarqué dans l'agent (JSON dans `config.yaml`).
v1.0 : un profil, **`ddsu666h`** (carte **vérifiée en réel** le 14/09/2026 sur noisy2 puis le 01/10/2026 sur noisy ;
voir `TODO.md`, « carte de registres DDSU666H complète et vérifiée »).

Format commun des valeurs : flottants 32 bits, octets de poids fort d'abord, **fonction 3** uniquement.
Plage valide `0x2000` à `0x2023` (au-delà : *Illegal data address*).

| Mesure | Registre | Échelle | Unité HA | `device_class` | `state_class` |
|---|---|---|---|---|---|
| Tension | `0x2000` | ×1 | V | `voltage` | `measurement` |
| Courant | `0x2002` | ×1 | A | `current` | `measurement` |
| Puissance active | `0x2006` | ×1000 | W | `power` | `measurement` |
| Puissance réactive | `0x200C` | ×1000 | var | `reactive_power` | `measurement` |
| Puissance apparente | `0x2012` | ×1000 | VA | `apparent_power` | `measurement` |
| Facteur de puissance | `0x2018` | ×1 | — | `power_factor` | `measurement` |
| Fréquence | `0x2020` | ×1 | Hz | `frequency` | `measurement` |
| Énergie totale (importée − exportée) | `0x4000` | ×1 | kWh | `energy` | `total` |
| Énergie importée | `0x400A` | ×1 | kWh | `energy` | `total_increasing` |
| Énergie exportée | `0x4014` | ×1 | kWh | `energy` | `total_increasing` |

**Signe** : puissance active **positive = soutirage, négative = injection** (convention Huawei). Pièges établis :
`0x2004` est toujours à 0 (**pas** la puissance) ; `0x200E` n'est **pas** la fréquence ; deux adresses du document
GitHub d'origine étaient fausses (`0x2018` et `0x2020`). Contrôles de cohérence utilisés : V × I = S ;
√(S² − P²) = |Q| ; P / S = |PF| ; total = importée − exportée.

**Lecture en trois requêtes** par cycle : `0x2000` ×28, `0x2020` ×2, `0x4000` ×24 (environ 100 ms à 9600 bauds).
Les réglages d'usine : **9600 bauds, adresse 11** pour un compteur Huawei (adresse 1 pour un Chint) ; le manuel
Chint annonce 8-N-2, la lecture en 8-N-1 fonctionne (vérifié sur noisy).

---

## 6. L'agent déployé

`applications/compteurmodbus/device-agent/compteurmodbus-agent.py` — dérivé du prototype
`applications/outils/reposcripts/scripts/ddsu666h-mqtt.py`, **sans dépendance** : `python3` ≥ 3.5 (noisy : 3.7),
`termios` de la bibliothèque standard.

- Lit son `config.yaml` local (compteurs de CETTE cible, profils, broker). Le YAML est écrit par `generator.ts` en
  **JSON** (valide en YAML) pour que l'agent n'ait pas besoin d'un analyseur YAML.
- Une boucle par port série : lecture des compteurs, publication, attente de `intervalleSec` moins le temps passé.
- **Client MQTT minimal intégré** (CONNECT, PUBLISH, PINGREQ, SUBSCRIBE du protocole 3.1.1 ; une centaine de lignes) :
  nécessaire pour avoir un **LWT** et un **battement de cœur** comme l'agent de teleinfo (§6.5 de leur spec), ce que
  des appels répétés à `mosquitto_pub` ne permettent pas. Alternative écartée en v1.0 : dépendre du paquet
  `mosquitto-clients` (§13, point 2).
- Reconnexion automatique, republication de la découverte au *birth message* de HA (`homeassistant/status`) et toutes
  les 10 minutes.
- Mode **`--sonde`** : essaie les adresses et parités demandées, lit les registres de mesure, affiche et sort
  (même comportement que `modbus-probe.py`, §10.3). Mode `--once` pour un essai sans service.
- **N'émet que des lectures** (§11.1).

Présence de l'agent : topic `compteurmodbus/<cible>/agent/status` (JSON `{status, timestamp}`, retenu, LWT
`offline`, battement toutes les 30 s) — même patron que teleinfo §6.5 ; le service dimotic-ha s'y abonne et affiche
« En ligne / Hors ligne / dernier contact » par cible.

---

## 7. Publication MQTT et découverte Home Assistant

### 7.1 Convention de topics

Découverte sous `<discoveryPrefix>/sensor/<nœud>/<mesure>/config` avec `discoveryPrefix = homeassist` (défaut) :
le **relais `nommage`** transforme et range les entités (aire et QUOI), **sans modification de `nommage`**
(`fonctionnelles-nommage_specs`, source MQTT correspondant au broker de destination). `device.name` =
`<quoi>---<lieu…>` du compteur (teleinfo §6.1, §6.3).

> Le prototype du 01/10/2026 publie directement sur `homeassistant/` : **provisoire**. Il crée des entités aux noms
> longs, sans taxonomie. L'application publie sous `homeassist/` (§12).

### 7.2 État

Un seul message JSON par cycle et par compteur sur `compteurmodbus/<cible>/<compteur>/state` (non retenu), avec
`expire_after = max(60, 6 × intervalle)` : si l'agent s'arrête, les capteurs passent « indisponibles » sans
dépendre du LWT.

### 7.3 Identifiants

`device.identifiers = ["compteurmodbus_<compteur.id>"]`, `unique_id = "compteurmodbus_<compteur.id>_<mesure>"`.
Les capteurs du prototype (`ddsu666h_noisy_<mesure>`) ne sont **pas** réutilisés tels quels : la migration (§12)
les remplace, avec perte d'historique prévue et annoncée (§13, point 5).

---

## 8. Déploiement SSH + systemd

Même séquence que `teleinfo` §7.1, sur le socle partagé `core/infrastructure/remote/` :

1. **Contrôles préalables** (lecture seule) : `python3` présent et version suffisante ; **le port existe** ; **aucun
   processus ne l'utilise** (`fuser`) ; le broker de destination répond (connexion TCP).
2. Création de `remoteDir` ; copie de l'agent (SCP) ; écriture de `config.yaml` (SSH `tee`, droits 600 : peut
   porter le mot de passe MQTT).
3. Écriture de `compteurmodbus.service` **dans `remoteDir`**, lien symbolique vers `/etc/systemd/system/` (convention
   auto-descriptive du guide §7), `daemon-reload && enable && restart`, vérification `is-active`.
4. Retour d'étape par étape à l'IHM (`compteurmodbus:remote-op:result`).

Autres actions : `start`, `stop`, `restart` (`SystemdUnitController`), **`logs`** (`journalctl -u <service> -n 100`,
affichée dans l'IHM), **`retirer`** (arrête, désactive, supprime l'unité et `remoteDir` — après confirmation).

Connexion en **root direct**, jamais `sudo` ; clé SSH unique de l'installation. Si le déploiement ne peut pas
écrire sur la cible, l'erreur est affichée telle quelle et l'état de la cible reste inchangé.

---

## 9. Configuration

`data/compteurmodbus/config.yaml` — **fichier commun**, diffusé comme celui des autres applications.

| Champ | Contenu |
|---|---|
| `targets` | §4.1 |
| `compteurs` | §4.2 |

Couches (`techniques-diffusion-data_specs` §8.1) :
- **commun** : `targets`, `compteurs` (le port d'un compteur décrit la machine cible, pas la machine locale) ;
- **secrets** (`secrets_config.yaml`) : `targets[].mqtt.password` — déclaré dans `APP_DECLARATIONS` du core ;
- **machine** : rien en v1.0.

Application **désactivée à son arrivée**, comme toute application nouvelle (guide §9, `enabledByDefault` absent).
Formulaire de configuration générique pour les cibles ; compteurs et valeurs en direct sur la page dédiée (§10).

---

## 10. Interface et Socket.io

### 10.1 Page « Compteurs Modbus » (menu)

- **Cartes de cibles** : composant mutualisé `TargetCards` (teleinfo/rpigpio/arexx) — état de l'agent, boutons
  Déployer, Démarrer, Arrêter, Redémarrer, **Voir la log**, Retirer ; rappel des instructions de préparation SSH.
- **Liste des compteurs** par cible : nom `QUOI---LIEU`, profil, adresse, valeurs **en direct** (tension, courant,
  puissance, énergie, âge de la mesure) lues sur le topic d'état.
- **Formulaire de compteur** : champs du §4.2 ; menu déroulant de ports (`by-id` / `by-path` listés sur la cible,
  action `ports`).

### 10.2 Événements (préfixe `compteurmodbus:`)

| Événement | Sens | Contenu |
|---|---|---|
| `compteurmodbus:state:get` / `:state` | IHM ↔ service | cibles, compteurs, présence des agents |
| `compteurmodbus:compteur:save` / `:delete` | IHM → service | définition d'un compteur |
| `compteurmodbus:remote-op` / `:remote-op:result` | IHM ↔ service | `{ targetId, action }` : deploy, start, stop, restart, logs, retirer, ports |
| `compteurmodbus:probe` / `:probe:result` | IHM ↔ service | sonde (§10.3) |
| `compteurmodbus:live` | service → IHM | dernière mesure d'un compteur |

### 10.3 Sonde de réglages (lecture seule)

Bouton « Chercher les réglages » : lance l'agent en `--sonde` sur la cible, adresses 11 et 1, parités N puis E,
et affiche ce qui répond (tension, courant, puissance…). **Refuse** de s'exécuter si le service de la cible utilise
déjà le port (il faut d'abord l'arrêter), et ne doit **jamais** être lancé sur un bus où un module Wi-Fi est maître
(§11.2).

---

## 11. Sécurité du bus, limites, hors périmètre

1. **Lecture seule** : l'agent n'émet que des requêtes de **fonction 3**. Aucune écriture dans un compteur, ni
   réglage d'adresse ou de vitesse, n'est offerte.
2. **Un seul maître par bus.** Un compteur dont un module Wi-Fi est déjà maître (le **DDZY422-D2** de noisy,
   interrogé par un module Solarman qui lit `0x0000`×34 toutes les 61 s) **ne peut pas** être interrogé par cet
   agent sans collisions : hors périmètre. Une passerelle qui se glisse dans les silences du module est envisageable
   plus tard (idée notée au `TODO.md`) ; sa lecture passive reste couverte par `rs485-sniffer.py`.
3. **Port exclusif** : un seul programme à la fois sur un adaptateur (RFXCOM, sonde, sniffer, agent).
4. **Chemins de port stables** (`by-id`/`by-path`) : deux adaptateurs identiques sans numéro de série peuvent
   échanger `ttyUSB0` et `ttyUSB1` au redémarrage.
5. Débit : à 9600 bauds, 3 requêtes par cycle occupent environ 100 ms ; intervalle minimum 1 s.
6. Pas de limite d'exposition réseau : l'agent ne **reçoit** aucune connexion, il ne fait que se connecter au broker.

---

## 12. Du prototype à l'application — migration de noisy

Situation au 01/10/2026 : `/root/ddsu666h-mqtt.py` + `/etc/systemd/system/ddsu666h-mqtt.service` sur noisy,
10 capteurs `ddsu666h_noisy_*` découverts directement sur le broker de noisy2 (`homeassistant/`).

Migration prévue (à faire seulement après validation de l'application) :
1. Déclarer la cible `noisy` et le compteur dans l'application ; **déployer** (l'agent prend le relais).
2. **Arrêter et supprimer** l'ancien service `ddsu666h-mqtt` et le script de `/root` ; supprimer les messages de
   découverte retenus `homeassistant/sensor/ddsu666h_noisy/+/config` (publication d'un message vide retenu), sinon
   les 10 anciens capteurs resteraient.
3. Vérifier les nouveaux capteurs (nommés par `nommage`) et brancher Omnibattery dessus.

Le prototype reste dans `outils/reposcripts/scripts/` jusqu'à la migration, puis est retiré de `outils` (spec outils
à versionner à ce moment).

---

## 13. Points ouverts

1. **Nom de l'application** : `compteurmodbus` proposé (à ne pas confondre avec `teleinfo`, compteurs EDF) ; à valider.
2. **MQTT** : client minimal intégré à l'agent (retenu, §6) ou dépendance `mosquitto-clients` (déjà présent sur
   noisy) — le premier évite toute dépendance et donne LWT/battement ; le second est plus court à écrire.
3. **Où se déclare le broker de destination** : par cible (retenu, §4.1) ou par compteur.
4. **Taxonomie** : le compteur est un point de mesure du réseau, pas un appareil : quel `QUOI` dans la nomenclature
   (« compteur » ? à créer dans `nommage` ?) ; à voir avec les `QUOI` existants.
5. **Historique HA** : les capteurs du prototype sont remplacés (§12) ; accepter la perte d'historique du prototype
   (quelques heures) ou conserver les `unique_id` `ddsu666h_noisy_*` pour cette seule cible ?
6. **Intervalle** : 5 s par défaut ; à confirmer par la qualité de la régulation d'Omnibattery (quelques secondes
   suffisent probablement).
7. **Deuxième moteur** (`modbus2mqtt` en Docker sur les machines 64 bits) : hors v1.0.
8. **Autres profils** : DTSU666 triphasé, Eastron SDM… à ajouter quand un besoin réel existe, avec leur propre carte
   vérifiée en réel.

---

## 14. Plan de mise en œuvre

Dans l'ordre, chacune vérifiée avant la suivante (build à chaque étape, test réel à la fin) :

1. Spec validée par l'utilisateur (ce document) ; points ouverts 1 à 5 tranchés.
2. Agent seul : client MQTT minimal, profil `ddsu666h`, modes `--once` / `--sonde`, essai sur noisy à la main.
3. Squelette de l'application (`index.ts`, schémas, `declarations` dans le core, service vide, page vide) :
   détectée, désactivée par défaut, activable à chaud.
4. `DeployService` + `generator.ts` : déploiement sur noisy depuis l'IHM, logs, arrêt/redémarrage.
5. Cartes de cibles, liste de compteurs, valeurs en direct, sonde.
6. Migration de noisy (§12) ; essai bout en bout jusqu'à Omnibattery quand la batterie sera installée.
7. Spec mise à jour des constats réels (v1.1), `PROMPT_PROJET.md` §11 (table specs ↔ application), `CHANGELOG`.

---

## 15. Historique

| Version | Date | Changements |
|---|---|---|
| 1.0 | 01/10/2026 | Première spécification (conception, aucun code d'application). Fondée sur le prototype manuel de noisy (service systemd + script, mesures vérifiées en réel, 10 capteurs dans le HA de noisy2) et sur les patrons `teleinfo`/`rpigpio`. |
