# Spécifications Techniques — Classifieur RFXCOM
**Module Complémentaire à specs-techniques-socle-ha-mqtt-v4.3.md §8.3**

**Version :** 1.0  
**Date :** 11 Juillet 2026  
**Statut :** Document de référence pour l'implémentation de `IHaClassifier` spécifique à RFXCOM  
**Conformité :** Intègre et étend les règles générales définies dans `specs-techniques-socle-ha-mqtt-v4.3.md`  

---

## 📌 Table des Matières
1. [Contexte et Périmètre](#1-contexte-et-périmètre)
2. [Règles Générales de Classification](#2-règles-générales-de-classification)
3. [Priorités de Classification pour RFXCOM](#3-priorités-de-classification-pour-rfxcom)
4. [Mapping `subType` RFXCOM → QUOI](#4-mapping-subtype-rfxcom--quoi)
5. [Mapping `type` RFXCOM → QUOI](#5-mapping-type-rfxcom--quoi)
6. [Règles Spécifiques aux Émetteurs](#6-règles-spécifiques-aux-émetteurs)
7. [Règles Spécifiques aux Récepteurs](#7-règles-spécifiques-aux-récepteurs)
8. [Gestion des Conflits](#8-gestion-des-conflits)
9. [Exemples Concrets](#9-exemples-concrets)
10. [Intégration avec `HaStructureRegistry`](#10-intégration-avec-hastructureregistry)
11. [Évolutivité](#11-évolutivité)
12. [Annexes](#12-annexes)

---

## 1. Contexte et Périmètre

### 1.1 Objectif
Ce document **complète** les spécifications générales du classifieur HA définies dans 
[`specs-techniques-socle-ha-mqtt-v4.3.md §8.3`](specs-techniques-socle-ha-mqtt-v4.3.md#83-haclassifier---module-de-classification-%C3%A0-sp%C3%A9cifier-s%C3%A9par%C3%A9ment) 
en détaillant les **règles spécifiques au module RFXCOM** pour la classification des entités.

**Pourquoi un document dédié ?**
- Les devices RFXCOM introduisent un **attribut `subType`** (ex: `Temperature`, `Humidity`, `Motion`) qui est **plus précis** que `device_class` HA pour la détermination du QUOI.
- La classification doit **prioriser** ce champ pour une correspondance exacte avec les types fonctionnels RF433.

### 1.2 Périmètre
| Inclus | Exclus |
|--------|--------|
| Règles de classification pour les devices RFXCOM (capteurs et émetteurs) | Implémentation du classifieur (code TypeScript) |
| Mapping `subType` → QUOI | Gestion des erreurs de classification |
| Mapping `type` → QUOI (fallback) | Classification des entités non-RFXCOM |
| Règles spécifiques aux émetteurs/récepteurs | Intégration avec MQTT ou WebSocket |
| Priorités de classification RFXCOM | Tests unitaires |

### 1.3 Public Cible
- Développeurs implémentant `HaClassifier` pour RFXCOM
- Mainteneurs du socle HA-MQTT
- Intégrateurs du module RFXCOM

### 1.4 Conformité
Ce document **respecte strictement** :
- [`specs-techniques-socle-ha-mqtt-v4.3.md`](specs-techniques-socle-ha-mqtt-v4.3.md) (architecture 5 couches, `IHaClassifier`)
- [`spec-nommage-v1.0.md`](spec-nommage-v1.0.md) (définition du QUOI)
- [`specs-fonctionnelles-rfxcom-v5.0.md`](specs-fonctionnelles-rfxcom-v5.0.md) (spécifications RFXCOM)

---

## 2. Règles Générales de Classification

### 2.1 Principe de Base
Le classifieur RFXCOM **étend** les règles générales définies dans 
[`specs-techniques-socle-ha-mqtt-v4.3.md §8.3`](specs-techniques-socle-ha-mqtt-v4.3.md#83-haclassifier---module-de-classification-%C3%A0-sp%C3%A9cifier-s%C3%A9par%C3%A9ment) 
avec une **priorité supplémentaire** pour les champs spécifiques à RFXCOM.

**Ordre de priorité global (pour les entités RFXCOM) :**
1. **`subType` RFXCOM** (le plus précis, spécifique à RFXCOM) → **NOUVEAU**
2. `device_class` HA (générique)
3. `domain` HA (générique)
4. Dernier segment de `entity_id` après `--` (générique)
5. `non_classifie` (fallback)

> **⚠️ Important** : Pour les entités **non-RFXCOM**, le classifieur revient aux règles générales (priorité : `device_class` > `domain` > `entity_id`).

### 2.2 Détection d'une Entité RFXCOM
Une entité est considérée comme **RFXCOM** si :
- Son `entity_id` **contient** un préfixe RFXCOM connu (ex: `rfxsensor_`, `rfxmeter_`, `lighting1_`, `lighting2_`, `lighting4_`), **OU**
- Ses `attributes` contiennent un champ `subType` **ET** un champ `type` (ex: `type: "RFXSensor"`, `subType: "Temperature"`), **OU**
- Son `device_id` fait référence à un device RFXCOM connu (via `HaStructureRegistry`).

---

## 3. Priorités de Classification pour RFXCOM

### 3.1 Ordre de Priorité Complet
| Priorité | Champ | Source | Exemple | QUOI Résultant |
|---------|-------|--------|---------|----------------|
| **1** | `subType` RFXCOM | `attributes.subType` | `"Temperature"` | `"température"` |
| **2** | `device_class` HA | `device_class` | `"temperature"` | `"température"` |
| **3** | `type` RFXCOM | `attributes.type` | `"RFXMeter"` | `"courant"` (si `subType: "Current"`) |
| **4** | `domain` HA | `domain` | `"sensor"` | `"capteurs"` |
| **5** | Dernier segment de `entity_id` | `entity_id.split('--').pop()` | `"salon--température"` | `"température"` |
| **6** | Fallback | - | - | `"non_classifie"` |

### 3.2 Algorithme de Classification
```
1. Si entité est RFXCOM (voir §2.2) :
   a. Si attributes.subType existe ET est dans RFXCOM_SUBTYPE_TO_QUOI :
      → Retourner [mapping(subType)]
   b. Sinon si attributes.type existe ET est dans RFXCOM_TYPE_TO_QUOI :
      → Retourner [mapping(type)]
   c. Sinon : Passer à l'étape 2 (règles générales)
2. Sinon (entité non-RFXCOM) :
   a. Appliquer règles générales (device_class > domain > entity_id)
```

---

## 4. Mapping `subType` RFXCOM → QUOI

### 4.1 Capteurs RFXSensor
| subType RFXCOM | QUOI | Domain HA | Device Class HA | Description | Exemple entity_id |
|----------------|------|------------|------------------|-------------|-------------------|
| Temperature | température | sensor | temperature | Capteur de température | sensor.rfxsensor_0xa5b3 |
| Humidity | humidite | sensor | humidity | Capteur d'humidité | sensor.rfxsensor_0xc4d2 |
| Pressure | pression | sensor | pressure | Capteur de pression atmosphérique | sensor.rfxsensor_0xXXXX |
| Motion | detecteur | binary_sensor | motion | Détecteur de mouvement | binary_sensor.rfxsensor_0xe7f1 |
| Contact | contact | binary_sensor | door | Capteur de contact (porte/fenêtre) | binary_sensor.rfxsensor_0x98a4 |
| Gas | fumee | sensor | gas | Détecteur de gaz | sensor.rfxsensor_0xXXXX |
| Smoke | fumee | sensor | smoke | Détecteur de fumée | sensor.rfxsensor_0xXXXX |
| CO2 | fumee | sensor | co2 | Capteur de CO2 | sensor.rfxsensor_0xXXXX |
| VOC | fumee | sensor | voc | Capteur de COV | sensor.rfxsensor_0xXXXX |
| Moisture | inondation | sensor | moisture | Détecteur d'inondation | sensor.rfxsensor_0xXXXX |
| Illuminance | eclairage | sensor | illuminance | Capteur de luminosité | sensor.rfxsensor_0xXXXX |

### 4.2 Compteurs RFXMeter
| subType RFXCOM | QUOI | Domain HA | Device Class HA | Description | Exemple entity_id |
|----------------|------|------------|------------------|-------------|-------------------|
| Current | courant | sensor | current | Compteur de courant | sensor.rfxmeter_0xb2c3 |
| Power | puissance | sensor | power | Compteur de puissance | sensor.rfxmeter_0xd4e5 |
| Energy | energie | sensor | energy | Compteur d'énergie | sensor.rfxmeter_0xXXXX |
| Voltage | energie | sensor | voltage | Compteur de tension | sensor.rfxmeter_0xXXXX |
| Water | eau | sensor | water | Compteur d'eau | sensor.rfxmeter_0xXXXX |
| Flow | eau | sensor | flow | Débitmètre | sensor.rfxmeter_0xXXXX |

### 4.3 Émetteurs Lighting (Boutons/Interrupteurs)
| subType RFXCOM | QUOI | Domain HA | Device Class HA | Description | Exemple entity_id |
|----------------|------|------------|------------------|-------------|-------------------|
| AC | bouton | binary_sensor | - | Bouton AC | binary_sensor.lighting2_0x02b3 |
| HomeEasy | interrupteur | switch | - | Interrupteur HomeEasy | switch.lighting1_0x01a2 |
| ARC | interrupteur | switch | - | Interrupteur ARC | switch.lighting1_0xXXXX |
| X10 | interrupteur | switch | - | Interrupteur X10 | switch.lighting1_0xXXXX |

> **⚠️ Règle spéciale** : Si le **récepteur** associé à un émetteur `Lighting2` a `isDimmable: true`, alors le QUOI du récepteur est `eclairage` (et non `bouton`).
> **Exemple** : Un émetteur `lighting2_0x02b3` peut contrôler un récepteur `recepteur_001` (QUOI: `eclairage` si `isDimmable: true`).

---

## 5. Mapping `type` RFXCOM → QUOI (Fallback)

**Utilisé si `subType` est absent ou inconnu.**

| type RFXCOM | QUOI | Description |
|-------------|------|-------------|
| RFXSensor | capteurs | Capteur générique (si `subType` inconnu) |
| RFXMeter | energie | Compteur générique |
| Lighting1 | interrupteur | Émetteur Lighting1 (AC) |
| Lighting2 | bouton | Émetteur Lighting2 (AC, avec variateur si `isDimmable`) |
| Lighting4 | interrupteur | Émetteur Lighting4 |
| Lighting5 | interrupteur | Émetteur Lighting5 |
| Lighting6 | interrupteur | Émetteur Lighting6 |

---

## 6. Règles Spécifiques aux Émetteurs

### 6.1 Émetteurs Lighting
- **Par défaut** : Les émetteurs Lighting1/2/4/5/6 sont classés comme `binary_sensor` (QUOI: `bouton` ou `interrupteur`).
- **Exception** : Si un émetteur est **appairé à un récepteur avec `isDimmable: true`**, le récepteur est classé comme `eclairage` (et non `bouton`).
  - **Exemple** : 
    ```yaml
    recepteur_001:
      isDimmable: true  # → QUOI: "eclairage"
      primaryEmitter: "lighting2_0x02b3"  # Émetteur (QUOI: "bouton")
    ```

### 6.2 Émetteurs sans `subType`
Si un émetteur RFXCOM n'a **pas de `subType`**, utiliser son `type` pour la classification (voir §5).

### 6.3 Émetteurs Appairés à Plusieurs Récepteurs
- Un émetteur peut contrôler **plusieurs récepteurs** (relation N↔N).
- **Le QUOI de l'émetteur reste inchangé** (ex: `bouton` pour un `Lighting2`).
- **Le QUOI des récepteurs** est déterminé par leur propre configuration (ex: `eclairage`, `volet`).

---

## 7. Règles Spécifiques aux Récepteurs

### 7.1 Récepteurs Logiques
- **Format** : `recepteur_<numéro>` (ex: `recepteur_001`).
- **QUOI déterminé par** :
  1. `quoi` **explicite** dans la configuration (si présent).
  2. **Type du récepteur** (ex: `light` → `eclairage`, `switch` → `interrupteur`, `cover` → `volet`).
  3. **Type des émetteurs appairés** (si `quoi` non défini).
     - Exemple : Si tous les émetteurs appairés sont de type `Lighting2`, alors QUOI = `eclairage`.
  4. `non_classifie` (fallback).

### 7.2 Récepteurs avec `isDimmable: true`
- **QUOI forcé** : `eclairage` (même si le récepteur est de type `switch`).
- **Implication** : L'émetteur primaire peut envoyer des commandes de **variation** (`set_level`).

### 7.3 Récepteurs Multi-QUOI
- Un récepteur peut appartenir à **plusieurs QUOI** si :
  - Il est contrôlé par des émetteurs de types différents (ex: `Lighting2` + `Lighting4`).
  - Sa configuration le spécifie explicitement (ex: `quoi: ["eclairage", "interrupteur"]`).
- **Exemple** :
  ```yaml
  recepteur_001:
    name: "Lumière Salon"
    quoi: ["eclairage", "interrupteur"]  # Multi-QUOI
    emitters:
      - "lighting2_0x02b3"  # Bouton (QUOI: bouton)
      - "lighting1_0x01a2"  # Interrupteur (QUOI: interrupteur)
  ```

---

## 8. Gestion des Conflits

### 8.1 Conflit entre `subType` et `device_class`
- **Règle** : `subType` RFXCOM a **priorité absolue** sur `device_class` HA.
- **Exemple** :
  ```
  Entité avec :
    attributes.subType = "Temperature"
    device_class = "humidity"
  → QUOI: "température" (priorité à subType)
  ```

### 8.2 Conflit entre `type` RFXCOM et `domain` HA
- **Règle** : `type` RFXCOM a priorité sur `domain` HA.
- **Exemple** :
  ```
  Entité avec :
    attributes.type = "RFXSensor"
    domain = "switch"
  → QUOI: "capteurs" (via mapping type → capteurs)
  ```

### 8.3 Conflit entre QUOI du Récepteur et des Émetteurs
- **Règle** : Le QUOI du **récepteur** prime sur celui des émetteurs.
- **Exemple** :
  ```yaml
  recepteur_001:
    quoi: "eclairage"  # QUOI du récepteur
    emitters:
      - "lighting2_0x02b3"  # QUOI: "bouton" (émetteur)
  → Le récepteur est classé comme "eclairage".
  ```

---

## 9. Exemples Concrets

### 9.1 Capteur de Température RFXSensor
```yaml
# Dans config-rfxcom-devices-v1.0.yaml
rfxsensor_0xa5b3:
  sensorId: "0xA5B3"
  type: "RFXSensor"
  subType: "Temperature"
  name: "Température---Salon"
  protocole: "rfxsensor"
```
**Classification :**
1. `subType = "Temperature"` → Mapping RFXCOM → QUOI: `"température"`
2. Résultat : `quoi_ids: ["température"]`
3. entity_id HA : `sensor.rfxsensor_0xa5b3`

### 9.2 Émetteur Lighting2 Appairé à un Récepteur Dimmable
```yaml
# Dans config-rfxcom-devices-v1.0.yaml
lighting2_0x02b3:
  sensorId: "0x02B3"
  type: "Lighting2"
  subType: "AC"
  name: "Bouton---Salon"
  protocole: "lighting2"

recepteur_001:
  id: "recepteur_001"
  name: "Lumière Salon"
  primaryEmitter: "lighting2_0x02b3"
  emitters:
    - "lighting2_0x02b3"
  isDimmable: true
  type: "light"
```
**Classification :**
- **Émetteur** (`lighting2_0x02b3`) :
  1. `subType = "AC"` → QUOI: `"bouton"`
- **Récepteur** (`recepteur_001`) :
  1. `isDimmable: true` → QUOI forcé: `"eclairage"`
  2. `type = "light"` → Confirme QUOI: `"eclairage"`

### 9.3 Compteur de Courant RFXMeter
```yaml
rfxmeter_0xb2c3:
  sensorId: "0xB2C3"
  type: "RFXMeter"
  subType: "Current"
  name: "Courant---Tableau"
  protocole: "rfxmeter"
```
**Classification :**
1. `subType = "Current"` → QUOI: `"courant"`
2. Résultat : `quoi_ids: ["courant"]`
3. entity_id HA : `sensor.rfxmeter_0xb2c3`

### 9.4 Récepteur Multi-QUOI
```yaml
recepteur_002:
  id: "recepteur_002"
  name: "Lumière Cuisine"
  quoi: ["eclairage", "interrupteur"]
  emitters:
    - "lighting2_0x1001"  # Bouton
    - "lighting1_0x01a2"  # Interrupteur
```
**Classification :**
- QUOI: `["eclairage", "interrupteur"]` (multi-QUOI)

---

## 10. Intégration avec `HaStructureRegistry`

### 10.1 Flux de Classification
```
HaStructureRegistry.initialize()
  → Pour chaque entité :
    1. Récupérer les attributes (subType, type, etc.)
    2. Appeler HaClassifier.classify(entity)
    3. Appliquer les règles RFXCOM (si entité RFXCOM) ou générales
    4. Assigner quoi_ids[] à l'entité structurée
    5. Ajouter l'entité à Area → QUOI → Entités
```

### 10.2 Injection du Classifieur
Dans `index.ts` (bootstrap) :
```typescript
const haClassifier = new HaClassifier(); // Utilise les règles générales + RFXCOM
const haStructureRegistry = new HaStructureRegistry(haClassifier, config, logger);
```

### 10.3 Tests de Classification
Voir [`src/ha/sync/__tests__/HaClassifier.test.ts`](src/ha/sync/__tests__/HaClassifier.test.ts) pour les tests unitaires.

---

## 11. Évolutivité

### 11.1 Ajout de Nouveaux `subType` RFXCOM
- **Processus** :
  1. Ajouter le `subType` dans le tableau `RFXCOM_SUBTYPE_TO_QUOI` (code).
  2. Mettre à jour ce document (§4) avec le nouveau mapping.
  3. Versionner la mise à jour (ex: `specs-classification-rfxcom-v1.1.md`).

### 11.2 Priorité des Mappings
- **Ordre immuable** : `subType` > `type` > `device_class` > `domain` > `entity_id`.
- **Ne pas modifier** cet ordre sans créer une nouvelle version des specs.

---

## 12. Annexes

### 12.1 Références
- [`specs-techniques-socle-ha-mqtt-v4.3.md`](specs-techniques-socle-ha-mqtt-v4.3.md) (architecture 5 couches)
- [`spec-nommage-v1.0.md`](spec-nommage-v1.0.md) (définition du QUOI)
- [`specs-fonctionnelles-rfxcom-v5.0.md`](specs-fonctionnelles-rfxcom-v5.0.md) (spécifications RFXCOM)

### 12.2 Glossaire
| Terme | Définition |
|-------|------------|
| QUOI | Type fonctionnel pur (ex: "Température", "Éclairage") |
| subType | Type spécifique RFXCOM (ex: "Temperature", "Humidity") |
| type | Type général RFXCOM (ex: "RFXSensor", "Lighting2") |
| HaClassifier | Module de classification des entités HA |
| RFXCOM | Protocole de communication RF 433 MHz |

### 12.3 Historique des Versions
| Version | Date | Auteur | Modifications |
|---------|------|--------|---------------|
| 1.0 | 11 Juillet 2026 | - | Création initiale |

---

*Document conforme à specs-techniques-socle-ha-mqtt-v4.3.md et specs-fonctionnelles-rfxcom-v5.0.md.*
