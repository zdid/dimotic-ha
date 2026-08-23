# Spécifications Fonctionnelles - Module RPIGPIO

*Version 1.4 - 23 Août 2026*
*v1.4 : multi-cible standardisé (`target` singulier → `targets[]`, plafonné à 1 en pratique via
`.max(1)`), même patron que `teleinfo`/`arexx` (demande explicite : implémentation identique dans
les 3 apps) — voir §2.1/§5.1bis/§6.2/§7. Deux simplifications décidées avec l'utilisateur, propagées
au socle partagé `core/infrastructure/remote/` : accès aux machines cibles toujours en root direct
(`sudo NOPASSWD` jugé équivalent à root sur ce projet, champ `sshUser` retiré, plus de préfixe
`sudo` nulle part) et clé SSH par cible sous `data/rpigpio/ssh/<id>/` plutôt que `~/.ssh/...` (non
résolu dans le conteneur Docker — vérifié dans le Dockerfile/compose.yaml). Protocole Socket.io
`rpigpio:remote-op`/`rpigpio:remote-op:result` étendu avec `targetId` (§7.2). Nouvelle carte de
cible dans le tableau de bord (`TargetCards.js`, composant mutualisé avec teleinfo/arexx, servi par
core en `/js/ts/components/TargetCards.js`) — remplace l'ancien bloc "cible unique + bouton
Déployer" ; instructions de préparation SSH par cible désormais affichées directement dans l'IHM
(auparavant absentes pour rpigpio/teleinfo, seule AREXX les avait). `start`/`stop`/`restart` restent
câblés côté serveur (déjà le cas depuis la v1.3) et sont maintenant exposés par de vrais boutons.
Testé au navigateur (rendu de carte, formulaire array). Ancienne version v1.3 archivée.*
*Version 1.3 - 22 Août 2026*
*v1.3 : `DeployService.ts` migré sur le socle partagé `core/infrastructure/remote/` (SSH/SCP +
contrôleur Docker/systemd, §5.1/§9), mutualisé avec `teleinfo` qui réimplémentait des primitives
quasi identiques. Protocole Socket.io de déclenchement uniformisé (§7.2) : l'ancien couple
`rpigpio:deploy`/`rpigpio:deploy:result` devient `rpigpio:remote-op`/`rpigpio:remote-op:result`
(payload `{ action }`), le même quelle que soit l'intervention distante. `start`/`stop`/`restart`
exposés côté `DeployService`/`DockerContainerController` (docker start/stop/restart, via sudo) mais
pas encore câblés sur un bouton IHM — en attente des scripts distants annoncés par l'utilisateur.
Ancienne version v1.2 archivée.*
*Version 1.2 - 19 Août 2026*
*Déploiement en conditions réelles sur `stfort` (192.168.1.53) : 3 pins réels (relais/lumière,
radiateur, journuit — anciennement gérés en direct par un module `/dev/mem` de l'ancien système
`dimotic`), agent mqtt-io vérifié en ligne (§7.3, caveat "non vérifié" de la v1.1 levé). L'ancien
système continue de piloter ces 3 relais via son code métier inchangé, mais un pont de
compatibilité (hors périmètre de ce dépôt, voir §2.5) redirige désormais son accès GPIO bas niveau
vers ce module plutôt que vers le matériel directement. Correction de topic (§4.1bis, nouveau)
trouvée en vérification empirique. Ancienne version v1.1 archivée.*

*Version 1.1 - 16 Août 2026*
*Migration en process séparé (`fonctionnelles-supervisor_specs` v2.6, IPC — §2.4, nouvelle) +
présence de l'agent mqtt-io distant, lecture seule (§7.3, nouvelle) : `RpigpioService` s'abonne au
LWT natif de mqtt-io. Non vérifié en conditions réelles sur `ha2` (redéploiement du conteneur
mqtt-io non autorisé cette session — contrainte "pas de contact ha2/orangepi" en vigueur). Ancienne
version v1.0 archivée.*

*Version 1.0 - 12 Août 2026*
*Première spécification, écrite en même temps que le code (contrairement à AREXX/RFXCOM, pas a
posteriori) — application créée et déployée en conditions réelles au cours de la session du
12/08/2026.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
    - 2.4 [Process séparé (v1.1)](#24-process-séparé-nouveau-v11-16082026)
    - 2.5 [Pont de compatibilité avec l'ancien système (v1.2)](#25-pont-de-compatibilité-avec-lancien-système-nouveau-v12-19082026)
3. [Modèle de données](#3-modèle-de-données)
4. [Génération de la configuration mqtt-io](#4-génération-de-la-configuration-mqtt-io)
    - 4.1bis [Topic de commande réel — segment `output`](#41bis-topic-de-commande-réel--segment-output-nouveau-v12-19082026)
5. [Déploiement Docker](#5-déploiement-docker)
    - 5.1bis [Socle SSH/SCP partagé + multi-cible (v1.3/v1.4)](#51bis-socle-sshscp-partagé--multi-cible-v13-étendu-v14--22-23082026)
6. [Configuration](#6-configuration)
7. [Interface Web et Socket.io](#7-interface-web-et-socketio)
    - 7.3 [Présence de l'agent mqtt-io (v1.1, vérifiée v1.2)](#73-présence-de-lagent-mqtt-io-lwt-lecture-seule--nouveau-v11-16082026)
8. [Limites et Contraintes Connues](#8-limites-et-contraintes-connues)
9. [Arborescence des Programmes](#9-arborescence-des-programmes)
10. [Annexes](#10-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/rpigpio` est une IHM de **paramétrage uniquement** (demande utilisateur explicite —
"ce n'est que le paramétrage") pour des pins GPIO exposées via l'outil tiers **mqtt-io**
(`flyte/mqtt-io`, ex `pi-mqtt-gpio`) : saisie quoi/où par pin, numéro de pin (BCM), inversion,
direction (entrée/sortie), puis génération + déploiement du `config.yaml` de mqtt-io et de son
conteneur Docker sur une machine cible.

L'application ne parle **jamais** GPIO, MQTT ni HA directement — elle ne fait que produire de la
configuration et la déployer par SSH. Le pilotage matériel réel est entièrement délégué au
conteneur mqtt-io déployé.

### 1.2 Périmètre

- **Inclus** : CRUD de pins (quoi/où, numéro, inversion, direction), génération du `config.yaml`
  mqtt-io et d'un `compose.yaml`, déploiement SSH + Docker, bouton "Générer et déployer" depuis
  l'IHM.
- **Exclus** : lecture/écriture GPIO par cette application elle-même, gestion du cycle de vie du
  conteneur en dehors du déploiement (pas de supervision/health-check continu depuis l'IHM),
  paramétrage fin de mqtt-io au-delà de ce que l'IHM expose (ex : `pullup`/`pulldown` sur les
  entrées, `initial`/`timed_set_ms` sur les sorties — non exposés, valeurs par défaut de mqtt-io).

### 1.3 Pourquoi Docker ici et pas pour teleinfo (application sœur)

Décision explicite de l'utilisateur, confirmée après vérification technique : les machines cibles
utilisées (ha2, orangepi, stfort) sont suffisamment capables (Node 20 officiel disponible en
`arm64`/`armv7`) pour tourner en Docker, contrairement au RPi1 cible de `teleinfo` (ARMv6, aucun
build Node officiel récent — voir `fonctionnelles-teleinfo_specs` §1.3).

### 1.4 Déploiement réel actuel (⭐ v1.2, 19/08/2026)

L'application tourne **sur `stfort`** (192.168.1.53), au sein de son propre conteneur
`dimotic-ha` (retirée de son `disabledApps`) — pas depuis une autre machine ciblant stfort par
SSH. `targets` est donc **vide** dans sa configuration réelle : un futur changement de pins
nécessite un redéploiement manuel depuis une machine ayant un accès SSH root à stfort (voir §6.1).
⚠️ Cette limite (pas de clé stockée dans son propre volume) n'est plus une contrainte technique
depuis la v1.4 — `data/rpigpio/ssh/<id>/` (§5.1bis) résout justement ce problème pour du multi-app,
mais reste une décision opérationnelle non tranchée pour ce cas précis (self-déploiement sur la
même machine), pas rouverte par ce refactor.

3 pins réelles en production, toutes en sortie :

| `id` | `quoi` | `lieu` | Pin BCM | Inversé |
|---|---|---|---|---|
| `15` | lumiere | relais (précis : relais15) | 22 | non |
| `13` | radiateur | salle de bain du bas | 27 | oui |
| `7` | journuit | grenier (précis : petit grenier) | 4 | non |

`id` choisi comme la position **physique** du connecteur (pas un slug `quoi_lieu` comme documenté
en §3.1) — convention volontaire pour permettre au pont de compatibilité (§2.5) de calculer le
topic mqtt-io directement depuis le numéro qu'expose déjà l'ancien système, sans table de
correspondance à maintenir.

---

## 2. Architecture

### 2.1 Composants (`applications/rpigpio/src/domain/`)

| Fichier | Rôle |
|---|---|
| `RpigpioService.ts` | Orchestrateur : CRUD des pins, événements Socket.io, appel au déploiement |
| `generator.ts` | Construit le `config.yaml` mqtt-io et le `compose.yaml` du conteneur à partir des pins stockées |
| `DeployService.ts` | `deploy(target)` : écrit `config.yaml`/`compose.yaml` sur la cible, `docker compose up -d`, `docker restart` — SSH via le socle partagé (§5.1bis), root direct. `start(target)`/`stop(target)`/`restart(target)` : délèguent au `DockerContainerController` partagé. Cible passée explicitement (⭐ v1.4, `config.targets[]`) au lieu de `config.target` |
| `config-schema.ts` | Schéma Zod des réglages (cible SSH, broker MQTT utilisé par mqtt-io) |
| `storage-schema.ts` | Schéma Zod d'une pin (`PinDefinition`) |
| `yaml/ConfigFileManager.ts` | Chargement/sauvegarde atomique du YAML des pins (copie locale du pattern planificateur/AREXX) |
| `socket-events.ts` | Catalogue des événements Socket.io |
| `index.ts` | Manifeste du module (`RPIGPIO_APP`, `RPIGPIO_UI_METADATA`, `RPIGPIO_MENU_CONFIG`) |

**Manifeste** (`RPIGPIO_APP`) : `id: 'rpigpio'`, `type: 'standalone'`, `audience: 'configuration'`,
`requiredMqtt: false`, `requiredHaWs: false` — cette application ne se connecte elle-même à aucun
broker ni à HA, seulement à la machine cible par SSH.

### 2.2 Flux de données

```
IHM (liste des pins, formulaire quoi/où/pin/direction/inversion)
    |
    v (bouton "Générer et déployer")
generator.ts : PinDefinition[] + config → config.yaml (mqtt-io) + compose.yaml
    |
    v (DeployService, SSH)
Écriture sur la cible (target.hostDir) → docker compose up -d → docker restart
    |
    v (conteneur flyte/mqtt-io, sur la cible)
Lecture/écriture GPIO réelle + publication MQTT (état + découverte HA sur homeassist/)
    |
    v
nommage (pipeline taxonomie existant, aucune modification requise) → homeassistant/ → HA
```

### 2.3 Pourquoi un `device` par pin (pas un device mqtt-io unique)

**Point d'architecture non trivial** : mqtt-io regroupe par défaut **toutes** ses pins sous un seul
"device" HA — `mqtt.ha_discovery.name` et `mqtt_options.client_id` sont partagés par l'ensemble de
l'instance (`home_assistant.py::get_common_config`, code source de mqtt-io vérifié le 12/08/2026).
Publié tel quel, ce comportement casserait le parsing QUOI---OÙ de nommage, qui attend une entité =
un device distinct, pas un device unique pour toute la carte.

**Contournement** : chaque pin reçoit un override `ha_discovery.device` dans le `config.yaml`
généré (`generator.ts::buildHaDiscoveryDevice`) :
```yaml
ha_discovery:
  device:
    name: "<quoi>---<lieu...>"        # chaîne QUOI---OÙ, lue par nommage
    identifiers: ["rpigpio_<pinId>"]  # unique par pin
    manufacturer: RPI GPIO
    model: mqtt-io
```
mqtt-io fait un `dict.update()` (fusion non profonde) sur ce bloc — l'override **remplace**
entièrement le device par défaut pour cette pin, sans affecter les autres.

### 2.4 Process séparé (⭐ v1.1, 16/08/2026)

`RPIGPIO_APP.runsAsSeparateProcess = true` — l'application tourne dans son propre process OS,
démarré par `ProcessSupervisor` (`applications/rpigpio/src/standalone.ts`), plutôt qu'in-process
avec `core`. Architecture générique détaillée dans `fonctionnelles-supervisor_specs` (pas dupliquée
ici) — aucun changement du code métier propre à `RpigpioService.ts`, le contrat de factory
(`createRpigpioServiceWithConfig(eventBus, logger, configProvider)`) reste identique, seul
l'`eventBus` injecté change de nature (`IpcEventBus` au lieu de l'`EventBus` in-process).

### 2.5 Pont de compatibilité avec l'ancien système (⭐ nouveau v1.2, 19/08/2026)

Sur `stfort`, l'ancien système `dimotic` (`zdidnodesuperdimotic`) continue de gérer ces 3 relais
via son propre module GPIO (`zdidnodegpio`, historiquement basé sur le paquet npm `rpio`,
accès direct `/dev/mem`) — **son code métier n'a pas été touché**. Un pont
(`gpiobridge.js`, hors périmètre de ce dépôt, vit dans l'arborescence de l'ancien système sur
stfort) remplace uniquement l'accès bas niveau : `gpioserv.js` importe désormais `global.rpio`
au lieu du vrai module `rpio`, posé par `appmean.js` avant son chargement. `gpiobridge.js` expose
la même interface minimale que `rpio` (`init`/`open`/`close`/`write` — `read`/`poll` non
implémentés, aucun device GPIO en entrée n'étant déclaré sur ce site) et relaie les écritures vers
ce module en MQTT, sur le broker **local** de stfort (le GPIO physique n'étant pas déportable,
contrairement au port série RFXCOM, aucune chaîne de pont mosquitto inter-machines n'est
nécessaire ici — voir `techniques-socle-ha-mqtt_specs` §8.5.4bis pour le mécanisme équivalent côté
RFXCOM, qui lui en a besoin).

Même principe que le pont de compatibilité RFXCOM (`rfxcombridge.js`, voir `INSTALLATION.md` partie
B) — non documenté plus en détail ici pour la même raison : ce code vit en dehors de ce dépôt, sans
gestion de version formelle, et n'est pas un composant `dimotic-ha`.

**Vérifié en conditions réelles (19/08/2026)** : commande envoyée par `gpiobridge.js` (isolément,
hors du flux complet de l'ancien système) → relais réel confirmé activé/désactivé, état
correctement republié sur `mqttio/rpigpio/rpigpio_bridge_stfort/output/15`. Le trajet complet
depuis l'interface historique de l'ancien système (dimoweb) jusqu'au relais n'a en revanche pas été
vérifié (structure exacte du message de commande interne à l'ancien système non explorée).

---

## 3. Modèle de données

### 3.1 `PinDefinition` (`storage-schema.ts`)

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `id` | string | oui (généré ou choisi) | Slug `quoi_lieu` par défaut (dédupliqué si collision), utilisé comme `name` mqtt-io (topic) et suffixe de `identifiers` — **mais peut être choisi manuellement** (ex : position physique du connecteur, voir §1.4, §2.5) quand une convention externe l'exige |
| `quoi` | string | oui | Taxonomie QUOI |
| `lieuPrecis` | string | non | Taxonomie OÙ, niveau précis |
| `lieu` | string | oui | Taxonomie OÙ, niveau principal |
| `lieuPere` | string | non | Taxonomie OÙ, niveau parent |
| `lieuGrandPere` | string | non | Taxonomie OÙ, niveau grand-parent |
| `pin` | number | oui | Numéro de pin BCM (module `raspberrypi` de mqtt-io) |
| `direction` | `'input'` \| `'output'` | oui | Détermine la section mqtt-io (`digital_inputs`/`digital_outputs`) |
| `inverted` | boolean | oui (défaut `false`) | Niveau bas = actif |

`id` est généré côté serveur (`RpigpioService::generatePinId`) à partir de `slugify(quoi_lieu)`,
avec suffixe numérique en cas de collision, sauf saisie manuelle explicite (cas du pont de
compatibilité, §2.5, où l'`id` doit être calculable par un tiers externe sans table de
correspondance).

### 3.2 Persistance

`data/rpigpio/rpigpio-pins-v1.0.yaml` — tableau `pins: PinDefinition[]`, aucune limite de nombre
(contrairement à `teleinfo`, pas de contrainte matérielle de type "bascule à 2 positions"). Sur
stfort, ce fichier contient les 3 pins réelles de §1.4.

---

## 4. Génération de la configuration mqtt-io

### 4.1 Schéma vérifié contre le code source réel

Le schéma mqtt-io (`config.yaml` : `mqtt`, `gpio_modules`, `digital_inputs`, `digital_outputs`) a
été vérifié directement contre `docs_src/schema.json` et `home_assistant.py` du dépôt
`flyte/mqtt-io` le 12/08/2026 — pas deviné depuis une documentation tierce potentiellement obsolète.

### 4.1bis Topic de commande réel — segment `output` (⭐ nouveau v1.2, 19/08/2026)

**Vérifié empiriquement** (`mosquitto_pub`/`sub` contre un déploiement réel, 19/08/2026) : le topic
de commande d'une sortie mqtt-io est `<topic_prefix>/output/<name>/set` (état publié sur
`<topic_prefix>/output/<name>`) — le segment `output` est **fixe côté mqtt-io**
(`server.py::_init_digital_outputs::publish_callback`), pas configurable, et n'apparaît nulle part
dans `generator.ts` ni dans ce document avant cette version. Tout code externe qui construit ce
topic à la main (le pont de compatibilité, §2.5) doit l'inclure explicitement — erreur réelle
trouvée et corrigée dans `gpiobridge.js` avant sa mise en service. Payload confirmé : chaînes `ON`/
`OFF`.

### 4.2 `discoveryPrefix` — jamais `homeassistant/` directement

`mqtt.ha_discovery.prefix` généré à `homeassist` par défaut (configurable), jamais
`homeassistant` — même convention que `nommage`/zigbee2mqtt : la découverte doit transiter par le
pipeline nommage (taxonomie, contrôle quoi/où) avant d'atteindre le vrai préfixe HA.

### 4.3 `generateComposeFile()` — `user: '0:0'`

**Bug réel trouvé en déploiement réel** (voir §8) : `privileged: true` seul ne suffit pas pour
l'accès GPIO — l'image `flyte/mqtt-io` bascule sur un utilisateur non-root en interne (`USER
mqtt_io` dans son Dockerfile), qui n'a pas accès à `/dev/mem` malgré le mode privilégié du
conteneur (permissions du fichier, pas des capacités du conteneur). `user: '0:0'` dans le
`compose.yaml` généré court-circuite ce `USER` de l'image.

**Comportement au démarrage vérifié en conditions réelles (19/08/2026)** : sans `publish_initial`
(non exposé par l'IHM, jamais renseigné dans le `config.yaml` généré), mqtt-io **lit** l'état
existant du pin (`GPIO.setup(..., initial=-1)`, sémantique "ne rien piloter", puis lecture) et le
republie — il ne force **aucun** niveau au démarrage. Comportement volontairement conservé tel
quel : ne pas exposer `initial` dans l'IHM évite qu'une source de vérité concurrente (ce module)
impose un état qui pourrait contredire celui attendu par un système tiers gérant encore le même
pin (cas du pont de compatibilité, §2.5).

---

## 5. Déploiement Docker

### 5.1 `DeployService.deploy(target)` — séquence

Prend désormais une cible précise (`RpigpioTargetConfig`, tirée de `config.targets[]` par
`RpigpioService.handleRemoteOp(targetId, action)`, §7.2) plutôt que `config.target` singulier
(⭐ v1.4). Séquence inchangée, mais sans `sudo` (⭐ v1.4, accès root direct — voir §5.1bis) :

1. Écrit `config.yaml` sur `target.hostDir` (SSH, `tee`).
2. Écrit `compose.yaml` sur `target.hostDir` (idem).
3. `cd target.hostDir && docker compose up -d` — crée le conteneur au premier déploiement,
   sans effet si sa définition n'a pas changé.
4. `docker restart target.containerName` — **nécessaire à chaque déploiement** : `docker
   compose up -d` ne redémarre PAS automatiquement un conteneur suite à un simple changement de
   contenu d'un fichier bind-monté (`config.yaml`), seulement suite à un changement de la
   définition du service elle-même. Sans ce restart explicite, un nouveau `config.yaml` déployé
   resterait sans effet tant que le conteneur n'est pas relancé manuellement.
5. `docker inspect --format '{{.State.Status}}'` — statut retourné à l'IHM.

Sur stfort, `targets` est vide (§1.4) — cette séquence n'est aujourd'hui déclenchable que depuis
une autre machine ayant un accès SSH root à stfort, pas depuis l'IHM de stfort elle-même.

### 5.1bis Socle SSH/SCP partagé + multi-cible (⭐ v1.3, étendu v1.4 — 22-23/08/2026)

`runSsh`/`runScp`/`shellQuote`/`expandHome` viennent de
`applications/core/src/infrastructure/remote/SshClient.ts` (exporté via `core/exports.ts`) — jusque
là réimplémentés quasi à l'identique dans `rpigpio` et `teleinfo`. `DeployResult` reste défini
localement dans `DeployService.ts` (forme identique à `RemoteOpResult` du socle, avec un type
`step` plus précis propre à ce module).

`start(target)`/`stop(target)`/`restart(target)` délèguent à un `DockerContainerController`
partagé (`core/infrastructure/remote/RemoteUnitController.ts`) : `docker start|stop|restart
target.containerName`. Symétrique côté `teleinfo`, qui utilise un `SystemdUnitController` pour sa
cible (systemd, pas de Docker sur le RPi1) — la même abstraction couvre les deux natures de cible.
Exposés côté Socket.io/IHM depuis la v1.4 (§7.2) : boutons Déployer/Démarrer/Arrêter/Redémarrer
sur chaque carte de cible (`TargetCards.js`, §7.1).

**⭐ v1.4 — deux simplifications décidées avec l'utilisateur, appliquées à tout le socle partagé
(donc aussi à `teleinfo`/`arexx`)** :
- **Root direct partout, plus de `sudo`/compte `claude` dédié** : analysé ensemble — un compte
  non-root avec `sudo NOPASSWD` sur des commandes larges (`tee`, `docker`, déjà le cas ici) équivaut
  de toute façon à root (`sudo tee` sur un chemin arbitraire permet d'écraser `/etc/sudoers`) — la
  distinction n'apportait qu'un vernis. `RemoteTarget`/`RpigpioTargetConfig` n'ont donc plus de
  champ `sshUser` ; machines cibles considérées comme cassables mais facilement restaurables.
- **Clé SSH par cible sous `data/rpigpio/ssh/<id>/`, pas `~/.ssh/...`** : vérifié dans le
  Dockerfile/compose.yaml — le conteneur tourne en `USER node` (home `/home/node`, jamais persisté,
  aucun volume SSH monté), un chemin `~/.ssh/...` ne fonctionne qu'en dev local. `data/rpigpio/`
  est le seul emplacement qui persiste et reste identique dans les deux contextes. Une clé PAR
  CIBLE (pas partagée) : révoquer une cible compromise ne doit pas obliger à re-clef les autres.

### 5.2 Conteneur généré

`--privileged` + `network_mode: host` + `user: '0:0'` — même convention que le conteneur
`dimotic-ha` lui-même (Dockerfile racine du projet, déjà nécessaire pour l'accès USB dynamique de
RFXCOM). Volume : `./config.yml:/config.yml:ro` (chemin fixe attendu par l'image, `CMD python -m
mqtt_io /config.yml`).

---

## 6. Configuration

### 6.1 `data/rpigpio/config.yaml` — champs réels

| Champ | Type | Défaut | Utilisation |
|---|---|---|---|
| `targets` | array, `.max(1)` | `[]` | ⭐ v1.4, remplace `target` singulier — voir détail des champs ci-dessous. Plafonné à 1 (contrainte métier réelle), même patron que `teleinfo`/`arexx` |
| `targets[].id` | string | — | Identifiant libre de la cible (ex: `"stfort"`), unique (`.refine()`) — utilisé en IHM et dans le protocole Socket.io (§7.2) |
| `targets[].host` | string | `''` | Hôte SSH — peut être la machine locale elle-même (stfort, §1.4) |
| `targets[].sshKeyPath` | string | `''` | Chemin vers la clé privée SSH dédiée à CETTE cible — sous `data/rpigpio/ssh/<id>/` (§5.1bis), jamais `~/.ssh/...` |
| `targets[].hostDir` | string | `/docker/mqttio-rpigpio` | Répertoire distant (`compose.yaml` + `config.yml`) |
| `targets[].containerName` | string | `mqtt-io-rpigpio` | Nom du conteneur ET du service dans le compose |
| `targets[].image` | string | `flyte/mqtt-io:2.6.0` | Épinglée à une version numérotée, pas `:latest`/`:develop` |
| `mqtt.host`/`mqtt.port` | string/number | `''`/`1883` | Broker que **mqtt-io** utilisera (pas le socle) — broker local de la machine cible si l'application y tourne elle-même |
| `mqtt.user`/`mqtt.password` | string | `''` | Identifiants MQTT — en clair dans `data/rpigpio/config.yaml`, comme le reste du projet |
| `mqtt.topicPrefix` | string | `mqttio/rpigpio` | Topics état/commande mqtt-io (voir §4.1bis pour le segment `output` additionnel) |
| `mqtt.discoveryPrefix` | string | `homeassist` | Voir §4.2 |

### 6.2 Formulaire générique ("Paramètres Techniques → RPIGPIO")

Deux groupes : "Machines cibles" (champ unique `type: 'array'`, `itemFields` — liste avec
ajout/suppression dynamique, ⭐ v1.4, même pattern que `nommage/sources`, voir
`core/src/types/config.ts`) et "Broker MQTT" (5 champs, inchangé).

---

## 7. Interface Web et Socket.io

### 7.1 Tableau de bord (`presentation/index.html`, page "Pins" du menu)

- Carte statut : nombre de pins déclarées, présence de l'agent mqtt-io.
- Liste des pins (chaîne QUOI---OÙ, badge direction, badge "inversé" si applicable, numéro GPIO,
  `id`) — boutons Modifier/Supprimer par ligne.
- Bouton "➕ Nouveau pin" → modale (quoi, lieu précis/lieu/père/grand-père, numéro, direction,
  inversion).
- **⭐ v1.4** — section "Cible" : une carte par cible configurée (`TargetCards.js`, composant
  mutualisé avec `teleinfo`/`arexx`, servi par core en `/js/ts/components/TargetCards.js`) —
  remplace l'ancien bloc "cible unique + bouton Déployer". Chaque carte affiche les instructions de
  préparation SSH (`ssh-keygen`/`ssh-copy-id`, adaptées si Docker) puis 4 boutons
  Déployer/Démarrer/Arrêter/Redémarrer, avec résultat succès/erreur par carte.

### 7.2 Événements Socket.io

**Server → Client** (persistants : `rpigpio:status`, `rpigpio:pins:list`) :
```typescript
'rpigpio:status'        // { pinsCount, targets: {id,host,containerName}[], isRunningInDocker, agentOnline, agentLastSeenAt } — targets ⭐ v1.4 (remplace target singulier)
'rpigpio:pins:list'     // PinDefinition[]
'rpigpio:pin:saved'     // PinDefinition
'rpigpio:pin:deleted'   // { id }
'rpigpio:remote-op:result' // { targetId, action, success, step?, error?, output? } — targetId ⭐ v1.4
'rpigpio:error'            // { message } — désormais aussi utilisé pour les erreurs de sauvegarde/suppression de pin (alerte dédiée #pins-error)
```

**Client → Server :**
```typescript
'rpigpio:status:get'
'rpigpio:pins:list:get'
'rpigpio:pin:save'   // PinDefinition sans id (création) ou avec id (modification)
'rpigpio:pin:delete' // { id }
'rpigpio:remote-op'  // { targetId, action: 'deploy'|'start'|'stop'|'restart' } — targetId ⭐ v1.4.
                      // handleRemoteOp() cherche la cible via config.targets.find(t => t.id === targetId),
                      // répond par une erreur explicite si introuvable.
```

### 7.3 Présence de l'agent mqtt-io (LWT, lecture seule) — ⭐ nouveau v1.1, 16/08/2026

`RpigpioService` ouvre sa **première** connexion MQTT — strictement en lecture seule, uniquement
pour suivre la présence de l'agent mqtt-io distant. Invariant conservé (§1.1) : l'application ne
lit/n'écrit toujours jamais de GPIO ni ne publie jamais elle-même sur MQTT — mqtt-io reste seul
responsable du pilotage matériel et de toute publication.

Le LWT suivi est **celui déjà natif de mqtt-io** (`<mqtt.topicPrefix>/<bridgeInstance>/status`,
payload `"running"`/`"dead"`) — rien de nouveau à publier côté agent, mqtt-io le fait déjà de
lui-même. `connectAgentPresence()` s'y abonne au démarrage du service ; chaque message reçu met à
jour `agentOnline` (`payload === 'running'`) et `agentLastSeenAt` (horodatage de réception, pas de
timestamp porté par le payload mqtt-io lui-même).

`RpigpioStatus` étendu : `agentOnline: boolean | null` (`null` tant qu'aucun message n'a encore été
reçu), `agentLastSeenAt: string | null`. Dashboard : champs "Agent mqtt-io" (En ligne/Hors
ligne/Inconnu) et "Dernier contact".

**✅ Vérifié en conditions réelles (⭐ v1.2, 19/08/2026)** : déploiement réel sur stfort, `agentOnline`
confirmé `true` après démarrage du conteneur mqtt-io (`pinsCount: 3, agentOnline: true` observé sur
`rpigpio:status`). Le caveat "non vérifié" de la v1.1 (contrainte "pas de contact ha2/orangepi",
alors en vigueur) est levé.

---

## 8. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| `privileged: true` seul insuffisant pour `/dev/mem` | Trouvé en déploiement réel, corrigé par `user: '0:0'` (§4.3) | Corrigé |
| Aucun retrait de découverte MQTT si une pin est supprimée | L'entité HA reste orpheline (topic retenu jamais vidé) — même limite qu'AREXX | Non corrigé |
| Aucune détection de collision de numéro de pin | Deux `PinDefinition` pourraient viser le même GPIO physique sans avertissement | Non corrigé |
| Pas de suivi de dérive config↔déploiement | L'IHM ne sait pas si la configuration stockée correspond à ce qui tourne réellement sur la cible (seul le résultat du dernier clic "Déployer" est visible) | Non corrigé |
| `docker restart` à chaque déploiement | Coupure de service de quelques secondes (acceptable en usage domestique, pas de rolling update) | Accepté |
| `pullup`/`pulldown`/`initial`/`timed_set_ms` de mqtt-io non exposés | Fonctionnalités mqtt-io disponibles mais non paramétrables depuis l'IHM — `initial` volontairement non exposé (§4.3, comportement par défaut jugé plus sûr) | Accepté |
| Identifiants MQTT en clair dans `data/rpigpio/config.yaml` | Cohérent avec le reste du projet (aucun secret manager) | Accepté |
| Broker MQTT local de stfort sans authentification | N'importe quel process local peut publier une commande sur les 3 relais réels sans contrôle — même limite que RFXCOM sur le même broker | Non corrigé, connu |
| Pas de redéploiement automatique depuis stfort (§1.4/§5.1) | Décision explicite (pas de clé SSH stockée dans le volume de données de l'application) | Accepté |
| Trajet complet ancien système → relais non vérifié via l'interface historique (§2.5) | Seul un test isolé du pont a été fait, pas via dimoweb | Non vérifié |

---

## 9. Arborescence des Programmes

```
applications/rpigpio/
├── package.json, tsconfig.json
├── src/
│   ├── domain/
│   │   ├── RpigpioService.ts
│   │   ├── generator.ts
│   │   ├── DeployService.ts
│   │   ├── config-schema.ts, storage-schema.ts, socket-events.ts, index.ts
│   │   └── yaml/ConfigFileManager.ts
│   └── presentation/
│       ├── index.html, ts/app.ts    # Tableau de bord "Pins"
│       └── ts/global.d.ts
```

---

## 10. Annexes

### 10.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](nommage_specs_v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.30.md) ⭐
- [Spécifications Fonctionnelles Supervision Multi-Machines](fonctionnelles-supervisor_specs_v2.6.md)
  (§2.4/§7.3 — architecture process séparé, §11.5/§14.8 — présence de l'agent)
- [Spécifications Fonctionnelles TELEINFO](fonctionnelles-teleinfo_specs_v1.1.md) (application
  sœur, même principe de paramétrage/déploiement, cible non-Docker, même mécanisme de présence
  d'agent §6.5)
- `INSTALLATION.md` (racine du dépôt), partie B — pont de compatibilité RFXCOM, même principe que
  le pont GPIO (§2.5), pour la partie hors périmètre de ce dépôt
- Dépôt source de mqtt-io : `github.com/flyte/mqtt-io` (schéma vérifié le 12/08/2026, topic
  `output` vérifié le 19/08/2026 — §4.1bis)

### 10.2 Glossaire
| Terme | Définition |
|-------|------------|
| mqtt-io | Outil tiers (Python) exposant des GPIO sur MQTT, avec découverte HA intégrée — anciennement `pi-mqtt-gpio` |
| Pin | Une entrée ou sortie GPIO paramétrée (quoi/où, numéro, direction, inversion) |
| `hostDir` | Répertoire sur la machine cible contenant `compose.yaml` + `config.yml` déployés |
| LWT (agent) | Last Will and Testament MQTT natif de mqtt-io (`.../status`, `running`/`dead`) — suivi en lecture seule par `RpigpioService` depuis la v1.1 (§7.3) |
| Pont de compatibilité | Code hors périmètre de ce dépôt (legacy, sans gestion de version formelle) redirigeant l'accès matériel bas niveau de l'ancien système `dimotic` vers un pilote `dimotic-ha` — voir §2.5 (GPIO) et `INSTALLATION.md` partie B (RFXCOM) |

### 10.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.4 | 2026-08-23 | Claude | **Multi-cible standardisé** : `target` singulier → `targets[]` (`.max(1)`, id texte libre, même pattern que `teleinfo`/`arexx` et `nommage/sources`) — §2.1/§5.1/§6/§7. Deux simplifications décidées avec l'utilisateur, propagées au socle partagé : accès cible toujours en root direct (`sshUser` retiré, plus de `sudo` — `sudo NOPASSWD` jugé équivalent à root sur ce projet) et clé SSH par cible sous `data/rpigpio/ssh/<id>/` au lieu de `~/.ssh/...` (non résolu dans le conteneur Docker — vérifié Dockerfile/compose.yaml). Protocole `rpigpio:remote-op`/`rpigpio:remote-op:result` étendu avec `targetId`. Nouvelle carte de cible dans le tableau de bord (`TargetCards.js`, composant mutualisé rpigpio/teleinfo/arexx) avec instructions SSH par cible et 4 boutons Déployer/Démarrer/Arrêter/Redémarrer — remplace l'ancien bloc à cible unique. Testé au navigateur. Ancienne version v1.3 archivée. |
| 1.3 | 2026-08-22 | Claude | **`DeployService.ts` migré sur le socle SSH/SCP partagé** `core/infrastructure/remote/` (§5.1bis) — mutualisé avec `teleinfo`, qui réimplémentait des primitives (`runSsh`/`runScp`/`shellQuote`/`expandHome`) quasi identiques. Protocole Socket.io uniformisé (§7.2) : `rpigpio:deploy`/`rpigpio:deploy:result` (sans payload) devient `rpigpio:remote-op`/`rpigpio:remote-op:result` (`{ action }`) — même mécanisme quelle que soit l'intervention distante, demande explicite de l'utilisateur en prévision de futurs scripts de start/stop/restart. `start()`/`stop()`/`restart()` ajoutés côté `DeployService`, délèguent à un `DockerContainerController` partagé — non encore exposés en IHM. Ancienne version v1.2 archivée. |
| 1.2 | 2026-08-19 | Claude | **Déploiement réel sur stfort** (§1.4, nouveau) : 3 pins réelles (relais/lumière, radiateur, journuit — anciennement pilotées en direct par l'ancien système), `id` choisi manuellement (position physique) pour permettre un calcul de topic sans table de correspondance côté pont. **Pont de compatibilité avec l'ancien système** (§2.5, nouveau) : redirige l'accès GPIO bas niveau de `zdidnodegpio` vers ce module, même principe que le pont RFXCOM, non documenté en détail ici (hors périmètre du dépôt). **Correction de topic** (§4.1bis, nouveau) : segment `output` fixe côté mqtt-io, absent de `generator.ts` et non documenté avant cette version — trouvé et corrigé avant mise en service du pont. Comportement de démarrage de `initial` clarifié (§4.3) : lecture, pas écriture, par conception. Caveat "non vérifié" de la présence d'agent (§7.3) levé — vérifié en conditions réelles sur stfort. Application désormais déployée SANS moyen de se redéployer elle-même (décision explicite, §1.4/§5.1/§8). Ancienne version v1.1 archivée. |
| 1.1 | 2026-08-16 | Claude | Migration en process séparé (§2.4, `runsAsSeparateProcess`/`standalone.ts`, architecture détaillée dans `fonctionnelles-supervisor_specs` v2.6) — premier test grandeur nature du pontage UI Socket.io d'une app séparée. Présence de l'agent mqtt-io distant, lecture seule (§7.3, nouveau) : `RpigpioStatus` étendu (`agentOnline`/`agentLastSeenAt`), dashboard mis à jour. Non vérifié en conditions réelles sur `ha2` (redéploiement du conteneur mqtt-io non autorisé cette session). Référence croisée techniques-socle mise à jour (v4.28→v4.30). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-12 | Claude | Première spécification, application créée et déployée en conditions réelles (ha2) au cours de la session. Couvre l'architecture, le modèle de données, la génération de la configuration mqtt-io (device par pin), le déploiement Docker (bug `user:'0:0'` trouvé en conditions réelles), la configuration, l'UI/Socket.io, et les limites connues. |
