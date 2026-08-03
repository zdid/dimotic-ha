# Spécifications Fonctionnelles - Module RFXCOM

*Version 5.9 - 3 Août 2026*
*Rattrapage complet du décrochage code/specs constaté début août 2026 : détection automatique du
port série (absente jusqu'ici), ordonnancement réel du push de protocoles au démarrage (verrou de
gate + timeout de sécurité), reconnexion à chaud sur changement de config, retrait de la découverte
MQTT à la désélection, topic dédié `attributs_taxonomie` (remplace l'ancienne intégration dans le
payload de découverte/état, jamais fonctionnelle côté HA), format réel du `uniqueId`
(`protocole_subType_sensorId[_unitCode]`, pas `protocole_sensorId`), absence de slash initial sur
les topics, état "inconnu" non publié au démarrage, arborescence réelle des programmes, et
correction de la numérotation des sections (dérivée depuis 5.7).*

> **v5.9** : **Rattrapage de dérive code/specs** (session du 03/08/2026, aucun changement de
> comportement — uniquement mise en conformité de la documentation avec le code réellement en
> production, dont une partie a évolué sur plusieurs semaines sans mise à jour de ce document).
> Points corrigés en détail dans les sections concernées, résumé rapide :
> - **§8.2 Détection automatique du port série** (nouveau, absent jusqu'ici) — `PortDetector`.
> - **§8.3 Gestion des protocoles matériel** : ajout du mécanisme de verrouillage (`protocolsPushGate`)
>   qui retarde la première publication de découverte tant que le push de protocoles n'a pas abouti
>   (ou échoué), avec un filet de sécurité de 20s ; verrou anti-boucle réinitialisé sur reconnexion à
>   chaud ; normalisation "tout coché = liste persistée vide".
> - **§8.5 Reconnexion à chaud** (nouveau) sur changement de port/vitesse depuis les Paramètres Techniques.
> - **§9 État au démarrage** : plus aucun état `"unknown"` fictif publié — un device sans valeur
>   fraîche (< 30 min) au démarrage est simplement omis de la publication initiale.
> - **§2.2, §4, §5, exemples throughout** : format réel du `uniqueId`
>   (`{protocole}_{subType}_{sensorId}[_{unitCode}]`, ex. `lighting2_ac_0x02be2c02_13`), pas
>   `{protocole}_{sensorId}`.
> - **§7.2, §17 Découverte et attributs** : `attributs_taxonomie` n'est **plus** un champ du payload
>   de découverte ni de l'état — c'est un topic MQTT dédié, publié uniquement à la (re)découverte.
>   Retrait MQTT de la découverte documenté (n'existait dans aucune version précédente).
> - **Topics** : correction du slash initial erroné dans tous les exemples (`rfxcom/...`, pas `/rfxcom/...`).
> - **§18 Arborescence** : structure réelle des fichiers (plate, pas de sous-dossiers `base/switch/light/cover`
>   ni `devices/handlers/`, présence de `presentation/rfxcom/` jusqu'ici absente).
> - **§11 Traces** : messages réels, avec le détail de l'ordonnancement démarrage→connexion→push protocoles→découverte.
> - **Numérotation des sections corrigée** (v5.7/v5.8 avaient un décalage ToC/en-têtes ; le bloc
>   "Communication Inter-Applications", jamais implémenté, déplacé en annexe et marqué comme tel).
> - Limitations nouvellement documentées : `autoDiscovery` déclaré mais jamais lu, `lastOn`/`lastLevel`/
>   `lastValue` écrits en YAML mais **strippés au chargement** par le schéma Zod (cause racine de la
>   rafale OFF à chaque redémarrage, voir §9.1 et §20), scan RF433 (`rfxcom:scan:*`) déclaré côté UI
>   sans aucun gestionnaire serveur.

> **v5.8** : Remplacement complet de la gestion des protocoles — filtre logiciel après décodage
> retiré, remplacé par un filtre matériel unique poussé en RAM au RFXtrx433. Voir historique §22.3.

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
9. [État au Démarrage et Gestion des Données QUOI/OÙ](#9-état-au-démarrage-et-gestion-des-données-quoiou)
10. [Fichier de Configuration Centralisé](#10-fichier-de-configuration-centralisé)
11. [Traces et Journalisation](#11-traces-et-journalisation)
12. [Interface Web et Socket.io](#12-interface-web-et-socketio)
13. [Scénarios d'Utilisation](#13-scénarios-dutilisation)
14. [Gestion des États](#14-gestion-des-états)
15. [Commandes](#15-commandes)
16. [Traduction Commandes HA → RFXCOM](#16-traduction-commandes-ha--rfxcom)
17. [Découverte et Retrait MQTT](#17-découverte-et-retrait-mqtt)
18. [Arborescence des Programmes](#18-arborescence-des-programmes)
19. [Tests](#19-tests)
20. [Limites et Contraintes](#20-limites-et-contraintes)
21. [Roadmap](#21-roadmap)
22. [Annexes](#22-annexes)

---

## 1. Introduction

### 1.1 Objectif
Ce document décrit les spécifications fonctionnelles du module d'intégration **RFXCOM** pour Home Assistant.

### 1.2 Périmètre
- **Inclus** : Réception messages RF433, classification HA, publication MQTT, exécution commandes, gestion récepteurs/émetteurs/scènes
- **Exclus** : Gestion du matériel RFXCOM (pilotes), configuration broker MQTT, implémentation UI générique du socle

### 1.3 Public Cible
- Développeurs intégrant le module RFXCOM
- Mainteneurs du socle HA-MQTT
- Utilisateurs finaux (configuration via UI et fichier YAML)

---

## 2. Référentiel de Nommage et Taxonomie

**⚠️ Ce module respecte strictement [spec-nommage-v1.0.md](spec-nommage-v1.0.md)**

### 2.1 Format du name (Obligatoire)
```
quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
```
- `---` : Séparateur majeur entre QUOI et OÙ
- `--` : Séparateur mineur entre niveaux hiérarchiques

### 2.2 Règle de Nommage Technique (réel, corrigé v5.9)

**Pour TOUS les devices RFXCOM (capteurs et émetteurs), le `uniqueId` réel est construit par**
`DeviceManager.ts::buildUniqueId()` **et n'est PAS** `<protocole>_<sensorId>` **comme documenté
jusqu'à v5.8, mais :**
```
<protocole>_<subType>_<sensorId>[_<unitCode>]
```

| Élément | Description | Exemple |
|---------|-------------|---------|
| protocole | Protocole RFXCOM interne, minuscules | `lighting2`, `rfxsensor`, `rfxmeter` |
| subType | Sous-type du message, minuscules | `ac`, `temperature`, `th9` |
| sensorId | Identifiant unique du device, minuscules | `0x02be2c02`, `0xa5b3` |
| unitCode | Code d'unité, uniquement si présent dans le message (télécommandes multi-boutons) | `13` |
| **Nom complet** | - | `lighting2_ac_0x02be2c02_13`, `rfxsensor_temperature_0xa5b3` |

**Pourquoi le `subType` et le `unitCode` sont nécessaires** (et pas seulement le `sensorId`) :
- un capteur `TH9` envoie **Temperature et Humidity avec le même `sensorId`** — sans le `subType`
  dans l'identifiant, les deux mesures s'écraseraient l'une l'autre ;
- une télécommande multi-boutons envoie plusieurs `unitCode` différents sous le même `sensorId` —
  sans le `unitCode` en suffixe, tous les boutons seraient confondus en un seul device.

**Pour les récepteurs logiques :**
```
recepteur_<timestamp>
```
Identifiant généré à la création (pas une séquence `001`, `002`, ... comme documenté jusqu'à v5.8) —
exemple réel observé en production : `recepteur_1000890`.

> ✅ **Garantie d'unicité** : la combinaison protocole+subType+sensorId(+unitCode) assure l'unicité
> dans tout le système.

### 2.3 QUOI = Type Fonctionnel Pur

**Le QUOI ne désigne PAS un endroit, mais le type fonctionnel du device :**

| SubType RFXCOM | QUOI (auto-déterminé) | Exemple |
|----------------|----------------------|---------|
| Temperature | Température | `Température---Salon` |
| Humidity | Humidité | `Humidité---Cuisine` |
| Motion (heuristique, voir note) | Mouvement | `Mouvement---Couloir` |
| Contact (heuristique, voir note) | Contact | `Contact---Entrée` |
| Current/Elec* | Courant | `Courant---Tableau` |
| Power/Elec* | Puissance | `Puissance---Cuisine` |
| Lighting1 | Interrupteur | `Interrupteur---Salon` |
| Lighting2 | Bouton | `Bouton---Salon` |
| Lighting4 | Télécommande | `Télécommande---Salon` |
| Lighting5, Lighting6 | Interrupteur | `Interrupteur---Salon` |
| Blinds1 | Volet | `Volet---Chambre` |

> ⚠️ **IMPORTANT** : Le QUOI est **prérempli automatiquement** depuis le subType du message RFXCOM
> (`classification.ts::determineQuoi()`). L'utilisateur peut le modifier via le fichier de
> configuration ou l'UI.
>
> ⚠️ **Note technique (Motion/Contact, non documentée avant v5.9)** : la distinction Motion/Contact
> pour `Security1` n'est **pas** un champ structuré fourni par la bibliothèque `rfxcom` — c'est une
> **heuristique** appliquée sur le nom du subtype (`/PIR|MOTION/i`), qualifiée d'"au mieux" dans le
> code (`RfxComTransceiver.ts`). Un capteur de sécurité au nom inhabituel peut donc être mal classé.

### 2.4 OÙ = Localisation Hiérarchique
Représente **l'emplacement** après `---`, séparé par `--` :

| Niveau | Rôle | Exemple | Obligatoire |
|--------|------|---------|-------------|
| `lieu_grand_pere` | Bâtiment | `Maison` | ❌ |
| `lieu_pere` | Étage | `Rez-de-Chaussée` | ❌ |
| `lieu_principal` | Pièce | **`Salon`** | ✅ **OUI** |
| `lieu_precis` | Sous-zone | `Coin Canapé` | ❌ |

Avec un seul segment de lieu, `lieu_precis` **et** `lieu_principal` reçoivent tous deux cette même
valeur (`taxonomy.ts::extractTaxonomy()`) — c'est ce qui justifie la déduplication appliquée dans
les fonctions d'affichage (§5.5).

**Exemples complets :**
- `Température---Salon` (N=1)
- `Température---Coin Canapé--Salon` (N=2)
- `Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée` (N=3)

### 2.5 Règle de Transmission vers HA (CRITIQUE)
**⭐ Les données ne sont PAS transmissibles vers HA si :**
- ❌ La case `transmitToHa` n'est pas cochée pour ce device/récepteur (voir §9.1 — remplace depuis
  v5.4 l'ancienne règle basée sur QUOI/OÙ)

### 2.6 Attributs de Taxonomie — topic MQTT dédié (⭐ corrigé v5.9)

> ⚠️ **Cette section documentait jusqu'à v5.8 un mécanisme jamais fonctionnel** : `attributs_taxonomie`
> comme champ `extra` du payload de découverte, ou comme clé de l'objet `attributes` du payload
> d'état. Dans les deux cas, HA **ignore silencieusement** ces clés (elles ne font pas partie de son
> schéma MQTT discovery ni de son enveloppe d'état). Le mécanisme réellement en production depuis
> fin juillet 2026 est un **topic MQTT dédié**, publié **uniquement à la (re)découverte**, jamais à
> chaque changement d'état :

```
homeassistant/{component}/{objectId}/attributs
```

Référencé dans le payload de découverte via les clés standard HA `json_attributes_topic` +
`json_attributes_template: '{{ value_json | tojson }}'`. Payload publié sur ce topic :
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

Voir §17 pour le détail complet du mécanisme (côté socle) et §7.2 pour son intégration dans le
payload de découverte RFXCOM.

---

## 3. Architecture

### 3.1 Schéma Global (5 Couches - Conforme à techniques-socle-ha-mqtt_specs)
```
┌─────────────────────────────────────────────────────────────────┐
│                    COUCHE PRÉSENTATION                    │
│              (UI Web générique + page dédiée RFXCOM)       │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE APPLICATION                     │
│   AppService · EventBus · SocketBridge                    │
├─────────────────────────────────────────────────────────────────┤
│                     COUCHE MÉTIER                         │
│   RfxComService · DeviceManager · ReceiverManager          │
│   ReceiverSwitch/Light/Cover · SceneManager · SceneExecutor │
├─────────────────────────────────────────────────────────────────┤
│                       COUCHE HA                           │
│   HaMqttIntegrationService · IntegrationBridge · EventBus       │
├─────────────────────────────────────────────────────────────────┤
│                  COUCHE INFRASTRUCTURE                    │
│   ConfigService · Logger · MqttTransport · RfxComTransceiver    │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Flux de Données
```
RFXCOM Transceiver (Port Série, détecté automatiquement — voir §8.2)
    |
    v (Message RF433, décodé par la bibliothèque rfxcom, un event par protocole)
RfxComTransceiver → RfxComService.handleRfxMessage()
    |
    v (Auto-détermination QUOI depuis subType — classification.ts)
    |
    v (Mise à jour dans config-rfxcom-devices-v1.0.yaml)
    v (Si nouvel émetteur, ajout à rfxcom_devices)
    |
    v (Si transmitToHa=true, publication Discovery + état MQTT)
Home Assistant
```

---

## 4. Types de Devices et Entités Supportés

> ⚠️ Les `unique_id`/`entity_id` d'exemple ci-dessous suivent le format réel §2.2
> (`{protocole}_{subType}_{sensorId}`), pas l'ancien format `{protocole}_{sensorId}`.

### 4.1 RFXSensor - Capteurs (0x50-0x5F)
**QUOI auto-déterminé depuis subType**

| SubType | QUOI | Composant HA | Device Class | Unité | Exemple unique_id |
|---------|------|---------------|--------------|-------|-------------------|
| Temperature | Température | sensor | temperature | °C | `rfxsensor_temperature_0xa5b3` |
| Humidity | Humidité | sensor | humidity | % | `rfxsensor_humidity_0xc4d2` |
| Motion | Mouvement | binary_sensor | motion | - | `rfxsensor_motion_0xe7f1` |
| Contact | Contact | binary_sensor | door | - | `rfxsensor_contact_0x98a4` |

> Note : un capteur `TemperatureHumidity1` (ex: TH9) génère **deux** messages normalisés distincts
> (Temperature et Humidity) à partir d'un seul paquet RF433 reçu — voir §6.

### 4.2 RFXMeter/Elec - Compteurs
**QUOI auto-déterminé depuis subType**

| SubType | QUOI | Composant HA | Device Class | Unité | Exemple unique_id |
|---------|------|---------------|--------------|-------|-------------------|
| Current | Courant | sensor | current | A | `rfxmeter_current_0xb2c3` |
| Power | Puissance | sensor | power | W | `rfxmeter_power_0xd4e5` |

### 4.3 Lighting - Émetteurs Physiques (0x10-0x1F)
**TOUS les Lighting sont des ÉMETTEURS PHYSIQUES**
**Par défaut : composant HA = binary_sensor (on/off), `entity_category: diagnostic`**

| Type | QUOI | Composant HA | Commandes | Exemple unique_id |
|------|------|---------------|-----------|-------------------|
| Lighting1 | Interrupteur | binary_sensor | on, off | `lighting1_x10_0x01a2` |
| Lighting2 | Bouton | binary_sensor | on, off | `lighting2_ac_0x02b3` |
| Lighting4 | Télécommande | binary_sensor | on, off | `lighting4_pt2262_0x1001` |
| Lighting5, Lighting6 | Interrupteur | binary_sensor | on, off | — |

> ⚠️ **CLARIFICATION IMPORTANTE** :
> - **Lighting2 sont TOUJOURS des binary_sensor dans HA** (ils émettent uniquement on/off)
> - **Le récepteur associé** peut être configuré comme `light` avec `isDimmable: true` (variateur)
> - Dans ce cas, la commande **sera traduite en setlevel** avant d'être envoyée par le lighting2
> - L'information "variateur" **ne vient pas du device Lighting2 lui-même**, mais de la configuration du récepteur
> - **Seuls 3 protocoles peuvent réellement transmettre** des commandes (voir `implementation-rfxcom_specs`
>   §7) : Lighting1, Lighting2, Blinds1. Lighting4/5/6 ne sont émetteurs-récepteurs qu'en réception.

### 4.4 Blinds1 - Volets (0x19)

| Type | QUOI | Composant HA (récepteur) | Commandes |
|------|------|---------------------------|-----------|
| Blinds1 | Volet | cover | open, close, stop |

---

## 5. Gestion des Émetteurs et Récepteurs

### 5.1 Définitions Clés

| Terme | Définition | Type HA | Nom Technique |
|-------|------------|---------|---------------|
| **Device RFXCOM** | Appareil physique RFXCOM | variable | `<protocole>_<subType>_<sensorId>[_<unitCode>]` |
| **Émetteur** | Device Lighting1/2/4/5/6 qui émet des signaux RF433 | **binary_sensor** (par défaut) | idem |
| **Récepteur** | Entité logique déclarée, associée à des émetteurs | switch, light, cover, scene | `recepteur_<timestamp>` |
| **primaryEmitter** | Émetteur principal d'un récepteur, utilisé pour envoyer les commandes RF433 | - | - |
| **Appairage** | Lien entre émetteur et récepteur (**N↔N**) stocké dans le récepteur | - | - |

### 5.2 Règles Fondamentales

1. **Tous les devices RFXCOM ont un nom technique** : `<protocole>_<subType>_<sensorId>[_<unitCode>]`
2. **QUOI = type fonctionnel pur** (ex: "Température", "Humidité", "Courant"), pas un endroit
3. **QUOI auto-déterminé** depuis le subType du message RFXCOM
4. **Émetteurs Lighting = binary_sensor par défaut** (ils émettent on/off)
5. **Appairages stockées dans le fichier YAML** : chaque récepteur contient sa liste d'émetteurs appairés
6. **primaryEmitter obligatoire** : détermine quel device RFXCOM envoie les commandes
7. **Relations N↔N** : un récepteur peut avoir plusieurs émetteurs, un émetteur peut agir sur plusieurs récepteurs
8. **Lighting2 variateur** : l'information "variateur" vient **exclusivement** de `isDimmable` sur le récepteur

### 5.3 Flux Émetteur → Récepteur — asymétrie primaryEmitter/emitters (⚠️ précision v5.9)

```
1. Bouton physique (Lighting2 0x02B3) envoie: "ON"
2. RfxComService reçoit message RF433
3. Service identifie 0x02B3 comme émetteur (lighting2_ac_0x02b3)
4. ReceiverManager.findReceiversForEmitter() cherche 0x02b3 dans emitters[] de chaque récepteur
5. Pour chaque récepteur trouvé:
   a. Module approprié exécute l'action configurée (toggle, on, off, set_level, etc.)
   b. Module met à jour état du récepteur dans HA et persiste lastOn/lastLevel
```

> ⚠️ **`findReceiversForEmitter` ne recherche QUE dans `emitters[]`, jamais dans `primaryEmitter`
> lui-même.** Contre-intuitivement, un récepteur n'écoute donc pas automatiquement en écho son
> propre `primaryEmitter` — un émetteur qui n'agit QUE comme primaryEmitter (jamais listé aussi
> dans `emitters[]`) ne redéclenchera jamais son récepteur par ce chemin. C'est pourquoi le chemin
> HA→récepteur (§5.4) doit mettre à jour l'état/`lastOn` **explicitement**, sans compter sur un echo
> RF433 : sans cet appel explicite, une commande envoyée depuis HA ne fait jamais bouger l'état
> interne (vérifié en conditions réelles, 30/07/2026).

### 5.4 Flux HA → Récepteur → Device RFXCOM
```
1. HA publie: homeassistant/light/recepteur_001/set (ou via topic command du socle)
   Payload: {"state": "ON", "brightness": 128}
2. IntegrationBridge reçoit via MQTT
3. RfxComService trouve recepteur_001 dans config-rfxcom-devices-v1.0.yaml
4. Récupère primaryEmitter et le device RFXCOM associé
5. ReceiverLight convertit brightness → level (échelle native RFXCOM 0-15, voir implementation-rfxcom_specs §6)
6. Envoi du signal RF433 au device cible
7. Mise à jour explicite de l'état interne + lastOn/lastLevel (voir §5.3 — pas d'écho automatique)
```

### 5.5 Libellés dérivés de la taxonomie (`buildDisplayName`/`buildBoutonDisplayName`)

Fonctions de `taxonomy.ts`, utilisées pour le `device.name` publié en découverte MQTT et pour les
libellés des listes déroulantes d'émetteurs dans l'UI (§12) :

- **`buildDisplayName(t)`** : `nomPrecis` s'il est défini et différent de `nomLieu`, sinon `rawQuoi`
  — capitalisé. Utilisé pour tous les récepteurs (switch/light/cover) et les scènes.
- **`buildBoutonDisplayName(t)`** : `rawQuoi` + `nomPrecis` (si défini) + `nomLieu` (si défini et
  différent de `nomPrecis`), chaque partie capitalisée et jointe par un espace. Utilisé pour les
  émetteurs Lighting bruts (boutons) — un bouton garde QUOI+lieu pour rester distinguable du
  récepteur qu'il pilote, contrairement au récepteur qui n'a besoin que d'un nom court (le
  `suggested_area` porte déjà le lieu côté HA).
- Seule la **première lettre** de chaque segment est mise en majuscule, le reste est inchangé.

---

## 6. Format des Messages RFXCOM

### 6.1 Structure Commune
```typescript
interface RfxComRawMessage {
  type: RfxComDeviceType;      // "RFXSensor", "RFXMeter", "Lighting1", "Lighting2", "Lighting4", "Lighting5", "Lighting6", "Blinds1"
  subType: RfxComSubType;      // "Temperature", "Humidity", "AC", etc.
  sensorId: string;            // "0x123456"
  seqNbr: number;               // 0-255
  signalLevel: number;          // dBm (-128 à 127)
  batteryLevel: number;         // 0-9
  data: Record<string, unknown>;
  rawData: Buffer;
}
```

> ⚠️ **La bibliothèque `rfxcom` n'émet pas un événement générique `'device'`** — chaque protocole
> émet son propre événement nommé (`'lighting1'`, `'lighting2'`, `'blinds1'`,
> `'temperaturehumidity1'`, ...), normalisé ensuite vers la structure ci-dessus par
> `RfxComTransceiver.ts`. Détail complet dans `implementation-rfxcom_specs`.

### 6.2 Auto-détermination du QUOI
```typescript
const SUBTYPE_TO_QUOI: Record<string, string> = {
  'Temperature': 'Température',
  'Humidity': 'Humidité',
  'Motion': 'Mouvement',
  'Contact': 'Contact',
  'Current': 'Courant',
  'Power': 'Puissance',
};
const TYPE_TO_QUOI: Record<string, string> = {
  'Lighting1': 'Interrupteur',
  'Lighting2': 'Bouton',
  'Lighting4': 'Télécommande',
  'Lighting5': 'Interrupteur',
  'Lighting6': 'Interrupteur',
  'Blinds1': 'Volet',
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
| RFXMeter/Elec | Current | sensor | current | Courant |
| RFXMeter/Elec | Power | sensor | power | Puissance |
| Lighting1/2/4/5/6 | - | **binary_sensor** | - | Interrupteur/Bouton/Télécommande |
| Blinds1 (récepteur) | - | cover | - | Volet |

### 7.2 Discovery MQTT pour Device RFXCOM (corrigé v5.9)

**Template réel (capteur), bridge `{{ bridgeInstance }}` — attention aux 4 corrections vs
versions antérieures : pas de slash initial sur le topic, `value_template` (pas
`attributs_taxonomie` en clair dans ce payload), `json_attributes_topic` séparé, `entity_category`
conditionnel :**
```json
{
  "name": "{{ taxonomy.raw_quoi }}",
  "unique_id": "{{ protocole }}_{{ subType }}_{{ sensorId }}",
  "~": "homeassistant/sensor/{{ protocole }}_{{ subType }}_{{ sensorId }}",
  "state_topic": "rfxcom/{{ bridgeInstance }}/{{ deviceId }}/state",
  "value_template": "{{ '{{ value_json.state }}' }}",
  "json_attributes_topic": "homeassistant/sensor/{{ protocole }}_{{ subType }}_{{ sensorId }}/attributs",
  "json_attributes_template": "{{ '{{ value_json | tojson }}' }}",
  "device": {
    "identifiers": ["{{ protocole }}_{{ subType }}_{{ sensorId }}"],
    "name": "RFXCOM {{ type }} {{ subType }}",
    "manufacturer": "RFXCOM",
    "model": "{{ protocole | uppercase }}",
    "suggested_area": "{{ taxonomy.nom_lieu }}"
  }
}
```

> **⚠️ Cas particulier des lights** : le composant `light` (`schema: 'basic'` implicite via
> discovery) attend la clé `state_value_template`, **pas** `value_template` — vérifié contre une
> instance HA réelle. Les switch/cover/sensor utilisent `value_template`. Le payload d'état publié
> ne contient **que** `{"state": "ON"}` (+ `signal_level`/`battery_level` en attributs classiques
> HA quand disponibles) — plus aucune clé `attributs_taxonomie` ni `evoo7_id`/`sensor_id` internes
> (ces derniers sont déjà connus de HA via `unique_id`).
>
> **Attributs de taxonomie** : voir §2.6 et §17 pour le topic dédié `.../attributs`, publié
> uniquement au moment de la découverte.
>
> **`entity_category`** : `"diagnostic"` pour les émetteurs Lighting bruts (boutons, capteurs en
> lecture seule) — jamais `"config"` sur une entité en lecture seule (HA rejette silencieusement
> l'entité dans ce cas, elle n'apparaît jamais).

---

## 8. Configuration

### 8.1 Fichier config.yaml (réel — corrigé v5.9)

> ⚠️ Les exemples de versions antérieures (`transmission.requireQuoi/requireLieu`,
> `autoDetermineQuoi`, `mqttActions.enabled/useSocleBridge`) sont **fictifs** — ces clés n'existent
> pas dans `config-schema.ts`. Voici les **7 champs réels**, tous dans `data/rfxcom/config.yaml`,
> section nue (pas de clé `rfxcom:` d'enveloppe) :

```yaml
enabled: true                                     # défaut true
port: "/dev/ttyUSB0"                               # défaut, écrasé par la détection auto — voir §8.2
baudRate: 38400
bridgeInstance: "rfx_bridge_0001"
devicesConfigFile: "config-rfxcom-devices-v1.0.yaml"
autoDiscovery: false                               # ⚠️ déclaré mais jamais lu par le code, voir §20
enabledHardwareProtocols:                          # vide = tous les protocoles gérables poussés
  - RUBICSON
  - LIGHTWAVERF
  - ARC
  - AC
  - OREGON
  - ATI
  - LACROSSE
```

Les paramètres `ha`/`mqtt`/`web` (socle) vivent séparément dans `data/core/config.yaml` — voir
`techniques-socle-ha-mqtt_specs`.

### 8.2 Détection Automatique du Port Série (nouveau v5.9)

> Absente de toute version précédente de ce document, alors qu'implémentée depuis plusieurs
> semaines. Le champ `port` de la configuration n'est qu'un **fallback** — la détection automatique
> est toujours tentée en premier, **à chaque tentative de connexion** (démarrage ET reconnexion à
> chaud, §8.5), jamais mise en cache.

**Mécanisme** (`PortDetector.ts`) :
1. Scan du répertoire `/dev/serial/by-id/` (stable, ne dépend pas de l'ordre d'énumération USB).
2. Recherche du **premier** lien symbolique dont le nom contient (insensible à la casse) `rfxcom`
   ou `rfxtrx`.
3. Résolution du lien vers le chemin réel (`/dev/ttyUSBx`) — c'est ce chemin résolu qui est utilisé,
   jamais le lien symbolique lui-même (contrainte du mapping de périphériques Docker).
4. Si le répertoire n'existe pas, ou aucune entrée ne correspond, ou le lien est irrésolvable :
   avertissement journalisé, retour au `port` configuré dans `config.yaml`.

> ⚠️ **Limitation connue** : en présence de **plusieurs** dongles RFXCOM branchés, le premier match
> trouvé par l'énumération du répertoire est utilisé sans autre critère de priorité — pas de
> garantie sur lequel des deux est sélectionné.

Exemple vérifié sur l'installation de référence :
`/dev/serial/by-id/usb-RFXCOM_RFXtrx433_A1RST9E-if00-port0 → /dev/ttyUSB0`.

### 8.3 Gestion des Protocoles Matériel (§ ex-8.2, corrigée v5.9 — verrou d'ordonnancement)

> **Principe inchangé depuis v5.8** : seul persiste un filtre **matériel** — notre sélection
> persistée (`enabledHardwareProtocols`) reste la seule source de vérité, jamais écrasée par ce que
> rapporte le matériel, poussée en RAM uniquement (jamais EEPROM) à chaque connexion.
>
> ⚠️ **Limitation connue et acceptée** : `RFXMeter`/Elec n'a **aucun bit correspondant** dans la
> table de protocoles matériel du RFXtrx433 — aucun filtrage possible pour cette catégorie, ni
> matériel ni logiciel.

**⭐ Nouveau v5.9 — ordonnancement garanti démarrage → push protocoles → découverte initiale.**
Un défaut découvert en conditions réelles début août 2026 : sans garde explicite, la rafale de
commandes OFF envoyée aux récepteurs au démarrage (§9.1) pouvait partir **avant** que la sélection
de protocoles ait été effectivement poussée au matériel, provoquant des échecs de transmission
(« Échec du push des protocoles » alors que la rafale OFF avait déjà commencé). Corrigé par un
verrou (`protocolsPushGate`, une `Promise` créée au tout début de `start()`, avant tout
enregistrement d'écouteur) :
- La première publication de découverte (`publishInitialDiscoveries()`, qui déclenche la rafale
  OFF des récepteurs) attend la résolution de ce verrou.
- Le verrou se résout dès que le push de protocoles a été **tenté** (succès ou échec — jamais
  bloquant indéfiniment).
- **Filet de sécurité : 20 secondes.** Si le statut matériel n'arrive jamais (ou trop tard), le
  verrou se résout de lui-même après ce délai. Valeur mesurée empiriquement : la séquence réelle
  connexion+réception du statut matériel prend ~6 à 6,5s sur l'installation de référence — un
  ancien filet de 6s perdait régulièrement la course contre la séquence réelle, d'où le passage à
  20s.
- En cas d'échec de connexion au transceiver, le verrou se résout aussi immédiatement (rien à
  pousser, pas de raison de bloquer la découverte).

**Verrou anti-boucle** (empêche de repousser en boucle — le push lui-même redéclenche un événement
`status` en retour) : **réinitialisé sur reconnexion à chaud** (§8.5), pour que le nouveau matériel
(ou la nouvelle connexion) reçoive bien le push une fois.

**Normalisation "tout coché" (non documentée avant v5.9)** : si la sélection cochée dans l'UI
couvre l'intégralité du catalogue matériel rapporté, elle est persistée comme une **liste vide**
(`[]`) plutôt que la liste complète explicite — cohérent avec la règle "liste vide = tous les
protocoles gérables par défaut" (§8.1).

**Interface (onglet Protocoles, voir §12) :** inchangée depuis v5.8.
```
Statut matériel du RFXtrx433
  Récepteur : 433.92MHz transceiver
  Firmware : Ext v1006
  [🔄 Rafraîchir]

Protocoles matériel (poussés au RFXtrx433)
  [ ] BLYSS
  [x] RUBICSON
  [x] AC
  ...
  [Envoyer au RFXtrx433]
```

**Flux :**
1. À la connexion, le service reçoit le statut matériel (type de récepteur, firmware, protocoles
   actifs rapportés, catalogue complet).
2. Le service pousse **automatiquement**, une seule fois par session (verrou anti-boucle), la
   sélection persistée au matériel — **la découverte initiale attend la fin de cette étape**
   (voir ci-dessus).
3. Le client reçoit `rfxcom:protocols:list` avec le statut matériel et le catalogue+sélection.
4. Cocher/décocher une case (`rfxcom:hardware-protocol:toggle`) **persiste immédiatement** mais
   **n'envoie rien au matériel**.
5. Le bouton **"Envoyer au RFXtrx433"** (`rfxcom:hardware-protocols:push`) pousse toute la
   sélection persistée en une fois.
6. Le bouton **"Rafraîchir"** (`rfxcom:hardware-status:refresh`) redemande le statut sans
   reconnexion complète.

> ⚠️ **Échec de push silencieux pour l'utilisateur** : une erreur lors du push (bouton dédié ou
> rafraîchissement) n'est actuellement pas remontée à l'UI — celle-ci affiche un succès
> inconditionnel. Seuls les logs serveur portent l'erreur réelle.

### 8.4 Actions MQTT par le Socle

**Principe fondamental (inchangé depuis v5.4) :**
> - L'application RFXCOM n'interagit **pas** directement avec MQTT.
> - Toutes les actions MQTT sont gérées par le socle HA-MQTT via `HaMqttIntegrationService`.
> - RFXCOM utilise **uniquement** les événements EventBus mis à disposition par le socle
>   (`integration:rfxcom:*`).

### 8.5 Reconnexion à Chaud sur Changement de Configuration (nouveau v5.9)

Depuis les Paramètres Techniques, un changement de `port` ou `baudRate` déclenche une reconnexion
**sans redémarrage du service** (`reconnectTransceiverIfConfigChanged()`) :

1. Déclenché par l'événement de sauvegarde générique de configuration (module RFXCOM, sauvegarde réussie).
2. Compare le port **effectivement utilisé** avant/après (détection automatique incluse, pas
   seulement la valeur brute de `config.yaml`) et le `baudRate`. Aucun des deux changé → aucune
   action.
3. Si changement : déconnexion propre du transceiver → réinitialisation du verrou anti-boucle
   protocoles (§8.3) → reconnexion avec les nouveaux paramètres → mise à jour de l'indicateur de
   connexion.
4. Ne touche **pas** `bridgeInstance` (pas de ré-enregistrement du bridge) et ne republie **pas**
   la découverte — seule la connexion série est renouvelée.

> Ce mécanisme remplace un ancien comportement où le module entier était redémarré par `AppService`
> à chaque sauvegarde de configuration — désactivé, RFXCOM gère désormais sa propre reconnexion.

---

## 9. État au Démarrage et Gestion des Données QUOI/OÙ

### 9.1 Règle Fondamentale de Transmission

**Toute transmission vers HA est conditionnée par `transmitToHa: boolean`** dans chaque
device/récepteur (case à cocher dans les fenêtres modales, §12) — **pas** par la complétude de
QUOI/OÙ (règle en vigueur jusqu'à v5.3 seulement).

Dès le démarrage, tous les devices/récepteurs avec `transmitToHa: true` sont publiés — sous réserve
du verrou d'ordonnancement décrit en §8.3.

### 9.2 Aucun état "inconnu" fictif publié (⭐ nouveau v5.9)

**Avant ce correctif**, un device sans valeur connue au démarrage (jamais reçu de message RF433
depuis le dernier redémarrage) recevait tout de même un état publié, avec la valeur littérale
`"unknown"` — une entité HA affichant "Inconnu" en permanence tant qu'aucun message réel n'était
reçu, y compris pour des capteurs qui n'émettent que rarement.

**Comportement actuel** : un device n'est publié au démarrage que si une valeur **fraîche** est
disponible — `lastSeen` de moins de **30 minutes** (`LAST_VALUE_MAX_AGE_MS`). Sinon, l'état est
simplement **omis** de la publication initiale ; HA affichera l'entité comme "Indisponible" (état
MQTT natif, pas une valeur fictive) jusqu'à la première réception réelle.

> ⚠️ **Limitation connue et documentée** (voir aussi §20) : la fenêtre de fraîcheur de 30 minutes
> ne peut en pratique **jamais se déclencher côté device physique (`lastValue`)**, car ce champ
> n'est actuellement jamais relu au redémarrage — voir §20 "Persistance silencieusement perdue au
> redémarrage". Elle reste pleinement fonctionnelle et documentée ici pour la logique elle-même,
> indépendamment de ce défaut de persistance.

### 9.3 Auto-détermination du QUOI
```typescript
function determineQuoi(type: string, subType: string): string {
  return SUBTYPE_TO_QUOI[subType] ?? TYPE_TO_QUOI[type] ?? subType;
}
```

### 9.4 Extraction de la Taxonomie
```typescript
function extractTaxonomy(fullName: string): ExtractedTaxonomy {
  const [rawQuoi, ouPart] = fullName.split('---');
  const lieux = (ouPart ?? '').split('--').map(s => s.trim()).filter(Boolean);
  const nomPrecis = lieux[0] ?? null;
  const nomLieu = lieux.length > 1 ? lieux[1] : lieux[0] ?? null;
  // ... (voir §2.4 pour la déduplication nomPrecis/nomLieu à un seul segment)
}
```

---

## 10. Fichier de Configuration Centralisé

### 10.1 `config-rfxcom-devices-v1.0.yaml`
**Structure complète (identifiants réels, format §2.2) :**

```yaml
rfxcom_devices:
  rfxsensor_temperature_0xa5b3:
    sensorId: "0xA5B3"
    type: "RFXSensor"
    subType: "Temperature"
    name: "Température---Salon"
    protocole: "rfxsensor"
    defaultQuoi: "Température"
    transmitToHa: true

  lighting2_ac_0x02be2c02_13:
    sensorId: "0x02BE2C02"
    unitCode: 13
    type: "Lighting2"
    subType: "AC"
    name: "Bouton---Salon"
    protocole: "lighting2"
    defaultQuoi: "Bouton"
    transmitToHa: false

rfxcom_receivers:
  recepteur_1000890:
    receiverId: "recepteur_1000890"
    name: "Lumière---Salon"
    type: "light"
    isDimmable: true
    primaryEmitter: "lighting2_ac_0x02be2c02_13"
    emitters:
      - emitterId: "lighting2_ac_0x02be2c02_13"
        action: "toggle"
    transmitToHa: true

  scene_1000851:
    receiverId: "scene_1000851"
    type: "scene"
    sceneType: "parallel"
    delayBetweenCommands: 0
    actions: []
```

### 10.2 Règles du Fichier
- **Format** : YAML strict
- **Chargement** : au démarrage du service RFXCOM
- **Sauvegarde** : à chaque modification via UI
- **Validation** : schéma Zod obligatoire (⚠️ voir §20 — le résultat validé n'est utilisé que pour
  la validation à l'écriture, la valeur d'origine non filtrée est réellement écrite sur disque,
  mais **c'est le résultat filtré qui est relu** au chargement suivant, avec pour conséquence la
  perte silencieuse des champs non déclarés au schéma — voir §20 pour le détail complet)

### 10.3 Exemple Complet
Voir fichier `config-rfxcom-devices-v1.0.yaml` sous `data/rfxcom/`.

---

## 11. Traces et Journalisation

### 11.1 Traces côté Serveur (réelles, corrigées v5.9)

Ordre réel au démarrage :
1. `INFO [RfxComService] Démarrage du service RFXCOM...`
2. `INFO [PortDetector] Port RFXCOM détecté via /dev/serial/by-id/... → /dev/ttyUSBx` (ou silence +
   fallback si non détecté)
3. `INFO [RfxComTransceiver] Tentative de connexion au transceiver RFXCOM sur {port}...`
4. `INFO [RfxComTransceiver] Statut matériel reçu : {receiverType}, firmware {firmwareVersion}` (peut
   survenir avant ou après le message suivant — pas d'ordre garanti par la bibliothèque)
5. `INFO [RfxComTransceiver] Transceiver RFXCOM initialisé avec succès sur {port}`
   — ou en cas d'échec : `WARN [RfxComService] Transceiver RFXCOM indisponible au démarrage: {erreur}`
6. `INFO [RfxComService] Protocoles matériel poussés pour la session` (une fois le push §8.3 réglé,
   succès ou échec)
7. `INFO [RfxComService] Service RFXCOM démarré`

> Les commandes envoyées (`turn_on`/`turn_off`/`set_level`/...) sont journalisées via un callback
> d'accusé de réception (`buildAckLogger`) déclenché quand la trame est **écrite sur le port série**
> — ceci **n'est pas** une confirmation de réception RF433 par le device physique. Toute exécution
> de commande reste optimiste (l'état interne est mis à jour immédiatement, sans attendre un écho
> RF433 qui, de toute façon, n'est pas garanti — voir §5.3).

### 11.2 Traces côté Client
- **État de connexion** : `rfxcom:status` `{connected, devicesCount, receiversCount, lastDiscovery}`
- Logs disponibles pour le chargement/sauvegarde de configuration

### 11.3 Recommandations
- Les erreurs de connexion (matériel absent, mauvais paramètres) sont normales au démarrage et ne
  doivent pas bloquer l'application.
- Les warnings de connexion affichent le motif précis pour aider au diagnostic.

---

## 12. Interface Web et Socket.io

### 12.1 Communication
- **Socket.io** est le canal principal de communication entre UI et serveur.
- Le fichier YAML peut aussi être édité manuellement (rechargé automatiquement).

### 12.2 Fonctionnalités UI pour RFXCOM

- **Structure en onglets** : Devices | Récepteurs | Scènes | Protocoles (§8.3)
- **Appairages intégrés aux Récepteurs** (pas d'onglet séparé)
- **Indicateur de connexion RFX433** : badge dans l'en-tête (🟢 Connecté / 🔴 Déconnecté), mis à
  jour dès réception de `rfxcom:status`.
- **Trois formulaires en fenêtre modale** (Devices, Récepteurs, Scènes) — pas de formulaire intégré
  à la page ; pas de bouton "Sauvegarder" global.

**Gestion des Devices :**
1. Liste des devices détectés avec sensorId, type, subType.
2. QUOI auto-rempli depuis le subType, modifiable.
3. **Taxonomie en 5 champs séparés** (Quoi, Lieu précis, Lieu obligatoire, Père, Grand-père),
   chacun avec sa propre icône de sauvegarde (💾) — recomposés côté serveur en un `name` unique
   avant envoi (`rfxcom:device:set_name`).
4. Deux listes distinctes : devices paramétrés (fichier) vs devices en auto-discovery (mémoire
   session).

**Barre d'outils (toolbar) :**

| Bouton | Icône | Événement Socket.io | Description | Statut |
|--------|-------|---------------------|--------------|--------|
| Scanner RF433 | 🔍 | `rfxcom:scan:start` | Démarrer une détection | ⚠️ **déclaré côté UI, aucun gestionnaire serveur** (voir §20) |
| Effacer non paramétrés | 🗑️ | `rfxcom:devices:clear-unconfigured` | Supprimer les devices auto-découverts non configurés | Fonctionnel |
| Rafraîchir | 🔄 | `rfxcom:devices:refresh` | Recharger la liste des devices paramétrés | Fonctionnel |

**Gestion des Récepteurs :**
1. Création : type (switch/light/cover), primaryEmitter, liste des emitters.
2. Variateur : cocher `isDimmable` pour Lighting2.
3. Covers : `openTimeSec`/`closeTimeSec` **obligatoires**.
4. Taxonomie en 5 champs séparés (même pattern que Devices).

**Gestion des Appairages** (intégrée à l'onglet Récepteurs) :
1. Ajout d'émetteurs à un récepteur depuis la liste des devices détectés.
2. Action par émetteur : toggle, on, off, set_level (light), open, close, stop (cover).
3. `primaryEmitter` désigné parmi les émetteurs associés.
4. **Libellés lisibles** dans les listes déroulantes (§5.5) — dérivés de la taxonomie
   (ex: `Bouton · Salon (lighting2_ac_0x02b3)`), pas le `uniqueId` brut.

**Scènes :** onglet dédié, création/modification/suppression via UI — voir §15.3.

### 12.3 Événements Socket.io

**Server → Client :**
```typescript
'rfxcom:status': { connected, devicesCount, receiversCount, lastDiscovery }
'rfxcom:devices:list': { devices: RfxComDeviceInfo[] }
'rfxcom:receivers:list': { receivers: ReceiverConfig[] }
'rfxcom:scenes:list': { scenes: ReceiverSceneConfig[] }
'rfxcom:protocols:list': {
  hardware: { receiverType, receiverTypeCode, firmwareVersion, firmwareType, enabledProtocols, availableProtocols } | null;
  hardwareAvailable: string[];
  hardwareEnabled: string[];
}
'rfxcom:device:detected': { device: RfxComDeviceInfo }
'rfxcom:error': { code: string, message: string }
```

**Client → Server :**
```typescript
'rfxcom:receiver:create' / 'rfxcom:receiver:update' / 'rfxcom:receiver:delete'
'rfxcom:scene:create' / 'rfxcom:scene:update' / 'rfxcom:scene:delete'
'rfxcom:scene:execute' / 'rfxcom:scene:cancel'
'rfxcom:devices:refresh'
'rfxcom:devices:clear-unconfigured'
'rfxcom:device:set_transmit' / 'rfxcom:device:delete' / 'rfxcom:device:set_name'
'rfxcom:protocols:list:get'
'rfxcom:hardware-protocol:toggle': { protocol: string, enabled: boolean }
'rfxcom:hardware-protocols:push'
'rfxcom:hardware-status:refresh'
```

> ⚠️ `rfxcom:scan:start`/`:complete`/`:failed` restent **déclarés** (§20) mais n'ont plus lieu
> d'être documentés comme un flux fonctionnel — aucun gestionnaire serveur ne les traite ; la
> détection est purement passive/continue.

---

## 13. Scénarios d'Utilisation

### 13.1 Découverte d'un Capteur (Température)
```
1. RFXCOM reçoit: RFXSensor Temperature 0xA5B3
2. Auto-détermination: subType "Temperature" → QUOI = "Température"
3. Génération: unique_id = "rfxsensor_temperature_0xa5b3"
4. Ajout automatique dans config-rfxcom-devices-v1.0.yaml (transmitToHa: false par défaut)
5. UI propose de compléter le OÙ et de cocher transmitToHa
6. Utilisateur saisit: Quoi=Température, Lieu=Salon, coche transmitToHa
7. Publication Discovery MQTT
8. HA découvre: sensor.rfxsensor_temperature_0xa5b3
```

### 13.2 Découverte d'un Émetteur (Lighting2)
```
1. RFXCOM reçoit: Lighting2 AC 0x02BE2C02 unitCode 13
2. Auto-détermination: type "Lighting2" → QUOI = "Bouton"
3. Génération: unique_id = "lighting2_ac_0x02be2c02_13"
4. Ajout automatique dans config-rfxcom-devices-v1.0.yaml
5. Par défaut: composant HA = binary_sensor
6. UI propose de compléter le OÙ
```

### 13.3 Création d'un Récepteur avec Variateur
```
1. Utilisateur crée un récepteur via UI (fenêtre modale)
   - name: "Lumière---Salon", type: "light", isDimmable: true
   - primaryEmitter: "lighting2_ac_0x02be2c02_13"
   - emitters: [{emitterId: "lighting2_ac_0x02be2c02_13", action: "toggle"}]
2. Sauvegarde dans config-rfxcom-devices-v1.0.yaml
3. Publication Discovery MQTT (light.recepteur_<id>)
4. Test: appui sur bouton physique → recepteur toggle (via emitters[], voir §5.3)
5. Test: commande HA light.recepteur_<id>/set → RF433 envoyé au primaryEmitter
```

### 13.4 Appairage Multiple (N↔N)
```
Récepteur recepteur_A (light) a: primaryEmitter=E1, emitters=[E1, E2]
Récepteur recepteur_B (switch) a: emitters=[E1]

Appui sur E1:
  → recepteur_A exécute son action pour E1 (car E1 ∈ emitters[])
  → recepteur_B exécute son action pour E1 (idem)
```

### 13.5 Ajout d'un Bouton via Détection Automatique
```
1. Onglet Devices → RFXCOM
2. "🗑️ Effacer non paramétrés" → nettoie la liste auto-discovery
3. "🔄 Rafraîchir" → recharge les devices déjà paramétrés
4. Appui physique sur un nouveau bouton RF433 → détection automatique passive
5. Client reçoit `rfxcom:device:detected` → ajout à la liste auto-discovery
6. Sélection → modale de paramétrage → saisie taxonomie 5 champs + transmitToHa
7. Sauvegarde → device passe en "paramétré"
```

**Persistance** : les devices paramétrés sont sauvegardés avec `transmitToHa: false` par défaut ;
seuls ceux à `true` sont envoyés à HA au démarrage. Les devices auto-découverts non paramétrés ne
sont **pas** persistés (mémoire de session uniquement).

---

## 14. Gestion des États

### 14.1 Attributs Communs (état MQTT, corrigé v5.9)

```json
{
  "state": "ON"
}
```
Avec en complément, **quand disponibles**, les attributs HA standard `signal_level`/`battery_level`
(publiés séparément, pas dans `attributs_taxonomie` — voir §2.6/§17 pour le topic dédié aux
attributs de taxonomie, distinct de l'état).

### 14.2 Fraîcheur et État au Démarrage
Voir §9.2 — aucun état "unknown" fictif, publication conditionnée à `lastSeen` < 30 minutes.

---

## 15. Commandes

### 15.1 Émetteurs Lighting (binary_sensor par défaut)
| Type | Commandes HA | Signification |
|------|--------------|---------------|
| Lighting1/2/4/5/6 | on, off | Émission signal RF433 ON/OFF |

### 15.2 Récepteurs
| Type | Commandes HA | Action RFXCOM |
|------|--------------|----------------|
| switch | on, off, toggle | Envoi ON/OFF au device cible (via primaryEmitter) |
| light | on, off, toggle, set_level | Conversion niveau, envoi au device cible |
| cover | open, close, stop | Envoi OPEN/CLOSE/STOP au device cible (Blinds1 uniquement — voir `implementation-rfxcom_specs`) |

### 15.3 Scènes RFXCOM

Une **scène** est un ensemble de commandes exécutées simultanément ou séquentiellement sur
plusieurs récepteurs.

#### 15.3.1 Structure des Scènes
```yaml
rfxcom_scenes:
  <sceneId>:
    id: "<sceneId>"
    name: "<QUOI>---<OÙ>"
    type: "parallel" | "sequential"     # défaut: sequential
    delayBetweenCommands: <ms>          # défaut: 500
    actions:
      - target: "<receiverId>"
        command: "<action>"
        value: <optionnel>
        delayMs: <optionnel, écrase delayBetweenCommands pour cette action>
```

#### 15.3.2 Comportement des Scènes
- **`parallel`** : les commandes sont envoyées **l'une après l'autre sans attente**
  (implémentation réelle : boucle synchrone, pas de véritable parallélisme `Promise.all` — effet
  perçu identique pour l'utilisateur, différence purement d'implémentation).
- **`sequential`** : les commandes sont envoyées les unes après les autres, avec un délai
  (`delayMs` de l'action, sinon `delayBetweenCommands` de la scène, sinon 500ms par défaut) entre
  chaque. Annulation vérifiée avant chaque commande et après chaque délai.
- **Gestion des erreurs** : en mode `sequential`, la première commande en échec interrompt les
  suivantes. En mode `parallel`, toutes les commandes sont tentées même en cas d'échec partiel.
- **Résultat** : `success = (aucune commande en échec) && (non annulée)` — voir la limitation
  ci-dessous.

> ⚠️ **Simplification connue** : le résultat d'exécution ne porte qu'un booléen `success` — une
> scène annulée par l'utilisateur et une scène ayant réellement échoué produisent le même
> `success: false`. Seule l'inspection du tableau `errors[]` (vide en cas d'annulation, peuplé en
> cas d'échec réel) permet de distinguer les deux cas.

#### 15.3.3 Intégration avec Home Assistant

Publiées comme `device_automation` (déclencheur, pas d'état/entité classique) :

```json
{
  "name": "Soirée",
  "unique_id": "rfxcom_scene_1000851",
  "automation_type": "trigger",
  "type": "scene_executed",
  "subtype": "<receiverId de la scène>",
  "topic": "rfxcom/rfx_bridge_0001/scene_1000851/set",
  "payload": "{}",
  "device": {
    "identifiers": ["rfxcom_scene_1000851"],
    "name": "RFXCOM Scène",
    "manufacturer": "RFXCOM",
    "model": "Scene"
  }
}
```

> ⚠️ **`type`/`subtype` sont requis par le schéma HA `device_automation`** — leur absence produit
> une erreur "required key not provided @ data['type']" côté HA (découvert en conditions réelles).
> **Aucun topic d'attributs de taxonomie** n'existe pour les scènes : `device_automation` est un
> déclencheur, pas une entité au sens classique, sans équivalent à `json_attributes_topic`.
>
> **Simplification connue, non vérifiée sur HA réel** : le schéma canonique `device_automation`
> attend un identifiant de découverte à deux segments (`.../{device_id}/{trigger_id}/config`) ; le
> socle ne construit qu'un identifiant unique par entité — la découverte utilise donc un seul
> segment (`rfxcom_scene_{sceneId}`), validé uniquement contre le broker MQTT (souscription/
> publication effectives), jamais contre une instance HA réelle qui vérifierait l'enregistrement.

**Topics MQTT pour les scènes :**
- **Exécution** : `rfxcom/{bridgeInstance}/scene_{sceneId}/set` (HA → App)
- **Résultat** : `rfxcom/{bridgeInstance}/scene_{sceneId}/state` (App → HA), état `completed`/`failed`,
  attributs `executed_commands`/`failed_commands`/`duration_ms`

> Attention à ne pas confondre l'`objectId` de découverte (`rfxcom_scene_{sceneId}`) et le
> `deviceId` d'état/commande (`scene_{sceneId}`) — deux encodages distincts pour la même scène.

#### 15.3.4 Commandes Spécifiques aux Scènes

| Commande | Description | Payload |
|----------|-------------|---------|
| `rfxcom:scene:execute` | Exécuter une scène | `{ sceneId }` |
| `rfxcom:scene:cancel` | Annuler une scène en cours (best-effort : n'interrompt qu'un mode `sequential` entre deux commandes) | `{ sceneId }` |
| `rfxcom:scenes:list:get` | Demander la liste des scènes | — |
| `rfxcom:scenes:list` | Liste des scènes | `{ scenes: ReceiverSceneConfig[] }` |
| `rfxcom:scene:create` / `:update` / `:delete` | CRUD scène | `{ config }` / `{ sceneId, config }` / `{ sceneId }` |

### 15.4 Commandes Spécifiques aux Récepteurs Dimmables

Pour les récepteurs avec `isDimmable: true` :

| Commande HA | Action RFXCOM | Conversion |
|--------------|----------------|-----------|
| `turn_on` | Envoi ON avec dernier niveau | Utilise `defaultLevel` ou 100% |
| `turn_off` | Envoi OFF | - |
| `toggle` | Basculer ON/OFF | Inverse l'état actuel |
| `set_level` | Envoi ON avec niveau spécifié | Voir échelle native ci-dessous |

> ⚠️ **Échelle réelle** : le niveau natif RFXCOM (`Lighting2.setLevel`) est **0-15**, pas 0-100 ni
> 0-255. La conversion depuis le pourcentage HA (`brightness`/`level`) est arrondie et bornée à
> cette plage — voir `implementation-rfxcom_specs` pour le détail du calcul.

### 15.5 Commandes Spécifiques aux Covers (Blinds1)

| Commande HA | Action RFXCOM |
|--------------|----------------|
| `open` | Envoi OPEN au device |
| `close` | Envoi CLOSE au device |
| `stop` | Envoi STOP au device |

---

## 16. Traduction Commandes HA → RFXCOM

### 16.1 Règles Générales
**Principe :** chaque type de récepteur (Switch, Light, Cover) implémente sa propre logique de
traduction en fonction du type du `primaryEmitter`.

**Flux :** HA → EventBus → RfxComService → ReceiverManager → `Receiver*.translateHaCommand()` → Commande RFXCOM

### 16.2 Récepteurs Switch
| Commande HA | Commande RFXCOM |
|-------------|------------------|
| `turn_on` | `on` |
| `turn_off` | `off` |
| `toggle` | `on`/`off` (inverse) |

### 16.3 Récepteurs Light
**A. Non dimmable** → comme Switch.
**B. Dimmable (Lighting2 uniquement, seul protocole récepteur variable en pratique)** :

| Commande | Lighting2 |
|----------|-----------|
| `turn_on` | `on` (dernier niveau connu) |
| `turn_off` | `off` |
| `set_level` | `set_level(value 0-15)` |

### 16.4 Récepteurs Cover (Blinds1)
| Commande HA | Commande RFXCOM |
|-------------|------------------|
| `open` | `open` (durée = `openTimeSec * 1000`) |
| `close` | `close` (durée = `closeTimeSec * 1000`) |
| `stop` | `stop` |

---

## 17. Découverte et Retrait MQTT

### 17.1 Publication (voir §7.2)
Chaque device/récepteur/scène avec `transmitToHa: true` publie sa découverte au démarrage (sous
réserve du verrou §8.3) et à chaque modification pertinente.

### 17.2 Topic dédié aux attributs de taxonomie
Voir §2.6 — publié uniquement au moment de la (re)découverte, jamais à chaque changement d'état.
Absent pour les scènes (`device_automation`, pas d'équivalent HA).

### 17.3 Retrait à la désélection (⭐ nouveau, absent de toute version antérieure)

Décocher `transmitToHa` (ou supprimer un device/récepteur/scène auparavant publié) déclenche le
**retrait effectif de la découverte HA** : publication d'une chaîne vide, retenue, sur le topic de
découverte (`homeassistant/{component}/{objectId}/config`) — mécanisme socle standard, pas
spécifique à RFXCOM.

Déclenché par :
- `rfxcom:device:set_transmit` passant de `true` à `false`
- `rfxcom:device:delete` (si `transmitToHa` était `true`)
- `rfxcom:receiver:update` faisant passer `transmitToHa` de `true` à `false`
- `rfxcom:receiver:delete` (si `transmitToHa` était `true`)
- `rfxcom:scene:update`/`:delete` (idem)

> ⚠️ **Piège technique** : le `component` HA (sensor/binary_sensor/light/switch/cover) doit être
> capturé **avant** la suppression/mutation, car il dérive du type du récepteur — une fois le
> récepteur retiré de `ReceiverManager`, cette information n'est plus disponible pour construire le
> topic de retrait.

---

## 18. Arborescence des Programmes (réelle, corrigée v5.9)

> ⚠️ La structure documentée jusqu'à v5.8 (`base/`, `switch/`, `light/`, `cover/` en
> sous-dossiers, `devices/handlers/[RfxSensor|Lighting]Handler.ts`, `RfxComConfigService.ts`,
> `presentation/index.ts`) **ne correspond pas** à l'arborescence réelle, qui est **plate** dans
> chaque dossier et ne comporte aucun de ces fichiers.

```
applications/rfxcom/
├── package.json, package-lock.json, tsconfig.json
├── src/
│   ├── domain/
│   │   ├── RfxComService.ts              # Orchestrateur (le plus volumineux du module)
│   │   ├── index.ts, types.ts
│   │   ├── config-schema.ts              # Config générale (§8.1)
│   │   ├── devices-config-schema.ts      # Schéma Zod du fichier YAML centralisé (§10)
│   │   ├── socket-events.ts
│   │   ├── taxonomy.ts                   # extractTaxonomy, buildDisplayName, buildBoutonDisplayName
│   │   ├── classification.ts             # determineQuoi, getProtocole, getDefaultComponent
│   │   ├── transceiver/
│   │   │   ├── RfxComTransceiver.ts      # Enveloppe la bibliothèque rfxcom
│   │   │   └── PortDetector.ts           # §8.2
│   │   ├── devices/
│   │   │   └── DeviceManager.ts          # Registry des devices, construction uniqueId
│   │   ├── receivers/                    # ⚠️ plat, pas de sous-dossiers base/switch/light/cover
│   │   │   ├── BaseReceiver.ts
│   │   │   ├── ReceiverManager.ts
│   │   │   ├── ReceiverSwitch.ts
│   │   │   ├── ReceiverLight.ts
│   │   │   └── ReceiverCover.ts
│   │   ├── scenes/
│   │   │   ├── SceneManager.ts
│   │   │   └── SceneExecutor.ts
│   │   └── yaml/
│   │       └── ConfigFileManager.ts      # Lecture/écriture config-rfxcom-devices-v1.0.yaml
│   ├── types/
│   │   └── rfxcom.d.ts                   # Déclarations manuelles (couvre uniquement la surface utilisée)
│   └── presentation/
│       ├── index.html, tsconfig.ui.json
│       ├── ts/app.ts, ts/global.d.ts
│       └── rfxcom/
│           ├── config.html               # Page dédiée (onglets Devices/Récepteurs/Scènes/Protocoles)
│           └── config-app.ts
```

**Règle non respectée en pratique** : le principe "max 400 lignes/fichier" énoncé en v5.5 est
aujourd'hui dépassé par `RfxComService.ts`, `config-app.ts` et `RfxComTransceiver.ts` — signalé ici
sans action corrective engagée à ce jour (voir Roadmap §21).

---

## 19. Tests

| ID | Description | Type |
|----|-------------|------|
| RFX-001 | Auto-détermination QUOI depuis subType | Unitaire |
| RFX-002 | Génération unique_id avec protocole+subType+sensorId(+unitCode) | Unitaire |
| RFX-003 | QUOI = type fonctionnel pur (pas d'endroit) | Unitaire |
| RFX-004 | Lighting = binary_sensor par défaut | Unitaire |
| RFX-005 | Appairage N↔N émetteurs/récepteurs | Intégration |
| RFX-006 | Configuration variateur via fichier YAML | Intégration |
| RFX-007 | Détection automatique du port série | Intégration |
| RFX-008 | primaryEmitter utilisé pour les commandes HA→RFXCOM | Intégration |
| RFX-009 | Ordonnancement push protocoles → découverte initiale | Intégration |
| RFX-010 | Retrait de découverte à la désélection | Intégration |

---

## 20. Limites et Contraintes

| Limite | Impact | Solution / Statut |
|--------|--------|----------|
| **`lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` écrits en YAML mais strippés au chargement** (schéma Zod ne les déclare pas, `z.object()` en mode `strip` par défaut) | Cause racine de la rafale de commandes OFF envoyée à **tous** les récepteurs à **chaque** redémarrage (l'état "dernier connu" est toujours relu comme `undefined`) ; la fenêtre de fraîcheur de 30 min (§9.2) ne peut jamais se déclencher pour `lastValue` en pratique | Non corrigé à ce jour — nécessiterait d'ajouter ces champs au schéma Zod des devices/récepteurs |
| `autoDiscovery` (config.yaml) déclaré mais jamais lu par le code | Le champ n'a aucun effet, quelle que soit sa valeur ; la détection RF433 est en réalité toujours active | Non corrigé — champ à retirer ou à réellement implémenter |
| `rfxcom:scan:start`/`:complete`/`:failed` déclarés côté UI/Socket.io sans gestionnaire serveur | Le bouton "Scanner RF433" de la toolbar (§12.2) ne produit aucun effet observable côté serveur | Non corrigé — détection RF433 purement passive/continue en pratique |
| QUOI auto-déterminé | Peut ne pas correspondre au cas réel | Modifiable via l'UI/fichier YAML |
| Heuristique Motion/Contact (Security1) | Classification par nom de subtype, pas un champ structuré | Acceptée, best-effort |
| Lighting = binary_sensor par défaut | Pas toujours adapté | Configurable via type de récepteur |
| Seuls 3 protocoles peuvent transmettre (Lighting1/2, Blinds1) | Un récepteur avec un `primaryEmitter` Lighting4/5/6 ne peut pas envoyer de commande RF433 | Limite de la bibliothèque `rfxcom` elle-même |
| `RFXMeter`/Elec sans bit de filtrage matériel | Impossible de filtrer cette catégorie de protocoles | Acceptée (voir §8.3) |
| Échec de push de protocoles non remonté à l'UI | L'utilisateur ne voit pas un échec de push (bouton dédié ou rafraîchissement) | Non corrigé — logs serveur uniquement |
| `SceneExecutionResult` sans distinction échec/annulation | `scene_failed` et `scene_cancelled` produisent le même `success: false` | Acceptée, `errors[]` permet de distinguer manuellement |
| Découverte `device_automation` à un seul segment (scènes) | Jamais vérifiée contre une instance HA réelle (seulement broker MQTT) | Acceptée, non vérifiée |

---

## 21. Roadmap

### Terminé (V4/V5/V5.5-V5.8)
Voir historique §22.3 pour le détail complet des versions précédentes.

### V5.9 (Terminé - 3 Août 2026)
- [x] Rattrapage documentaire complet (aucun changement de code) : détection automatique du port,
  ordonnancement démarrage (verrou protocoles), reconnexion à chaud, retrait de découverte,
  topic dédié attributs, format réel des identifiants, arborescence réelle.

### Non planifié
- [ ] Corriger la persistance `lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` (§20, cause racine
  de la rafale OFF au redémarrage)
- [ ] Retirer ou implémenter réellement `autoDiscovery`
- [ ] Retirer ou implémenter réellement le flux `rfxcom:scan:*`
- [ ] Découpage de `RfxComService.ts`/`config-app.ts`/`RfxComTransceiver.ts` (dépassent 400 lignes)
- [ ] Remonter les échecs de push de protocoles à l'UI

---

## 22. Annexes

### 22.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](spec-nommage-v1.0.md) ⭐
- [Spécifications Implémentation RFXCOM](implementation-rfxcom_specs_v1.3.md)
- [Spécifications Récepteurs/Émetteurs RFXCOM](recepteurs-emetteurs-rfxcom_specs_v5.4.md)
- [Spécifications Techniques Socle HA-MQTT **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.19.md) ⭐
- [Documentation librairie npm rfxcom](https://www.npmjs.com/package/rfxcom)

### 22.2 Glossaire
| Terme | Définition |
|-------|------------|
| QUOI | Type fonctionnel pur (ex: "Température", "Bouton") |
| OÙ | Localisation hiérarchique (ex: "Salon", "Coin Canapé--Salon") |
| unique_id | `<protocole>_<subType>_<sensorId>[_<unitCode>]` |
| primaryEmitter | Émetteur principal d'un récepteur, utilisé pour envoyer les commandes RF433 |
| Appairage | Lien entre un émetteur et un récepteur (N↔N) |
| transmitToHa | Case à cocher autorisant l'envoi du device/récepteur vers HA |
| Protocoles matériel | Sélection (granularité bibliothèque `rfxcom`) poussée au RFXtrx433 en RAM — voir §8.3 |
| protocolsPushGate | Verrou retardant la première découverte jusqu'à la tentative de push des protocoles (§8.3) |

### 22.3 Annexe : Communication Inter-Applications — **NON IMPLÉMENTÉE**

> ⚠️ **Cette section décrit une conception qui n'a jamais été codée.** Aucune trace de
> `InterAppClient` dans `applications/rfxcom/`. Conservée ici à titre de mémoire de conception (le
> pattern Request/Reply existe et est utilisé par d'autres briques du projet), mais ne doit **pas**
> être considérée comme une capacité actuellement exposée par RFXCOM. Si ce chantier est repris un
> jour, repartir de `inter-app-communication_specs_v1.0.md` plutôt que de ce texte figé.

Événements Fire & Forget envisagés : `rfxcom:device:detected`, `rfxcom:device:removed`,
`rfxcom:device:state:updated`, `rfxcom:message:received`, `rfxcom:scan:started/completed`,
`rfxcom:scan:device:found`.

Capacités Request/Reply envisagées : `rfxcom:devices:list`, `rfxcom:device:get`,
`rfxcom:device:scan`, `rfxcom:device:send`, `rfxcom:pairing:create`, `rfxcom:pairing:delete`.

### 22.4 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 → 4.0 | 2026-07-05 → 07-08 | Mistral Vibe | Version initiale, intégration spec nommage, clarification émetteurs/récepteurs, QUOI pur, auto-détermination |
| 5.0 | 2026-07-09 | Mistral Vibe | Fichier YAML centralisé, primaryEmitter, émetteurs dans récepteur |
| 5.1 | 2026-07-16 | Mistral Vibe | Détection automatique onglet Devices, toolbar, Appairages intégrées aux Récepteurs |
| 5.4 | 2026-07-17 | Mistral Vibe | Gestion des protocoles (logicielle, retirée depuis), transmitToHa, scènes réactivées, actions MQTT par le socle |
| 5.5 | 2026-07-18 | Mistral Vibe | Spécifications Cover Lighting2, traduction commandes HA→RFXCOM, arborescence modulaire |
| 5.6 | 2026-07-21 | Claude | Alignement topics MQTT sur le nouveau format du socle |
| 5.7 | 2026-07-21 | Claude | Scènes implémentées et testées, événements Socket.io réels, correctif socle abonnement commandes |
| 5.8 | 2026-07-27 | Claude | Remplacement filtre logiciel → filtre matériel unique, onglet Protocoles, taxonomie 5 champs, fenêtres modales, libellés lisibles |
| 5.9 | 2026-08-03 | Claude | **Rattrapage documentaire complet** (voir bandeau en tête de document) : détection automatique du port (§8.2, absente jusqu'ici), verrou d'ordonnancement démarrage→push protocoles→découverte (§8.3), reconnexion à chaud (§8.5), retrait de découverte à la désélection (§17.3), topic dédié attributs de taxonomie (§2.6/§17.2, remplace un mécanisme jamais fonctionnel), format réel des identifiants (§2.2), absence d'état "unknown" fictif au démarrage (§9.2), arborescence réelle (§18), numérotation des sections corrigée, section Communication Inter-Applications déplacée en annexe et marquée non implémentée (§22.3), nouvelles limitations documentées (§20) dont la cause racine de la rafale OFF à chaque redémarrage. Aucun changement de comportement — travail de documentation uniquement, faisant suite à plusieurs semaines de dérive entre code et specs. |

---

*Conforme à [spec-nommage-v1.0.md](spec-nommage-v1.0.md) et [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.19.md)*
