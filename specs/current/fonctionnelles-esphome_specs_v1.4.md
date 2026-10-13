# Spécifications Fonctionnelles - Module ESPHOME

*Version 1.4 - 13 Octobre 2026 — **réalisation de l'usine, du poseur et de la reconnaissance de la carte** : mot de passe OTA du poseur, ports API et OTA dans le manifeste et la pose, protocole OTA précisé (port de `espota2.py`), format lu d'`esptool flash-id`, limite de la clé API d'un appareil existant absent de HA, état de l'application. Version 1.3 : **manifeste du paquet (§4bis)** et **tailles connues après compilation (§5.5)** : flash et RAM mesurées, comparées à la fiche du modèle, refus avant envoi si le firmware ne tient pas (important quand un appareil change pour un modèle moins doté en RAM). Version 1.2 : **deux enregistrements distincts : le modèle de matériel (une fois par type de carte) et l'appareil (un exemplaire, avec sa MAC)** ; la reconnaissance de la carte (§5.4) propose de créer l'un et/ou l'autre. Version 1.1 : **décisions de l'utilisateur sur les points ouverts** : brokers par site (connexions propres), réservations DHCP pour les ESP de noisy, assembleur **renommé `esps-assemble`**, **reconnaissance de la carte avant le premier flash** (§5.4) ; protocole d'envoi à l'ESP tranché à l'essai. Version 1.0 : première version, avant tout code : écrite d'après `conception-esphome-assembleur_specs_v1.4.md` (décisions et plan de tests de l'utilisateur du 13/10/2026) et `guide-nouvelle-application_specs_v2.1.md`. L'assembleur (application `espdisplay` aujourd'hui, **qui deviendra `esps-assemble`**, voir §1.4) a sa propre spec (`fonctionnelles-espdisplay_specs`) ; cette spec couvre l'application **`esphome`** : l'**usine** et le **poseur**. Les points marqués ❓ (§12) attendent encore une décision ou un essai.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Configuration](#3-configuration)
4. [Messages MQTT](#4-messages-mqtt)
5. [Usine](#5-usine)
6. [Poseur](#6-poseur)
7. [Garde-fou : un seul agent actif](#7-garde-fou--un-seul-agent-actif)
8. [Interface](#8-interface)
9. [Secrets et sécurité](#9-secrets-et-sécurité)
10. [Plan de tests](#10-plan-de-tests)
11. [Arborescence prévue](#11-arborescence-prévue)
12. [Points ouverts](#12-points-ouverts)
13. [Historique](#13-historique)

---

## 1. Introduction

### 1.1 Objectif

`applications/esphome` fabrique et pose les firmwares des appareils ESP (ESP32, ESP8266, avec ou sans écran) à partir des **paquets** produits par l'assembleur (`espdisplay`) : elle les **compile** (usine), puis les **envoie à l'ESP et déclare l'appareil dans Home Assistant** (poseur). Elle remplace le script SSH `espdisplay-agent-run.sh`.

### 1.2 Une application, deux options

| Option | Rôle | Où | Dépend de |
|---|---|---|---|
| `usine` | récupère les sources, **compile**, crée les clés API, tient `secrets.yaml`, produit firmware et amorce | la machine qui héberge ESPHome (falbala, conteneur `esphome`) ; elle sert plusieurs sites | Docker (socket), dossier de configuration d'ESPHome |
| `poseur` | récupère le firmware, **l'envoie à l'ESP sur le réseau local du site**, déclare l'appareil au HA du site, vérifie | chaque site, machine toujours allumée (ha2, noisy2) | broker MQTT et HA du site |

Les deux options se **cochent séparément par machine**. Chez l'utilisateur : ha2 = poseur, falbala = usine ; chez noisy : noisy2 = poseur ; l'usine de falbala sert les deux sites. Sur toutes les machines, l'application est la **même** (mêmes fonctions partout, seule la configuration change).

### 1.3 Ce que l'application ne fait pas

- Elle n'**assemble** pas (c'est l'assembleur, §1.4) et ne génère pas les plans.
- Elle ne **lit pas** les plans de HA ; elle n'écoute **aucun événement « plans modifiés »** : tout part d'une demande volontaire.
- Elle n'utilise pas la **diffusion** entre instances (dispositif de sécurité et de reprise, pas de livraison) : la livraison se fait par « je demande, j'obtiens » (§5.2, §6.2).

### 1.4 Nom de l'assembleur (décision du 13/10/2026)

L'application d'assemblage, aujourd'hui `espdisplay` (trompeur : tous les appareils n'ont pas d'écran), est **renommée `esps-assemble`**. Le renommage se fait à l'étape 3 (assembleur) : dossier `applications/esps-assemble/`, `data/esps-assemble/`, `ESPS_ASSEMBLE_APP`, événements `esps-assemble:*`, sujet `dimotic/esps-assemble/<site>/appareils` (remplace `dimotic/espdisplay/<site>/appareils`). D'ici là, les textes de cette spec qui disent « l'assembleur » désignent `espdisplay`.

---

## 2. Architecture

### 2.1 Flux (rappel — détail dans la conception §4)

```
espdisplay (assembleur)            esphome / usine                    esphome / poseur
  paquet zip + message  ─jobs──►  récupère le zip, compile   ─pose──►  récupère le firmware
  conservé "jobs"                  crée la clé, message "pose"          l'envoie à l'ESP, déclare dans HA
        ▲                                                                       │
        └────────────── status (message conservé, journal) ◄────────────────────┘
```

Deux messages conservés (`jobs`, `pose`) disent **quoi prendre et où** ; le destinataire les supprime après prise en charge. Une machine éteinte n'empêche rien : le message attend.

### 2.2 Composants (`applications/esphome/src/domain/`)

| Fichier | Rôle |
|---|---|
| `index.ts` | déclaration `ESPHOME_APP` (`ApplicationModule`), factory ; `runsAsSeparateProcess: true` |
| `config-schema.ts` | schéma Zod de la configuration (§3) |
| `messages.ts` | types et validation des messages MQTT versionnés (§4) |
| `EsphomeService.ts` | orchestration : démarre les options actives, expose l'état à l'UI |
| `factory/FactoryService.ts` | usine : boucle des demandes, file d'attente (une compilation à la fois) |
| `factory/DockerApi.ts` | requêtes HTTP sur le socket Docker (`exec`, `inspect`) — pas de client Docker dans l'image |
| `factory/SecretsStore.ts` | lecture/écriture de `secrets.yaml` (création de clés API, wifi par site) |
| `factory/PackageFetcher.ts` | téléchargement et vérification du zip (somme de contrôle) |
| `installer/InstallerService.ts` | poseur : boucle des poses, tentatives |
| `installer/OtaClient.ts` | protocole de mise à jour d'ESPHome vers l'ESP (❓ §12.1) |
| `installer/HaDeclarer.ts` | déclaration dans HA (flux `esphome`) et vérification |
| `presence.ts` | présence conservée avec testament, garde-fou (§7) |
| `MqttSites.ts` | connexions aux brokers des sites (§3.3) |
| `socket-events.ts` | événements Socket.io de l'interface |

### 2.3 Dépendances sur le cœur (déjà livrées au socle v4.45)

- **Route de lecture** `GET /api/apps/:appId/partage/<chemin>` (dossier `data/<appId>/machine_partage/`) : l'usine y publie les firmwares ; l'assembleur y publie les paquets.
- **« Interroger HA »** générique (`HaWsClient.callWs` / `callRest`, via `HaBridgeClient`) : utilisé par le poseur pour vérifier et déclarer.
- **Port du dev forcé à 8088** (`DIMOTIC_WEB_PORT`) pour les essais.

---

## 3. Configuration

Fichier `data/esphome/config.yaml` (objet nu, comme les autres applications). Aucun secret : les mots de passe MQTT et jetons sont dans le fichier des secrets du cœur (`secrets_config.yaml`) ou, pour les valeurs propres à ESPHome, dans le `secrets.yaml` d'ESPHome.

### 3.1 Commun

```yaml
site: stfort                       # site de cette machine (sujets MQTT, §4)
adresseJoignable: 192.168.1.26:8087   # adresse de cette instance vue des AUTRES sites (défaut : adresse locale + port web)
```

### 3.2 Option `usine`

```yaml
usine:
  actif: true
  esphome:
    conteneur: esphome                     # conteneur ESPHome à commander
    dossierConfig: /esphome-config         # dossier d'ESPHome monté dans l'instance (/docker/esphome/config sur falbala)
    image: esphome/esphome:2025.11.2       # version figée, montée de version volontaire
    socketDocker: /var/run/docker.sock
  sites:                                   # sites servis par cette usine
    - id: stfort
      mqtt: { hote: 192.168.1.51, port: 1883 }       # broker du site (utilisateur/mot de passe dans les secrets)
    - id: noisy
      mqtt: { hote: 10.10.10.3, port: 1883 }         # par le VPN
  conservation: { revisions: 5, nettoyageJours: 30 }
  premierFlash: { peripherique: /dev/ttyUSB0, reconnaissance: true }   # carte branchée sur la machine de l'usine ; reconnue avant tout flash (§5.4)
```

### 3.3 Option `poseur`

```yaml
poseur:
  actif: true
  mqtt: { hote: 127.0.0.1, port: 1883 }    # broker du site (celui de l'application nommage/core)
  tentatives: { intervalleMinutes: 5, dureeMinutes: 60 }
  motDePasseOta: ""          # mot de passe OTA des ESP du site (ota_password) — champ masqué, jamais dans un message
```

Le poseur utilise la **liaison HA du cœur de son instance** (aucun jeton d'un autre HA).

### 3.4 Interface de configuration

Formulaire générique « Paramètres Techniques → ESPHOME » (`configUi`), avec les deux cases `usine.actif` / `poseur.actif`. Application **désactivée par défaut** à l'arrivée (règle du cycle de vie), activée depuis *Gestion des applications* — à chaud.

---

## 4. Messages MQTT

Tous en JSON avec les champs communs : `v` (version du format, `1`), `site`, `appareil`, `revision` (entier croissant), `at` (date ISO). **Messages conservés** (retain) sauf mention. Chaque message reste **sur le broker de son site** (sites étanches).

| Sujet | Émetteur | Contenu propre | Supprimé par |
|---|---|---|---|
| `dimotic/esphome/<site>/jobs/<appareil>` | assembleur | `action` (`amorce` \| `firmware`), `origine` (adresse de l'assembleur), `paquet` (adresse du zip), `sha256` | l'usine, **après** récupération réussie et dépôt chez ESPHome ; ou l'assembleur (annulation) |
| `dimotic/esphome/<site>/pose/<appareil>` | usine | `firmware` (adresse), `sha256`, `tailleOctets`, `esp` (adresse de l'ESP, tirée du manifeste), `portApi` (6053) et `portOta` (3232, du manifeste), `nomAffichage`, `cle` (clé API, **visible une fois**, seulement pour un appareil neuf), `options` (ex. `autoriserAppelsService: true`) | le poseur, après prise en charge ; ou l'assembleur (annulation) |
| `dimotic/esphome/<site>/status/<appareil>` | usine puis poseur | `etat`, `detail` (fin du journal), `versionFirmware`, `mesures` (flash et RAM utilisées, §5.5) | jamais (état courant) |
| `dimotic/esphome/agent/<machine ESPHome>` | usine | `instance`, `port`, `heure` ; **testament** = hors ligne | testament |
| `dimotic/esphome/<site>/poseur` | poseur | idem | testament |
| `dimotic/esps-assemble/<site>/appareils` | assembleur | liste des appareils (nom, pages de plans oui/non) | — |
| `dimotic/esphome/<site>/demande-generer` (non conservé) | HA (panneau Plans) | `appareil` | — |

**États de `status`** : `en_attente`, `recuperation`, `compilation`, `pret_a_poser`, `envoi`, `verification`, `termine`, `echec`.

**Règles** : une demande de révision **plus ancienne** que celle déjà traitée est ignorée et journalisée ; une plus récente **remplace** la précédente non encore prise (même sujet conservé) ; l'annulation est un message vide conservé sur `jobs` ou `pose`.

---

## 4bis. Manifeste du paquet (zip)

Le paquet produit par l'assembleur contient un fichier `manifest.json` que l'usine lit : c'est de lui, et non du message de demande, que viennent les informations de l'appareil dont la pose a besoin.

```json
{
  "v": 1,
  "appareil": "haplan-display",
  "nomAffichage": "Plan HAPLAN",
  "revision": 7,
  "assemble": "2026-10-13T18:00:00+02:00",
  "modele": { "id": "sunton-8048s070c", "puce": "esp32-s3", "flash": "16MB", "cadre": "esp-idf" },
  "esp": { "adresse": "192.168.1.40", "port": 6053, "portOta": 3232 },
  "options": { "autoriserAppelsService": true },
  "wifi": ["stfort"],
  "fichiers": { "haplan-display.yaml": "<sha256>", "bibliotheque/…": "<sha256>" }
}
```

L'usine **refuse** un paquet dont le manifeste est absent, invalide, ou dont une somme de contrôle de fichier ne correspond pas. `modele` sert à la reconnaissance de la carte (§5.4) et au contrôle des tailles (§5.5). `esp.adresse` est une adresse fixe ou une **réservation DHCP** (les ESP de noisy). Le format complet, avec les fiches de modèle et d'élément, est fixé par la spec de l'assembleur (étape 3).

---

## 5. Usine

### 5.1 Déroulement d'une demande

1. **Réception** : abonnement aux sujets `jobs/#` de chaque site servi. À la connexion, les demandes conservées en attente sont traitées (falbala éteinte : elles attendent).
2. **Une compilation à la fois** (file par ordre d'arrivée). État `recuperation`.
3. **Récupération du paquet** : `GET` à l'adresse `paquet` (via VPN pour un autre site), **vérification de `sha256`**. Échec ⇒ la demande **reste** (nouvelle tentative), état `echec` si répété.
4. **Dépôt** des sources dans `dossierConfig/<appareil>/` (remplacement atomique ; 5 dernières révisions gardées) ; **suppression de la demande** (message vide conservé) — seulement maintenant.
5. **Clé API** : si `api_<appareil>` est **absent** de `secrets.yaml`, génération d'une clé aléatoire et écriture sous `api_<appareil>` ; **un appareil existant ne reçoit jamais de nouvelle clé** (reprise de haplan-display, poele-display, hasat4/5 sans réappairage).
6. **Compilation** (`compilation`) par `exec` dans le conteneur ESPHome (API Docker) : `esphome compile <appareil>.yaml`. Journal conservé ; fin du journal dans `detail`. **Les tailles sont relevées et contrôlées** (§5.5) avant toute publication.
7. **Publication** : dépôt du firmware dans `machine_partage/firmwares/<appareil>/<revision>/`, puis message `pose` (`pret_a_poser`).
8. **Amorce** (`action: amorce`) : compile l'amorce **du modèle de matériel** (même découpage de la flash que le firmware final) ; si une carte est branchée sur la machine de l'usine, elle est d'abord **reconnue** (§5.4) puis flashée par `esphome upload … --device <peripherique>` (premier flash par USB) ; sinon l'amorce reste téléchargeable pour un flasheur web.

### 5.2 Erreurs

| Cas | Comportement |
|---|---|
| Compilation ratée | `echec` + fin du journal ; la demande est **supprimée** (refaire « Assembler ») |
| Firmware trop gros pour le modèle (§5.5) | `echec` explicite, rien n'est publié ; la demande est supprimée |
| Somme de contrôle fausse | paquet rejeté, demande conservée, `echec` après 3 essais |
| Révision périmée | ignorée, journalisée |
| Une autre usine pour la même machine ESPHome | aucune demande traitée (§7) |
| Docker / ESPHome injoignable | état de l'usine « indisponible » dans l'interface, demandes conservées |
| Carte USB absente pour l'amorce | firmware d'amorce produit, flash non fait, message explicite |

### 5.3 Entretien

Après chaque compilation réussie : suppression des sources et firmwares au-delà des **5 dernières révisions** par appareil. Chaque jour : `esphome clean` des appareils non compilés depuis **30 jours** (le cache d'ESPHome pèse 1,8 Go).

### 5.4 Reconnaissance de la carte avant le premier flash (décision du 13/10/2026)

Pour ne **jamais flasher une carte qui n'est pas celle qu'on croit** (l'utilisateur a déjà dû rendre trois Sonoff Basic R4 achetés par erreur), l'usine **interroge la carte en lecture seule** avant tout premier flash, par `esptool` (fourni avec ESPHome, lancé dans le conteneur `esphome` : `chip_id`, `flash_id`) :

| Relevé | Sert à |
|---|---|
| **famille de puce** (ESP32, ESP32-S2/S3/C3, ESP8266) et révision | comparer à `plateforme` / `carte` de la fiche du matériel |
| **taille de la flash** (et fabricant) | comparer à `flash` de la fiche (partitions de l'amorce) |
| **adresse MAC** | mémorisée pour l'appareil (vérification dans HA, §6.1) |
| fonctions (Wi-Fi, Bluetooth, PSRAM, tension) | affichées à l'utilisateur |

**Deux enregistrements distincts** (conception §3.1) : le **modèle de matériel** (la fiche : puce, flash, périphériques, broches — **une seule fois** par type de carte) et l'**appareil** (un exemplaire physique, avec son nom unique, son nom d'affichage et sa **MAC** ; deux cartes identiques = un modèle, deux appareils). Une carte nouvelle peut demander les deux.

**Commande** : `esptool --port <port USB> flash-id` (esptool 5.1.0 de l'image ESPHome) lancée dans le conteneur ESPHome ; la sortie est lue de façon tolérante (lignes `Chip type`, `MAC`, `Detected flash size` ou `Flash Size`, `Features`). Le **format exact est à valider sur la carte d'essai**. Le bouton « Reconnaître la carte » de la page ESPHome (usine) lance la commande et affiche relevé et verdict (événement `esphome:carte:reconnaitre` → `esphome:carte:releve`). Les catalogues de modèles et d'appareils viendront de l'assembleur (étape 3) ; en attendant, tout verdict est « carte inconnue » ou « non conforme ».

**Verdict** (affiché dans l'interface, état `reconnaissance`), d'après le relevé :

| Relevé | Verdict | Proposition |
|---|---|---|
| MAC déjà enregistrée sur un appareil | **appareil connu** (« c'est `<appareil>` ») | reflasher ou remplacer le firmware de cet appareil ; contrôle de conformité avec son modèle |
| MAC inconnue, puce + flash correspondent à un modèle de la bibliothèque | **nouvel exemplaire d'un modèle connu** | **créer l'appareil** (nom, nom d'affichage, éléments), MAC mémorisée |
| MAC inconnue, aucun modèle ne correspond (ex. ESP32-C6, 8 Mo) | **carte inconnue** | **créer le modèle** (fiche pré-remplie : plateforme, variante, flash, cadre — à compléter : nom, périphériques, broches), **puis l'appareil** |
| carte choisie pour un appareil mais puce ou flash **différentes** de la fiche | **non conforme** | refus avec le détail (« détectée : ESP32-C3, 4 Mo ; la fiche attend ESP32-S3, 16 Mo ») ; aucun flash sans confirmation explicite |

Un modèle jamais utilisé ne reçoit son amorce (même découpage de flash que le firmware final) qu'une fois sa fiche **complète** ; une puce peu supportée par ESPHome (par exemple C6, `esp-idf` seulement) est signalée à la création du modèle.

La reconnaissance sert aussi **avant un achat** (carte d'essai ou de rechange branchée pour savoir ce qu'elle est). Elle n'écrit rien sur la carte.

### 5.5 Tailles connues après compilation (décision du 13/10/2026)

À la fin de la compilation, ESPHome affiche l'occupation **de la RAM** et **de la flash** (« used N bytes from M bytes ») et `firmware.bin` existe : la taille est **connue avec précision**. L'usine la relève (`mesures` : `flashUtilisee`, `flashDisponible`, `ramUtilisee`, `ramDisponible`, `tailleOctets` du fichier) et la compare à la **fiche du modèle** (taille de l'emplacement de mise à jour, RAM interne, présence de PSRAM) :

| Contrôle | Seuil | Effet |
|---|---|---|
| firmware plus gros que l'**emplacement de mise à jour** du modèle | > 100 % | **refus** : état `echec` « le firmware (N octets) ne tient pas dans l'emplacement (M octets) du modèle X » ; rien n'est publié |
| flash utilisée proche de la limite | > 90 % | **avertissement** affiché (le moindre élément ajouté ne tiendra plus) |
| RAM statique utilisée | > 80 % | **avertissement** ; > 100 % : l'édition de liens échoue déjà, message explicite |

**Changement de modèle** (un appareil réaffecté à un modèle moins doté en RAM ou en flash) : l'assembleur contrôle la compatibilité d'après la fiche **avant** de générer ; l'usine contrôle les tailles **réelles** après la compilation. L'interface affiche l'**historique des tailles par appareil** (révision par révision) : on voit le firmware grossir et l'effet d'un changement de modèle.

**Limite** : la RAM relevée est la RAM **statique** ; la mémoire dynamique à l'exécution (tas, tampons de l'écran LVGL, PSRAM) n'est pas mesurée à la compilation. Laisser de la marge ; la fiche du modèle porte les valeurs (`memoire` : RAM interne, PSRAM, `emplacementOta`).

---

## 6. Poseur

### 6.1 Déroulement d'une pose

1. **Réception** du message `pose` du site (état `recuperation`).
2. **Récupération du firmware** chez l'usine (adresse du message, par le VPN pour un autre site) et vérification de `sha256` **et de `tailleOctets`** (nombre d'octets reçus).
3. **Envoi à l'ESP** (`envoi`) sur le réseau local, par le **protocole de mise à jour d'ESPHome** implémenté dans l'application (TypeScript, sans ESPHome ni Python sur la machine) ; l'adresse et le port OTA sont ceux du message `pose`. Le protocole (versions 1 et 2) est un **port d'`espota2.py` d'ESPHome 2025.11.2** : octets magiques, version, fonctionnalités (compression gzip, authentification SHA256), défi-réponse avec le **mot de passe OTA du poseur** (§3.3), taille, MD5 de la charge, blocs de 8 Ko (un accusé par bloc en version 2), accusés de réception et de fin. Testé contre un faux ESP ; **à valider sur la carte d'essai**.
4. **Déclaration dans HA** (appareil neuf) : flux REST `esphome` (adresse, port API, **clé**, option « Autoriser les appels de service » si demandé). Un appareil déjà connu de HA (entrée ESPHome retrouvée par nom réseau, adresse ou titre) n'est pas redéclaré. **Limite** : la clé n'est dans le message de pose que pour un appareil créé par l'usine ; un appareil **déjà existant mais absent de HA** (hasat4) ne peut pas être déclaré automatiquement — l'échec le dit et indique `api_<appareil>` dans le `secrets.yaml` de l'usine.
5. **Vérification** (`verification`) : la **date de compilation** dans la version du firmware de l'appareil (registre d'appareils de HA) doit avoir changé ; sinon `echec`.
6. **Fin** : suppression du message `pose`, état `termine` (`versionFirmware`).

### 6.2 Erreurs

| Cas | Comportement |
|---|---|
| ESP injoignable | le message `pose` reste ; nouvelle tentative **toutes les 5 minutes pendant 1 heure**, puis `echec` |
| ESP refuse (mot de passe OTA, partition trop petite, MD5…) | `echec` avec la raison de l'ESP, le message est supprimé |
| Firmware envoyé mais appareil impossible à déclarer dans HA | `echec` : « firmware envoyé, mais déclaration dans HA impossible : … » |
| HA indisponible | tentative différée comme ci-dessus |
| Appareil déjà dans HA mais firmware inchangé | `echec` « le firmware n'a pas changé » |

Une pose à la fois par poseur.

---

## 7. Garde-fou : un seul agent actif

Chaque usine publie sa présence (message conservé + testament) sur `dimotic/esphome/agent/<machine ESPHome>` ; chaque poseur sur `dimotic/esphome/<site>/poseur`. Au démarrage, un agent qui trouve **un autre agent en ligne** pour la même cible **ne traite aucune demande** et l'affiche (« un autre agent est déjà actif : instance X, port Y »). Ce n'est **pas** de la sécurité, c'est une protection contre l'oubli (en particulier : instance réelle 8087 **et** instance de dev 8088 sur falbala). Pas de canal dev/prod dans les sujets, pas de signature : seule la somme de contrôle du zip subsiste (intégrité). Vider les demandes d'essai avant de réactiver l'agent réel.

---

## 8. Interface

Entrée de menu « ESPHome » (page propre), un seul onglet par option active :

- **Usine** : présence (OK / autre agent actif), **reconnaissance d'une carte branchée** (bouton « Reconnaître la carte », relevé et verdict, §5.4), file des demandes, compilation en cours avec **journal en direct**, liste des appareils (dernière révision, état, date), boutons **Annuler** (message vide), **Relancer**, **Télécharger le paquet** (zip) et **le firmware** (fichier), affichage **une seule fois** de la clé API d'un appareil neuf avec la consigne d'appariement.
- **Poseur** : poses en cours et historique du site, tentatives restantes, bouton **Annuler** ; état de la liaison HA.
- **Commun** : état de chaque message conservé du site, adresse joignable annoncée.

Transferts binaires par les routes génériques du cœur (§8 du guide). Aucun secret affiché sauf la clé API une fois.

---

## 9. Secrets et sécurité

- Les paquets et les messages **ne contiennent aucun secret** (le YAML référence `!secret …`).
- `secrets.yaml` (clés API `api_<appareil>`, wifi `wifi_<site>_ssid/password`, mots de passe d'OTA) reste **sur la machine ESPHome** ; la clé API d'un appareil neuf ne circule que dans le message `pose` de son site, une fois.
- Le **socket Docker** monté dans le conteneur de l'instance donne à l'application le contrôle de la machine : **accepté par l'utilisateur**, limité à la machine de l'usine (falbala).
- Pas de jeton HA d'un site sur une machine d'un autre site.
- Un appareil qui change de site **emporte les mots de passe des wifi déclarés** (choisir les sites dont le wifi figure dans l'appareil).

---

## 10. Plan de tests

Repris de la conception §12 ; lieu, critère et ordre :

| Étape | Où | Critère |
|---|---|---|
| Messages, schémas, révisions | unitaires (vitest) | demandes périmées ignorées, remplacement d'une demande par la suivante |
| Usine | falbala, dev 8088 (usine réelle désactivée) | suppression **seulement après** récupération réussie, création de clé **seulement** pour un nom absent, deux usines refusées ; compilation réelle de l'appareil d'essai |
| Poseur | falbala dev puis ha2 | récupération/vérification du firmware, envoi, tentatives ; l'appareil d'essai apparaît dans HA (`loaded`), la date de compilation change au second envoi |
| Tailles (§5.5) | unitaires : lecture de la sortie de compilation (flash, RAM), refus > 100 % de l'emplacement, avertissements 90 % / 80 %, historique par révision | un firmware volontairement trop gros pour un modèle fictif est refusé avant publication |
| Manifeste (§4bis) | unitaires : manifeste absent, invalide, somme de contrôle fausse | paquet refusé avec la raison |
| Reconnaissance de la carte | carte d'essai en USB | puce, flash et MAC relevés ; refus d'une carte d'un autre modèle que la fiche (essai avec une fiche volontairement fausse) ; aucune écriture sur la carte | verdict correct dans les 3 cas |
| Amorce | carte d'essai en USB | rejoint le wifi (liste + point d'accès de secours), déclarée dans HA, reçoit ensuite le firmware par le réseau |
| Bout en bout stfort | réel, avec l'utilisateur | « Générer » dans HA → assemblage → usine → poseur → écran à jour ; état `termine` |
| Bout en bout noisy | réel, par VPN | état `termine` côté noisy ; aucun message de noisy sur le broker de stfort |

Chaque étape : `npm run build` + tests de l'application, suite du cœur verte, commits atomiques.

---

## 11. Arborescence prévue

```
applications/esphome/
  package.json  tsconfig.json
  src/
    standalone.ts
    domain/ index.ts  config-schema.ts  messages.ts  EsphomeService.ts  presence.ts  MqttSites.ts  socket-events.ts
    domain/factory/    FactoryService.ts  DockerApi.ts  SecretsStore.ts  PackageFetcher.ts
    domain/installer/  InstallerService.ts  OtaClient.ts  HaDeclarer.ts
    presentation/      index.html  ts/app.ts
data/esphome/          config.yaml
data/esphome/machine_partage/   firmwares/<appareil>/<révision>/   (route de lecture du cœur)
```

---

## 11bis. État de la réalisation (13/10/2026)

| Élément | État |
|---|---|
| Configuration, messages, garde-fou, liaisons MQTT par site | fait, **vérifié sur les vrais brokers** (ha2 et noisy2 par le VPN) |
| Usine : paquet, manifeste, dépôt, clé API, compilation, tailles, firmware, pose | fait, **vérifié par une compilation réelle** dans le conteneur ESPHome (ESP32 de test) |
| Poseur : client OTA, déclaration et vérification dans HA, file et tentatives | fait, **testé en simulation seulement** (faux ESP, HA simulé) — à valider sur la carte d'essai |
| Reconnaissance de la carte (esptool) | fait, **format de sortie à valider** sur une carte réelle |
| Premier flash USB et amorce | **à faire** (l'amorce se compile déjà comme un firmware ; le flash USB est à écrire) |
| Entretien (purge du cache à 30 jours) et assembleur (paquets, fiches, catalogues) | **à faire** (étape 3) |

---

## 12. Points ouverts

**Tranchés le 13/10/2026** : accès MQTT par **connexions propres de l'application** (une par site servi, identifiants dans les secrets du cœur) ; ESP de noisy : **réservations DHCP** ; assembleur renommé **`esps-assemble`** (§1.4) ; premier flash : **reconnaissance de la carte avant tout flash** (§5.4).

1. ❓ **Protocole de mise à jour d'ESPHome en TypeScript** (poseur) : à vérifier **à l'essai** avec l'appareil d'essai. **Repli** si trop coûteux : `esphome upload` dans un petit conteneur dédié sur ha2/noisy2.
2. ❓ **Flasheur web** : utile en plus du flash depuis falbala ? (à voir après les premiers essais).
3. **Sujet de la demande « Générer »** (`dimotic/esphome/<site>/demande-generer`) : nom à confirmer à l'étape 4.
4. **Réveil de falbala** par le réseau (facultatif : la demande attend).
5. **Format des fiches** de matériels/éléments et du manifeste du zip : défini par la spec de l'assembleur (étape 3) — la fiche de matériel devra porter ce que la reconnaissance compare (famille de puce, flash).
6. **Version d'ESPHome** à figer : valeur à choisir au moment d'écrire le `compose.yaml` de l'instance de falbala.

---

## 13. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.4 | 2026-10-13 | Claude | Réalisation : mot de passe OTA du poseur (§3.3), ports API/OTA (§4, §4bis), protocole OTA précisé (§6.1), limite de la clé d'un appareil existant absent de HA, commande et format de la reconnaissance (§5.4), état de la réalisation (§11bis). v1.3 archivée. |
| 1.3 | 2026-10-13 | Claude | Manifeste du paquet (§4bis) ; tailles relevées après compilation et comparées à la fiche du modèle, refus avant envoi si le firmware ne tient pas, historique des tailles, cas du changement de modèle (§5.5) ; `tailleOctets` dans la pose. v1.2 archivée. |
| 1.2 | 2026-10-13 | Claude | Modèle de matériel et appareil enregistrés séparément ; la reconnaissance de la carte propose de créer l'un et/ou l'autre, reconnaît une MAC déjà connue (§5.4). v1.1 archivée. |
| 1.1 | 2026-10-13 | Claude | Décisions sur les points ouverts : connexions MQTT propres par site, réservations DHCP, assembleur renommé `esps-assemble` (§1.4), reconnaissance de la carte avant le premier flash (§5.4), test associé. v1.0 archivée. |
| 1.0 | 2026-10-13 | Claude | Première spécification fonctionnelle de l'application `esphome` (usine et poseur), avant tout code, d'après la conception v1.4. |
