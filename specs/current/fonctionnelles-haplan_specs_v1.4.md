# Spécifications Fonctionnelles - Module HAPLAN

*Version 1.4 - 28 Août 2026*
*Nouvelle §17 "Génération de cartes Plan Home Assistant (Lovelace)" — conception soumise par
l'utilisateur pour une troisième sortie de HAPlan (après l'interaction HA directe et la génération
ESPHome) : générer et envoyer vers HA une configuration de carte Plan Lovelace, depuis la même
modélisation de plans/positions déjà existante (§4). Aucun code écrit à ce stade — plusieurs points
restent à trancher avant implémentation (§17.7), notamment la police d'icônes réellement utilisée et
les capacités exactes de la carte Plan Lovelace côté HA.*

*Version 1.3 - 15 Août 2026*
*Met à jour la v1.2 : nouvelle §8.10 "Écran mural physique (ESP32-S3)" — veille du rétroéclairage
après 30s d'inactivité tactile (rallumé au premier tap) et retrait du texte des coordonnées x/y
(le marqueur "X" rouge reste, en permanence).*

*Version 1.2 - 13 Août 2026*
*Met à jour la v1.1 : bouton "Déployer sur l'écran" (§3.6, §8.9, §13) qui envoie le plan affiché
à la nouvelle application `applications/espdisplay` (voir
`fonctionnelles-espdisplay_specs_v1.0.md`) pour régénération/compilation/déploiement sur un écran
ESP physique — premier exemple de communication inter-applications initiée par HAPLAN via
l'EventBus générique (`emitGeneric`/`onGeneric`, même pattern que
`integration:bridge:register`).*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture Générale](#2-architecture-générale)
3. [Backend — `HaplanService`](#3-backend--haplanservice)
    - 3.6 [Déploiement sur écran ESP (v1.2)](#36-déploiement-sur-écran-esp-v12)
4. [Persistance des Plans et Positions](#4-persistance-des-plans-et-positions)
5. [Upload de Plan (exception REST)](#5-upload-de-plan-exception-rest)
6. [Arbre de Taxonomie pour le Sélecteur d'Entités](#6-arbre-de-taxonomie-pour-le-sélecteur-dentités)
7. [Accès Externe et Page Dédiée](#7-accès-externe-et-page-dédiée)
8. [Frontend — Bootstrap et Composants](#8-frontend--bootstrap-et-composants)
    - 8.9 [Bouton de déploiement écran (v1.2)](#89-bouton-de-déploiement-écran-v12)
    - 8.10 [Écran mural physique (ESP32-S3, v1.3)](#810-écran-mural-physique-esp32-s3-v13)
9. [Modèle d'Objets HA (icônes du plan)](#9-modèle-dobjets-ha-icônes-du-plan)
10. [Fenêtres Contextuelles (popups de contrôle)](#10-fenêtres-contextuelles-popups-de-contrôle)
11. [Nom d'Entité Dérivé de la Taxonomie](#11-nom-dentité-dérivé-de-la-taxonomie)
12. [Menu Escamotable et Contrôles Flottants](#12-menu-escamotable-et-contrôles-flottants)
    - 12.1 [Navigation circulaire entre plans](#121-navigation-circulaire-entre-plans-v11)
    - 12.2 [Échelle icônes/textes réglable](#122-échelle-icônestextes-réglable---plan-scale-v11)
13. [Socket.io](#13-socketio)
14. [Configuration](#14-configuration)
15. [Limites, Bugs Connus et Code Mort](#15-limites-bugs-connus-et-code-mort)
16. [Arborescence des Programmes](#16-arborescence-des-programmes)
17. [Génération de cartes Plan Home Assistant (Lovelace) — conception, v1.4](#17-génération-de-cartes-plan-home-assistant-lovelace--conception-nouveau-v14)
18. [Annexes](#18-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/haplan` est une interface tactile à base de plans de maison : l'utilisateur place des
icônes d'entités Home Assistant **déjà existantes** sur des images de plans uploadées, les
positionne par glisser-déposer, et clique dessus pour ouvrir une fenêtre de contrôle. C'est un
**portage** d'un projet standalone antérieur, `haplanserver` (github.com/zdid/haplanserver),
adapté au socle EventBus/Socket.io/MQTT/WS de ce projet — pas une conception ex nihilo.

**Principe fondamental (explicite dans l'en-tête du code)** : HAPLAN **ne publie aucune découverte
MQTT** — contrairement à RFXCOM/EVOO7/AREXX/NOMMAGE, ce n'est pas une intégration matérielle.
`HaStructureRegistry` (Mode A) fournit l'instantané initial et l'arbre de taxonomie, `HaWsClient`
fournit l'état en direct et le canal de commande.

### 1.2 Public visé et positionnement

`audience: 'end-user'` — HAPLAN est pensée pour un **usage quotidien par tous**, contrairement aux
autres applications (`audience: 'configuration'`), et est la **seule catégorie candidate à une
exposition externe** (voir §7). Elle a sa propre page dédiée réelle (`dashboard.html`), pas une
intégration SPA dans le Shadow DOM du core comme les tableaux de bord habituels.

### 1.3 Historique de développement

4 commits seulement à ce jour :
1. Application initiale — plans avec icônes tactiles, pilotage HA existant.
2. Correction d'une boucle de messages au déplacement d'un objet sur le plan.
3. Menu escamotable + nom d'entité issu de la taxonomie QUOI/OÙ.
4. Amélioration du contraste des lumières éteintes sur le plan.

Plusieurs commentaires du code font référence à un plan de portage en "Phase 1 / Phase 2 / Phase
3" — les trois phases sont aujourd'hui implémentées, mais certains commentaires n'ont pas été mis
à jour en conséquence (voir §15).

---

## 2. Architecture Générale

```
┌─────────────────────────────────────────────────────────────────┐
│                    COUCHE PRÉSENTATION                    │
│   Page dédiée réelle (dashboard.html), pas de SPA          │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE APPLICATION                     │
│   AppService · EventBus · SocketBridge                    │
├─────────────────────────────────────────────────────────────────┤
│                     COUCHE MÉTIER                         │
│   HaplanService — pas de découverte MQTT                   │
├─────────────────────────────────────────────────────────────────┤
│                       COUCHE HA (Mode A uniquement)         │
│   HaStructureRegistry (instantané initial) · HaWsClient      │
│   (état en direct + commandes)                              │
└─────────────────────────────────────────────────────────────────┘
```

**Manifeste** (`HAPLAN_APP`, `src/domain/index.ts`) : `id: 'haplan'`, `type: 'standalone'`,
`audience: 'end-user'`, `configurable: true`, **`requiredMqtt: false`**, **`requiredHaWs: true`**,
`configSection: 'haplan'`. Contrairement à toutes les autres applications métier de ce projet,
HAPLAN a besoin de Mode A (WebSocket HA) et **pas** de MQTT.

**Formulaire générique** : `HAPLAN_UI_METADATA.fields = []` — délibérément vide (commentaire du
code : *"rien à paramétrer via le formulaire générique (juste `enabled`), la page dédiée
(dashboard) est le vrai point d'entrée"*).

**Factories** : `createHaplanService(eventBus, logger, configProvider, haStructureRegistry,
haWsClient)` — 5 paramètres, `haStructureRegistry`/`haWsClient` potentiellement `undefined` si
`ha.ws_enable: false` (le service démarre quand même, dégradé — voir §3).

---

## 3. Backend — `HaplanService`

### 3.1 Séquence de démarrage (`start()`)

1. `configFileManager.load()` — charge le YAML des plans.
2. `recomputeTrackedEntityIds()` — reconstruit l'ensemble des `entity_id` référencés par au moins
   une position sur au moins un plan.
3. `setupSocketEventListeners()` (client→serveur) + `registerSocketEvents()` (annonce au
   `SocketBridge`, voir §13).
4. Abonnement interne à `haplan:internal:floorplan:create` — signal émis uniquement par la route
   REST d'upload (§5), **volontairement absent** de la liste des événements Socket.io exposés au
   client (aucun client ne peut le déclencher directement).
5. Si `haWsClient` existe : `haWsClient.onStateChanged(entity => handleHaStateChanged(entity))`.
   Sinon : avertissement *"HaWsClient indisponible (ha.ws_enable=false ?)"* — le service démarre
   quand même, mais aucune commande ni aucun état en direct ne sera jamais disponible.
6. `emitStatus()` + `emitTaxonomyTree()`.

`stop()` se contente de journaliser — **aucun nettoyage réel** (voir §15, limitation projet-wide
sur la désactivation d'application).

### 3.2 Entités suivies (`trackedEntityIds`)

Ensemble de tous les `entity_id` référencés par au moins une position, sur au moins un plan —
recalculé au chargement, après une mise à jour de positions, et après la suppression d'un plan.
Sert de **garde-fou de sécurité** pour les commandes (§3.4) : seule une entité déjà placée sur un
plan peut recevoir une commande envoyée par un client.

### 3.3 État en direct et instantané initial

- **Instantané initial** (`emitEntitiesStateBulk`) : lit `haStructureRegistry.getAllEntities()`
  (déjà peuplé par `AppService` au démarrage — pas de requête HA redondante), filtre sur les
  entités suivies, émet `haplan:entities:state:bulk`. Déclenché uniquement à la demande de la
  liste des plans et après une mise à jour de positions (pour qu'une entité tout juste ajoutée
  reçoive immédiatement son état).
- **État en direct** (`handleHaStateChanged`) : filtre le flux `onStateChanged` de `HaWsClient` sur
  `trackedEntityIds` (pas le firehose HA complet), réémet `haplan:entity:state`.

### 3.4 Exécution de commande

`handleEntityCommand({entity_id, domain, service, serviceData?})` :
1. Sans `haWsClient` disponible → erreur `HAPLAN_HA_UNAVAILABLE`.
2. **Défense en profondeur** : l'entité doit appartenir à `trackedEntityIds`, sinon
   `HAPLAN_UNKNOWN_ENTITY` — *"jamais une commande arbitraire vers une entité HA quelconque envoyée
   par un client malveillant"* (commentaire du code).
3. `haWsClient.sendCommand(domain, service, {entity_id}, serviceData)` — appel WebSocket direct
   (`call_service`), pas de MQTT.
4. Échec → `HAPLAN_COMMAND_FAILED`.

### 3.5 Codes d'erreur

`HaplanErrorCode` : `HAPLAN_HA_UNAVAILABLE` | `HAPLAN_UNKNOWN_ENTITY` | `HAPLAN_COMMAND_FAILED` |
`HAPLAN_SAVE_FAILED` | `HAPLAN_DEPLOY_BUSY` | `HAPLAN_DEPLOY_FAILED` (v1.2, voir §3.6)
(`applications/core/src/types/errors.ts`).

### 3.6 Déploiement sur écran ESP (v1.2)

`handleFloorplanDeploy({floorplanId})` — déclenché par l'événement client `haplan:floorplan:deploy`
(§13), délègue **entièrement** la régénération/compilation/déploiement à la nouvelle application
`applications/espdisplay` (voir `fonctionnelles-espdisplay_specs_v1.0.md`), via l'EventBus
générique partagé — **aucune dépendance de compilation** entre les deux applications (même pattern
que `ArexxService`/`Evoo7Service` → `IntegrationBridge`, `integration:bridge:register`) :

1. **Verrou simple** (`deployInProgress: boolean`, un seul déploiement à la fois — ESPDISPLAY
   partage un unique conteneur Docker `esphome`) : si un déploiement est déjà en cours, rejet
   immédiat `HAPLAN_DEPLOY_BUSY`, aucun événement `espdisplay:deploy-floorplan` émis. Pas de file
   d'attente (voir limitation §15).
2. Plan inconnu → `HAPLAN_UNKNOWN_ENTITY` (même code que les autres opérations sur un
   `floorplanId` absent, §3.4/§4.4).
3. Sinon : pose le verrou, émet `haplan:floorplan:deploy:started` (accusé de réception immédiat
   pour l'UI, §8.9), puis `espdisplay:deploy-floorplan({floorplanId})` sur l'EventBus générique.
4. **Écouteur unique**, enregistré une seule fois dans `start()` (pas par requête) : sur
   `espdisplay:deploy-result({floorplanId?, ok, message, durationMs})`, lève le verrou et
   retransmet tel quel aux clients via `haplan:floorplan:deploy:result`. `message` contient les
   dernières lignes de sortie du pipeline Python (généré par `applications/espdisplay`) — utile en
   cas d'échec, volumineux en cas de succès (non tronqué côté HAPLAN).

Durée observée en conditions réelles : ~15s (cache de compilation ESPHome chaud) à ~65s (cache
froid, ex: après modification du template `haplan-display.yaml`).

---

## 4. Persistance des Plans et Positions

### 4.1 Fichier `data/haplan/config-haplan-floorplans-v1.0.yaml`

Schéma (`floorplans-config-schema.ts`) :
```yaml
floorplans:
  <floorplanId>:                  # clé = identifiant du plan, NON assaini (voir §15)
    filename: <nom de fichier image, assaini>
    positions:
      - entity_id: <string>
        x: <number|null>          # normalisé 0-1, null tant que non placé
        y: <number|null>
```

Même forme que le fichier d'origine de haplanserver (`client-floorplans.json`, conservé à titre de
référence/import sous `data/haplan/client-floorplans.json`, format légèrement différent).

`ConfigFileManager` : mêmes garanties que les autres applications (copie `.bak` avant écriture,
écriture atomique tmp→rename, fichier manquant → créé vide, erreur de validation Zod au chargement
→ démarrage avec une config vide sans toucher au fichier fautif).

### 4.2 Positions — toujours la liste complète, jamais un delta

**Point d'entrée unique** pour ajouter, déplacer ou retirer une icône : l'événement Socket.io
`haplan:floorplan:positions:update`, qui porte systématiquement la **liste complète** des
positions du plan concerné — jamais une modification incrémentale. Le serveur :
1. Conserve les positions précédentes en mémoire.
2. Remplace `floorplan.positions` par la nouvelle liste, sauvegarde.
3. **En cas d'échec d'écriture** : restauration en mémoire des positions précédentes,
   `HAPLAN_SAVE_FAILED`, réémission de la liste (le client recolle sur l'état serveur réel).
4. En cas de succès : `recomputeTrackedEntityIds()` + rediffusion de la liste des plans + de
   l'instantané d'état.

**Aucun équivalent serveur au `PositionManager` côté client** (§8) — la position n'est qu'un champ
du fichier de configuration du plan, remplacé en bloc à chaque sauvegarde.

### 4.3 Création d'un plan (upload, voir §5)

- Rejet si l'identifiant existe déjà.
- Extension déterminée depuis le MIME type (`image/png`→`.png`, `image/jpeg`→`.jpg`,
  `image/webp`→`.webp` — doit rester synchronisé avec la liste blanche du filtre `multer`).
- Le **nom de fichier** est assaini (`[^a-zA-Z0-9-_]` → `_`, repli sur `'plan'` si vide) —
  **mais la clé de la map (`floorplanId`) ne l'est pas** (voir limitation §15).
- Écriture de l'image, puis du YAML ; **si la sauvegarde YAML échoue, l'image déjà écrite est
  supprimée** (pas d'orphelin).

### 4.4 Suppression d'un plan

Retrait de l'entrée + sauvegarde ; en cas d'échec, l'entrée est **restaurée** en mémoire et
`HAPLAN_SAVE_FAILED` est renvoyé. Puis suppression du fichier image (best-effort, avertissement
seul en cas d'échec). Recalcule `trackedEntityIds` et rediffuse la liste des plans.

---

## 5. Upload de Plan (exception REST)

HAPLAN est la **deuxième exception volontaire** au principe "tout Socket.io" du socle (voir
`techniques-socle-ha-mqtt_specs` §5.7) — un upload de fichier binaire (image) est mal adapté à
Socket.io.

- **Fichiers statiques** : `/data/haplan/images/*` servi directement par Express — établit la
  convention `/data/{app}/...` pour du contenu écrit par l'utilisateur, distincte de
  `/applications/{appId}/...` qui ne sert que du code.
- **Route** : `POST /api/haplan/floorplans/upload` — `multer` en mémoire, limite **10 Mo**, liste
  blanche de types MIME (`image/png`, `image/jpeg`, `image/webp`).
  - Erreur de filtre/multer → **415**.
  - `file`/`floorplanId` manquant → **400**.
  - EventBus indisponible → **503**.
  - Sinon : émission de `haplan:internal:floorplan:create` (interne, jamais exposé aux clients
    Socket.io) et **réponse 200 `{success:true}` — un simple accusé de réception**. Le résultat
    réel (plan créé, ou `HAPLAN_SAVE_FAILED`) arrive **de façon asynchrone via Socket.io**, pas
    dans cette réponse HTTP.

---

## 6. Arbre de Taxonomie pour le Sélecteur d'Entités

### 6.1 Principe

`taxonomy-tree.ts::buildEntityPickerTree()` — la hiérarchie OÙ **ne vient pas** des areas HA
(structure plate, sans parent/enfant côté HA) mais de l'attribut `attributs_taxonomie`, déjà porté
par chaque entité publiée par les intégrations MQTT de ce projet (RFXCOM/EVOO7/AREXX/NOMMAGE).
Même source que `ArbreouquoiService::extractOuPathFromEntity`, mais **simplifiée à un seul niveau
OÙ** (le lieu le plus précis disponible) plutôt que la hiérarchie à 4 niveaux — pour reconstruire
exactement la forme attendue par le composant `EntitySelector` porté tel quel de haplanserver
(`{id, name, devices: [{id, name, entities: {}}]}` — **OÙ joue le rôle "Pièce", QUOI joue le rôle
"Appareil"**, aucun changement client nécessaire).

### 6.2 Résolution par entité

- `areaId` = `slug_precis || slug_lieu || slug_pere || slug_grand_pere || '__non_classe__'`
- `areaName` = `lieu_precis || lieu_principal || lieu_pere || lieu_grand_pere || 'Non classé'`
- `quoiId` = `slug_quoi || '__autre__'`, `quoiName` = `quoi || 'Autre'`

Résultat trié alphabétiquement par nom d'area. Émis (`emitTaxonomyTree`) sur **toutes** les
entités du référentiel (pas seulement celles déjà placées), au démarrage et sur demande.

---

## 7. Accès Externe et Page Dédiée

### 7.1 Routage réel (pas SPA)

`menu.entry.path = '/applications/haplan/presentation/haplan/dashboard.html'` — chemin de fichier
réel, pas la convention SPA `presentation/index.html`. `Sidebar.ts` (core) route tout
`entry.path` commençant par `/applications/` vers une **vraie navigation**
(`window.location.href = path`) plutôt que l'embarquement Shadow DOM habituel — mécanisme
générique documenté dans `techniques-socle-ha-mqtt_specs` §6.2, HAPLAN étant le cas d'usage
explicitement cité dans le commentaire du code source (`Sidebar.ts`).

### 7.2 Redirection racine pour instance mono-application

`GET /` teste d'abord si l'instance ne fait tourner qu'**un seul** module (hors `core`) et que ce
module a `audience: 'end-user'` — si oui, redirige directement vers son `menu.entry.path`. Sans
effet sur le déploiement actuel (toutes les applications tournent ensemble) ; prévu pour une future
instance dédiée exposée en externe, avec HAPLAN comme cas d'usage nommé explicitement dans les
commentaires du code.

### 7.3 Relation avec la porte OAuth2

**Aucune interaction spéciale.** HAPLAN ne contient aucun code lié à l'authentification — elle
hérite exactement de la même protection que toute autre route quand la porte OAuth2 est activée
(`web.auth.enabled`, voir `techniques-socle-ha-mqtt_specs` §5.6). Sa seule relation, indirecte, est
que `audience: 'end-user'` en fait la cible naturelle d'une instance externe dédiée, et qu'elle
sert d'exemple dans les commentaires de configuration de l'authentification
(`client_id: https://haplan.example.com/`).

---

## 8. Frontend — Bootstrap et Composants

### 8.1 Page (`dashboard.html`)

Structure : `.haplan-app` (colonne plein écran) contenant `.haplan-header` (menu escamotable, voir
§12) et `.haplan-body` (`position: relative`, contenant les contrôles flottants, le conteneur de
plan `#floorplan-container`, et le bandeau flottant de focus d'entité, voir §11). Deux panneaux
latéraux (`display:none` → `.active`) : sélecteur d'entité et formulaire de nouveau plan.

Dépendances : thème du core (`/styles/main.css`), Font Awesome 6.0.0 (CDN — dépendance héritée du
composant d'objets porté tel quel), sa propre copie du client Socket.io (page de navigation
complète, même pattern que les pages dédiées RFXCOM/EVOO7).

### 8.2 `dashboard-app.ts` — orchestration

- **File de sérialisation `showFloorplan()`** : corrige un bug réel (commit dédié) — deux appels
  concurrents à `showFloorplan()` (ex: relecture de la liste persistante des plans à la
  reconnexion Socket.io, pendant qu'un ajout d'entité en déclenche un autre) écrasaient le DOM
  fraîchement construit l'un de l'autre (`cleanup()` fait `innerHTML = ''`). Corrigé en chaînant
  chaque appel sur le précédent via une `Promise` de file d'attente.
- `EntitySelector` construit une fois, callback → ajout de l'entité sélectionnée au centre du plan
  (`{x:0.5, y:0.5}`).
- Réabonnement à la liste des plans : sélectionne le plan courant, **se rabat sur le premier plan
  disponible si le plan courant a été supprimé entre-temps**.
- Bascule mode édition, panneau sélecteur d'entité, panneau nouveau plan, bouton suppression de
  plan (confirmation native), indicateur de connexion (rafraîchi toutes les 3s).

### 8.3 `DataService` (côté navigateur)

Garde délibérément le même nom de classe et la même surface publique que celui de haplanserver
(pour que tous les fichiers "portés tels quels" compilent sans modification) — l'implémentation
interne utilise Socket.io (via le `SocketService` du core) au lieu du WebSocket brut d'origine.
Singleton accessible via `getDataService()`.

Caches internes : états par entité, plans, images préchargées, plan courant. Écoute
`haplan:floorplans:list` (reconstruit la map, sélectionne le premier plan si aucun courant,
précharge les images), `haplan:entities:state:bulk`, `haplan:entity:state`, `haplan:error`
(**console uniquement, jamais remonté à l'UI** — voir §15), `haplan:taxonomy:tree`.

Méthodes notables : `sendCommand()` (fire-and-forget, aucun accusé de réception attendu du
serveur), `uploadFloorplan()` (upload REST, §5), `deleteFloorplan()`,
`updatePositionsForFloorplan()` (toujours la liste complète, §4.2), `getTaxonomyDisplayName()`
(voir §11). `getEntity()`/`getAreaNameOfEntity()` restent des **stubs partiels** (voir §15).

### 8.4 `FloorPlanContainer` — orchestrateur par plan

Un `PositionManager` (client, §8.5), un `FloorPlan` (rendu image + surface de glisser-déposer,
§8.6) et un `ObjectManager` (registre des objets, création/mise à jour) par instance de plan
affiché.

`enableEditMode()`/`disableEditMode()` : la sortie du mode édition force une sauvegarde immédiate
des positions en attente (contourne le debounce, voir §8.5) avant de désactiver le glisser-déposer.

### 8.5 `PositionManager` (client) — debounce local

Stocke les positions par plan en mémoire, avec un **debounce de 5 secondes** avant sauvegarde
serveur (`updatePosition`/`scheduleSave`) — `forceSave()` court-circuite ce délai (utilisé en
sortie de mode édition). Aucun équivalent serveur — la persistance réelle est entièrement gérée
par `HaplanService` (§4.2), qui reçoit systématiquement la liste complète.

### 8.6 `FloorPlan` — surface image et glisser-déposer

- Le plan est **toujours entièrement contenu** dans son conteneur (mise à l'échelle
  `min(widthRatio, heightRatio)`) — **pas de zoom ni de pan**.
- Positions normalisées 0-1, appliquées en `left/top` pourcentage + `translate(-50%,-50%)` par
  rapport au conteneur de glisser-déposer — c'est ce qui les rend indépendantes du
  redimensionnement.
- **Icône de corbeille** : positionnée par défaut en haut à droite (`{x:0.95, y:0.05}`), également
  déplaçable en mode édition — sa position est persistée via le **même mécanisme que les entités**,
  sous un pseudo-`entity_id` `'__trash_icon__'` (voir limitation §15).
- Bordure du conteneur de glisser-déposer : `1px solid #CCCCCC` normalement,
  `3px solid #4CAF50` (+ contour vert pointillé) en mode édition.
- Redimensionnement sur `resize` de la fenêtre (debounce 200ms) et sur appel explicite
  (`recalculateDimensions()`, déclenché par le menu escamotable, §12).

### 8.7 Glisser-déposer (`DragAndDropConstrained`)

Deux modes de contrainte : `'full'` (l'élément entier reste dans le conteneur) et `'center'`
(seul le centre doit rester dans le conteneur — utilisé par toutes les entités et la corbeille,
cohérent avec le `translate(-50%,-50%)`). **Événements souris uniquement — pas d'événements
tactiles**, malgré la présentation de l'application comme "tactile" (voir limitation §15).

### 8.8 `EntitySelector` — sélecteur en cascade

Trois listes déroulantes en cascade (Pièce → Appareil → Entité, terminologie héritée du portage),
filtrant les entités déjà placées sur le plan courant et les entités `diagnostic.`/`config.`
(entity_category techniques).

### 8.9 Bouton de déploiement écran (v1.2)

`#btn-deploy-floorplan` (`.haplan-header`, à côté du bouton de suppression) — `setupDeployFloorplanButton()`
dans `dashboard-app.ts` :

1. Au clic : désactive le bouton, texte "⏳ Déploiement en cours…", `dataService.deployFloorplan(floorplanId)`
   (émet `haplan:floorplan:deploy` avec le plan **actuellement affiché**, pas un plan choisi séparément).
2. `onDeployStarted()` : confirme le même état visuel (couvre le cas où un autre client aurait
   déjà déclenché un déploiement — voir limitation ci-dessous).
3. `onDeployResult()` : réactive le bouton, restaure son texte, `alert()` de succès (durée
   arrondie à la seconde) ou d'échec (message brut du pipeline).
4. `onError()`, **filtré au code** (`HAPLAN_DEPLOY_BUSY`/`HAPLAN_DEPLOY_FAILED` uniquement) : réarme
   le bouton sur un rejet immédiat côté serveur (verrou déjà pris) — sans ce filtre, n'importe
   quelle autre erreur HAPLAN survenant pendant un déploiement réarmerait le bouton à tort, le
   canal `haplan:error` étant partagé par toutes les commandes (§15, bug #10 : toujours vrai que
   seul ce bouton et les alertes d'upload donnent un retour visuel des erreurs, tout le reste
   reste silencieux console-only).

Contrairement aux autres actions du tableau de bord, **aucune confirmation native** avant l'envoi
(à la différence de la suppression de plan) — déploiement non destructif pour les données HAPLAN
elles-mêmes (il modifie un écran physique distant, pas la configuration des plans).

### 8.10 Écran mural physique (ESP32-S3, v1.3)

Le firmware déployé par le bouton ci-dessus (`applications/haplan/tools/esphome/haplan-display.yaml`,
propriété de HAPLAN — voir `fonctionnelles-espdisplay_specs` §4.1) affiche les plans sur un écran
tactile mural (Sunton ESP32-8048S070C, ESP32-S3, tactile capacitif GT911). Détail matériel complet
en mémoire de session (`project_haplan_esphome_s3_display`), pas dupliqué ici — cette section ne
couvre que le comportement fonctionnel pertinent pour la maintenance.

**Veille du rétroéclairage** (demande utilisateur 14/08/2026, reproduit le comportement d'un écran
précédent) : rétroéclairage éteint après 30s d'inactivité tactile (`lvgl: on_idle:`), rallumé au
premier tap (`touchscreen: on_touch: - light.turn_on: backlight`, en tête de liste des actions). Ce
n'est **pas** une veille ESP réelle — LVGL, le WiFi et les états HA continuent de tourner et de se
mettre à jour en arrière-plan, seul le rétroéclairage physique s'éteint. Point accepté par
l'utilisateur : le tout premier tap qui réveille l'écran peut aussi déclencher l'icône sous le
doigt (LVGL ne distingue pas réveil et clic) — pas de logique de suppression du premier tap.

**Marqueur tactile permanent** : un marqueur "X" rouge reste affiché en permanence à l'endroit du
dernier tap (décision utilisateur explicite, pas temporaire) — aide à diagnostiquer un tap "raté"
à côté d'une icône de 24px. Le texte des coordonnées x/y qui l'accompagnait a été retiré le
14/08/2026 (prévu depuis la mise en place initiale, "une fois l'appli au point").

---

## 9. Modèle d'Objets HA (icônes du plan)

### 9.1 Hiérarchie

```
HAObject (abstrait)
└── BaseEntity (abstrait — rendu visuel, interaction)
    ├── EnhancedSwitchObject
    │   ├── EnhancedLightObject → MinimalLightObject
    │   ├── EnhancedCoverObject → EnhancedBlindObject
    │   ├── EnhancedVMCObject
    │   ├── EnhancedWaterHeaterObject
    │   └── EnhancedRadiatorObject
    ├── EnhancedThermostatObject
    ├── EnhancedTemperatureSensor
    ├── EnhancedHumiditySensor
    └── EnhancedGenericSensor
```

`HAObject` : glisser-déposer (délai d'attente 2s pour trouver le conteneur DOM, jusqu'à 10
tentatives via `requestAnimationFrame` pour trouver le nœud DOM lui-même), détection de dépose sur
la corbeille, envoi de commande (silencieusement abandonnée si non connecté — voir §15).

`BaseEntity` : style visuel (`icon`/`card`/`gauge`/`slider`/`minimal`), palette de couleurs par
type, gestion du clic — **en mode édition, tout clic est ignoré** (pas de fenêtre contextuelle) ;
**les capteurs (`sensor.*`) n'ouvrent jamais de fenêtre**, quel que soit le mode.

### 9.2 Détermination du type d'objet (`UnifiedObjectFactory`)

Résolution par préfixe de domaine (`light.`→lumière, `switch.`→interrupteur, `sensor.`→capteur
température/humidité/générique selon des mots-clés dans l'id, `cover.`→volet/store,
`climate.`→thermostat ; tout le reste → lumière par défaut). Pour les domaines `light` et `switch`,
un second niveau de détection (`SwitchTypeDetector`) peut **reclasser** l'objet en VMC/chauffe-eau/
radiateur selon des mots-clés dans l'`entity_id` ou les attributs — voir limitation §15
(reclassement erroné possible d'une lumière).

### 9.3 Rendu et actions par type

| Type | Icône | Actions envoyées |
|---|---|---|
| Lumière (`EnhancedLightObject`) | ampoule, dorée quand allumée | `light.turn_on`/`turn_off` (le variateur de la fenêtre contextuelle ne fonctionne pas réellement, voir §15) |
| Interrupteur (`EnhancedSwitchObject`/`MinimalLightObject`) | bascule ON/OFF | `switch.turn_on`/`turn_off` |
| Volet/Store (`EnhancedCoverObject`/`EnhancedBlindObject`) | fenêtre | `cover.open_cover`/`close_cover`/`stop_cover` |
| VMC/Chauffe-eau/Radiateur | icône dédiée par type — **état lu uniquement à la couleur de l'icône**, aucun libellé ON/OFF (retiré en v1.1, voir §15.3 bug #3) : chauffe-eau bleu éteint/orange allumé, VMC blanc éteint/jaune allumé, radiateur bleu éteint/rouge allumé (+ icône flocon/feu selon l'état) | `switch.*` |
| Thermostat (`EnhancedThermostatObject`) | thermomètre coloré selon la consigne | `climate.set_temperature`/`set_hvac_mode` |
| Capteurs (température/humidité/générique) | valeur affichée seule | aucune (lecture seule, pas de fenêtre) |

---

## 10. Fenêtres Contextuelles (popups de contrôle)

Gestionnaire singleton `ContextWindowManager` : positionnement à côté de l'icône cliquée
(bascule à gauche/au-dessus si débordement), overlay semi-transparent, fermeture par clic
extérieur ou touche Échap.

5 fenêtres concrètes :

| Fenêtre | Utilisée pour | Contenu |
|---|---|---|
| `LightWindow` | Lumières | Boutons Éteindre/Allumer + curseur de luminosité (non fonctionnel, §15) |
| `SwitchWindow` | Interrupteur générique | Bouton bascule unique, fermeture automatique 500ms après action |
| `SwitchContextWindow` | VMC/chauffe-eau/radiateur | Statut + boutons Éteindre/Allumer |
| `ThermostatWindow` | Thermostats | Température actuelle, consigne ±1°C, champ numérique, rafraîchie en direct si ouverte |
| `GenericWindow` | Volets/stores (les capteurs n'y accèdent jamais) | Liste des valeurs affichées — souvent vide en pratique, voir §15 |

Le titre de **toutes** les fenêtres provient du même mécanisme : voir §11.

---

## 11. Nom d'Entité Dérivé de la Taxonomie

`DataService.getTaxonomyDisplayName(entity_id)` — lit `attributs_taxonomie` depuis le cache d'état
côté client (déjà présent dans le payload d'état transmis par le serveur) :
```
quoi + lieu_precis + lieu_principal (déduplication : lieu_principal omis si identique à lieu_precis)
```
Chaque partie capitalisée, jointe par un espace. **Repli** sur le `friendly_name` HA (ou
l'`entity_id`) si aucune taxonomie n'est publiée pour cette entité. Fonctionne uniquement pour les
entités déjà présentes sur un plan (dépend du cache d'état côté client, pas de l'arbre de
taxonomie serveur du §6, qui est un mécanisme distinct).

**Deux consommateurs :**
1. **Titre des 5 fenêtres contextuelles** (`getFormattedWindowTitle`, §10).
2. **Bandeau flottant de focus d'entité** — émis au **survol** ET au **clic** (pas seulement au
   clic), via un événement DOM `ha-object-focus`. C'est le **seul retour visuel disponible en mode
   édition**, puisque le clic n'y ouvre volontairement aucune fenêtre. Affiché en bas de l'écran,
   disparaît après 3 secondes (réinitialisé à chaque nouvel événement).

---

## 12. Menu Escamotable et Contrôles Flottants

- `.haplan-header` : `display: none` par défaut, `display: flex` (classe `.open`) quand ouvert —
  **repousse le plan vers le bas** en s'ouvrant (flux normal, pas un overlay), puisqu'il fait
  partie de la colonne flexible verticale de `.haplan-app`.
- `.haplan-floating-controls` : **toujours visibles**, superposés au plan (position absolue,
  au-dessus du header ouvert ou fermé) — flèche de retour (`← `, lien simple vers `/`), bouton
  hamburger (☰ / ✕ selon l'état) et bouton loupe (🔍, voir échelle ci-dessous).
- **Recalcul de dimensions obligatoire à l'ouverture/fermeture** : le changement de hauteur de
  `.haplan-body` doit déclencher un nouveau calcul de l'échelle et du repositionnement de toutes
  les icônes (`recalculateDimensions()` → `FloorPlan.forceResize()`), sans quoi le plan resterait
  à l'ancienne échelle avec des icônes mal positionnées.

### 12.1 Navigation circulaire entre plans (v1.1)

Deux flèches épaisses semi-transparentes (`.haplan-nav-arrow--prev`/`--next`), plaquées sur les
bords gauche/droit de `.haplan-body`, en remplacement pratique du sélecteur de plan (caché dans le
menu escamotable replié). `navigateFloorplan(direction)` (`dashboard-app.ts`) navigue dans
`Object.keys(dataService.getAllFloorplans())` avec un index **circulaire**
(`(index + direction + n) % n`) : depuis le dernier plan, "suivant" revient au premier, et
inversement depuis le premier, "précédent" va au dernier.

### 12.2 Échelle icônes/textes réglable (`--plan-scale`, v1.1)

Toutes les règles de taille scalables de `styles.css` (icônes, titres, badges de valeur, boutons,
capteurs) sont exprimées `calc(Npx * var(--plan-scale, 1))`. Le bouton loupe (🔍) ouvre un panneau
contenant un curseur (`<input type="range">`, 60 % à 120 %, pas de 10 %) — `setupPlanScaleControl()`
applique la valeur via `document.documentElement.style.setProperty('--plan-scale', ...)` et la
persiste dans `localStorage` (clé `haplan:plan-scale`).

**Mémorisation par écran, pas par utilisateur** : `localStorage` est local au navigateur, pas au
formulaire générique de paramètres de l'application (`HAPLAN_UI_METADATA.fields`, toujours vide,
voir §2) — cohérent avec l'usage prévu d'un plan mural fixe, où chaque écran garde son propre
réglage sans dépendre d'un compte ou d'une session utilisateur. Le formulaire générique n'est de
toute façon jamais atteint pour cette application : son entrée de menu route directement vers
`dashboard.html` (§7.1), pas vers la page de configuration générique.

---

## 13. Socket.io

**Server → Client** (persistants : `haplan:status`, `haplan:floorplans:list`,
`haplan:taxonomy:tree` — **`haplan:entities:state:bulk` est délibérément non persistant**, un
événement persistant n'a qu'une seule valeur rejouée par nom, incompatible avec un état par
entité) :
```typescript
'haplan:status'                  // HaplanStatus
'haplan:floorplans:list'         // { floorplans: Record<id, {filename, positions[]}> }
'haplan:taxonomy:tree'           // { areas: EntityPickerAreaNode[] }
'haplan:entities:state:bulk'     // { states: [{entity_id, state, attributes}] }
'haplan:entity:state'            // { entity_id, state, attributes }
'haplan:error'                   // AppError
'haplan:floorplan:deploy:started'  // { floorplanId } — v1.2, ponctuel, voir §3.6/§8.9
'haplan:floorplan:deploy:result'   // { floorplanId?, ok, message, durationMs } — v1.2, ponctuel
```

**Client → Server :**
```typescript
'haplan:status:get'
'haplan:floorplans:list:get'
'haplan:taxonomy:tree:get'
'haplan:entity:command'                    // { entity_id, domain, service, serviceData? }
'haplan:floorplan:positions:update'        // { floorplanId, positions: [...] } — liste complète, voir §4.2
'haplan:floorplan:delete'                  // { floorplanId }
'haplan:floorplan:deploy'                  // { floorplanId } — v1.2, voir §3.6
```

> **v1.2 — Événements inter-applications (pas Socket.io, EventBus générique uniquement)** :
> `espdisplay:deploy-floorplan` (émis par HAPLAN, écouté par `applications/espdisplay`) et
> `espdisplay:deploy-result` (l'inverse) — voir §3.6 et `fonctionnelles-espdisplay_specs_v1.0.md`.
> Noms **codés en dur des deux côtés**, volontairement (aucune dépendance de compilation entre les
> deux applications), même convention que `integration:bridge:register`.

> Événement interne, jamais exposé côté client : `haplan:internal:floorplan:create` (déclenché
> uniquement par la route REST d'upload, §5).

---

## 14. Configuration

### 14.1 `data/haplan/config.yaml` — champs réels

Seulement **deux champs** (`config-schema.ts`) :

| Champ | Type | Défaut |
|---|---|---|
| `enabled` | boolean | `true` |
| `floorplansConfigFile` | string | `config-haplan-floorplans-v1.0.yaml` |

> ⚠️ Aucun fichier `data/haplan/config.yaml` n'existe par défaut — HAPLAN tourne entièrement sur
> ses valeurs Zod par défaut tant qu'aucune sauvegarde n'a eu lieu (mais rappel : le formulaire
> générique n'expose de toute façon aucun champ, voir §2).

---

## 15. Limites, Bugs Connus et Code Mort

### 15.1 Stubs et documentation périmée

| Élément | État réel |
|---|---|
| `DataService.getEntity()` | Ne retourne jamais que `{name}` — `area_name`/`device_name` toujours absents malgré le type déclaré |
| `DataService.getAreaNameOfEntity()` | **Toujours `''`**, code mort (plus aucun appelant depuis l'introduction du §11) |
| Commentaires "upload/suppression = stubs, Phase 3 différée" | **Faux** — les deux sont pleinement implémentés (§5, §4.4) |
| `README.md`/`ENTITY_LIBRARY_DOCUMENTATION.md` (dans `models/objects/`) | Documentation **d'origine de haplanserver**, jamais mise à jour — décrit un rendu "Card"/"Gauge" qui ne correspond plus au rendu icône/valeur actuel |

### 15.2 Code mort

`FloorplanSelector.ts` (grille de vignettes, aucun importeur), `EnhancedObjectFactory.ts` (ancienne
fabrique, supplantée par `UnifiedObjectFactory`), `FloorPlan.calculateScale()`,
`FloorPlanContainer.updatePreferences()` (opère sur un canvas jamais assigné),
`FloorPlanContainer.changeFloorplan()`, de larges portions de `styles.css` (ancien système de
menu, dialogue de renommage de plan, classes d'objets historiques jamais émises par le code
actuel).

### 15.3 Bugs fonctionnels identifiés en lisant le code

| # | Bug | Conséquence |
|---|---|---|
| 1 | Curseur de luminosité de `LightWindow` inopérant | `EnhancedLightObject` ne stocke jamais la valeur affichée (toujours lue à 0) et l'action `set_brightness` ne fait qu'une mutation locale — **aucune commande `light.turn_on {brightness}` n'est jamais envoyée à HA** |
| 2 | Libellés de statut des interrupteurs génériques et SwitchContextWindow toujours faux | Aucune classe d'objet n'alimente jamais `displayValue('status')` — bouton en permanence "Allumer", statut en permanence "OFF" |
| 3 | Sélecteurs CSS de statut désaccordés du DOM réellement rendu | `EnhancedSwitchObject` (interrupteur générique) : la div de statut est créée sans la classe que `updateDisplay()` recherche ensuite — mise à jour visuelle sans effet. **Ne concerne plus `EnhancedRadiatorObject`/`EnhancedWaterHeaterObject`/`EnhancedVMCObject` depuis la v1.1** : le libellé ON/OFF (déjà cassé pour le radiateur, et par ailleurs de taille figée en JS, ignorant `--plan-scale`) a été retiré des trois plutôt que corrigé — l'état s'y lit désormais uniquement à la couleur de l'icône (§9.3) |
| 4 | `EnhancedBlindObject.getIconForState()` lit le mauvais indicateur | Utilise `isOn` (hérité de la branche interrupteur) au lieu de `isOpen` (mis à jour par la branche volet) |
| 5 | Une lumière peut être reclassée en VMC/chauffe-eau/radiateur | `SwitchTypeDetector` s'exécute aussi pour le domaine `light` — une lumière dont l'`entity_id` contient `fan`/`ventilation`/`chauffage`/`ballon`... émettra à tort des commandes `switch.*` au lieu de `light.*` |
| 6 | Écouteurs `change` dupliqués sur le sélecteur de plan | Réattaché à chaque réception de `haplan:floorplans:list` (donc après chaque sauvegarde/création/suppression/reconnexion) sans jamais retirer le précédent — un seul changement utilisateur finit par déclencher plusieurs affichages en cascade |
| 7 | Suppression par glisser-déposer sur la corbeille laisse l'objet enregistré côté client | Le nœud DOM et la position sont retirés, mais pas l'entrée dans le registre interne du gestionnaire d'objets — l'entité reste comptée comme "déjà placée" par le sélecteur |
| 8 | `__trash_icon__` fuit dans le modèle de données persisté | La position de la corbeille est enregistrée côté serveur sous un pseudo-`entity_id`, comptée dans `entitiesCount` et dans `trackedEntityIds` — filtrée côté client au chargement, mais pas côté serveur |
| 9 | Position de la corbeille jamais restaurée | Toujours recréée à sa position par défaut au chargement, bien que persistée (voir #8) — la valeur enregistrée n'est jamais relue |
| 10 | `haplan:error` invisible pour l'utilisateur | Uniquement journalisé en console navigateur — aucune commande échouée, sauvegarde échouée ou entité inconnue n'est jamais signalée visuellement (seule exception : une `alert()` native sur échec HTTP d'upload) |
| 11 | Commandes silencieusement abandonnées hors connexion | `sendCommand()` vérifie `isConnected()` et abandonne avec un simple avertissement journalisé si non connecté |
| 12 | `HaplanStatus` jamais rafraîchi après le démarrage | Compteurs (`floorplansCount`/`entitiesCount`) figés jusqu'au prochain redémarrage ou une demande explicite jamais faite par le tableau de bord ; `haWsConnected` reflète la présence de l'objet `HaWsClient`, pas son état de connexion réel |
| 13 | Aucun support tactile | Glisser-déposer basé uniquement sur les événements souris — sur un appareil tactile, le déplacement d'icône en mode édition ne fonctionne pas, malgré la présentation de l'application comme "tactile" |
| 14 | Aucun zoom/pan | Le plan est toujours entièrement contenu dans le conteneur |
| 15 | Identifiants de plan non assainis comme clé de map | Seul le nom de fichier est assaini — deux identifiants distincts peuvent produire le même nom de fichier assaini et s'écraser silencieusement ; pas de renommage possible |
| 16 | Aucune protection contre l'édition concurrente | La liste de positions est toujours remplacée en bloc ; deux navigateurs éditant le même plan simultanément s'écrasent l'un l'autre (dernier écrit gagne, fenêtre de 5s de debounce) |
| 17 (v1.2) | Déploiement écran : verrou simple, pas de file d'attente | Une deuxième demande pendant qu'un déploiement est en cours est **rejetée** (`HAPLAN_DEPLOY_BUSY`), pas mise en attente — l'utilisateur doit réessayer manuellement une fois le premier terminé |

### 15.4 Autres constats

- `stop()` du service ne désabonne rien (écouteur `onStateChanged`, écouteurs EventBus) — même
  limitation projet-wide que RFXCOM/AREXX/EVOO7 sur la désactivation d'application (voir
  `TODO.md`).
- Aucun test automatisé n'existe pour cette application.
- Journalisation de débogage significative dans les chemins de rendu/glisser-déposer (traces à
  chaque mouvement de souris, chaque mise à jour d'état), y compris des branches de débogage codées
  en dur pour une entité spécifique de l'installation de référence.
- Plusieurs contournements de timing DOM plutôt qu'un vrai cycle de vie (attente active/répétée
  pour trouver un nœud DOM, doubles `requestAnimationFrame`, `setTimeout` de re-vérification de
  visibilité) — fonctionnels mais fragiles en cas de changement de structure du DOM.

---

## 16. Arborescence des Programmes

```
applications/haplan/
├── package.json, tsconfig.json
└── src/
    ├── domain/
    │   ├── HaplanService.ts
    │   ├── config-schema.ts, floorplans-config-schema.ts, types.ts, socket-events.ts, index.ts
    │   ├── taxonomy-tree.ts
    │   └── yaml/ConfigFileManager.ts
    └── presentation/
        ├── tsconfig.ui.json
        └── haplan/
            ├── dashboard.html, dashboard-app.ts, styles.css
            ├── services/DataService.ts
            ├── components/
            │   ├── FloorPlanContainer.ts, EntitySelector.ts
            │   └── FloorplanSelector.ts        # code mort, voir §15.2
            ├── services/ObjectManager.ts
            ├── models/
            │   ├── FloorPlan.ts, PositionManager.ts
            │   └── objects/
            │       ├── HAObject.ts, BaseEntity.ts
            │       ├── EnhancedSwitchObject.ts, EnhancedLightObject.ts, MinimalLightObject.ts
            │       ├── EnhancedCoverObject.ts, EnhancedBlindObject.ts
            │       ├── EnhancedVMCObject.ts, EnhancedWaterHeaterObject.ts, EnhancedRadiatorObject.ts
            │       ├── EnhancedThermostatObject.ts
            │       ├── EnhancedTemperatureSensor.ts, EnhancedHumiditySensor.ts, EnhancedGenericSensor.ts
            │       ├── UnifiedObjectFactory.ts, EnhancedObjectFactory.ts (code mort), utils/SwitchTypeDetector.ts
            │       └── windows/
            │           ├── ContextWindow.ts, ContextWindowManager.ts
            │           └── LightWindow.ts, SwitchWindow.ts, SwitchContextWindow.ts, ThermostatWindow.ts, GenericWindow.ts
            └── ui/draganddropconstrained.ts
```

Données runtime : `data/haplan/config-haplan-floorplans-v1.0.yaml`, `data/haplan/images/`,
`data/haplan/client-floorplans.json` (import legacy, format haplanserver d'origine).

---

## 17. Génération de cartes Plan Home Assistant (Lovelace) — conception, nouveau v1.4

**Statut** : conception soumise par l'utilisateur (28/08/2026), reprise ici telle quelle — aucun
code écrit à ce stade. Plusieurs points restent à trancher avant implémentation (§17.7).

### 17.1 Contexte

HAPlan fait déjà deux choses à partir de la même modélisation de plans (images + positions
d'objets, §4) : interagir en direct avec Home Assistant (§3/§8), et générer des configurations
ESPHome pour des tablettes qui reproduisent le plan (§3.6/§8.9-8.10). **Objectif de cette
conception** : une troisième sortie — générer et envoyer une configuration de **carte Plan
(Lovelace)** vers Home Assistant, depuis les mêmes données de modélisation.

Rappel d'architecture (déjà vraie aujourd'hui, §2/§13) : le cœur (`core`) gère les web services
(WebSocket HA, port 8123) et MQTT (réservé aux drivers) ; HAPlan est une application satellite en
process séparé, communique avec le cœur en IPC ; le cœur gère déjà l'authentification (token longue
durée HA) dans ses paramètres, HAPlan n'a rien à gérer côté authentification.

### 17.2 Source de données (déjà existante)

Un répertoire d'images de plans au format JPEG (fond souvent transparent, ou noir avec tracés
blancs selon le thème) + un fichier de configuration associé listant, pour chaque plan, la liste
des objets avec : l'identifiant d'entité HA (ex. `light.salon`), des coordonnées x/y en pourcentage
(pas de pixels absolus — le pourcentage représente le **centre** de l'icône/texte affiché),
éventuellement une icône (et parfois une valeur affichée à côté, ou l'icône seule), la taille de
l'icône/texte (déjà réglable dans HAPlan aujourd'hui, §12.2).

Police d'icônes utilisée par HAPlan aujourd'hui : non identifiée précisément à ce stade (à vérifier
dans le code, §17.7). Contrainte : la police doit permettre plusieurs couleurs par icône selon
l'état (ex. gris = éteint, jaune = allumé). HA utilise nativement les icônes **mdi** (Material
Design Icons), qui répondent à ce besoin — un mapping HAPlan → mdi sera probablement nécessaire si
la police d'origine diffère.

### 17.3 Types d'objets et comportements

Le système doit rester générique : n'importe quel capteur ou actionneur HA doit pouvoir être placé
sur un plan, sans liste figée de types supportés — même esprit que le modèle d'objets déjà en place
côté HAPlan lui-même (§9, `UnifiedObjectFactory`). Cas déjà identifiés :

| Type d'objet | Icône | Comportement au clic |
|---|---|---|
| Actionneur simple (lumière) | grisée si éteint, jaune si allumé | bascule l'état (on/off) |
| Capteur pur (température, humidité...) | déterminée automatiquement selon le type de mesure ; unité récupérée automatiquement | aucune action, affichage seul |
| Objet complexe (thermostat...) | — | ouvre une fenêtre dédiée avec les différents réglages (fenêtre déjà existante dans HAPlan — `ThermostatWindow.ts`, §16 — à reproduire si possible côté HA) |

**Repli pour les thermostats** si la fenêtre dédiée n'est pas réalisable côté HA : afficher la
température au centre, bouton **+** (rouge) à droite et **−** (bleu) à gauche pour ajuster la
consigne directement depuis le plan.

### 17.4 Rendu / affichage

- Le plan doit s'adapter (responsive) à la surface d'affichage disponible côté HA, avec
  repositionnement proportionnel des icônes/textes — les coordonnées en % s'y prêtent nativement.
- Le style visuel (fond noir/tracés blancs, ou fond transparent selon le plan) doit être
  conservé/respecté côté rendu HA.

### 17.5 Génération et envoi vers Home Assistant

- **Format de sortie** : HAPlan construit **directement** la configuration au format attendu par la
  carte Plan Lovelace de HA (pas de format intermédiaire à transformer côté HA par un script).
- **Canal d'envoi** : web service (WebSocket HA, port 8123) — pas MQTT, réservé aux drivers.
- **Authentification** : token longue durée déjà configuré côté cœur (paramètres core, §14) ; HAPlan
  s'appuie dessus sans gestion supplémentaire.
- **Déclenchement** : action manuelle initiée depuis HAPlan (pas de génération/envoi automatique à
  chaque modification d'un plan) — même principe que le bouton de déploiement écran ESP existant
  (§8.9), un bouton dédié de plus dans le même esprit.

### 17.6 Différence avec la génération ESPHome existante (§3.6/§8.9-8.10)

Les deux sorties partent de la même modélisation (§4/§17.2) mais produisent des artefacts de nature
différente : ESPHome génère une configuration firmware compilée et déployée sur un écran physique
dédié (pipeline Python séparé, §8.9) ; la carte Plan Lovelace génère une configuration HA native,
consommée directement par l'interface HA existante de l'utilisateur (navigateur, appli mobile HA),
sans matériel dédié ni compilation.

### 17.7 Points restants à trancher / vérifier (avant implémentation)

- Identifier précisément la police d'icônes utilisée actuellement par HAPlan, et déterminer si un
  mapping vers mdi est nécessaire (et sa méthode : table de correspondance manuelle, ou automatique
  par nom).
- Vérifier les capacités réelles de la carte Plan Lovelace de HA (formats de coordonnées acceptés,
  gestion des couleurs d'icônes dynamiques, possibilité d'ouvrir une fenêtre de dialogue
  personnalisée pour les thermostats) pour confirmer que le format ciblé est bien réalisable tel
  quel — **non vérifié à ce stade, condition préalable à l'implémentation**.

---

## 18. Annexes

### 18.1 Références
- [Spécification de Nommage **OBLIGATOIRE**](spec-nommage-v1.0.md) ⭐
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.19.md) ⭐ (§5.7 exceptions REST, §6.2 routage `Sidebar`)
- Projet d'origine : [haplanserver](https://github.com/zdid/haplanserver)

### 18.2 Glossaire
| Terme | Définition |
|-------|------------|
| Plan (floorplan) | Image uploadée servant de fond, avec ses positions d'entités associées |
| Position | Coordonnées normalisées 0-1 d'une entité sur un plan donné |
| Mode édition | État permettant de glisser-déposer les icônes ; désactive l'ouverture des fenêtres contextuelles au clic |
| Entité suivie (`trackedEntityIds`) | `entity_id` référencé par au moins une position sur au moins un plan — seules ces entités peuvent recevoir une commande |
| `attributs_taxonomie` | Attribut HA publié par les intégrations MQTT du projet, source à la fois de l'arbre de sélection (§6) et du nom d'entité affiché (§11) |

### 18.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.4 | 2026-08-28 | Claude | **Génération de cartes Plan Home Assistant (Lovelace)** (§17, nouvelle, conception) : troisième sortie de HAPlan depuis la même modélisation plans/positions (§4), après l'interaction HA directe et la génération ESPHome (§3.6/§8.9-8.10) — carte Plan Lovelace construite directement au format HA cible, envoyée en WebSocket (port 8123, pas MQTT) via le token longue durée déjà géré côté cœur, déclenchement manuel depuis HAPlan. Types d'objets génériques (actionneur simple, capteur pur, objet complexe avec fenêtre dédiée ou repli +/− pour les thermostats). Conception soumise par l'utilisateur, reprise telle quelle — aucun code écrit, plusieurs points laissés ouverts avant implémentation (§17.7) : police d'icônes réelle de HAPlan à identifier, capacités exactes de la carte Plan Lovelace côté HA non vérifiées. Ancienne version v1.3 archivée. |
| 1.3 | 2026-08-15 | Claude | **Écran mural physique (ESP32-S3)** (§8.10, nouvelle) : veille du rétroéclairage après 30s d'inactivité tactile (rallumé au premier tap), retrait du texte des coordonnées x/y (le marqueur "X" rouge reste, décision utilisateur permanente). |
| 1.2 | 2026-08-13 | Claude | Bouton "Déployer sur l'écran" (§3.6, §8.9) : premier exemple de communication inter-applications initiée par HAPLAN, vers la nouvelle application `applications/espdisplay` (`espdisplay:deploy-floorplan`/`espdisplay:deploy-result` sur l'EventBus générique, même pattern que `integration:bridge:register`). 3 nouveaux événements Socket.io (§13), 2 nouveaux codes d'erreur (§3.5). |
| 1.1 | 2026-08-06 | Claude | Échelle icônes/textes réglable par l'utilisateur (§12.2, `--plan-scale`, curseur 60-120 %, mémorisé par écran via `localStorage`) et navigation circulaire par flèches entre plans (§12.1), tous deux ajoutés au dashboard depuis la v1.0. Affichage d'état simplifié pour VMC/chauffe-eau/radiateur (§9.3) : libellé ON/OFF retiré (au lieu d'être corrigé, voir bug #3 révisé en §15.3), état désormais lu uniquement à la couleur de l'icône. |
| 1.0 | 2026-08-03 | Claude | Première spécification formelle, écrite a posteriori (application opérationnelle depuis fin juillet 2026 sans documentation dédiée). Couvre l'architecture, le backend (`HaplanService`), la persistance des plans/positions, l'upload (exception REST), l'arbre de taxonomie, l'accès externe/page dédiée, le frontend (bootstrap, `FloorPlan`, glisser-déposer), le modèle d'objets HA, les fenêtres contextuelles, le nom d'entité dérivé de la taxonomie, le menu escamotable, Socket.io, la configuration, et une liste consolidée de bugs fonctionnels et de code mort identifiés en lisant le code réel. |
