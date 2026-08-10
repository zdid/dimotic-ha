# Spécifications Techniques d'Implémentation - Module RFXCOM

*Version 1.4 - 10 Août 2026*
*§11.1 : nouveau listener `integration:rfxcom:ha:online`, rappelle `publishInitialDiscoveries()` —
second déclencheur de republication de découverte, voir `fonctionnelles-rfxcom_specs` §17.1 et
`techniques-socle-ha-mqtt_specs` §8.5.4bis.*

*Version 1.3 - 3 Août 2026*
*Réécriture complète après audit du code réel : l'essentiel de ce document (§2-§8, §11, §13)
décrivait une API de la bibliothèque `rfxcom` qui ne correspond pas à la version réellement
publiée/utilisée (pas d'événement générique `'device'`, signatures de commandes différentes,
options de construction différentes). Voir le commentaire d'en-tête de
`applications/rfxcom/src/types/rfxcom.d.ts`, qui documentait déjà cet écart depuis un moment sans
que ce fichier de specs ait été corrigé en conséquence.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture de l'Implémentation](#2-architecture-de-limplémentation)
3. [Intégration de la Bibliothèque rfxcom (réelle)](#3-intégration-de-la-bibliothèque-rfxcom-réelle)
4. [Gestion du Transceiver RFXCOM](#4-gestion-du-transceiver-rfxcom)
5. [Détection et Classification des Devices](#5-détection-et-classification-des-devices)
6. [Exécution des Commandes](#6-exécution-des-commandes)
7. [Mappage des Protocoles (réel — 3 protocoles émetteurs)](#7-mappage-des-protocoles-réel--3-protocoles-émetteurs)
8. [Persistance et Validation](#8-persistance-et-validation)
9. [Configuration Requise](#9-configuration-requise)
10. [Gestion des Erreurs](#10-gestion-des-erreurs)
11. [Séquence de Démarrage/Arrêt](#11-séquence-de-démarragearrêt)
12. [Tests et Validation](#12-tests-et-validation)
13. [Limites et Contraintes](#13-limites-et-contraintes)
14. [Annexes](#14-annexes)

---

## 1. Introduction

### 1.1 Objectif
Ce document décrit l'implémentation technique **réelle** du module RFXCOM, à partir de la
bibliothèque npm `rfxcom` telle qu'installée dans `node_modules/rfxcom` (pas telle que documentée
en théorie) — c'est la démarche suivie par `applications/rfxcom/src/types/rfxcom.d.ts`, dont le
commentaire d'en-tête précise explicitement que les déclarations couvrent *"QUE la surface
réellement utilisée par RfxComTransceiver.ts — vérifiée directement dans le code source installé"*.

### 1.2 Périmètre
- **Inclus** : intégration de la bibliothèque `rfxcom`, initialisation du transceiver, détection/
  classification des devices RF433, exécution des commandes via les transmitters, mappage entre
  les événements réels de la bibliothèque et le modèle interne.
- **Exclus** : configuration matérielle du transceiver, gestion du port série au niveau OS
  (au-delà de la détection automatique, voir `fonctionnelles-rfxcom_specs` §8.2), configuration
  MQTT et HA WebSocket (`techniques-socle-ha-mqtt_specs`).

### 1.3 Prérequis
- Transceiver RFXtrx433 connecté via port série, détecté automatiquement (voir
  `fonctionnelles-rfxcom_specs` §8.2) ou configuré manuellement (`/dev/ttyUSB0` par défaut).
- NPM package `rfxcom` (dépendance de `applications/rfxcom`).

### 1.4 Référentiels
- **⭐ [fonctionnelles-rfxcom_specs_v5.11.md](fonctionnelles-rfxcom_specs_v5.11.md)** - Spécifications fonctionnelles principales
- **⭐ [techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.19.md)** - Socle technique
- **⭐ [spec-nommage-v1.0.md](spec-nommage-v1.0.md)** - Règles de nommage
- **⭐ [recepteurs-emetteurs-rfxcom_specs_v5.4.md](recepteurs-emetteurs-rfxcom_specs_v5.4.md)** - Récepteurs et émetteurs

---

## 2. Architecture de l'Implémentation

### 2.1 Composants Principaux (réels, avec taille de fichier)

| Composant | Fichier | Lignes | Responsabilité |
|-----------|---------|--------|----------------|
| `RfxComService` | `applications/rfxcom/src/domain/RfxComService.ts` | ~1085 | Orchestration principale (dépasse la règle des 400 lignes/fichier, voir `fonctionnelles-rfxcom_specs` §20) |
| `RfxComTransceiver` | `applications/rfxcom/src/domain/transceiver/RfxComTransceiver.ts` | ~517 | Enveloppe la bibliothèque `rfxcom`, normalise les événements par protocole |
| `PortDetector` | `applications/rfxcom/src/domain/transceiver/PortDetector.ts` | ~48 | Détection automatique du port série |
| `DeviceManager` | `applications/rfxcom/src/domain/devices/DeviceManager.ts` | ~147 | Registry des devices, construction du `uniqueId` |
| `ReceiverManager` | `applications/rfxcom/src/domain/receivers/ReceiverManager.ts` | ~102 | Orchestre les récepteurs (switch/light/cover) |
| `BaseReceiver` / `ReceiverSwitch` / `ReceiverLight` / `ReceiverCover` | `applications/rfxcom/src/domain/receivers/*.ts` | 38 / 66 / 107 / 147 | Interface commune `IReceiverModule` + implémentations |
| `SceneManager` / `SceneExecutor` | `applications/rfxcom/src/domain/scenes/*.ts` | 43 / 91 | Registry + exécution des scènes |
| `ConfigFileManager` | `applications/rfxcom/src/domain/yaml/ConfigFileManager.ts` | 96 | Lecture/écriture YAML du fichier centralisé |
| `taxonomy.ts` / `classification.ts` | `applications/rfxcom/src/domain/*.ts` | 100 / 99 | Extraction taxonomie, classification QUOI/composant HA |
| `rfxcom.d.ts` | `applications/rfxcom/src/types/rfxcom.d.ts` | ~153 | Déclarations TypeScript **manuelles**, limitées à la surface réellement utilisée |

> ⚠️ **`RfxComConfigService` n'existe pas.** La configuration est chargée directement via
> `IAppConfigProvider` + `config-schema.ts` (paramètres généraux) et `ConfigFileManager` (fichier
> YAML des devices/récepteurs/scènes).

### 2.2 Flux de Données (réel)

```
Transceiver RFXCOM (port série)
        │
        ▼ (événements PAR PROTOCOLE — pas d'événement générique 'device')
   'lighting1' | 'lighting2' | 'blinds1' | 'temperaturehumidity1' | 'temperature1' | 'elec1' | ...
        │
        ▼
RfxComTransceiver — normalisation vers RfxComRawMessage (type/subType/sensorId/seqNbr/signalLevel/batteryLevel/data)
        │
        ▼
RfxComService.handleRfxMessage() → DeviceManager.handleRawMessage()
        │
        ▼
Classification (classification.ts) + mise à jour config-rfxcom-devices-v1.0.yaml
        │
        ▼
Si transmitToHa: publication MQTT (discovery + état) via le socle
```

---

## 3. Intégration de la Bibliothèque rfxcom (réelle)

### 3.1 Import

**Fichier**: `applications/rfxcom/src/domain/transceiver/RfxComTransceiver.ts`

```typescript
import * as rfxcom from 'rfxcom';
```

> ⚠️ Aucun import `RfxComDeviceEvent` ni type `RfxCom as RfxComType` depuis un fichier
> `types/rfxcom` — ces noms n'existent pas dans le code réel.

### 3.2 Déclarations TypeScript manuelles (`rfxcom.d.ts`)

Le fichier `applications/rfxcom/src/types/rfxcom.d.ts` déclare **uniquement** ce qui est utilisé :

| Déclaration | Contenu |
|---|---|
| `RfxComOptions` | `{debug?, deviceParameters?}` — **rien d'autre**, pas de `concurrency`/`timeout` |
| `ProtocolSubtypeTable` | Table bidirectionnelle `Record<number,string> & Record<string,number>` (produite par `reflect()` de la bibliothèque) |
| `class RfxCom extends EventEmitter` | `initialise(cb?)`, `close()`, `on(event, listener)` générique, `static dumpHex()` |
| `Lighting1Event` / `Lighting2Event` / `Blinds1Event` / `TemperatureHumidity1Event` / `Temperature1Event` / `Elec1Event` | Formes des événements réellement consommés |
| `abstract class Transmitter` | Classe de base |
| `type TransmitCallback` | `(err, response, seqnbr) => void` — invoqué une fois la trame **écrite sur le port série**, PAS une confirmation RF433 |
| `class Lighting1` | `switchOn`/`switchOff` |
| `class Lighting2` | `switchOn`/`switchOff`/`setLevel(deviceId, level 0-15)` |
| `class Lighting4` | `sendData(data, pulseWidth, cb?)` |
| `class Blinds1` | `open`/`close(deviceId, direction?, cb?)`/`stop` |
| Tables `lighting1`/`lighting2`/`lighting4`/`lighting5`/`lighting6`/`blinds1`/`security1`, `packetNames` | Constantes de la bibliothèque |

**Non déclaré, accédé via `as any`** avec commentaire explicite dans le code :
`rfxcom.protocols[receiverTypeCode]`, `device.enableRFXProtocols()`, `device.getRFXStatus()` — ces
trois éléments n'existent nulle part dans les déclarations officielles/tierces disponibles, la
gestion des protocoles matériel (`fonctionnelles-rfxcom_specs` §8.3) les utilise malgré tout après
vérification directe du comportement en conditions réelles.

---

## 4. Gestion du Transceiver RFXCOM

### 4.1 Différences réelles avec l'API précédemment documentée (v1.2)

| Point | Documenté jusqu'à v1.2 | Réel |
|---|---|---|
| Événement de détection | `'device'` générique | Un événement par protocole (`'lighting1'`, `'lighting2'`, `'blinds1'`, `'temperaturehumidity1'`, `'temperature1'`, `'elec1'`, ...) |
| Connexion réussie | `'connect'` | `'ready'` |
| Connexion échouée | `'error'` | `'connectfailed'` / `'disconnect'` (avec message) |
| Ordre statut/prêt | `'status'` après `'connect'` | `'status'` peut arriver **avant ou après** `'ready'` — aucun ordre garanti |
| Options du constructeur | `{debug, deviceParameters, concurrency: 3, timeout: 12000}` | **`{debug}` uniquement** — aucun `deviceParameters`/`concurrency`/`timeout` n'est jamais passé |
| Événement générique `'error'` | Existe | N'existe pas dans le cycle de vie utilisé — les échecs passent par `'connectfailed'`/`'disconnect'` |

### 4.2 Construction et Connexion (réel)

**Fichier** : `RfxComTransceiver.ts::connect()`

```typescript
async connect({ port, baudRate }: { port: string; baudRate: number }): Promise<void> {
  this.device = new rfxcom.RfxCom(port, { debug: this.debugEnabled });
  let settled = false;

  this.device.on('ready', () => { if (!settled) { settled = true; /* resolve */ } });
  this.device.on('connectfailed', (msg) => { if (!settled) { settled = true; /* reject */ } });
  this.device.on('disconnect', (msg) => { if (!settled) { settled = true; /* reject */ } });
  this.device.on('status', (status) => { this.onHardwareStatusCallback?.(status); });

  this.setupProtocolListeners(this.device);
  this.device.initialise(onReadyCallback);
}
```

Un drapeau `settled` garantit que la promesse de connexion ne se résout/rejette qu'**une seule
fois**, quel que soit l'ordre d'arrivée de `'ready'`/`'connectfailed'`/`'disconnect'`.

### 4.3 Écouteurs par Protocole (réel, remplace l'ancien §4.3 générique)

`setupProtocolListeners(device)` enregistre un écouteur **par nom d'événement de protocole**, pas
un écouteur générique `'device'`. Chaque écouteur normalise son événement natif vers
`RfxComRawMessage` (voir `fonctionnelles-rfxcom_specs` §6.1).

**Normalisations particulières :**
- **`temperaturehumidity1`** : un seul paquet RF433 produit **deux** messages normalisés
  (Temperature + Humidity) — le device physique (ex: TH9) a un seul `sensorId` mais deux entrées
  logiques distinctes (voir `fonctionnelles-rfxcom_specs` §2.2 sur le rôle du `subType` dans
  l'identifiant).
- **`security1`** : Motion/Contact déterminé par une heuristique sur le nom du subtype
  (`/PIR|MOTION/i`), pas un champ structuré — best-effort documenté.
- **`resolveSensorIdentity`** — cas particuliers : Lighting1 utilise `houseCode+unitCode` en
  minuscules (le champ `id` de la bibliothèque est jugé redondant/peu fiable) ; Lighting4 utilise
  `String(evt.data)` (pas de `id`/`houseCode` disponible pour ce protocole).

### 4.4 Fermeture

```typescript
disconnect(): void {
  this.device?.close();
  this.device = undefined;
}
```

---

## 5. Détection et Classification des Devices

### 5.1 Classification réelle (`classification.ts`, remplace les anciennes méthodes fictives
`mapRfxComProtocolToDeviceType`/`enrichDeviceFromPacketType`)

| Fonction | Rôle |
|---|---|
| `determineQuoi(type, subType)` | QUOI depuis `SUBTYPE_TO_QUOI`/`TYPE_TO_QUOI` (voir `fonctionnelles-rfxcom_specs` §9.3) |
| `getProtocole(type)` | Nom de protocole interne (minuscules) |
| `getDefaultComponent(type, subType)` | Composant HA par défaut (sensor/binary_sensor) |
| `buildStateDeviceId(protocole, subType, sensorId, unitCode?)` | Encodage du `deviceId` d'état/commande |
| `getDefaultUnit(subType)` | Unité HA par défaut (°C, %, A, W...) |

`SUBTYPE_TO_QUOI`/`TYPE_TO_QUOI` couvrent Temperature/Humidity/Motion/Contact/Current/Power et
Lighting1/2/4/5/6/Blinds1 — **Lighting5/6 → "Interrupteur"**, **Blinds1 → "Volet"** (absents des
tables documentées jusqu'à v1.2, qui ne couvraient que 3 packet types Lighting).

### 5.2 Construction du `uniqueId` (`DeviceManager.ts::buildUniqueId`)

```typescript
const uniqueId = `${protocole}_${message.subType.toLowerCase()}_${message.sensorId.toLowerCase()}${unitSuffix}`;
// unitSuffix = message.unitCode !== undefined ? `_${unitCode}` : ''
```
Voir `fonctionnelles-rfxcom_specs` §2.2 pour la justification (disambiguïsation multi-mesures et
multi-boutons).

### 5.3 Détection

**Il n'existe pas de méthode `startDiscovery()` avec timer de 2 secondes.** La détection est
purement **continue et passive** : chaque événement de protocole reçu du transceiver déclenche
immédiatement `handleRawMessage()`. Aucun état "en cours de scan" n'est maintenu côté serveur —
`getStatus().scanInProgress` retourne toujours `false` en dur, bien que le champ existe et que les
événements `rfxcom:scan:start`/`:complete`/`:failed` soient déclarés côté Socket.io (aucun
gestionnaire serveur ne les traite, voir `fonctionnelles-rfxcom_specs` §20).

---

## 6. Exécution des Commandes

### 6.1 Flux d'Exécution (réel)

```
HA → EventBus → RfxComService.applyReceiverCommand()
        │
        ▼
ReceiverManager → Receiver{Switch|Light|Cover}.translateHaCommand()
        │
        ▼
RfxComTransceiver.getOrCreateTransmitter(protocole, subType) — cache par `${protocole}:${subType}`
        │
        ▼
Appel de la méthode du transmitter (switchOn/switchOff/setLevel/open/close/stop)
        │
        ▼
buildAckLogger() — callback loggé à l'écriture sur le port série (pas une confirmation RF433)
```

### 6.2 Dispatch par Protocole (réel — remplace `instanceof` fictif)

**Il n'y a pas de dispatch par `instanceof rfxcom.Lighting1`** (les classes réelles ne sont même
pas toutes déclarées dans `rfxcom.d.ts`). Le dispatch réel est un `switch` sur la chaîne
`protocole` :

```typescript
switch (protocole) {
  case 'lighting1': /* rfxcom.Lighting1 */ break;
  case 'lighting2': /* rfxcom.Lighting2 */ break;
  case 'blinds1':   /* rfxcom.Blinds1 */ break;
  default: /* non transmissible — voir §7 */
}
```

Seuls **3 protocoles** disposent d'un transmitter réellement instanciable :
`lighting1`, `lighting2`, `blinds1` (`getOrCreateTransmitter`). Lighting4/5/6 n'ont **aucun**
chemin de commande — ils ne sont utilisables qu'en réception (émetteurs/boutons).

### 6.3 Commande DIM — échelle réelle

```typescript
// Échelle native RFXCOM : 0-15, PAS 0-100 ni 0-255
const level = Math.round(((value ?? 100) / 100) * 15);
const clamped = Math.max(0, Math.min(15, level));
transmitter.setLevel(deviceId, clamped);
```

### 6.4 Mappage des Actions (réel)

| Action HA | Protocoles Supportés |
|-----------|---------------------|
| `turn_on` / `turn_off` | lighting1, lighting2, blinds1 (open/close pour cover) |
| `toggle` | lighting1, lighting2 |
| `set_level` | lighting2 uniquement (0-15 natif) |
| `open` / `close` / `stop` | blinds1 uniquement |

---

## 7. Mappage des Protocoles (réel — 3 protocoles émetteurs)

### 7.1 Protocoles → Classes Transmitter (réel)

| Protocole | Classe Transmitter | Peut transmettre ? |
|-----------|-------------------|-----------------|
| lighting1 | `rfxcom.Lighting1` | ✅ |
| lighting2 | `rfxcom.Lighting2` | ✅ |
| lighting4 | — | ❌ réception seule |
| lighting5 | — | ❌ réception seule |
| lighting6 | — | ❌ réception seule |
| blinds1 | `rfxcom.Blinds1` | ✅ |

> ⚠️ Les protocoles `lighting3`, `switch1`, `blinds2`, `blinds3`, `security1` documentés jusqu'à
> v1.2 n'ont **aucune** trace dans le code réel — ni classification, ni transmitter, ni mention.

### 7.2 Résolution des Descripteurs de Protocole

Les descripteurs de transmission (subtype exact attendu par la bibliothèque) sont résolus
dynamiquement via `rfxcom.protocols[receiverTypeCode]` (accès non déclaré, `as any`) — pas une
table statique en dur dans le code applicatif comme documenté jusqu'à v1.2 (`rfxcom.lighting1.IMPULS`
etc. écrits en dur). Un nom de protocole inconnu du catalogue matériel rapporté est silencieusement
filtré (`.filter(d => !!d)`), avec avertissement si la liste résultante est vide.

---

## 8. Persistance et Validation

### 8.1 ⚠️ Perte silencieuse des champs d'état au rechargement (le plus important gap de ce document)

`ConfigFileManager.ts` utilise Zod pour valider **et** pour produire la valeur effectivement
utilisée :

- **`save()`** : `schema.parse(config)` pour valider (résultat **jeté**), puis `yaml.dump(config)`
  sur l'objet **original**, non filtré → tous les champs, même non déclarés au schéma (ex:
  `lastOn`, `lastLevel`, `lastValue`, `commandDeviceId`), **sont bien écrits sur disque**.
- **`load()`** : retourne directement `schema.parse(parsed)` → en mode `strip` (défaut de
  `z.object()`), **tous les champs non déclarés au schéma sont silencieusement supprimés** du
  résultat utilisé par l'application.

**Conséquence concrète, vérifiée sur l'installation de référence** : `lastOn`/`lastLevel` sont
bien présents dans `data/rfxcom/config-rfxcom-devices-v1.0.yaml` (écrits par chaque commande), mais
`lastOn` y vaut systématiquement `false` — parce qu'il est relu comme `undefined` à chaque
démarrage (jamais `true`, car la valeur réellement écrite n'a plus le temps d'être relue avant que
la rafale OFF de démarrage ne la réécrive). `lastValue` (devices non-récepteurs) et
`commandDeviceId` n'apparaissent **jamais** dans le fichier réel — leurs points d'écriture ne sont
jamais atteints en pratique dans le flux actuel.

**C'est la cause racine documentée** de la rafale de commandes OFF envoyée à tous les récepteurs à
chaque redémarrage (`fonctionnelles-rfxcom_specs` §9.1/§20) : `receiver.config.lastOn` étant
toujours `undefined` après rechargement, le service ne peut jamais distinguer "état inconnu au
redémarrage" de "éteint la dernière fois" et applique systématiquement `turn_off` par sécurité.

**Schéma réel des devices/récepteurs** (`devices-config-schema.ts`) — champs déclarés vs champs
présents côté TypeScript (`types.ts`) uniquement :

| Champ | Déclaré au schéma Zod | Déclaré côté TS (`types.ts`) | Conséquence |
|---|---|---|---|
| `transmitToHa` | ✅ (défaut `false`) | ✅ | OK |
| `unitCode` | ✅ (devices) | ✅ | OK |
| `lastSeen` | ✅ (devices) | ✅ | OK |
| `lastValue` | ❌ | ✅ | Toujours stripé au rechargement |
| `commandDeviceId` | ❌ | ✅ | Toujours stripé au rechargement |
| `lastOn` (switch/light) | ❌ | ✅ | Toujours stripé au rechargement |
| `lastLevel` (light) | ❌ | ✅ | Toujours stripé au rechargement |

### 8.2 Validation à la sauvegarde

`rfxComDevicesConfigSchema` inclut un `.refine()` global garantissant l'unicité des `receiverId` à
travers `rfxcom_receivers` — la seule validation transversale du fichier (le reste est structurel,
par type de device/récepteur/scène).

---

## 9. Configuration Requise

### 9.1 Configuration Technique Réelle (remplace l'exemple fictif v1.2)

> ⚠️ Il n'y a **pas** de `config/technical-config.yaml`, ni de champs
> `transceiverType`/`serialTimeoutMs`/`discoveryIntervalMs`/`receivers`/`scenes`/`appairages` au
> niveau de la config générale. Voir `fonctionnelles-rfxcom_specs` §8.1 pour les **7 champs réels**
> de `data/rfxcom/config.yaml` (`enabled`, `port`, `baudRate`, `bridgeInstance`,
> `devicesConfigFile`, `autoDiscovery`, `enabledHardwareProtocols`).

### 9.2 Récepteur RFXCOM (réel)

Voir `fonctionnelles-rfxcom_specs` §10.1 et `recepteurs-emetteurs-rfxcom_specs` §10 pour la
structure réelle et complète (`ReceiverSwitchConfig`/`ReceiverLightConfig`/`ReceiverCoverConfig`/
`ReceiverSceneConfig`) — l'exemple v1.2 (`deviceClass`, `subunitCode`, `groupCode`, `inverted`,
`haExposed`, `quoi`, `ou` comme champs plats du récepteur) ne correspond à aucune structure
existante dans le code.

---

## 10. Gestion des Erreurs

### 10.1 Codes d'Erreur Réellement Émis

Sur les 7 codes documentés jusqu'à v1.2, **seuls 2 sont effectivement émis par le code** :

| Code | Description | Émis ? |
|------|-------------|-----------|
| `RFXCOM_CONNECTION_ERROR` | Erreur de connexion au transceiver (échec initial ou reconnexion à chaud) | ✅ |
| `RFXCOM_COMMAND_FAILED` | Échec de l'exécution d'une commande (transmission, push protocoles) | ✅ |
| `RFXCOM_TRANSCEIVER_NOT_INITIALIZED` / `_NOT_CONNECTED` / `_UNSUPPORTED_PROTOCOL` / `_UNSUPPORTED_ACTION` / `_DEVICE_NOT_FOUND` | — | ❌ jamais émis dans le code actuel |

### 10.2 Format des Erreurs
Inchangé — voir `specs-erreurs-v1.0.md`.

---

## 11. Séquence de Démarrage/Arrêt

### 11.1 Démarrage (réel, détaillé — remplace le §11.1 générique v1.2)

1. `logger.info('Démarrage du service RFXCOM...')`
2. `configFileManager.load()` — validation Zod ; en échec, log + config vide (pas de crash)
3. `deviceManager.loadConfigured(...)`, `receiverManager.loadReceivers(...)`,
   `sceneManager.loadScenes(...)` (scènes filtrées par `type: 'scene'`)
4. **Création du verrou `protocolsPushGate`** + filet de sécurité 20s — **avant** tout
   enregistrement d'écouteur EventBus/Socket.io (ordre critique, voir
   `fonctionnelles-rfxcom_specs` §8.3)
5. Enregistrement des écouteurs EventBus (`integration:rfxcom:command`,
   `integration:rfxcom:bridge:connection`, `app:module:config:saved`, ⭐ v1.4
   `integration:rfxcom:ha:online`) et Socket.io (24 gestionnaires)
6. `eventBus.emitGeneric('integration:bridge:register', ...)`
7. Enregistrement des callbacks du transceiver (`onMessage`, `onConnectionChange`,
   `onHardwareStatus` — ce dernier déclenche le push de protocoles une fois par session, résout le
   verrou à la fin, voir `fonctionnelles-rfxcom_specs` §8.3)
8. **Résolution du port** (`PortDetector` en premier, `config.port` en fallback — voir
   `fonctionnelles-rfxcom_specs` §8.2)
9. `await transceiver.connect({port, baudRate})` — en échec : `WARNING`, erreur émise, **verrou
   résolu immédiatement** (rien à pousser)
10. Émission des listes initiales (statut, devices, récepteurs, scènes, protocoles)
11. `logger.info('Service RFXCOM démarré')`

**La découverte MQTT n'est PAS publiée à cette étape** — elle est déclenchée séparément par le
gestionnaire `integration:rfxcom:bridge:connection`, lui-même conditionné par la résolution du
verrou `protocolsPushGate` (`this.protocolsPushGate.then(() => this.publishInitialDiscoveries())`).

**⭐ v1.4 — Second déclencheur, indépendant du verrou ci-dessus** :
```typescript
this.eventBus.onGeneric<{ bridgeInstance: string }>(
  `integration:${MODULE_NAME}:ha:online`,
  () => this.publishInitialDiscoveries()
);
```
Alimenté par le birth message MQTT natif de HA (`homeassistant/status`), pas par la connexion du
bridge RFXCOM — couvre le cas où HA redémarre seul sans que notre propre client MQTT ne se
déconnecte. Voir `techniques-socle-ha-mqtt_specs` §8.5.4bis pour le mécanisme socle
(`HaMqttIntegrationService.onHaOnline()` → `IntegrationBridge` → événement générique
`integration:{module}:ha:online`).

**Comportement en cas d'échec de connexion** : `WARNING` (pas `ERROR`), `isConnected = false`,
application non bloquée, indicateur UI "Déconnecté".

### 11.2 Arrêt

```typescript
async stop(): Promise<void> {
  transceiver.disconnect();
  eventBus.emitGeneric('integration:bridge:unregister', ...);
  emitStatus();
}
```
Ne republie/retire **pas** les découvertes MQTT à l'arrêt.

### 11.3 Reconnexion à Chaud (réel — remplace le mécanisme fictif "AppService redémarre tout le
module")

> ⚠️ **AppService ne redémarre plus le module entier** à chaque sauvegarde de configuration. Ce
> comportement a été désactivé côté RFXCOM (comportement générique du socle conservé pour les
> autres modules qui n'implémentent pas leur propre reconnexion).

Voir `fonctionnelles-rfxcom_specs` §8.5 pour le détail complet (`reconnectTransceiverIfConfigChanged`) :
comparaison port effectif + `baudRate` avant/après, déconnexion/réinitialisation du verrou
anti-boucle protocoles/reconnexion si changement détecté, sans toucher au `bridgeInstance` ni
republier la découverte.

---

## 12. Tests et Validation

### 12.1 Scénarios de Test (mis à jour)

| ID | Description | Critère de Succès |
|----|-------------|------------------|
| RFX-T-001 | Initialisation du transceiver | `'ready'` reçu, `isConnected = true` |
| RFX-T-002 | Détection d'un message par protocole | Message normalisé transmis à `handleRfxMessage` |
| RFX-T-003 | Exécution commande ON (lighting1/2, blinds1) | Méthode du transmitter appelée avec les bons paramètres |
| RFX-T-004 | Exécution commande set_level (lighting2) | Conversion vers l'échelle 0-15 correcte |
| RFX-T-005 | Déconnexion (`'disconnect'`/`'connectfailed'`) | `isConnected = false`, `emitStatus()` |
| RFX-T-006 | Protocole non transmissible (lighting4/5/6) | Commande rejetée proprement, pas de crash |
| RFX-T-007 | Verrou `protocolsPushGate` | Découverte initiale n'a lieu qu'après résolution du verrou |
| RFX-T-008 | Filet de sécurité 20s | Le verrou se résout même sans statut matériel reçu |

### 12.2 Validation de la Configuration

Voir `config-schema.ts` (§8.1 de `fonctionnelles-rfxcom_specs`) et `devices-config-schema.ts`
(§8.2 de ce document) — pas de méthode `validateRfxComConfig` séparée, la validation Zod est
appliquée directement au chargement/à la sauvegarde.

---

## 13. Limites et Contraintes

### 13.1 Limites Réelles de l'Intégration

| Limite | Impact | Solution |
|--------|--------|----------|
| Seuls lighting1/lighting2/blinds1 peuvent transmettre | Un récepteur avec `primaryEmitter` Lighting4/5/6 ne peut envoyer aucune commande | Limite de la bibliothèque elle-même, pas de contournement |
| Aucune option `timeout`/`concurrency` passée au constructeur | Pas de contrôle applicatif sur ces paramètres (comportement par défaut de la bibliothèque) | Non ajustable actuellement |
| `RFXMeter`/Elec sans bit de filtrage matériel | Impossible de filtrer cette catégorie de protocoles | Acceptée |
| `lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` strippés au rechargement (§8.1) | Cause racine de la rafale OFF à chaque redémarrage | Non corrigé — nécessiterait d'étendre le schéma Zod |
| ACK = écriture port série, pas confirmation RF433 | Toute commande reste optimiste, pas de garantie de réception par le device physique | Acceptée, documentée |

### 13.2 Protocoles Non Supportés (transmission)
`lighting4`, `lighting5`, `lighting6`, `security1` : réception uniquement, aucun transmitter
disponible dans le code applicatif actuel.

### 13.3 Contraintes Matérielles
- Le transceiver doit être branché avant/pendant le démarrage (détection automatique tolère un
  branchement tardif suivi d'une reconnexion à chaud, §11.3).
- Permissions du port série appropriées (`dialout` ou équivalent).
- `baudRate` cohérent avec le matériel (38400 par défaut).

---

## 14. Annexes

### 14.1 Références
- **[Bibliothèque rfxcom npm](https://www.npmjs.com/package/rfxcom)**
- **[fonctionnelles-rfxcom_specs_v5.11.md](fonctionnelles-rfxcom_specs_v5.11.md)** ⭐
- **[techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.19.md)** ⭐
- **[recepteurs-emetteurs-rfxcom_specs_v5.4.md](recepteurs-emetteurs-rfxcom_specs_v5.4.md)** ⭐

### 14.2 Glossaire

| Terme | Définition |
|-------|------------|
| Transceiver | Appareil RFXtrx433 qui émet/reçoit les signaux RF433 |
| Transmitter | Classe de la bibliothèque `rfxcom` permettant d'envoyer des commandes pour un protocole spécifique — seuls Lighting1/Lighting2/Blinds1 en ont un côté applicatif |
| protocolsPushGate | Verrou retardant la première découverte MQTT jusqu'à la tentative de push des protocoles matériel |
| ACK (accusé de réception) | Confirmation d'écriture sur le port série, PAS de réception RF433 par le device physique |

### 14.3 Exemple Complet (réel)

```typescript
// Construction (voir PlanificateurService/RfxComService pour le pattern d'injection réel)
const transceiver = new RfxComTransceiver(logger);
transceiver.onMessage((msg) => deviceManager.handleRawMessage(msg));
transceiver.onHardwareStatus(async (status) => {
  await this.pushEnabledHardwareProtocolsOnce(status);
});

const port = this.resolvePort(); // PortDetector puis fallback config
await transceiver.connect({ port, baudRate: this.config.baudRate });
```

### 14.4 Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-07-11 | Mistral Vibe | Version initiale - Intégration de la bibliothèque rfxcom npm |
| 1.2 | 2026-07-17 | Mistral Vibe | Démarrage automatique via AppService, injection `IAppConfigProvider`, traces détaillées |
| 1.4 | 2026-08-10 | Claude | **Second déclencheur de découverte** (§11.1) — listener `integration:rfxcom:ha:online` rappelant `publishInitialDiscoveries()`, alimenté par le birth message MQTT natif de HA. Voir `fonctionnelles-rfxcom_specs` v5.11 et `techniques-socle-ha-mqtt_specs` §8.5.4bis. Ancienne version v1.3 archivée. |
| 1.3 | 2026-08-03 | Claude | **Réécriture complète des sections décrivant l'API de la bibliothèque `rfxcom`** (§2-§8, §11, §13), qui documentaient une API fictive jamais celle réellement publiée (pas d'événement générique `'device'`, pas de `'connect'`/`'error'` génériques, options du constructeur réduites à `{debug}`, dispatch par `switch` sur le protocole et non `instanceof`, échelle de dim réelle 0-15). Nouvelle §8 "Persistance et Validation" documentant la cause racine, jusqu'ici non identifiée dans les specs, de la rafale de commandes OFF à chaque redémarrage (`lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` écrits en YAML mais strippés au rechargement par le schéma Zod). §11.1/§11.3 réécrites (verrou `protocolsPushGate`, reconnexion à chaud propre à RFXCOM plutôt que redémarrage du module entier par AppService). Section "Communication Inter-Applications" (§9 de la v1.2, jamais implémentée, doublon de numérotation avec l'ancienne §9) retirée de ce document — voir l'annexe correspondante dans `fonctionnelles-rfxcom_specs_v5.11.md` §22.3, qui la documente une seule fois pour l'ensemble du module RFXCOM avec la mention explicite "non implémentée". |

---

*Conforme à [fonctionnelles-rfxcom_specs_v5.11.md](fonctionnelles-rfxcom_specs_v5.11.md), [techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.19.md) et [spec-nommage-v1.0.md](spec-nommage-v1.0.md)*
