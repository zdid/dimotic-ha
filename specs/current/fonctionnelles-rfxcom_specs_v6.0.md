# Spécifications — Module RFXCOM

**Version :** 6.0
**Date :** 19 Septembre 2026
**Auteur :** Mistral Vibe / Claude
**Statut :** En production
**Type :** Application d'intégration
**Dépend de :** `nommage_specs_v1.0.md` (protocole de taxonomie QUOI/OÙ), `techniques-socle-ha-mqtt_specs_v4.33.md`,
`guide-nouvelle-application_specs_v2.0.md`, `fonctionnelles-supervisor_specs_v2.9.md` (§9.1/§9.4 pour le
principe multi-instances utilisé en Partie 1 §17bis)

> **v6.0 (19/09/2026)** — **Fusion de `fonctionnelles-rfxcom_specs_v5.17.md` +
> `implementation-rfxcom_specs_v1.5.md` + `recepteurs-emetteurs-rfxcom_specs_v5.4.md`** en un seul
> document (même chantier de restructuration que pour ARBREOUQUOI et NOMMAGE plus tôt cette session :
> "il y a plusieurs specs qui traitent de rfxcom, il faut les regrouper"). Trois parties clairement
> séparées dans ce même document : **Partie 1 — Fonctionnel** (§, numérotation inchangée),
> **Partie 2 — Technique / Implémentation** (§T, préfixe pour ne pas renuméroter et casser les
> renvois internes existants), **Partie 3 — Récepteurs, Émetteurs et Scènes** (§R, même principe) —
> ce troisième document reste distinct de la Partie 1 malgré le recoupement de sujet (nomenclature,
> architecture récepteurs/émetteurs) car il apporte un niveau de détail technique réellement
> complémentaire, non dupliqué ailleurs (schéma Zod complet §R5.3, interfaces TypeScript complètes
> §R10, payloads MQTT Discovery détaillés par type d'entité §R7, checklist d'implémentation §R12.1)
> et il est activement cité par nom et numéro de section dans au moins 8 fichiers TypeScript réels de
> `applications/rfxcom/src/domain/` — voir l'avertissement plus bas sur ce point précis.
>
> **Aucun contenu `InterAppClient`/`ApplicationCapabilities` mort à retirer ici** : la Partie 1
> documentait déjà correctement ce pattern comme non implémenté (§22.3, corrigé en v5.9/v5.17) ; les
> Parties 2 et 3 n'en contenaient aucune trace (implementation-rfxcom l'avait déjà retirée en v1.3,
> recepteurs-emetteurs-rfxcom n'en a jamais eu).
>
> **Deux notes de correction ajoutées** (contenu conservé intégralement, pas de perte d'information) :
> Partie 2 §T8.1 et Partie 3 §R4.3 décrivaient toutes deux, à la date de leur dernière mise à jour
> (10/08 et 03/08/2026), la perte silencieuse de `lastOn`/`lastLevel`/`lastValue` au rechargement
> comme un défaut **non corrigé** — un correctif réel est intervenu depuis (15/08/2026, voir Partie 1
> §9.2/§9.2bis/§9.2ter/§20) sans que ces deux sections, plus anciennes, n'en soient informées. Un
> encart a été ajouté à chacune pointant vers l'état réel actuel, sans modifier le texte original
> (qui reste correct historiquement pour la date à laquelle il a été écrit).
>
> **⚠️ Point important : `classification-rfxcom_specs_v1.0.md` n'a PAS été fusionné dans ce
> document**, malgré son sujet directement lié à RFXCOM (contrairement au cas NOMMAGE où l'exclusion
> tenait à des références externes). Vérification faite avant fusion : ce document (11/07/2026, jamais
> mis à jour depuis) décrit un mécanisme de classification — cascade de priorité `HaClassifier`
> générique (`subType` > `device_class` > `domain` > `entity_id` > `non_classifie`), QUOI multi-valeurs,
> `isDimmable` forçant le QUOI du récepteur à `"eclairage"` — **qui ne correspond pas** au mécanisme
> réellement implémenté (`applications/rfxcom/src/domain/classification.ts::determineQuoi()`, déjà
> documenté fidèlement en Partie 1 §9.3 et Partie 2 §T5.1 : une simple table `SUBTYPE_TO_QUOI`/
> `TYPE_TO_QUOI`, sans cascade, sans `device_class`, sans multi-QUOI, sans notion de `non_classifie`
> côté RFXCOM) ni au classifieur générique réel du socle (`TaxonomyHaClassifier`, qui classe depuis la
> chaîne de taxonomie `name`, pas depuis `subType`/`device_class`). Les tables de mapping QUOI du
> document (§4/§5) diffèrent aussi de la casse et du contenu réels (`"température"` minuscule vs
> `"Température"` réel ; `Pressure`/`Gas`/`Smoke`/`CO2`/`VOC`/`Moisture`/`Illuminance`/`Energy`/
> `Voltage`/`Water`/`Flow` documentés mais absents du code). **Décision utilisateur (19/09/2026) :
> archivé comme conception jamais construite**, à la manière de l'ancien `inter-app-communication_specs`
> — déplacé vers `specs/archives/v5.17-rfxcom/classification-rfxcom_specs_v1.0.md`, aucune modification
> de son contenu. Références mises à jour en conséquence dans `techniques-socle-ha-mqtt_specs` §8.3
> (bandeau ajouté, §8.3.1 lui-même signalé comme non vérifié contre le réel) et `PROMPT.md`/
> `PROMPT_PROJET.md`. Reste néanmoins cité par un commentaire de
> `applications/rfxcom/src/domain/classification.ts` ("Conforme à ... et classification-rfxcom_specs_v1.0.md
> §4/§5") et `types.ts` — cette conformité déclarée dans le code ne concerne en réalité que les deux
> tableaux de mapping, pas le reste du document (cascade/multi-QUOI/conflits), et même ces deux tableaux
> divergent du code réel comme détaillé ci-dessus ; correction de ces commentaires **hors périmètre**
> de cette session (changement de code, pas de specs).
>
> **⚠️ Avertissement — références de code devenues obsolètes (hors périmètre de cette fusion) :**
> au moins 8 fichiers TypeScript de `applications/rfxcom/src/domain/` (`classification.ts`,
> `devices-config-schema.ts`, `types.ts`, `RfxComService.ts`, `socket-events.ts`, et les 3 fichiers
> `receivers/*.ts`) portent des commentaires citant `recepteurs-emetteurs-rfxcom_specs` par son nom de
> fichier et un numéro de section (ex: "§4.2", "§8.2", "§6.3"). Ces sections existent toujours dans ce
> document fusionné (renumérotées avec le préfixe R — ex: §4.2 → §R4.2), mais le nom de fichier cité
> dans le code ne correspond plus. Modification du code source **volontairement hors périmètre** de
> cette fusion de specs (changement de masse sur du code, nécessiterait sa propre confirmation
> explicite) — signalé ici pour un futur nettoyage.
>
> Anciennes versions (`fonctionnelles-rfxcom_specs_v5.17.md`, `implementation-rfxcom_specs_v1.5.md`,
> `recepteurs-emetteurs-rfxcom_specs_v5.4.md`) archivées.

---

## 📚 Table des Matières

**Partie 1 — Fonctionnel**
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
    - 17bis. [Multi-instances — Recouvrement RF et Relais entre Bridges](#17bis-multi-instances--recouvrement-rf-et-relais-entre-bridges-nouveau-v516)
18. [Arborescence des Programmes](#18-arborescence-des-programmes)
19. [Tests](#19-tests)
20. [Limites et Contraintes](#20-limites-et-contraintes)
21. [Roadmap](#21-roadmap)
22. [Annexes](#22-annexes)

**Partie 2 — Technique / Implémentation**
- T1. [Introduction](#t1-introduction)
- T2. [Architecture de l'Implémentation](#t2-architecture-de-limplémentation)
- T3. [Intégration de la Bibliothèque rfxcom (réelle)](#t3-intégration-de-la-bibliothèque-rfxcom-réelle)
- T4. [Gestion du Transceiver RFXCOM](#t4-gestion-du-transceiver-rfxcom)
- T5. [Détection et Classification des Devices](#t5-détection-et-classification-des-devices)
- T6. [Exécution des Commandes](#t6-exécution-des-commandes)
- T7. [Mappage des Protocoles (réel — 3 protocoles émetteurs)](#t7-mappage-des-protocoles-réel--3-protocoles-émetteurs)
- T8. [Persistance et Validation](#t8-persistance-et-validation)
- T9. [Configuration Requise](#t9-configuration-requise)
- T10. [Gestion des Erreurs](#t10-gestion-des-erreurs)
- T11. [Séquence de Démarrage/Arrêt](#t11-séquence-de-démarragearrêt)
- T12. [Tests et Validation](#t12-tests-et-validation)
- T13. [Limites et Contraintes](#t13-limites-et-contraintes)
- T14. [Annexes](#t14-annexes)

**Partie 3 — Récepteurs, Émetteurs et Scènes**
- R1. [Introduction](#r1-introduction)
- R2. [Référentiel de Nommage](#r2-référentiel-de-nommage)
- R3. [Définitions Clés](#r3-définitions-clés)
- R4. [Architecture Récepteurs ↔ Émetteurs](#r4-architecture-récepteurs--émetteurs)
- R5. [Fichier de Configuration Centralisé](#r5-fichier-de-configuration-centralisé)
- R6. [Modules Dédiés](#r6-modules-dédiés)
- R7. [MQTT Discovery](#r7-mqtt-discovery)
- R8. [Flux de Données](#r8-flux-de-données)
- R9. [Exemples Complets](#r9-exemples-complets)
- R10. [Types TypeScript](#r10-types-typescript)
- R11. [Intégration Interface Web](#r11-intégration-interface-web)
- R12. [Annexes](#r12-annexes)

---

# Partie 1 — Fonctionnel

*Version 5.17 - 19 Septembre 2026 — §22.3 : référence morte vers `inter-app-communication_specs`
(retirée de `specs/current/`) corrigée vers `techniques-socle-ha-mqtt_specs` §9bis.*
*⭐ Nouvelle §17bis "Multi-instances — Recouvrement RF et Relais entre Bridges" : ferme une lacune
documentaire (le mécanisme `registered-devices`/`claimed-elsewhere`, construit plus tôt cette
session avant même la migration en process séparé, n'avait jamais été documenté dans ce fichier —
seulement dans `fonctionnelles-supervisor_specs` §9.4, sans référence croisée depuis ici, corrigé).
Deux ajouts réels : **exclusion effective** de la liste "découverts" pour un device déjà revendiqué
par une autre instance (jusqu'ici seul un avertissement séparé existait, le device restait visible
comme "à déclarer" — bug signalé par l'utilisateur, corrigé) et **relais de valeur inter-instances**
(nouveau topic non retenu `rfxcom/{bridgeInstance}/relayed-value`) avec un garde-fou anti-écho pour
les commandes envoyées. **Non vérifié en conditions réelles** — nécessiterait deux instances RFXCOM
actives avec recouvrement RF réel, indisponible cette session (récepteur physique unique). Aucun
relais de commande (scope explicitement écarté par l'utilisateur). Référence croisée
`techniques-socle-ha-mqtt_specs` mise à jour (v4.19→v4.30, §22.1).*

*Version 5.15 - 15 Août 2026*
*Ferme le gap documenté en v5.14 §20 : `lastValue`/`commandDeviceId` ajoutés à `rfxComDeviceSchema`
(§20) — ces deux champs survivent désormais au rechargement, comme `lastOn`/`lastLevel` des
récepteurs depuis le 07/08/2026. Fenêtre de fraîcheur de 30 minutes retirée de
`publishDeviceStateAtStartup()` (§9.2) — demande explicite de l'utilisateur : maintenant que
`lastValue` persiste correctement, la dernière valeur connue doit toujours être republiée au
démarrage, quel que soit son âge, plutôt que d'être arbitrairement filtrée. Nouveau champ
`lastAnyValueChangeAt` (§9.2ter, nouvelle) : horodatage global, tous devices confondus, du dernier
changement de valeur — pas rattaché à un device précis, persisté, exposé dans `RfxComStatus` et sur
le tableau de bord ; pas de logique de fraîcheur/alerte dessus pour l'instant (juste stocké et
affiché, demande explicite).*

*Version 5.14 - 15 Août 2026*
*⚠️ Correctif de sécurité réel, incident constaté par l'utilisateur ("parfois ces commandes
arrivent à passer et m'éteignent toute la maison") : `publishReceiverStateAtStartup()` (§9.2bis,
nouvelle) envoyait une vraie commande RF433 `turn_off` à chaque récepteur commandable dont l'état
n'était pas connu au démarrage — un redémarrage pouvait donc réellement éteindre des lumières
allumées dans la maison, de façon aléatoire selon que le transceiver était déjà connecté à ce
moment précis. Corrigé : republication strictement passive de l'état à HA, plus aucune commande
matérielle envoyée au démarrage. §20 corrigée au passage : la ligne "lastOn/lastLevel strippés au
chargement" était stale — en réalité déjà corrigée le 07/08/2026 (`devices-config-schema.ts`
déclare bien ces champs depuis cette date), seule la table de limitations n'avait jamais été mise à
jour ; le vrai gap restant (device-level `lastValue`/`commandDeviceId`) est précisé séparément.*

*Version 5.13 - 15 Août 2026*
*§12.2/§12.3 : la page application affiche désormais le statut matériel du transceiver (type de
récepteur, firmware, protocoles activés/disponibles) — déjà récupéré en interne (§8.2, filtre
matériel des protocoles) mais jamais exposé à l'UI jusqu'ici.*

*Version 5.12 - 10 Août 2026*
*§8.6/§8.7/§8.8 : reconnexion automatique du transceiver (boucle 5s), correction de la publication
optimiste d'état sur transceiver déconnecté, journal des ordres reçus avec résultat d'exécution
réel — toutes demandes utilisateur suite à une anomalie constatée en direct (commande "réussie"
sans qu'aucune trame RF n'ait pu être émise).*

*Version 5.11 - 10 Août 2026*
*§17.1 : second déclencheur de republication de découverte — `integration:rfxcom:ha:online`
(birth message natif de HA sur `homeassistant/status`, indépendant de la connexion de notre propre
bridge MQTT), voir `techniques-socle-ha-mqtt_specs` §8.5.4bis pour le mécanisme complet.*

*Version 5.10 - 9 Août 2026*
*§5.5 : `essential.name` passe à `null` partout (5 endroits) — corrige un doublon de nom réel
observé en direct ("Lumière lumière", "Température Température", "Bouton Chambre du bas Bouton"),
voir `techniques-socle-ha-mqtt_specs` §8.5.4 pour `has_entity_name`.*

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

**⚠️ Ce module respecte strictement [nommage_specs_v1.0.md](nommage_specs_v1.0.md)**

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

**⭐ v5.9 — `essential.name` toujours `null` (fix doublon "Lumière lumière").** Chaque récepteur
(ReceiverLight/Switch/Cover), le publish RFXSensor/RFXMeter et les scènes (`RfxComService`) ne
publient plus de nom propre pour l'entité (`essential.name: null`, voir `techniques-socle-ha-mqtt_
specs` §8.5.4 pour `has_entity_name`) — seul `device.name` (`buildDisplayName`/
`buildBoutonDisplayName` ci-dessus) porte le libellé affiché. Avant ce correctif, `essential.name`
valait `taxonomy.rawQuoi` (le quoi brut, non capitalisé) tandis que `device.name` valait
`buildDisplayName(taxonomy)` (le même quoi, capitalisé, en repli faute de lieu précis distinct) —
HA (discovery classique) concatène toujours `"{device.name} {name}"`, produisant des doublons
visibles constatés en direct sur une instance HA réelle : "Lumière lumière", "Température
Température", "Bouton Chambre du bas Bouton" (boutons : `device.name` = `buildBoutonDisplayName`
inclut déjà le quoi en préfixe). Chaque device RFXCOM ne porte qu'une seule entité HA : son nom
propre était donc systématiquement redondant avec celui du device, jamais une information
distincte.

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

### 8.6 Reconnexion Automatique du Transceiver Matériel (⭐ nouveau v5.12)

Si le transceiver est absent au démarrage, ou se déconnecte en cours de fonctionnement (câble USB
débranché), une boucle retente une connexion **toutes les 5 secondes** plutôt que d'exiger un
redémarrage complet de l'application (demande utilisateur, 10/08/2026) :
- Démarrée dès `onConnectionChange(connected=false)` — couvre à la fois l'échec de connexion
  initial et une déconnexion ultérieure (le callback est enregistré avant le tout premier appel de
  connexion).
- Chaque tentative redétecte le port via `PortDetector` (`/dev/serial/by-id`, stable même si le
  numéro `/dev/ttyUSBx` change) et referme une éventuelle instance orpheline d'une tentative
  précédente avant de réessayer.
- Arrêtée dès `connected=true` ; nettoyée à l'arrêt du service. Un seul minuteur actif à la fois
  (idempotent).
- Échecs silencieux entre tentatives (le motif initial a déjà été journalisé) — seule la
  reconnexion réussie (ou l'absence prolongée) est notable.

### 8.7 Publication Optimiste de l'État Corrigée (⭐ nouveau v5.12)

**Anomalie réelle constatée en direct (10/08/2026)** : avec le transmetteur physiquement débranché,
une commande "allumer" envoyée depuis IA/`planificateur` était quand même relayée jusqu'à RFXCOM,
qui publiait `state:"ON"` sur MQTT (confirmé retenu sur le broker) sans qu'aucune trame RF n'ait pu
être émise — HA affichait la lumière allumée alors que rien ne s'était physiquement passé.
`transceiver.sendCommand()` ne lève une exception que si le transceiver n'a **jamais** été
initialisé depuis le démarrage, pas s'il a été débranché après une connexion antérieure réussie.

**Corrigé** : `applyReceiverCommand()` vérifie désormais explicitement `transceiver.isConnected()`
avant tout envoi — échec propre (`rfxcom:error`, log ERROR), aucune publication d'état optimiste si
le transceiver n'est pas connecté.

> ⚠️ **Limitation restante, non traitée** : même connecté, la commande reste optimiste sur la
> **réception RF433 par le récepteur physique lui-même** — la bibliothèque `rfxcom` ne remonte que
> la confirmation d'écriture bas niveau sur le port série (`buildAckLogger`), jamais une
> confirmation que le récepteur cible a réellement exécuté la commande. Un récepteur hors de
> portée RF, ou une pile déchargée sur un émetteur intermédiaire, reste donc silencieusement non
> détecté.

### 8.8 Journal des Ordres Reçus (⭐ nouveau v5.12)

Suite à la découverte que l'ACK générique `homeassistant.turn_on`/`turn_off` de HA masque les
échecs RFXCOM réels à tous les niveaux en amont (`planificateur`, `ia` — Mistral peut confabuler un
succès sur cette seule base, voir `fonctionnelles-planificateur_specs` §8), RFXCOM tient désormais
son propre journal (`rfxcom:orders:list`, 100 dernières entrées, événement persistant) : chaque
ordre reçu (récepteur cible, commande, valeur) avec le résultat réel d'`applyReceiverCommand()`
(connecté ou non, erreur de résolution/transmission le cas échéant) — seule source de vérité
fiable, indépendante de tout ce qui se passe en amont. Nouvelle carte "Journal des ordres reçus"
sur le tableau de bord.

---

## 9. État au Démarrage et Gestion des Données QUOI/OÙ

### 9.1 Règle Fondamentale de Transmission

**Toute transmission vers HA est conditionnée par `transmitToHa: boolean`** dans chaque
device/récepteur (case à cocher dans les fenêtres modales, §12) — **pas** par la complétude de
QUOI/OÙ (règle en vigueur jusqu'à v5.3 seulement).

Dès le démarrage, tous les devices/récepteurs avec `transmitToHa: true` sont publiés — sous réserve
du verrou d'ordonnancement décrit en §8.3.

### 9.2 Aucun état "inconnu" fictif publié (⭐ nouveau v5.9, fenêtre de fraîcheur retirée en v5.15)

**Avant le correctif v5.9**, un device sans valeur connue au démarrage (jamais reçu de message
RF433 depuis le dernier redémarrage) recevait tout de même un état publié, avec la valeur littérale
`"unknown"` — une entité HA affichant "Inconnu" en permanence tant qu'aucun message réel n'était
reçu, y compris pour des capteurs qui n'émettent que rarement.

**Comportement v5.9 à v5.14** : un device n'était publié au démarrage que si une valeur **fraîche**
était disponible — `lastSeen` de moins de **30 minutes** (`LAST_VALUE_MAX_AGE_MS`). En pratique
cette fenêtre ne se déclenchait jamais : `lastValue` n'était pas déclaré dans `rfxComDeviceSchema`
et donc toujours perdu au rechargement (voir §20), rendant la condition de fraîcheur systématiquement
fausse quel que soit son réglage.

**Corrigé (v5.15, 15/08/2026)** : `lastValue` déclaré dans `rfxComDeviceSchema` (§20) — survit
désormais au rechargement. Une fois ce vrai défaut corrigé, la fenêtre de 30 minutes n'avait plus de
raison d'être (demande explicite de l'utilisateur) — **retirée** : un device est désormais publié au
démarrage dès qu'une valeur est connue, quel que soit son âge. Un device n'ayant **jamais** eu de
valeur connue (`lastValue` toujours absent) reste omis de la publication initiale ; HA affiche
l'entité comme "Indisponible" (état MQTT natif) jusqu'à la première réception réelle.

### 9.2bis État au démarrage des récepteurs commandables (light/switch) — ⭐ corrigé v5.14

**Avant ce correctif**, `publishReceiverStateAtStartup()` distinguait deux cas pour un récepteur
`light`/`switch` : si `lastOn` était connu, republication passive de l'état ; **sinon, envoi d'une
vraie commande `turn_off` au matériel** ("pour initialiser l'état", comportement présent depuis
l'origine de l'app). Un device/récepteur sans `lastOn` connu — par exemple parce qu'il n'a jamais
reçu de commande individuelle depuis l'import de l'inventaire reconstitué (voir §22, historique de
la perte de la machine d'origine) — déclenchait donc une vraie transmission RF433 OFF à chaque
redémarrage.

**Incident réel constaté par l'utilisateur** : selon que le transceiver était déjà connecté ou non
au moment précis où cette rafale de commandes partait (course avec `protocolsPushGate`, voir §8.3),
les commandes échouaient silencieusement (transceiver pas encore prêt, sans effet) ou **réussissaient
réellement** — éteignant potentiellement toute une maison à chaque redémarrage du service, de façon
imprévisible.

**Corrigé (15/08/2026)** : `publishReceiverStateAtStartup()` republie désormais **toujours** l'état
courant à HA de façon strictement passive (`publishReceiverState()`), qu'il soit connu ou non —
plus aucune commande matérielle envoyée au démarrage, quel que soit l'état de `lastOn`. Si l'état
est inconnu, `getState()` retombe sur son défaut interne (`this.on = config.lastOn ?? false`, voir
`ReceiverLight`/`ReceiverSwitch`) : HA affiche cette valeur par défaut sans qu'elle soit jamais
transmise physiquement au récepteur — au pire un affichage optimiste incorrect dans HA (le récepteur
pourrait être réellement allumé), jamais une action physique non désirée.

### 9.2ter Horodatage global du dernier changement de valeur (⭐ nouveau v5.15)

Nouveau champ `lastAnyValueChangeAt` (niveau fichier, `config-rfxcom-devices-v1.0.yaml` — pas par
device) : horodatage ISO8601 mis à jour à **chaque** changement de valeur d'**un** device, quel
qu'il soit — distinct de `lastSeen`/`lastValue` (par device). Demande utilisateur explicite : un
indicateur global, "quand ce module a-t-il vu passer une valeur pour la dernière fois", sans
rattachement à un capteur précis (un capteur donné pouvant légitimement n'émettre que rarement sans
que ça signifie un problème).

Mis à jour dans `publishDeviceState()`, persisté immédiatement (même appel que `lastValue`),
exposé dans `RfxComStatus.lastAnyValueChangeAt` et affiché sur le tableau de bord ("Dernier
changement (tous devices)"). **Volontairement sans logique de fraîcheur/alerte pour l'instant** —
juste stocké et affiché (demande explicite de l'utilisateur, "on supprime le contrôle par rapport à
la date" en réponse à la question de son usage prévu) ; pourrait servir plus tard d'indicateur de
vie du récepteur RF (détecter un transceiver qui ne capte plus rien), non implémenté à ce stade.

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
- **Carte "Matériel du Transceiver"** (v5.13, 14/08/2026) : type de récepteur, firmware,
  protocoles activés/disponibles — déjà récupérés en interne depuis l'événement `status` de la lib
  `rfxcom` (`RfxComTransceiver.onHardwareStatus`, utilisé jusque-là uniquement pour le filtre
  matériel des protocoles, §8.2) mais jamais exposés à l'UI avant cette version. Masquée tant
  qu'aucun statut matériel n'a encore été reçu (ex: transceiver jamais connecté).
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
'rfxcom:status': { connected, devicesCount, receiversCount, lastDiscovery, scanInProgress, error?,
                    hardware?: { receiverType, firmwareType, firmwareVersion, enabledProtocols, availableProtocols } }
                  // hardware absent tant qu'aucun statut matériel n'a été reçu (v5.13, 14/08/2026)
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

**⭐ v5.11 — Second déclencheur : signal `ha:online` du socle.** En plus du démarrage/de la
reconnexion du bridge MQTT propre à RFXCOM (déclencheur historique), `publishInitialDiscoveries()`
est désormais aussi rappelée sur l'événement `integration:rfxcom:ha:online` — alimenté par le
birth message MQTT **natif de HA** (`homeassistant/status`, indépendant de notre propre connexion),
voir `techniques-socle-ha-mqtt_specs` §8.5.4bis. Nécessaire pour le cas où HA redémarre seul, sans
que le broker MQTT ni notre bridge ne se déconnectent — sans ce second déclencheur, HA repart avec
un registre vide et ne reçoit jamais de nouvelle découverte.

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

## 17bis. Multi-instances — Recouvrement RF et Relais entre Bridges (⭐ nouveau v5.16)

### 17bis.1 Contexte — `registered-devices`, conçu dans la spec supervisor, jamais documenté ici

Deux dongles RFXCOM sur deux machines ont de bonnes chances de recevoir le **même** signal RF pour
un même appareil physique — la RF ne respecte aucune frontière machine. Un premier mécanisme,
construit plus tôt dans la session du 16/08/2026 (avant même la migration de `rfxcom` en process
séparé) répond à la collision de **découverte** : chaque instance publie
`rfxcom/{bridgeInstance}/registered-devices` (retenu, QoS 1) — tableau JSON des `objectId`
(uniqueId device, `receiverId`, ou `scene_{receiverId}`) actuellement publiés vers HA depuis cette
instance. Chaque instance s'abonne à `rfxcom/+/registered-devices` (toutes les autres), et
`isClaimedByOtherInstance(objectId)` bloque la republication de découverte pour un `objectId` déjà
revendiqué ailleurs — jamais une exclusion silencieuse, un avertissement visible
(`rfxcom:claimed-elsewhere:list`) signale le conflit à l'utilisateur (principe "une entité, un
endroit, responsabilité du paramétreur", voir `fonctionnelles-supervisor_specs` §9.1/§9.4 pour la
conception complète — non reproduite ici, référence croisée uniquement).

**Lacune documentaire fermée par cette version** : ce mécanisme, pourtant en place et fonctionnel
depuis plus tôt dans la session, n'avait jamais eu de mention dans ce document — seulement dans la
spec supervisor. §17bis.2/17bis.3 ci-dessous documentent les deux ajouts réels de cette version.

### 17bis.2 ⭐ Exclusion effective de la liste "découverts" (nouveau v5.16)

**Bug signalé par l'utilisateur, corrigé** : `isClaimedByOtherInstance` ne servait jusqu'ici qu'à
peupler l'avertissement `claimed-elsewhere` — le device revendiqué par une autre instance restait
malgré tout visible dans la liste "découverts" (`rfxcom:devices:list`, champ `discovered`), comme
s'il restait "à déclarer" ici. `emitDevicesList()` (`RfxComService.ts`) filtre désormais cette liste
en excluant tout `uniqueId` revendiqué ailleurs — recalculé également à chaque réception d'un
message `registered-devices` (pas seulement au chargement de la page), pour que l'UI reflète les
changements en direct sans rafraîchissement manuel.

**Déclaration : reste locale, au plus près du signal reçu** — décision explicite de l'utilisateur
en discutant cette version : pas de mécanisme pour transmettre les métadonnées d'un device
*non déclaré* d'une instance à l'autre afin de le déclarer ailleurs (une première formulation de
l'idée l'envisageait, simplifiée en cours de discussion). L'instance qui capte physiquement un
signal reste celle qui le déclare, si elle le souhaite ; §17bis.3 couvre le cas où le device est
*déjà* déclaré par une autre instance.

### 17bis.3 ⭐ Relais de valeur inter-instances (nouveau v5.16)

**Principe** : quand une instance capte un signal RF433 pour un device qu'elle sait revendiqué par
une **autre** instance (`isClaimedByOtherInstance` positif), elle transmet la trame brute plutôt que
de l'ignorer silencieusement — un secours en cas de réception ratée côté propriétaire, jamais une
publication concurrente vers HA (reste cohérent avec §9.1 de la spec supervisor).

**Topic** : `rfxcom/{bridgeInstance}/relayed-value` — **non retenu** (`retain: false`), à la
différence de `registered-devices` : un événement ponctuel, pas un état à rejouer aux nouveaux
abonnés. Payload : `{ objectId: string, message: RfxComRawMessage }` (la trame brute complète —
`type`, `subType`, `sensorId`, `unitCode`, `data`, `signalLevel`, `batteryLevel`, `timestamp`).

**Émission** (`publishRelayedValue`, appelée depuis `handleRfxMessage`) : dès que
`isClaimedByOtherInstance(uniqueId)` est positif pour un signal reçu. L'événement local
`rfxcom:device:detected` n'est alors **pas** émis (le device n'est pas "à découvrir" ici, il
appartient déjà à quelqu'un).

**Réception** (`handleRelayedValueMessage`) — trois vérifications avant tout traitement :
1. **Anti-écho** (§17bis.4 ci-dessous).
2. **Appartenance réelle** : `deviceManager.getDevice(objectId)` doit exister — sinon le relais est
   ignoré silencieusement (topologie invalide, ou message pour une troisième instance qui partage
   le même abonnement wildcard).
3. **Reconstruction de `timestamp`** : le passage JSON.stringify/JSON.parse via le passthrough MQTT
   transforme le `Date` d'origine en chaîne ISO — reconstruit explicitement en `Date` avant tout
   traitement, sinon tout `.toISOString()` en aval (`DeviceManager.handleRawMessage`,
   `RfxComService.publishDeviceState`) lèverait une exception.

Une fois acceptée, la trame relayée est rejouée par le **même chemin** qu'une réception RF433
réelle : mise à jour `lastSeen`/`commandDeviceId` du device configuré, publication d'état si
`transmitToHa` (capteur), et `receiverManager.handleEmitterMessage()` si le type commence par
`Lighting` (émetteur associé à un ou plusieurs récepteurs — met à jour `lastOn`/`lastLevel`, publie
l'état des récepteurs affectés).

**Explicitement hors scope (décision utilisateur)** : aucun relais de **commande** — ce mécanisme
est à sens unique (valeurs captées → propriétaire), il n'existe aucun moyen pour une instance sans
portée RF sur un device de faire transmettre une commande par une autre instance qui, elle,
l'aurait.

### 17bis.4 ⭐ Garde-fou anti-écho (nouveau v5.16)

**Problème identifié par l'utilisateur avant construction** : quand une instance exécute une
commande (`applyReceiverCommandInternal` → `transceiver.sendCommand()`), elle transmet réellement un
signal RF433 en se faisant passer pour le `primaryEmitter` déclaré — un dongle d'une **autre**
instance à portée le capte exactement comme une vraie pression sur la télécommande physique (RF433
ne distingue pas les deux). Sans garde-fou, le mécanisme de relais ferait remonter à l'instance
émettrice l'écho de sa propre commande comme s'il s'agissait d'une information nouvelle.

**Résolu** : `recentlyCommandedEmitters` (`Map<uniqueId du primaryEmitter, horodatage d'expiration>`)
— posé juste après `transceiver.sendCommand()` réussi dans `applyReceiverCommandInternal`, fenêtre
de **5 secondes** (`RELAY_ECHO_SUPPRESSION_MS`, même ordre de grandeur que la boucle de reconnexion
du transceiver, cohérent avec les répétitions de trame RF433). `handleRelayedValueMessage` vérifie
cette table avant tout traitement — un relais entrant pour un `objectId` encore dans la fenêtre est
ignoré (log de niveau debug, pas une erreur).

Ne concerne que le relais **inter-instances** : la même instance n'entend jamais l'écho de sa propre
transmission (le dongle émetteur ne se réécoute pas lui-même — voir le commentaire existant dans
`applyReceiverCommandInternal` sur l'absence d'écho intra-instance), ce garde-fou n'aurait donc
aucun effet sur le chemin local.

### 17bis.5 ⚠️ Non vérifié en conditions réelles

Contrairement à la plupart des correctifs RFXCOM de cette session (tous validés avec le vrai
transceiver), ce mécanisme **n'a pas pu être testé en conditions réelles** : il nécessiterait deux
instances RFXCOM actives simultanément, avec des dongles en recouvrement RF réel — configuration
indisponible cette session (un seul récepteur physique, reparti sur `orangepi` juste avant ce
chantier ; l'instance locale `rfxcom` a été redésactivée en conséquence). Build propre (`tsc -b`),
aucune régression de comportement pour le chemin RF433 local (réception réelle) — seule la
correction de flux ajoutée. À vérifier au prochain déploiement où deux instances RFXCOM
tourneraient simultanément avec du recouvrement RF.

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
| ~~`lastValue`/`commandDeviceId` (devices physiques) strippés au chargement~~ | ~~Fenêtre de fraîcheur de 30 min jamais déclenchée, capteurs "Indisponible" après chaque redémarrage~~ | **Corrigé le 15/08/2026** (v5.15) — `rfxComDeviceSchema` déclare désormais les deux champs. La fenêtre de fraîcheur elle-même a été retirée au passage (§9.2, demande utilisateur) : la dernière valeur connue est toujours republiée, quel que soit son âge |
| ~~`lastOn`/`lastLevel` (récepteurs) strippés au chargement~~ | ~~Rafale de commandes OFF à chaque redémarrage~~ | **Corrigé le 07/08/2026** (`receiverSwitchSchema`/`receiverLightSchema` déclarent ces champs) — cette ligne était restée stale dans le tableau jusqu'au 15/08/2026 malgré le correctif déjà en place. Le risque résiduel (récepteur n'ayant jamais eu de `lastOn` connu) est traité séparément — voir §9.2bis (v5.14) : aucune commande matérielle n'est plus jamais envoyée au démarrage |
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
| Relais de valeur/exclusion multi-instances (§17bis) non vérifiés en conditions réelles | Nécessiterait deux dongles RFXCOM actifs avec recouvrement RF, indisponible cette session | Non vérifié — à tester au prochain déploiement multi-instances |

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
- [Spécification de Nommage **OBLIGATOIRE**](nommage_specs_v1.0.md) ⭐
- **Partie 2 — Technique / Implémentation** de ce document (§T1 et suivants)
- **Partie 3 — Récepteurs, Émetteurs et Scènes** de ce document (§R1 et suivants)
- [Spécifications Techniques Socle HA-MQTT **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.33.md) ⭐
- [Spécifications Fonctionnelles Supervision Multi-Machines](fonctionnelles-supervisor_specs_v2.9.md)
  (§9.1/§9.4 — conception complète du principe "une entité, un endroit" et de `registered-devices`,
  voir §17bis de ce document pour son usage réel côté RFXCOM)
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
| `registered-devices` | Topic MQTT retenu par instance, liste des `objectId` publiés vers HA — anti-collision de découverte entre instances (§17bis.1) |
| Relais de valeur | Transmission d'une trame RF433 captée pour un device revendiqué par une autre instance, vers cette dernière (§17bis.3) |
| Anti-écho | Garde-fou évitant qu'une instance ne se voie relayer l'écho de sa propre commande RF433 (§17bis.4) |

### 22.3 Annexe : Communication Inter-Applications — **NON IMPLÉMENTÉE**

> ⚠️ **Cette section décrit une conception qui n'a jamais été codée.** Aucune trace de
> `InterAppClient` dans `applications/rfxcom/`. Conservée ici à titre de mémoire de conception (le
> pattern Request/Reply existe et est utilisé par d'autres briques du projet), mais ne doit **pas**
> être considérée comme une capacité actuellement exposée par RFXCOM. `inter-app-communication_specs`
> a été retirée de `specs/current/` (19/09/2026, même conception jamais construite). Si ce chantier
> est repris un jour, repartir de `techniques-socle-ha-mqtt_specs` §9bis (mécanisme réel :
> `emitGeneric`/`onGeneric` + `CorrelatedRequester`) plutôt que de ce texte figé.

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
| 5.10 | 2026-08-09 | Claude | `essential.name` passe à `null` partout (5 endroits, §5.5) — corrige un doublon de nom réel ("Lumière lumière"), voir `techniques-socle-ha-mqtt_specs` §8.5.4 pour `has_entity_name`. |
| 5.11 | 2026-08-10 | Claude | **Second déclencheur de republication de découverte** (§17.1) — `integration:rfxcom:ha:online`, alimenté par le birth message MQTT natif de HA, en plus du démarrage/de la reconnexion du bridge propre à RFXCOM. Voir `techniques-socle-ha-mqtt_specs` §8.5.4bis pour le mécanisme complet. Ancienne version v5.10 archivée. |
| 5.12 | 2026-08-10 | Claude | **Trois correctifs suite à une anomalie constatée en direct** (transceiver débranché, commande "réussie" sans transmission RF) : reconnexion automatique du transceiver (§8.6, boucle 5s), publication optimiste d'état corrigée (§8.7, vérification `isConnected()` avant tout envoi), journal des ordres reçus avec résultat d'exécution réel (§8.8, `rfxcom:orders:list`, 100 max). Ancienne version v5.11 archivée. |
| 5.13 | 2026-08-15 | Claude | **Statut matériel affiché sur la page application** (§12.2/§12.3, nouvelle carte "Matériel du Transceiver") : type de récepteur, firmware, protocoles activés/disponibles — déjà récupéré en interne (§8.2) mais jamais exposé à l'UI. Vérifié en conditions réelles sur transceiver physique (RFXtrx433 XL, firmware ProXL 2 v1047). Ancienne version v5.12 archivée. |
| 5.14 | 2026-08-15 | Claude | **⚠️ Correctif de sécurité réel** (§9.2bis, nouvelle) : `publishReceiverStateAtStartup()` envoyait une vraie commande RF433 `turn_off` à tout récepteur commandable sans `lastOn` connu au démarrage — incident constaté par l'utilisateur (maison éteinte de façon imprévisible à certains redémarrages, selon l'état de connexion du transceiver à ce moment précis). Corrigé : republication strictement passive de l'état, plus aucune commande matérielle au démarrage. §20 corrigée au passage (la ligne "lastOn/lastLevel strippés" était stale — déjà corrigée le 07/08/2026, jamais reflété dans le tableau ; le vrai gap restant, `lastValue`/`commandDeviceId` niveau devices, reste documenté séparément). Ancienne version v5.13 archivée. |
| 5.15 | 2026-08-15 | Claude | Ferme le gap restant de v5.14 §20 : `lastValue`/`commandDeviceId` ajoutés à `rfxComDeviceSchema` — survivent désormais au rechargement. Fenêtre de fraîcheur de 30 min retirée de `publishDeviceStateAtStartup()` (§9.2, demande utilisateur) — devenue sans objet une fois `lastValue` persisté correctement, la dernière valeur connue est toujours republiée au démarrage. Nouveau `lastAnyValueChangeAt` (§9.2ter) : horodatage global (tous devices confondus, pas par device), persisté, exposé dans `RfxComStatus` et sur le tableau de bord — demande utilisateur explicite, sans logique de fraîcheur/alerte dessus pour l'instant. Ancienne version v5.14 archivée. |
| 5.16 | 2026-08-16 | Claude | **Nouvelle §17bis "Multi-instances — Recouvrement RF et Relais entre Bridges"** : ferme une lacune documentaire (`registered-devices`/`claimed-elsewhere`, construit plus tôt dans la session, jamais documenté ici — seulement dans `fonctionnelles-supervisor_specs` §9.4, référence croisée ajoutée). Deux ajouts réels : exclusion effective de la liste "découverts" pour un device revendiqué par une autre instance (§17bis.2, corrige un bug signalé par l'utilisateur — seul un avertissement séparé existait jusqu'ici) et relais de valeur inter-instances (§17bis.3, nouveau topic non retenu `rfxcom/{bridgeInstance}/relayed-value`) avec garde-fou anti-écho pour les commandes envoyées (§17bis.4, `RELAY_ECHO_SUPPRESSION_MS` 5s). Déclaration d'un device reste locale (décision explicite, une idée initiale de déclaration inter-instances a été simplifiée en discussion). Aucun relais de commande (hors scope explicite). **Non vérifié en conditions réelles** (§17bis.5) — nécessiterait deux dongles RFXCOM en recouvrement RF, indisponible cette session. Référence croisée techniques-socle mise à jour (v4.19→v4.30). Ancienne version v5.15 archivée. |

---

*Conforme à [nommage_specs_v1.0.md](nommage_specs_v1.0.md) et [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.33.md)*

---

# Partie 2 — Technique / Implémentation


## T1. Introduction

### T1.1 Objectif
Ce document décrit l'implémentation technique **réelle** du module RFXCOM, à partir de la
bibliothèque npm `rfxcom` telle qu'installée dans `node_modules/rfxcom` (pas telle que documentée
en théorie) — c'est la démarche suivie par `applications/rfxcom/src/types/rfxcom.d.ts`, dont le
commentaire d'en-tête précise explicitement que les déclarations couvrent *"QUE la surface
réellement utilisée par RfxComTransceiver.ts — vérifiée directement dans le code source installé"*.

### T1.2 Périmètre
- **Inclus** : intégration de la bibliothèque `rfxcom`, initialisation du transceiver, détection/
  classification des devices RF433, exécution des commandes via les transmitters, mappage entre
  les événements réels de la bibliothèque et le modèle interne.
- **Exclus** : configuration matérielle du transceiver, gestion du port série au niveau OS
  (au-delà de la détection automatique, voir `fonctionnelles-rfxcom_specs` §8.2), configuration
  MQTT et HA WebSocket (`techniques-socle-ha-mqtt_specs`).

### T1.3 Prérequis
- Transceiver RFXtrx433 connecté via port série, détecté automatiquement (voir
  `fonctionnelles-rfxcom_specs` §8.2) ou configuré manuellement (`/dev/ttyUSB0` par défaut).
- NPM package `rfxcom` (dépendance de `applications/rfxcom`).

### T1.4 Référentiels
- **⭐ [fonctionnelles-rfxcom_specs_v5.12.md](#1-introduction)** - Spécifications fonctionnelles principales
- **⭐ [techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.33.md)** - Socle technique
- **⭐ [nommage_specs_v1.0.md](nommage_specs_v1.0.md)** - Règles de nommage
- **⭐ [recepteurs-emetteurs-rfxcom_specs_v5.4.md](#r1-introduction)** - Récepteurs et émetteurs

---

## T2. Architecture de l'Implémentation

### T2.1 Composants Principaux (réels, avec taille de fichier)

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

### T2.2 Flux de Données (réel)

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

## T3. Intégration de la Bibliothèque rfxcom (réelle)

### T3.1 Import

**Fichier**: `applications/rfxcom/src/domain/transceiver/RfxComTransceiver.ts`

```typescript
import * as rfxcom from 'rfxcom';
```

> ⚠️ Aucun import `RfxComDeviceEvent` ni type `RfxCom as RfxComType` depuis un fichier
> `types/rfxcom` — ces noms n'existent pas dans le code réel.

### T3.2 Déclarations TypeScript manuelles (`rfxcom.d.ts`)

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

## T4. Gestion du Transceiver RFXCOM

### T4.1 Différences réelles avec l'API précédemment documentée (v1.2)

| Point | Documenté jusqu'à v1.2 | Réel |
|---|---|---|
| Événement de détection | `'device'` générique | Un événement par protocole (`'lighting1'`, `'lighting2'`, `'blinds1'`, `'temperaturehumidity1'`, `'temperature1'`, `'elec1'`, ...) |
| Connexion réussie | `'connect'` | `'ready'` |
| Connexion échouée | `'error'` | `'connectfailed'` / `'disconnect'` (avec message) |
| Ordre statut/prêt | `'status'` après `'connect'` | `'status'` peut arriver **avant ou après** `'ready'` — aucun ordre garanti |
| Options du constructeur | `{debug, deviceParameters, concurrency: 3, timeout: 12000}` | **`{debug}` uniquement** — aucun `deviceParameters`/`concurrency`/`timeout` n'est jamais passé |
| Événement générique `'error'` | Existe | N'existe pas dans le cycle de vie utilisé — les échecs passent par `'connectfailed'`/`'disconnect'` |

### T4.2 Construction et Connexion (réel)

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

### T4.3 Écouteurs par Protocole (réel, remplace l'ancien §4.3 générique)

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

### T4.4 Fermeture

```typescript
disconnect(): void {
  this.device?.close();
  this.device = undefined;
}
```

---

## T5. Détection et Classification des Devices

### T5.1 Classification réelle (`classification.ts`, remplace les anciennes méthodes fictives
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

### T5.2 Construction du `uniqueId` (`DeviceManager.ts::buildUniqueId`)

```typescript
const uniqueId = `${protocole}_${message.subType.toLowerCase()}_${message.sensorId.toLowerCase()}${unitSuffix}`;
// unitSuffix = message.unitCode !== undefined ? `_${unitCode}` : ''
```
Voir `fonctionnelles-rfxcom_specs` §2.2 pour la justification (disambiguïsation multi-mesures et
multi-boutons).

### T5.3 Détection

**Il n'existe pas de méthode `startDiscovery()` avec timer de 2 secondes.** La détection est
purement **continue et passive** : chaque événement de protocole reçu du transceiver déclenche
immédiatement `handleRawMessage()`. Aucun état "en cours de scan" n'est maintenu côté serveur —
`getStatus().scanInProgress` retourne toujours `false` en dur, bien que le champ existe et que les
événements `rfxcom:scan:start`/`:complete`/`:failed` soient déclarés côté Socket.io (aucun
gestionnaire serveur ne les traite, voir `fonctionnelles-rfxcom_specs` §20).

---

## T6. Exécution des Commandes

### T6.1 Flux d'Exécution (réel)

```
HA → EventBus → RfxComService.applyReceiverCommand()   ⭐ v1.5 : enveloppe recordOrder() +
        │                                                  applyReceiverCommandInternal()
        ▼
⭐ v1.5 : transceiver.isConnected() ? sinon échec propre, aucun envoi tenté
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
        │
        ▼
⭐ v1.5 : recordOrder() journalise le résultat réel (recentOrders, 100 max, rfxcom:orders:list)
```

**⭐ v1.5** : `applyReceiverCommand()` (nom conservé côté appelant) enveloppe désormais
`applyReceiverCommandInternal()` (logique inchangée, renommée) — chaque appel est journalisé via
`recordOrder(receiverId, command, value, result)`, quel que soit le point de sortie (échec précoce
— transceiver non connecté, récepteur/émetteur introuvable — ou succès/échec de `sendCommand()`).
Voir `fonctionnelles-rfxcom_specs` §8.6/§8.7/§8.8 pour le contexte complet (anomalie constatée en
direct : publication d'état optimiste sur transceiver débranché).

### T6.2 Dispatch par Protocole (réel — remplace `instanceof` fictif)

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

### T6.3 Commande DIM — échelle réelle

```typescript
// Échelle native RFXCOM : 0-15, PAS 0-100 ni 0-255
const level = Math.round(((value ?? 100) / 100) * 15);
const clamped = Math.max(0, Math.min(15, level));
transmitter.setLevel(deviceId, clamped);
```

### T6.4 Mappage des Actions (réel)

| Action HA | Protocoles Supportés |
|-----------|---------------------|
| `turn_on` / `turn_off` | lighting1, lighting2, blinds1 (open/close pour cover) |
| `toggle` | lighting1, lighting2 |
| `set_level` | lighting2 uniquement (0-15 natif) |
| `open` / `close` / `stop` | blinds1 uniquement |

---

## T7. Mappage des Protocoles (réel — 3 protocoles émetteurs)

### T7.1 Protocoles → Classes Transmitter (réel)

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

### T7.2 Résolution des Descripteurs de Protocole

Les descripteurs de transmission (subtype exact attendu par la bibliothèque) sont résolus
dynamiquement via `rfxcom.protocols[receiverTypeCode]` (accès non déclaré, `as any`) — pas une
table statique en dur dans le code applicatif comme documenté jusqu'à v1.2 (`rfxcom.lighting1.IMPULS`
etc. écrits en dur). Un nom de protocole inconnu du catalogue matériel rapporté est silencieusement
filtré (`.filter(d => !!d)`), avec avertissement si la liste résultante est vide.

---

## T8. Persistance et Validation

### T8.1 ⚠️ Perte silencieuse des champs d'état au rechargement (le plus important gap de ce document)

> **📌 Mise à jour v6.0 (19/09/2026)** : cette section, écrite le 10/08/2026, décrit ce défaut comme
> non corrigé. Un correctif réel est intervenu depuis pour `lastValue`/`commandDeviceId` (devices) et
> `lastOn`/`lastLevel` (récepteurs) — voir **Partie 1 §9.2/§9.2bis/§9.2ter/§20** (15/08/2026 pour les
> devices ; le correctif récepteurs, antérieur au 07/08/2026, avait déjà été noté stale dans le
> tableau de la Partie 1 §20). Le texte ci-dessous reste correct pour l'analyse de la cause racine
> (mécanisme Zod `strip`), seul le statut "non corrigé" est dépassé.

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

### T8.2 Validation à la sauvegarde

`rfxComDevicesConfigSchema` inclut un `.refine()` global garantissant l'unicité des `receiverId` à
travers `rfxcom_receivers` — la seule validation transversale du fichier (le reste est structurel,
par type de device/récepteur/scène).

---

## T9. Configuration Requise

### T9.1 Configuration Technique Réelle (remplace l'exemple fictif v1.2)

> ⚠️ Il n'y a **pas** de `config/technical-config.yaml`, ni de champs
> `transceiverType`/`serialTimeoutMs`/`discoveryIntervalMs`/`receivers`/`scenes`/`appairages` au
> niveau de la config générale. Voir `fonctionnelles-rfxcom_specs` §8.1 pour les **7 champs réels**
> de `data/rfxcom/config.yaml` (`enabled`, `port`, `baudRate`, `bridgeInstance`,
> `devicesConfigFile`, `autoDiscovery`, `enabledHardwareProtocols`).

### T9.2 Récepteur RFXCOM (réel)

Voir `fonctionnelles-rfxcom_specs` §10.1 et `recepteurs-emetteurs-rfxcom_specs` §10 pour la
structure réelle et complète (`ReceiverSwitchConfig`/`ReceiverLightConfig`/`ReceiverCoverConfig`/
`ReceiverSceneConfig`) — l'exemple v1.2 (`deviceClass`, `subunitCode`, `groupCode`, `inverted`,
`haExposed`, `quoi`, `ou` comme champs plats du récepteur) ne correspond à aucune structure
existante dans le code.

---

## T10. Gestion des Erreurs

### T10.1 Codes d'Erreur Réellement Émis

Sur les 7 codes documentés jusqu'à v1.2, **seuls 2 sont effectivement émis par le code** :

| Code | Description | Émis ? |
|------|-------------|-----------|
| `RFXCOM_CONNECTION_ERROR` | Erreur de connexion au transceiver (échec initial ou reconnexion à chaud) | ✅ |
| `RFXCOM_COMMAND_FAILED` | Échec de l'exécution d'une commande (transmission, push protocoles) | ✅ |
| `RFXCOM_TRANSCEIVER_NOT_INITIALIZED` / `_NOT_CONNECTED` / `_UNSUPPORTED_PROTOCOL` / `_UNSUPPORTED_ACTION` / `_DEVICE_NOT_FOUND` | — | ❌ jamais émis dans le code actuel |

### T10.2 Format des Erreurs
Inchangé — voir `specs-erreurs-v1.0.md`.

---

## T11. Séquence de Démarrage/Arrêt

### T11.1 Démarrage (réel, détaillé — remplace le §11.1 générique v1.2)

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

**⭐ v1.5 — Boucle de reconnexion automatique (5s)** :
```typescript
this.transceiver.onConnectionChange((connected) => {
  this.emitStatus();
  if (connected) this.stopReconnectLoop();
  else this.startReconnectLoop();
});
```
Enregistré avant le tout premier `connect()` — un échec de connexion initial déclenche donc aussi
`notifyConnection(false, ...)` côté `RfxComTransceiver`, et donc la boucle, sans code dédié dans le
bloc `catch` de `start()`. `startReconnectLoop()` est idempotent (`setInterval`, 5000ms) ;
`attemptAutoReconnect()` (une itération) : `if (transceiver.isConnected()) { stopReconnectLoop(); return; }`,
sinon `transceiver.disconnect()` (referme une instance orpheline éventuelle) puis
`transceiver.connect({port: resolvePort(), baudRate})` — échec silencieux, nouvelle tentative dans
5s. `resolvePort()` redétecte via `PortDetector` à chaque tentative (le port `/dev/serial/by-id`
peut réapparaître sous le même chemin stable). Nettoyée dans `stop()`.

### T11.2 Arrêt

```typescript
async stop(): Promise<void> {
  transceiver.disconnect();
  eventBus.emitGeneric('integration:bridge:unregister', ...);
  emitStatus();
}
```
Ne republie/retire **pas** les découvertes MQTT à l'arrêt.

### T11.3 Reconnexion à Chaud (réel — remplace le mécanisme fictif "AppService redémarre tout le
module")

> ⚠️ **AppService ne redémarre plus le module entier** à chaque sauvegarde de configuration. Ce
> comportement a été désactivé côté RFXCOM (comportement générique du socle conservé pour les
> autres modules qui n'implémentent pas leur propre reconnexion).

Voir `fonctionnelles-rfxcom_specs` §8.5 pour le détail complet (`reconnectTransceiverIfConfigChanged`) :
comparaison port effectif + `baudRate` avant/après, déconnexion/réinitialisation du verrou
anti-boucle protocoles/reconnexion si changement détecté, sans toucher au `bridgeInstance` ni
republier la découverte.

---

## T12. Tests et Validation

### T12.1 Scénarios de Test (mis à jour)

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

### T12.2 Validation de la Configuration

Voir `config-schema.ts` (§8.1 de `fonctionnelles-rfxcom_specs`) et `devices-config-schema.ts`
(§8.2 de ce document) — pas de méthode `validateRfxComConfig` séparée, la validation Zod est
appliquée directement au chargement/à la sauvegarde.

---

## T13. Limites et Contraintes

### T13.1 Limites Réelles de l'Intégration

| Limite | Impact | Solution |
|--------|--------|----------|
| Seuls lighting1/lighting2/blinds1 peuvent transmettre | Un récepteur avec `primaryEmitter` Lighting4/5/6 ne peut envoyer aucune commande | Limite de la bibliothèque elle-même, pas de contournement |
| Aucune option `timeout`/`concurrency` passée au constructeur | Pas de contrôle applicatif sur ces paramètres (comportement par défaut de la bibliothèque) | Non ajustable actuellement |
| `RFXMeter`/Elec sans bit de filtrage matériel | Impossible de filtrer cette catégorie de protocoles | Acceptée |
| `lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` strippés au rechargement (§8.1) | Cause racine de la rafale OFF à chaque redémarrage | Non corrigé — nécessiterait d'étendre le schéma Zod |
| ACK = écriture port série, pas confirmation RF433 | Toute commande reste optimiste, pas de garantie de réception par le device physique | Acceptée, documentée |

### T13.2 Protocoles Non Supportés (transmission)
`lighting4`, `lighting5`, `lighting6`, `security1` : réception uniquement, aucun transmitter
disponible dans le code applicatif actuel.

### T13.3 Contraintes Matérielles
- Le transceiver doit être branché avant/pendant le démarrage (détection automatique tolère un
  branchement tardif suivi d'une reconnexion à chaud, §11.3).
- Permissions du port série appropriées (`dialout` ou équivalent).
- `baudRate` cohérent avec le matériel (38400 par défaut).

---

## T14. Annexes

### T14.1 Références
- **[Bibliothèque rfxcom npm](https://www.npmjs.com/package/rfxcom)**
- **[fonctionnelles-rfxcom_specs_v5.12.md](#1-introduction)** ⭐
- **[techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.33.md)** ⭐
- **[recepteurs-emetteurs-rfxcom_specs_v5.4.md](#r1-introduction)** ⭐

### T14.2 Glossaire

| Terme | Définition |
|-------|------------|
| Transceiver | Appareil RFXtrx433 qui émet/reçoit les signaux RF433 |
| Transmitter | Classe de la bibliothèque `rfxcom` permettant d'envoyer des commandes pour un protocole spécifique — seuls Lighting1/Lighting2/Blinds1 en ont un côté applicatif |
| protocolsPushGate | Verrou retardant la première découverte MQTT jusqu'à la tentative de push des protocoles matériel |
| ACK (accusé de réception) | Confirmation d'écriture sur le port série, PAS de réception RF433 par le device physique |

### T14.3 Exemple Complet (réel)

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

### T14.4 Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-07-11 | Mistral Vibe | Version initiale - Intégration de la bibliothèque rfxcom npm |
| 1.2 | 2026-07-17 | Mistral Vibe | Démarrage automatique via AppService, injection `IAppConfigProvider`, traces détaillées |
| 1.4 | 2026-08-10 | Claude | **Second déclencheur de découverte** (§11.1) — listener `integration:rfxcom:ha:online` rappelant `publishInitialDiscoveries()`, alimenté par le birth message MQTT natif de HA. Voir `fonctionnelles-rfxcom_specs` v5.11 et `techniques-socle-ha-mqtt_specs` §8.5.4bis. Ancienne version v1.3 archivée. |
| 1.5 | 2026-08-10 | Claude | **Vérification `isConnected()` + journal des ordres** (§6.1) — `applyReceiverCommand()` refuse tout envoi si le transceiver n'est pas connecté, chaque ordre journalisé (`recordOrder()`, `rfxcom:orders:list`). **Boucle de reconnexion automatique** (§11.1, 5s) sur `onConnectionChange(connected=false)`. Voir `fonctionnelles-rfxcom_specs` v5.12. Ancienne version v1.4 archivée. |
| 1.3 | 2026-08-03 | Claude | **Réécriture complète des sections décrivant l'API de la bibliothèque `rfxcom`** (§2-§8, §11, §13), qui documentaient une API fictive jamais celle réellement publiée (pas d'événement générique `'device'`, pas de `'connect'`/`'error'` génériques, options du constructeur réduites à `{debug}`, dispatch par `switch` sur le protocole et non `instanceof`, échelle de dim réelle 0-15). Nouvelle §8 "Persistance et Validation" documentant la cause racine, jusqu'ici non identifiée dans les specs, de la rafale de commandes OFF à chaque redémarrage (`lastOn`/`lastLevel`/`lastValue`/`commandDeviceId` écrits en YAML mais strippés au rechargement par le schéma Zod). §11.1/§11.3 réécrites (verrou `protocolsPushGate`, reconnexion à chaud propre à RFXCOM plutôt que redémarrage du module entier par AppService). Section "Communication Inter-Applications" (§9 de la v1.2, jamais implémentée, doublon de numérotation avec l'ancienne §9) retirée de ce document — voir l'annexe correspondante dans `fonctionnelles-rfxcom_specs_v5.12.md` §22.3, qui la documente une seule fois pour l'ensemble du module RFXCOM avec la mention explicite "non implémentée". |

---

*Conforme à [fonctionnelles-rfxcom_specs_v5.12.md](#1-introduction), [techniques-socle-ha-mqtt_specs_v4.19.md](techniques-socle-ha-mqtt_specs_v4.33.md) et [nommage_specs_v1.0.md](nommage_specs_v1.0.md)*

---

# Partie 3 — Récepteurs, Émetteurs et Scènes

## R1. Introduction

### R1.1 Objectif
Ce document **complète** les [spécifications principales](#1-introduction) en
détaillant la gestion des **récepteurs logiques** et **émetteurs physiques RFXCOM**.

### R1.2 Périmètre
| Inclus | Exclus |
|--------|--------|
| Récepteurs déclarés via fichier YAML | Gestion matériel RFXCOM |
| Émetteurs (devices Lighting1/2/4/5/6) | Implémentation bas niveau de la bibliothèque `rfxcom` |
| Appairage émetteurs ↔ récepteurs (N↔N) | — |
| Scènes (SceneManager/SceneExecutor) | — |

### R1.3 Public Cible
- Développeurs implémentant RFXCOM
- Intégrateurs Home Assistant
- Mainteneurs du socle HA-MQTT

### R1.4 Conformité
- [nommage_specs_v1.0.md](nommage_specs_v1.0.md) (format `quoi---ou--ou`)
- [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.33.md) (architecture 5 couches)
- [fonctionnelles-rfxcom_specs](#1-introduction) (spécifications principales)

---

## R2. Référentiel de Nommage

### R2.1 Format du `name` (Obligatoire)
```
quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere
```

### R2.2 Nommage Technique (réel — corrigé v5.4)

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

### R2.3 QUOI = Type Fonctionnel Pur ⭐

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

### R2.4 Règle de Transmission vers HA

**⭐ Depuis v5.4 (application) — remplace la règle QUOI/OÙ documentée jusqu'à v5.3 de ce document** :
les données ne sont transmissibles vers HA **que si** `transmitToHa: true` est coché pour ce
device/récepteur/scène (case à cocher dans les fenêtres modales) — voir
`fonctionnelles-rfxcom_specs` §9.1.

---

## R3. Définitions Clés

### R3.1 Terminologie

| Terme | Définition | Type HA | Nom Technique |
|-------|------------|---------|---------------|
| **Device RFXCOM** | Appareil **physique** RFXCOM (capteur OU émetteur) | variable | `<protocole>_<subType>_<sensorId>[_<unitCode>]` |
| **Émetteur** | Device **Lighting1/2/4/5/6** qui **émet** des signaux RF433 | **binary_sensor** (par défaut) | idem |
| **Récepteur** | Entité **logique** déclarée dans le fichier YAML, **associée à des émetteurs** | switch, light, cover | `recepteur_<timestamp>` |
| **Scène** | Entité logique orchestrant plusieurs récepteurs | `device_automation` (déclencheur) | `scene_<timestamp>` |
| **primaryEmitter** | **Émetteur principal** d'un récepteur, utilisé pour envoyer les commandes RF433 | - | - |
| **Appairage** | Lien entre émetteur et récepteur (**N↔N**), stocké dans `rfxcom_receivers[].emitters[]` | - | - |

### R3.2 Règles Fondamentales

1. **unique_id contient TOUJOURS protocole+subType+sensorId(+unitCode)** pour TOUS les devices
2. **QUOI = type fonctionnel pur** : "Température", "Humidité", "Courant", "Bouton" (PAS "Température Salon")
3. **QUOI auto-déterminé** depuis type/subType RFXCOM
4. **Émetteurs Lighting = binary_sensor par défaut** : ils émettent on/off
5. **Appairages dans le fichier YAML** : chaque récepteur contient sa liste d'émetteurs dans `emitters[]`
6. **primaryEmitter obligatoire** (récepteurs commandables) : détermine le device RFXCOM cible pour les commandes HA
7. **Relations N↔N**, avec une asymétrie importante — voir §4.4
8. **Lighting2 variateur** : l'information "variateur" vient **exclusivement** de `isDimmable`

---

## R4. Architecture Récepteurs ↔ Émetteurs

### R4.1 Modèle Conceptuel (5 Couches)
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

### R4.2 Mapping N↔N (Appairages)

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

### R4.3 ⭐ Persistance de `lastOn`/`lastLevel` — réponse définitive (nouveau v5.4)

> **📌 Mise à jour v6.0 (19/09/2026)** : cette section, écrite le 03/08/2026, conclut que le défaut
> n'est "non corrigé à ce jour". Un correctif réel est intervenu depuis (avant le 07/08/2026 pour
> `lastOn`/`lastLevel` — voir **Partie 1 §20**, qui note ce même retard de mise à jour) : ces champs
> sont désormais déclarés au schéma Zod et survivent au rechargement. L'analyse de la cause racine
> ci-dessous reste correcte, seule la conclusion "non corrigé" est dépassée.

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

### R4.4 ⭐ Asymétrie `primaryEmitter` / `emitters[]` (nouveau v5.4)

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

## R5. Fichier de Configuration Centralisé

### R5.1 `config-rfxcom-devices-v1.0.yaml`

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

### R5.2 Règles du Fichier

| Règle | Description |
|-------|-------------|
| **Format** | YAML strict |
| **Chargement** | Au démarrage du service RFXCOM |
| **Sauvegarde** | À chaque modification (via UI) |
| **Validation** | Schéma Zod obligatoire, **résultat filtré effectivement utilisé au chargement** — voir §4.3 pour la conséquence sur `lastOn`/`lastLevel` |

### R5.3 Schéma de Validation Zod (réel — `devices-config-schema.ts`)

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

## R6. Modules Dédiés

### R6.1 Architecture Modulaire

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

### R6.2 Interface Commune (réelle)

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

### R6.3 ReceiverLight (avec variateur)

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

### R6.4 ReceiverSwitch

```typescript
interface ReceiverSwitchConfig extends BaseReceiverConfig {
  type: 'switch';
  lastOn?: boolean;   // ⚠️ jamais relu après redémarrage, voir §4.3
}
```
**Commandes :** on, off, toggle.

### R6.5 ReceiverCover (avec délais)

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

## R7. MQTT Discovery

### R7.1 Discovery pour Device RFXCOM (Capteur ou Émetteur) — corrigé v5.4

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

### R7.2 Discovery pour Récepteur

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

### R7.3 ⭐ Discovery pour Scène (nouveau détail v5.4)

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

## R8. Flux de Données

### R8.1 Initialisation

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

### R8.2 Traitement Message RF433 (Émetteur)

```
Message RF433 reçu
  → RfxComTransceiver normalise (type/subType/sensorId/unitCode)
  → DeviceManager construit l'emitterId (protocole_subType_sensorId[_unitCode])
  → ReceiverManager.findReceiversForEmitter(emitterId) — recherche UNIQUEMENT dans emitters[] (§4.4)
  → Pour chaque récepteur trouvé : applyEmitterCommand(action, value?) puis persistance (§4.3)
  → Si emitterId inconnu de rfxcom_devices : ajout automatique (transmitToHa: false par défaut)
```

### R8.3 Traitement Commande MQTT (HA → Récepteur → Device RFXCOM)

```
Commande MQTT reçue (topic .../set)
  → RfxComService résout le récepteur cible depuis le deviceId
  → Récupère primaryEmitter (PAS via emitters[], voir §4.4)
  → module.translateHaCommand(command, value?) → { action, value? }
  → RfxComTransceiver envoie la trame RF433 au device du primaryEmitter
  → Mise à jour EXPLICITE de l'état interne + lastOn/lastLevel (pas d'écho automatique, §4.4)
  → Publication de l'état MQTT du récepteur
```

### R8.4 Événements EventBus Spécifiques à RFXCOM

Voir `fonctionnelles-rfxcom_specs` §12.3 pour la liste complète et à jour des événements
Socket.io réellement implémentés (server↔client). Côté EventBus interne (module↔application), les
événements utilisés sont `integration:rfxcom:command` (HA→app), `integration:rfxcom:bridge:connection`
(statut bridge), `integration:bridge:register`/`:unregister` — génériques au socle, pas spécifiques
à un vocabulaire RFXCOM séparé comme documenté jusqu'à v5.3 (`rfxcom:device:detected`,
`rfxcom:receiver:command`, `rfxcom:appairage:*` en tant qu'événements EventBus n'existent pas ;
seuls leurs équivalents Socket.io existent, voir §11).

---

### R8.5 Topics MQTT Spécifiques à RFXCOM

#### R8.5.1 Encodage du `deviceId` RFXCOM

Pour un **device physique**, le `deviceId` utilisé dans les topics d'état/commande encode le
protocole complet :
```
{protocole}_{sousProtocole}__{sensorId}_{unitCode}
```
**Exemple complet :** `lighting2_ac__0x017340ca_10`

Pour un **récepteur logique**, `deviceId` = son `receiverId` directement.

> ⚠️ Ce `deviceId` est **distinct** de `unique_id`/`object_id` (`<protocole>_<subType>_<sensorId>`,
> voir §2.2) utilisé dans le topic de découverte HA.

#### R8.5.2 Topics d'État et de Commande (App ↔ HA) — ⭐ corrigé v5.4, plus de slash initial

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `rfxcom/{bridgeInstance}/{deviceId}/state` | App → HA | `{ "state": "ON"\|"OFF" }` | 0 | false |
| `rfxcom/{bridgeInstance}/{deviceId}/set` | HA → App | `{ "state": "ON"\|"OFF", "brightness"?: 0-255 }` | 1 | false |

> ⚠️ **Les exemples précédents de ce document (jusqu'à v5.3) portaient tous un `/` initial erroné**
> (`/rfxcom/...`) — un premier niveau de topic MQTT vide, non standard. Le format générique du
> socle avait déjà été corrigé dans `techniques-socle-ha-mqtt_specs` v4.16 (29/07/2026), mais cette
> correction n'avait jamais été répercutée dans les exemples spécifiques à RFXCOM de ce document.

#### R8.5.3 Topics de Découverte RFXCOM (App → HA)

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `homeassistant/{component}/{object_id}/config` | App → HA | Message de discovery (§7) | 1 | true |
| `homeassistant/{component}/{object_id}/attributs` | App → HA | `{"attributs_taxonomie": {...}}`, publié uniquement à la (re)découverte | 1 | true |

#### R8.5.4 LWT (Last Will and Testament)

| Topic | Direction | Payload | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `rfxcom/{bridgeInstance}/status` | App → Broker | `"online"` / `"offline"` | 1 | true |

#### R8.5.5 Retrait de Découverte

Voir `fonctionnelles-rfxcom_specs` §17.3 — publication d'une chaîne vide retenue sur le topic de
découverte, à la désélection (`transmitToHa: true → false`) ou à la suppression.

---

## R9. Exemples Complets

### R9.1 Installation Résidentielle (identifiants réels)

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

## R10. Types TypeScript

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

## R11. Intégration Interface Web

### R11.1 Données Exposées via Socket.io

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

### R11.2 Workflow UI - Configuration Complète

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

## R12. Annexes

### R12.1 Checklist d'Implémentation
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

### R12.2 Conformité
- ✅ [nommage_specs_v1.0.md](nommage_specs_v1.0.md)
- ✅ [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.33.md)
- ✅ [fonctionnelles-rfxcom_specs](#1-introduction)

### R12.3 Références
- [Spécifications Principales RFXCOM](#1-introduction)
- [Spécifications Implémentation RFXCOM](#t1-introduction)
- [Spécification de Nommage **OBLIGATOIRE**](nommage_specs_v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.33.md) ⭐

### R12.4 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 → 4.0 | 2026-07-07 → 07-08 | Mistral Vibe | Version initiale, intégration nommage, corrections techniques |
| 5.0 | 2026-07-09 | Mistral Vibe | Fichier YAML centralisé, primaryEmitter, émetteurs dans récepteur |
| 5.1 | 2026-07-21 | Claude | Refonte topics MQTT §8.5 (bridge_instance, encodage deviceId) |
| 5.2 | 2026-07-21 | Claude | Implémentation réelle des Scènes, `ReceiverSceneConfig` ne dérive plus de `BaseReceiverConfig` |
| 5.3 | 2026-07-27 | Claude | Mise à jour du workflow UI (taxonomie 5 champs, fenêtres modales, libellés lisibles) |
| 5.4 | 2026-08-03 | Claude | **Rattrapage complet code/specs** : format réel du `uniqueId` (protocole+subType+sensorId+unitCode), réponse définitive sur la persistance `lastOn`/`lastLevel` (écrits mais strippés au rechargement — cause racine de la rafale OFF, §4.3), asymétrie `primaryEmitter`/`emitters[]` documentée (§4.4), correction du slash initial erroné sur tous les topics (§8.5.2), détail complet de la découverte de scène avec `type`/`subtype` requis (§7.3), schéma Zod réel à jour (§5.3, 8 types de device, contrainte d'unicité `receiverId`), `receiverId` en timestamp et non séquentiel (§2.2). |

---

*Document conforme à [nommage_specs_v1.0.md](nommage_specs_v1.0.md) et [techniques-socle-ha-mqtt_specs](techniques-socle-ha-mqtt_specs_v4.33.md)*
