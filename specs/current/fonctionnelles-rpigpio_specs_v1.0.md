# Spécifications Fonctionnelles - Module RPIGPIO

*Version 1.0 - 12 Août 2026*
*Première spécification, écrite en même temps que le code (contrairement à AREXX/RFXCOM, pas a
posteriori) — application créée et déployée en conditions réelles au cours de la session du
12/08/2026.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Modèle de données](#3-modèle-de-données)
4. [Génération de la configuration mqtt-io](#4-génération-de-la-configuration-mqtt-io)
5. [Déploiement Docker](#5-déploiement-docker)
6. [Configuration](#6-configuration)
7. [Interface Web et Socket.io](#7-interface-web-et-socketio)
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
conteneur Docker sur une machine cible (ha2 ou orangepi).

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

Décision explicite de l'utilisateur, confirmée après vérification technique : ha2/orangepi sont
des machines suffisamment capables (Node 20 officiel disponible en `arm64`) pour tourner en
Docker, contrairement au RPi1 cible de `teleinfo` (ARMv6, aucun build Node officiel récent — voir
`fonctionnelles-teleinfo_specs` §1.3).

---

## 2. Architecture

### 2.1 Composants (`applications/rpigpio/src/domain/`)

| Fichier | Rôle |
|---|---|
| `RpigpioService.ts` | Orchestrateur : CRUD des pins, événements Socket.io, appel au déploiement |
| `generator.ts` | Construit le `config.yaml` mqtt-io et le `compose.yaml` du conteneur à partir des pins stockées |
| `DeployService.ts` | SSH : écrit `config.yaml`/`compose.yaml` sur la cible, `docker compose up -d`, `docker restart` |
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

---

## 3. Modèle de données

### 3.1 `PinDefinition` (`storage-schema.ts`)

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `id` | string | oui (généré) | Slug `quoi_lieu` (dédupliqué si collision), utilisé comme `name` mqtt-io (topic) et suffixe de `identifiers` |
| `quoi` | string | oui | Taxonomie QUOI |
| `lieuPrecis` | string | non | Taxonomie OÙ, niveau précis |
| `lieu` | string | oui | Taxonomie OÙ, niveau principal |
| `lieuPere` | string | non | Taxonomie OÙ, niveau parent |
| `lieuGrandPere` | string | non | Taxonomie OÙ, niveau grand-parent |
| `pin` | number | oui | Numéro de pin BCM (module `raspberrypi` de mqtt-io) |
| `direction` | `'input'` \| `'output'` | oui | Détermine la section mqtt-io (`digital_inputs`/`digital_outputs`) |
| `inverted` | boolean | oui (défaut `false`) | Niveau bas = actif |

`id` est généré côté serveur (`RpigpioService::generatePinId`) à partir de `slugify(quoi_lieu)`,
avec suffixe numérique en cas de collision — jamais saisi directement par l'utilisateur.

### 3.2 Persistance

`data/rpigpio/rpigpio-pins-v1.0.yaml` — tableau `pins: PinDefinition[]`, aucune limite de nombre
(contrairement à `teleinfo`, pas de contrainte matérielle de type "bascule à 2 positions").

---

## 4. Génération de la configuration mqtt-io

### 4.1 Schéma vérifié contre le code source réel

Le schéma mqtt-io (`config.yaml` : `mqtt`, `gpio_modules`, `digital_inputs`, `digital_outputs`) a
été vérifié directement contre `docs_src/schema.json` et `home_assistant.py` du dépôt
`flyte/mqtt-io` le 12/08/2026 — pas deviné depuis une documentation tierce potentiellement obsolète.

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

---

## 5. Déploiement Docker

### 5.1 `DeployService.deploy()` — séquence

1. Écrit `config.yaml` sur `target.hostDir` (SSH, `sudo tee`).
2. Écrit `compose.yaml` sur `target.hostDir` (idem).
3. `cd target.hostDir && sudo docker compose up -d` — crée le conteneur au premier déploiement,
   sans effet si sa définition n'a pas changé.
4. `sudo docker restart target.containerName` — **nécessaire à chaque déploiement** : `docker
   compose up -d` ne redémarre PAS automatiquement un conteneur suite à un simple changement de
   contenu d'un fichier bind-monté (`config.yaml`), seulement suite à un changement de la
   définition du service elle-même. Sans ce restart explicite, un nouveau `config.yaml` déployé
   resterait sans effet tant que le conteneur n'est pas relancé manuellement.
5. `docker inspect --format '{{.State.Status}}'` — statut retourné à l'IHM.

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
| `target.host` | string | `''` | Hôte SSH (ha2/orangepi) |
| `target.sshUser` | string | `claude` | Utilisateur SSH dédié (même convention que `docker/rebuild-and-deploy.sh`) |
| `target.sshKeyPath` | string | `''` | Chemin **local** vers la clé privée SSH (jamais son contenu) |
| `target.hostDir` | string | `/docker/mqttio-rpigpio` | Répertoire distant (`compose.yaml` + `config.yml`) |
| `target.containerName` | string | `mqtt-io-rpigpio` | Nom du conteneur ET du service dans le compose |
| `target.image` | string | `flyte/mqtt-io:2.6.0` | Épinglée à une version numérotée, pas `:latest`/`:develop` |
| `mqtt.host`/`mqtt.port` | string/number | `''`/`1883` | Broker que **mqtt-io** utilisera (pas le socle) |
| `mqtt.user`/`mqtt.password` | string | `''` | Identifiants MQTT — en clair dans `data/rpigpio/config.yaml`, comme le reste du projet |
| `mqtt.topicPrefix` | string | `mqttio/rpigpio` | Topics état/commande mqtt-io |
| `mqtt.discoveryPrefix` | string | `homeassist` | Voir §4.2 |

### 6.2 Formulaire générique ("Paramètres Techniques → RPIGPIO")

Deux groupes : "Machine cible" (5 champs), "Broker MQTT" (5 champs) — tous les champs de §6.1
sauf structure interne (`target`/`mqtt` aplatis en `target.xxx`/`mqtt.xxx`).

---

## 7. Interface Web et Socket.io

### 7.1 Tableau de bord (`presentation/index.html`, page "Pins" du menu)

- Carte statut : nombre de pins déclarées, machine cible, nom du conteneur.
- Liste des pins (chaîne QUOI---OÙ, badge direction, badge "inversé" si applicable, numéro GPIO,
  `id`) — boutons Modifier/Supprimer par ligne.
- Bouton "➕ Nouveau pin" → modale (quoi, lieu précis/lieu/père/grand-père, numéro, direction,
  inversion).
- Bouton "🚀 Générer et déployer" → résultat affiché en alerte succès/erreur avec le détail de
  l'étape en échec (`step`: `write-config`/`write-compose`/`compose-up`/`restart`).

### 7.2 Événements Socket.io

**Server → Client** (persistants : `rpigpio:status`, `rpigpio:pins:list`) :
```typescript
'rpigpio:status'        // { pinsCount, target: { host, containerName } }
'rpigpio:pins:list'     // PinDefinition[]
'rpigpio:pin:saved'     // PinDefinition
'rpigpio:pin:deleted'   // { id }
'rpigpio:deploy:result' // { success, step?, error?, output? }
'rpigpio:error'         // { message }
```

**Client → Server :**
```typescript
'rpigpio:status:get'
'rpigpio:pins:list:get'
'rpigpio:pin:save'    // PinDefinition sans id (création) ou avec id (modification)
'rpigpio:pin:delete'  // { id }
'rpigpio:deploy'
```

---

## 8. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| `privileged: true` seul insuffisant pour `/dev/mem` | Trouvé en déploiement réel, corrigé par `user: '0:0'` (§4.3) | Corrigé |
| Aucun retrait de découverte MQTT si une pin est supprimée | L'entité HA reste orpheline (topic retenu jamais vidé) — même limite qu'AREXX | Non corrigé |
| Aucune détection de collision de numéro de pin | Deux `PinDefinition` pourraient viser le même GPIO physique sans avertissement | Non corrigé |
| Pas de suivi de dérive config↔déploiement | L'IHM ne sait pas si la configuration stockée correspond à ce qui tourne réellement sur la cible (seul le résultat du dernier clic "Déployer" est visible) | Non corrigé |
| `docker restart` à chaque déploiement | Coupure de service de quelques secondes (acceptable en usage domestique, pas de rolling update) | Accepté |
| `pullup`/`pulldown`/`initial`/`timed_set_ms` de mqtt-io non exposés | Fonctionnalités mqtt-io disponibles mais non paramétrables depuis l'IHM | Non implémenté |
| Identifiants MQTT en clair dans `data/rpigpio/config.yaml` | Cohérent avec le reste du projet (aucun secret manager) | Accepté |

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
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.28.md) ⭐
- [Spécifications Fonctionnelles TELEINFO](fonctionnelles-teleinfo_specs_v1.0.md) (application
  sœur, même principe de paramétrage/déploiement, cible non-Docker)
- Dépôt source de mqtt-io : `github.com/flyte/mqtt-io` (schéma vérifié le 12/08/2026)

### 10.2 Glossaire
| Terme | Définition |
|-------|------------|
| mqtt-io | Outil tiers (Python) exposant des GPIO sur MQTT, avec découverte HA intégrée — anciennement `pi-mqtt-gpio` |
| Pin | Une entrée ou sortie GPIO paramétrée (quoi/où, numéro, direction, inversion) |
| `hostDir` | Répertoire sur la machine cible contenant `compose.yaml` + `config.yml` déployés |

### 10.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-08-12 | Claude | Première spécification, application créée et déployée en conditions réelles (ha2) au cours de la session. Couvre l'architecture, le modèle de données, la génération de la configuration mqtt-io (device par pin), le déploiement Docker (bug `user:'0:0'` trouvé en conditions réelles), la configuration, l'UI/Socket.io, et les limites connues. |
