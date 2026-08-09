# Spécifications Fonctionnelles - Récepteurs et Émetteurs RFXCOM

*Version 5.4 - 3 Août 2026*
*Complément aux [spécifications principales](fonctionnelles-rfxcom_specs_v5.10.md)*
*Conforme à [spec-nommage-v1.0.md](spec-nommage-v1.0.md) et [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.19.md)*

> **v5.4** : **Rattrapage complet code/specs**, en écho au rattrapage de
> `fonctionnelles-rfxcom_specs_v5.10.md`. Corrections principales :
> - **§2.2, §7, §9** : format réel du `uniqueId`/`deviceId`
>   (`{protocole}_{subType}_{sensorId}[_{unitCode}]`), pas `{protocole}_{sensorId}`.
> - **§4.3 (nouveau)** : réponse **définitive** à la question laissée ouverte dans les sessions
>   précédentes — `lastOn`/`lastLevel` **sont bien écrits** dans le fichier YAML à chaque
>   changement d'état, mais **ne sont PAS déclarés au schéma Zod** des devices/récepteurs, et sont
>   donc silencieusement supprimés à chaque rechargement (`z.object()` en mode `strip` par défaut).
>   C'est la cause racine, désormais documentée avec preuve, de la rafale de commandes OFF à
>   chaque redémarrage.
> - **§4.4 (nouveau)** : asymétrie `primaryEmitter`/`emitters[]` — un récepteur n'écoute **pas**
>   automatiquement en écho son propre `primaryEmitter` (seul `emitters[]` est consulté), d'où la
>   nécessité d'une mise à jour explicite de l'état après une commande HA→RFXCOM.
> - **§8.5.2** : correction du slash initial erroné sur tous les topics (`rfxcom/...`, pas
>   `/rfxcom/...`) — la même erreur avait déjà été corrigée dans `techniques-socle-ha-mqtt_specs`
>   v4.16 pour le format générique, mais jamais répercutée dans les exemples spécifiques à RFXCOM
>   de ce document.
> - **§7.3 (nouveau)** : détail complet de la découverte de scène (`device_automation`), incluant
>   les clés `type`/`subtype` requises par HA (absentes de la v5.3), découvertes lors des tests en
>   conditions réelles.
> - **§5.3** : schéma Zod réel (`devices-config-schema.ts`), avec toutes les divergences vs la
>   version précédemment documentée (types enum réels à 8 valeurs, `transmitToHa` sur
>   devices/récepteurs, contrainte d'unicité `receiverId`).
> - **§2.2** : `receiverId` est un identifiant à base de timestamp (`recepteur_1000890`), pas une
>   séquence `001`/`002`.

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Référentiel de Nommage](#2-référentiel-de-nommage)
3. [Définitions Clés](#3-définitions-clés)
4. [Architecture Récepteurs ↔ Émetteurs](#4-architecture-récepteurs--émetteurs)
5. [Fichier de Configuration Centralisé](#5-fichier-de-configuration-centralisé)
6. [Modules Dédiés](#6-modules-dédiés)
7. [MQTT Discovery](#7-mqtt-discovery)
8. [Flux de Données](#8-flux-de-données)
9. [Exemples Complets](#9-exemples-complets)
10. [Types TypeScript](#10-types-typescript)
11. [Intégration Interface Web](#11-intégration-interface-web)
12. [Annexes](#12-annexes)

---

## 1. Introduction

### 1.1 Objectif
Ce document **complète** les [spécifications principales](fonctionnelles-rfxcom_specs_v5.10.md) en
détaillant la gestion des **récepteurs logiques** et **émetteurs physiques RFXCOM**.

### 1.2 Périmètre
| Inclus | Exclus |
|--------|--------|
| Récepteurs déclarés via fichier YAML | Gestion matériel RFXCOM |
| Émetteurs (devices Lighting1/2/4/5/6) | Implémentation bas niveau de la bibliothèque `rfxcom` |
| Appairage émetteurs ↔ récepteurs (N↔N) | — |
| Scènes (SceneManager/SceneExecutor) | — |

### 1.3 Public Cible
- Développeurs implémentant RFXCOM
- Intégrateurs Home Assistant
- Mainteneurs du socle HA-MQTT

### 1.4 Conformité
- [spec-nommage-v1.0.md](spec-nommage-v1.0.md) (format `quoi---ou--ou`)
- [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.19.md) (architecture 5 couches)
- [fonctionnelles-rfxcom_specs](fonctionnelles-rfxcom_specs_v5.10.md) (spécifications principales)

---

## 2. Référentiel de Nommage

### 2.1 Format du `name` (Obligatoire)
```
quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
```

### 2.2 Nommage Technique (réel — corrigé v5.4)

**Pour TOUS les devices RFXCOM (capteurs ET émetteurs) :**
```
<protocole>_<subType>_<sensorId>[_<unitCode>]
```

| Type | Protocole | subType | sensorId | unitCode | `uniqueId` |
|------|-----------|---------|----------|----------|------------|
| RFXSensor Temperature | `rfxsensor` | `temperature` | `0xa5b3` | — | `rfxsensor_temperature_0xa5b3` |
| RFXMeter Current | `rfxmeter` | `current` | `0xb2c3` | — | `rfxmeter_current_0xb2c3` |
| Lighting1 | `lighting1` | `x10` | `0x01a2` | — | `lighting1_x10_0x01a2` |
| Lighting2 | `lighting2` | `ac` | `0x02be2c02` | `13` | `lighting2_ac_0x02be2c02_13` |
| Lighting4 | `lighting4` | `pt2262` | `0x1001` | — | `lighting4_pt2262_0x1001` |

Le `subType` et le `unitCode` sont **nécessaires** à l'unicité — voir
`fonctionnelles-rfxcom_specs` §2.2 pour la justification complète (un TH9 envoie Temperature et
Humidity sous le même `sensorId`, une télécommande multi-boutons envoie plusieurs `unitCode` sous
le même `sensorId`).

**Pour les récepteurs logiques :**
```
recepteur_<timestamp>
```
**Pas** une séquence `001`/`002` — un identifiant généré à la création, du type `recepteur_1000890`
(observé en production). Idem pour les scènes : `scene_<timestamp>`.

> ✅ **Garantie d'unicité** : combinaison protocole+subType+sensorId(+unitCode), ou timestamp de
> création pour les récepteurs/scènes.

### 2.3 QUOI = Type Fonctionnel Pur ⭐

| SubType/Type RFXCOM | QUOI (auto-déterminé) | Exemple name complet |
|----------------|----------------------|----------------------|
| Temperature | **Température** | `Température---Salon` |
| Humidity | **Humidité** | `Humidité---Cuisine` |
| Current/Power | **Courant/Puissance** | `Courant---Tableau` |
| Motion (heuristique) | **Mouvement** | `Mouvement---Couloir` |
| Contact (heuristique) | **Contact** | `Contact---Entrée` |
| Lighting1 | **Interrupteur** | `Interrupteur---Salon` |
| Lighting2 | **Bouton** | `Bouton---Salon` |
| Lighting4 | **Télécommande** | `Télécommande---Salon` |
| Lighting5, Lighting6 | **Interrupteur** | `Interrupteur---Salon` |
| Blinds1 | **Volet** | `Volet---Salon` |

> ⚠️ `Curtain1`/`Blind1` (documentés jusqu'à v5.3 dans `SUBTYPE_TO_QUOI`) n'existent pas dans le
> code réel — seul `Blinds1` (récepteur `cover`) est géré, voir `fonctionnelles-rfxcom_specs` §4.4.

### 2.4 Règle de Transmission vers HA

**⭐ Depuis v5.4 (application) — remplace la règle QUOI/OÙ documentée jusqu'à v5.3 de ce document** :
les données ne sont transmissibles vers HA **que si** `transmitToHa: true` est coché pour ce
device/récepteur/scène (case à cocher dans les fenêtres modales) — voir
`fonctionnelles-rfxcom_specs` §9.1.

---

## 3. Définitions Clés

### 3.1 Terminologie

| Terme | Définition | Type HA | Nom Technique |
|-------|------------|---------|---------------|
| **Device RFXCOM** | Appareil **physique** RFXCOM (capteur OU émetteur) | variable | `<protocole>_<subType>_<sensorId>[_<unitCode>]` |
| **Émetteur** | Device **Lighting1/2/4/5/6** qui **émet** des signaux RF433 | **binary_sensor** (par défaut) | idem |
| **Récepteur** | Entité **logique** déclarée dans le fichier YAML, **associée à des émetteurs** | switch, light, cover | `recepteur_<timestamp>` |
| **Scène** | Entité logique orchestrant plusieurs récepteurs | `device_automation` (déclencheur) | `scene_<timestamp>` |
| **primaryEmitter** | **Émetteur principal** d'un récepteur, utilisé pour envoyer les commandes RF433 | - | - |
| **Appairage** | Lien entre émetteur et récepteur (**N↔N**), stocké dans `rfxcom_receivers[].emitters[]` | - | - |

### 3.2 Règles Fondamentales

1. **unique_id contient TOUJOURS protocole+subType+sensorId(+unitCode)** pour TOUS les devices
2. **QUOI = type fonctionnel pur** : "Température", "Humidité", "Courant", "Bouton" (PAS "Température Salon")
3. **QUOI auto-déterminé** depuis type/subType RFXCOM
4. **Émetteurs Lighting = binary_sensor par défaut** : ils émettent on/off
5. **Appairages dans le fichier YAML** : chaque récepteur contient sa liste d'émetteurs dans `emitters[]`
6. **primaryEmitter obligatoire** (récepteurs commandables) : détermine le device RFXCOM cible pour les commandes HA
7. **Relations N↔N**, avec une asymétrie importante — voir §4.4
8. **Lighting2 variateur** : l'information "variateur" vient **exclusivement** de `isDimmable`

---

## 4. Architecture Récepteurs ↔ Émetteurs

### 4.1 Modèle Conceptuel (5 Couches)
```
┌─────────────────────────────────────────────────────────────────┐
│              COUCHE PRÉSENTATION (UI Web + Socket.io)            │
├─────────────────────────────────────────────────────────────────┤
│              COUCHE APPLICATION (EventBus + SocketBridge)        │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE MÉTIER                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    RfxComService                            │  │
│  │  ┌─────────────────┐       ┌─────────────────────────────┐  │  │
│  │  │   ÉMETTEURS      │       │      RÉCEPTEURS              │  │  │
│  │  │ (Lighting1/2/4/5/6)│      │   (logiques)                 │  │  │
│  │  │  binary_sensor   │◄──────►│ switch/light/cover           │  │  │
│  │  └─────────────────┘  N↔N    │  + primaryEmitter + emitters[]│  │  │
│  │                                │  (asymétriques, voir §4.4)   │  │  │
│  │                                └─────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────┐    │  │
│  │  │  ReceiverManager → ReceiverSwitch/ReceiverLight/ReceiverCover │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  │  ┌─────────────────────────────────────────────────────┐    │  │
│  │  │        SceneManager (registre) ⇄ SceneExecutor        │    │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  └────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│           COUCHE HA (HaMqttIntegrationService + EventBus)        │
├─────────────────────────────────────────────────────────────────┤
│         COUCHE INFRASTRUCTURE (ConfigService + MqttTransport)     │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Mapping N↔N (Appairages)

```typescript
// Structure d'un récepteur avec ses émetteurs associés
interface BaseReceiverConfig {
  receiverId: string;
  name: string;
  primaryEmitter: string;
  emitters: AssociatedEmitter[];
  transmitToHa: boolean;
}

interface AssociatedEmitter {
  emitterId: string;
  action: 'toggle' | 'on' | 'off' | 'set_level' | 'open' | 'close' | 'stop';  // enum strict, pas string libre
}
```

**Exemple de mapping dans le fichier YAML :**
```yaml
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
      - emitterId: "lighting2_ac_0x02be2c02_14"
        action: "set_level"
    transmitToHa: true
```

### 4.3 ⭐ Persistance de `lastOn`/`lastLevel` — réponse définitive (nouveau v5.4)

Une question laissée ouverte dans des sessions précédentes ("`lastOn` est-il jamais persisté ?")
a désormais une réponse **vérifiée et définitive** :

- **`ReceiverSwitch.applyEmitterCommand`** et **`ReceiverLight.applyEmitterCommand`** mettent bien
  à jour `this.config.lastOn` (et `lastLevel` pour Light) à chaque commande appliquée, et le
  fichier est bien réécrit (`ConfigFileManager.save()`) — **ces valeurs sont bien présentes dans le
  YAML sur disque**, vérifié directement sur l'installation de référence.
- **Mais** `lastOn`/`lastLevel` **ne sont pas déclarés** dans `devices-config-schema.ts`
  (`baseReceiverFields`, `ReceiverSwitchConfig`, `ReceiverLightConfig`) — seulement dans le type
  TypeScript `types.ts`. Or `ConfigFileManager.load()` retourne le résultat de
  `schema.parse(...)`, et Zod **supprime silencieusement** (mode `strip`, comportement par défaut
  de `z.object()`) tout champ non déclaré au schéma.
- **Conséquence** : à chaque redémarrage, `receiver.config.lastOn` est relu comme `undefined`,
  quelle que soit la valeur réellement écrite juste avant l'arrêt. C'est la cause racine
  (désormais confirmée) de la rafale de commandes OFF envoyée à **tous** les récepteurs à chaque
  démarrage — voir `fonctionnelles-rfxcom_specs` §9.1/§20 et `implementation-rfxcom_specs` §8.1
  pour le détail technique complet du mécanisme de perte.
- **`ReceiverCover`** n'a de toute façon **aucun** champ `lastOn`/`lastLevel` équivalent — sa
  position est recalculée à partir du temps écoulé et perdue à chaque redémarrage par conception.

> Non corrigé à ce jour. Corriger nécessiterait d'ajouter ces champs (et `lastValue`,
> `commandDeviceId`, côté devices) au schéma Zod — voir Roadmap de `fonctionnelles-rfxcom_specs`.

### 4.4 ⭐ Asymétrie `primaryEmitter` / `emitters[]` (nouveau v5.4)

**`ReceiverManager.findReceiversForEmitter()` ne recherche que dans `emitters[]`, jamais dans
`primaryEmitter` lui-même.** Concrètement : un émetteur qui n'est référencé que comme
`primaryEmitter` d'un récepteur (et absent de `emitters[]`) ne redéclenche **jamais** ce récepteur
en écho lorsqu'il émet un message RF433 — y compris après une commande HA→RFXCOM envoyée via ce
même `primaryEmitter`.

C'est pourquoi le chemin HA→récepteur (§8.3) **doit** mettre à jour explicitement l'état interne
(et donc `lastOn`/`lastLevel`, voir §4.3) après avoir envoyé une commande — il ne peut pas compter
sur un écho RF433 en retour, contrairement à ce qu'on pourrait supposer d'une architecture purement
événementielle. Vérifié en conditions réelles (30/07/2026) : sans cet appel explicite, `lastOn`
restait absent du YAML après un OFF réellement envoyé et reçu par le device physique.

**Recommandation pratique** : si un `primaryEmitter` doit aussi réagir en écho à ses propres
émissions RF433 (ex: bouton physique qui commande également son propre récepteur), il doit être
**également** ajouté à `emitters[]`, pas seulement désigné comme `primaryEmitter`.

---

## 5. Fichier de Configuration Centralisé

### 5.1 `config-rfxcom-devices-v1.0.yaml`

**Structure complète (identifiants réels) :**

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
    lastSeen: "2026-08-03T10:15:00.000Z"

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

  recepteur_1000901:
    receiverId: "recepteur_1000901"
    name: "Volet---Fenêtre--Cuisine"
    type: "cover"
    coverType: "blinds1"
    primaryEmitter: "blinds1_lincoln_0x03c4"
    openTimeSec: 25
    closeTimeSec: 20
    emitters:
      - emitterId: "blinds1_lincoln_0x03c4"
        action: "open"
    transmitToHa: true

  scene_1000851:
    receiverId: "scene_1000851"
    type: "scene"
    sceneType: "parallel"
    delayBetweenCommands: 0
    actions: []
    transmitToHa: true
```

### 5.2 Règles du Fichier

| Règle | Description |
|-------|-------------|
| **Format** | YAML strict |
| **Chargement** | Au démarrage du service RFXCOM |
| **Sauvegarde** | À chaque modification (via UI) |
| **Validation** | Schéma Zod obligatoire, **résultat filtré effectivement utilisé au chargement** — voir §4.3 pour la conséquence sur `lastOn`/`lastLevel` |

### 5.3 Schéma de Validation Zod (réel — `devices-config-schema.ts`)

```typescript
// Type de device — 8 valeurs réelles (pas 5)
const rfxComDeviceTypeSchema = z.enum([
  'RFXSensor', 'RFXMeter', 'Lighting1', 'Lighting2', 'Lighting4', 'Lighting5', 'Lighting6', 'Blinds1',
]);

const rfxComDeviceSchema = z.object({
  uniqueId: z.string(),
  sensorId: z.string(),
  type: rfxComDeviceTypeSchema,
  subType: z.string(),
  protocole: z.string(),
  name: z.string(),
  defaultQuoi: z.string(),
  transmitToHa: z.boolean().default(false),
  unitCode: z.number().optional(),
  lastSeen: z.string().optional(),
  // ⚠️ lastValue et commandDeviceId existent côté TS (types.ts) mais PAS ici — strippés au rechargement, voir §4.3
});

const associatedEmitterSchema = z.object({
  emitterId: z.string(),
  action: z.enum(['toggle', 'on', 'off', 'set_level', 'open', 'close', 'stop']),
});

const baseReceiverFields = {
  receiverId: z.string(),
  name: z.string(),
  primaryEmitter: z.string(),
  emitters: z.array(associatedEmitterSchema).default([]),
  transmitToHa: z.boolean().default(false),
  // ⚠️ lastOn/lastLevel existent côté TS (types.ts) mais PAS ici — strippés au rechargement, voir §4.3
};

const receiverSwitchConfigSchema = z.object({ ...baseReceiverFields, type: z.literal('switch') });
const receiverLightConfigSchema = z.object({
  ...baseReceiverFields, type: z.literal('light'),
  isDimmable: z.boolean().default(false),
});
const receiverCoverConfigSchema = z.object({
  ...baseReceiverFields, type: z.literal('cover'),
  coverType: z.enum(['blinds1', /* ... 6 valeurs au total */]),
  openTimeSec: z.number().positive(),
  closeTimeSec: z.number().positive(),
});

// ⭐ La scène n'a NI primaryEmitter NI emitters (confirmé, inchangé depuis v5.2)
const sceneActionSchema = z.object({
  target: z.string(), command: z.string(), value: z.number().optional(), delayMs: z.number().optional(),
});
const receiverSceneConfigSchema = z.object({
  receiverId: z.string(), name: z.string(), type: z.literal('scene'), transmitToHa: z.boolean().default(false),
  sceneType: z.enum(['parallel', 'sequential']).default('sequential'),
  delayBetweenCommands: z.number().default(500),
  actions: z.array(sceneActionSchema).min(1),
});

// Schéma complet du fichier, avec contrainte d'unicité des receiverId (nouveau, non documenté avant v5.4)
const rfxComDevicesConfigSchema = z.object({
  rfxcom_devices: z.record(rfxComDeviceSchema),
  rfxcom_receivers: z.record(z.discriminatedUnion('type', [
    receiverSwitchConfigSchema, receiverLightConfigSchema, receiverCoverConfigSchema, receiverSceneConfigSchema,
  ])),
}).refine(/* unicité des receiverId à travers rfxcom_receivers */);
```

---

## 6. Modules Dédiés

### 6.1 Architecture Modulaire

Les scènes ne sont **pas** un 4ème `IReceiverModule`. `ReceiverManager` ne charge que
switch/light/cover (il ignore explicitement `type: 'scene'` lors du chargement) ; les scènes sont
gérées par `SceneManager` (registre CRUD) + `SceneExecutor` (exécution parallel/sequential), qui
**réutilisent** `ReceiverManager` pour appliquer chaque commande de scène à son récepteur cible.

```
                        RfxComService
                  (Gestion centrale)
          ┌───────────────────────────┼───────────────────────────┐
          v                           v                           v
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│    ReceiverSwitch     │   │    ReceiverLight      │   │    ReceiverCover      │
│    (pour switch)      │   │    (pour light)       │   │    (pour cover)       │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
          ▲                           ▲                           ▲
          └───────────────────────────┼───────────────────────────┘
                                       │ commande sur le récepteur cible
                     ┌─────────────────────────┐      ┌──────────────────┐
                     │      SceneManager        │◄────►│  SceneExecutor   │
                     │  (registre CRUD scènes)  │      │ (parallel/sequential) │
                     └─────────────────────────┘      └──────────────────┘
```

### 6.2 Interface Commune (réelle)

**Fichier** : `receivers/BaseReceiver.ts`

```typescript
interface IReceiverModule {
  readonly config: CommandableReceiverConfig;
  translateHaCommand(command: string, value?: number): ReceiverCommandResult;
  applyEmitterCommand(action: string, value?: number): void;
  getState(): Record<string, unknown>;
  getDiscoveryEssential(): EssentialEntityData;
}

interface ReceiverCommandResult {
  action: string;
  value?: number;
}
```

Interface **synchrone** (pas de `Promise`) — `config` est injecté par le constructeur, pas par une
méthode `initialize()` séparée. `RfxComService` orchestre l'appel à `translateHaCommand()` puis
l'envoi RF433 et la publication d'état ; le module ne publie pas lui-même vers MQTT.
`CommandableReceiverConfig` = switch/light/cover uniquement (§10) : les scènes ne l'implémentent
pas.

### 6.3 ReceiverLight (avec variateur)

```typescript
interface ReceiverLightConfig extends BaseReceiverConfig {
  type: 'light';
  isDimmable: boolean;
  lastOn?: boolean;    // ⚠️ jamais relu après redémarrage, voir §4.3
  lastLevel?: number;  // ⚠️ idem
}
```

- **`isDimmable: true`** : accepte on/off/toggle/**set_level** (échelle native 0-15, voir
  `implementation-rfxcom_specs` §6.3).
- **`isDimmable: false`** : comportement simple switch.

### 6.4 ReceiverSwitch

```typescript
interface ReceiverSwitchConfig extends BaseReceiverConfig {
  type: 'switch';
  lastOn?: boolean;   // ⚠️ jamais relu après redémarrage, voir §4.3
}
```
**Commandes :** on, off, toggle.

### 6.5 ReceiverCover (avec délais)

```typescript
interface ReceiverCoverConfig extends BaseReceiverConfig {
  type: 'cover';
  coverType: 'blinds1';   // ⚠️ une seule valeur gérée en pratique (voir §7 de fonctionnelles-rfxcom_specs)
  openTimeSec: number;    // OBLIGATOIRE
  closeTimeSec: number;   // OBLIGATOIRE
}
```
**Commandes :** open, close, stop (pas de `set_position` — non implémenté). Position recalculée à
partir du temps écoulé, **jamais persistée** (pas de champ `lastPosition`).

---

## 7. MQTT Discovery

### 7.1 Discovery pour Device RFXCOM (Capteur ou Émetteur) — corrigé v5.4

```json
{
  "name": "{{ taxonomy.raw_quoi }}",
  "unique_id": "{{ protocole }}_{{ subType }}_{{ sensorId }}",
  "~": "homeassistant/{{ component }}/{{ protocole }}_{{ subType }}_{{ sensorId }}",
  "state_topic": "rfxcom/{{ bridgeInstance }}/{{ deviceId }}/state",
  "value_template": "{{ '{{ value_json.state }}' }}",
  "json_attributes_topic": "homeassistant/{{ component }}/{{ protocole }}_{{ subType }}_{{ sensorId }}/attributs",
  "device": {
    "identifiers": ["{{ protocole }}_{{ subType }}_{{ sensorId }}"],
    "name": "RFXCOM {{ type }} {{ subType }}",
    "manufacturer": "RFXCOM",
    "model": "{{ protocole | uppercase }}",
    "suggested_area": "{{ taxonomy.nom_lieu }}"
  }
}
```

> Le payload d'état ne contient que `{"state": "ON"}` (+ `signal_level`/`battery_level` en
> attributs HA standard, séparés) — **aucune clé `attributs_taxonomie` en clair** dans ce message,
> voir `fonctionnelles-rfxcom_specs` §2.6 pour le topic dédié.

**Exemple Lighting2 (Émetteur = binary_sensor), bridge `rfx_bridge_0001` :**
```json
{
  "name": "Bouton",
  "unique_id": "lighting2_ac_0x02be2c02_13",
  "component": "binary_sensor",
  "entity_category": "diagnostic",
  "state_topic": "rfxcom/rfx_bridge_0001/lighting2_ac__0x02be2c02_13/state",
  "device": {
    "identifiers": ["lighting2_ac_0x02be2c02_13"],
    "name": "RFXCOM Lighting2 AC",
    "manufacturer": "RFXCOM",
    "model": "LIGHTING2",
    "suggested_area": "Salon"
  },
  "payload_on": "ON",
  "payload_off": "OFF"
}
```

### 7.2 Discovery pour Récepteur

**Récepteur de type light (avec variateur), bridge `rfx_bridge_0001` :**
```json
{
  "name": "Lumière",
  "unique_id": "recepteur_1000890",
  "component": "light",
  "state_value_template": "{{ '{{ value_json.state }}' }}",
  "device": {
    "identifiers": ["recepteur_1000890"],
    "name": "Lumière",
    "manufacturer": "RFXCOM",
    "model": "ReceiverLight",
    "suggested_area": "Salon"
  },
  "command_topic": "rfxcom/rfx_bridge_0001/recepteur_1000890/set",
  "state_topic": "rfxcom/rfx_bridge_0001/recepteur_1000890/state",
  "payload_on": "ON",
  "payload_off": "OFF"
}
```

> ⚠️ **Le composant `light` attend `state_value_template`, pas `value_template`** — distinction
> vérifiée contre une instance HA réelle, absente de toute version précédente de ce document. Les
> autres composants (switch/cover/sensor) utilisent `value_template`.
>
> Pour un récepteur logique, `deviceId` = son `receiverId` directement (pas de décomposition
> protocole/sous-protocole, un récepteur pouvant agréger plusieurs émetteurs).

### 7.3 ⭐ Discovery pour Scène (nouveau détail v5.4)

Publiée comme `device_automation` (déclencheur, pas d'état/entité classique) :

```json
{
  "name": "Soirée",
  "unique_id": "rfxcom_scene_1000851",
  "automation_type": "trigger",
  "type": "scene_executed",
  "subtype": "1000851",
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
> l'erreur HA "required key not provided @ data['type']", découverte en conditions réelles et
> corrigée depuis ; **absents de la v5.3 de ce document**. `subtype` porte le `receiverId` de la
> scène (sans le préfixe `scene_`).
>
> **Pas de topic d'attributs de taxonomie pour les scènes** : `device_automation` est un
> déclencheur, sans équivalent HA à `json_attributes_topic` — voir `fonctionnelles-rfxcom_specs`
> §15.3.3.
>
> Attention à ne pas confondre l'`objectId` de découverte (`rfxcom_scene_{sceneId}`, `sceneId`
> **sans** préfixe) et le `deviceId` d'état/commande (`scene_{sceneId}`).

---

## 8. Flux de Données

### 8.1 Initialisation

```
Démarrage
  → PortDetector.detect() puis fallback config.port
  → ConfigFileManager.load() (config-rfxcom-devices-v1.0.yaml)
  → DeviceManager.loadConfigured() / ReceiverManager.loadReceivers() / SceneManager.loadScenes()
  → Création du verrou protocolsPushGate (voir fonctionnelles-rfxcom_specs §8.3)
  → Connexion transceiver
  → Push protocoles matériel (résout le verrou)
  → publishInitialDiscoveries() (devices, récepteurs, scènes avec transmitToHa: true)
```
Voir `fonctionnelles-rfxcom_specs` §8.3/§11.1 et `implementation-rfxcom_specs` §11.1 pour le détail
complet et l'ordre exact.

### 8.2 Traitement Message RF433 (Émetteur)

```
Message RF433 reçu
  → RfxComTransceiver normalise (type/subType/sensorId/unitCode)
  → DeviceManager construit l'emitterId (protocole_subType_sensorId[_unitCode])
  → ReceiverManager.findReceiversForEmitter(emitterId) — recherche UNIQUEMENT dans emitters[] (§4.4)
  → Pour chaque récepteur trouvé : applyEmitterCommand(action, value?) puis persistance (§4.3)
  → Si emitterId inconnu de rfxcom_devices : ajout automatique (transmitToHa: false par défaut)
```

### 8.3 Traitement Commande MQTT (HA → Récepteur → Device RFXCOM)

```
Commande MQTT reçue (topic .../set)
  → RfxComService résout le récepteur cible depuis le deviceId
  → Récupère primaryEmitter (PAS via emitters[], voir §4.4)
  → module.translateHaCommand(command, value?) → { action, value? }
  → RfxComTransceiver envoie la trame RF433 au device du primaryEmitter
  → Mise à jour EXPLICITE de l'état interne + lastOn/lastLevel (pas d'écho automatique, §4.4)
  → Publication de l'état MQTT du récepteur
```

### 8.4 Événements EventBus Spécifiques à RFXCOM

Voir `fonctionnelles-rfxcom_specs` §12.3 pour la liste complète et à jour des événements
Socket.io réellement implémentés (server↔client). Côté EventBus interne (module↔application), les
événements utilisés sont `integration:rfxcom:command` (HA→app), `integration:rfxcom:bridge:connection`
(statut bridge), `integration:bridge:register`/`:unregister` — génériques au socle, pas spécifiques
à un vocabulaire RFXCOM séparé comme documenté jusqu'à v5.3 (`rfxcom:device:detected`,
`rfxcom:receiver:command`, `rfxcom:appairage:*` en tant qu'événements EventBus n'existent pas ;
seuls leurs équivalents Socket.io existent, voir §11).

---

### 8.5 Topics MQTT Spécifiques à RFXCOM

#### 8.5.1 Encodage du `deviceId` RFXCOM

Pour un **device physique**, le `deviceId` utilisé dans les topics d'état/commande encode le
protocole complet :
```
{protocole}_{sousProtocole}__{sensorId}_{unitCode}
```
**Exemple complet :** `lighting2_ac__0x017340ca_10`

Pour un **récepteur logique**, `deviceId` = son `receiverId` directement.

> ⚠️ Ce `deviceId` est **distinct** de `unique_id`/`object_id` (`<protocole>_<subType>_<sensorId>`,
> voir §2.2) utilisé dans le topic de découverte HA.

#### 8.5.2 Topics d'État et de Commande (App ↔ HA) — ⭐ corrigé v5.4, plus de slash initial

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `rfxcom/{bridgeInstance}/{deviceId}/state` | App → HA | `{ "state": "ON"\|"OFF" }` | 0 | false |
| `rfxcom/{bridgeInstance}/{deviceId}/set` | HA → App | `{ "state": "ON"\|"OFF", "brightness"?: 0-255 }` | 1 | false |

> ⚠️ **Les exemples précédents de ce document (jusqu'à v5.3) portaient tous un `/` initial erroné**
> (`/rfxcom/...`) — un premier niveau de topic MQTT vide, non standard. Le format générique du
> socle avait déjà été corrigé dans `techniques-socle-ha-mqtt_specs` v4.16 (29/07/2026), mais cette
> correction n'avait jamais été répercutée dans les exemples spécifiques à RFXCOM de ce document.

#### 8.5.3 Topics de Découverte RFXCOM (App → HA)

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `homeassistant/{component}/{object_id}/config` | App → HA | Message de discovery (§7) | 1 | true |
| `homeassistant/{component}/{object_id}/attributs` | App → HA | `{"attributs_taxonomie": {...}}`, publié uniquement à la (re)découverte | 1 | true |

#### 8.5.4 LWT (Last Will and Testament)

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `rfxcom/{bridgeInstance}/status` | App → Broker | `"online"` / `"offline"` | 1 | true |

#### 8.5.5 Retrait de Découverte

Voir `fonctionnelles-rfxcom_specs` §17.3 — publication d'une chaîne vide retenue sur le topic de
découverte, à la désélection (`transmitToHa: true → false`) ou à la suppression.

---

## 9. Exemples Complets

### 9.1 Installation Résidentielle (identifiants réels)

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

  lighting2_ac_0x02be2c02_14:
    sensorId: "0x02BE2C02"
    unitCode: 14
    type: "Lighting2"
    subType: "AC"
    name: "Bouton---Cuisine"
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
      - emitterId: "lighting2_ac_0x02be2c02_14"
        action: "set_level"
    transmitToHa: true
```

**Comportement :**
- Appui sur `lighting2_ac_0x02be2c02_13` → `recepteur_1000890` toggle (car dans `emitters[]`)
- Appui sur `lighting2_ac_0x02be2c02_14` → `recepteur_1000890` passe au niveau configuré
- Commande HA `light.recepteur_1000890/set` → RF433 envoyé au `primaryEmitter`
  (`lighting2_ac_0x02be2c02_13`), état mis à jour explicitement (§4.4)
- Un appui sur le `primaryEmitter` **seul** (hors `emitters[]`) ne redéclencherait **pas** le
  récepteur — voir §4.4

---

## 10. Types TypeScript

**Fichiers réels** : `applications/rfxcom/src/domain/types.ts` (interfaces) et
`applications/rfxcom/src/domain/devices-config-schema.ts` (schéma Zod, §5.3) — **pas**
`src/domain/integrations/rfxcom/types-recepteurs.ts` comme documenté jusqu'à v5.3, chemin qui
n'existe pas.

```typescript
export type ReceiverType = 'switch' | 'light' | 'cover' | 'scene';
export type CoverType = 'blinds1';   // une seule valeur en pratique

export interface AssociatedEmitter {
  emitterId: string;
  action: 'toggle' | 'on' | 'off' | 'set_level' | 'open' | 'close' | 'stop';
}

export interface SceneAction {
  target: string;
  command: string;
  value?: number;
  delayMs?: number;
}

export interface BaseReceiverConfig {
  receiverId: string;
  name: string;
  primaryEmitter: string;
  emitters: AssociatedEmitter[];
  transmitToHa: boolean;
  icon?: string;
}

export interface ReceiverSwitchConfig extends BaseReceiverConfig {
  type: 'switch';
  lastOn?: boolean;        // ⚠️ non déclaré au schéma Zod, voir §4.3
}

export interface ReceiverLightConfig extends BaseReceiverConfig {
  type: 'light';
  isDimmable: boolean;
  lastOn?: boolean;        // ⚠️ idem
  lastLevel?: number;      // ⚠️ idem
}

export interface ReceiverCoverConfig extends BaseReceiverConfig {
  type: 'cover';
  coverType: CoverType;
  openTimeSec: number;
  closeTimeSec: number;
}

// Scène — ne dérive PAS de BaseReceiverConfig (inchangé depuis v5.2)
export interface ReceiverSceneConfig {
  receiverId: string;
  name: string;
  type: 'scene';
  transmitToHa: boolean;
  sceneType: 'parallel' | 'sequential';
  delayBetweenCommands: number;
  actions: SceneAction[];
}

export type CommandableReceiverConfig = ReceiverSwitchConfig | ReceiverLightConfig | ReceiverCoverConfig;
export type ReceiverConfig = CommandableReceiverConfig | ReceiverSceneConfig;

export interface RfxComDeviceInfo {
  uniqueId: string;          // <protocole>_<subType>_<sensorId>[_<unitCode>]
  sensorId: string;
  unitCode?: number;
  type: string;
  subType: string;
  defaultQuoi: string;
  name: string;
  protocole: string;
  transmitToHa: boolean;
  lastSeen?: string;
  // lastValue / commandDeviceId existent côté TS mais pas au schéma — voir §4.3
}

export interface RfxComDevicesConfigFile {
  rfxcom_devices: Record<string, RfxComDeviceInfo>;
  rfxcom_receivers: Record<string, ReceiverConfig>;
}
```

---

## 11. Intégration Interface Web

### 11.1 Données Exposées via Socket.io

Voir `fonctionnelles-rfxcom_specs` §12.3 pour la liste complète et exacte (server→client et
client→server) — ce document ne la duplique plus pour éviter toute divergence future ; seuls les
événements directement liés aux récepteurs/scènes sont rappelés ici :

```typescript
'rfxcom:receivers:list': { receivers: ReceiverConfig[] }
'rfxcom:receiver:create' / ':update' / ':delete'
'rfxcom:scenes:list': { scenes: ReceiverSceneConfig[] }
'rfxcom:scene:create' / ':update' / ':delete' / ':execute' / ':cancel'
'rfxcom:device:set_name': { uniqueId: string; name: string }
```

### 11.2 Workflow UI - Configuration Complète

**Étape 1 : Détection des devices** — inchangé, voir `fonctionnelles-rfxcom_specs` §13.5.

**Étape 2 : Configuration QUOI/OÙ pour un device**
```
Sélection d'un device → fenêtre modale, 5 champs séparés (Quoi/Lieu précis/Lieu/Père/Grand-père),
chacun avec sa propre icône de sauvegarde (💾). Recomposition côté serveur en un seul `name` avant
envoi de 'rfxcom:device:set_name' (contrat inchangé depuis v5.0).
```

**Étape 3 : Création Récepteur + primaryEmitter + Émetteurs**
```
"Créer Récepteur" → fenêtre modale :
  - receiverId auto-généré (timestamp, pas séquentiel — voir §2.2)
  - Taxonomie en 5 champs séparés
  - type (switch/light/cover)
  - primaryEmitter : liste déroulante à libellé lisible dérivé de la taxonomie (ex: "Bouton · Salon
    (lighting2_ac_0x02be2c02_13)"), pas le uniqueId brut seul
  - emitters : multi-sélection sur la même liste — ⚠️ penser à y inclure aussi le primaryEmitter
    si un écho de ses propres émissions RF433 est souhaité (voir §4.4)
  - isDimmable (light) / openTimeSec+closeTimeSec obligatoires (cover)
→ 'rfxcom:receiver:create' avec la config complète
```

---

## 12. Annexes

### 12.1 Checklist d'Implémentation
| Tâche | Statut |
|-------|--------|
| Auto-détermination QUOI depuis subType | ✅ |
| unique_id avec protocole+subType+sensorId(+unitCode) | ✅ |
| QUOI = type fonctionnel pur | ✅ |
| Lighting = binary_sensor par défaut | ✅ |
| Fichier YAML centralisé | ✅ |
| primaryEmitter dans chaque récepteur | ✅ |
| Liste des émetteurs appairés dans le récepteur | ✅ |
| Lighting2 variateur via configuration | ✅ |
| Types TypeScript complets | ✅ |
| Schéma Zod pour validation | ✅ (mais incomplet — voir §4.3) |
| Receiver{Switch,Light,Cover} | ✅ |
| Discovery MQTT (devices/récepteurs/scènes) | ✅ |
| Socket.io handlers | ✅ |
| Scènes (SceneManager/SceneExecutor + UI) | ✅ |
| Persistance fiable de `lastOn`/`lastLevel` au redémarrage | ❌ **non résolu**, voir §4.3 |

### 12.2 Conformité
- ✅ [spec-nommage-v1.0.md](spec-nommage-v1.0.md)
- ✅ [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.19.md)
- ✅ [fonctionnelles-rfxcom_specs](fonctionnelles-rfxcom_specs_v5.10.md)

### 12.3 Références
- [Spécifications Principales RFXCOM](fonctionnelles-rfxcom_specs_v5.10.md)
- [Spécifications Implémentation RFXCOM](implementation-rfxcom_specs_v1.3.md)
- [Spécification de Nommage **OBLIGATOIRE**](spec-nommage-v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.19.md) ⭐

### 12.4 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 → 4.0 | 2026-07-07 → 07-08 | Mistral Vibe | Version initiale, intégration nommage, corrections techniques |
| 5.0 | 2026-07-09 | Mistral Vibe | Fichier YAML centralisé, primaryEmitter, émetteurs dans récepteur |
| 5.1 | 2026-07-21 | Claude | Refonte topics MQTT §8.5 (bridge_instance, encodage deviceId) |
| 5.2 | 2026-07-21 | Claude | Implémentation réelle des Scènes, `ReceiverSceneConfig` ne dérive plus de `BaseReceiverConfig` |
| 5.3 | 2026-07-27 | Claude | Mise à jour du workflow UI (taxonomie 5 champs, fenêtres modales, libellés lisibles) |
| 5.4 | 2026-08-03 | Claude | **Rattrapage complet code/specs** : format réel du `uniqueId` (protocole+subType+sensorId+unitCode), réponse définitive sur la persistance `lastOn`/`lastLevel` (écrits mais strippés au rechargement — cause racine de la rafale OFF, §4.3), asymétrie `primaryEmitter`/`emitters[]` documentée (§4.4), correction du slash initial erroné sur tous les topics (§8.5.2), détail complet de la découverte de scène avec `type`/`subtype` requis (§7.3), schéma Zod réel à jour (§5.3, 8 types de device, contrainte d'unicité `receiverId`), `receiverId` en timestamp et non séquentiel (§2.2). |

---

*Document conforme à [spec-nommage-v1.0.md](spec-nommage-v1.0.md) et [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.19.md)*
