# Spécifications Fonctionnelles - Module TELEINFO

*Version 1.2 - 22 Août 2026*
*v1.2 : `DeployService.ts` migré sur le socle partagé `core/infrastructure/remote/` (SSH/SCP +
contrôleur Docker/systemd, §7.1bis), mutualisé avec `rpigpio` qui réimplémentait des primitives
quasi identiques. Protocole Socket.io de déclenchement uniformisé (§9.2) : l'ancien couple
`teleinfo:deploy`/`teleinfo:deploy:result` devient `teleinfo:remote-op`/`teleinfo:remote-op:result`
(payload `{ action }`), le même quelle que soit l'intervention distante. `start`/`stop`/`restart`
exposés côté `DeployService`/`SystemdUnitController` (`systemctl start|stop|restart`) mais pas
encore câblés sur un bouton IHM — en attente des scripts distants annoncés par l'utilisateur.
Ancienne version v1.1 archivée.*
*Version 1.1 - 16 Août 2026*
*Migration en process séparé (`fonctionnelles-supervisor_specs` v2.6, IPC — §2.4, nouvelle) +
présence de l'agent RPi1 : LWT + battement de cœur ajoutés à `ha-publisher.js` (§6.5, nouvelle) —
seule implémentation de présence/heartbeat de cette session **vérifiée en conditions réelles** sur
le matériel physique (redéploiement réel, service systemd actif, battement reçu toutes les 30s).
Ancienne version v1.0 archivée.*

*Version 1.0 - 12 Août 2026*
*Première spécification, écrite en même temps que le code — application créée, déployée et
déboguée en conditions réelles (RPi1 physique, 2 compteurs EDF réels) au cours de la session du
12/08/2026.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
    - 2.4 [Process séparé (v1.1)](#24-process-séparé-nouveau-v11-16082026)
3. [Modèle de données](#3-modèle-de-données)
4. [Protocole Téléinformation Mode Historique](#4-protocole-téléinformation-mode-historique)
5. [Bascule GPIO entre les 2 compteurs](#5-bascule-gpio-entre-les-2-compteurs)
6. [Publication MQTT et Découverte HA](#6-publication-mqtt-et-découverte-ha)
    - 6.5 [Présence de l'agent (LWT + battement de cœur)](#65-présence-de-lagent-lwt--battement-de-cœur--nouveau-v11-16082026)
7. [Déploiement SSH + systemd](#7-déploiement-ssh--systemd)
    - 7.1bis [Socle SSH/SCP partagé (v1.2)](#71bis-socle-sshscp-partagé-nouveau-v12-22082026)
8. [Configuration](#8-configuration)
9. [Interface Web et Socket.io](#9-interface-web-et-socketio)
10. [Limites et Contraintes Connues](#10-limites-et-contraintes-connues)
11. [Arborescence des Programmes](#11-arborescence-des-programmes)
12. [Annexes](#12-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/teleinfo` est une IHM de paramétrage (quoi/où, ADCO) pour **2 compteurs EDF mode
historique** câblés sur un **unique Raspberry Pi 1**, via une carte de commutation matérielle
(bascule GPIO entre les 2 lignes série). L'application génère un `config.yaml` et déploie un agent
Node.js (`device-agent/`) sur ce RPi1 par SSH + service systemd.

### 1.2 Origine du code

Le `device-agent/` est une **adaptation**, pas une réécriture, d'un programme existant de
l'utilisateur (`/home/didier/ownCloud/workspace6/zdidnodeteleinfo/`, JavaScript, faisait partie
d'une ancienne domotique maison). Le protocole série, le calcul de checksum et la logique de
bascule GPIO sont repris à l'identique (déjà prouvés sur ce matériel exact) — voir §4/§5. La
simplification porte sur le périmètre (2 compteurs alternés uniquement, mode `CONTINU`/
`ALADEMANDE` de l'original retirés) et sur la source de configuration (fichier local généré par
cette application, plutôt que `global.properties` centralisé sur le "module principal" de
l'ancienne domotique).

### 1.3 Pourquoi pas Docker

**Vérifié le 12/08/2026** : Node.js officiel n'a plus de build ARMv6 depuis Node 14 (`nodejs.org/
dist` ne propose que `linux-arm64`/`linux-armv7l` pour Node 20) — un vrai Raspberry Pi 1
(ARM1176JZF-S, ARMv6) est donc incompatible avec l'image Docker `node:20-*` utilisée par le reste
du projet. Décision utilisateur : agent en process Node natif + systemd, comme l'ancienne
installation déjà prouvée sur ce matériel, plutôt que de réécrire en Go ou d'utiliser un Node très
ancien (EOL) en conteneur.

### 1.4 Périmètre

- **Inclus** : CRUD de 2 compteurs (ADCO, quoi/où), génération du `config.yaml` de l'agent,
  déploiement SSH + systemd, bouton "Générer et déployer".
- **Exclus** : lecture GPIO/série par cette application elle-même (délégué à l'agent déployé),
  support de plus ou moins de 2 compteurs (contrainte physique de la carte de commutation à 2
  positions), tarifs autres que Base/HC-HP (autres champs TIC ignorés).

---

## 2. Architecture

### 2.1 Composants dimotic-ha (`applications/teleinfo/src/domain/`)

| Fichier | Rôle |
|---|---|
| `TeleinfoService.ts` | Orchestrateur : CRUD des 2 compteurs, événements Socket.io, appel au déploiement |
| `generator.ts` | Construit le `config.yaml` de l'agent à partir des compteurs stockés |
| `DeployService.ts` | `deploy()` : copie `device-agent/`, résout les dépendances natives, écrit/redémarre le service systemd — SSH/SCP via le socle partagé (§7.1bis). `start()`/`stop()`/`restart()` : délèguent au `SystemdUnitController` partagé, ⭐ v1.2 |
| `config-schema.ts` | Schéma Zod des réglages (cible SSH, GPIO, port série, broker MQTT) |
| `storage-schema.ts` | Schéma Zod d'un compteur (`CompteurDefinition`), max 2 |
| `yaml/ConfigFileManager.ts` | Chargement/sauvegarde atomique du YAML des compteurs |

### 2.2 Composants de l'agent déployé (`applications/teleinfo/device-agent/`)

| Fichier | Rôle | Origine |
|---|---|---|
| `main.js` | Point d'entrée : lit `config.yaml` local, câble tout ensemble | Adapté de `hateleinfo1.js` |
| `teleinfo-reader.js` | Lecture d'une trame série (checksum, délimiteurs) | Adapté de `edfteleinfo.js` |
| `teleinfo-service.js` | Boucle d'alternance entre les 2 compteurs, pause entre cycles | Adapté de `teleinfoserv.js` |
| `gpio-switch.js` | Pilotage de la carte de commutation (`rpio`, pins physiques) | Adapté de `edfteleinfogpio.js` |
| `ha-publisher.js` | Découverte HA + publication d'état MQTT (`homeassist/`, taxonomie QUOI---OÙ) | **Nouveau** — remplace `hateleinfo2.js` (publiait en dur sur `homeassistant/sensor/...` avec libellés français fixes) |

### 2.3 Flux de données

```
IHM (2 compteurs : ADCO + quoi/où)
    |
    v (bouton "Générer et déployer")
generator.ts → config.yaml agent
    |
    v (DeployService, SSH + systemd)
RPi1 : /opt/teleinfo/ (device-agent + config.yaml), service systemd actif
    |
    v (boucle alternée, voir §5)
Compteur A --(bascule GPIO)--> Compteur B --(bascule GPIO)--> Compteur A --(pause cycleIntervalMs)--> ...
    |
    v (trame longue valide reçue)
ha-publisher.js : découverte + état MQTT sur homeassist/
    |
    v
nommage (pipeline taxonomie existant, aucune modification requise) → homeassistant/ → HA
```

### 2.4 Process séparé (⭐ nouveau v1.1, 16/08/2026)

`TELEINFO_APP.runsAsSeparateProcess = true` — même mécanisme générique qu'`rpigpio` (voir
`fonctionnelles-rpigpio_specs` §2.4) : `TeleinfoService.ts` (composant dimotic-ha, §2.1) tourne dans
son propre process OS (`applications/teleinfo/src/standalone.ts`), démarré par `ProcessSupervisor`.
**Ne concerne que le composant dimotic-ha** — l'agent RPi1 (§2.2, `device-agent/`) reste, comme
avant, un déploiement entièrement séparé (SSH + systemd, §7), sans rapport avec ce mécanisme de
process séparé côté `core` (deux notions de "process séparé" distinctes, à ne pas confondre — voir
`fonctionnelles-supervisor_specs` §11.4, "migrer teleinfo/rpigpio déployés en Docker/systemd séparé
vers l'architecture standalone du socle reste hors scope").

---

## 3. Modèle de données

### 3.1 `CompteurDefinition` (`storage-schema.ts`)

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `adco` | number | oui | Numéro de série du compteur (étiquette `ADCO` de la trame) — identifie sans ambiguïté quel compteur a répondu |
| `quoi` | string | oui | Taxonomie QUOI |
| `lieuPrecis` | string | non | Taxonomie OÙ, niveau précis |
| `lieu` | string | oui | Taxonomie OÙ, niveau principal |
| `lieuPere` | string | non | Taxonomie OÙ, niveau parent |
| `lieuGrandPere` | string | non | Taxonomie OÙ, niveau grand-parent |

**Exactement 2 compteurs maximum** (`compteursConfigSchema`, `.max(2)`) — contrainte physique de
la bascule GPIO (une seule ligne série, 2 positions). `TeleinfoService::handleSaveCompteur` refuse
toute création au-delà de 2 (message d'erreur explicite plutôt qu'un rejet Zod silencieux).

### 3.2 Persistance

`data/teleinfo/teleinfo-compteurs-v1.0.yaml` — tableau `compteurs: CompteurDefinition[]`.

---

## 4. Protocole Téléinformation Mode Historique

### 4.1 Paramètres série

1200 bauds, 7 bits de données, parité paire, 1 bit d'arrêt (`teleinfo-reader.js`) — norme Enedis
mode historique, repris à l'identique de l'original.

### 4.2 Structure d'une trame

- Une trame = plusieurs lignes `ÉTIQUETTE VALEUR CHECKSUM`.
- **Les lignes à l'intérieur d'une même trame sont séparées par CR-LF simple.**
- **Les trames entre elles sont séparées par la séquence CR-ETX-STX-LF** (4 octets :
  `\x0D\x03\x02\x0A`).
- Checksum : somme des codes ASCII de "ÉTIQUETTE VALEUR", `& 0x3F`, `+ 0x20`.
- Trame "longue" (exploitable) = contient `OPTARIF` (option tarifaire) en plus de `ADCO`.

### 4.3 ⭐ Bug réel trouvé et corrigé en conditions réelles (12/08/2026)

**Symptôme observé** : service déployé et actif, connexion MQTT confirmée, mais aucune trame
jamais reconnue — `timeout de lecture (5s)` en boucle, alors qu'une capture série brute (`stty` +
`cat` + `xxd`) confirmait des données réelles et valides sur le fil.

**Cause** : la première version de `teleinfo-reader.js` découpait le flux uniquement sur le
délimiteur de trame (CR-ETX-STX-LF, §4.2), en traitant directement chaque morceau obtenu comme
**une seule ligne** à envoyer au décodeur de checksum — alors que ce morceau contient en réalité
**plusieurs lignes** (une trame entière) séparées par de simples CR-LF. Un découpage à un seul
niveau livrait donc un bloc multi-lignes au décodeur, dont le calcul de checksum (prévu pour une
seule ligne) échouait systématiquement.

L'original (`edfteleinfo.js::traitData()`) faisait bien ce découpage à deux niveaux
(`data.split('\r\n')` après avoir isolé une trame) — perdu par inadvertance lors de l'adaptation.

**Correction** (`teleinfo-reader.js`) : pour chaque bloc obtenu entre deux délimiteurs de trame,
`frameBlob.split('\r\n')` puis décodage ligne par ligne dans un objet `frame` frais. Vérifié en
conditions réelles après correction : les deux compteurs alternent correctement, trames reçues
toutes les ~2s au sein d'un même cycle.

---

## 5. Bascule GPIO entre les 2 compteurs

### 5.1 Principe

Une carte de commutation matérielle ("carte CAN", terme du code original) route l'une des 2 lignes
téléinfo vers l'unique UART du RPi1, sélectionnée par l'état de 2 pins GPIO en **numérotation
physique (BOARD)**, pas BCM (`gpio-switch.js`, package `rpio`) — pins 11/12 par défaut,
configurables.

### 5.2 Identification par ADCO, pas par timing

Le compteur qui a répondu est déterminé par le champ `ADCO` de la trame reçue, **jamais** en
supposant que "l'état GPIO actuel = tel compteur" — plus robuste face à un éventuel décalage de
timing entre la bascule et la stabilisation du signal.

### 5.3 Cycle de lecture (`teleinfo-service.js`)

1. Bascule initiale déterministe (`gpioSwitch.inverse()`).
2. Lecture d'une trame longue complète (compteur A) — ou timeout 5s / 15 anomalies consécutives.
3. Bascule GPIO (`inverse()`), pause matérielle `SWITCH_DELAY_MS` (150ms, temps de stabilisation
   de la carte de commutation).
4. Lecture d'une trame longue complète (compteur B).
5. **Pause `cycleIntervalMs`** (§5.4) avant de reboucler à l'étape 1.

### 5.4 ⭐ Throttling — demande utilisateur (12/08/2026)

Mesuré en conditions réelles sans pause après un cycle complet : ~5 secondes entre deux lectures
d'un **même** compteur (le compteur envoie une trame en continu, la boucle enchaînait donc
immédiatement). Jugé inutilement rapide pour du suivi de consommation électrique et risquant de
saturer MQTT/le recorder HA sur la durée.

**Correctif** : pause configurable `cycleIntervalMs` (défaut **30000 ms**) insérée après chaque
cycle complet (les 2 compteurs lus une fois) — `SWITCH_DELAY_MS` (150ms, matériel) reste inchangé
**entre** les 2 lectures d'un même cycle, seule la pause **après** le cycle est configurable.
Vérifié en conditions réelles : ~33s entre deux lectures d'un même compteur avec la valeur par
défaut.

---

## 6. Publication MQTT et Découverte HA

### 6.1 `ha-publisher.js` — nouveau, remplace `hateleinfo2.js`

L'original publiait directement sur `homeassistant/sensor/...` avec des libellés français fixes
("Intensité", "Puissance Apparente"...). La version dimotic-ha publie sur
`<discoveryPrefix>/sensor/...` (défaut `homeassist`, jamais `homeassistant` directement — même
convention que `nommage`/`rpigpio`) avec `device.name = "<quoi>---<lieu...>"` par compteur, pour
que **nommage** (pipeline existant, aucune modification requise) assigne automatiquement la bonne
area et le bon quoi.

### 6.2 Capteurs publiés par compteur

| Clé TIC | Libellé | Unité | `device_class` | `state_class` |
|---|---|---|---|---|
| `IINST` | Intensité | A | `current` | `measurement` |
| `PAPP` | Puissance apparente | VA | `apparent_power` | `measurement` |
| `BASE` | Index base | Wh | `energy` | `total_increasing` |
| `HCHC` | Index heures creuses | Wh | `energy` | `total_increasing` |
| `HCHP` | Index heures pleines | Wh | `energy` | `total_increasing` |

**Amélioration par rapport à l'original** : `state_class` ajouté (absent avant), nécessaire pour
qu'un capteur soit exploitable dans le tableau de bord Énergie de HA. Un compteur en tarif "Base"
n'aura jamais `HCHC`/`HCHP` dans ses trames (et réciproquement) — le capteur HA correspondant reste
simplement sans valeur, pas d'erreur.

### 6.3 Un `device` HA par compteur

`device.identifiers: ["teleinfo_<adco>"]` — chaque compteur est un device HA distinct, ses 5
capteurs groupés dessous. État publié en un seul message JSON combiné par lecture
(`<baseTopic>/state`), pas un message par capteur.

### 6.4 Réabonnement au birth message HA

`ha-publisher.js` s'abonne à `homeassistant/status` (topic réel de HA, indépendant de
`discoveryPrefix`) et republie la découverte de tous les compteurs déclarés à chaque passage à
`online` — même mécanisme que RFXCOM/nommage (`techniques-socle-ha-mqtt_specs` §8.5.4bis).

### 6.5 ⭐ Présence de l'agent (LWT + battement de cœur) — nouveau v1.1, 16/08/2026

Contrairement à `rpigpio` (dont l'agent mqtt-io publie déjà nativement un LWT réutilisable, voir
`fonctionnelles-rpigpio_specs` §7.3), l'agent RPi1 (`device-agent/ha-publisher.js`, JS brut, pas de
build — ARMv6/Node12) n'avait **aucun** mécanisme de présence — ajouté de toutes pièces :
- **LWT** : option `will` posée à la connexion MQTT (`mqtt.connect(url, { will: {...} })`), topic
  `teleinfo/agent/status`, payload JSON `{status: 'offline', timestamp}`, retenu (`retain: true`,
  QoS 1).
- **Battement de cœur** : `publishPresence()` (payload `{status: 'online', timestamp}`, même topic,
  retenu) appelée immédiatement à la connexion puis toutes les **30s** (`setInterval`). Choix d'un
  payload JSON avec timestamp plutôt qu'un simple `"online"`/`"offline"` : un LWT seul ne donne
  qu'un état binaire, jamais de "dernier contact" récent tant que l'agent reste connecté longtemps
  sans redémarrer — le timestamp du battement permet de le calculer côté consommateur.
  ⚠️ Le timestamp du LWT **lui-même** reste figé au moment de l'enregistrement (`connect()`), pas
  du déclenchement réel du LWT par le broker — limite MQTT connue, sans effet pratique ici puisque
  c'est le battement de cœur, pas le LWT, qui porte l'information "dernier contact" exploitée.
- **Anti-empilement** : l'intervalle précédent est explicitement nettoyé (`clearInterval`) avant
  d'en reposer un nouveau à chaque reconnexion — évite d'empiler des battements en cas de
  coupures/reconnexions répétées du broker.

**Côté dimotic-ha** : `TeleinfoService.connectAgentPresence()` — même patron que `RpigpioService`
(`fonctionnelles-rpigpio_specs` §7.3), s'abonne en lecture seule à `teleinfo/agent/status`, parse le
JSON, met à jour `agentOnline`/`agentLastSeenAt`. Dashboard : champs "Agent RPi1" (En ligne/Hors
ligne/Inconnu) et "Dernier contact".

**⭐ Vérifié en conditions réelles (16/08/2026, accord explicite utilisateur — RFXCOM déjà branché
sur cette machine, seul le RPi1 restait à toucher)** : redéployé via le bouton "Générer et déployer"
existant (`DeployService.ts`, aucun nouveau mécanisme de déploiement — copie tous les fichiers
`device-agent/`, dont le `ha-publisher.js` modifié), service systemd redémarré avec succès (`statut:
active`), lecture réelle des 2 compteurs confirmée (`journalctl` sur le RPi1). Battement de cœur
reçu et exploité de bout en bout : `agentOnline: true`, `agentLastSeenAt` se met à jour toutes les
30s pile, observé en direct sur le tableau de bord — la seule implémentation de présence/heartbeat
de cette session vérifiée avec du vrai matériel (contrairement à `rpigpio`/`ha2`, voir
`fonctionnelles-rpigpio_specs` §7.3).

---

## 7. Déploiement SSH + systemd

### 7.1 `DeployService.deploy()` — séquence

1. Copie `device-agent/*.js` + `package.json` vers `target.remoteDir` (SCP).
2. Écrit `config.yaml` généré (SSH, `tee`).
3. `ensureNodeModules()` — voir §7.2.
4. `copyBundledPureJsDeps()` — copie `js-yaml`/`argparse` directement depuis ce dépôt (SCP).
5. Écrit l'unité systemd, `daemon-reload && enable && restart`, vérifie `is-active`.

### 7.1bis Socle SSH/SCP partagé (⭐ nouveau v1.2, 22/08/2026)

`runSsh`/`runScp`/`shellQuote`/`expandHome` viennent désormais de
`applications/core/src/infrastructure/remote/SshClient.ts` (exporté via `core/exports.ts`) — jusque
là réimplémentés quasi à l'identique dans `teleinfo` et `rpigpio` (constaté en comparant les deux
fichiers). `DeployResult` reste défini localement dans `DeployService.ts` (forme identique à
`RemoteOpResult` du socle, avec un type `step` plus précis propre à ce module).

`start()`/`stop()`/`restart()` (⭐ v1.2) délèguent à un `SystemdUnitController` partagé
(`core/infrastructure/remote/RemoteUnitController.ts`, sans `sudo` — la connexion SSH vers le RPi1
se fait déjà en root) : `systemctl start|stop|restart target.serviceName`. Symétrique côté
`rpigpio`, qui utilise un `DockerContainerController` pour sa cible (Docker sur stfort) — la même
abstraction couvre les deux natures de cible. Pas encore exposés côté Socket.io/IHM (§9.2) : prêts
pour de futurs boutons "Démarrer"/"Arrêter"/"Redémarrer", en attendant les scripts distants annoncés
par l'utilisateur.

### 7.2 ⭐ Résolution des dépendances natives — deux approches abandonnées en conditions réelles

Le RPi1 cible dispose d'un `node_modules` **partagé** hérité de l'ancienne domotique
(`/home/domotique/node_applications/node_modules`, ~57 applications, 66 000+ fichiers) contenant
déjà `rpio@2.4.2`/`serialport@9.0.7` compilés et prouvés pour ce matériel exact (ARMv6, Node
v12.21.0).

- **`cp -r` du répertoire entier** — testé en conditions réelles : encore en cours après 13
  minutes pour ~10% des fichiers (carte SD lente, goulot sur le nombre de fichiers, pas la taille).
  Abandonné.
- **`npm install --production`** — testé en conditions réelles : lent (résolution réseau) et
  **risqué** — son algorithme de réconciliation (npm 6.x) a supprimé des paquets manuellement
  placés mais absents du `package.json` déclaré, en plein milieu d'une installation par ailleurs
  interrompue par timeout, laissant l'arbre de dépendances dans un état pire qu'avant. Conservé
  uniquement en dernier recours (`resolveDependenciesTargeted` échoue ET aucun `node_modules`
  partagé trouvé).

**Approche retenue** (`resolveDependenciesTargeted`) : résolution **ciblée**, module par module —
`node -e "require('x')"`, parser le nom du module manquant dans l'erreur `Cannot find module`,
copier **uniquement** ce module depuis le partage, retenter. Quelques dizaines de secondes au
total pour une dizaine de dépendances transitives, jamais de suppression. `js-yaml`/`argparse`
(absentes du partage, pures JS) copiées directement depuis ce dépôt plutôt que résolues sur la
cible.

### 7.3 Unité systemd générée

```ini
[Service]
Type=simple
WorkingDirectory=<remoteDir>
ExecStart=<nodeBinPath> <remoteDir>/main.js
Restart=always
RestartSec=5
User=root
```

`User=root` nécessaire : `rpio` requiert l'accès à `/dev/mem`. `nodeBinPath` pointe explicitement
vers le binaire Node déjà installé et prouvé sur la cible (`/usr/bin/node`), jamais un `node`
générique du `PATH` qui pourrait être une version incompatible.

---

## 8. Configuration

### 8.1 `data/teleinfo/config.yaml` — champs réels

| Champ | Type | Défaut | Utilisation |
|---|---|---|---|
| `target.host` | string | `''` | Hôte SSH du RPi1 |
| `target.sshUser` | string | `root` | Nécessaire pour `rpio` (`/dev/mem`) |
| `target.sshKeyPath` | string | `''` | Chemin **local** vers la clé privée SSH |
| `target.remoteDir` | string | `/opt/teleinfo` | Répertoire distant de l'agent |
| `target.nodeBinPath` | string | `/usr/bin/node` | Voir §7.3 |
| `target.serviceName` | string | `teleinfo` | Nom du service systemd |
| `gpio.pinA`/`gpio.pinB` | number | `11`/`12` | Pins physiques (BOARD) de la bascule |
| `serialPort` | string | `/dev/ttyAMA0` | Port série UART |
| `cycleIntervalMs` | number | `30000` | Voir §5.4 |
| `mqtt.host`/`mqtt.port` | string/number | `''`/`1883` | Broker que **l'agent** utilisera |
| `mqtt.discoveryPrefix` | string | `homeassist` | Voir §6.1 |

### 8.2 Formulaire générique ("Paramètres Techniques → TELEINFO")

Trois groupes : "Machine cible (RPi1)" (6 champs), "Câblage" (4 champs, dont `cycleIntervalMs`),
"Broker MQTT" (5 champs).

---

## 9. Interface Web et Socket.io

### 9.1 Tableau de bord (`presentation/index.html`, page "Compteurs" du menu)

- Carte statut : nombre de compteurs déclarés (0 à 2), machine cible, nom du service.
- Liste des compteurs (chaîne QUOI---OÙ, ADCO) — boutons Modifier/Supprimer.
- Bouton "➕ Nouveau compteur" désactivé au-delà de 2. Bouton "🚀 Générer et déployer" désactivé
  tant que les 2 compteurs ne sont pas déclarés.

### 9.2 Événements Socket.io

**Server → Client** (persistants : `teleinfo:status`, `teleinfo:compteurs:list`) :
```typescript
'teleinfo:status'          // { compteursCount, target: { host, serviceName }, agentOnline, agentLastSeenAt } — ⭐ v1.1
'teleinfo:compteurs:list'  // CompteurDefinition[]
'teleinfo:compteur:saved'
'teleinfo:compteur:deleted'
'teleinfo:remote-op:result' // { action, success, step?, error?, output? } — ⭐ v1.2, remplace teleinfo:deploy:result
'teleinfo:error'
```

**Client → Server :**
```typescript
'teleinfo:status:get'
'teleinfo:compteurs:list:get'
'teleinfo:compteur:save'    // { adco, quoi, lieu, ..., originalAdco? } — originalAdco pour une modification
'teleinfo:compteur:delete'  // { adco }
'teleinfo:remote-op'        // { action: 'deploy'|'start'|'stop'|'restart' } — ⭐ v1.2, remplace teleinfo:deploy
                             // (sans payload). Seul 'deploy' est branché côté serveur (§7.1bis) ; les 3
                             // autres répondent par une erreur explicite tant qu'aucun bouton IHM ne les déclenche.
```

---

## 10. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| Découpage de trame à un seul niveau (bug initial) | Aucune trame jamais reconnue malgré des données réelles reçues | Corrigé (§4.3) |
| Rythme de publication non throttlé (bug initial) | ~5s/compteur, jugé excessif pour du suivi énergétique | Corrigé (§5.4) |
| Exactement 2 compteurs supportés | Contrainte physique de la bascule GPIO à 2 positions — pas générique pour N compteurs | Accepté (conception) |
| `resolveDependenciesTargeted` suppose le `node_modules` partagé de l'ancienne domotique sur LA machine précise | Un déploiement vers un autre RPi1 sans cet historique retomberait sur `npm install` (lent/risqué, voir §7.2) | Connu, non généralisé |
| Agent tourne en `root` | Nécessaire pour `rpio`/`/dev/mem`, aucun sandboxing | Accepté |
| Aucun retrait de découverte MQTT si un compteur est modifié/supprimé | L'entité HA reste orpheline sous l'ancien ADCO — même limite qu'AREXX/rpigpio | Non corrigé |
| Aucune vérification que l'ADCO saisi correspond au compteur physiquement câblé | Seule la lecture réelle après déploiement valide/infirme la saisie | Accepté (contrôle a posteriori) |
| Seuls Base/HC-HP sont exploités | Autres champs TIC (IMAX, PTEC, MOTDETAT...) reçus mais ignorés | Accepté (hors périmètre demandé) |
| Timestamp du LWT figé à la connexion, pas au déclenchement réel (§6.5) | Sans effet pratique — c'est le battement de cœur, pas le LWT, qui porte "dernier contact" | Accepté (limite MQTT connue) |

---

## 11. Arborescence des Programmes

```
applications/teleinfo/
├── package.json, tsconfig.json
├── device-agent/                      # Déployé tel quel sur le RPi1 cible
│   ├── package.json                   # rpio@2.4.2, serialport@9.0.7 (versions prouvées), mqtt, js-yaml
│   ├── main.js
│   ├── teleinfo-reader.js
│   ├── teleinfo-service.js
│   ├── gpio-switch.js
│   ├── ha-publisher.js
│   └── teleinfo.service.template
├── src/
│   ├── domain/
│   │   ├── TeleinfoService.ts
│   │   ├── generator.ts
│   │   ├── DeployService.ts
│   │   ├── config-schema.ts, storage-schema.ts, socket-events.ts, index.ts
│   │   └── yaml/ConfigFileManager.ts
│   └── presentation/
│       ├── index.html, ts/app.ts    # Tableau de bord "Compteurs"
│       └── ts/global.d.ts
```

---

## 12. Annexes

### 12.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](nommage_specs_v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.30.md) ⭐
- [Spécifications Fonctionnelles Supervision Multi-Machines](fonctionnelles-supervisor_specs_v2.6.md)
  (§2.4 — architecture process séparé côté dimotic-ha, §11.5/§14.8 — présence de l'agent)
- [Spécifications Fonctionnelles RPIGPIO](fonctionnelles-rpigpio_specs_v1.3.md) (application sœur,
  même principe de paramétrage/déploiement, cible Docker, même mécanisme de présence d'agent §7.3,
  même socle SSH/SCP partagé depuis la v1.2/v1.3 — §7.1bis/§5.1bis)
- Code source d'origine : `/home/didier/ownCloud/workspace6/zdidnodeteleinfo/` (hors dépôt git,
  propriété de l'utilisateur)

### 12.2 Glossaire
| Terme | Définition |
|-------|------------|
| TIC | Télé-Information Client — protocole série des compteurs EDF |
| Mode historique | Version originale du protocole TIC (compteurs pré-Linky ou Linky configuré en compatibilité) |
| ADCO | Adresse du compteur — numéro de série unique, présent dans chaque trame |
| Trame longue | Trame contenant `OPTARIF` (option tarifaire), la seule exploitée par cette application |
| Carte de commutation ("carte CAN") | Matériel maison routant l'une des 2 lignes téléinfo vers l'UART unique du RPi1, selon l'état de 2 pins GPIO |
| LWT + battement de cœur (agent) | Présence de `ha-publisher.js` sur `teleinfo/agent/status`, ajoutée en v1.1 (§6.5) — LWT + republication JSON toutes les 30s |

### 12.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.2 | 2026-08-22 | Claude | **`DeployService.ts` migré sur le socle SSH/SCP partagé** `core/infrastructure/remote/` (§7.1bis) — mutualisé avec `rpigpio`, qui réimplémentait des primitives (`runSsh`/`runScp`/`shellQuote`/`expandHome`) quasi identiques. Protocole Socket.io uniformisé (§9.2) : `teleinfo:deploy`/`teleinfo:deploy:result` (sans payload) devient `teleinfo:remote-op`/`teleinfo:remote-op:result` (`{ action }`) — même mécanisme quelle que soit l'intervention distante, demande explicite de l'utilisateur en prévision de futurs scripts de start/stop/restart. `start()`/`stop()`/`restart()` ajoutés côté `DeployService`, délèguent à un `SystemdUnitController` partagé — non encore exposés en IHM. Ancienne version v1.1 archivée. |
| 1.1 | 2026-08-16 | Claude | Migration du composant dimotic-ha en process séparé (§2.4, `runsAsSeparateProcess`/`standalone.ts` — l'agent RPi1 lui-même reste un déploiement SSH+systemd distinct, sans rapport). Présence de l'agent RPi1 : LWT + battement de cœur ajoutés à `ha-publisher.js` (§6.5, nouveau) — **seule implémentation de présence/heartbeat de cette session vérifiée en conditions réelles** avec du matériel physique (redéploiement réel confirmé, `agentOnline`/`agentLastSeenAt` mis à jour toutes les 30s). Référence croisée techniques-socle mise à jour (v4.28→v4.30). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-12 | Claude | Première spécification. Application créée, déployée et déboguée en conditions réelles (2 compteurs EDF physiques, RPi1 réel) au cours de la session — couvre l'architecture, le protocole téléinformation, la bascule GPIO, la publication MQTT/découverte HA, le déploiement SSH+systemd (dont la leçon sur la résolution de dépendances natives), la configuration, l'UI/Socket.io. Deux bugs réels trouvés et corrigés documentés en détail (§4.3 découpage de trame, §5.4 throttling). |
