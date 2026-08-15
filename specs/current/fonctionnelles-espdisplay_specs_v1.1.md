# Spécifications Fonctionnelles - Module ESPDISPLAY

*Version 1.1 - 15 Août 2026*
*Met à jour la v1.0 : exécution à distance par SSH (§6.3) — nécessaire depuis que le bouton HAPLAN
"Déployer sur l'écran" est utilisé en production sur `ha2`, qui n'a ni python3 ni le conteneur
`esphome` (Pi4, RAM insuffisante, voir §6.2 déjà existant). Gagne aussi une configuration UI (§5.2)
et une entrée de menu, absentes jusque-là.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Communication Inter-Applications (EventBus)](#3-communication-inter-applications-eventbus)
4. [Pipeline Python](#4-pipeline-python)
5. [Configuration](#5-configuration)
6. [Choix d'Infrastructure Docker](#6-choix-dinfrastructure-docker)
    - 6.3 [Exécution distante par SSH (v1.1)](#63-exécution-distante-par-ssh-v11--bug-de-production-corrigé-le-14082026)
7. [Limites et Contraintes Connues](#7-limites-et-contraintes-connues)
8. [Arborescence des Programmes](#8-arborescence-des-programmes)
9. [Annexes](#9-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/espdisplay` orchestre le déploiement de firmware sur les écrans ESP (ESPHome/LVGL) du
projet — actuellement l'écran mural HAPLAN (ESP32-S3, voir `project_haplan_esphome_s3_display` en
mémoire de session), avec d'autres appareils ESP à venir (dont un thermostat de poêle actuellement
sous Tasmota, migration différée). Elle ne contient **aucune logique de génération de contenu** :
elle reçoit une demande (`{floorplanId}`), l'exécute via le pipeline Python déjà existant côté
HAPLAN (§4), et republie le résultat — un pur orchestrateur, délibérément mince.

### 1.2 Pourquoi une application séparée plutôt qu'intégrée à HAPLAN

Décision utilisateur (13/08/2026) : bien que le premier cas d'usage soit spécifique aux plans
HAPLAN, **d'autres appareils ESP sont prévus** (thermostat de poêle notamment) qui n'ont aucun lien
avec des plans de maison. Une application dédiée au déploiement d'écrans ESP, découplée de HAPLAN
par communication inter-applications (§3), évite de faire porter à HAPLAN une responsabilité qui ne
lui appartient pas et pose l'architecture pour les prochains appareils sans dépendre de HAPLAN.

### 1.3 Périmètre

- **Inclus** : écoute d'une demande de déploiement, exécution du pipeline Python en sous-processus,
  republication du résultat (succès/échec, sortie du pipeline, durée).
- **Exclus (volontairement, pour l'instant)** : configuration UI dédiée (aucun `configUi`/`menu`
  déclaré), OTA automatique après compilation réussie (le flash reste manuel,
  `docker exec esphome esphome run ... --device ...`), génération/fusion elle-même (appartient au
  script Python, propriété de HAPLAN — voir §4), gestion de plusieurs appareils ESP en parallèle
  (verrou unique côté HAPLAN, voir `fonctionnelles-haplan_specs_v1.2.md` §3.6), file d'attente de
  déploiements.

---

## 2. Architecture

### 2.1 Composants (`applications/espdisplay/src/domain/`)

| Fichier | Rôle |
|---|---|
| `EspDisplayService.ts` | Orchestrateur : écoute l'événement de déploiement, lance le sous-processus Python, republie le résultat |
| `config-schema.ts` | Schéma Zod (conteneur/répertoire Docker, chemin du script, binaire Python) |
| `index.ts` | Manifeste `ESPDISPLAY_APP` (métadonnées `AppService`) + factories |

**Manifeste** (`ESPDISPLAY_APP`) : `id: 'espdisplay'`, `type: 'standalone'`, `audience:
'configuration'`, `configurable: false`, `requiredMqtt: false`, `requiredHaWs: false`,
`configSection: 'espdisplay'` — aucun besoin de MQTT ni de WebSocket HA, cette application ne parle
qu'à l'EventBus et à un sous-processus local.

**Factory** : `createEspDisplayService(eventBus, logger, configProvider)` — 3 paramètres, comme
TELEINFO/RPIGPIO (pas de dépendance à `HaStructureRegistry`/`HaWsClient`).

### 2.2 Flux de données

```
HAPLAN (dashboard-app.ts, bouton "Déployer sur l'écran")
    |
    v (Socket.io: haplan:floorplan:deploy)
HaplanService.handleFloorplanDeploy
    |
    v (EventBus générique: espdisplay:deploy-floorplan { floorplanId })
EspDisplayService.handleDeployFloorplan
    |
    v (sous-processus)
python3 applications/haplan/tools/generate_esphome_floorplan.py <floorplanId> --compile
    |
    +--> génère widgets/image du plan (lit data/haplan/config-haplan-floorplans-v1.0.yaml)
    +--> fusionne dans applications/haplan/tools/esphome/haplan-display.yaml (template)
    +--> copie les assets dans /docker/esphome/config (§6)
    +--> docker exec esphome esphome compile /config/haplan-display.yaml
    |
    v (EventBus générique: espdisplay:deploy-result { floorplanId, ok, message, durationMs })
HaplanService (écouteur unique, voir fonctionnelles-haplan_specs_v1.2.md §3.6)
    |
    v (Socket.io: haplan:floorplan:deploy:result)
HAPLAN (bouton réactivé, résultat affiché)
```

Le flash effectif sur l'écran physique (OTA) **n'est pas déclenché automatiquement** par ce flux —
seule la compilation l'est (voir §1.3, limite acceptée pour cette première version).

---

## 3. Communication Inter-Applications (EventBus)

### 3.1 Pattern repris de l'existant

Aucun HTTP ni MQTT interne — comme `ArexxService`/`Evoo7Service` → `IntegrationBridge`
(`integration:bridge:register`), ESPDISPLAY communique avec HAPLAN via
`eventBus.emitGeneric`/`onGeneric` (voir `applications/core/src/application/EventBus.ts`), tous deux
injectés avec **la même instance** d'`EventBus` par `AppService` (un seul process Node pour toute la
plateforme — voir `techniques-socle-ha-mqtt_specs`). Noms d'événements **codés en dur des deux
côtés**, volontairement : aucune des deux applications n'importe l'autre, aucune dépendance de
compilation.

### 3.2 Événements

```typescript
// Écouté par ESPDISPLAY, émis par HAPLAN (ou tout autre appelant futur)
'espdisplay:deploy-floorplan'   // { floorplanId?: string } — absent = --all (tous les plans)

// Émis par ESPDISPLAY, écouté par HAPLAN
'espdisplay:deploy-result'      // { floorplanId?: string, ok: boolean, message: string, durationMs: number }
```

`message` contient les ~20 dernières lignes de la sortie combinée (stdout+stderr) du pipeline
Python — suffisant pour diagnostiquer un échec de compilation ESPHome sans avoir à consulter les
journaux du conteneur Docker séparément.

### 3.3 Verrouillage — responsabilité de l'appelant, pas d'ESPDISPLAY

ESPDISPLAY **ne maintient aucun verrou lui-même** : si deux événements `espdisplay:deploy-floorplan`
arrivent avant qu'un premier sous-processus ne se termine, les deux s'exécutent en parallèle (deux
`docker exec esphome esphome compile ...` concurrents sur le même conteneur — non testé, risque
réel de conflit sur le répertoire de build ESPHome partagé). Le verrou observé en pratique
(`deployInProgress`, un seul déploiement à la fois) est entièrement porté par **HAPLAN**, l'unique
appelant actuel — voir `fonctionnelles-haplan_specs_v1.2.md` §3.6. Un futur second appelant (ex:
thermostat de poêle) devrait soit réutiliser un verrou coordonné, soit attendre qu'ESPDISPLAY en
porte un lui-même (non fait, périmètre volontairement minimal pour cette v1.0).

---

## 4. Pipeline Python

### 4.1 Propriété : HAPLAN, pas ESPDISPLAY

`applications/haplan/tools/generate_esphome_floorplan.py` reste sous `applications/haplan/` —
HAPLAN est propriétaire des données de plan (`data/haplan/config-haplan-floorplans-v1.0.yaml`) et de
la logique de génération de widgets (classification d'entités, calcul de position, glyphes
Font Awesome — voir §9.2 de `fonctionnelles-haplan_specs_v1.2.md` pour la classification côté
TypeScript qu'elle reproduit). ESPDISPLAY **appelle** ce script en sous-processus (`node:child_process.spawn`),
il ne le possède pas et n'en connaît pas le contenu — seul le chemin (configurable, §5) et la
convention d'arguments (`<floorplanId>|--all --compile --esphome-container <nom> --esphome-config-dir <chemin>`)
sont un contrat partagé entre les deux applications.

### 4.2 Options `--merge`/`--compile` (ajoutées le 13/08/2026)

Avant cette session, la fusion du fragment généré dans le template ESPHome (`haplan-display.yaml`)
était faite à la main via des heredocs Python tapés à chaque itération pendant le débogage de
l'écran physique — fonctionnel mais non reproductible. Le script expose désormais :
- `--merge` : génère + fusionne (produit `<template>-merged.yaml` à côté du template).
- `--compile` : implique `--merge`, copie en plus le YAML fusionné + les assets (images, police,
  table de partitions) dans `--esphome-config-dir`, puis lance `esphome compile` dans le conteneur
  Docker désigné par `--esphome-container`.

Le nom de fichier déployé dans `--esphome-config-dir` est **le même que celui du template**
(`--template`, défaut `haplan-display.yaml`) — pas un nom `-merged` distinct : c'est ce nom de
fichier qui identifie l'appareil dans le tableau de bord ESPHome et dans l'intégration HA (device
"haplan-display-1" → configuration "haplan-display.yaml"). Un nom différent produirait un binaire
compilé qui ne correspond à aucun appareil apparié.

---

## 5. Configuration

### 5.1 `data/espdisplay/config.yaml` — champs réels

| Champ | Type | Défaut | Utilisation |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `esphomeContainer` | string | `esphome` | Nom du conteneur Docker déjà en service (§6) |
| `esphomeConfigDir` | string | `/docker/esphome/config` | Répertoire monté dans ce conteneur |
| `pipelineScriptPath` | string | `''` | Vide = résolu vers `applications/haplan/tools/generate_esphome_floorplan.py` (relatif à `PROJECT_ROOT`) |
| `pythonBin` | string | `python3` | Doit avoir PyYAML + Pillow installés (dépendances du script, hors runtime Node) |
| `remote.host` | string | `''` (v1.1) | Vide = exécution locale ; sinon délégation SSH, voir §6.3 |
| `remote.sshUser` | string | `didier` (v1.1) | |
| `remote.sshKeyPath` | string | `''` (v1.1) | Chemin de la clé privée dédiée, monté en volume dans le conteneur (voir §6.3) |

### 5.2 Configuration UI (v1.1)

`configurable: true`, `configUi: ESPDISPLAY_UI_METADATA` — menu "Paramètres Techniques > Écrans
ESP" (absent en v1.0). Deux groupes de champs : "Conteneur ESPHome" (les 4 premiers champs du
tableau ci-dessus) et "Machine distante (optionnel)" (les 3 champs `remote.*`). Ajouté après avoir
constaté que la configuration `remote.*`, mise en place à la main via SSH pour contourner
l'incident ha2 (§6.3), n'était consultable ni modifiable que par un accès direct à
`data/espdisplay/config.yaml` — aucune UI, pas même une entrée de menu.

---

## 6. Choix d'Infrastructure Docker

### 6.1 Conteneur `esphome` déjà existant, réutilisé tel quel

`espdisplay` ne gère **aucun cycle de vie Docker** — il suppose qu'un conteneur nommé (par défaut)
`esphome` (image `esphome/esphome:latest`, volumes `./config:/config`, `./cache:/cache`) tourne déjà
sur la machine où le process Node s'exécute, et se contente d'y faire des `docker exec`.

### 6.2 ⭐ Décision d'hébergement — essai réel sur ha2 (Pi4) abandonné le 13/08/2026

**Contexte** : avant de fixer l'hébergement définitif, un essai empirique a été fait sur `ha2` (le
Raspberry Pi 4 de production HA, 1.8 Go RAM total, ~885 Mo disponible avant tout test) — décision
explicite de l'utilisateur de vérifier plutôt que de supposer.

**Résultat** : le téléchargement/extraction du toolchain ESP-IDF (préalable à toute compilation, pas
encore la compilation elle-même) a suffi à saturer le swap (511 Mo, plein et stable). La compilation
réelle (`ninja`, 1794 objets) a progressé jusqu'à ~20% des objets avant de **stagner complètement** ;
une simple commande `free -h`/`uptime` a fini par ne plus répondre du tout, jusqu'à ce qu'une
**nouvelle** connexion SSH échoue dès l'échange de bannière — la machine hôte, qui fait tourner
Home Assistant en production, était devenue injoignable par thrashing mémoire. Le test a été
interrompu par un redémarrage électrique côté utilisateur.

**Un second essai sur `ia.local` (Raspberry Pi 5, 16 Go RAM) a été commencé** mais abandonné avant
compilation réelle (décision utilisateur de revenir à la machine de développement plutôt que de
poursuivre l'expérimentation d'hébergement) — **aucune conclusion positive n'a donc été établie
pour un Pi5**, seule l'**infaisabilité du Pi4/ha2** est un fait vérifié.

**Décision retenue** : le conteneur `esphome` reste sur la machine de développement locale
(`falbala`) — déjà prouvée fonctionnelle (plusieurs compilations réussies en 15-65s selon le cache,
flash OTA réel validé sur écran physique). `esphomeContainer`/`esphomeConfigDir` restent
configurables (§5) si cet hébergement devait un jour changer, mais **aucun mécanisme de bascule
automatique n'existe** — un changement de machine hôte est une reconfiguration manuelle.

### 6.3 Exécution distante par SSH (v1.1) — bug de production corrigé le 14/08/2026

**Symptôme constaté** : une fois le bouton HAPLAN "Déployer sur l'écran" (voir
`fonctionnelles-haplan_specs_v1.2.md` §8.9) utilisé depuis l'instance `ha2` réelle (pas seulement en
test local sur falbala), échec immédiat : *"impossible de lancer python3 : spawn python3 ENOENT"*.
Cause directe : `ha2` n'a, volontairement, ni `python3` ni le conteneur `esphome` (décision §6.2 —
Pi4, RAM insuffisante pour ESP-IDF). Le pipeline ne peut physiquement pas s'exécuter sur cette
machine.

**Correctif** : `EspDisplayService.runPipelineRemote()` — si `remote.host` (§5.1) est renseigné,
délègue l'exécution par SSH à la machine désignée plutôt que de lancer `python3` localement.

- **Un seul argument transmis** (l'identifiant de plan, ou `--all`) : la machine cible fait tourner
  une **commande SSH forcée** (`command="..."` dans `authorized_keys`, script
  `~/bin/espdisplay-agent-run.sh` côté cible) qui reconstruit elle-même l'appel complet du pipeline
  à partir de `$SSH_ORIGINAL_COMMAND` — la clé dédiée ne permet donc **rien d'autre** que ce
  pipeline précis, pas un accès shell général. Même niveau de restriction que le principe de
  moindre privilège déjà appliqué ailleurs dans ce projet (comptes de déploiement `claude-*`).
- Pas d'injection possible même sans validation de charset côté script : l'argument reçu est passé
  en un seul token `argv` à `python3` (jamais réinterprété par un shell), et
  `generate_esphome_floorplan.py` valide lui-même l'identifiant de plan (sort en erreur si inconnu).
- `StrictHostKeyChecking=accept-new` + `UserKnownHostsFile` pointé vers `data/espdisplay/` (volume
  persisté) plutôt que le défaut (`$HOME`, jamais persisté sur ce conteneur — voir Dockerfile,
  "pas de volume nommé sur /app") : confiance au premier contact (TOFU), mais rejette bien un
  changement ultérieur de clé hôte. Sans ce réglage explicite, la clé hôte ne serait jamais
  mémorisée d'un redémarrage de conteneur à l'autre — deuxième bug trouvé en testant en conditions
  réelles (*"Host key verification failed"*).
- **`openssh-client` ajouté à l'image Docker runtime** (`Dockerfile`) — absent par défaut de l'image
  `node:20-bookworm-slim`, troisième bug trouvé en conditions réelles (*"ssh": executable file not
  found in $PATH*).

**Déploiement réel (ha2 → falbala)** : clé `~/.ssh/espdisplay-agent/id_ed25519` générée sur
falbala, montée en lecture seule dans le conteneur `dimotic-ha` de ha2
(`./secrets/espdisplay-agent_id_ed25519:/app/secrets/espdisplay-agent_id_ed25519:ro`, propriétaire
uid/gid 1000 pour correspondre à l'utilisateur `node` du conteneur). Testé de bout en bout avec une
vraie compilation ESPHome déclenchée depuis le conteneur ha2.

---

## 7. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| Pas de verrou propre (§3.3) | Deux déploiements concurrents non coordonnés par ESPDISPLAY lui-même, risque de conflit sur le conteneur Docker partagé | Accepté (verrou porté par l'appelant, HAPLAN) |
| Pas d'OTA automatique | Une compilation réussie ne flashe pas l'écran — flash manuel (`esphome run --device ...`) | Accepté (périmètre v1.0) |
| Un seul hôte distant configurable (v1.1) | `remote.host` unique, pas de sélection dynamique par appareil — voir la conception (non implémentée) d'un registre multi-machines dans `fonctionnelles-supervisor_specs_v1.0.md` §6.2, qui remplacerait ce SSH point-à-point par un relais MQTT générique | Connu, différé |
| Hébergement Docker non généralisé | Un seul conteneur/machine supposé (§6.1) — plusieurs appareils ESP futurs partageraient le même conteneur, pas de sélection par appareil | Connu, non généralisé |
| Chemin du script Python en dur par défaut vers `applications/haplan/tools/` | Un appareil ESP sans rapport avec HAPLAN (ex: futur thermostat de poêle) devra soit un autre script, soit une généralisation de celui-ci | Connu, différé |
| Aucun test automatisé | Vérifié uniquement manuellement (EventBus simulé + vrai sous-processus + vraie compilation Docker, voir session du 13/08/2026) | Accepté |

---

## 8. Arborescence des Programmes

```
applications/espdisplay/
├── package.json, tsconfig.json
└── src/
    └── domain/
        ├── EspDisplayService.ts
        ├── config-schema.ts
        └── index.ts
```

Dépend en exécution (sous-processus, pas en import) de :
```
applications/haplan/tools/
├── generate_esphome_floorplan.py     # --merge/--compile, voir §4.2
└── esphome/
    ├── haplan-display.yaml            # template, source de vérité versionnée
    ├── partitions-haplan.csv
    └── fonts/fa-solid-900.ttf
```

---

## 9. Annexes

### 9.1 Références
- [Spécifications Fonctionnelles HAPLAN](fonctionnelles-haplan_specs_v1.2.md) ⭐ (§3.6/§8.9 —
  déclencheur actuel, seul appelant)
- [Communication Inter-Applications](inter-app-communication_specs_v1.0.md) ⭐ (pattern EventBus
  générique)
- [Spécifications Techniques Socle](techniques-socle-ha-mqtt_specs_v4.28.md) ⭐

### 9.2 Glossaire
| Terme | Définition |
|-------|------------|
| Pipeline (Python) | `generate_esphome_floorplan.py` — génère, fusionne et compile un firmware ESPHome à partir des données de plan HAPLAN |
| Fusion (`--merge`) | Insertion du fragment généré (images, police, widgets LVGL) dans le template ESPHome, aux emplacements marqués par des ancres en commentaire |
| OTA | Over-The-Air — mise à jour du firmware par WiFi plutôt que par câble USB, disponible mais non automatisée par ESPDISPLAY (§7) |

### 9.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.1 | 2026-08-15 | Claude | **Exécution distante par SSH** (§6.3) — corrige un échec réel en production (`ha2`, ni python3 ni conteneur esphome) : commande forcée, clé dédiée, `UserKnownHostsFile` persisté, `openssh-client` ajouté à l'image Docker (3 bugs distincts trouvés en conditions réelles). **Configuration UI** (§5.2) — menu "Écrans ESP", jusque-là absent. |
| 1.0 | 2026-08-13 | Claude | Première spécification. Nouvelle application, créée en même temps que le code — orchestration du déploiement d'écrans ESP via EventBus générique (pattern `integration:bridge:register`), appel du pipeline Python existant côté HAPLAN, choix d'hébergement Docker documenté avec l'essai réel (et l'échec réel) sur ha2/Pi4. Testée en conditions quasi réelles : EventBus simulé + vrai sous-processus + vraie compilation Docker + vrai flash OTA sur écran physique. |
