# Spécifications Fonctionnelles - Module RFXCOM

*Version 5.8 - 27 Juillet 2026*
*Intègre le fichier de configuration centralisé config-rfxcom-devices-v1.0.yaml avec primaryEmitter et émetteurs appairés dans les récepteurs. NOUVEAU: **Spécifications Cover avec Lighting2** (états up/down/intermediate, calcul position%, traduction on/off), **Traduction Commandes HA→RFXCOM par type**, **Arborescence des Programmes**, Détection automatique, toolbar Scanner/Effacer/Rafraîchir, Appairages intégrés, **Gestion des protocoles matériel** (remplace l'ancien filtre logiciel), Scènes implémentées et testées, transmitToHa, actions MQTT par le socle, indicateur connexion, traces détaillées.*

> **v5.8** : **Remplacement complet de la gestion des protocoles (§8.2)** — l'ancien filtre logiciel
> après décodage (granularité Lighting1/2/4/5/6/Blinds1/RFXSensor/RFXMeter, persistant, appliqué côté
> application) est **supprimé** (demande utilisateur, jugé trop complexe sans réel gain face au
> mécanisme matériel). Remplacé par un filtre **matériel unique** : le RFXtrx433 rapporte à la
> connexion (`rfxcom:status:get`... voir §8.2) ses protocoles actifs et son catalogue complet
> (granularité fine, ex: X10/ARC/AC/OREGON — noms de la bibliothèque `rfxcom`, pas nos catégories
> internes) ; notre sélection persistée (`enabledHardwareProtocols`) reste la seule référence — elle
> n'est **jamais écrasée** par ce que rapporte le matériel — et est **repoussée** au RFXtrx433 en RAM
> uniquement (jamais en EEPROM, jamais via `saveRFXProtocols`), en un seul lot via un bouton dédié
> "Envoyer au RFXtrx433" (plus de push automatique à chaque coche). Nouveau bouton "Rafraîchir" pour
> réinterroger le statut matériel sans reconnexion complète. Documente aussi, dans §12, l'onglet
> **Protocoles** (jusqu'ici absent de la liste des onglets), la saisie de la taxonomie en **5 champs
> séparés** avec sauvegarde individuelle (Devices et Récepteurs, fenêtres modales), et les **libellés
> lisibles dérivés de la taxonomie** dans les listes déroulantes d'émetteurs (remplace l'affichage du
> `uniqueId` brut).

> **v5.7** : **Scènes implémentées et testées** (§14.3 — le code n'existait pas malgré le "réactivées"
> de v5.4, voir `recepteurs-emetteurs-rfxcom_specs_v5.2.md` pour le détail architecture). Noms
> d'événements Socket.io réellement utilisés (`rfxcom:scenes:list`/`:list:get`, §14.3.5). Documente
> deux simplifications connues : topic de découverte `device_automation` à un seul segment (§14.3.4)
> et `SceneExecutionResult` ne distinguant pas `scene_failed` de `scene_cancelled` (§14.3.6). Corrige
> aussi un gap du socle sans lequel les scènes (et tout récepteur RFXCOM) ne recevaient jamais aucune
> commande HA→app en pratique — voir `techniques-socle-ha-mqtt_specs_v4.12.md`.

> **v5.6** : Alignement des topics `state_topic`/scènes sur le nouveau format MQTT du socle
> (`techniques-socle-ha-mqtt_specs_v4.10.md` §8.5) : `/{moduleName}/{bridgeInstance}/{deviceId}/state|set`.
> Le topic de découverte HA standard est inchangé. Voir `recepteurs-emetteurs-rfxcom_specs_v5.1.md`
> §8.5 pour le détail complet (encodage `deviceId`, LWT par bridge_instance).

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Référentiel de Nommage et Taxonomie](#2-référentiel-de-nommage-et-taxonomie)
3. [Architecture](#3-architecture)
4. [Types de Devices et Entités Supportés](#4-types-de-devices-et-entités-supportés)
5. [Gestion des Émetteurs et Récepteurs](#5-gestion-des-émetteurs-et-récepteurs)
6. [Format des Messages RFXCOM](#6-format-des-messages-rfxcom)
7. [Mappage vers Home Assistant](#7-mappage-vers-home-assistant)
8. [Configuration](#8-configuration)
9. [Gestion des Données QUOI et OÙ](#9-gestion-des-données-quoi-et-ou)
10. [Fichier de Configuration Centralisé](#10-fichier-de-configuration-centralisé)
11. [Interface Web et Socket.io](#11-interface-web-et-socketio)
12. [Scénarios d'Utilisation](#12-scenarios-dutilisation)
13. [Gestion des États](#13-gestion-des-états)
14. [Commandes](#14-commandes)
   - [14.1 Émetteurs Lighting](#141-émetteurs-lighting)
   - [14.2 Récepteurs](#142-récepteurs)
   - [14.3 Scènes RFXCOM](#143-scènes-rfxcom)
   - [14.4 Commandes Spécifiques aux Récepteurs Dimmables](#144-commandes-spécifiques-aux-récepteurs-dimmables)
   - [14.5 Commandes Spécifiques aux Covers](#145-commandes-spécifiques-aux-covers)
16. [Traduction Commandes HA → RFXCOM](#16-traduction-commandes-ha--rfxcom)
17. [Arborescence des Programmes](#17-arborescence-des-programmes)
18. [Tests](#18-tests)
19. [Limites et Contraintes](#19-limites-et-contraintes)
20. [Roadmap](#20-roadmap)
21. [Annexes](#21-annexes)

---

## 1. Introduction

### 1.1 Objectif
Ce document décrit les spécifications fonctionnelles du module d'intégration **RFXCOM** pour Home Assistant.

**NOUVEAU v5.0 :**
- ✅ **Fichier de configuration centralisé** : `config-rfxcom-devices-v1.0.yaml` contient TOUS les devices, récepteurs et appairages
- ✅ **primaryEmitter dans chaque récepteur** : Détermine quel device RFXCOM envoie les commandes
- ✅ **Liste des émetteurs appairés dans le récepteur** : Les appairages N↔N sont stockées directement dans la définition du récepteur
- ✅ **entity_id et unique_id contiennent TOUJOURS le protocole interne** (`<protocole_interne>_<sensorId>`)
- ✅ **QUOI = type fonctionnel pur** (ex: "Température", "Humidité", "Courant")
- ✅ **QUOI auto-déterminé** depuis le subType RFXCOM
- ✅ **Émetteurs Lighting = binary_sensor par défaut** (on/off)

### 1.2 Périmètre
- **Inclus** : Réception messages RF433, classification HA, publication MQTT, exécution commandes, gestion récepteurs/émetteurs
- **Exclus** : Gestion du matériel RFXCOM (pilotes), configuration broker MQTT, implémentation UI

### 1.3 Public Cible
- Développeurs intégrant le module RFXCOM
- Mainteneurs du socle HA-MQTT
- Utilisateurs finaux (configuration via fichier YAML)

---

## 2. Référentiel de Nommage et Taxonomie

**⚠️ Ce module respecte strictement [spec-nommage-v1.0.md](spec-nommage-v1.0.md)**

### 2.1 Format du name (Obligatoire)
```
quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
```
- `---` : Séparateur majeur entre QUOI et OÙ
- `--` : Séparateur mineur entre niveaux hiérarchiques

### 2.2 Règle de Nommage Technique

**Pour TOUS les devices RFXCOM (capteurs et émetteurs) :**
```
<protocole_interne>_<sensorId>
```

| Élément | Description | Exemple | Résultat |
|---------|-------------|---------|----------|
| protocole_interne | Protocole RFXCOM interne | `lighting2`, `rfxsensor`, `rfxmeter` | - |
| sensorId | Identifiant unique du device | `0x02b3`, `0xa5b3` | - |
| **Nom complet** | - | - | `lighting2_0x02b3`, `rfxsensor_0xa5b3` |

**Pour les récepteurs logiques :**
```
recepteur_<numéro_séquence>
```
- `numéro_séquence` : Numéro attribué séquentiellement (001, 002, ...)
- Exemple : `recepteur_001`, `recepteur_002`

> ✅ **Garantie d'unicité** : Le sensorId ou le numéro de séquence assure l'unicité dans tout le système.

### 2.3 QUOI = Type Fonctionnel Pur

**Le QUOI ne désigne PAS un endroit, mais le type fonctionnel du device :**

| SubType RFXCOM | QUOI (auto-déterminé) | Exemple |
|----------------|----------------------|---------|
| Temperature | Température | `Température---Salon` |
| Humidity | Humidité | `Humidité---Cuisine` |
| Motion | Mouvement | `Mouvement---Couloir` |
| Contact | Contact | `Contact---Entrée` |
| Current | Courant | `Courant---Tableau` |
| Power | Puissance | `Puissance---Cuisine` |
| Lighting1 | Interrupteur | `Interrupteur---Salon` |
| Lighting2 | Bouton | `Bouton---Salon` |
| Lighting4 | Télécommande | `Télécommande---Salon` |

> ⚠️ **IMPORTANT** : Le QUOI est **prérempli automatiquement** depuis le subType du message RFXCOM. L'utilisateur peut le modifier dans le fichier de configuration.

### 2.4 OÙ = Localisation Hiérarchique
Représente **l'emplacement** après `---`, séparé par `--` :

| Niveau | Rôle | Exemple | Obligatoire |
|--------|------|---------|-------------|
| `lieu_grand_pere` | Bâtiment | `Maison` | ❌ |
| `lieu_pere` | Étage | `Rez-de-Chaussée` | ❌ |
| `lieu_principal` | Pièce | **`Salon`** | ✅ **OUI** |
| `lieu_precis` | Sous-zone | `Coin Canapé` | ❌ |

**Exemples complets :**
- `Température---Salon` (N=1)
- `Température---Coin Canapé--Salon` (N=2)
- `Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée` (N=3)

### 2.5 Règle de Transmission vers HA (CRITIQUE)
**⭐ Les données ne sont PAS transmissibles vers HA si :**
- ❌ QUOI (`raw_quoi`) est vide/manquant
- ❌ OÙ n'a PAS de `lieu_principal` (aucune pièce définie)

### 2.6 Attributs de Taxonomie (Obligatoire)
Toute entité DOIT inclure dans son payload MQTT :
```json
{
  "attributs_taxonomie": {
    "quoi": "Température",
    "slug_quoi": "temperature",
    "lieu_principal": "Salon",
    "slug_lieu": "salon",
    "lieu_precis": "Coin Canapé",
    "slug_precis": "coin_canape",
    "lieu_pere": null,
    "slug_pere": null,
    "lieu_grand_pere": null,
    "slug_grand_pere": null
  }
}
```

---

## 3. Architecture

### 3.1 Schéma Global (5 Couches - Conforme à specs-techniques-socle-ha-mqtt.md)
```
┌─────────────────────────────────────────────────────────────────┐
│                    COUCHE PRÉSENTATION                    │
│              (UI Web + Socket.io)                        │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE APPLICATION                     │
│   AppService · EventBus · SocketBridge · RestartManager   │
├─────────────────────────────────────────────────────────────────┤
│                     COUCHE MÉTIER                         │
│   RfxComService · ReceiverSwitchModule · ReceiverLightModule   │
│   ReceiverCoverModule · ReceiverSceneModule                      │
├─────────────────────────────────────────────────────────────────┤
│                       COUCHE HA                           │
│   HaMqttIntegrationService · IntegrationBridge · EventBus       │
├─────────────────────────────────────────────────────────────────┤
│                  COUCHE INFRASTRUCTURE                    │
│   ConfigService · Logger · MqttTransport                        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Flux de Données (Mis à jour v5.0)
```
RFXCOM Transceiver (Port Série)
    |
    v (Message RF433)
RfxComService.handleRfxMessage()
    |
    v (Auto-détermination QUOI depuis subType)
    v (Ex: Temperature → QUOI = "Température")
    |
    v (Validation QUOI/OÙ)
    +--[QUOI ou OÙ manquant?]---> [BLOCAGE: Pas de transmission HA]
    |
    v (Mise à jour dans config-rfxcom-devices-v1.0.yaml)
    v (Si nouvel émetteur, ajout à rfxcom_devices)
    |
    v (Publication Discovery MQTT)
Home Assistant
```

---

## 4. Types de Devices et Entités Supportés

### 4.1 RFXSensor - Capteurs (0x50-0x5F)
**QUOI auto-déterminé depuis subType**

| SubType | QUOI | Composant HA | Device Class | Unité | Exemple entity_id | Exemple unique_id | Exemple name |
|---------|------|---------------|--------------|-------|-------------------|-------------------|--------------|
| Temperature | Température | sensor | temperature | °C | `sensor.rfxsensor_0xa5b3` | `rfxsensor_0xa5b3` | `Température---Salon` |
| Humidity | Humidité | sensor | humidity | % | `sensor.rfxsensor_0xc4d2` | `rfxsensor_0xc4d2` | `Humidité---Cuisine` |
| Motion | Mouvement | binary_sensor | motion | - | `binary_sensor.rfxsensor_0xe7f1` | `rfxsensor_0xe7f1` | `Mouvement---Couloir` |
| Contact | Contact | binary_sensor | door | - | `binary_sensor.rfxsensor_0x98a4` | `rfxsensor_0x98a4` | `Contact---Entrée` |

### 4.2 RFXMeter - Compteurs (0x70-0x7F)
**QUOI auto-déterminé depuis subType**

| SubType | QUOI | Composant HA | Device Class | Unité | Exemple entity_id | Exemple unique_id | Exemple name |
|---------|------|---------------|--------------|-------|-------------------|-------------------|--------------|
| Current | Courant | sensor | current | A | `sensor.rfxmeter_0xb2c3` | `rfxmeter_0xb2c3` | `Courant---Tableau` |
| Power | Puissance | sensor | power | W | `sensor.rfxmeter_0xd4e5` | `rfxmeter_0xd4e5` | `Puissance---Cuisine` |

### 4.3 Lighting - Émetteurs Physiques (0x10-0x1F)
**TOUS les Lighting sont des ÉMETTEURS PHYSIQUES**
**Par défaut : composant HA = binary_sensor (on/off)**

| Type | QUOI | Composant HA | Commandes | Exemple entity_id | Exemple unique_id | Exemple name |
|------|------|---------------|-----------|-------------------|-------------------|--------------|
| Lighting1 | Interrupteur | binary_sensor | on, off | `binary_sensor.lighting1_0x01a2` | `lighting1_0x01a2` | `Interrupteur---Salon` |
| Lighting2 | Bouton | binary_sensor | on, off | `binary_sensor.lighting2_0x02b3` | `lighting2_0x02b3` | `Bouton---Salon` |
| Lighting4 | Télécommande | binary_sensor | on, off | `binary_sensor.lighting4_0x1001` | `lighting4_0x1001` | `Télécommande---Salon` |

> ⚠️ **CLARIFICATION IMPORTANTE** :
> - **Lighting2 sont TOUJOURS des binary_sensor dans HA** (ils émettent uniquement on/off)
> - **Le récepteur associé** peut être configuré comme `light` avec `isDimmable: true` (variateur)
> - Dans ce cas, la commande **sera traduite en setlevel** avant d'être envoyée par le lighting2
> - L'information "variateur" **ne vient pas du device Lighting2 lui-même**, mais de la configuration du récepteur

---

## 5. Gestion des Émetteurs et Récepteurs

### 5.1 Définitions Clés

| Terme | Définition | Type HA | Nom Technique | Exemple |
|-------|------------|---------|---------------|---------|
| **Device RFXCOM** | Appareil physique RFXCOM | variable | `<protocole>_<sensorId>` | `lighting2_0x02b3`, `rfxsensor_0xa5b3` |
| **Émetteur** | Device Lighting1/2/4 qui émet des signaux RF433 | **binary_sensor** (par défaut) | `<protocole>_<sensorId>` | `lighting2_0x02b3` |
| **Récepteur** | Entité logique déclarée, associée à des émetteurs | switch, light, cover, scene | `recepteur_<seq>` | `recepteur_001` |
| **primaryEmitter** | Émetteur principal d'un récepteur, utilisé pour envoyer les commandes RF433 | - | `<protocole>_<sensorId>` | `lighting2_0x02b3` |
| **Appairage** | Lien entre émetteur et récepteur (**N↔N**) stocké dans le récepteur | - | - | - |

### 5.2 Règles Fondamentales (NOUVEAU v5.0)

1. **Tous les devices RFXCOM ont un nom technique** : `<protocole_interne>_<sensorId>`
2. **QUOI = type fonctionnel pur** (ex: "Température", "Humidité", "Courant"), pas un endroit
3. **QUOI auto-déterminé** depuis le subType du message RFXCOM
4. **Émetteurs Lighting = binary_sensor par défaut** (ils émettent on/off)
5. **Appairages stockées dans le fichier YAML** : dans `config-rfxcom-devices-v1.0.yaml`, chaque récepteur contient sa liste d'émetteurs appairés
6. **primaryEmitter obligatoire** : Chaque récepteur a UN émetteur primaire qui détermine quel device RFXCOM envoie les commandes
7. **Relations N↔N** : 
   - Un récepteur peut avoir **plusieurs émetteurs** associés (dans `emitters[]`)
   - Un émetteur peut agir sur **plusieurs récepteurs** (chaque récepteur référence l'émetteur)
8. **Lighting2 variateur** : L'information "variateur" vient **exclusivement** de la propriété `isDimmable` du récepteur

### 5.3 Flux Émetteur → Récepteur
```
1. Bouton physique (Lighting2 0x02B3) envoie: "ON"
2. RfxComService reçoit message RF433
3. Service identifie 0x02B3 comme émetteur (lighting2_0x02b3)
4. Service parcourt TOUS les récepteurs dans config-rfxcom-devices-v1.0.yaml
5. Pour chaque récepteur qui a lighting2_0x02b3 dans sa liste emitters:
   a. Vérification que QUOI/OÙ sont complets
   b. Module approprié exécute l'action configurée (toggle, on, off, set_level, etc.)
   c. Module met à jour état du récepteur dans HA
   d. **Envoi de l'état de l'émetteur (binary_sensor)** dans HA si configuré
```

### 5.4 Flux HA → Récepteur → Device RFXCOM (NOUVEAU v5.0)
```
1. HA publie: homeassistant/light/recepteur_001/set
   Payload: {"state": "ON", "brightness": 128}
2. IntegrationBridge reçoit via MQTT
3. RfxComService trouve recepteur_001 dans config-rfxcom-devices-v1.0.yaml
4. Récupère primaryEmitter: "lighting2_0x02b3"
5. Trouve le device associé: lighting2_0x02b3 → sensorId: "0x02B3"
6. ReceiverLightModule convertit: brightness 128 → level 50%
7. Module envoie commande à RfxComService:
   {targetSensorId: "0x02B3", command: "set_level", value: 50}
8. RfxComService envoie signal RF433 au device cible
9. Device physique (0x02B3) exécute
```

---

## 6. Format des Messages RFXCOM

### 6.1 Structure Commune
```typescript
interface RfxComRawMessage {
  type: RfxComDeviceType;      // "RFXSensor", "RFXMeter", "Lighting1", "Lighting2", "Lighting4"
  subType: RfxComSubType;      // "Temperature", "Humidity", "Motion", "AC", etc.
  sensorId: string;            // "0x123456"
  seqNbr: number;              // 0-255
  signalLevel: number;         // dBm (-128 à 127)
  batteryLevel: number;        // 0-9
  data: Record<string, unknown>;
  rawData: Buffer;
}
```

### 6.2 Auto-détermination du QUOI
```typescript
const SUBTYPE_TO_QUOI: Record<string, string> = {
  'Temperature': 'Température',
  'Humidity': 'Humidité',
  'Motion': 'Mouvement',
  'Contact': 'Contact',
  'Current': 'Courant',
  'Power': 'Puissance',
  'Lighting1': 'Interrupteur',
  'Lighting2': 'Bouton',
  'Lighting4': 'Télécommande',
};
```

---

## 7. Mappage vers Home Assistant

### 7.1 Composants HA par Type de Device

| Type RFXCOM | SubType | Composant HA | Device Class | QUOI |
|-------------|---------|---------------|--------------|------|
| RFXSensor | Temperature | sensor | temperature | Température |
| RFXSensor | Humidity | sensor | humidity | Humidité |
| RFXSensor | Motion | binary_sensor | motion | Mouvement |
| RFXSensor | Contact | binary_sensor | door | Contact |
| RFXMeter | Current | sensor | current | Courant |
| RFXMeter | Power | sensor | power | Puissance |
| Lighting1 | - | **binary_sensor** | - | Interrupteur |
| Lighting2 | - | **binary_sensor** | - | Bouton |
| Lighting4 | - | **binary_sensor** | - | Télécommande |

### 7.2 Discovery MQTT pour Device RFXCOM
**Template général (capteur), bridge `{{ bridgeInstance }}` :**
```json
{
  "name": "{{ taxonomy.raw_quoi }}",
  "unique_id": "{{ protocole }}_{{ sensorId }}",
  "~": "homeassistant/sensor/{{ protocole }}_{{ sensorId }}",
  "state_topic": "/rfxcom/{{ bridgeInstance }}/{{ deviceId }}/state",
  "device": {
    "identifiers": ["{{ protocole }}_{{ sensorId }}"],
    "name": "RFXCOM {{ type }} {{ subType }}",
    "manufacturer": "RFXCOM",
    "model": "{{ protocole | uppercase }}"
  },
  "attributs_taxonomie": {
    "quoi": "{{ taxonomy.raw_quoi }}",
    "slug_quoi": "{{ taxonomy.slug_quoi }}",
    "lieu_principal": "{{ taxonomy.nom_lieu }}",
    "slug_lieu": "{{ taxonomy.slug_lieu }}"
  }
}
```

> **⭐ v5.6** : `state_topic` (et `command_topic` le cas échéant) suit le format
> `/{moduleName}/{bridgeInstance}/{deviceId}/state|set` — voir
> [`recepteurs-emetteurs-rfxcom_specs` §8.5](recepteurs-emetteurs-rfxcom_specs_v5.2.md#85-topics-mqtt-spécifiques-à-rfxcom)
> pour l'encodage exact de `deviceId`. Le topic de découverte (`.../config`, déduit de `~`) reste standard HA.

---

## 8. Configuration

### 8.1 Fichier config.yaml (Paramètres généraux)
**Seuls les paramètres généraux RFXCOM sont dans ce fichier :**

```yaml
# ============================================================
# Configuration Socle (voir specs-techniques-socle-ha-mqtt.md)
# ============================================================
ha:
  ws:
    host: "192.168.1.100"
    port: 8123
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

mqtt:
  host: "192.168.1.100"
  port: 1883
  client_id: "ha-rfxcom-001"

web:
  port: 8080
  host: "0.0.0.0"

# ============================================================
# Configuration RFXCOM - Paramètres généraux
# ============================================================
rfxcom:
  port: "/dev/ttyUSB0"
  baudRate: 38400
  
  # Règle de transmission (obligatoire)
  transmission:
    requireQuoi: true
    requireLieu: true
  
  # Auto-détermination QUOI activée par défaut
  autoDetermineQuoi: true
  
  # Fichier de configuration des devices/récepteurs/appairages
  devicesConfigFile: "config-rfxcom-devices-v1.0.yaml"
  
  # **NOUVEAU v5.4 - Actions MQTT par le socle**
  # Toutes les actions MQTT sont gérées par le socle HA-MQTT
  # L'application RFXCOM utilise uniquement les événements EventBus mis à disposition
  mqttActions:
    enabled: true
    useSocleBridge: true
```

> ⚠️ **IMPORTANT** : 
> - Les **devices RFXCOM**, **récepteurs** et **appairages** sont dans **`config-rfxcom-devices-v1.0.yaml`** (fichier séparé)
> - Seul le fichier principal `config.yaml` contient les paramètres généraux (port série, MQTT, etc.)
> - **Les actions MQTT sont gérées par le socle** - RFXCOM n'interagit pas directement avec MQTT mais utilise les services du socle


### 8.2 Paramètres Techniques dans l'UI - Gestion des Protocoles (matériel, v5.8)

> **⭐ v5.8 — Remplace intégralement l'ancien mécanisme (v5.4)** : le filtre logiciel après décodage,
> avec sa granularité interne (Lighting1/2/4/5/6/Blinds1/RFXSensor/RFXMeter) et ses événements
> `rfxcom:protocol:toggle`/`rfxcom:protocols:update`, a été **retiré** (demande utilisateur — jugé
> trop complexe à opérer sans documentation, sans réel gain face au filtre matériel une fois celui-ci
> vérifié en conditions réelles). **Seul persiste désormais le filtre matériel** décrit ci-dessous.
>
> ⚠️ **Limitation connue et acceptée** : `RFXMeter` (compteurs élec, `elec1`/`23`/`4`/`5`) n'a **aucun
> bit correspondant** dans la table de protocoles matériel du RFXtrx433
> (`node_modules/rfxcom/lib/index.js::protocols_RFXtrx433`) — il n'existe donc plus aucun moyen de
> filtrer ces messages, ni matériel ni logiciel, depuis ce retrait.

**Principe :**
> - Le RFXtrx433 rapporte, à chaque connexion (poignée de main `initialise()`, événement `status` de
>   la bibliothèque `rfxcom`), son type de récepteur, son firmware et ses protocoles **actuellement
>   actifs matériellement** — granularité fine et propre à la bibliothèque (ex: `X10`, `ARC`, `AC`,
>   `OREGON`, `LIGHTWAVERF`...), distincte de nos catégories internes `RfxComDeviceType`
>   (`Lighting1`/`Lighting2`/...).
> - **Notre sélection persistée (`enabledHardwareProtocols`) est la seule source de vérité** : ce que
>   le matériel rapportait à la connexion **n'écrase jamais** cette liste, dans aucun sens.
> - Cette sélection est **repoussée** au matériel (commande "mode"/`configureRFX` de la bibliothèque,
>   PAS `saveRFXProtocols`) **en mémoire RAM du RFXtrx433 uniquement** — jamais écrite dans sa mémoire
>   non volatile (limite documentée de 10 000 cycles d'écriture pour l'EEPROM). Le matériel oublie ce
>   choix à la prochaine coupure d'alimentation ; c'est pourquoi le push est refait à chaque connexion.
> - Liste vide en configuration = tous les protocoles gérables par ce récepteur sont demandés par défaut.

**Interface (onglet Protocoles, voir §12) :**
```
Statut matériel du RFXtrx433
  Récepteur : 433.92MHz transceiver
  Firmware : Ext v1006
  [🔄 Rafraîchir]

Protocoles matériel (poussés au RFXtrx433)
  [ ] BLYSS
  [x] RUBICSON
  [x] FINEOFFSET
  [x] LIGHTING4
  ...
  [x] AC
  ... (catalogue complet dépend du receiverTypeCode rapporté)
  [Envoyer au RFXtrx433]
```

**Flux :**
1. À la connexion, le service reçoit le statut matériel (`RfxComTransceiver.onHardwareStatus`) : type de récepteur, firmware, protocoles actifs rapportés, et catalogue complet dérivé de `rfxcom.protocols[receiverTypeCode]`.
2. Le service pousse **automatiquement**, une seule fois par session (verrou anti-boucle — le push lui-même redéclenche un événement `status` en retour), la sélection persistée au matériel.
3. Le client reçoit `rfxcom:protocols:list` avec le statut matériel et le catalogue+sélection courante.
4. Cocher/décocher une case (`rfxcom:hardware-protocol:toggle`) **persiste immédiatement** la sélection (fichier `config.yaml`, champ `enabledHardwareProtocols`) mais **n'envoie rien au matériel**.
5. Le bouton **"Envoyer au RFXtrx433"** (`rfxcom:hardware-protocols:push`) pousse la sélection actuellement persistée **en une seule fois**, quel que soit le nombre de cases modifiées depuis le dernier envoi.
6. Le bouton **"Rafraîchir"** (`rfxcom:hardware-status:refresh`) redemande au matériel son statut (commande "get status" de la bibliothèque) **sans reconnexion complète** — met à jour l'affichage (statut + protocoles actifs rapportés) mais ne repousse pas notre sélection.

**Persistance :**
> - La sélection est stockée dans la configuration RFXCOM (`config.yaml`, champ `enabledHardwareProtocols: string[]`, noms au format de la bibliothèque `rfxcom`)
> - Au démarrage, la sélection précédemment persistée est automatiquement repoussée au matériel (étape 2 ci-dessus)
> - Par défaut (liste vide), tous les protocoles gérables par ce récepteur sont poussés

### 8.3 Actions MQTT par le Socle (NOUVEAU v5.4)

**Principe fondamental :**
> - **L'application RFXCOM n'interagit PAS directement avec MQTT**
> - **Toutes les actions MQTT sont gérées par le socle HA-MQTT** via le service `HaMqttIntegrationService`
> - RFXCOM utilise **uniquement** les événements EventBus mis à disposition par le socle

**Flux MQTT via le socle :**
1. RFXCOM émet un événement sur l'EventBus (ex: `rfxcom:device:state`)
2. Le socle `HaMqttIntegrationService` écoute ces événements
3. Le socle traduit et publie sur les topics MQTT appropriés vers Home Assistant
4. Pour les commandes HA → RFXCOM : le socle reçoit les messages MQTT et les convertit en événements EventBus
5. RFXCOM écoute ces événements EventBus et agit en conséquence

**Avantages :**
- ✅ **Découplage total** entre RFXCOM et MQTT
- ✅ **Réutilisable** pour d'autres applications
- ✅ **Maintenance centralisée** dans le socle
- ✅ **Tests simplifiés** (mock de l'EventBus au lieu de MQTT)

**Événements clés pour RFXCOM :**
- `rfxcom:device:state` → Publication état device vers HA
- `rfxcom:receiver:state` → Publication état récepteur vers HA
- `ha:command` → Réception commandes de HA (converties depuis MQTT par le socle)
- `rfxcom:discovery` → Envoi des messages de discovery vers HA

---

## 9. Gestion des Données QUOI et OÙ

### 9.1 Règle Fondamentale (MAJ v5.4)
**Toute transmission vers HA est conditionnée par une case à cocher dans les fenêtres modales**

> ⚠️ **CHANGEMENT IMPORTANT v5.4** :
> - **PLUS** conditionné par QUOI + lieu_principal
> - **NOUVEAU** : Une donnée spécifique `transmitToHa: boolean` dans chaque device/recepteur
> - Si `transmitToHa: true`, le device sera envoyé vers HA
> - **Dès le démarrage**, TOUS les devices avec `transmitToHa: true` sont **automatiquement envoyés à HA**
> - Le nommage (QUOI---lieu---...) est toujours utilisé pour les entity_id, mais ne conditionne plus l'envoi

### 9.2 Auto-détermination du QUOI
**Algorithme :**
```typescript
function determineQuoi(message: RfxComRawMessage): string {
  const defaultQuoi = getDefaultQuoi(message.subType);
  if (defaultQuoi) return defaultQuoi;
  return message.subType;
}
```

### 9.3 Extraction de la Taxonomie
```typescript
function extractTaxonomie(fullName: string): Taxonomie {
  const parts = fullName.split('---');
  const raw_quoi = (parts[0] || '').trim();
  const lieux = parts[1] ? parts[1].split('--') : [];
  
  return {
    raw_quoi,
    slug_quoi: raw_quoi ? slugify(raw_quoi) : '',
    nom_precis: lieux[0]?.trim() || null,
    slug_precis: lieux[0]?.trim() ? slugify(lieux[0].trim()) : null,
    nom_lieu: lieux.length > 1 ? lieux[1]?.trim() : (lieux[0]?.trim() || null),
    slug_lieu: lieux.length > 1 ? lieux[1]?.trim() ? slugify(lieux[1].trim()) : null : 
               (lieux[0]?.trim() ? slugify(lieux[0].trim()) : null),
    nom_pere: lieux[2]?.trim() || null,
    slug_pere: lieux[2]?.trim() ? slugify(lieux[2].trim()) : null,
    nom_grand_pere: lieux[3]?.trim() || null,
    slug_grand_pere: lieux[3]?.trim() ? slugify(lieux[3].trim()) : null
  };
}
```

---

## 10. Fichier de Configuration Centralisé

### 10.1 `config-rfxcom-devices-v1.0.yaml`
**Structure complète :**

```yaml
# ============================================
# SECTION 1 : DEVICES RFXCOM PHYSIQUES
# ============================================
rfxcom_devices:
  rfxsensor_0xa5b3:
    sensorId: "0xA5B3"
    type: "RFXSensor"
    subType: "Temperature"
    name: "Température---Salon"
    protocole: "rfxsensor"
    defaultQuoi: "Température"
  
  lighting2_0x02b3:
    sensorId: "0x02B3"
    type: "Lighting2"
    subType: "AC"
    name: "Bouton---Salon"
    protocole: "lighting2"
    defaultQuoi: "Bouton"

# ============================================
# SECTION 2 : RÉCEPTEURS LOGIQUES
# ============================================
rfxcom_receivers:
  recepteur_001:
    receiverId: "recepteur_001"
    name: "Lumière---Salon"
    type: "light"
    isDimmable: true
    defaultLevel: 80
    primaryEmitter: "lighting2_0x02b3"  # ⭐ Émetteur principal pour envoyer les commandes RF433
    emitters:                           # ⭐ Liste complète des émetteurs associés (N↔N)
      - emitterId: "lighting2_0x02b3"
        action: "toggle"
      - emitterId: "lighting2_0x1001"
        action: "set_level"
        value: 50

# ============================================
# SECTION 3 : MAPPING INVERSE (Optionnel)
# ============================================
# sensorId_to_receiver:
#   "0x02B3": "recepteur_001"
```

### 10.2 Règles du Fichier
- **Format** : YAML strict
- **Chargement** : Au démarrage du service RFXCOM
- **Sauvegarde** : À chaque modification via UI ou API
- **Validation** : Schéma Zod obligatoire avant chargement
- **Backup** : Copie automatique avant toute écriture

### 10.3 Exemple Complet
Voir fichier `config-rfxcom-devices-v1.0.yaml` à la racine du projet.

---

## 11. Traces et Journalisation

**NOUVEAU v5.3 - Traces détaillées pour le démarrage et la connexion :**

### 11.1 Traces côté Serveur
- **Démarrage du service** : `INFO [RfxComService] Démarrage du service RFXCOM...`
- **Tentative de connexion** : `INFO [RfxComService] Tentative de connexion au transceiver RFXCOM sur {port}...`
- **Connexion réussie** : `INFO [RfxComService] Transceiver RFXCOM initialisé avec succès sur {port}`
- **Échec de connexion** : `WARN [RfxComService] Tentative de connexion RFXCOM échouée - Motif: {erreur}` ou `WARN [RfxComService] Initialisation du transceiver RFXCOM échouée - Motif: {erreur}`

### 11.2 Traces côté Client
- **État de connexion** : Événement `rfxcom:status` émis avec `{connected: boolean, devicesCount: number, receiversCount: number, lastDiscovery: string}`
- **Chargement de la config** : Logs disponibles pour le chargement et la sauvegarde de la configuration

### 11.3 Recommandations
- Les erreurs de connexion (matériel absent, mauvais paramètres) sont normales et ne doivent pas bloquer l'application
- Les warnings de connexion doivent afficher le motif précis pour aider au diagnostic

---

## 12. Interface Web et Socket.io

### 12.1 Communication
- **Socket.io** est le canal principal de communication entre UI et serveur
- **Le fichier YAML peut aussi être édité manuellement** (rechargé automatiquement)
- La configuration est soumise via `config:save` et déclenche un redémarrage

### 11.2 Fonctionnalités UI pour RFXCOM

**NOUVEAU v5.4 - Organisation de l'interface :**
- **Structure en onglets** : Devices | Récepteurs | Scènes (réactivées et intégrées) | **Protocoles** *(⭐ v5.8, voir §8.2 pour le détail fonctionnel)*
- **Appairages intégrés aux Récepteurs** : Les appairages (device → récepteur) sont gérés dans l'onglet Récepteurs (remplace le terme Associations)
- **Indicateur de connexion RFX433** : Badge dans l'en-tête affichant l'état de connexion au transceiver (🟢 Connecté / 🔴 Déconnecté)
- **Actions MQTT par le socle** : Toutes les actions MQTT (publication, abonnement) sont gérées par le socle HA-MQTT, l'application RFXCOM utilise uniquement les événements mis à disposition

**Indicateur de connexion :**
| État | Couleur | Texte | Comportement |
|------|--------|------|-------------|
| Connecté | Vert (#28a745) | "Connecté" | Transceiver RFX433 opérationnel |
| Déconnecté | Rouge (#dc3545) | "Déconnecté" | Transceiver non connecté (mauvais paramètres ou matériel absent) |

**Mécanisme :**
- L'indicateur est mis à jour automatiquement dès qu'un événement `rfxcom:status` est reçu
- Le statut est demandé automatiquement au chargement de l'écran RFXCOM
- Le service RFXCOM émet `rfxcom:status` à chaque changement d'état (connexion, déconnexion, erreur)

**Gestion des Devices :**
1. **Liste des devices détectés** : Affiche tous les devices RFXCOM avec leur sensorId, type, subType
2. **QUOI auto-rempli** : Le QUOI est prérempli depuis le subType, modifiable par l'utilisateur
3. **Taxonomie en 5 champs séparés** *(⭐ v5.8)* : le formulaire de paramétrage (fenêtre modale, voir
   note ci-dessous) sépare le `name` technique en 5 champs indépendants — **Quoi**, **Lieu précis**,
   **Lieu** (obligatoire), **Père**, **Grand-père** — au lieu d'un unique champ `OÙ` en texte libre à
   séparateurs `--`. Chaque champ a sa propre icône de sauvegarde (💾, même pattern que l'application
   EVOO7), permettant de corriger un seul niveau sans ressaisir toute la hiérarchie. Côté serveur,
   les 5 champs sont recomposés en un seul `name` (`quoi---lieu_precis--lieu--pere--grand_pere`) avant
   envoi via `rfxcom:device:set_name` — le contrat Socket.io (§12.3) est inchangé.
4. **Deux listes distinctes** :
   - **Devices déjà paramétrés** : Chargés depuis le fichier de configuration centralisé
   - **Devices en auto-discovery** : Détectés par scan mais non encore configurés

**Barre d'outils (toolbar) :**
| Bouton | Icône | Événement Socket.io | Description |
|--------|-------|---------------------|-------------|
| Scanner RF433 | 🔍 | `rfxcom:scan:start` | Démarre la détection automatique des devices RF433 |
| Effacer non paramétrés | 🗑️ | `rfxcom:devices:clear-unconfigured` | Supprime les devices auto-découverts non configurés |
| Rafraîchir | 🔄 | `rfxcom:devices:refresh` | Recharge la liste des devices **déjà paramétrés** depuis le fichier |

**Note :** Le bouton "Sauvegarder" a été supprimé - les sauvegardes sont déclenchées via les fenêtres
modales. *(⭐ v5.8 — précision de périmètre)* Les formulaires d'ajout/modification des **Devices**,
des **Récepteurs** et des **Scènes** sont tous les trois présentés en **fenêtre modale** (overlay,
fermeture par clic sur le fond ou bouton Annuler) plutôt qu'en formulaire intégré à la page.

**Gestion des Récepteurs :**
1. **Création de récepteur** : Définir type (switch/light/cover), primaryEmitter, et liste des emitters
2. **Configuration variateur** : Pour Lighting2, cocher "isDimmable" pour activer le mode variateur
3. **Configuration covers** : Saisie des délais openTimeSec/closeTimeSec **OBLIGATOIRES**
4. **Taxonomie en 5 champs séparés** *(⭐ v5.8)* : même pattern que pour les Devices (point 3
   ci-dessus) — Quoi/Lieu précis/Lieu/Père/Grand-père saisis séparément dans la fenêtre modale.

**Gestion des Appairages (Appairages) :**
> ⚠️ **Intégrées dans l'onglet Récepteurs** (pas d'onglet séparé)
>
1. **Ajout d'émetteurs à un récepteur** : Sélectionner des émetteurs dans la liste des devices détectés
2. **Définir l'action** : toggle, on, off, set_level (pour light), open, close, stop (pour cover)
3. **Définir le primaryEmitter** : L'émetteur principal qui enverra les commandes RF433
4. **Stockage** : Les appairages N↔N sont stockées directement dans la définition du récepteur (primaryEmitter + liste des émetteurs appairés)
5. **Libellés lisibles** *(⭐ v5.8)* : les listes déroulantes de sélection d'émetteur (primaryEmitter
   et emitters) affichent un libellé dérivé de la taxonomie (QUOI + hiérarchie de lieux, ex:
   `Bouton · Salon (lighting2_0x02b3)`) plutôt que le `uniqueId` brut seul — sans quoi il est
   impossible de savoir de quel device il s'agit au moment de l'appairage.

**Scènes :**
> ✅ **Fonctionnalité réactivée v5.4** - Onglet dédié disponible avec création/modification/suppression via UI

### 11.3 Événements Socket.io

**NOUVEAU v5.1 - Événements de détection et gestion :**

**Server → Client :**
```typescript
'rfxcom:devices:list': { devices: RfxComDeviceInfo[] }           // Liste complète des devices
'rfxcom:receivers:list': { receivers: ReceiverConfig[] }          // Liste complète des récepteurs
'rfxcom:device:detected': { device: RfxComDeviceInfo }           // Nouveau device détecté (auto-discovery)
'rfxcom:receiver:created': { receiver: ReceiverConfig }           // Récepteur créé
'rfxcom:scan:start': {}                                             // Notification: scan démarré
'rfxcom:scan:complete': { devices: RfxComDeviceInfo[] }           // Notification: scan terminé avec résultats
'rfxcom:scan:failed': { error: string }                             // Notification: échec du scan
'rfxcom:protocols:list': {                                          // ⭐ v5.8 — statut + catalogue/sélection matériel (voir §8.2)
  hardware: { receiverType: string; receiverTypeCode: number; firmwareVersion: number;
              firmwareType: string; enabledProtocols: string[]; availableProtocols: string[] } | null;
  hardwareAvailable: string[];   // Catalogue complet pour ce receiverTypeCode
  hardwareEnabled: string[];     // Sélection persistée (enabledHardwareProtocols)
}
```

**Client → Server :**
```typescript
'rfxcom:receiver:create': { config: ReceiverConfig }               // Créer un récepteur
'rfxcom:receiver:update': { receiverId: string, config: Partial<ReceiverConfig> }  // Mettre à jour un récepteur
'rfxcom:receiver:delete': { receiverId: string }                   // Supprimer un récepteur
'rfxcom:devices:refresh': {}                                       // NOUVEAU: Rafraîchir la liste des devices
'rfxcom:scan:start': {}                                            // NOUVEAU: Démarrer un scan de détection
'rfxcom:devices:clear-unconfigured': {}                           // NOUVEAU: Effacer devices non paramétrés
'config:save': AppConfig                                            // Sauvegarder la configuration globale
'rfxcom:protocols:list:get': {}                                    // ⭐ v5.8 — Redemander le statut+catalogue+sélection matériel
'rfxcom:hardware-protocol:toggle': { protocol: string; enabled: boolean }  // ⭐ v5.8 — Persiste la case (pas de push matériel)
'rfxcom:hardware-protocols:push': {}                                // ⭐ v5.8 — Pousse la sélection persistée au matériel, en une fois (bouton "Envoyer au RFXtrx433")
'rfxcom:hardware-status:refresh': {}                                // ⭐ v5.8 — Redemande le statut au matériel sans reconnexion (bouton "Rafraîchir")
```

> **⭐ v5.8** : les événements `rfxcom:protocol:toggle` et `rfxcom:protocols:update` (ancien filtre
> logiciel, v5.4) sont **supprimés** — voir §8.2.

---

## 13. Scénarios d'Utilisation

### 12.1 Découverte d'un Capteur (Température)
```
1. RFXCOM reçoit: RFXSensor Temperature 0xA5B3
2. Auto-détermination: subType "Temperature" → QUOI = "Température"
3. Génération: protocole = "rfxsensor", entity_id = "sensor.rfxsensor_0xa5b3"
4. Ajout automatique dans config-rfxcom-devices-v1.0.yaml:
   rfxcom_devices:
     rfxsensor_0xa5b3:
       sensorId: "0xA5B3"
       name: "Température---[à compléter]"
5. UI propose de compléter le OÙ
6. Utilisateur saisit: "Température---Salon"
7. Validation: QUOI="Température" ✅, lieu="Salon" ✅
8. Publication Discovery MQTT
9. HA découvre: sensor.rfxsensor_0xa5b3
```

### 12.2 Découverte d'un Émetteur (Lighting2)
```
1. RFXCOM reçoit: Lighting2 0x02B3
2. Auto-détermination: type "Lighting2" → QUOI = "Bouton"
3. Génération: protocole = "lighting2", unique_id = "lighting2_0x02b3"
4. Ajout automatique dans config-rfxcom-devices-v1.0.yaml:
   rfxcom_devices:
     lighting2_0x02b3:
       sensorId: "0x02B3"
       name: "Bouton---[à compléter]"
5. **Par défaut: composant HA = binary_sensor**
6. UI propose de compléter le OÙ
7. Publication Discovery MQTT (binary_sensor.lighting2_0x02b3)
8. HA découvre l'émetteur
```

### 12.3 Création d'un Récepteur avec Variateur
```
1. Utilisateur crée un récepteur via UI
   - receiverId: "recepteur_001" (auto-généré)
   - name: "Lumière---Salon"
   - type: "light"
   - isDimmable: true  # ⭐ Mode variateur activé
   - primaryEmitter: "lighting2_0x02b3"  # ⭐ Émetteur principal
   - emitters:  # ⭐ Liste des émetteurs associés
       - emitterId: "lighting2_0x02b3", action: "toggle"
       - emitterId: "lighting2_0x1001", action: "set_level", value: 50
2. Sauvegarde dans config-rfxcom-devices-v1.0.yaml
3. Publication Discovery MQTT (light.recepteur_001)
4. Test: appui sur bouton physique 0x02B3 → recepteur_001 toggle
5. Test: commande HA light.recepteur_001/set → Envoi RF433 à 0x02B3
```

### 12.4 Appairage Multiple (N↔N)
```
Récepteur recepteur_001 (light) a:
  primaryEmitter: "lighting2_0x02b3"
  emitters:
    - emitterId: "lighting2_0x02b3", action: "toggle"
    - emitterId: "lighting2_0x1001", action: "set_level", value: 50

Émetteur lighting2_0x02b3 est référencé dans:
  - recepteur_001 (primaryEmitter)
  - recepteur_002 (dans emitters[])

Appui sur lighting2_0x02b3:
  → recepteur_001 toggle (car primaryEmitter)
  → recepteur_002 exécute son action (ex: on)
```

### 12.5 Ajout d'un Bouton via Détection Automatique (MAJ v5.4)
```
Workflow simplifié pour ajouter un nouveau bouton RF433 sans naviguer dans une longue liste :

1. **Onglet Devices** : Utilisateur va dans Applications → RFXCOM → onglet Devices
2. **Effacement** : **NOUVEAU** - Clique sur "🗑️ Effacer non paramétrés" → `rfxcom:devices:clear-unconfigured` → Supprime tous les devices de la liste "auto-discovery" qui n'ont pas été paramétrés
3. **Rafraîchir** : Clique sur "🔄 Rafraîchir" → charge la liste des **devices déjà paramétrés**
4. **Scanner** : Clique sur "🔍 Scanner RF433" → déclenche `rfxcom:scan:start`
5. **Serveur** : RFXCOM commence la détection RF433
6. **Notification** : Client reçoit `rfxcom:scan:start` → affiche "Scan en cours..."
7. **Détection** : Premier device RF433 détecté → serveur émet `rfxcom:device:detected`
8. **Client** : Reçoit le device → l'ajoute à la liste des **devices en auto-discovery**
9. **Affichage** : Le device apparaît avec icône "non paramétré" (ex: 📝 ou ⚠️)
10. **Sélection** : Utilisateur clique sur le device → ouvre **modale de paramétrage**
11. **Paramétrage** : Utilisateur remplace "[à compléter]" par son OÙ (ex: "Bouton---Salon")
12. **Validation** : QUOI auto-déterminé depuis subType (ex: "Bouton") + OÙ validé
13. **Sauvegarde** : Via modale → `rfxcom:device:update` → device passé en "paramétré"
14. **Rafraîchissement** : Liste mise à jour → device disparaît de "auto-discovery", apparaît dans "paramétrés"
```

**Nommage automatique :** 
- Le formulaire de paramétrage propose automatiquement le QUOI basé sur le subType du message RFXCOM
- Le OÙ doit être saisi manuellement mais la construction du nom technique (`<protocole>_<sensorId>`) est automatique
- La construction du name pour HA suit le pattern `QUOI---lieu_precis--lieu--lieu_pere--lieu_grand_pere` avec les séparateurs `---` (majeur) et `--` (mineur)

**Persistance :**
- Les devices **paramétrés** sont sauvegardés dans `config-rfxcom-devices-v1.0.yaml` avec leur `transmitToHa` par défaut à `false`
- Seuls les devices avec `transmitToHa: true` sont envoyés vers HA au démarrage
- Les devices **auto-découverts non paramétrés** ne sont PAS sauvegardés dans le fichier YAML (seulement en mémoire côté serveur pendant la session)

---

## 14. Gestion des États

### 13.1 Attributes Communs
```json
{
  "signal_level": -75,
  "battery_level": 9,
  "sensor_id": "rfxsensor_0xa5b3",
  "device_id": "rfxsensor_0xa5b3",
  "attributs_taxonomie": {
    "quoi": "Température",
    "slug_quoi": "temperature",
    "lieu_principal": "Salon",
    "slug_lieu": "salon"
  }
}
```

---

## 15. Commandes

### 14.1 Émetteurs Lighting (binary_sensor par défaut)
| Type | Commandes HA | Signification |
|------|--------------|---------------|
| Lighting1/2/4 | on, off | Émission signal RF433 ON/OFF |

### 14.2 Récepteurs
| Type | Commandes HA | Action RFXCOM |
|------|--------------|----------------|
| switch | on, off, toggle | Envoi ON/OFF au device cible (via primaryEmitter) |
| light | on, off, toggle, set_level | Conversion level 0-100%, envoi au device cible |
| cover | open, close, stop, set_position | Envoi OPEN/CLOSE/STOP au device cible |

### 14.3 Scènes RFXCOM (RÉACTIVÉES v5.4)

Une **scène** est un ensemble de commandes exécutées simultanément ou séquentiellement sur plusieurs récepteurs.

**NOUVEAU v5.4 :**
- Les scènes sont **réactivées et pleinement intégrées** dans l'interface
- Onglet dédié "Scènes" disponible dans RFXCOM
- Création, modification, suppression via UI
- Exécution déclenchée par événements Socket.io

#### 14.3.1 Structure des Scènes
Chaque scène est définie dans `config-rfxcom-devices-v1.0.yaml` avec la structure suivante :

```yaml
rfxcom_scenes:
  <sceneId>:
    id: "<sceneId>"                    # Identifiant unique (ex: scene_001)
    name: "<QUOI>---<OÙ>"              # Ex: "Scène---Soirée--Salon" (conforme spec-nommage-v1.0.md)
    description: "<description>"       # Optionnel
    type: "parallel" | "sequential"     # Mode d'exécution (défaut: sequential)
    delayBetweenCommands: <ms>         # Délai entre commandes en mode sequential (défaut: 500)
    commands:                         # Liste des commandes à exécuter
      - target: "<receiverId>"          # Récepteur cible (obligatoire)
        action: "<action>"              # Commande HA (ex: turn_on, set_level)
        parameters:                     # Paramètres optionnels
          brightness?: 0-255           # Pour les récepteurs dimmables
          position?: 0-100             # Pour les covers
          transition?: <ms>            # Durée de transition (optionnel)
```

#### 14.3.2 Exemple de Scène
```yaml
rfxcom_scenes:
  scene_001:
    id: "scene_001"
    name: "Soirée---Salon"
    description: "Allume les lumières du salon à 50% et ferme les volets"
    type: "sequential"
    delayBetweenCommands: 300
    commands:
      - target: "recepteur_001"
        action: "turn_on"
        parameters:
          brightness: 128
      - target: "recepteur_002"
        action: "close"
      - target: "recepteur_003"
        action: "turn_on"
```

#### 14.3.3 Comportement des Scènes
- **Mode `parallel`** : Toutes les commandes sont envoyées **simultanément**.
- **Mode `sequential`** : Les commandes sont envoyées **les unes après les autres**, avec un délai de `delayBetweenCommands` entre chaque.
- **Gestion des erreurs** :
  - Si une commande échoue en mode `sequential`, les commandes suivantes **sont annulées**.
  - En mode `parallel`, toutes les commandes sont tentées **même si certaines échouent**.
- **Feedback** : À la fin de l'exécution, un événement `rfxcom:scene:executed` est émis avec :
  ```typescript
  {
    sceneId: string;
    success: boolean;
    executedCommands: number;
    failedCommands: number;
    errors: Array<{
      receiverId: string;
      action: string;
      error: AppError;  // Voir specs-erreurs-v1.0.md
    }>;
    duration: number;   // Durée totale en ms
  }
  ```

#### 14.3.4 Intégration avec Home Assistant
Les scènes sont publiées comme des **automatisations HA** via MQTT Discovery. Bridge `rfx_bridge_0001` :

```json
{
  "name": "Soirée Salon",
  "unique_id": "rfxcom_scene_001",
  "automation_type": "trigger",
  "topic": "/rfxcom/rfx_bridge_0001/scene_scene_001/set",
  "payload": "{}",
  "device": {
    "identifiers": ["rfxcom_scene_001"],
    "name": "RFXCOM Scène",
    "manufacturer": "RFXCOM",
    "model": "Scene"
  }
}
```

**Topics MQTT pour les scènes** *(⭐ v5.6 — conforme au format §8.5 de `recepteurs-emetteurs-rfxcom_specs`)* :
- **Exécution** : `/rfxcom/{bridgeInstance}/scene_{sceneId}/set` (HA → App, QoS 1, retain false)
- **Résultat** : `/rfxcom/{bridgeInstance}/scene_{sceneId}/state` (App → HA, QoS 0, retain false)

> **⭐ v5.7 — Simplification connue, non vérifiée sur une instance HA réelle** : le schéma HA
> canonique du component `device_automation` utilise deux segments d'identifiant dans le topic de
> découverte (`homeassistant/device_automation/{device_id}/{trigger_id}/config`). Le socle ne
> construit qu'un `objectId` unique pour tous les components (`buildDiscoveryPayload`,
> `techniques-socle-ha-mqtt_specs` §8.5.0) — la découverte de scène RFXCOM utilise donc
> `homeassistant/device_automation/rfxcom_scene_{sceneId}/config`, testé uniquement contre le
> broker MQTT (souscription/publication effectives), jamais contre une instance HA réelle qui
> validerait l'enregistrement de l'entité côté HA.

#### 14.3.5 Commandes Spécifiques aux Scènes

> **⭐ v5.7** : noms d'événements réellement implémentés — alignés sur la convention
> `rfxcom:{ressource}s:list` déjà utilisée pour devices/récepteurs (`RFXCOM_SOCKET_EVENTS`/
> `RFXCOM_CLIENT_EVENTS` dans `domain/socket-events.ts`), plutôt que le singulier `rfxcom:scene:list`
> initialement documenté ci-dessous.

| Commande | Description | Payload |
|----------|-------------|---------|
| `rfxcom:scene:execute` | Exécuter une scène | `{ sceneId: string }` |
| `rfxcom:scene:cancel` | Annuler une scène en cours (best-effort : n'interrompt qu'un mode `sequential` entre deux commandes, ne peut pas annuler un envoi RF433 déjà lancé) | `{ sceneId: string }` |
| `rfxcom:scenes:list:get` *(⭐ v5.7, remplace `rfxcom:scene:list`)* | Demander la liste des scènes | — |
| `rfxcom:scenes:list` *(⭐ v5.7, remplace `rfxcom:scene:list`)* | Liste des scènes (réponse + événement persistant) | `{ scenes: ReceiverSceneConfig[] }` |
| `rfxcom:scene:create` / `rfxcom:scene:update` / `rfxcom:scene:delete` | CRUD scène (distinct de `rfxcom:receiver:*`, qui rejette explicitement `type: 'scene'`) | `{ config }` / `{ sceneId, config }` / `{ sceneId }` |
| `rfxcom:scene:created` | Scène créée | `{ scene: ReceiverSceneConfig }` |
| `rfxcom:scene:updated` | Scène mise à jour | `{ scene: ReceiverSceneConfig }` |
| `rfxcom:scene:deleted` | Scène supprimée | `{ sceneId: string }` |

#### 14.3.6 États des Scènes
| État | Description | Événement EventBus | Événement Socket.io |
|------|-------------|-------------------|-------------------|
| `scene_pending` | Scène en attente d'exécution | `rfxcom:scene:status` | - |
| `scene_executing` | Scène en cours d'exécution | `rfxcom:scene:status` | - |
| `scene_completed` | Scène terminée avec succès | `rfxcom:scene:executed` | `rfxcom:scene:executed` |
| `scene_failed` | Scène terminée avec erreurs | `rfxcom:scene:executed` | `rfxcom:scene:executed` |
| `scene_cancelled` | Scène annulée | `rfxcom:scene:executed` | `rfxcom:scene:executed` |

> **⭐ v5.7 — Simplification connue** : `SceneExecutionResult` (§14.3.3) ne porte qu'un booléen
> `success`, pas un état distinct par cause. En pratique, `scene_failed` et `scene_cancelled`
> produisent donc le même résultat (`success: false`) — le payload `rfxcom:scene:executed` ne permet
> pas à l'UI de distinguer "annulée par l'utilisateur" de "échec d'une commande" sans inspecter
> `errors[]` (vide en cas d'annulation, peuplé en cas d'échec réel).

### 14.4 Commandes Spécifiques aux Récepteurs Dimmables

Pour les récepteurs avec `isDimmable: true` :

| Commande HA | Action RFXCOM | Conversion |
|--------------|----------------|-----------|
| `turn_on` | Envoi ON avec dernier niveau | Utilise `defaultLevel` ou 100% |
| `turn_off` | Envoi OFF | - |
| `toggle` | Basculer ON/OFF | Inverse l'état actuel |
| `set_level` | Envoi ON avec niveau spécifié | `level = brightness * 255 / 100` |

**Note** : Le niveau RFXCOM est en **0-255**, tandis que HA utilise **0-100%**.

### 14.5 Commandes Spécifiques aux Covers

Pour les récepteurs de type `cover` :

| Commande HA | Action RFXCOM | Paramètres |
|--------------|----------------|------------|
| `open` | Envoi OPEN au device | `duration = openTimeSec * 1000` |
| `close` | Envoi CLOSE au device | `duration = closeTimeSec * 1000` |
| `stop` | Envoi STOP au device | - |
| `set_position` | Envoi SET_POSITION au device | `position = 0-100%` |

**Timing** : Les délais `openTimeSec` et `closeTimeSec` sont **obligatoires** pour les covers.

---



## 16. Traduction Commandes HA → RFXCOM *(NOUVEAU v5.5)*

### 16.1 Règles Générales
**Principe :** Chaque type de récepteur (Switch, Light, Cover) **implémente sa propre logique de traduction** en fonction du **type du primaryEmitter**.

**Flux :** HA → EventBus → RfxComService → ReceiverManager → Receiver*.translateHaCommand() → Commande RFXCOM

### 16.2 Récepteurs Switch
| Commande HA | Commande RFXCOM |
|-------------|------------------|
| `turn_on` | `on` |
| `turn_off` | `off` |
| `toggle` | `on`/`off` (inverse) |

### 16.3 Récepteurs Light
**A. NON dimmable** → Comme Switch  
**B. Dimmable** : Lighting5/6 → `set_level(value)`, Lighting2 → `on`/`off`

| Commande | Lighting2 | Lighting5/6 |
|----------|-----------|--------------|
| `turn_on` | `on` | `set_level(last||100)` |
| `turn_off` | `off` | `set_level(0)` |

### 16.4 Récepteurs Cover avec Lighting2
**États :** `up` (100%), `down` (0%), `intermediate` (0%<pos<100%)

**Calcul :** `position = startPos ± (elapsedMs/timeSec*100)`

| État | Commande | Action | Résultat |
|------|----------|--------|----------|
| `up` | `open` | Ignoré | 100% |
| `up` | `close` | `off` | Début descente |
| `down` | `open` | `on` | Début montée |
| `intermediate` | `open`/`close`/`stop` | `on`/`off`/dernière | Arrêt |

### 16.5 Récepteurs Cover avec Blinds1/Curtain1
| Commande HA | Commande RFXCOM |
|-------------|------------------|
| `open` | `open` (duration) |
| `close` | `close` (duration) |
| `stop` | `stop` |

---

## 17. Arborescence des Programmes *(NOUVEAU v5.5)*

```
applications/rfxcom/
├── index.ts, package.json, tsconfig.json
├── domain/
│   ├── types.ts, config-schema.ts, socket-events.ts
│   ├── RfxComService.ts              # Orchestrateur
│   ├── yaml/ConfigFileManager.ts     # Gestion YAML
│   ├── devices/DeviceManager.ts      # Registry devices
│   │   └── handlers/[RfxSensor|Lighting]Handler.ts
│   ├── receivers/ReceiverManager.ts   # Orchestre récepteurs
│   │   ├── base/BaseReceiver.ts      # Classe abstraite
│   │   ├── switch/ReceiverSwitch.ts   # on/off/toggle
│   │   ├── light/ReceiverLight.ts    # dimmable/non
│   │   └── cover/ReceiverCover.ts    # Lighting2/Blinds1
│   └── scenes/[SceneManager|Executor].ts
└── presentation/[index.ts|tsconfig.json|ts/app.ts|index.html]
```

**Règles :** Max 400 lignes/fichier, découplage total, polymorphisme via BaseReceiver

---

## 18. Tests

| ID | Description | Type |
|----|-------------|------|
| RFX-001 | Auto-détermination QUOI depuis subType | Unitaire |
| RFX-002 | Génération entity_id/unique_id avec protocole | Unitaire |
| RFX-003 | QUOI = type fonctionnel pur (pas d'endroit) | Unitaire |
| RFX-004 | Lighting = binary_sensor par défaut | Unitaire |
| RFX-005 | Appairage N↔N émetteurs/récepteurs | Intégration |
| RFX-006 | Configuration variateur via fichier YAML | Intégration |
| RFX-007 | Validation QUOI/OÙ obligatoire | Unitaire |
| RFX-008 | primaryEmitter utilisé pour les commandes HA→RFXCOM | Intégration |

---

## 19. Limites et Contraintes

| Limite | Impact | Solution |
|--------|--------|----------|
| QUOI auto-déterminé | Peut ne pas correspondre | Modifiable dans le fichier YAML |
| Lighting = binary_sensor par défaut | Pas toujours adapté | Configurable via type de récepteur |
| Variateur uniquement via configuration | Pas de détection auto | Configuration manuelle obligatoire |
| Fichier YAML centralisé | Tail important pour beaucoup de devices | Structure optimisée et validation Zod |

---

## 20. Roadmap

### V4 (Terminé)
- [x] Correction noms techniques
- [x] Clarification émetteurs/récepteurs
- [x] QUOI pur, entity_id avec protocole pour TOUS
- [x] Auto-détermination QUOI depuis subType

### V5 (Terminé)
- [x] **Fichier de configuration centralisé** (`config-rfxcom-devices-v1.0.yaml`)
- [x] **primaryEmitter dans chaque récepteur** pour les commandes HA→RFXCOM
- [x] **Liste des émetteurs appairés dans le récepteur** (appairages N↔N, remplace Associations)
- [x] **Attributs_taxonomie validé pour HA**
- [x] **Gestion des protocoles autorisés dans les paramètres techniques** (v5.4)
- [x] **Envoi conditionnel vers HA via transmitToHa** dans les fenêtres modales (v5.4)
- [x] **Scènes réactivées et intégrées** avec onglet dédié (v5.4)
- [x] **Actions MQTT gérées par le socle** - RFXCOM utilise uniquement EventBus (v5.4)
- [x] **Workflow devices complet** : détection, paramétrage, effacement non-paramétrés (v5.4)
- [x] **Clarification Lighting2** : TOUJOURS binary_sensor, récepteur peut être variateur (v5.4)
- [x] **Nommage automatique** avec séparateurs --- et -- (v5.4)
- [x] **Implémentation complète**

### V5.5 (Terminé - 18 Juillet 2026)
- [x] **Spécifications Cover avec Lighting2** : calcul position %, états up/down/intermediate, traduction on/off→montée/descente/stop
- [x] **Traduction Commandes HA→RFXCOM par type** : Switch, Light dimmable/non-dimmable, Cover avec différents émetteurs
- [x] **Arborescence des Programmes** : structure modulaire (Switch/Light/Cover séparés)
- [ ] Tests d'intégration

### V5.8 (Terminé - 27 Juillet 2026)
- [x] **Filtre de protocoles matériel** : remplace l'ancien filtre logiciel (v5.4), granularité fine de la bibliothèque `rfxcom`, push RAM uniquement en un lot via bouton dédié, bouton de rafraîchissement du statut
- [x] **Taxonomie en 5 champs séparés** avec sauvegarde individuelle, pour Devices et Récepteurs
- [x] **Fenêtres modales** étendues aux trois formulaires (Devices/Récepteurs/Scènes)
- [x] **Libellés lisibles** (dérivés de la taxonomie) dans les listes déroulantes d'émetteurs

---

## 21. Annexes

### 20.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](spec-nommage-v1.0.md) ⭐
- [Spécifications Récepteurs/Émetteurs](specs-recepteurs-emetteurs-rfxcom-v5.0.md)
- [Spécifications Techniques Socle HA-MQTT **OBLIGATOIRE**](specs-techniques-socle-ha-mqtt.md) ⭐
- [Fichier de configuration centralisé](config-rfxcom-devices-v1.0.yaml)
- [Documentation librairie npm rfxcom](https://www.npmjs.com/package/rfxcom) - Utilisée pour la gestion des protocoles RF433

### 20.2 Glossaire
| Terme | Définition |
|-------|------------|
| QUOI | **Type fonctionnel pur** (ex: "Température", "Humidité", "Bouton") |
| OÙ | Localisation hiérarchique (ex: "Salon", "Coin Canapé--Salon") |
| entity_id | `<domain>.<protocole>_<sensorId>` |
| unique_id | `<protocole>_<sensorId>` |
| primaryEmitter | Émetteur principal d'un récepteur, utilisé pour envoyer les commandes RF433 |
| Appairage | **Remplace Association** - Lien entre un émetteur et un récepteur (N↔N) |
| transmitToHa | Case à cocher dans les fenêtres modales pour autoriser l'envoi du device vers HA |
| Protocoles matériel *(⭐ v5.8, remplace "Protocoles autorisés")* | Sélection de protocoles (granularité bibliothèque `rfxcom`, ex: `AC`/`X10`/`OREGON`) poussée au RFXtrx433 en RAM, en un lot via le bouton dédié — voir §8.2 |

### 20.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-07-05 | Mistral Vibe | Version initiale |
| 2.0 | 2026-07-07 | Mistral Vibe | Intégration spec nommage.md |
| 3.0 | 2026-07-08 | Mistral Vibe | Correction noms techniques, clarification émetteurs/récepteurs |
| 4.0 | 2026-07-08 | Mistral Vibe | QUOI pur, entity_id avec protocole pour TOUS, auto-détermination, Lighting=binary_sensor, appairages N↔N via UI |
| 5.0 | 2026-07-09 | Mistral Vibe | **Fichier YAML centralisé, primaryEmitter, émetteurs dans récepteur, attributs_taxonomie validé** |
| 5.1 | 2026-07-16 | Mistral Vibe | **Détection automatique dans onglet Devices, toolbar Scanner/Effacer/Rafraîchir, deux listes devices (paramétrés vs auto-discovery), Appairages intégrées aux Récepteurs** |
| 5.4 | 2026-07-17 | Mistral Vibe | **Gestion des protocoles, transmitToHa, scènes réactivées, actions MQTT par le socle, workflow devices complet, nommage automatique ---/--, Lighting2 clarifié (binary_sensor), appairage remplace association** |
| 5.5 | 2026-07-18 | Mistral Vibe | **Spécifications Cover avec Lighting2 (états up/down/intermediate, calcul position%, traduction on/off), Traduction Commandes HA→RFXCOM par type, Arborescence des Programmes modulaire** |
| 5.6 | 2026-07-21 | Claude | Alignement des topics `state_topic` et scènes sur le nouveau format MQTT du socle (`/{moduleName}/{bridgeInstance}/{deviceId}/state\|set`), conforme à `techniques-socle-ha-mqtt_specs_v4.10.md` §8.5 |
| 5.7 | 2026-07-21 | Claude | **Scènes implémentées et testées** (§14.3) : `SceneManager`/`SceneExecutor` (voir `recepteurs-emetteurs-rfxcom_specs_v5.2.md` §6.1), onglet UI dédié. Événements Socket.io réels documentés (`rfxcom:scenes:list`/`:list:get`, §14.3.5). Deux simplifications connues documentées (topic `device_automation` à un segment, `SceneExecutionResult` sans distinction failed/cancelled). Correction du socle (auto-abonnement aux commandes, `techniques-socle-ha-mqtt_specs_v4.11.md`) sans lequel aucune commande HA→app RFXCOM n'était jamais reçue. |
| 5.8 | 2026-07-27 | Claude | **Remplacement complet de la gestion des protocoles (§8.2)** : l'ancien filtre logiciel après décodage (v5.4, granularité Lighting1/2/4/5/6/Blinds1/RFXSensor/RFXMeter, événements `rfxcom:protocol:toggle`/`rfxcom:protocols:update`) est retiré (demande utilisateur) et remplacé par un filtre matériel unique — sélection persistée jamais écrasée par le matériel, poussée en RAM uniquement (jamais EEPROM) en un seul lot via un bouton dédié plutôt qu'à chaque coche, plus un bouton de rafraîchissement du statut sans reconnexion. Limitation documentée : plus aucun filtrage possible pour RFXMeter (aucun bit matériel correspondant). Documente aussi l'onglet Protocoles (absent jusqu'ici de la liste des onglets, §12.2), la taxonomie en 5 champs séparés avec sauvegarde individuelle pour Devices et Récepteurs, l'extension du pattern fenêtre modale aux trois formulaires (Devices/Récepteurs/Scènes), et les libellés lisibles (dérivés de la taxonomie) dans les listes déroulantes d'émetteurs. |

---

*Conforme à [spec-nommage-v1.0.md](spec-nommage-v1.0.md) et [specs-techniques-socle-ha-mqtt.md](specs-techniques-socle-ha-mqtt.md)*


---

## 9. Communication Inter-Applications

> **⚠️ IMPORTANT :** Cette section documente les événements et capacités que cette application **expose** aux autres applications.
> 
> **Pour utiliser ces capacités :**
> - Import depuis le core : `import { InterAppClient } from '../../../core/src/exports'`
> - Utiliser `interAppClient.request()` pour les Request/Reply
> - Utiliser `interAppClient.on()` pour écouter les événements Fire & Forget
> - Voir [inter-app-communication_specs_v1.0.md](../inter-app-communication_specs_v1.0.md) pour les détails

### 9.1 Événements Fire & Forget (Écoute possible par d'autres applications)

| Événement | Description | Payload Type | Fréquence | Émetteur |
|-----------|-------------|--------------|-----------|----------|
| `rfxcom:device:detected` | Nouveau device RFXCOM détecté automatiquement | `RfxcomDeviceDetectedPayload` | Selon détection | rfxcom |
| `rfxcom:device:removed` | Device RFXCOM supprimé | `RfxcomDeviceRemovedPayload` | Sur action utilisateur | rfxcom |
| `rfxcom:device:state:updated` | État d'un device RFXCOM mis à jour | `RfxcomDeviceStatePayload` | Fréquente | rfxcom |
| `rfxcom:message:received` | Message RF433/868 reçu et décodé | `RfxcomRawMessagePayload` | Selon activité RF | rfxcom |
| `rfxcom:scan:started` | Scan de devices démarré | `RfxcomScanPayload` | Sur demande | rfxcom |
| `rfxcom:scan:completed` | Scan de devices terminé | `RfxcomScanCompletedPayload` | À la fin du scan | rfxcom |
| `rfxcom:scan:device:found` | Device trouvé pendant le scan | `RfxcomDeviceFoundPayload` | Pendant le scan | rfxcom |

**Types des payloads :**
```typescript
// RfxcomDeviceDetectedPayload
export interface RfxcomDeviceDetectedPayload {
  deviceId: string;
  sensorId: string;
  subType: string;
  protocol: string;
  name: string;
  quoi: string;
  ou: string;
  timestamp: string;
}

// RfxcomDeviceRemovedPayload
export interface RfxcomDeviceRemovedPayload {
  deviceId: string;
  sensorId: string;
  timestamp: string;
}

// RfxcomDeviceStatePayload
export interface RfxcomDeviceStatePayload {
  deviceId: string;
  sensorId: string;
  state: Record<string, unknown>;
  timestamp: string;
}

// RfxcomRawMessagePayload
export interface RfxcomRawMessagePayload {
  rawMessage: string;
  protocol: string;
  subType: string;
  sensorId: string;
  rssi: number;
  timestamp: string;
}

// RfxcomScanPayload
export interface RfxcomScanPayload {
  scanId: string;
  protocols: string[];
  timestamp: string;
}

// RfxcomScanCompletedPayload
export interface RfxcomScanCompletedPayload {
  scanId: string;
  devicesFound: number;
  timestamp: string;
}

// RfxcomDeviceFoundPayload
export interface RfxcomDeviceFoundPayload {
  scanId: string;
  device: RfxcomDeviceDetectedPayload;
  timestamp: string;
}
```

**Exemple d'écoute depuis une autre application :**
```typescript
import { InterAppClient } from '../../../core/src/exports';

this.interAppClient.on('rfxcom:device:detected', (payload, fromApp) => {
  // payload est de type RfxcomDeviceDetectedPayload
  console.log(`Nouveau device détecté par ${fromApp}:`, payload);
});

this.interAppClient.on('rfxcom:message:received', (payload, fromApp) => {
  // payload est de type RfxcomRawMessagePayload
  console.log(`Message RF reçu de ${fromApp}:`, payload);
});
```

### 9.2 Capacités Request/Reply (Appel possible depuis d'autres applications)

| Capacité | Description | Request Type | Reply Type | Timeout conseillé |
|----------|-------------|--------------|------------|-------------------|
| `rfxcom:devices:list` | Lister tous les devices RFXCOM configurés | `RfxcomListDevicesRequest` | `RfxcomListDevicesReply` | 2000ms |
| `rfxcom:device:get` | Obtenir les détails d'un device spécifique | `RfxcomGetDeviceRequest` | `RfxcomGetDeviceReply` | 1000ms |
| `rfxcom:device:scan` | Lancer un scan de nouveaux devices | `RfxcomScanRequest` | `RfxcomScanReply` | 30000ms |
| `rfxcom:device:send` | Envoyer une commande RF via un device | `RfxcomSendCommandRequest` | `RfxcomSendCommandReply` | 5000ms |
| `rfxcom:pairing:create` | Créer un appairage entre émetteur et récepteur | `RfxcomCreatePairingRequest` | `RfxcomCreatePairingReply` | 2000ms |
| `rfxcom:pairing:delete` | Supprimer un appairage | `RfxcomDeletePairingRequest` | `RfxcomDeletePairingReply` | 2000ms |

**Types :**
```typescript
// Request/Reply pour devices:list
interface RfxcomListDevicesRequest {
  includeDisabled?: boolean;
  filterByProtocol?: string;
}

interface RfxcomListDevicesReply {
  devices: RfxcomDeviceDetectedPayload[];
  total: number;
}

// Request/Reply pour device:get
interface RfxcomGetDeviceRequest {
  deviceId: string;
}

interface RfxcomGetDeviceReply {
  device: RfxcomDeviceDetectedPayload & {
    configuration: Record<string, unknown>;
    pairedEmitters: string[];
    primaryEmitter?: string;
  };
}

// Request/Reply pour device:scan
interface RfxcomScanRequest {
  protocols?: string[];
  duration?: number; // en secondes
}

interface RfxcomScanReply {
  scanId: string;
  status: 'started' | 'completed' | 'cancelled';
  devicesFound: RfxcomDeviceDetectedPayload[];
}

// Request/Reply pour device:send
interface RfxcomSendCommandRequest {
  deviceId: string;
  command: string;
  payload?: Record<string, unknown>;
}

interface RfxcomSendCommandReply {
  success: boolean;
  sentAt: string;
  ackReceived?: boolean;
  error?: string;
}

// Request/Reply pour pairing:create
interface RfxcomCreatePairingRequest {
  receiverId: string;
  emitterId: string;
  makePrimary?: boolean;
}

interface RfxcomCreatePairingReply {
  success: boolean;
  pairingId: string;
  receiverId: string;
  emitterId: string;
}

// Request/Reply pour pairing:delete
interface RfxcomDeletePairingRequest {
  pairingId: string;
}

interface RfxcomDeletePairingReply {
  success: boolean;
  pairingId: string;
}
```

**Exemple d'appel depuis une autre application :**
```typescript
import { InterAppClient } from '../../../core/src/exports';
import type {
  RfxcomListDevicesRequest,
  RfxcomListDevicesReply,
  RfxcomSendCommandRequest,
  RfxcomSendCommandReply
} from '../rfxcom/specs';

// Lister tous les devices
const listReply = await interAppClient.request<
  RfxcomListDevicesRequest,
  RfxcomListDevicesReply
>(
  'rfxcom:devices:list',
  { includeDisabled: true },
  2000
);

if (listReply.status === 'success') {
  console.log('Devices trouvés:', listReply.result.devices);
}

// Envoyer une commande
const sendReply = await interAppClient.request<
  RfxcomSendCommandRequest,
  RfxcomSendCommandReply
>(
  'rfxcom:device:send',
  { deviceId: 'lighting2_0x02b3', command: 'ON' },
  5000
);

if (sendReply.status === 'success') {
  console.log('Commande envoyée:', sendReply.result);
}
```

**Handler côté récepteur (dans l'application RFXCOM) :**
```typescript
import { InterAppClient } from '../../../core/src/exports';

// Exemple: handler pour rfxcom:devices:list
this.interAppClient.onRequest('rfxcom:devices:list', async (request, reply) => {
  try {
    const devices = await getAllDevices(request.payload);
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'rfxcom',
      status: 'success',
      result: { devices, total: devices.length },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'rfxcom',
      status: 'error',
      error: {
        code: 'RFXCOM_LIST_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Exemple: handler pour rfxcom:device:send
this.interAppClient.onRequest('rfxcom:device:send', async (request, reply) => {
  try {
    const result = await sendRfCommand(request.payload);
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'rfxcom',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'rfxcom',
      status: 'error',
      error: {
        code: 'RFXCOM_SEND_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});
```

