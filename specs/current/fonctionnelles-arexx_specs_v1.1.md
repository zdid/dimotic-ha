# Spécifications Fonctionnelles - Module AREXX

*Version 1.1 - 4 Août 2026*
*v1.1 : correction de la référence `ws-ha` → `dimotic-ha` (§5.1, projet renommé le 04/08/2026),
sans changement fonctionnel.*
*Version 1.0 - 3 Août 2026*
*Première spécification formelle de l'application AREXX, opérationnelle depuis le 23/07/2026 mais
jusqu'ici sans documentation dédiée — écrite a posteriori à partir d'une lecture exhaustive du code
réel (pas de conception préalable à documenter, contrairement aux autres applications de ce
projet).*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Modes d'Acquisition](#3-modes-dacquisition)
4. [Serveur HTTP Local](#4-serveur-http-local)
5. [Mode USB (BS500)](#5-mode-usb-bs500)
6. [Registre des Capteurs et Persistance](#6-registre-des-capteurs-et-persistance)
7. [Taxonomie et Découverte HA](#7-taxonomie-et-découverte-ha)
8. [Configuration](#8-configuration)
9. [Interface Web et Socket.io](#9-interface-web-et-socketio)
10. [Limites et Contraintes Connues](#10-limites-et-contraintes-connues)
11. [Arborescence des Programmes](#11-arborescence-des-programmes)
12. [Annexes](#12-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/arexx` intègre les capteurs de température/humidité AREXX (hub réseau BS1000, ou
dongle USB/RF433 BS500) avec Home Assistant, sur le même principe que RFXCOM/EVOO7 : traducteur
entre un dialecte matériel propriétaire et le format MQTT normalisé du socle. **Application
en lecture seule** — contrairement à RFXCOM/EVOO7, aucun chemin de commande HA→matériel n'existe ;
AREXX ne fait que relayer des relevés.

C'est un portage d'un projet standalone antérieur nommé `arexx2hass` (mentionné en commentaire
dans plusieurs fichiers du code) — `PushReceiver` porte son `HttpServ`, `PollClient` son
`FromHttp`, `UsbBridge` son `RfUsb`.

### 1.2 Périmètre
- **Inclus** : réception de relevés température/humidité (3 modes d'acquisition), classification
  HA, publication MQTT (découverte + état), enregistrement/désenregistrement de capteurs via UI.
- **Exclus** : commandes HA→matériel (aucune, application read-only), configuration du matériel
  AREXX lui-même (BS1000/BS500), configuration broker MQTT (socle).

### 1.3 Conception délibérément minimale

`ArexxService.ts` (302 lignes, un commentaire d'en-tête explicite le choix architectural) :
*"Contrairement à `RfxComService` (~1800 lignes historiques, plusieurs sous-managers), AREXX n'a
pas de récepteurs/scènes/commandes : un seul service avec un `SensorRegistry` suffit."* Pas de
`ReceiverManager`, pas de `SceneManager`, pas de dispatch de commandes — un seul flux
capteur→HA.

---

## 2. Architecture

### 2.1 Composants (`applications/arexx/src/domain/`)

| Fichier | Rôle |
|---|---|
| `ArexxService.ts` | Orchestrateur unique : cycle de vie, backends d'acquisition, découverte/état HA, événements Socket.io, persistance |
| `SensorRegistry.ts` | Registre en mémoire : capteurs configurés (persistés) vs découverts (session uniquement) |
| `taxonomy.ts` | Extraction QUOI/OÙ — copie verbatim de celui de RFXCOM (pas de parseur partagé dans le socle) |
| `yaml/ConfigFileManager.ts` | Chargement/sauvegarde atomique du YAML des capteurs |
| `acquisition/PushReceiver.ts` | Serveur HTTP local Express (modes `push`/`usb`) |
| `acquisition/PollClient.ts` | Client HTTP périodique vers le BS1000 (mode `poll`) |
| `acquisition/UsbBridge.ts` | `spawn()` du binaire ARM vendored (mode `usb`) |
| `config-schema.ts` / `devices-config-schema.ts` | Schémas Zod (config générale / capteurs) |
| `types.ts` | `ArexxRawReading`, `ArexxSensorInfo`, `ArexxDiscoveredSensor`, `ArexxStatus` |
| `socket-events.ts` | Catalogue des événements Socket.io |
| `index.ts` | Manifeste du module (`AREXX_APP`, `AREXX_UI_METADATA`, `AREXX_MENU_CONFIG`) |

**Manifeste** (`AREXX_APP`) : `id: 'arexx'`, `type: 'integration'`, `audience: 'configuration'`,
`requiredMqtt: true`, `requiredHaWs: false`, `configSection: 'arexx'`.

### 2.2 Flux de données

```
BS1000/BS500 (matériel AREXX)
    |
    v (selon le mode — voir §3)
PushReceiver (HTTP) | PollClient (HTTP périodique) | UsbBridge (process enfant) → PushReceiver
    |
    v (callback onReading commun)
ArexxService.handleReading()
    |
    v (SensorRegistry.handleReading — nouveau capteur ou mise à jour)
    |
    v (si configuré ET transmitToHa=true)
publishSensorState() → EventBus → IntegrationBridge → MQTT → Home Assistant
```

### 2.3 Séquence de démarrage (`ArexxService.start()`)

1. `configFileManager.load()` — charge le YAML des capteurs.
2. `sensorRegistry.loadConfigured(...)`.
3. `setupSocketEventListeners()`.
4. `eventBus.emitGeneric('integration:bridge:register', {moduleName: 'arexx', bridgeInstance})`.
5. `await startAcquisition()` — démarre le(s) backend(s) selon le mode configuré (§3).
6. `publishInitialDiscoveries()` — pour chaque capteur configuré avec `transmitToHa: true`.
7. `emitStatus()` + `emitSensorsList()`.

`stop()` : arrête `pushReceiver`/`pollClient`/`usbBridge`, désenregistre le bridge.
**⚠️ Ne désabonne aucun des 5 écouteurs EventBus posés par `setupSocketEventListeners()`** — sur un
redémarrage à chaud (sauvegarde de configuration), les écouteurs s'accumulent : un même événement
`arexx:sensor:set_name` finit par s'exécuter N fois (et écrire N fois le YAML) après N
redémarrages. Non corrigé à ce jour.

---

## 3. Modes d'Acquisition

Un seul mode actif à la fois (`config.acquisitionMode` : `push` | `poll` | `usb`), démarré depuis
`startAcquisition()` avec un callback `onReading` commun aux trois backends.

### 3.1 `push` (par défaut)

Le BS1000 (ou un BS500 branché sur un Raspberry Pi séparé, configuré pour pousser) envoie ses
relevés en HTTP vers le serveur local d'AREXX (§4). Mode recommandé (libellé UI : "Push HTTP
(recommandé)").

### 3.2 `poll`

`PollClient` interroge périodiquement (`pollIntervalSeconds`, défaut 50s) le BS1000 en HTTP GET
sur `http://{bs1000Address}:{bs1000Port}/sdata_table.txt`.

**⚠️ Parsing fragile, documenté comme tel dans le code** : le BS1000 renvoie un pseudo-tableau
HTML (pas du JSON) — `parseTable()` applique 15 remplacements de chaînes successifs dans une
boucle `while` pour le convertir en JSON avant de le parser, "fidèle à l'original [portage],
aucun format alternatif documenté par Arexx". Un échec de parsing est loggé
(`Réponse BS1000 non parsable`) et retourne un objet vide, sans notification UI (voir §10).

Le type de mesure (température vs humidité) est déterminé **heuristiquement** depuis la chaîne
d'unité (`RH` ou `%` → humidité, sinon température) — pas un code structuré.

**⚠️ `running` reste vrai même si `bs1000Address` est absent** — `PollClient.start()` échoue
silencieusement à démarrer dans ce cas, mais le statut global du service reste "En cours".

### 3.3 `usb`

BS500 branché en direct sur la machine hôte. **Hors Docker uniquement, architectures arm/v6 ou
arm/v7** (le binaire vendored ne fonctionne pas sur arm64 — Raspberry Pi 3/4/5 en distribution
64 bits — incident connu et remonté à Arexx). Détail complet en §5. **Démarre à la fois
`UsbBridge` ET `PushReceiver`** — le binaire USB repousse ses lectures vers le serveur HTTP local,
qui les traite exactement comme le mode `push`.

---

## 4. Serveur HTTP Local

**Fichier** : `acquisition/PushReceiver.ts`, Express 4, `urlencoded` uniquement (pas de JSON body
parser).

- **Port** : `config.httpservPort`, défaut **49161**.
- **Routes** : `ALL /` et `ALL /rules` — les deux verbes-agnostiques, tous deux routés vers le même
  gestionnaire (`/rules` existe car c'est l'URL vers laquelle le mécanisme de "règle" du BS1000 /
  le fichier de règles du binaire USB peut être pointé).
- **Format attendu** (form-encodé) :
  ```
  type=1&id=8962&time=501092328&v=20.3&rssi=-101&missing=501092328
  ```
  - `type` : `'3'` → humidité, **toute autre valeur** → température (voir limitation §10 —
    d'autres types AREXX comme CO2/tension seraient mal étiquetés).
  - `id` → identifiant matériel brut (`rawId`).
  - `v` → valeur (`parseFloat`).
  - `rssi` → niveau de signal (optionnel).
  - `time` → secondes écoulées depuis le 01/01/2000 (epoch AREXX, offset `946684800`
    s appliqué pour convertir en date réelle) ; repli sur l'heure courante si non numérique.
  - Requête sans `id` ou avec `v` non numérique → relevé rejeté, réponse `"ko"`. Sinon,
    traitement + réponse `"ok"`.
- **Aucune authentification, aucun filtrage par IP source, aucune limitation de débit**, écoute
  sur toutes les interfaces. Chaque requête est journalisée intégralement en debug.
- **⚠️ Port non exposé par défaut dans `compose.yaml`** (seul `8080:8080` est publié) — le mode
  `push` depuis un BS1000 externe est injoignable dans le conteneur fourni tel quel.

---

## 5. Mode USB (BS500)

**Fichier** : `acquisition/UsbBridge.ts` — spawn d'un **binaire ARM compilé vendored**, pas une
bibliothèque série Node.

### 5.1 Bundle vendored (`applications/arexx/rf_usb_http_rpi_0_6/`)

| Fichier | Rôle |
|---|---|
| `rf_usb_http.elf` | Binaire AREXX officiel "rf_usb_http pour Raspberry Pi", v0.6 — nécessite `libusb 1.0` sur l'hôte |
| `rulefile.txt` | Configuration passée en argument — cible **codée en dur** `localhost:49161` |
| `51-rf_usb.rules` | Règle udev à installer (`/lib/udev/rules.d`), `idVendor==0451`, `idProduct==3211` |
| `device.xml` | Table des types de mesure AREXX (1=Température, 3=Humidité relative, 5=CO2, 7=Tension, 9=Temps...) |
| `rf.service` | Unité systemd de référence (déploiement standalone d'origine, non utilisée par dimotic-ha) |

### 5.2 Cycle de vie

- `start()` : `chmod +x` du binaire (interpolation de chaîne non échappée dans `exec()`), puis
  spawn même si le `chmod` a échoué (seule l'erreur est journalisée).
- `spawn(binaryPath, ['-v', rulefilePath], {cwd: binaryDir})` — stdout en debug, stderr en erreur.
- **Aucune supervision/redémarrage** en cas d'arrêt inattendu du process (`'close'` se contente de
  journaliser et de vider la référence).
- `stop()` : `SIGKILL` direct, sans délai de grâce SIGTERM. Un `stop()` déclenché pendant la
  fenêtre du `chmod` (avant le spawn effectif) peut laisser un process orphelin.

### 5.3 Pièges connus

- **`rulefile.txt` cible `localhost:49161` en dur** — changer `httpservPort` dans l'UI **casse
  silencieusement** le pipeline USB (rien ne régénère ce fichier).
- **`config.usbDevicePath` n'est jamais lu** — le binaire découvre le dongle lui-même via
  `libusb` ; ce champ de configuration est purement décoratif dans l'UI actuelle.
- **Le binaire n'est pas copié dans `dist`** au build — la résolution de chemin relative à
  `__dirname` ne fonctionne que depuis `src` (exécution en développement/`tsx`), pas depuis un
  build de production.

---

## 6. Registre des Capteurs et Persistance

### 6.1 `SensorRegistry`

Deux registres en mémoire :
- **`configuredSensors`** — persisté dans le YAML.
- **`discoveredSensors`** — **mémoire uniquement, jamais persisté** (par conception).

### 6.2 Construction de l'identifiant (`uniqueId`)

```typescript
const uniqueId = `arexx_${reading.rawId}${reading.kind === 'humidity' ? '_rh' : ''}`;
```
Un capteur physique AREXX mesurant à la fois température et humidité (ex: `rawId 8962`) produit
**deux** identifiants distincts (`arexx_8962` et `arexx_8962_rh`) — donc deux entités HA
indépendantes pour un seul boîtier physique.

### 6.3 Fichier `data/arexx/arexx-sensors-v1.0.yaml`

Schéma (`devices-config-schema.ts`) — clé racine `arexx_sensors: Record<uniqueId, ...>`, chaque
entrée : `uniqueId`, `kind` (`temperature`|`humidity`), `name`, `transmitToHa` (défaut `false`),
`lastValue?`, `lastSeen?`.

`ConfigFileManager` : mêmes garanties que RFXCOM/EVOO7 (copie `.bak` avant écriture, écriture
atomique tmp→rename) ; fichier manquant → créé avec un contenu vide ; erreur de validation Zod au
chargement → démarrage avec une config vide, **sans toucher au fichier fautif**.

**⚠️ Persistance opportuniste uniquement** : `handleReading()` met bien à jour `lastValue`/
`lastSeen` en mémoire à chaque relevé, mais `persistSensors()` (écriture disque) n'est déclenché
que par les **trois actions utilisateur** (renommer, activer/désactiver `transmitToHa`, supprimer)
— jamais automatiquement après un relevé. En pratique, la fenêtre de fraîcheur de 30 minutes
utilisée au démarrage (voir §7.3, même mécanisme que RFXCOM/AREXX pour éviter un état "unknown"
fictif) trouve donc le plus souvent une valeur périmée ou absente sur disque, sauf action manuelle
récente de l'utilisateur.

### 6.4 Promotion découvert → configuré

Un capteur détecté (`isNew: true` lors d'un relevé) apparaît dans `discoveredSensors` avec sa date
de détection. `setSensorName()` le promeut vers `configuredSensors` (`transmitToHa: false` par
défaut, même convention que RFXCOM) et le retire de la liste des découverts.

---

## 7. Taxonomie et Découverte HA

### 7.1 Extraction QUOI/OÙ

`taxonomy.ts` — copie verbatim de celui de RFXCOM (commentaire du code : *"aucun parseur partagé
n'existe dans core, chaque intégration matérielle duplique ce fichier"*). Même format
`QUOI---lieu_precis--lieu--pere--grand_pere`, mêmes fonctions `extractTaxonomy()`/`slugify()`/
`buildAttributsTaxonomie()` (10 champs, identique à RFXCOM/EVOO7 — voir
`fonctionnelles-rfxcom_specs` §2.6).

### 7.2 Publication de découverte (`publishSensorDiscovery`)

- Composant HA : `sensor` (toujours).
- `device_class`/`unit_of_measurement` : `humidity`/`%` si `kind === 'humidity'`, sinon
  `temperature`/`°C`.
- `value_template: '{{ value_json.state }}'` (même correctif que RFXCOM — sans lui, HA compare
  l'état à l'intégralité du JSON du topic).
- `attributsTaxonomie` fourni → topic MQTT dédié aux attributs de taxonomie, publié uniquement à
  la découverte (mécanisme générique du socle, voir `techniques-socle-ha-mqtt_specs` §8.5.4).
- `device.name` : littéralement `"AREXX temperature"` ou `"AREXX humidity"` — **la même chaîne
  pour tous les capteurs d'un même type**, alors que `device.identifiers` est bien propre à
  chaque capteur. Chaque capteur reste un device HA distinct, mais avec un libellé peu
  distinctif au niveau device (le nom de l'**entité**, lui, porte le QUOI réel via `essential.name`).
- `suggested_area` : lieu de la taxonomie (`nomLieu`).
- **Aucun `command_topic`** — AREXX ne déclare jamais `commandEnabled`, cohérent avec son
  caractère read-only (§1.1).

### 7.3 État au démarrage — pas d'état "unknown" fictif

Même mécanisme que RFXCOM (voir `fonctionnelles-rfxcom_specs` §9.2) : `publishSensorStateAtStartup()`
n'émet un état que si `lastValue` est défini **et** `lastSeen` a moins de 30 minutes
(`LAST_VALUE_MAX_AGE_MS`). Sinon, rien n'est publié — HA affiche nativement "Indisponible" plutôt
qu'une fausse valeur "unknown". Voir §6.3 pour la limite pratique de ce mécanisme (persistance
opportuniste de `lastSeen`).

### 7.4 ⚠️ Aucun retrait de découverte

**Contrairement à RFXCOM/EVOO7**, AREXX n'émet jamais `integration:arexx:discovery:remove` —
supprimer un capteur, ou désactiver `transmitToHa` après l'avoir activé, ne retire **jamais**
l'entité déjà publiée côté HA (elle reste visible, figée sur sa dernière valeur connue). Le
mécanisme générique existe pourtant côté socle (`unpublishDiscovery`) — simplement jamais appelé
par AREXX. Non corrigé à ce jour.

---

## 8. Configuration

### 8.1 `data/arexx/config.yaml` — champs réels

| Champ | Type | Défaut | Utilisation réelle |
|---|---|---|---|
| `enabled` | boolean | `true` | Déclaré, **jamais lu** par le service (activation gérée au niveau dossier, voir `ApplicationManager`) |
| `acquisitionMode` | enum `push`\|`poll`\|`usb` | `push` | §3 |
| `httpservPort` | int positif | `49161` | §4 |
| `bs1000Address` | string, optionnel | — | §3.2 |
| `bs1000Port` | int positif | `80` | §3.2 |
| `pollIntervalSeconds` | int, 5-300 | `50` | §3.2 |
| `usbDevicePath` | string, optionnel | — | ⚠️ **déclaré, jamais lu** (le binaire USB découvre le dongle lui-même) |
| `bridgeInstance` | string | `arexx_bridge_0001` | Enregistrement/désenregistrement du bridge, découverte, état |
| `sensorsConfigFile` | string | `arexx-sensors-v1.0.yaml` | Chemin du fichier capteurs |

> ⚠️ **Aucun `data/arexx/config.yaml` n'existe par défaut sur une installation neuve** — tant que
> l'utilisateur n'a pas sauvegardé une fois le formulaire générique, AREXX tourne entièrement sur
> ses valeurs par défaut Zod.

### 8.2 Formulaire générique ("Paramètres Techniques → AREXX")

Un seul groupe "Acquisition" (icône 📡), avec les 7 champs ci-dessus **sauf** `enabled` et
`sensorsConfigFile` (non exposés). Formulaire **plat** — les 7 champs sont toujours affichés,
sans masquage conditionnel selon le mode sélectionné (contrairement à ce qu'on pourrait attendre
d'un mode "push" qui n'a besoin ni de `bs1000Address` ni de `pollIntervalSeconds`).

---

## 9. Interface Web et Socket.io

### 9.1 Tableau de bord (`presentation/index.html`, embarqué dans le Shadow DOM du core)

- Badge "En cours"/"Arrêté" (piloté par `status.running` — voir la limitation §10 sur sa fiabilité
  en mode `poll`/`usb` en cas d'échec silencieux).
- Grille : Mode (chaîne brute), Capteurs paramétrés (compteur), Dernier relevé (horodatage ou
  `--`).
- Liste des capteurs récemment détectés non paramétrés (masquée si vide).
- Bouton "Rafraîchir" et lien vers la page dédiée "⚙️ Capteurs".
- N'affiche jamais les valeurs des capteurs configurés — seulement les non-paramétrés en attente.

### 9.2 Page dédiée "Capteurs" (`presentation/arexx/config.html`)

Vraie navigation de page complète (comme RFXCOM/EVOO7), sa propre connexion Socket.io.

- Table "Capteurs paramétrés" : identifiant, nom (QUOI---OÙ), type, case "Vers HA"
  (`transmitToHa`), dernier relevé, actions renommer/supprimer.
- Table "Capteurs en auto-découverte" : identifiant, type, date de détection, bouton "Paramétrer".
- **Flux de nommage** : deux boîtes de dialogue natives `prompt()` successives (QUOI, puis OÙ avec
  l'indication de format `lieu_principal (ou lieu_precis--lieu_principal)`), concaténées en
  `${quoi}---${lieu}`. Aucune validation contre le référentiel NOMMAGE — texte libre.
- Suppression via `confirm()` natif.

### 9.3 Événements Socket.io

**Server → Client** (persistants : `arexx:status`, `arexx:sensors:list`) :
```typescript
'arexx:status'          // { running, acquisitionMode, sensorsCount, lastReadingAt }
'arexx:sensors:list'    // { configured, discovered }
'arexx:sensor:detected' // { uniqueId, kind }
'arexx:error'           // ⚠️ déclaré et écouté côté UI, jamais émis par le serveur
```

**Client → Server :**
```typescript
'arexx:status:get'
'arexx:sensors:list:get'
'arexx:sensor:set_name'      // { uniqueId, name }
'arexx:sensor:set_transmit'  // { uniqueId, transmitToHa }
'arexx:sensor:delete'        // { uniqueId }
```

---

## 10. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| `stop()` ne désabonne pas ses écouteurs EventBus | Un redémarrage à chaud (sauvegarde config) fait exécuter chaque commande UI N fois après N redémarrages | Non corrigé |
| Persistance `lastValue`/`lastSeen` opportuniste, pas automatique | La fenêtre de fraîcheur de 30 min au démarrage trouve le plus souvent des données périmées | Non corrigé |
| Aucun retrait de découverte MQTT | Supprimer un capteur ou désactiver `transmitToHa` laisse l'entité HA orpheline | Non corrigé |
| `usbDevicePath` jamais lu | Champ de configuration purement décoratif | Non corrigé |
| `rulefile.txt` cible `localhost:49161` en dur | Changer `httpservPort` casse silencieusement le mode USB | Non corrigé |
| Binaire USB non copié dans `dist` | Mode USB fonctionnel seulement en exécution depuis `src` | Non corrigé |
| `running` toujours vrai après `startAcquisition()` | Le badge "En cours" peut mentir en cas d'échec silencieux (`poll` sans adresse, `usb` sans spawn réussi) | Non corrigé |
| Pas de supervision du process USB enfant | Aucun redémarrage automatique si le binaire se termine de façon inattendue | Non corrigé |
| Parsing HTML du BS1000 (mode `poll`) fragile | Format non documenté par Arexx, chaînage de remplacements successifs — accepté comme fidèle au portage d'origine | Accepté |
| Seuls température/humidité sont gérés | Un relevé d'un autre type AREXX (CO2, tension) serait publié à tort comme une température | Non corrigé |
| `arexx:error` jamais émis | Aucune erreur (BS1000 injoignable, payload invalide, échec d'écriture YAML, échec de spawn USB) n'atteint l'UI — logs serveur uniquement | Non corrigé |
| Aucune authentification sur le serveur HTTP local | Écoute sur toutes les interfaces, sans filtrage — acceptable en LAN de confiance, à ne pas exposer publiquement | Accepté (cohérent avec le reste du socle, voir `techniques-socle-ha-mqtt_specs` §5.6) |
| Port HTTP local non publié dans `compose.yaml` | Mode `push` depuis un BS1000 externe injoignable dans le conteneur fourni tel quel | Non corrigé |
| Désactivation de l'application ne coupe pas le serveur HTTP / process USB en cours | Fuite de handles OS (item générique du projet, particulièrement critique ici — AREXX cumule serveur HTTP, timer et process enfant) | Non implémenté (chantier différé, voir `TODO.md`) |

---

## 11. Arborescence des Programmes

```
applications/arexx/
├── package.json, tsconfig.json
├── rf_usb_http_rpi_0_6/          # Binaire vendored (mode USB), non compilé par ce projet
│   ├── rf_usb_http.elf
│   ├── rulefile.txt
│   ├── 51-rf_usb.rules
│   ├── device.xml
│   └── rf.service                # Référence de l'ancien déploiement standalone, non utilisée
├── src/
│   ├── domain/
│   │   ├── ArexxService.ts
│   │   ├── SensorRegistry.ts
│   │   ├── taxonomy.ts
│   │   ├── types.ts, config-schema.ts, devices-config-schema.ts, socket-events.ts, index.ts
│   │   ├── acquisition/
│   │   │   ├── PushReceiver.ts
│   │   │   ├── PollClient.ts
│   │   │   └── UsbBridge.ts
│   │   └── yaml/ConfigFileManager.ts
│   └── presentation/
│       ├── index.html, ts/app.ts    # Tableau de bord (Shadow DOM du core)
│       └── arexx/
│           ├── config.html          # Page dédiée "Capteurs"
│           └── config-app.ts
```

---

## 12. Annexes

### 12.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](spec-nommage-v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.19.md) ⭐
- [Spécifications Fonctionnelles RFXCOM](fonctionnelles-rfxcom_specs_v5.12.md) (mécanismes partagés : taxonomie, fraîcheur d'état au démarrage)

### 12.2 Glossaire
| Terme | Définition |
|-------|------------|
| BS1000 | Hub réseau AREXX, interrogeable en HTTP (mode `poll`) ou capable de pousser ses relevés (mode `push`) |
| BS500 | Dongle USB/RF433 AREXX, utilisable en direct (mode `usb`, hors Docker, arm/v6-v7) ou sur un Raspberry Pi séparé en mode `push` |
| `rawId` | Identifiant matériel brut d'un capteur AREXX, tel qu'envoyé sur le fil |
| `uniqueId` | `arexx_{rawId}` (température) ou `arexx_{rawId}_rh` (humidité) — un capteur physique T+RH produit deux identifiants |
| Capteur découvert | Relevé reçu d'un `uniqueId` non encore paramétré — en mémoire seulement, jamais persisté tant qu'il n'est pas nommé |

### 12.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-08-03 | Claude | Première spécification formelle, écrite a posteriori (application opérationnelle depuis le 23/07/2026 sans documentation dédiée). Couvre l'architecture, les 3 modes d'acquisition, le mode USB (binaire vendored), la persistance, la taxonomie/découverte HA, la configuration, l'UI/Socket.io, et une liste consolidée des limites connues identifiées en lisant le code réel. |
