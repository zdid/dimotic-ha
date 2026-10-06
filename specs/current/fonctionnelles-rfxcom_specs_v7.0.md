# Spécifications — Module RFXCOM

**Version :** 7.0
**Date :** 6 Octobre 2026
**Statut :** En production
**Type :** Application d'intégration
**Dépend de :** `fonctionnelles-nommage_specs` (protocole de taxonomie QUOI/OÙ), `techniques-socle-ha-mqtt_specs`
(socle), `guide-nouvelle-application_specs`, `fonctionnelles-supervisor_specs` (§9.1 et §9.4 : principe
multi-instances)

Ce document est la description complète et unique du module : fonctionnel, technique, récepteurs/émetteurs/scènes.

---

## Table des matières

1. Objet et périmètre
2. Vocabulaire
3. Identifiants et nommage
4. Architecture
5. Matériel et transceiver
6. Devices : capteurs et émetteurs
7. Récepteurs
8. Scènes
9. Fichiers de configuration et de données
10. Publication vers Home Assistant
11. État au démarrage
12. Plusieurs instances RFXCOM
13. Interface web
14. Démarrage, arrêt, reconnexion
15. Journalisation et erreurs
16. Limites connues
17. Critères d'acceptation
18. Annexes

---

## 1. Objet et périmètre

Le module RFXCOM relie un transceiver **RFXtrx433** (radio 433 MHz) à Home Assistant (HA) par MQTT. Il :

- reçoit les trames radio, les classe et en publie l'état vers HA (capteurs, boutons, compteurs) ;
- permet de **commander** des récepteurs radio depuis HA (lumières, prises, volets) ;
- relie des **émetteurs** physiques (télécommandes, boutons muraux) à des **récepteurs** logiques ;
- exécute des **scènes** (suites de commandes) ;
- coexiste avec d'autres instances RFXCOM sur d'autres machines.

**Hors périmètre** : le pilote du matériel (bibliothèque npm `rfxcom`), le broker MQTT, l'interface web générique du socle.
Le module n'accède pas à MQTT directement : il passe par les services d'intégration du socle (`HaMqttIntegrationService`
via l'EventBus, événements `integration:rfxcom:*`).

---

## 2. Vocabulaire

| Terme | Définition |
|---|---|
| **Transceiver** | Le boîtier RFXtrx433 branché en USB (port série). |
| **Device** | Appareil radio observé par le transceiver : capteur, compteur, ou émetteur. |
| **Émetteur** | Device Lighting1, 2, 4, 5 ou 6 qui envoie des ordres (télécommande, bouton mural, interrupteur radio). Publié dans HA comme `binary_sensor`. |
| **Récepteur** | Entité logique déclarée par l'utilisateur, commandable depuis HA : `switch`, `light` ou `cover`. Elle représente un **module physique** (module de lampe, prise, moteur de volet). |
| **Appairage** (physique) | Apprentissage, par le **module** du récepteur, du code radio d'un émetteur, selon la procédure du fabricant. Cela se passe **hors dimotic-ha**. Une fois appairé, le module réagit **directement** à ce code, sans passer par dimotic-ha. |
| **Émetteur principal** (`primaryEmitter`) | L'émetteur dont le code a été appris par le module du récepteur et que dimotic-ha **utilise pour le commander** : HA commande le récepteur en émettant ce code. |
| **Association** | Déclaration, dans la configuration d'un récepteur, d'un émetteur supplémentaire (`emitters[]`) dont dimotic-ha **écoute** les appuis pour tenir l'état du récepteur à jour dans HA. Dans le cas normal, cet émetteur est aussi appairé physiquement au module. Relation N↔N. |
| **Scène** | Entité logique qui enchaîne des commandes sur plusieurs récepteurs. |
| **Instance** | Un processus RFXCOM, identifié par son `bridgeInstance` complet (§9.1). |

**Règle générale.** L'émetteur principal et les émetteurs associés sont **réellement appairés** au module du récepteur : le
récepteur bouge tout seul quand on appuie dessus, et dimotic-ha ne fait que **suivre** l'état. La seule exception est le cas
où le protocole de l'émetteur principal n'est pas celui d'un émetteur associé : le module n'a alors pas pu apprendre ce
bouton (§7.3).

---

## 3. Identifiants et nommage

### 3.1 Format du `name`

```
quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
```

`---` sépare le QUOI de l'OÙ ; `--` sépare les niveaux du lieu. Le module respecte `nommage_specs`.

| Niveau | Rôle | Exemple | Obligatoire |
|---|---|---|---|
| `lieu_grand_pere` | Bâtiment | Maison | non |
| `lieu_pere` | Étage | Rez-de-Chaussée | non |
| `lieu_principal` | Pièce | Salon | **oui** |
| `lieu_precis` | Sous-zone | Coin Canapé | non |

Avec un seul segment de lieu, `lieu_precis` et `lieu_principal` reçoivent la même valeur.
Exemples : `Température---Salon`, `Température---Coin Canapé--Salon`, `Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée`.

### 3.2 Identifiant technique d'un device

```
<protocole>_<subType>_<sensorId>[_<unitCode>]        en minuscules
```

Exemples : `rfxsensor_temperature_0xa5b3`, `lighting2_ac_0x02be2c02_13`, `lighting1_x10_0x01a2`.

- Le `subType` distingue les mesures d'un même capteur (un TH9 envoie Température et Humidité sous le même `sensorId`).
- Le `unitCode` distingue les boutons d'une télécommande multi-touches (Lighting1/2 : un `sensorId`, plusieurs unités).
- La combinaison est unique dans tout le système. Lighting1 utilise `houseCode+unitCode` en minuscules comme `sensorId`
  (sans `unitCode` séparé) ; Lighting4 utilise la donnée brute ; Lighting5 et 6 utilisent `id` et `unitCode`. Détails par
  protocole au §6.3.

### 3.3 Identifiant d'un récepteur ou d'une scène

`recepteur_<horodatage>` et `scene_<horodatage>`, générés à la création (ex. `recepteur_1000890`). Unique dans le fichier.

### 3.4 QUOI automatique

Le QUOI d'un device est prérempli depuis son type ; l'utilisateur peut le modifier.

| Origine | QUOI | | Origine | QUOI |
|---|---|---|---|---|
| Temperature | Température | | Lighting1 | Interrupteur |
| Humidity | Humidité | | Lighting2 | Bouton |
| Motion | Mouvement | | Lighting4 | Télécommande |
| Contact | Contact | | Lighting5, Lighting6 | Interrupteur |
| Current | Courant | | Blinds1 | Volet |
| Power | Puissance | | | |

Règle : le QUOI vient du `subType` s'il est connu, sinon du type, sinon du `subType` brut. La distinction Mouvement/Contact
d'un capteur de sécurité repose sur le nom du sous-type (`PIR` ou `MOTION` = mouvement) : un nom inhabituel peut être mal
classé.

### 3.5 Taxonomie et libellés

La taxonomie est extraite du `name` (QUOI brut, lieu précis, lieu principal, père, grand-père, avec leurs « slugs »).

- **Libellé d'un récepteur ou d'une scène** (`device.name` publié) : le lieu précis s'il existe et diffère du lieu
  principal, sinon le QUOI ; première lettre en majuscule.
- **Libellé d'un bouton** (émetteur Lighting) : QUOI + lieu précis + lieu principal (si différent), chaque partie avec sa
  majuscule initiale, séparées par un espace. Un bouton garde son QUOI et son lieu pour rester distinguable du récepteur
  qu'il pilote.
- Chaque device ne porte qu'**une** entité HA : le nom de l'entité est toujours `null` ; seul `device.name` porte le
  libellé (HA concatène `device.name` et `name`, d'où l'absence de nom propre pour éviter les doublons).

---

## 4. Architecture

### 4.1 Couches (conformes au socle)

| Couche | Éléments |
|---|---|
| Présentation | Page RFXCOM (onglets Devices, Récepteurs, Scènes, Protocoles) + Socket.io |
| Application | `AppService`, `EventBus`, `SocketBridge` |
| Métier | `RfxComService` · `DeviceManager` · `ReceiverManager` · `ReceiverSwitch`/`ReceiverLight`/`ReceiverCover` · `SceneManager` · `SceneExecutor` |
| HA | `HaMqttIntegrationService`, `IntegrationBridge` |
| Infrastructure | `ConfigService`, `Logger`, `MqttTransport`, `RfxComTransceiver`, `PortDetector`, `ConfigFileManager`, `LastStatesStore` |

Les scènes ne sont pas un type de récepteur : `ReceiverManager` ne charge que switch/light/cover ; `SceneManager` (registre)
et `SceneExecutor` (exécution) réutilisent `ReceiverManager` pour appliquer chaque commande.

### 4.2 Réception d'un signal radio

```
Transceiver → événement par protocole (lighting1, lighting2, blinds1, temperaturehumidity1, …)
  → RfxComTransceiver : normalisation en RfxComRawMessage
  → RfxComService.handleRfxMessage()
      · device inconnu → ajouté en mémoire de session (« à déclarer »), jamais persisté tant qu'il n'est pas paramétré
      · device déclaré → lastSeen/lastValue mis à jour ; si transmitToHa : état publié vers HA
      · émetteur (Lighting*) → déduplication (§7.3) puis ReceiverManager.handleEmitterMessage()
      · device revendiqué par une autre instance → trame relayée à cette instance (§12)
```

La bibliothèque `rfxcom` n'émet pas d'événement générique : chaque protocole a son événement. Un paquet
`temperaturehumidity1` produit deux messages normalisés (Température et Humidité).

Structure normalisée :

```typescript
interface RfxComRawMessage {
  type: 'RFXSensor'|'RFXMeter'|'Lighting1'|'Lighting2'|'Lighting4'|'Lighting5'|'Lighting6'|'Blinds1'|'Rfy';
  subType: string;          // "Temperature", "AC", …
  sensorId: string;         // "0x123456", en majuscules
  unitCode?: number;
  commandDeviceId?: string; // identifiant de commande au format du transmetteur ("0xID/unité", "A1"…) ; absent pour un capteur
  seqNbr: number;           // 0-255
  signalLevel: number;      // niveau brut rssi de la bibliothèque, 0-15 (pas des dBm)
  batteryLevel: number;     // niveau brut, 0-9 ou 0-15 selon le protocole
  data: Record<string, unknown>;
  timestamp: Date;
}
```

### 4.3 Commande depuis HA

```
HA → MQTT …/<receiverId>/set → socle (IntegrationBridge) → RfxComService.applyReceiverCommand()
  1. transceiver connecté ? sinon échec propre, aucune publication d'état (§5.5)
  2. ReceiverManager → Receiver{Switch|Light|Cover}.translateHaCommand() → { action, value? }
  3. RfxComTransceiver.sendCommand() vers l'adresse du primaryEmitter
  4. mise à jour explicite de l'état interne du récepteur, puis publication de l'état vers HA
  5. journalisation de l'ordre avec son résultat réel (§13.4)
```

L'état interne est mis à jour **explicitement** après chaque commande : le transceiver n'entend pas ses propres
transmissions, aucun écho radio ne peut le faire.

---

## 5. Matériel et transceiver

### 5.1 Détection du port série

Le port est résolu **à chaque tentative de connexion** (démarrage et reconnexion), sans cache :

1. scan de `/dev/serial/by-id/` ; premier lien dont le nom contient `rfxcom` ou `rfxtrx` (insensible à la casse) ;
2. résolution vers le chemin réel (`/dev/ttyUSBx`) — c'est ce chemin qui est ouvert, jamais le lien ;
3. à défaut (répertoire absent, aucun lien, lien cassé) : avertissement et repli sur `port` de `machine_config.yaml`, qui
   contient donc **l'adresse réelle** du transceiver (ex. `/dev/ttyUSB0`), pas un lien `by-id`.

Avec plusieurs transceivers branchés, le premier trouvé est utilisé sans autre critère. Le conteneur doit voir le
périphérique (montage de `/dev`).

### 5.2 Connexion

`RfxComTransceiver.connect({port, baudRate})` crée la connexion avec la bibliothèque `rfxcom` (option `debug` seule). Un
drapeau garantit que la promesse de connexion n'est réglée qu'une fois, parmi `ready`, `connectfailed` et `disconnect`.
L'événement `status` (statut matériel) peut arriver avant ou après `ready` : aucun ordre n'est garanti.

Si le transceiver est absent au démarrage, l'application démarre quand même (avertissement, indicateur « Déconnecté »).

### 5.3 Reconnexion automatique

Dès que `connected=false` (échec initial ou débranchement), une boucle retente toutes les **5 secondes** : elle referme une
instance orpheline, redétecte le port (§5.1) et reconnecte. Un seul minuteur est actif à la fois ; il s'arrête à la
reconnexion et à l'arrêt du service. Les échecs intermédiaires sont silencieux.

### 5.4 Changement de réglages à chaud

Un changement de `port` ou de `baudRate` depuis les Paramètres Techniques reconnecte le transceiver **sans redémarrer** le
module : la configuration est relue sur disque ; si le port **effectivement utilisé** (détection incluse) ou le `baudRate`
changent, déconnexion propre, remise à zéro du verrou de poussée des protocoles, reconnexion. Le `bridgeInstance` n'est pas
touché ; un changement de `bridgeInstance` n'est pris en compte qu'au démarrage suivant. La découverte n'est pas republiée.

### 5.5 Commandes émises

Seuls quatre protocoles disposent d'un transmetteur :

| Protocole | Actions |
|---|---|
| `lighting1` | `on`, `off` |
| `lighting2` | `on`, `off`, `set_level` (0-15 natif) |
| `blinds1` | `open`, `close`, `stop` |
| `rfy` (Somfy RTS) | `open` (up), `close` (down), `stop` |

Lighting4, 5, 6 et Security1 ne sont qu'en réception. Les transmetteurs sont créés à la demande et mis en cache par
`protocole:subType`.

Le niveau natif de `set_level` est 0-15 : le pourcentage HA (0-100) est arrondi et borné
(`round(value/100 × 15)`, valeur absente = 100 %).

Le `callback` de transmission est appelé quand la trame est **écrite sur le port série** : ce n'est pas une confirmation de
réception par le récepteur radio. Une commande reste optimiste côté récepteur (portée, pile d'un émetteur intermédiaire) ;
mais elle est **refusée** si le transceiver n'est pas connecté : échec propre (`rfxcom:error`, journal ERROR), aucun état
publié.

### 5.6 Protocoles matériel

Le RFXtrx433 filtre en matériel les protocoles qu'il décode. La sélection persistée (`enabledHardwareProtocols`) est la seule
source de vérité ; elle est poussée en **RAM** du matériel (jamais en EEPROM) à chaque connexion, **une seule fois par
session** (verrou anti-boucle, car le push redéclenche un événement `status`).

- Liste vide = tous les protocoles gérables. Si la sélection cochée couvre tout le catalogue rapporté par le matériel, elle
  est persistée comme liste vide.
- `RFXMeter`/Elec n'a aucun bit de filtrage matériel : cette catégorie n'est pas filtrable.
- **Ordonnancement garanti** : la première publication de découverte attend que le push soit tenté (succès ou échec), avec
  un délai maximal de **20 secondes** (verrou `protocolsPushGate`, créé avant tout enregistrement d'écouteur). En cas
  d'échec de connexion, le verrou est levé immédiatement. Le verrou anti-boucle est remis à zéro à la reconnexion à chaud.
- Interface (onglet Protocoles) : cocher/décocher **persiste** sans rien envoyer ; « Envoyer au RFXtrx433 » pousse la
  sélection ; « Rafraîchir » redemande le statut sans reconnexion.

---

## 6. Devices : capteurs et émetteurs

### 6.1 Types pris en charge

| Famille | Types | Composant HA | Classe d'appareil / commandes |
|---|---|---|---|
| Capteurs RFXSensor | Température, Humidité | `sensor` | `temperature` (°C), `humidity` (%) |
| | Mouvement, Contact | `binary_sensor` | `motion`, `door` |
| Compteurs RFXMeter/Elec | Courant, Puissance | `sensor` | `current` (A), `power` (W) |
| Émetteurs | Lighting1, 2, 4, 5, 6 | `binary_sensor`, `entity_category: diagnostic` | on/off |
| Volets natifs | Blinds1, Rfy | (récepteur `cover`) | open, close, stop |

Un émetteur Lighting est **toujours** un `binary_sensor` (il n'émet que on/off). L'information « variateur » d'une lumière
vient **exclusivement** de `isDimmable` sur le récepteur, jamais du device. `entity_category` n'est jamais `config` pour une
entité en lecture seule (HA la rejetterait silencieusement).

### 6.2 Détection et paramétrage

La détection est **continue et passive** : chaque trame reçue d'un device inconnu l'ajoute à la liste « à déclarer » (mémoire
de session). Ces devices ne sont jamais persistés tant qu'ils ne sont pas paramétrés.

Le paramétrage d'un device (modale) fixe sa taxonomie en 5 champs (recomposés en un `name` unique côté serveur) et la case
`transmitToHa`. Un device paramétré est écrit dans le fichier avec `transmitToHa: false` par défaut ; seuls ceux à `true`
sont publiés vers HA. `rfxcom:device:create_manual` crée un device à la main.

Le device mémorise, pour les protocoles commandables, l'adresse de commande apprise (`commandDeviceId`) : c'est une
identité, stockée dans la configuration.

---

### 6.3 Ordres reçus par protocole

Les ordres qu'un émetteur peut envoyer dépendent de son protocole et de son sous-type. Les noms ci-dessous sont ceux de la
bibliothèque `rfxcom` ; Lighting5 et Lighting6 n'ont fait l'objet d'aucune étude propre dans le projet : ils sont traités
comme les autres émetteurs Lighting (réception seule).

| Protocole | Identité du device | Ordres que la bibliothèque décode |
|---|---|---|
| **Lighting1** (X10, ARC, Chacon, ELRO, Waveman, …) | `houseCode`+`unitCode` en un seul identifiant (ex. `a1`) | Off, On, Dim, Bright, Program, All Off, All On, Chime |
| **Lighting2** (AC, …) | `id` + `unitCode` : **un bouton = une unité** | Off, On, Group Off, Group On, Set Level, Set Group Level |
| **Lighting4** (PT2262) | donnée brute | « Data » seule : l'ordre n'est pas décodé |
| **Lighting5** (LightwaveRF, BBSB, Conrad, Eurodomest, Kangtai, Livolo, Legrand, …) | `id` + `unitCode` | **dépend du sous-type** : LightwaveRF = Off, On, Group Off, Mood 1 à 5, Lock/Unlock/All Lock, Close/Stop/Open, Set Level, couleurs ; BBSB/Conrad/Eurodomest/Kangtai = Off, On, Group Off, Group On ; Livolo = Toggle (par gang), Group Off ; Legrand = Toggle uniquement |
| **Lighting6** (Blyss, Cuveo) | `id` + `unitCode` (le code de groupe n'entre pas dans l'identifiant) | On, Off, Group On, Group Off |

**Lighting1 et Lighting2 sont complémentaires.** Un émetteur Lighting2 distingue ses boutons (une unité par bouton). Un
émetteur Lighting1 est identifié par son seul code : **des boutons qui émettent le même code sont indiscernables** et ne
forment qu'**un seul émetteur à déclarer**. En revanche, cet émetteur peut être associé à **plusieurs récepteurs**, de noms
différents (§7.2).

**Ordre « lisible » (on/off).** Pour décider de l'état d'un récepteur, le pilote ne sait lire que `On`, `Group On` (marche) et
`Off`, `Group Off` (arrêt). Tout autre ordre (Toggle, Mood, Open/Close/Stop, Dim, Bright, All On, All Off, Chime, Set
Level…) n'est **pas lisible comme on/off** : un récepteur associé retombe alors sur son `action` configurée (§7.2), et un
émetteur principal est ignoré (§7.3).

**État publié pour l'émetteur lui-même** (`binary_sensor`) : `ON` si l'ordre reçu est `On` ou `Group On`, `OFF` pour tout autre
ordre (Off, Group Off, Toggle, Mood, Dim…). Ce n'est donc pas un « contact » (« il y a eu un appui ») : c'est « le dernier ordre
était une marche » (§16).

**Ordres émis par dimotic-ha** : seulement `lighting1` (`on`, `off`) et `lighting2` (`on`, `off`, `set_level`) ; Lighting4, 5
et 6 ne sont jamais émis (§5.5), même si la bibliothèque sait émettre pour 5 et 6.

---

## 7. Récepteurs

### 7.1 Types

| Type | Commandes HA | Particularités |
|---|---|---|
| `switch` | `turn_on`, `turn_off`, `toggle` | état `lastOn` |
| `light` | `turn_on`, `turn_off`, `toggle`, `set_level` | `isDimmable`, `defaultLevel`, états `lastOn`, `lastLevel` |
| `cover` | `open`, `close`, `stop` (`set_position` : voir §7.5) | `coverType`, `openTimeSec`, `closeTimeSec` obligatoires |

Chaque récepteur déclare un `primaryEmitter` (obligatoire) et des `emitters[]`.

### 7.2 Émetteur principal, émetteurs associés et mode d'action

- **`primaryEmitter`** : code appris par le module du récepteur. Les commandes HA sont transmises avec ce code ; son
  protocole détermine le vocabulaire de commande.
- **`emitters[]`** : émetteurs dont on **écoute** les appuis. Chaque association porte :

| Champ | Rôle |
|---|---|
| `emitterId` | uniqueId de l'émetteur |
| `action` | `toggle`, `on`, `off`, `set_level`, `open`, `close`, `stop` |
| `value` | niveau 0-100 pour `set_level` |
| `followReceivedSignal` | `true` = suivre l'ordre réellement reçu (voir ci-dessous) |

**Quand le pilote entend un émetteur associé, comment décide-t-il de l'état du récepteur ?** Deux modes :

| Mode | À utiliser pour… | Effet |
|---|---|---|
| **Action fixe** (`followReceivedSignal` absent ou `false`) | un bouton qui veut toujours dire la même chose : « allume à 50 % » (`set_level` + `value: 50`), « ouvre le volet » (`open`) | Le récepteur applique **l'`action` configurée**, quel que soit le contenu de la trame. |
| **Suivre le signal reçu** (`followReceivedSignal: true`) | un interrupteur ou une télécommande qui envoie tantôt `On`, tantôt `Off` sur le même code | Le récepteur applique **l'ordre réellement contenu dans la trame** : `On` → allumé (ou volet qui monte), `Off` → éteint (ou volet qui descend). `action` ne sert alors que de repli quand l'ordre n'est pas lisible (§6.3). |

En une phrase : en action fixe, le bouton « veut dire » ce qui est configuré ; en mode suivi, le bouton « dit lui-même » ce
qu'il veut, et le récepteur le copie.

- Pour les émetteurs **Lighting1, Lighting2 et Lighting6**, l'ordre est toujours explicite (On ou Off) : l'action
  « toggle » n'existe pas, l'association suit le signal reçu. Une configuration qui contient encore `toggle` pour ces
  protocoles est convertie au démarrage en `action: on` + `followReceivedSignal: true` (copie de sécurité
  `…bak-avant-suppression-toggle`). « toggle » reste possible pour les autres protocoles (Lighting5 : Livolo, Legrand, ne
  parlent qu'en Toggle).
- Un émetteur peut être associé à plusieurs récepteurs, et un récepteur à plusieurs émetteurs (N↔N). Plusieurs récepteurs
  de noms différents peuvent ainsi réagir au même code (§6.3, Lighting1).

### 7.3 Ce que fait le pilote quand il entend un émetteur

1. **Déduplication** : la même trame (même émetteur, même ordre) déjà traitée il y a moins de **1,5 s** est ignorée. Cela
   couvre la réception directe suivie du relais d'une autre instance (§12).
2. **Récepteurs concernés** : ceux dont `emitters[]` contient l'émetteur (association) **et** ceux dont le `primaryEmitter`
   est cet émetteur, ce dernier cas **seulement si l'ordre on/off est lisible** (§6.3).
3. **Ordre appliqué** : pour une association, selon le mode du §7.2 ; pour l'émetteur principal, l'ordre reçu.
4. **Mise à jour** de l'état du récepteur, publié vers HA.
5. **Retransmission radio : jamais**, sauf le « pont de protocole » ci-dessous.

**Qui fait bouger le récepteur ?**

| Situation | Qui fait bouger le récepteur | Rôle du pilote |
|---|---|---|
| Appui sur un émetteur appairé au module (principal ou associé, même protocole) | le **module**, directement | suit l'état dans HA ; n'émet rien |
| Commande depuis HA | le pilote | émet le code de l'émetteur principal |
| Émetteur associé d'un **autre protocole** que le principal, récepteur = **volet natif** (Blinds1, Rfy) | le pilote : le moteur n'a rien reçu du bouton | **pont de protocole** : retransmet en vocabulaire natif (`open`, `close`, ou `stop` si l'ordre répète le sens en cours) |
| Émetteur associé d'un autre protocole que le principal, récepteur = switch, light ou volet Lighting2 | personne : le module n'a pas appris ce bouton | met seulement l'affichage de HA à jour — **cas non pris en charge** (§16) |

> Conséquence : pour qu'un bouton agisse sur un récepteur, il doit avoir été **appairé à son module**. L'association dans
> dimotic-ha sert à faire suivre l'état dans HA, pas à créer l'appairage.

### 7.4 Commandes HA par type

**`switch`** : `turn_on` → `on` ; `turn_off` → `off` ; `toggle` → inverse de l'état interne.

**`light` non variable** : comme un switch.

**`light` variable** (`isDimmable`, Lighting2 uniquement) :

| Commande | Action |
|---|---|
| `turn_on` | `on` avec le dernier niveau (`lastLevel`, sinon `defaultLevel`, sinon 100 %) |
| `turn_off` | `off` |
| `toggle` | `off` si allumé, sinon `on` au dernier niveau |
| `set_level` | `set_level` au niveau demandé |

Les niveaux sont des pourcentages 0-100 dans le module ; HA parle en luminosité 0-255 (conversion par l'appelant), le
matériel en 0-15 (§5.5). L'état d'une lumière variable porte `brightness` (0-255).

### 7.5 Volets (`cover`)

Le protocole du `primaryEmitter` détermine le fonctionnement.

**Volet piloté en Lighting2** (relais à deux sens) : pas de commande « stop » native.
- `open` → `on`, `close` → `off`.
- **Répéter la commande en cours arrête le moteur** (comportement matériel du relais). Une commande déjà en cours dans le
  même sens est donc ignorée (`open` pendant une montée, `close` pendant une descente, `set_position` vers la même
  direction).
- **Inverser le sens** ne nécessite pas d'arrêt intermédiaire (le relais gère l'interverrouillage).
- `stop` : renvoie la commande qui a démarré le mouvement (`on` si montée, `off` si descente) ; sans mouvement en cours,
  rien n'est émis.
- Un ordre on/off reçu d'un émetteur (§7.3) qui répète le sens en cours est un arrêt ; sinon c'est un nouveau mouvement.
- `open` et `close` ne sont jamais refusés au motif « déjà ouvert/fermé » : la position calculée peut être fausse
  (§11), et une commande inutile vaut mieux qu'un ordre silencieusement avalé.

**Volet en protocole natif** (Blinds1, Rfy) : `open`, `close`, `stop` sont transmis tels quels.

**Position** (les deux régimes) : calculée par le temps écoulé depuis le début du mouvement
(`openTimeSec`, `closeTimeSec`), de 0 (fermé) à 100 (ouvert). Un mouvement est considéré **arrivé** quand la position
calculée est à moins de 3 % de la butée ; la direction repasse alors à « aucune » et la position vaut 0 ou 100.
**Positionnement en pourcentage** (`set_position`, curseur de HA). Le volet est amené vers la cible dans le sens voulu, puis
**arrêté à l'instant où la position calculée atteint la cible** (durée = écart ÷ 100 × `openTimeSec` ou `closeTimeSec`) :
- le pilote arme un **minuteur par volet** ; à l'échéance il émet l'ordre d'arrêt (Lighting2 : la commande qui a démarré le
  mouvement ; natif : `stop`), republie l'état et journalise l'ordre ;
- cible 0 ou 100 : pas d'arrêt émis, le volet s'arrête à sa butée ;
- nouvelle cible dans le **même sens** : seule la cible change (rien n'est retransmis, une commande répétée arrêterait le
  moteur) et le minuteur est réarmé ; sens **inverse** : le volet repart dans l'autre sens, sans arrêt intermédiaire ;
- `open`, `close`, `stop` ou un ordre d'émetteur annulent la cible en cours ;
- la précision est celle du calcul au temps : la position est **approximative** (§16).

**État publié** : pendant un mouvement, `opening` ou `closing` ; à l'arrêt, `up` (position ≥ 100), `down` (≤ 0) ou
`intermediate`, avec `attributes.position`. À l'arrivée en butée (ou à l'arrêt automatique), l'état est republié sans attendre
la prochaine commande. La position est persistée dans le fichier des derniers états (`lastPosition`).

`coverType` (9 valeurs) : `Curtain1`, `Curtain2`, `Curtain3`, `Blind1`, `Blind2`, `Blind3`, `RFY`, `RFYEXT`, `ASA`.

---

## 8. Scènes

Une scène enchaîne des commandes sur des récepteurs.

```yaml
rfxcom_receivers:
  scene_1000851:
    receiverId: "scene_1000851"
    type: scene
    name: "Soirée"
    sceneType: sequential           # parallel | sequential (défaut sequential)
    delayBetweenCommands: 500       # ms (défaut 500)
    transmitToHa: true
    actions:                        # au moins une
      - target: recepteur_1000890   # receiverId
        command: turn_on
        value: 50                   # optionnel
        delayMs: 200                # optionnel : remplace delayBetweenCommands pour cette action
```

- **`parallel`** : commandes envoyées l'une après l'autre sans attente (boucle synchrone, pas de `Promise.all`).
- **`sequential`** : délai (`delayMs`, sinon `delayBetweenCommands`, sinon 500 ms) entre chaque commande. L'annulation est
  testée avant chaque commande et après chaque délai.
- **Erreurs** : en `sequential`, la première commande en échec interrompt les suivantes ; en `parallel`, toutes sont
  tentées.
- **Résultat** : `success = aucune commande en échec ET non annulée`. Une annulation et un échec produisent tous deux
  `success: false` ; `errors[]` (vide si annulée) permet de les distinguer.
- Annulation (`rfxcom:scene:cancel`) : au mieux, n'interrompt qu'une scène `sequential` entre deux commandes.
- Une scène n'a ni `primaryEmitter` ni `emitters`.

**Exécution depuis HA** : topic `rfxcom/{bridgeInstance}/scene_{sceneId}/set` ; résultat sur
`rfxcom/{bridgeInstance}/scene_{sceneId}/state` (`completed` ou `failed`, attributs `executed_commands`, `failed_commands`,
`duration_ms`).

---

## 9. Fichiers de configuration et de données

Tous sous `data/rfxcom/`. Le préfixe `machine_` désigne un fichier **propre à la machine** (non diffusé aux autres, cf.
`techniques-diffusion-data_specs`).

| Fichier | Contenu |
|---|---|
| `config.yaml` | Réglages communs (§9.1) |
| `machine_config.yaml` | `port`, `baudRate` de cette machine (§9.2) |
| `machine_config-rfxcom-devices-v1.0.yaml` | Devices, récepteurs, scènes (§9.3) — le préfixe `machine_` est imposé quel que soit `devicesConfigFile` |
| `machine_rfxcom-derniers-etats.json` | Derniers états (§9.4) |

### 9.1 `config.yaml`

Section nue (pas de clé d'enveloppe). Les paramètres `ha`, `mqtt`, `web` du socle vivent dans `data/core/config.yaml`.

```yaml
enabled: true
bridgeInstance: rfx_bridge
devicesConfigFile: config-rfxcom-devices-v1.0.yaml
autoDiscovery: true
waitForHaWsBeforeDiscovery: true
enabledHardwareProtocols: []        # vide = tous les protocoles gérables
radioDebug: false                   # diagnostic : trace chaque paquet reçu et émis (§15)
```

- **`bridgeInstance`** : préfixe du nom d'instance. Le core y ajoute `_<machineId>` : `rfx_bridge_ha2_811876`. Le nom
  complet apparaît dans tous les topics. Deux machines ne partagent jamais le même nom complet.
- **`waitForHaWsBeforeDiscovery`** : attend la synchronisation avec HA avant de publier les découvertes, pour que les
  entités reçoivent leur zone (HA n'applique la zone suggérée qu'à la création de l'entité).
- **`autoDiscovery`** : la détection des nouveaux devices est toujours active ; ce champ n'a aucun effet.
- **`radioDebug`** : active la trace hexadécimale de chaque paquet reçu et émis par le transceiver (journal du conteneur). À n'activer que le temps d'un diagnostic ; pris en compte à la connexion suivante.

### 9.2 `machine_config.yaml`

```yaml
port: /dev/ttyUSB0
baudRate: 38400
```

Le module lit le lien dans `/dev/serial/by-id/` et ouvre **l'adresse réelle au bout du lien** (§5.1), jamais le lien lui-même.
Le `port` n'est qu'un **repli**, utilisé quand cette détection échoue : il contient l'adresse réelle du transceiver
(`/dev/ttyUSB0`), pas le lien. Sa valeur peut devenir fausse si le numéro `ttyUSBx` change ; la détection, qui passe toujours en
premier, la corrige.

### 9.3 Fichier des devices, récepteurs et scènes

```yaml
rfxcom_devices:
  lighting2_ac_0x02be2c02_13:
    uniqueId: lighting2_ac_0x02be2c02_13
    sensorId: "0x02BE2C02"
    unitCode: 13
    type: Lighting2
    subType: AC
    protocole: lighting2
    name: "Bouton---Salon"
    defaultQuoi: Bouton
    transmitToHa: false
    commandDeviceId: "0x02BE2C02/13"      # adresse de commande apprise (optionnel)

rfxcom_receivers:
  recepteur_1000890:
    receiverId: recepteur_1000890
    type: light
    name: "Lumière---Salon"
    isDimmable: true
    defaultLevel: 80
    primaryEmitter: lighting2_ac_0x02be2c02_13
    emitters:
      - emitterId: lighting2_ac_0x02be2c02_14
        action: on
        followReceivedSignal: true
    transmitToHa: true
    icon: mdi:ceiling-light

  recepteur_1000901:
    receiverId: recepteur_1000901
    type: cover
    name: "Volet---Fenêtre--Cuisine"
    coverType: Blind1
    openTimeSec: 25
    closeTimeSec: 20
    primaryEmitter: lighting2_ac_0x013bc452_12
    emitters: []
    transmitToHa: true
```

**Schéma** (Zod, `devices-config-schema.ts`) :

- *Device* : `uniqueId`, `sensorId`, `type` (`RFXSensor`, `RFXMeter`, `Lighting1/2/4/5/6`, `Blinds1`, `Rfy`), `subType`,
  `protocole`, `name`, `defaultQuoi` (tous obligatoires), `transmitToHa` (défaut `false`), `unitCode`, `lastSeen`,
  `commandDeviceId`, `lastValue` (texte ou nombre).
- *Récepteur* (commun) : `receiverId`, `name`, `primaryEmitter`, `emitters[]` (défaut vide), `transmitToHa` (défaut
  `false`), `icon`. Propres à chaque type : `switch` (`lastOn`) ; `light` (`isDimmable` défaut `false`, `defaultLevel`
  0-100, `lastOn`, `lastLevel`) ; `cover` (`coverType`, `openTimeSec` > 0, `closeTimeSec` > 0, `lastPosition`).
- *Scène* : §8 (`actions` : au moins une).
- Contrainte transversale : `receiverId` uniques.
- `lastAnyValueChangeAt` (texte ISO) : voir §9.4.

**Règles du fichier** : YAML strict ; chargé au démarrage ; réécrit **uniquement quand la configuration change vraiment**
(édition depuis l'écran ou adresse de commande nouvellement apprise), jamais à la réception d'une trame. Un fichier invalide
est signalé dans le journal et le module démarre avec une configuration vide, sans planter. Le YAML peut être édité à la
main.

### 9.4 Derniers états

Les valeurs qui changent à chaque trame ne sont **pas** dans la configuration : elles sont dans
`machine_rfxcom-derniers-etats.json` (`LastStatesStore`).

| Clé | Contenu |
|---|---|
| `devices.<uniqueId>` | `lastValue`, `lastSeen` |
| `receivers.<receiverId>` | `lastOn`, `lastLevel`, `lastPosition` |
| `lastAnyValueChangeAt` | Horodatage ISO du dernier changement de valeur d'un device quelconque (indicateur global, affiché sur le tableau de bord ; aucune alerte n'est associée) |

- Écriture **groupée** : au plus une toutes les 30 s pendant la réception, aucune sans trafic, immédiate à l'arrêt propre.
- Écriture atomique (fichier temporaire puis renommage), sans `.bak`. Un fichier absent ou illisible = démarrage sans derniers
  états (entités « inconnues » dans HA jusqu'à la prochaine trame) ; la configuration n'est jamais touchée.
- Au chargement, ces valeurs sont appliquées **avant** la construction des récepteurs, qui en tirent leur état initial.
- Une configuration au format ancien qui contiendrait encore des derniers états est migrée au premier démarrage (états
  écrits dans le fichier dédié, configuration réécrite sans eux).

---

## 10. Publication vers Home Assistant

### 10.1 Topics

| Topic | Sens | Charge | QoS | Retain |
|---|---|---|---|---|
| `homeassistant/{component}/{rfxcom_bridge}/{objectId}/config` | module → HA | découverte (§10.2) | 1 | oui |
| `homeassistant/{component}/{objectId}/attributs` | module → HA | taxonomie (§10.3) | 1 | oui |
| `rfxcom/{bridgeInstance}/{deviceId}/state` | module → HA | `{"state":…}` | 0 | non |
| `rfxcom/{bridgeInstance}/{deviceId}/set` | HA → module | commande | 1 | **non** |
| `rfxcom/{bridgeInstance}/status` | module → broker | `online` / `offline` (dernière volonté) | 1 | oui |
| `rfxcom/{bridgeInstance}/registered-devices` | module → autres instances | liste d'`objectId` (§12) | 1 | oui |
| `rfxcom/{bridgeInstance}/relayed-value` | instance → instance | trame relayée (§12) | — | non |

Aucun topic ne commence par `/`.

**Les commandes ne sont jamais retenues**, ni par HA (l'option `retain` des entités de découverte vaut `false`), ni par aucune
application. Une commande reçue avec le drapeau `RETAIN` est ignorée : une commande est une action ponctuelle, jamais à
rejouer à une reconnexion.

**`deviceId` d'état et de commande** : pour un device physique, `{protocole}_{sousProtocole}__{sensorId}_{unitCode}`
(ex. `lighting2_ac__0x017340ca_10`) ; pour un récepteur, son `receiverId` ; pour une scène, `scene_{sceneId}`. Ce `deviceId`
est distinct du `unique_id`/`objectId` de découverte (`<protocole>_<subType>_<sensorId>` ; `rfxcom_scene_{sceneId}` pour
une scène).

### 10.2 Découverte

Chaque device, récepteur et scène avec `transmitToHa: true` est publié. Champs communs : `name: null`, `unique_id`,
`state_topic`, `json_attributes_topic`, `availability_topic` = statut de l'instance, `device`
(`identifiers`, `name`, `manufacturer: RFXCOM`, `model`, `suggested_area`).

| Entité | Composant | Particularités |
|---|---|---|
| Capteur | `sensor` | `device_class`, unité, `value_template: {{ value_json.state }}` |
| Mouvement/contact | `binary_sensor` | `device_class` `motion` / `door` |
| Émetteur Lighting | `binary_sensor` | `entity_category: diagnostic`, `payload_on: ON`, `payload_off: OFF`, `device.name` = libellé de bouton |
| Récepteur `switch` | `switch` | `command_topic`, `payload_on/off` |
| Récepteur `light` | `light` | `command_topic`, **`state_value_template`** (et non `value_template`, que `light` ignore) |
| Récepteur `cover` | `cover` | `device_class: shutter`, `command_topic`, `position_topic` + `position_template: {{ value_json.attributes.position }}`, `set_position_topic` (le topic de commande) + `set_position_template: {"position": {{ position }} }`, `state_open: up`, `state_closed: down`, `state_opening: opening`, `state_closing: closing` |
| Scène | `device_automation` | déclencheur (§10.4) |

L'état publié se limite à `{"state": "ON"}` (+ `brightness` pour une lumière variable, `position` pour un volet, et
`signal_level`, `battery_level` quand ils sont connus). Aucune clé de taxonomie ni identifiant interne dans l'état.

### 10.3 Attributs de taxonomie

HA ignore les clés inconnues d'un payload de découverte ou d'état : la taxonomie est donc publiée sur un **topic dédié**,
référencé par `json_attributes_topic` et `json_attributes_template: {{ value_json | tojson }}`, **uniquement à la
(re)découverte**, jamais à chaque état :

```json
{ "attributs_taxonomie": { "quoi": "Température", "slug_quoi": "temperature",
    "lieu_principal": "Salon", "slug_lieu": "salon", "lieu_precis": "Coin Canapé", "slug_precis": "coin_canape",
    "lieu_pere": null, "slug_pere": null, "lieu_grand_pere": null, "slug_grand_pere": null } }
```

Les scènes n'ont pas d'attributs de taxonomie (`device_automation` est un déclencheur).

### 10.4 Scènes dans HA

```json
{ "name": "Soirée", "unique_id": "rfxcom_scene_1000851", "automation_type": "trigger",
  "type": "scene_executed", "subtype": "1000851",
  "topic": "rfxcom/{bridgeInstance}/scene_1000851/set", "payload": "{}",
  "device": { "identifiers": ["rfxcom_scene_1000851"], "name": "RFXCOM Scène", "manufacturer": "RFXCOM", "model": "Scene" } }
```

`type` et `subtype` sont obligatoires pour HA (`subtype` = `receiverId` de la scène sans préfixe `scene_`).

### 10.5 Quand la découverte est publiée

- à la connexion du bridge MQTT du module, **après** la levée du verrou de poussée des protocoles (§5.6) ;
- à la réception du message de naissance de HA (`homeassistant/status`), pour le cas où HA redémarre seul ;
- lors de toute modification pertinente d'un device, récepteur ou scène.

La republication complète est **limitée à une fois toutes les 30 secondes**, quel que soit le nombre de reconnexions reçues
entre-temps.

### 10.6 Retrait

Décocher `transmitToHa`, ou supprimer un device, récepteur ou scène préalablement publié, retire sa découverte : message
vide retenu sur son topic de découverte. Changer le **type** d'un récepteur publié retire l'ancienne entité et en crée une
nouvelle (sans derniers états). Le composant HA doit être capturé **avant** la suppression, car il dérive du type du
récepteur.

---

## 11. État au démarrage

Principes : **aucune commande radio n'est jamais envoyée au démarrage**, et **aucun état inconnu fictif n'est publié**.

- **Devices** : republiés dès qu'une dernière valeur est connue, quel que soit son âge. Un device sans valeur connue est
  omis ; HA l'affiche « Indisponible » jusqu'à la première réception.
- **Récepteurs `switch`/`light`** : l'état courant est republié de façon strictement passive. Si `lastOn` est inconnu,
  l'état par défaut (éteint) est publié sans jamais être transmis au récepteur physique : au pire un affichage incorrect
  dans HA, jamais une action physique.
- **Volets** : la dernière position est republiée (état + position) **seulement si elle est connue** ; sinon rien n'est
  publié (la position par défaut, 100 %, serait inventée) et le volet reste « inconnu » dans HA jusqu'à la prochaine
  commande. La position peut être fausse après une coupure ou un déplacement manuel du volet.
- **Seconde passe** : 10 secondes après les découvertes, les états sont republiés **seuls** (passif, valeurs courantes,
  aucune commande radio) : à la création d'entités neuves, les états envoyés avec la découverte arrivent avant que HA ait
  créé l'entité et sont perdus (non retenus).

---

## 12. Plusieurs instances RFXCOM

Deux transceivers sur deux machines peuvent capter le **même** signal radio. Principe : une entité, un seul endroit
(`fonctionnelles-supervisor_specs` §9.1/§9.4).

### 12.1 Revendication des appareils

Chaque instance publie `rfxcom/{bridgeInstance}/registered-devices` (retenu) : tableau des `objectId` (uniqueId de device,
`receiverId`, ou `scene_{receiverId}`) qu'elle publie vers HA. Chaque instance s'abonne à `rfxcom/+/registered-devices`.

- **Un `objectId` déjà revendiqué par une autre instance n'est pas publié** par celle-ci ; un avertissement
  (`rfxcom:claimed-elsewhere:list`) signale le conflit. Jamais d'exclusion silencieuse.
- Un device revendiqué ailleurs est exclu de la liste « à déclarer » (`rfxcom:devices:list`, champ `discovered`),
  recalculée à chaque message `registered-devices`.
- La **déclaration reste locale** : l'instance qui capte un signal est celle qui le déclare, si elle le souhaite.
- **Le message `registered-devices` est retenu** : il survit à l'arrêt de l'instance qui l'a publié et continue de
  revendiquer ses appareils. Voir §12.5.

### 12.2 Relais de valeur

Quand une instance capte un signal pour un device revendiqué par une **autre** instance, elle publie la trame brute sur
`rfxcom/{bridgeInstance}/relayed-value` (non retenu ; `{ objectId, message }`) au lieu de l'ignorer : secours en cas de
réception manquée côté propriétaire, jamais une publication concurrente vers HA. L'événement local `device:detected` n'est
pas émis.

À la réception, l'instance propriétaire : (1) ignore le relais dans la fenêtre anti-écho (§12.3) ; (2) l'ignore si
`objectId` n'est pas un de ses devices ; (3) reconstruit le `timestamp` en `Date` (la sérialisation JSON en fait une
chaîne). Elle rejoue ensuite la trame par le **même chemin** qu'une réception radio réelle (§4.2).

Il n'existe aucun relais de **commande** : le mécanisme est à sens unique (valeurs captées → propriétaire).

### 12.3 Anti-écho

Quand une instance transmet une commande radio, elle se fait passer pour le `primaryEmitter` : un transceiver d'une autre
instance à portée l'entend comme une vraie pression sur la télécommande. Pour ne pas relayer à l'émettrice l'écho de sa
propre commande, elle mémorise le `primaryEmitter` commandé pendant **5 secondes** ; tout relais entrant le concernant est
ignoré dans ce délai. La même instance n'entend jamais ses propres transmissions.

### 12.4 Déduplication

Une même trame entendue directement **et** relayée par une autre instance (15 à 90 ms plus tard) n'est traitée qu'une fois
(§7.3).

### 12.5 Déplacer le transceiver vers une autre machine

Le déplacement change le nom d'instance (donc les topics) ; les messages retenus de l'ancienne instance bloquent la
découverte de la nouvelle. Ordre à suivre :

1. Désactiver `rfxcom` sur l'ancienne machine, puis débrancher le transceiver et le brancher sur la nouvelle.
2. Copier sur la nouvelle machine `config.yaml`, `machine_config.yaml` (avec, dans `port`, l'adresse réelle du transceiver sur la nouvelle machine, ex. `/dev/ttyUSB0`) et
   `machine_config-rfxcom-devices-v1.0.yaml` (et, si l'on veut conserver les états, `machine_rfxcom-derniers-etats.json`).
3. **Supprimer sur le broker les messages retenus de l'ancienne instance** : `rfxcom/{ancienne instance}/#` (dont
   `registered-devices`, `status`, et d'éventuels `…/set`) et `homeassistant/+/{ancienne instance}/#` (découvertes). C'est
   obligatoire : sans cela, la nouvelle instance considère les appareils comme revendiqués et ne publie pas leur découverte.
4. Activer `rfxcom` sur la nouvelle machine. Les entités de HA retrouvent leur nom et leur historique : leur `unique_id` ne
   contient pas le nom de l'instance.

---

## 13. Interface web

### 13.1 Page

Onglets **Devices**, **Récepteurs**, **Scènes**, **Protocoles**. Les associations d'émetteurs font partie des Récepteurs (pas d'onglet
séparé). Trois formulaires en **fenêtre modale** (Devices, Récepteurs, Scènes) ; pas de bouton « Sauvegarder » global.

- **En-tête** : badge de connexion (🟢 Connecté / 🔴 Déconnecté), mis à jour sur `rfxcom:status`.
- **Carte « Matériel du transceiver »** : type de récepteur, firmware, protocoles activés/disponibles ; masquée tant qu'aucun
  statut matériel n'est reçu.
- **Tableau de bord** : statut, « Dernier changement (tous devices) » (`lastAnyValueChangeAt`), journal des ordres reçus
  (§13.4), avertissements « déjà revendiqué ailleurs ».

### 13.2 Devices

Liste des devices détectés (sensorId, type, subType) ; QUOI prérempli et modifiable ; taxonomie en **5 champs** séparés
(Quoi, Lieu précis, Lieu obligatoire, Père, Grand-père), chacun avec son icône de sauvegarde ; deux listes distinctes :
devices paramétrés (fichier) et devices détectés (session). Outils : « Effacer non paramétrés »
(`rfxcom:devices:clear-unconfigured`), « Rafraîchir » (`rfxcom:devices:refresh`).

### 13.3 Récepteurs et associations

Création : type, taxonomie en 5 champs, `primaryEmitter`, émetteurs associés, `isDimmable` (lumière),
`openTimeSec`/`closeTimeSec` (volet, obligatoires). Les listes déroulantes d'émetteurs utilisent le **libellé lisible** dérivé
de la taxonomie (`Bouton · Salon (lighting2_ac_0x02b3)`), jamais le `uniqueId` seul. Actions proposées par émetteur :
`toggle` (hors Lighting1/2/6), `on`, `off`, `set_level` (light), `open`, `close`, `stop` (cover), et la case « suivre le signal
reçu ». L'écran conserve `followReceivedSignal` à l'enregistrement d'un récepteur.

### 13.4 Journal des ordres

Chaque ordre reçu de HA (récepteur cible, commande, valeur) est journalisé avec le **résultat réel** de son exécution
(transceiver connecté ou non, erreur de résolution ou de transmission) : 100 dernières entrées, événement persistant
`rfxcom:orders:list`. C'est la seule source fiable : l'accusé générique `turn_on`/`turn_off` de HA masque les échecs en amont.

### 13.5 Événements Socket.io

*Serveur → client* : `rfxcom:status` (`connected`, `devicesCount`, `receiversCount`, `lastDiscovery`, `error?`,
`hardware?` {`receiverType`, `firmwareType`, `firmwareVersion`, `enabledProtocols`, `availableProtocols`}),
`:devices:list`, `:device:detected`, `:device:deleted`, `:receivers:list`, `:receiver:created|updated|deleted`,
`:scenes:list`, `:scene:created|updated|deleted|status|executed`, `:protocols:list`, `:orders:list`,
`:claimed-elsewhere:list`, `:error` (`{code, message}`).

*Client → serveur* : `:status:get`, `:devices:list:get`, `:receivers:list:get`, `:scenes:list:get`, `:orders:list:get`,
`:claimed-elsewhere:list:get`, `:protocols:list:get`, `:devices:refresh`, `:devices:clear-unconfigured`,
`:device:set_name|set_transmit|delete|create_manual`, `:receiver:create|update|delete`,
`:scene:create|update|delete|execute|cancel`, `:hardware-protocol:toggle` (`{protocol, enabled}`),
`:hardware-protocols:push`, `:hardware-status:refresh`.

---

## 14. Démarrage, arrêt, reconnexion

### 14.1 Démarrage

1. Journal « Démarrage du service RFXCOM… ».
2. Chargement du fichier des devices (validation Zod ; en échec : journal + configuration vide), des derniers états, puis
   construction du `DeviceManager`, du `ReceiverManager`, du `SceneManager`.
3. Création du verrou `protocolsPushGate` (filet de 20 s) — **avant** tout enregistrement d'écouteur.
4. Enregistrement des écouteurs EventBus (`integration:rfxcom:command`, `…:bridge:connection`, `…:ha:online`,
   `app:module:config:saved`) et Socket.io, puis `integration:bridge:register`.
5. Enregistrement des callbacks du transceiver (`onMessage`, `onConnectionChange`, `onHardwareStatus` : ce dernier pousse
   les protocoles une fois par session et lève le verrou).
6. Résolution du port (§5.1), connexion ; en échec : avertissement, erreur émise, verrou levé, boucle de reconnexion (§5.3).
7. Émission des listes initiales (statut, devices, récepteurs, scènes, protocoles). Journal « Service RFXCOM démarré ».

La découverte MQTT n'est pas publiée à cette étape : elle est déclenchée par la connexion du bridge, après la levée du verrou
(§10.5).

### 14.2 Arrêt

Déconnexion du transceiver (avant l'arrêt de la boucle de reconnexion), écriture immédiate des derniers états,
`integration:bridge:unregister`, statut. Les découvertes ne sont ni retirées ni republiées à l'arrêt.

---

## 15. Journalisation et erreurs

Ordre des traces au démarrage : démarrage du service ; détection du port (`PortDetector`) ; tentative de connexion ; statut
matériel (type, firmware — avant ou après le message suivant) ; transceiver initialisé (ou avertissement
« indisponible au démarrage ») ; protocoles poussés pour la session ; service démarré.

**Traces de diagnostic** (niveau debug) :
- chaque trame d'émetteur reçue : `RF reçu: <uniqueId> — commande=…, unitCode=… | signal=n/15 seq=… data={…}` ;
- chaque décision de récepteur : `Émetteur … → récepteur … : action=… (signal reçu, config=…)` et, pour un volet,
  `Volet … — commande HA « … » [protocole] : sens=… position=…% → émet … | aucune émission ; après : sens=… position=…%` ;
- chaque ordre émis (`→ RFXCOM: …`) et son accusé d'écriture sur le port série ;
- avec `radioDebug`, chaque paquet reçu et émis en hexadécimal (`Received:` / `Sent:`), qui montre ce qui part réellement
  sur l'antenne.

Les erreurs de connexion au démarrage sont normales et ne bloquent pas l'application : niveau avertissement, motif précis.

**Codes d'erreur émis** (`rfxcom:error`) : `RFXCOM_CONNECTION_ERROR` (connexion initiale ou reconnexion à chaud) et
`RFXCOM_COMMAND_FAILED` (transmission, poussée de protocoles). Format : `erreurs_specs`.

---

## 16. Limites connues

| Limite | Effet |
|---|---|
| Une commande est optimiste côté récepteur physique | Aucune confirmation de réception radio ; un récepteur hors de portée n'est pas détecté |
| Seuls Lighting1, Lighting2, Blinds1 et Rfy peuvent transmettre | Un récepteur dont le `primaryEmitter` est Lighting4/5/6 ne peut pas être commandé |
| `RFXMeter`/Elec sans filtrage matériel | Catégorie non filtrable |
| Classification Mouvement/Contact par le nom du sous-type | Peut classer à tort un capteur de nom inhabituel |
| Plusieurs transceivers sur la même machine | Le premier trouvé est utilisé |
| `autoDiscovery` sans effet | La détection est toujours active |
| Événements `rfxcom:scan:*` déclarés sans gestionnaire | Pas de balayage actif ; détection passive uniquement |
| Échec de poussée des protocoles non remonté à l'écran | Visible seulement dans le journal serveur |
| Position d'un volet approximative lors d'un positionnement en pourcentage | L'arrêt à la cible est émis au temps calculé : écart possible avec la position réelle (§7.5) |
| L'état d'un volet publié à l'instant d'un ordre est la position calculée **avant** le mouvement | Un volet qui s'ouvre apparaît « fermé » (et inversement) jusqu'à la mise à jour suivante |
| Position d'un volet calculée, jamais mesurée | Fausse après une coupure, un déplacement manuel ou un ordre radio non entendu |
| Pont de protocole limité aux volets natifs (§7.3) | Un émetteur associé d'un autre protocole que le principal, pour un switch, une light ou un volet Lighting2, ne commande pas le récepteur : seul l'affichage suit |
| État d'un émetteur Lighting = « le dernier ordre était On ou Group On » | Toggle, Mood, Dim, Off, Group Off… s'affichent `OFF` (§6.3) |
| Lighting6 : le code de groupe n'entre pas dans l'identifiant | Deux télécommandes Blyss de même `id` et d'unités égales mais de groupes différents se confondent |
| Lighting5 et Lighting6 sans étude propre | Réception seule ; seuls On/Off/Group On/Group Off sont exploités (§6.3) |
| Résultat de scène sans distinction annulation/échec | Distinguer par `errors[]` |
| Découverte des scènes à un seul segment, jamais validée sur une instance HA qui vérifierait l'enregistrement | Non vérifiée |
| Relais inter-instances et exclusion (§12) non éprouvés avec un recouvrement radio réel | Non vérifiés en conditions réelles |
| `RfxComService.ts`, `config-app.ts` et `RfxComTransceiver.ts` dépassent la règle de 400 lignes | Découpage à faire |
| Aucun test automatisé | Voir §17 |

---

## 17. Critères d'acceptation

Comportements à valider (et à couvrir par des tests automatisés) :

1. QUOI automatique par type et sous-type ; `uniqueId` `protocole_subType_sensorId[_unitCode]` ; unicité des `receiverId`.
2. Un émetteur Lighting est un `binary_sensor` `diagnostic` ; `isDimmable` ne vient que du récepteur.
3. Signal d'un émetteur de `emitters[]` : récepteur mis à jour avec l'ordre reçu si `followReceivedSignal`, sinon avec
   l'action configurée ; plusieurs récepteurs touchés si N↔N.
4. Signal d'un `primaryEmitter` avec ordre lisible : état suivi, **aucune retransmission**.
5. Même trame reçue deux fois en moins de 1,5 s (directe puis relayée) : traitée une seule fois.
6. Lighting1/2/6 : jamais de « toggle » ; conversion d'une configuration existante au démarrage avec copie de sécurité.
7. Commande HA : transmission vers le `primaryEmitter` ; refusée (échec propre, aucun état publié) si le transceiver est
   déconnecté ; journal des ordres alimenté dans tous les cas.
8. Commande reçue avec le drapeau `RETAIN` : ignorée. Entités de découverte avec `retain: false`.
9. Volet Lighting2 : répéter la commande en cours arrête ; inverser le sens sans arrêt ; `stop` renvoie la commande qui a
   démarré le mouvement ; arrivée à 3 % de la butée ; position persistée ; état `opening`/`closing` pendant le mouvement, `up`/`down`
   à l'arrivée sans attendre une commande.
9bis. Positionnement en pourcentage : arrêt émis à la position visée (minuteur par volet), annulé par `open`/`close`/`stop`
   ou un ordre d'émetteur ; même sens = cible changée sans retransmission ; sens inverse = repart sans arrêt intermédiaire.
10. Volet natif : `open`/`close`/`stop` transmis tels quels (Blinds1, Rfy).
11. Aucune commande radio au démarrage ; aucun état inconnu fictif ; position de volet republiée seulement si connue ;
    seconde passe d'états 10 s après les découvertes.
12. Découverte : attendre le verrou des protocoles (max. 20 s) ; republication limitée à une par 30 s ; republication sur
    naissance de HA ; retrait à la désélection.
13. Port : détection `/dev/serial/by-id/` prioritaire, repli sur `machine_config.yaml` ; reconnexion automatique toutes les
    5 s ; reconnexion à chaud sur changement de `port`/`baudRate`.
14. Fichier des devices réécrit seulement sur changement de configuration ; derniers états écrits au plus toutes les 30 s ;
    fichier d'états absent sans conséquence.
15. Multi-instances : un `objectId` revendiqué ailleurs n'est pas publié ; trame relayée rejouée par le chemin de réception ;
    anti-écho de 5 s ; déplacement du transceiver selon §12.5.
16. Scènes : `parallel` sans attente, `sequential` avec délais, interruption sur première erreur en `sequential`,
    annulation entre deux commandes.

---

## 18. Annexes

### 18.1 Arborescence

```
applications/rfxcom/
├── package.json, tsconfig.json
└── src/
    ├── domain/
    │   ├── RfxComService.ts            # orchestrateur
    │   ├── index.ts, types.ts, socket-events.ts
    │   ├── config-schema.ts            # config.yaml
    │   ├── devices-config-schema.ts    # schéma Zod du fichier des devices
    │   ├── taxonomy.ts                 # extractTaxonomy, buildDisplayName, buildBoutonDisplayName
    │   ├── classification.ts           # determineQuoi, getProtocole, getDefaultComponent
    │   ├── transceiver/                # RfxComTransceiver.ts, PortDetector.ts
    │   ├── devices/                    # DeviceManager.ts
    │   ├── receivers/                  # BaseReceiver, ReceiverManager, ReceiverSwitch, ReceiverLight, ReceiverCover
    │   ├── scenes/                     # SceneManager.ts, SceneExecutor.ts
    │   ├── state/                      # LastStatesStore.ts
    │   └── yaml/                       # ConfigFileManager.ts
    ├── types/rfxcom.d.ts               # déclarations manuelles de la surface utilisée de la bibliothèque
    └── presentation/                   # index.html, ts/app.ts, rfxcom/config.html, rfxcom/config-app.ts
```

La bibliothèque `rfxcom` est déclarée à la main (`rfxcom.d.ts`) ; `rfxcom.protocols[…]`, `enableRFXProtocols()` et
`getRFXStatus()` n'existent pas dans les déclarations et sont appelés par `as any`.

### 18.2 Glossaire

| Terme | Définition |
|---|---|
| QUOI / OÙ | Type fonctionnel (« Température », « Bouton ») / localisation hiérarchique (« Coin Canapé--Salon ») |
| `uniqueId` | `<protocole>_<subType>_<sensorId>[_<unitCode>]` |
| `bridgeInstance` | Nom d'instance : préfixe configuré + `_<machineId>` |
| `transmitToHa` | Autorise la publication d'un device, récepteur ou scène vers HA |
| `followReceivedSignal` | L'association applique l'ordre on/off réellement contenu dans la trame (au lieu de l'`action` fixe configurée) |
| Appairage / association | Appairage = le module du récepteur a appris le code d'un émetteur (physique, hors dimotic-ha) ; association = déclaration de cet émetteur dans le récepteur pour que dimotic-ha suive son état (§2) |
| `protocolsPushGate` | Verrou retardant la première découverte jusqu'à la poussée des protocoles |
| `registered-devices` | Topic retenu par instance : appareils qu'elle publie vers HA |
| Relais de valeur | Trame captée pour un device revendiqué ailleurs, transmise à l'instance propriétaire |
| Anti-écho | Fenêtre de 5 s qui évite de relayer à l'émettrice l'écho de sa propre commande |
| Pont de protocole | Retransmission d'un bouton Lighting2 vers un volet en protocole natif |

### 18.3 Références

- `fonctionnelles-nommage_specs` — format QUOI/OÙ (obligatoire)
- `techniques-socle-ha-mqtt_specs` — socle (obligatoire) : `HaMqttIntegrationService`, garde sur les commandes retenues
- `fonctionnelles-supervisor_specs` §9.1/§9.4 — une entité, un endroit ; `registered-devices`
- Bibliothèque npm `rfxcom`
