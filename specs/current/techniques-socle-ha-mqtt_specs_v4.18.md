# Spécifications Techniques — Socle Commun Applications HA/MQTT

**Version :** 4.18  
**Date :** 30 Juillet 2026  
**Statut :** Document de référence projet — sert de prompt de base pour la génération de chaque application

> **v4.18** : **`AreaEnsureService` (§8.5.4)** — `device.suggested_area` s'étant révélé non fiable
> (HA ne l'applique qu'à la toute première création, jamais garanti même sur redécouverte propre,
> vérifié en conditions réelles), `core` crée désormais lui-même l'area via l'API WebSocket de HA
> (`config/area_registry/create`) avant de publier la découverte — entièrement transparent pour
> les 4 applications émettrices. Nouveau `AreaEnsureService` (`ha/sync/`), interception dans
> `IntegrationBridge`, optionnel (Mode A seulement), best-effort (timeout ~8s). Vérifié sur une
> installation HA neuve : 86/96 devices assignés automatiquement.
> **v4.17** : **Ajout de `device.suggested_area` en découverte (§8.5.4)**, alimenté avec le lieu
> de taxonomie (pas le lieu précis), dans RFXCOM, EVOO7, AREXX et NOMMAGE (passthrough) — les
> quatre applications qui envoient des messages de découverte. Confirme au passage qu'un ancien
> champ `area_id` déclaré dans le type mais jamais alimenté nulle part n'était de toute façon pas
> exploitable : ce n'est pas la bonne clé pour la découverte MQTT de HA (`suggested_area` l'est).
> **v4.16** : **Correction du format des topics état/commande/LWT (§8.5.4)** — ces topics
> (`{moduleName}/{bridgeInstance}/{deviceId}/state|set` et `{moduleName}/{bridgeInstance}/status`)
> ne doivent **pas** commencer par un `/` : un slash initial crée un premier niveau de topic vide
> (MQTT), non-standard et source de confusion dans les clients/visualiseurs. Erreur introduite dès
> la définition initiale du format (v4.8, 21/07/2026) et restée non détectée jusqu'à un examen
> direct des messages retenus sur le broker par l'utilisateur, sur la nouvelle installation HA en
> cours de test. Seul le topic de **découverte** (`homeassistant/{component}/{object_id}/config`)
> garde son format inchangé — il n'a jamais eu ce défaut. Corrigé dans les 4 fonctions
> `get*Topic`/`getBridgeStatusTopic` de `ha-mqtt.ts` (point d'origine unique). Les anciens topics
> retenus (avec `/` initial) ont été explicitement effacés du broker de test (payload vide retenu)
> après le correctif, pour éviter des entités fantômes/dupliquées côté HA — à refaire sur toute
> autre instance ayant déjà tourné avec l'ancien format.
> **v4.15** : **Nouvelle §5.6 "Porte d'authentification OAuth2 HA (accès externe)"** — mécanisme
> optionnel (désactivé par défaut, `web.auth.enabled`), sans effet sur un déploiement interne tant
> qu'il n'est pas explicitement activé. Prévu pour une future instance externe dédiée exposée
> derrière un reverse proxy TLS : le flux OAuth2 natif de Home Assistant sert de portail de
> connexion (identifiant/mot de passe HA), un cookie de session signé (HMAC, sans état côté
> serveur) protège ensuite toutes les routes REST **et** la connexion Socket.io elle-même — les
> deux canaux étaient jusqu'ici sans aucune authentification, un modèle pensé pour un LAN de
> confiance. Pas de permissions différenciées par utilisateur HA (choix explicite) : tout
> utilisateur authentifié partage le même accès complet via le jeton longue durée déjà utilisé par
> le serveur.
> **v4.13** : **Correction §6 "Couche Présentation"** — la liste des invariants excluait encore
> Alpine.js ("Aucun framework UI tiers... Alpine.js"), affirmation devenue fausse depuis la
> réintroduction du framework (`presentation_specs` v4.0 + nouveau document dédié
> `alpinejs-implementation_specs_v1.0.md`, 22/07/2026). La note historique v4.7 ci-dessous, qui
> qualifiait Alpine.js de "technologie abandonnée", est conservée telle quelle (exacte au moment où
> elle a été écrite) mais n'est plus d'actualité.
> **v4.12** : **Remplacement du client WebSocket HA maison par `home-assistant-js-websocket`**
> (§4.2, §8.2) — librairie officiellement maintenue par l'équipe Home Assistant (utilisée par le
> frontend HA lui-même), en remplacement de `HaWsTransport.ts`/`HaWsClient.ts` écrits à la main.
> Motivation : le transport maison contenait un bug réel de double authentification par connexion
> (`HaWsTransport` envoyait son propre `auth` à l'ouverture du socket, `HaWsClient` en envoyait un
> second en réponse à `auth_required`), avec pour conséquence une boucle de reconnexion toutes les
> ~1s en cas de jeton invalide (jamais de renoncement, contrairement à la lib officielle qui échoue
> immédiatement sur `auth_invalid`, sans retry). `HaWsTransport.ts` est **supprimé** — `HaWsClient`
> encapsule directement `home-assistant-js-websocket` (polyfill `globalThis.WebSocket = require('ws')`
> documenté officiellement pour l'usage Node.js) en conservant la même API publique
> (`connect`/`disconnect`/`loadInitialRegistry`/`subscribeToEvents`/`sendCommand`/`onConnect`/
> `onDisconnect`/`onError`/`onStateChanged`/`onAreaUpdated`/`onDeviceUpdated`/`onEntityUpdated`/
> `reconfigure`) — `onMessage` (firehose brut) disparaît, sans équivalent dans la lib officielle
> (architecture par Promise/callback par requête) ; son unique consommateur (`HaCommandService`)
> faisait un ré-appariement de réponse par id déjà redondant avec la Promise que `sendCommand`
> retournait déjà (et déjà bugué : le `requestId` suivi localement ne correspondait pas
> nécessairement à l'id réellement envoyé sur le fil), simplifié pour résoudre directement depuis
> cette Promise. `config/area_registry/list`/`config/device_registry/list`/
> `config/entity_registry/list` (chargement initial du référentiel) n'ont pas d'équivalent haut
> niveau dans la lib — passent par l'échappatoire documentée `connection.sendMessagePromise()`.
> ⚠️ Vérifié à l'implémentation : ni `loadInitialRegistry()`/`subscribeToEvents()` (peuplement de
> `HaStructureRegistry`/`HaStateRegistry`) ni `HaCommandService` ne sont câblés dans le bootstrap de
> production (`applications/core/src/index.ts`/`AppService`) à ce jour — code fonctionnel mais
> orphelin, pré-existant, non introduit par ce changement.

> **v4.11** : **Correction d'un gap fonctionnel réel** (découvert en implémentant les scènes RFXCOM,
> §8.5.2) : `publishDiscoveryFor` abonne désormais **automatiquement** le bridge au topic de commande
> (`subscribeCommands`) lorsque l'entité publiée a `commandEnabled: true`. Avant ce correctif, aucun
> module métier n'appelait jamais la méthode d'abonnement dédiée (`subscribeCommandsFor`) — les
> commandes HA→app pour *tous* les modules publiant via la découverte normale (§8.5.0) n'étaient donc
> **jamais reçues en pratique** (le broker ne recevait aucun `SUBSCRIBE` sur le topic `/set`), bien que
> le code de réception (`parseIncomingCommand`, routage `integration:{module}:command`) fonctionne
> correctement une fois l'abonnement effectué. Non détecté plus tôt car les tests précédents du socle
> ne validaient que la réception RF433→MQTT (device→HA), jamais le sens HA→device en conditions
> réelles. `subscribeCommandsFor` reste appelable directement si un module a besoin d'un abonnement de
> commande sans publier de découverte associée (cas non rencontré à ce jour).

> **v4.10** : Séparation de `exports.ts` (point d'entrée backend Node.js du core) et **`ui-exports.ts`**
> (point d'entrée navigateur) — voir §4.2. Le code UI (ex: `SocketService`, dépendant de `window`/
> `document`/du script global `socket.io-client`) ne doit **jamais** être réexporté depuis `exports.ts` :
> tout consommateur backend de `exports.ts` (ex: une application important des types via ce point
> d'entrée) entraînerait sinon la compilation transitive de ce code navigateur dans son propre `dist`
> backend — constaté concrètement sur `nommage` et `arbreouquoi`, qui compilaient chacun une copie
> morte de `SocketService.js` dans leur `dist` Node. Les applications ayant besoin de `SocketService`
> côté navigateur importent désormais `ui-exports.ts` (ou le `dist` UI déjà buildé du core, selon leur
> configuration TypeScript — voir `guide-nouvelle-application_specs` §3.9).

> **v4.9** : Ajout du **Passthrough MQTT** (§8.5.6) : mécanisme pour les applications qui relaient
> des messages MQTT déjà formés (lus depuis une source tierce) vers le broker HA unique du socle,
> sans passer par la normalisation de découverte §8.5.0. Deux modes : réécriture de préfixe
> (`integration:{module}:passthrough:discovery`) et passthrough intégral
> (`integration:{module}:passthrough:publish`). Cas d'usage type : l'application `nommage`
> relayant des découvertes Zigbee2MQTT enrichies vers `homeassistant/...`.

> **v4.8** : **Précision du format MQTT (Mode B, §8.5)** : un seul broker pour tout le socle, mission
> détaillée par intégration (LWT + découverte persistante + état + commandes), nouveau concept de
> **bridge_instance** (LWT et topics état/commande par instance physique/logique), nouveaux formats
> de topics état/commande (`/{moduleName}/{bridgeInstance}/{deviceId}/state|set`, remplace l'ancien
> schéma générique `homeassistant/.../state|set` et l'ancien LWT `ha-integration/{module}/status`).
> Le topic de découverte HA standard (`homeassistant/{component}/{object_id}/config`) est inchangé.
> Clarification : le module métier ne fournit que les données essentielles, `HaMqttIntegrationService`
> normalise et complète l'intégralité du message de découverte.
> **v4.7** : **Correction de la couche Présentation** : suppression des références à Alpine.js (technologie abandonnée depuis `presentation_specs` v3.0 — TypeScript pur + Web Components natifs). La section 6 renvoie désormais vers `presentation_specs_v3.2.md` pour éviter la duplication et la désynchronisation entre documents.
> **v4.6** : **Restructuration complète de l'arborescence** : Déplacement de `src/applications/` et `src/applications_desactivees/` vers `applications/` et `applications_desactivees/` à la racine du projet. Chaque application (y compris le core) est maintenant autonome avec ses propres `package.json`, `tsconfig.json`, et `dist/`. **Le core ne peut pas être désactivé**. Mise à jour des mécanismes de détection et d'activation/désactivation via `AppService`.
> **v4.5** : Ajout du **démarrage automatique des services d'application** avec reconnexion sur changement de configuration. **Traces obligatoires** au démarrage et gestion des erreurs de connexion (matériel absent, mauvais paramètres).
> **v4.4** : Ajout de la **gestion dynamique d'activation/désactivation** des applications via répertoires `applications/` et `applications_desactivees/`.
> **v4.3** : Restructuration de la configuration HA avec flags d'activation (`ws_enable`, `mqtt_enable`) et regroupement MQTT sous HA.
> **v4.2** : Ajout du support **Alpine.js** pour la couche Présentation, tout en conservant TypeScript comme langage principal.

---

## 1. Contexte & Périmètre

Ce document définit le socle technique commun à toutes les applications du projet.
Chaque application hérite de l'intégralité de ces spécifications et les complète uniquement
avec ses propres règles métier, sa configuration spécifique, et les événements Socket.io
qu'elle choisit d'exposer à l'UI.

**Invariants communs à toutes les applications :**
- Écrites en **TypeScript 5.x** strict
- Communication avec **Home Assistant** via **MQTT** (broker Mosquitto standalone externe)
- **Synchronisation du référentiel HA** en mémoire (totale ou filtrée)
- Interface web embarquée communiquant exclusivement via **Socket.io** (sauf `/health`)
- Déployées dans un **conteneur Docker** avec `restart: unless-stopped`
- Configuration, données et logs **persistés sur l'hôte** dans `data/` et `logs/`

---

## 2. Stack Technique

| Composant | Technologie | Version |
|---|---|---|
| Langage | TypeScript | 5.x — mode strict |
| Runtime | Node.js (Alpine) | 20 LTS |
| Protocole IoT | MQTT | 3.1.1 / 5.0 |
| Broker MQTT | Mosquitto standalone | Externe au conteneur |
| Serveur HTTP/WS | Express.js + Socket.io | 4.x / 4.x |
| **Frontend** | **HTML + CSS + TypeScript + Web Components natifs** | **ES2020+** |
| Containerisation | Docker + Docker Compose | — |
| Paquets | pnpm | lockfile strict |
| Validation | Zod | 3.x |
| Logging | Winston + daily-rotate-file | 3.x / 5.x |
| Tests | Vitest | 1.x |

---

## 3. Architecture en Couches

Règle absolue : **les dépendances ne vont que vers le bas**.
Une couche ne connaît jamais l'existence d'une couche supérieure.

Le projet compte **cinq couches**, dont une couche **HA** dédiée, intercalée entre
la couche Métier et la couche Infrastructure.

```
┌──────────────────────────────────────────────────────────┐
│                    COUCHE PRÉSENTATION                    │
│   UI Web (HTML/CSS/TypeScript + Web Components natifs)   │
│   Serveur Express + Socket.io                            │
│   → Émet et reçoit uniquement des événements Socket.io   │
│   → Seul /health reste en HTTP pur                       │
├──────────────────────────────────────────────────────────┤
│                    COUCHE APPLICATION                     │
│   AppService · EventBus · SocketBridge · RestartManager  │
│   → SocketBridge : relaie EventBus ↔ Socket.io            │
├──────────────────────────────────────────────────────────┤
│                    COUCHE MÉTIER                         │
│   Logique pure spécifique à chaque application           │
│   Pas d'accès direct à HA, MQTT, fichiers, ou sockets    │
│   Consomme le référentiel structuré exposé par la        │
│   couche HA, et envoie ses commandes via cette couche     │
├──────────────────────────────────────────────────────────┤
│                     COUCHE HA                            │
│   Couche dédiée à toute la relation avec Home Assistant  │
│                                                            │
│   ┌──────────────────────────────────────────────────┐   │
│   │  A) Synchronisation référentiel — Web Service (WS) │   │
│   │     HaWsClient · HaStateRegistry                  │   │
│   │     HaStructureRegistry (area → QUOI → entités)   │   │
│   │     HaClassifier (module à venir, injecté ici)    │   │
│   │     HaCommandService (envoi commandes vers HA)    │   │
│   ├──────────────────────────────────────────────────┤   │
│   │  B) Modules d'intégration — MQTT                  │   │
│   │     Utilisés uniquement par les applications de    │   │
│   │     type "intégration" (passerelles, capteurs      │   │
│   │     tiers, etc.)                                   │   │
│   └──────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────┤
│               COUCHE INFRASTRUCTURE                    │
│   ConfigLoader · ConfigWriter · Logger                   │
│   (transport bas niveau : client WS, client MQTT)         │
└──────────────────────────────────────────────────────────┘
```

**Règles strictes :**
- La couche **métier** ne connaît ni HA, ni MQTT, ni Express, ni Socket.io, ni le filesystem —
  elle consomme exclusivement le référentiel structuré et les services exposés par la **couche HA**
- La couche **HA** est le seul point d'entrée/sortie vers Home Assistant pour toute l'application
- À l'intérieur de la couche HA, **deux modes de communication coexistent** sans se mélanger :
  - **Web Service (WebSocket HA native, port 8123)** : synchronisation du référentiel
    (entités, areas, devices) et envoi de commandes — utilisé par toute application
  - **MQTT** : réservé exclusivement aux applications de type **intégration**
    (modules qui font le pont entre HA et un système tiers)
- La **présentation** ne contient aucune logique métier
- Les modules métier communiquent vers l'UI **uniquement via EventBus**
- Le **SocketBridge** (couche application) est le seul composant qui traduit EventBus → Socket.io
- L'accès à `config.yaml` est réservé à `ConfigLoader` et `ConfigWriter`

---

## 4. Structure des Répertoires

### 4.1 Sur l'hôte (à côté de `compose.yaml`)

```
projet/
├── compose.yaml
├── .env                   # Secrets — non versionné
├── .env.example           # Modèle versionné sans valeurs sensibles
├── data/
│   ├── core/
│   │   └── config.yaml    # Section socle (ha/web/logging)
│   └── {app}/              # Un sous-répertoire par application (evoo7, rfxcom, ...)
│       ├── config.yaml    # Section de config propre à l'application (objet nu)
│       └── ...             # Fichiers de données propres à l'application
└── logs/
    └── app.log            # Logs rotatifs
```

Chaque application (y compris le core) a son propre sous-répertoire dans `data/`, regroupant à
la fois sa configuration et ses fichiers de données — objectif : pouvoir déplacer une application
d'une machine à une autre en copiant un seul sous-répertoire. Le tout reste sous `data/`, qui est
le seul répertoire monté en volume Docker externe.

### 4.2 Structure des Répertoires

**Structure à la racine du projet :**
```
├── src/                              # Code source du cœur (core) de l'application
│   ├── index.ts                      # Bootstrap : instancie et câble toutes les couches
│   ├── exports.ts                    # Point d'entrée BACKEND (Node.js) — EventBus, Logger, ConfigService,
│   │                                   #    HA types, etc. Ne DOIT PAS réexporter de code navigateur (§4.2.1).
│   ├── ui-exports.ts                 # ⭐ NOUVEAU v4.10 : Point d'entrée NAVIGATEUR — ex: SocketService.
│   │                                   #    Séparé de exports.ts pour ne pas polluer le dist backend
│   │                                   #    des applications qui importent exports.ts (§4.2.1).
│   ├── types/                        # Interfaces partagées — accessibles par toutes les couches
│   │   ├── config.ts                 # AppConfig, MqttConfig, HaSyncConfig, WebConfig
│   │   ├── ha.ts                     # HaEntity, HaDomain, HaState
│   │   ├── events.ts                 # AppEvent, SocketEvent, EventPayloads
│   │   └── interapp.ts               # ⭐ NOUVEAU : Types pour communication inter-applications
│   ├── infrastructure/
│   │   ├── config/
│   │   │   ├── schema.ts             # Schéma Zod — source de vérité de la config
│   │   │   ├── loader.ts             # Lecture + validation Zod de config.yaml
│   │   │   ├── writer.ts             # Écriture atomique (tmp → rename) de config.yaml
│   │   │   └── ConfigService.ts      # Service centralisé d'accès à la config (injection de dépendances)
│   │   ├── transport/
│   │   │   └── MqttTransport.ts      # Client MQTT bas niveau (utilisé par la couche HA, mode intégration)
│   │   └── logger/
│   │       └── index.ts              # Winston : console + fichier rotatif
│   ├── ha/                            # COUCHE HA — seul point de contact avec Home Assistant
│   │   ├── sync/                     # A) Synchronisation référentiel — via Web Service (WS)
│   │   │   ├── HaWsClient.ts         # ⭐ v4.12 : encapsule home-assistant-js-websocket (lib officielle
│   │   │   │                          #   HA) — auth, souscriptions, routage. Plus de transport maison.
│   │   │   ├── HaStateRegistry.ts    # États bruts des entités (Map<entity_id, HaRawEntity>)
│   │   │   ├── HaStructureRegistry.ts # Référentiel structuré area → QUOI → entités
│   │   │   └── HaClassifier.ts       # Interface IHaClassifier — implémentation à venir (module dédié)
│   │   ├── command/
│   │   │   └── HaCommandService.ts   # Envoi de commandes vers HA (call_service via WS)
│   │   ├── integration/              # B) Modules d'intégration — via MQTT
│   │   │   └── [module]/             # Un sous-dossier par module d'intégration MQTT spécifique
│   │   └── types/
│   │       ├── ha-ws.ts              # Types protocole WebSocket HA (messages, events)
│   │       ├── ha-entity.ts          # HaRawEntity, HaEntityState, HaDeviceClass
│   │       ├── ha-structure.ts       # HaArea, HaDevice, HaQuoi, HaStructuredRegistry
│   │       └── ha-command.ts         # HaCommand, HaServiceCall, HaCommandResult
│   └── application/
│       ├── AppService.ts             # Cycle de vie, coordination des modules
│       ├── EventBus.ts               # EventEmitter typé — canal inter-couches
│       ├── SocketBridge.ts           # Traduit EventBus → émissions Socket.io
│       ├── RestartManager.ts         # process.exit(0) différé après sauvegarde config
│       └── InterAppClient.ts         # ⭐ NOUVEAU : Client pour communication inter-applications
│
├── applications/                     # Applications ACTIVÉES — chacune dans son répertoire autonome
│   └── [app-name]/                  # Ex: rfxcom, zigbee2mqtt, core
│       ├── package.json             # Dépendances npm spécifiques à l'application
│       ├── tsconfig.json            # Configuration TypeScript de l'application
│       ├── dist/                    # Build compilé de l'application
│       ├── domain/                  # Couche Métier de l'application
│       │   └── [feature]/
│       │       ├── [Feature]Service.ts       # Logique métier — consomme HaStructureRegistry via EventBus
│       │       └── [Feature]Rules.ts         # Transformations et règles pures
│       └── presentation/            # Couche Présentation de l'application
│
├── applications_desactivees/        # Applications DÉSACTIVÉES — ignorées par le cœur
│   └── [app-name]/                  # Ex: old_app
│       ├── package.json
│       ├── tsconfig.json
│       ├── dist/
│       ├── domain/
│       └── presentation/
│
└── presentation/
    ├── server.ts                     # Création Express + attache Socket.io + /health
    ├── socket/
    │   ├── handlers.ts               # Listeners des événements Socket.io entrants (client → serveur)
    │   └── events.ts                 # Constantes des noms d'événements Socket.io
    └── ui/                           # Servi statiquement par Express
        ├── index.html                # Page principale (Web Components natifs)
        ├── style.css                 # Charte graphique commune (variables CSS)
        └── app.ts                    # Logique UI TypeScript — Socket.io client + Web Components
```

### 4.2.1 `exports.ts` vs `ui-exports.ts` — pourquoi deux points d'entrée

**⭐ NOUVEAU v4.10.** Le core expose deux barrels distincts pour les applications dérivées (nommage,
arbreouquoi, etc.) :

| Fichier | Exécuté dans | Contenu | Exemple |
|---|---|---|---|
| `src/exports.ts` | Node.js (backend) | EventBus, Logger, ConfigService, types HA, `HaMqttIntegrationService`, etc. | `IEventBus`, `HaStructureRegistry` |
| `src/ui-exports.ts` | Navigateur | Code dépendant de `window`/`document`/du script global `socket.io-client` | `SocketService` |

**Pourquoi la séparation est stricte** : un fichier `.ts` est une seule unité de compilation. Si
`exports.ts` réexportait `SocketService` (comme c'était le cas avant v4.10), alors **tout** import
depuis `exports.ts` — même un `import type` d'une interface purement backend — force TypeScript à
résoudre l'intégralité du graphe de `exports.ts`, y compris `SocketService.ts`. Résultat observé
concrètement : `nommage` et `arbreouquoi`, qui importent des types backend depuis `exports.ts`,
compilaient chacun une copie de `SocketService.js` dans leur propre `dist` Node — du code mort qui ne
peut pas s'exécuter côté serveur (utilise `window`, `declare const io`).

**Règle** : toute ressource du core destinée à tourner dans le navigateur va dans `ui-exports.ts`,
jamais dans `exports.ts`. Le module principal (`tsc` du core) **exclut explicitement**
`src/ui-exports.ts` de son build (voir `tsconfig.json` du core) pour éviter le même phénomène côté
core lui-même.

**Consommation par une application dérivée** — deux cas selon la configuration TypeScript de
l'application (voir `guide-nouvelle-application_specs` §3.9) :
- Si le `rootDir` de l'application englobe `applications/core/src/` (ex: `nommage`, dont le `rootDir`
  est `..`) : importer directement `../../../../core/src/ui-exports` (fichier source).
- Si le `rootDir` de l'application est restreint à son propre `src/` (ex: `arbreouquoi`) : TypeScript
  refuse de compiler une source hors `rootDir` (`TS6059`). Importer alors le `dist` UI déjà buildé du
  core : `.../core/dist/presentation/ui/js/ts/services/SocketService`. Ceci suppose que le core a déjà
  été buildé (`npm run build:ui`) et que `tsconfig.ui.json` du core émet des déclarations
  (`declaration: true`, ajouté en v4.10 précisément pour ce cas).

### 4.3 Gestion Dynamique des Applications

**Structure des répertoires applications (à la racine du projet) :**
```
├── applications/                     # Applications ACTIVÉES (chargées au démarrage)
│   ├── core/                        # CORE - **NE PEUT PAS ÊTRE DÉSACTIVÉ**
│   ├── rfxcom/
│   ├── zigbee2mqtt/
│   └── tartenpion/                  # Dynamique - apparaît après activation
│
└── applications_desactivees/        # Applications DÉSACTIVÉES (ignorées par le cœur)
    └── old_app/                      # Exemple : application désactivée
```

**Mécanisme de détection et démarrage automatique (AppService.ts) :**
- Le service `AppService.detectApplicationModules()` scanne `applications/` et `dist/applications/` à la racine du projet
- Les répertoires dans `applications_desactivees/` et `dist/applications_desactivees/` sont **exclus** de la détection
- **Exception** : Le répertoire `core/` dans `applications/` **ne peut pas être déplacé** vers `applications_desactivees/` — il est toujours chargé
- Pour chaque application détectée qui est **activée** (présente dans les répertoires applications/) et **n'est pas le core** :
  - **Détection des métadonnées** : Chargement de `{APP_NAME}_APP` pour les informations du module
  - **Détection des événements Socket.io** : Chargement de `{APP_NAME}_SOCKET_EVENTS` pour les événements dynamiques
  - **Instanciation automatique du service** : Recherche et appel d'une factory (`create*Service` ou `*ServiceFactory`)
  - **Démarrage automatique** : Appel de `.start()` sur l'instance du service
  - **Gestion des erreurs** : Si le démarrage échoue (mauvais paramètres, matériel absent), un warning est loggé et l'application continue
  - **Traces obligatoires** : Chaque service DOIT logger son démarrage avec niveau INFO et ses erreurs avec niveau WARN/ERROR
    - Exemple : `[INFO] [RfxComService] Démarrage du service RFXCOM...`
    - Exemple : `[INFO] [RfxComService] Transceiver RFXCOM initialisé avec succès sur /dev/ttyUSB0`
    - Exemple : `[WARN] [RfxComService] Tentative de connexion RFXCOM échouée - Motif: {erreur}`
- Seules les applications dans `applications/` sont :
  - Instanciées et démarrées automatiquement au démarrage
  - Visibles dans le menu de l'UI
  - Configurables via les paramètres techniques

**Processus d'activation/désactivation :**
> **Accès UI** : L'activation et la désactivation des applications se font via un **sous-menu des Paramètres Techniques** dans l'interface utilisateur.

1. **Backend API (recommandé) :**
   - `POST /api/applications/{id}/enable` → déplace `{id}/` de `applications_desactivees/` vers `applications/`
   - `POST /api/applications/{id}/disable` → déplace `{id}/` de `applications/` vers `applications_desactivees/`
   - **Exception** : L'API **rejecte** toute tentative de désactivation du `core/` avec une erreur 400
   - **Déclenche automatiquement un restart** via `RestartManager.ts`

2. **Filesystem (manuel) :**
   - Déplacement manuel du répertoire entre les deux dossiers
   - **Le répertoire `core/` ne doit JAMAIS être déplacé** vers `applications_desactivees/`
   - **Restart obligatoire** pour prise en compte (`docker restart` ou `pm2 restart`)

**Flux complet :**
```mermaid
graph TD
    A[Utilisateur clique [Activer]] --> B[Backend reçoit POST /api/applications/tartenpion/enable]
    B --> C[Backend vérifie que tartenpion/ existe dans applications_desactivees/]
    C --> D[fs.renameSync(applications_desactivees/tartenpion, applications/tartenpion)]
    D --> E[Backend émet app:restart via RestartManager]
    E --> F[Redémarrage de l'application]
    F --> G[AppService rescan applications/]
    G --> H[UI reçoit nouvelle liste via app:modules:list]
    H --> I[Menu mis à jour dynamiquement]
```

**Garanties :**
| Garantie | Mécanisme | Preuve |
|----------|-----------|--------|
| Zéro modification cœur | Déplacement de répertoires uniquement | Convention filesystem |
| Données conservées | `data/{app}/` non supprimé | Persistance indépendante |
| Activation réversible | Répertoire simplement déplacé | Pas de suppression |
| Détection automatique | Scan exclusif de `applications/` | `AppService.ts` lignes 160-175 |

**Points d'attention :**
1. **Core non désactivable** : Le répertoire `applications/core/` **ne peut pas être désactivé**. Toute tentative (API ou manuelle) est rejetée. Le core est toujours chargé et démarré.
2. **Nom unique** : Le nom du répertoire doit correspondre à l'`id` déclaré dans `domain/index.ts`
3. **Structure obligatoire** : Chaque application doit avoir au minimum `domain/index.ts` exportant `{APP_NAME}_APP`
4. **Factory de service requise** : Chaque application doit exporter une factory de service (`create*Service` ou `*ServiceFactory`) pour le démarrage automatique
5. **Méthode start() requise** : Chaque service doit implémenter une méthode `.start()` asynchrone
6. **Méthode stop() optionnelle** : Les services peuvent implémenter `.stop()` pour un arrêt propre (recommandé)
7. **Restart automatique sur changement de config** : Les services sont automatiquement redémarrés quand leur configuration est sauvegardée
8. **Gestion des erreurs de démarrage** : Si le démarrage d'un service échoue (mauvais paramètres, matériel absent), un warning est loggé avec le motif précis, et l'application continue de fonctionner. Les services doivent implémenter une gestion d'erreur robuste.
9. **Processus reproductible** : Le démarrage automatique (au boot et sur changement de params) doit être **reproductible pour toute nouvelle application** sans modification du cœur

**Injection de dépendances — `IAppConfigProvider` vs `ConfigService` :**
> **Contexte** : Les services d'application (ex: `RfxComService`) ont besoin d'accéder à leur section de configuration spécifique.
> 
> **Deux approches supportées** :
> - **`IAppConfigProvider<T>`** : Interface légère, typée, qui expose uniquement `getAppConfig(): T`. C'est l'approche recommandée pour les services métier (couche Domain) car elle respect le principe d'inversion de dépendances et limite l'accès à la configuration spécifique de l'application.
> - **`ConfigService`** : Service complet qui gère toute la configuration de l'application (toutes sections). Utilisé par la couche Infrastructure.
> 
> **Factory pattern** :
> - `createRfxComService(eventBus, logger, configProvider: IAppConfigProvider)` — Approche recommandée, typée
> - `createRfxComServiceWithConfig(eventBus, logger, configService: ConfigService)` — Approche alternative, crée elle-même le provider
> 
> **Résolution automatique** : `AppService` crée un `IAppConfigProvider` via `new AppConfigProvider(moduleId, configService)` et l'injecte dans chaque factory. Chaque service d'application reçoit donc un provider typé limitant l'accès à sa propre section de configuration.

---


## 5. Communication Socket.io

### 5.1 Principe général

Socket.io est **l'unique canal** de communication entre l'UI et le serveur.
L'API REST est supprimée. Seul `/health` reste en HTTP pour le healthcheck Docker.

```
UI (app.ts)  ←──── Socket.io ────→  server.ts
                                         │
                                    SocketBridge
                                         │
                                      EventBus
                                    ↙    ↓    ↘
                             MqttClient  HaSync  [Domain]
```

### 5.2 Événements Socket.io — Socle (server → client)

Ces événements sont émis par toutes les applications sans exception.

| Événement | Payload | Description |
|---|---|---|
| `app:status` | `{ mqtt: boolean, haEntities: number, uptime: number }` | État global — émis à la connexion et sur changement |
| `app:log` | `{ level: string, module: string, message: string, ts: string }` | Chaque ligne de log en temps réel |
| `ha:entity:updated` | `HaEntity` | Mise à jour d'une entité HA |
| `ha:sync:ready` | `{ entityCount: number }` | Référentiel HA initialisé |
| `config:current` | `AppConfig` | Config actuelle — émise sur demande ou après sauvegarde |
| `config:saved` | `{ success: boolean, error?: string }` | Résultat de la sauvegarde |
| `mqtt:connected` | `void` | Connexion MQTT établie |
| `mqtt:disconnected` | `{ reason: string }` | Perte de connexion MQTT |

### 5.3 Événements Socket.io — Socle (client → server)

| Événement | Payload | Description |
|---|---|---|
| `config:get` | `void` | Demande la config actuelle |
| `config:save` | `AppConfig` | Soumet une nouvelle configuration |
| `logs:get` | `{ lines: number }` | Demande les N dernières lignes de log |

### 5.4 Événements Socket.io — Extension par application

Chaque application déclare ses propres événements dans `applications/[app-name]/presentation/socket/events.ts`.
Elle les émet exclusivement via l'EventBus (jamais en appelant Socket.io directement depuis le domaine).

**Concernant MQTT :** chaque application décide librement quels messages MQTT elle relaie à l'UI.
Le `SocketBridge` s'abonne aux événements EventBus que le domaine choisit d'émettre,
et les retransmet au(x) client(s) Socket.io connectés.

Exemple de déclaration dans une application dérivée :
```typescript
// applications/[app-name]/presentation/socket/events.ts (application spécifique)
export const SOCKET_EVENTS = {
  // Hérités du socle
  ...SOCLE_SOCKET_EVENTS,
  // Spécifiques à cette application
  MQTT_RAW_MESSAGE: 'mqtt:raw',          // Remontée brute d'un topic MQTT vers l'UI
  AUTOMATION_TRIGGERED: 'automation:triggered',
} as const;
```

#### 5.4.1 Événements persistants — Diffusion automatique aux nouveaux clients

Le `SocketBridge` supporte les **événements persistants**, qui sont automatiquement envoyés à tout nouveau client Socket.io lors de sa connexion, sans nécessiter d'interrogation explicite.

**Mécanisme :**
1. Une application déclare quels événements sont persistants lors de l'enregistrement de ses événements Socket.io
2. Le `SocketBridge` stocke la dernière valeur de ces événements
3. Lorsqu'un nouveau client se connecte, le `SocketBridge` lui envoie automatiquement tous les événements persistants avec leur dernière valeur connue

**Format d'enregistrement :**
```typescript
// Émission par l'application lors de son initialisation
this.eventBus.emit('app:socket-events:registered', {
  appId: 'rfxcom',
  socketEvents: {
    STATUS: 'rfxcom:status',
    DEVICES_LIST: 'rfxcom:devices:list'
  },
  persistentEvents: ['rfxcom:status']  // ✅ Événements à envoyer automatiquement aux nouveaux clients
});
```

**Exemple pour le socle (core) :**
```typescript
// Dans AppService, lors du démarrage
this.eventBus.emit('app:socket-events:registered', {
  appId: 'core',
  socketEvents: SOCLE_SOCKET_EVENTS,  // Tous les événements du socle
  persistentEvents: [
    'app:status',       // Statut global de l'application
    'config:current',   // Configuration actuelle
    'mqtt:connected',   // Statut MQTT
    'mqtt:disconnected',
    'app:modules:list', // Liste des modules disponibles
    'ha:status'         // Statut HA
  ]
});
```

**Comportement :**
- Le client reçoit automatiquement `rfxcom:status` avec la dernière valeur lors de la connexion
- Si le statut change après la connexion, le client reçoit la mise à jour normalement
- Le client n'a **pas besoin** d'interroger explicitement le statut

**Cas d'usage typiques :**
- Statut de connexion d'une application (connecté/déconnecté)
- État global (nombre de devices, version, etc.)
- Configuration actuelle
- Derniers résultats de scan/découverte

**Avantages :**
- ✅ Réduction du trafic réseau (pas d'interrogation systématique)
- ✅ Meilleure UX (statut affiché immédiatement)
- ✅ Robustesse aux reconnexions
- ✅ Simplification du code client

### 5.5 Flux de sauvegarde de la configuration

```
UI                        SocketBridge / handlers.ts         ConfigWriter / RestartManager
 │                                   │                                   │
 │  emit('config:save', newConfig)   │                                   │
 │──────────────────────────────────>│                                   │
 │                                   │  Validation Zod                   │
 │                                   │  → emit('config:saved', {         │
 │                                   │      success: false, error })      │
 │                                   │  si invalide                      │
 │                                   │                                   │
 │                                   │  Écriture atomique config.yaml ──>│
 │                                   │                                   │
 │  emit('config:saved', {           │                                   │
 │    success: true })               │<──────────────────────────────────│
 │<──────────────────────────────────│                                   │
 │                                   │  setTimeout(500ms)                │
 │                                   │  → process.exit(0) ──────────────>│
 │                                   │                        Docker restart: unless-stopped
 │                                   │                        → nouvelle config chargée
```

---

### 5.5 Communication Inter-Applications

> **⭐ NOUVEAU v4.7** : Toutes les applications (sauf core) partagent le même EventBus et peuvent communiquer entre elles.
> Voir [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md) pour la spécification complète.

**Principe fondamental :** L'EventBus est **partagé entre toutes les applications**. Cela permet une communication directe et découplée.

#### 5.5.1 Deux patterns de communication

| Pattern | Description | Synchronisation | Utilisation |
|---------|-------------|-----------------|-------------|
| **Fire & Forget** | Événement unidirectionnel, aucune réponse attendue | Asynchrone | Notifications, événements de cycle de vie |
| **Request/Reply** | Question/Réponse avec corrélation via `requestId` | **Asynchrone avec Promises** | Appels de service, requêtes de données |

**Tous les échanges inter-applications sont asynchrones.** Aucun appel synchrone n'est autorisé.

#### 5.5.2 Système de corrélation Request/Reply

Pour les communications où une réponse est attendue :

```
Émetteur ──────[Request]──► EventBus ──────► Récepteur
     │         requestId: "app1-xxx-1"         │
     │                                        ▼
     │                               [Traitement ASYNCHRONE]
     │                                        │
     └──────────────────[Reply]◄──────────────┘
              requestId: "app1-xxx-1"
              inReplyTo: "app1-xxx-1"
```

**Structure de base :**
- **Request** : `{ requestId, capability, payload, fromApp, timestamp }`
- **Reply** : `{ requestId, inReplyTo, fromApp, status, result?, error?, timestamp }`

**Mécanisme :**
1. L'émetteur génère un `requestId` unique (`{appId}-{timestamp}-{seq}`)
2. L'émetteur émet la Request sur l'EventBus
3. Le récepteur traite la demande de manière **asynchrone**
4. Le récepteur émet la Reply avec le même `requestId`
5. L'émetteur reçoit la Reply via son `RequestTracker` (Promise résolue/rejetée)
6. Si timeout dépassé, la Promise est rejetée

#### 5.5.3 Déclaration des capacités

**Toute application (sauf core) DOIT exporter** ses capacités dans `domain/capabilities.ts` :

```typescript
// applications/{app-name}/domain/capabilities.ts
import type { AppRequest, AppReply, ApplicationCapabilities, RequestHandler } from '../../../core/src/types/interapp';

export const {APP_NAME}_CAPABILITIES: ApplicationCapabilities = {
  id: '{app-name}',
  name: '{App Name}',
  description: 'Description des capacités de cette application',
  version: '1.0',

  // Capacités gérées (Request/Reply)
  handledRequests: {
    '{app-name}:capability': {
      description: 'Description de cette capacité',
      requestType: 'AppRequest<MyRequestPayload>',
      responseType: 'AppReply<MyReplyResult>',
      handler: myCapabilityHandler
    }
  },

  // Événements émettables (Fire & Forget)
  emittedEvents: {
    '{app-name}:event': {
      description: 'Description de l\'événement',
      payloadType: 'MyEventPayload'
    }
  }
};
```

#### 5.5.4 Intégration décentralisée

`AppService` dans le core :
- **Détecte** les applications disponibles
- **Injecte** le même EventBus à toutes les applications
- Chaque application **documente** ses capacités dans sa spécification (section 9)
- Les conflits de noms sont évités par convention entre développeurs

#### 5.5.5 Utilisation via InterAppClient

**Dans une application (appelante) :**
```typescript
import { InterAppClient } from '../../../core/src/application/InterAppClient';

class MyAppService {
  private interApp: InterAppClient;

  constructor(eventBus: IEventBus, logger: Logger) {
    this.interApp = new InterAppClient(eventBus, logger, '{app-name}');
  }

  async callScheduler() {
    // Pose une question (asynchrone)
    const reply = await this.interApp.request(
      'scheduler:schedule',
      { action: 'turn_on', at: '+15m' },
      5000 // timeout 5 secondes
    );

    if (reply.status === 'success') {
      console.log('OK:', reply.result);
    }
  }

  notifyEvent() {
    // Émet un événement (Fire & Forget)
    this.interApp.emit('myapp:event', { data: 'value' });
  }
}
```

**Dans une application (réceptrice) :**
```typescript
class SchedulerService {
  constructor(eventBus: IEventBus, logger: Logger) {
    this.interApp = new InterAppClient(eventBus, logger, 'scheduler');
    
    // Configurer le handler
    this.interApp.onRequest(
      'scheduler:schedule',
      SCHEDULER_CAPABILITIES.handledRequests['scheduler:schedule'].handler
    );
  }
}
```

#### 5.5.6 Points clés à retenir

1. **⭐ EventBus partagé** : Toutes les applications utilisent la même instance
2. **⭐ Communication asynchrone** : Aucune communication bloquante
3. **⭐ Corrélation obligatoire** : Toujours utiliser `requestId` et `inReplyTo`
4. **⭐ Déclaration explicite** : Toute capacité DOIT être déclarée
5. **⭐ Typage fort** : Toujours typer les payloads avec TypeScript
6. **⭐ Pas de couplage direct** : Les applications ne connaissent pas l'implémentation des autres

> **📖 Pour plus de détails :** Voir [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md)

### 5.6 Porte d'authentification OAuth2 HA (accès externe)

**Contexte** : le serveur (Express + Socket.io) n'a par défaut **aucune authentification** — un
modèle pensé pour un LAN de confiance (CORS grand ouvert, aucune vérification à la connexion
Socket.io). Ce mécanisme optionnel comble ce vide pour une future instance externe dédiée,
exposée derrière un reverse proxy TLS (déploiement séparé, à la charge de l'exploitant — voir
§4.3 pour la notion d'instance mono-application). **Désactivé par défaut**
(`web.auth.enabled: false`), sans aucun effet sur un déploiement interne tant qu'il n'est pas
explicitement activé dans `data/core/config.yaml`.

**Principe** : le flux OAuth2 natif de Home Assistant sert **uniquement de portail de
connexion** (identifiant/mot de passe HA, MFA compris) — il n'y a pas de permissions
différenciées par utilisateur HA. Une fois authentifié, tout utilisateur partage le même accès
complet via le jeton longue durée déjà utilisé par le serveur pour piloter HA
(`ha.ws.token`) ; le token OAuth2 obtenu à la connexion n'est ni conservé, ni réutilisé pour
piloter HA — seule la réussite de l'échange fait foi de l'authentification.

**Flux** (conforme à `developers.home-assistant.io/docs/auth_api`) :

1. `GET /auth/login` → génère un `state` aléatoire, le pose dans un cookie `httpOnly` de courte
   durée (protection CSRF du round-trip, sans stockage serveur), redirige vers
   `{ha_base_url}/auth/authorize?client_id=...&redirect_uri=...&state=...` (pas de
   `response_type` — HA valide `client_id` par correspondance de domaine avec `redirect_uri`,
   style IndieAuth, aucun enregistrement préalable requis).
2. HA authentifie l'utilisateur puis redirige vers `redirect_uri?code=...&state=...`.
3. `GET /auth/callback` → vérifie `state` contre le cookie posé à l'étape 1, puis
   `POST {ha_base_url}/auth/token` (`grant_type=authorization_code`) — cet échange
   serveur-à-serveur **est** la preuve d'authentification (un `code` reçu en paramètre seul
   n'est jamais suffisant, il pourrait être rejoué). Succès → pose un cookie de session signé
   HMAC-SHA256 (`crypto` natif de Node, sans dépendance npm supplémentaire, sans état côté
   serveur — payload `{exp}` signé, `session_secret` de configuration), redirige vers la page
   d'origine.
4. `GET /auth/logout` → efface le cookie de session.

**Portée de la garde** : un middleware Express, enregistré **avant tout autre** (y compris les
fichiers statiques), protège toutes les routes sauf `/health` et `/auth/*`. **Socket.io est
gardé séparément** (`io.use()` sur le handshake, vérifiant le même cookie de session) — la seule
protection REST ne suffirait pas, Socket.io étant le canal principal de toutes les applications
(§5.1), pas seulement les routes REST exceptionnelles (§5.5 upload HAPLAN). Les cookies
voyagent automatiquement avec la connexion Socket.io (même origine) : aucune modification côté
client d'aucune application n'est nécessaire, la porte est entièrement transparente une fois la
session établie.

**Configuration** (`web.auth`, voir §7) : `enabled`, `ha_base_url` (URL HTTP publique de HA,
distincte de `ha.ws.host`/`port` qui reste réservé au WebSocket LAN), `client_id`,
`redirect_uri`, `session_secret`, `session_ttl_hours`. Section absente du fichier tant que non
activée explicitement ; si `enabled: true`, tous les champs sont requis (échec au démarrage
sinon, plutôt qu'un mode dégradé silencieux).

> **📖 Implémentation** : `applications/core/src/infrastructure/auth/AuthService.ts`,
> intégré dans `PresentationServer` (routes `/auth/*` + middleware de garde) et `SocketBridge`
> (`io.use()`).

---

## 6. Couche Présentation

> **⚠️ v4.7** : Cette section renvoyait auparavant vers Alpine.js, technologie **abandonnée** depuis `presentation_specs` v3.0 (migration complète vers **TypeScript pur + Web Components natifs**, sans framework UI tiers). Pour éviter toute duplication et désynchronisation entre documents (cf. règle anti-redondance de `PROMPT_PROJET.md` §10), ce socle ne détaille plus l'implémentation de la couche Présentation : elle est **entièrement spécifiée** dans [presentation_specs](presentation_specs_v4.0.md), qui fait référence. *(Obsolète depuis v4.13 — Alpine.js a été réintroduit, voir ci-dessous.)*

**Rappel des invariants** (détail complet dans `presentation_specs`) :
- TypeScript ES2020+ et Web Components natifs comme base ; Alpine.js autorisé en complément, sous réserve de respecter strictement `alpinejs-implementation_specs_v1.0.md` (cycle de vie, chargement, Shadow DOM)
- Autres frameworks UI tiers (React, Vue, Angular, etc.) — non retenus
- Toute la réactivité passe par des Custom Elements et des événements DOM natifs (nativement, ou via les directives Alpine sur ces mêmes Custom Elements)
- Communication exclusivement via Socket.io (sauf `/health`)

---

## 7. Configuration (`data/core/config.yaml` + `data/{app}/config.yaml`)

**⭐ v4.14** : La configuration n'est plus un fichier unique. Le socle (`ha`/`web`/`logging`)
vit dans `data/core/config.yaml`. Chaque application dérivée a son propre `data/{app}/config.yaml`
— un objet **nu** (pas de clé d'app en tête, le nom du dossier fait déjà cette distinction),
correspondant exactement à ce que documentaient jusqu'ici les sections métier "ajoutées" au
fichier unique. Au chargement, `ConfigLoader` fusionne le fichier socle et tous les
`data/{app}/config.yaml` détectés en un seul objet en mémoire — de forme **identique** à
l'ancienne : `getConfig()` retourne toujours `{ha, web, logging, evoo7, rfxcom, ...}`. Seuls le
chargement et l'écriture sur disque changent ; `IAppConfigProvider`/code métier des applications
ne sont pas affectés (§7.4).

### 7.1 Structure complète de référence (vue fusionnée en mémoire)

```yaml
ha:
  # Flags d'activation pour HA WebSocket et MQTT
  ws_enable: false                 # Activer la connexion WebSocket HA
  mqtt_enable: false               # Activer la connexion MQTT HA
  
  # Configuration WebSocket HA (requis si ws_enable: true)
  ws:
    host: "192.168.1.x"           # Adresse IP de Home Assistant
    port: 8123                    # Port WebSocket HA (par défaut 8123)
    token: ""                    # Long-Lived Access Token HA — via .env de préférence
    reconnect_delay: 5            # Secondes, backoff exponentiel plafonné à 60s
  
  # Configuration MQTT HA (requis si mqtt_enable: true)
  mqtt:
    host: "192.168.1.x"           # Adresse IP du broker MQTT
    port: 1883                    # Port MQTT (par défaut 1883)
    client_id: "app-nom-unique"    # Doit être unique par application
    username: ""                 # Optionnel
    password: ""                 # Optionnel
    keepalive: 60                # Secondes
    reconnect_delay: 5           # Secondes
  
  # Configuration de structuration HA
  structure:
    include_unassigned: false     # Inclure les entités sans area
    unassigned_label: "Non assigné" # Label de la zone virtuelle si include_unassigned: true

web:
  port: 8080
  host: "0.0.0.0"
  # Optionnel — absent tant que la porte d'authentification OAuth2 HA n'est pas activée
  # explicitement (voir §5.6). Réservé à une future instance externe dédiée.
  # auth:
  #   enabled: false               # true active la garde REST + Socket.io
  #   ha_base_url: "https://ha.example.com"       # URL HTTP publique de HA (≠ ha.ws.host, LAN)
  #   client_id: "https://cette-instance.example.com/"      # Origine publique de CETTE instance
  #   redirect_uri: "https://cette-instance.example.com/auth/callback"  # Même origine que client_id
  #   session_secret: ""           # Secret HMAC de signature du cookie de session — requis si enabled
  #   session_ttl_hours: 720       # 30 jours

logging:
  level: "info"                  # "debug" | "info" | "warn" | "error"
  rotate:
    max_size_mb: 10
    max_files: 5

# Chaque application dérivée a son propre data/{app}/config.yaml (objet nu, fusionné ici
# en mémoire sous la clé {app} par ConfigLoader), intégré au schéma Zod de l'application
```

### 7.2 Règles

- Lecture **au démarrage uniquement** via `ConfigLoader` — erreur fatale si invalide ; fusionne
  `data/core/config.yaml` et chaque `data/{app}/config.yaml` détecté par scan de `data/`
- Écriture **uniquement via `ConfigWriter`** déclenché par Socket.io — jamais depuis le domaine
- Écriture **atomique** par fichier : écriture dans `{fichier}.tmp` puis renommage — `saveConfig()`
  (formulaire "Paramètres Techniques" socle) n'écrit que `data/core/config.yaml` (`ha`/`web`/
  `logging` extraits de la config fusionnée reçue du client) ; `saveModuleConfig()`/
  `savePartialConfig()` (config applicative) n'écrivent que `data/{moduleId}/config.yaml` —
  jamais les deux à la fois, jamais les fichiers des autres applications
- Le schéma **Zod** dans `schema.ts` est la source de vérité — il documente types, optionnalité et valeurs par défaut
- Les applications dérivées **étendent** le schéma Zod de base sans le modifier
- **HA WS et MQTT** : La section `mqtt` a été **déplacée sous `ha`** et est activée via le flag `ha.mqtt_enable`. De même, `ha.ws` est activé via `ha.ws_enable`. Les deux peuvent coexister ou être désactivés indépendamment.
- **Compatibilité** : Les sections `ha.ws` et `ha.mqtt` peuvent être présentes dans la configuration même si leurs flags respectifs (`ws_enable`, `mqtt_enable`) sont à `false` — elles ne seront simplement pas initialisées.

### 7.3 Changements v4.3 — Activation conditionnelle HA WS/MQTT

**Nouveauté v4.3** : La configuration HA a été restructurée pour permettre une activation conditionnelle et indépendante des connecteurs WebSocket et MQTT.

**Structure précédente (v4.2) :**
```yaml
# au niveau racine
mqtt: { ... }  # optionnel, uniquement pour les apps "integration"

# dans ha
hat:
  ws: { host, port, token, reconnect_delay }
  structure: { ... }
```

**Nouvelle structure (v4.3) :**
```yaml
hat:
  # Flags d'activation
  ws_enable: false      # Désactivé par défaut
  mqtt_enable: false   # Désactivé par défaut
  
  # Configurations (peuvent être présentes même si désactivées)
  ws: { host, port, token, reconnect_delay }
  mqtt: { host, port, client_id, username, password, keepalive, reconnect_delay }
  structure: { ... }
```

**Règles d'activation :**
- HA WebSocket est initialisé **uniquement si** : `ha.ws_enable === true` **ET** `ha.ws.host` **ET** `ha.ws.token` sont présents
- HA MQTT est initialisé **uniquement si** : `ha.mqtt_enable === true` **ET** `ha.mqtt` est présent et valide
- Les deux connecteurs peuvent être **activés indépendamment** ou **désactivés simultanément**
- Les sections `ha.ws` et `ha.mqtt` peuvent **rester dans le fichier** même si désactivées (pour conservation de la configuration)

**Avantages :**
- Activation/désactivation **sans supprimer** les paramètres de configuration
- **Indépendance** totale entre WS et MQTT
- **Clarté** : les flags `*_enable` rendent l'état explicite
- **Flexibilité** : permet de tester différentes combinaisons sans modifier la structure

---

### 7.4 Accès à la configuration — ConfigService

Le **`ConfigService`** est le **point d'accès centralisé** à la configuration pour toutes les couches.
Il est instancié **une seule fois** dans `index.ts` (bootstrap) et **injecté** dans les services qui en ont besoin.

**Règles strictes :**
- **Une seule instance** : `ConfigService` est instancié une fois au démarrage et injecté via les constructeurs
- **Pas de singleton global** : Aucune méthode statique, pas de `getInstance()`
- **Pas d'accès direct** : Les couches ne lisent pas `config.yaml` directement — tout passe par `ConfigService`
- **Immuabilité** : La configuration retournée par `ConfigService` ne doit pas être modifiée directement

**Responsabilités :**
- Charger la configuration via `ConfigLoader` au démarrage
- Fournir un accès typé à la configuration complète ou à ses sections
- Centraliser la validation et les valeurs par défaut

**Exemple d'utilisation :**
```typescript
// index.ts (bootstrap)
const configService = new ConfigService(new ConfigLoader());
const haWsClient = new HaWsClient(configService.getHaConfig().ws);

// Dans un service (couche HA ou Application)
class MyService {
  constructor(private configService: ConfigService) {} 
  
  doSomething() {
    const mqttConfig = this.configService.getMqttConfig();
    // ...
  }
}
```

---

## 8. Couche HA

La couche HA est le **seul point de contact** entre l'application et Home Assistant.
Elle se décline en deux modes de communication distincts, qui ne se mélangent jamais :

- **A) Synchronisation du référentiel** — via le **Web Service** (WebSocket natif HA, port 8123)
- **B) Modules d'intégration** — via **MQTT**, uniquement pour les applications qui en ont besoin

### 8.1 Mode A — Synchronisation du référentiel (Web Service)

#### 8.1.1 Protocole de connexion

L'API WebSocket native de HA est utilisée sur `ws://<ha-host>:8123/api/websocket`.
Authentification par **Long-Lived Access Token**.

```
1. Connexion WS → HA envoie { type: "auth_required" }
2. Client envoie { type: "auth", access_token: "..." }
3. HA répond { type: "auth_ok" } ou { type: "auth_invalid" } → exit(1)
4. Chargement initial (voir 8.1.2)
5. Souscription aux événements temps réel (voir 8.1.3)
```

#### 8.1.2 Chargement initial

Au démarrage, après authentification, trois appels en parallèle :

```typescript
{ id: 1, type: "get_states" }                  // Toutes les entités + états
{ id: 2, type: "config/area_registry/list" }   // Toutes les areas
{ id: 3, type: "config/device_registry/list" } // Tous les devices
```

Une fois les trois réponses reçues :
1. Peuplement de `HaStateRegistry`
2. Peuplement de `HaStructureRegistry` (classification + structuration via `HaClassifier`)
3. `EventBus.emit('ha:ready', { entityCount, areaCount, deviceCount })`

#### 8.1.3 Souscriptions temps réel

```typescript
{ id: 10, type: "subscribe_events", event_type: "state_changed" }
{ id: 11, type: "subscribe_events", event_type: "area_registry_updated" }
{ id: 12, type: "subscribe_events", event_type: "device_registry_updated" }
{ id: 13, type: "subscribe_events", event_type: "entity_registry_updated" }
```

Sur réception de chaque événement : mise à jour du registre concerné, recalcul partiel
de `HaStructureRegistry` si nécessaire, puis émission EventBus correspondante.

#### 8.1.4 Reconnexion

- Reconnexion automatique, backoff exponentiel plafonné à 60s
- À chaque reconnexion : rechargement initial complet (8.1.2)
- Pendant la déconnexion : les registres conservent leur dernier état connu
- `EventBus.emit('ha:disconnected')` / `EventBus.emit('ha:reconnected')` aux transitions

### 8.2 Référentiel Structuré `area → QUOI → entités`

```typescript
// Une area HA enrichie
interface HaArea {
  area_id: string;
  name: string;
  quoiMap: Map<string, HaQuoi>;        // clé = quoi_id
}

// Un concept métier (le "QUOI")
interface HaQuoi {
  quoi_id: string;                     // ex: "eclairage", "climat", "securite"
  label: string;                       // ex: "Éclairage"
  entities: HaStructuredEntity[];
}

// Une entité dans le référentiel structuré
interface HaStructuredEntity {
  entity_id: string;
  friendly_name: string;
  domain: string;
  device_class?: string;
  state: string;
  attributes: Record<string, unknown>;
  device_id?: string;
  area_id?: string;
  quoi_ids: string[];                  // Une entité peut appartenir à plusieurs QUOI
  last_updated: Date;
  // Références complètes (peuplées par HaStructureRegistry)
  device?: HaDevice;                   // Référence au device parent
  area?: HaArea;                     // Référence à l'area parente
}

// Racine du référentiel structuré
interface HaStructuredRegistry {
  areas: Map<string, HaArea>;
  unassigned?: HaArea;                 // Présent si ha.structure.include_unassigned = true
  lastFullSync: Date;
}
```

**Règles de structuration :**

- **Attribution area** : via `device_id` → `device.area_id`, ou directement `entity.area_id`
  (priorité à `entity.area_id` si les deux sont définis). Sans area : placée dans `unassigned`
  selon `ha.structure.include_unassigned`.
- **Attribution QUOI** : entièrement déléguée au `HaClassifier` (voir 8.3). Une entité peut
  recevoir **plusieurs QUOI**. Si aucun QUOI ne correspond, l'entité est placée dans le
  QUOI système `"non_classifie"`.

### 8.3 HaClassifier — Module de Classification

La détermination du QUOI est assurée par le module `HaClassifier` qui implémente l'interface `IHaClassifier`.

**Document de référence pour RFXCOM** : Pour les règles spécifiques aux devices RFXCOM (notamment la priorité du champ `subType`),
voir [`specs-classification-rfxcom-v1.0.md`](specs-classification-rfxcom-v1.0.md).

#### 8.3.0 Priorités de Classification (Générique)
Pour toutes les entités, l'ordre de priorité est :
1. `device_class` HA (le plus précis pour les entités standard)
2. `domain` HA
3. Dernier segment de `entity_id` après `--`
4. `non_classifie` (fallback)

> **⚠️ Pour les entités RFXCOM** : L'ordre est **différent** (voir §8.3.1).

#### 8.3.1 Priorités de Classification pour RFXCOM
Pour les entités issues de devices RFXCOM (détectées par leur `entity_id`, `attributes.subType`, ou `device_id`),
l'ordre de priorité est **modifié** pour tenir compte des champs spécifiques RFXCOM :

1. **`subType` RFXCOM** (le plus précis, ex: `Temperature` → `température`)
2. `type` RFXCOM (ex: `RFXSensor` → `capteurs`)
3. `device_class` HA (générique)
4. `domain` HA (générique)
5. Dernier segment de `entity_id` après `--`
6. `non_classifie` (fallback)

> **Exemple** : Une entité avec `attributes.subType = "Temperature"` et `device_class = "humidity"` sera classée comme `température` (priorité à `subType`).

Voir [`specs-classification-rfxcom-v1.0.md`](specs-classification-rfxcom-v1.0.md) pour le **mapping complet** `subType`/`type` → QUOI.

```typescript
interface IHaClassifier {
  /**
   * Retourne les quoi_ids applicables à une entité.
   * Retourne [] si aucun QUOI ne correspond.
   * 
   * @param entity - Entité à classer (avec domain, device_class, entity_id, et attributs RFXCOM)
   * @returns Tableau de quoi_ids (au moins un, jamais vide)
   */
  classify(entity: HaStructuredEntity): string[];

  /**
   * Retourne le catalogue des QUOI disponibles dans cette implémentation.
   */
  getQuoiCatalog(): HaQuoiDefinition[];

  /**
   * Retourne la définition d'un QUOI par son ID.
   */
  getQuoiDefinition(quoiId: string): HaQuoiDefinition | undefined;

  /**
   * Classifie une entité avec métadonnées sur la méthode utilisée (pour le debug).
   */
  classifyWithDetails(entity: HaStructuredEntity): ClassificationResult;
}

interface HaQuoiDefinition {
  quoi_id: string;
  label: string;
  description?: string;
}

interface ClassificationResult {
  entity_id: string;
  quoi_ids: string[];
  matchedBy: 'subType' | 'type' | 'device_class' | 'domain' | 'entity_id' | 'fallback';
}
```

### 8.3.1 Méthodes d'accès de HaStructureRegistry

Le `HaStructureRegistry` expose les méthodes suivantes pour l'accès par la couche Métier.
**Toutes les entités retournées incluent :** `quoi_ids[]` (liste des QUOI) et `area`/`device` (références complètes).

```typescript
// Accès par identifiant
getEntity(entityId: string): HaStructuredEntity | undefined
getAllEntities(): HaStructuredEntity[]

// Accès par QUOI
getEntitiesByQuoi(quoiId: string): HaStructuredEntity[]

// Accès par Area
getEntitiesByArea(areaId: string): HaStructuredEntity[]

// Accès par Area + QUOI
getEntitiesByAreaAndQuoi(areaId: string, quoiId: string): HaStructuredEntity[]

// Accès aux structures
getAreas(): Map<string, HaArea>
getArea(areaId: string): HaArea | undefined
getDevices(): Map<string, HaDevice>
getDevice(deviceId: string): HaDevice | undefined
getQuoiCatalog(): HaQuoiDefinition[]

// Métadonnées
getEntityCount(): number
getLastFullSync(): Date | null
getRegistry(): HaStructuredRegistry
```

**Règles :**
- Chaque `HaStructuredEntity` retournée contient **toujours** :
  - `quoi_ids: string[]` — Liste de tous les QUOI auxquels l'entité appartient
  - `area?: HaArea` — Référence complète à l'area parente (si définie)
  - `device?: HaDevice` — Référence complète au device parent (si défini)
- Les références `area` et `device` sont peuplées par `HaStructureRegistry` pendant l'initialisation
- Priorité pour `area_id` : `entity.area_id` > `device.area_id`

`HaStructureRegistry` reçoit son implémentation de `IHaClassifier` par injection de
dépendance au bootstrap (`index.ts`).

### 8.4 Envoi de Commandes — HaCommandService

```typescript
interface HaCommand {
  entity_id: string | string[];
  domain: string;                      // Ex: "light", "switch", "climate"
  service: string;                     // Ex: "turn_on", "turn_off", "set_temperature"
  service_data?: Record<string, unknown>;
}

interface HaCommandResult {
  success: boolean;
  command: HaCommand;
  error?: string;
}
```

Les commandes sont envoyées via le message WebSocket HA `call_service` :

```json
{
  "id": 42,
  "type": "call_service",
  "domain": "light",
  "service": "turn_on",
  "target": { "entity_id": "light.salon" },
  "service_data": { "brightness": 128 }
}
```

Le résultat est émis sur `EventBus.emit('ha:command:result', HaCommandResult)`.
La couche métier envoie ses commandes via `EventBus.emit('ha:command:send', HaCommand)` —
jamais d'appel direct à `HaWsClient`.

### 8.5 Mode B — Modules d'intégration (MQTT)

Le mode MQTT de la couche HA est **réservé exclusivement** aux applications de type
**intégration** : celles dont la fonction est de faire le pont entre Home Assistant
et un système tiers (capteur externe, passerelle, service cloud, etc.).

> **⭐ v4.8** : Précision du **format des topics** MQTT (état/commande/LWT) et introduction du
> concept de **bridge_instance**. Remplace intégralement les §8.5.1 à 8.5.4 précédents.

#### 8.5.0 Mission et Principes

Le socle expose **un seul broker MQTT** (`ha.mqtt`, une seule adresse — voir §7.1) partagé par
toutes les applications d'intégration. Pour chaque intégration active (ex: RFXCOM), le socle a la
responsabilité de :

1. Publier le **LWT** (Last Will and Testament) — **un par bridge_instance** (voir §8.5.1)
2. Publier la **découverte** des entités vers HA, de façon **persistante** (retain)
3. Publier les **changements d'état** du matériel vers HA
4. **Recevoir les commandes** émises par HA et les router vers le module d'intégration concerné

**Répartition des responsabilités (règle absolue) :**
- Le **module d'intégration métier** (ex: RFXCOM) ne fournit que les **données essentielles**
  de chaque entité (nom, classe, valeur, unité, identifiants) — jamais le message MQTT complet.
- Le **module d'intégration HA du socle** (`HaMqttIntegrationService` / pont d'intégration) est
  seul responsable de **construire et normaliser l'intégralité** du message de découverte HA
  (topics, bloc `device`, `availability_topic`, valeurs par défaut, etc.). Un module métier ne
  doit jamais construire lui-même un payload de découverte HA complet.

#### 8.5.1 Concept de `bridge_instance`

Une application d'intégration peut piloter **plusieurs instances physiques ou logiques** du même
type de pont (ex: plusieurs transceivers RFXCOM branchés sur la même installation). Chaque
instance est identifiée par un **`bridge_instance`** unique au sein de l'application
(ex: `rfx_bridge_0001`, `rfx_bridge_0002`).

- Le `bridge_instance` est défini et attribué par le module d'intégration métier
  (pas par le socle) — il doit être stable dans le temps (persisté en configuration)
- **Le LWT est publié par bridge_instance**, pas par application : si un seul transceiver tombe,
  seules ses entités doivent apparaître indisponibles dans HA, pas toute l'intégration
- `HaMqttModuleConfig` (voir §8.5.2) porte ce champ

#### 8.5.2 HaMqttIntegrationService — Service MQTT Générique

Le service `HaMqttIntegrationService` fournit une **abstraction générique** pour la communication
MQTT avec Home Assistant, utilisable par tous les modules d'intégration.

```typescript
// Configuration d'un module d'intégration
interface HaMqttModuleConfig {
  moduleName: string;        // Nom unique du module (ex: "rfxcom", "zigbee2mqtt")
  bridgeInstance: string;    // ⭐ v4.8 — Identifiant du pont physique/logique (ex: "rfx_bridge_0001")
  clientId: string;         // Client ID MQTT
  cleanSession: boolean;   // Nettoyer la session (default: false)
  keepalive: number;       // Keepalive en secondes (default: 60)
  reconnectPeriod: number; // Délai de reconnexion en ms (default: 5000)
}

// Service MQTT générique
class HaMqttIntegrationService {
  // Connexion
  connect(host: string, port: number, username?: string, password?: string): Promise<void>
  disconnect(): void
  isConnectedToMqtt(): boolean
  
  // Publication HA — construit et normalise l'intégralité du message (voir §8.5.0)
  publishDiscovery(component: string, objectId: string, entity: HaMqttDiscoveryEntity, retain?: boolean, qos?: 0|1|2): void
  publishState(deviceId: string, state: HaMqttStateMessage, retain?: boolean, qos?: 0|1|2): void
  
  // Passthrough — relais de messages déjà formés, sans normalisation (⭐ v4.9, voir §8.5.6)
  publishDiscoveryPassthrough(sourceTopic: string, payload: unknown): void
  publishPassthrough(topic: string, payload: unknown, qos?: 0|1|2, retain?: boolean): void
  
  // Abonnements
  subscribeToCommands(deviceId: string, qos?: 0|1|2): void
  subscribeToAllModuleCommands(qos?: 0|1|2): void
  unsubscribeFromCommands(deviceId: string): void
  
  // Callbacks
  onCommand(callback: (event: IntegrationCommandEvent) => void): void
  onConnectionChange(callback: (module: string, bridgeInstance: string, connected: boolean) => void): void
}
```

**Règles pour HaMqttIntegrationService :**
- **LWT** : Topic `{moduleName}/{bridgeInstance}/status` (voir §8.5.4) avec payload `online`/`offline`, QoS 1, retain true
- **QoS par défaut** : Discovery/State = QoS 1 + retain true, Commands = QoS 1 + retain false
- **Reconnexion automatique** avec backoff configurable
- **Gestion des erreurs** : Logging + reconnexion automatique, avec les codes normalisés (voir `erreurs_specs`)
- **⭐ v4.11 — Abonnement automatique aux commandes** : `publishDiscoveryFor` (nom réel de la méthode de
  publication de découverte normalisée) abonne automatiquement le bridge au topic de commande
  correspondant si l'entité essentielle fournie par le module a `commandEnabled: true`. Un module
  métier n'a donc **jamais** besoin d'appeler explicitement `subscribeCommandsFor` pour une entité
  déjà publiée via la découverte normale — l'abonnement est couplé 1:1 à la publication.

#### 8.5.3 Structure des modules d'intégration

Chaque module d'intégration suit cette structure :

```bash
src/ha/integration/
└── [module-name]/
    ├── [ModuleName]Service.ts    # Service métier (couche HA)
    └── types.ts                 # Types spécifiques
```

**Communication entre les couches :**
```
[ModuleName]Service (HA) 
  ↔ EventBus emit('integration:{module}:discovery')
     ↔ HaMqttIntegrationService (HA) 
        ↔ MQTT Broker
           ↔ Home Assistant
```

**Règles d'implémentation d'un module :**
1. **Pas d'accès direct** à MQTT dans le service métier (utiliser EventBus)
2. **Découverte HA** : Le service métier émet `integration:discovery` avec les **données essentielles
   uniquement** ; `HaMqttIntegrationService` complète et publie le message normalisé sur MQTT (voir §8.5.0)
3. **État** : Le service métier émet `integration:state`, HaMqttIntegrationService publie sur MQTT
4. **Commandes** : HaMqttIntegrationService reçoit de MQTT, émet sur EventBus, service métier écoute et exécute

#### 8.5.4 Format des Topics MQTT

Deux familles de topics coexistent, avec des rôles distincts :

| Type | Topic | Direction | Format standard |
|---|---|---|---|
| **Découverte** | `homeassistant/{component}/{object_id}/config` | App → HA | **Inchangé** — convention MQTT Discovery standard de HA |
| **État** | `{moduleName}/{bridgeInstance}/{deviceId}/state` | App → HA | Espace de nom propre à l'intégration |
| **Commande** | `{moduleName}/{bridgeInstance}/{deviceId}/set` | HA → App | Référencé comme `command_topic` dans le message de découverte |
| **LWT** | `{moduleName}/{bridgeInstance}/status` | App → Broker | `online` / `offline`, un par bridge_instance |

**Règles :**
- Le topic de **découverte** (`.../config`) reste au format HA standard : c'est celui que HA scanne
  automatiquement. `object_id` suit la convention de nommage technique de chaque application
  (ex: `<protocole>_<sensorId>` pour RFXCOM, voir `nommage_specs`).
- Les topics d'**état** et de **commande** sont propres à l'espace de noms de l'application
  (`{moduleName}/{bridgeInstance}/...`) et sont **référencés depuis le message de découverte**
  via les champs `state_topic` / `command_topic` — HA ne les déduit pas lui-même.
- **`deviceId`** est un **identifiant opaque** dont la structure interne est définie par chaque
  module d'intégration selon ses propres conventions (il peut différer de `object_id`). Voir la
  spécification propre à chaque application pour son encodage exact
  (ex: `recepteurs-emetteurs-rfxcom_specs` pour RFXCOM).
- Ce format **remplace** l'ancien schéma générique `homeassistant/{component}/{object_id}/state|set`
  utilisé jusqu'en v4.7, ainsi que l'ancien topic LWT `ha-integration/{module}/status` (qui n'avait
  pas la granularité par bridge_instance).
- **`device.suggested_area`** (⭐ v4.17) : nom de l'area HA à suggérer (une chaîne, ex: `"Salon"` —
  **pas** un `area_id` technique, qui n'existe pas dans le schéma de découverte MQTT de HA et
  n'est donc jamais exploitable ici). HA ne s'en sert qu'**une fois**, à la création de l'entité,
  pour lui assigner automatiquement une area si elle n'en a pas déjà une — jamais réappliqué
  ensuite, donc sans effet sur une entité déjà assignée manuellement ou par une exécution
  précédente. Alimenté avec le **lieu** de la taxonomie (pas le lieu précis) : `nomLieu` dans
  `ExtractedTaxonomy` (RFXCOM/EVOO7/AREXX, module `taxonomy.ts` dupliqué par application) ou
  `parsed.ou.lieu.raw` (NOMMAGE, passthrough — n'altère que si un bloc `device` existe déjà dans
  le message relayé). Omis si le lieu n'est pas renseigné.
- **⭐ v4.18 — Garantie active de l'area (`AreaEnsureService`)** : vérifié en conditions réelles
  (suppression + redécouverte complète d'une entité, puis redémarrage complet de HA) que
  `suggested_area` seul ne suffit pas — HA ne l'applique de façon fiable qu'à la toute première
  création d'un device, jamais de façon garantie même sur une redécouverte propre. `core` **crée
  donc l'area lui-même via l'API WebSocket de HA** (`config/area_registry/create`, Mode A),
  **avant** de publier la découverte — entièrement transparent pour les 4 applications
  émettrices, qui continuent seulement d'alimenter `device.suggested_area` comme avant.
  Interception dans `IntegrationBridge.subscribeModuleEvents()` (les deux chemins de découverte,
  `integration:{module}:discovery` et `integration:{module}:passthrough:discovery`), best-effort
  (timeout ~8s, jamais bloquant — une erreur/dépassement n'empêche jamais la publication).
  Optionnel : sans Mode A actif (`ha.ws_enable: false`), `AreaEnsureService` n'est pas construit,
  `suggested_area` reste sans effet garanti comme avant. Vérifié en conditions réelles sur une
  installation HA neuve (broker MQTT et registre HA réinitialisés) : **86 devices sur 96** ont
  reçu leur area automatiquement (les 10 restants : 9 devices HA natifs sans rapport, 1 device
  EVOO7 partagé bloqué par le même effet "figé à la première création" — sa toute première
  entité découverte n'avait pas de lieu de taxonomie saisi).

**Exemple de message de découverte (généré par le socle, données essentielles fournies par le module) :**
```json
{
  "name": "Température Salon",
  "unique_id": "rfxcom_temperature_001",
  "device_class": "temperature",
  "state_topic": "rfxcom/rfx_bridge_0001/rfxsensor_0xa5b3/state",
  "command_topic": "rfxcom/rfx_bridge_0001/rfxsensor_0xa5b3/set",
  "unit_of_measurement": "°C",
  "device": {
    "identifiers": ["rfxcom_001"],
    "name": "RFXCOM Transceiver",
    "manufacturer": "RFXCOM",
    "model": "RFXtrx433E"
  }
}
```

**State (`{moduleName}/{bridgeInstance}/{deviceId}/state`) :**
```json
{
  "state": "22.5",
  "attributes": {
    "unit_of_measurement": "°C",
    "friendly_name": "Température Salon"
  }
}
```

**Command (`{moduleName}/{bridgeInstance}/{deviceId}/set`) :**
```json
{
  "state": "on"
}
```

#### 8.5.5 Événements EventBus pour les modules

**Modules → HaMqttIntegrationService :**
- `integration:{module}:discovery` → Découverte d'une entité à publier vers HA (données essentielles uniquement)
- `integration:{module}:state` → Changement d'état à publier vers HA
- `integration:{module}:passthrough:discovery` → Passthrough découverte, réécriture de préfixe (⭐ v4.9, voir §8.5.6)
- `integration:{module}:passthrough:publish` → Passthrough complet, aucune transformation (⭐ v4.9, voir §8.5.6)

**HaMqttIntegrationService → Modules :**
- `integration:{module}:command` → Commande reçue de HA à exécuter

**HaMqttIntegrationService → Application :**
- `ha:integration:connected` → Bridge MQTT connecté (payload inclut `bridgeInstance`)
- `ha:integration:disconnected` → Bridge MQTT déconnecté (payload inclut `bridgeInstance`)

> - Les applications activent HA WS via `ha.ws_enable` et MQTT via `ha.mqtt_enable`
>   (une seule adresse de broker, partagée par toutes les intégrations — voir §7.1).
>   Les applications qui ne sont pas des intégrations n'activent **pas** ces flags
>   dans leur configuration, et n'instancient aucun module sous `src/ha/integration/`
> - Chaque module d'intégration vit dans son propre sous-dossier `src/ha/integration/[module]/`
>   et reste indépendant des autres modules d'intégration
> - Connexion MQTT : reconnexion automatique (backoff plafonné à 60s), QoS 1 pour états/commandes/LWT

#### 8.5.6 Passthrough MQTT

> **⭐ v4.9** : Nouveau mécanisme, distinct du flux normalisé §8.5.0-8.5.5.

**Cas d'usage.** Certaines applications n'ont pas de matériel à décrire sous forme de devices/entités
normalisées (comme RFXCOM) : elles disposent déjà d'un **message MQTT complet**, obtenu par lecture
d'une source tierce (un autre broker, ou un autre topic du même broker), qu'elles doivent simplement
faire transiter vers le broker HA unique du socle (`ha.mqtt`, §7.1), éventuellement après l'avoir
modifié. Exemple : l'application `nommage` lit les messages de découverte de Zigbee2MQTT — publiés
volontairement sur un préfixe différent (ex: `homeassist/...`) pour ne pas être auto-découverts
directement — les enrichit (attributs de taxonomie) et les republie pour HA.

Pour ce besoin, `HaMqttIntegrationService` expose un canal **passthrough** : l'application ne fournit
pas de données essentielles à normaliser (contrairement à §8.5.0), mais un message déjà formé.
**Deux modes :**

**Mode Découverte — réécriture de préfixe**
- Événement : `integration:{module}:passthrough:discovery`
- Payload : `{ sourceTopic: string, payload: unknown }`
- Traitement : le socle remplace le **premier segment** de `sourceTopic` par `homeassistant`, puis
  publie le résultat avec QoS 1 et retain `true` (règles standard de découverte, §8.5.0)
- Exemple : `sourceTopic: "homeassist/sensor/temp_cuisine/config"` → publié sur
  `homeassistant/sensor/temp_cuisine/config`

**Mode Complet — passthrough intégral**
- Événement : `integration:{module}:passthrough:publish`
- Payload : `{ topic: string, payload: unknown, qos?: 0|1|2, retain?: boolean }`
- Traitement : **aucune transformation** — publication telle quelle sur le broker HA unique, avec
  les QoS/retain fournis (par défaut : QoS 1, retain `false` si non précisés)

**Règles :**
- Les deux modes utilisent la **connexion MQTT unique du socle** (`ha.mqtt`) — aucune connexion
  supplémentaire n'est ouverte par `HaMqttIntegrationService` pour le passthrough
- Le passthrough est **indépendant** du concept de `bridge_instance`/`deviceId` (§8.5.1/§8.5.4) :
  il ne s'applique pas aux intégrations "device-centric" (RFXCOM), mais aux applications qui
  relaient des messages déjà formés. `bridgeInstance` reste néanmoins requis dans
  `HaMqttModuleConfig` pour le LWT (§8.5.2) — une application passthrough-only peut y renseigner
  une valeur fixe unique si elle ne pilote pas plusieurs instances physiques
- La **lecture** des sources tierces (autre broker, topics étrangers) reste **entièrement à la
  charge de l'application** — le socle ne fait que publier vers `ha.mqtt` ; il n'ouvre ni ne gère
  aucune connexion vers une source externe

### 8.6 Événements EventBus — Couche HA

```typescript
type AppEvents = {
  // ... événements socle (application, présentation) ...

  // Couche HA → Application (mode A — Web Service)
  'ha:ready':                  { entityCount: number; areaCount: number; deviceCount: number };
  'ha:disconnected':           void;
  'ha:reconnected':            void;
  'ha:entity:state_changed':   HaStructuredEntity;
  'ha:area:updated':           HaArea;
  'ha:structure:rebuilt':      HaStructuredRegistry;
  'ha:command:result':         HaCommandResult;

  // Application → Couche HA (commandes)
  'ha:command:send':           HaCommand;

  // Couche HA → Application (mode B — intégration MQTT, propre à chaque module)
  // Ex: 'ha:integration:[module]:event': <payload spécifique au module>
};
```

### 8.7 Événements Socket.io — Couche HA

Ajouts au catalogue Socket.io (server → client) :

| Événement | Payload | Description |
|---|---|---|
| `ha:ready` | `{ entityCount, areaCount, deviceCount }` | Référentiel initial prêt |
| `ha:status` | `{ connected: boolean }` | Statut connexion WS HA |
| `ha:entity:changed` | `HaStructuredEntity` | Changement d'état d'une entité |
| `ha:structure` | `HaStructuredRegistry` | Référentiel complet (sur demande) |
| `ha:area:updated` | `HaArea` | Mise à jour d'une area |
| `ha:command:result` | `HaCommandResult` | Résultat d'une commande |

Ajouts (client → server) :

| Événement | Payload | Description |
|---|---|---|
| `ha:structure:get` | `void` | Demande le référentiel complet |
| `ha:command:send` | `HaCommand` | Envoie une commande à HA |

> Pour le mode B (intégration), chaque application décide librement quels événements
> MQTT elle relaie à l'UI via Socket.io — voir §5.4.

---

## 9. EventBus Typé

Canal de communication interne entre toutes les couches. Aucun module ne dépend directement
d'un autre — tout passe par l'EventBus. Le détail des événements `ha:*` est défini en §8.6 ;
cette section rassemble le socle commun.

```typescript
type AppEvents = {
  // Couche HA → Application (voir §8.6 pour le détail complet)
  'ha:ready':               { entityCount: number; areaCount: number; deviceCount: number };
  'ha:disconnected':        void;
  'ha:reconnected':         void;
  'ha:entity:state_changed': HaStructuredEntity;
  'ha:command:result':      HaCommandResult;

  // Application → Couche HA
  'ha:command:send':        HaCommand;

  // Application → Présentation (via SocketBridge)
  'app:status:changed':     { ha: boolean; haEntities: number; uptime: number };

  // Présentation → Application
  'config:save:requested':  AppConfig;
  'config:saved':           { success: boolean; error?: string };

  // Extension libre par le domaine de chaque application
  // Ex: 'automation:triggered': { id: string; entity: HaStructuredEntity }
  // Pour les applications d'intégration, extension libre par module MQTT (voir §8.6)
};
```

Le `SocketBridge` s'abonne aux événements EventBus et les retransmet à Socket.io.
Il est le **seul point de contact** entre EventBus et Socket.io.

---

## 10. Cycle de Vie

### 10.1 Démarrage (`index.ts`)

```
1. Initialisation Logger (en premier absolu)
2. Chargement + validation config.yaml → exit(1) si invalide
3. Démarrage Express + Socket.io  ← UI accessible immédiatement
4. Connexion couche HA — Web Service (retry infini en arrière-plan)
5. Synchronisation référentiel HA (HaStateRegistry + HaStructureRegistry)
6. [Si application d'intégration] Connexion MQTT des modules concernés
7. Démarrage modules métier (après événement 'ha:ready')
8. Log INFO "Application démarrée — UI : http://localhost:<port>"
```

> Express et Socket.io démarrent **avant** la couche HA : l'UI reste accessible même si la
> configuration HA est incorrecte, permettant de la corriger sans accès shell au conteneur.

### 10.2 Arrêt propre (SIGTERM / SIGINT)

```
1. Arrêt des modules métier
2. [Si application d'intégration] Publication LWT offline MQTT, déconnexion propre
3. Fermeture propre de la connexion WS HA
4. Fermeture Socket.io + Express
5. Flush logs
6. exit(0)
```

### 10.3 Codes de sortie

| Code | Signification |
|---|---|
| `0` | Arrêt propre (normal ou après sauvegarde config) |
| `1` | Erreur fatale au démarrage |

---

## 11. Docker

### 11.1 `Dockerfile`

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
COPY src/presentation/ui/ ./ui/
RUN pnpm build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ui   ./ui
RUN mkdir -p /app/data /app/logs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
```

### 11.2 `compose.yaml`

```yaml
services:
  app:
    build: .
    container_name: ha-app-nom        # Adapter par application
    restart: unless-stopped           # Obligatoire — permet le redémarrage après config:save
    environment:
      - NODE_ENV=production
      - TZ=Europe/Paris
    ports:
      - "8080:8080"                   # Port UI — adapter par application
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    networks:
      - ha_network

networks:
  ha_network:
    external: true
    name: ha_network
```

---

## 12. Logging

Format : `[ISO8601] [LEVEL] [couche:module] message`

```
[2026-06-29T10:23:45.123Z] [INFO]  [ha:sync] Référentiel initialisé : 142 entités
[2026-06-29T10:23:46.001Z] [DEBUG] [mqtt:client] Message reçu : homeassistant/light/salon/state
[2026-06-29T10:23:50.001Z] [ERROR] [mqtt:client] Connexion perdue. Reconnexion dans 5s...
```

Chaque ligne de log est également émise vers l'UI via Socket.io (`app:log`).
Rotation quotidienne · 10 Mo max par fichier · 5 fichiers conservés.

---

## 13. Charte Graphique UI

Interface minimaliste et fonctionnelle. Fichier `ui/style.css` partagé entre toutes les applications.

```css
:root {
  --color-bg:           #1a1a2e;
  --color-surface:      #16213e;
  --color-primary:      #0f3460;
  --color-accent:       #e94560;
  --color-text:         #eaeaea;
  --color-text-muted:   #8892a4;
  --color-success:      #4caf50;
  --color-warning:      #ff9800;
  --color-error:        #f44336;
  --radius:             8px;
  --font:               'Segoe UI', system-ui, sans-serif;
}
```

**Pages minimales obligatoires :**

| Page | Contenu |
|---|---|
| `/` — Dashboard | Statut MQTT · nb entités HA · uptime · derniers logs |
| `/config` | Formulaire de configuration complet — soumis via `config:save` |
| `/logs` | Flux de logs en temps réel via `app:log` |

Les applications dérivées ajoutent leurs propres pages dans l'UI sans modifier les pages du socle.

---

## 14. Dépendances NPM

```json
{
  "dependencies": {
    "ws":                        "^8.x",
    "home-assistant-js-websocket": "^9.x",  // ⭐ v4.12 — client WS HA officiel, ws requis en polyfill Node
    "express":                   "^4.x",
    "socket.io":                 "^4.x",
    "js-yaml":                   "^4.x",
    "zod":                       "^3.x",
    "winston":                   "^3.x",
    "winston-daily-rotate-file": "^5.x"
  },
  "devDependencies": {
    "typescript":       "^5.x",
    "@types/node":      "^20.x",
    "@types/express":   "^4.x",
    "@types/ws":        "^8.x",
    "@types/js-yaml":   "^4.x",
    "tsx":              "^4.x",
    "vitest":           "^1.x"
  }
}
```

> `ws` est requis dans **toutes** les applications (couche HA, mode A).
> `mqtt` (`^5.x` + dépendance directe, pas de `@types` requis) n'est ajouté
> que dans les applications de type **intégration** (couche HA, mode B).

---

## 15. Conventions de Développement

- **TypeScript strict** — `any` interdit
- **SRP** — un fichier, une responsabilité
- **Injection de dépendances** — les services reçoivent leurs dépendances en constructeur
- **Pas de couplage inter-couches** — tout passe par EventBus ou injection
- **Pas d'accès direct** à HA, MQTT, ou Socket.io depuis le domaine — uniquement via
  EventBus ↔ couche HA et EventBus ↔ SocketBridge
- **Nommage** : camelCase variables/fonctions · PascalCase types/classes · UPPER_SNAKE constantes
- **Git** : conventional commits (`feat:` `fix:` `refactor:` `chore:` `docs:`)

---

## 16. Checklist Nouvelle Application

- [ ] Copier la structure du socle
- [ ] Définir `ha.ws.host/port/token` et `web.port` uniques dans `config.yaml`
- [ ] Décider de `ha.structure.include_unassigned`
- [ ] Instancier `ConfigService` une seule fois dans `index.ts` et l'injecter dans les couches
- [ ] Fournir une implémentation de `IHaClassifier` (module dédié à venir) et l'injecter
      dans `HaStructureRegistry` au bootstrap
- [ ] **v4.3** Si l'application est une **intégration** : activer `ha.mqtt_enable: true` et configurer `ha.mqtt`,
      créer `src/ha/integration/[module]/`, et documenter ses topics spécifiques
- [ ] Étendre le schéma Zod avec les sections config métier supplémentaires
- [ ] Créer `applications/[app-name]/domain/[feature]/` — logique métier pure, consommant `HaStructureRegistry`
      et envoyant ses commandes via `EventBus.emit('ha:command:send', ...)`
- [ ] Déclarer les événements Socket.io spécifiques dans `applications/[app-name]/presentation/socket/events.ts`
- [ ] Configurer le `SocketBridge` pour relayer les événements EventBus souhaités (métier et,
      le cas échéant, événements d'intégration MQTT — au choix de l'application)
- [ ] Ajouter les pages UI spécifiques sans modifier les pages du socle
- [ ] Mettre à jour `container_name` et `ports` dans `compose.yaml`
- [ ] Ajouter le token HA dans `.env` (jamais dans `config.yaml` versionné)
- [ ] Fournir `.env.example`
- [ ] Vérifier que `data/` et `logs/` sont dans `.gitignore`

---

*Spécifications v4.7 — Document à utiliser comme prompt de base pour la génération de chaque application du projet.*

---

## 📅 Historique des Versions

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| **4.18** | 30/07/2026 | Claude | **`AreaEnsureService` — création active des areas HA (§8.5.4)**, à la demande de l'utilisateur, suite à la découverte que `device.suggested_area` (v4.17) n'est jamais fiable : vérifié en conditions réelles (suppression + redécouverte complète d'une entité, puis redémarrage complet de HA) que HA ne l'applique qu'à la toute première création, jamais de façon garantie. Nouveau `AreaEnsureService` (`applications/core/src/ha/sync/`) : crée l'area via l'API WebSocket de HA (`config/area_registry/create`) avant de publier la découverte, avec dédoublonnage insensible à la casse contre `HaStructureRegistry` (nouveau `getAllAreas()`), nom capitalisé, cache local mis à jour immédiatement après création (évite les doublons entre demandes concurrentes pour le même lieu), et attente de l'événement `ha:ready` (pas seulement l'authentification WS — le chargement du référentiel est un chaînage asynchrone séparé, deux races distinctes constatées et corrigées en conditions réelles). Interception dans `IntegrationBridge.subscribeModuleEvents()`, sur les deux chemins de découverte (normal et passthrough NOMMAGE) — **aucun changement dans RFXCOM/EVOO7/AREXX/NOMMAGE**, qui alimentaient déjà `suggested_area`. Optionnel (Mode A seulement), best-effort (timeout ~8s, jamais bloquant). Vérifié sur une installation HA neuve (registre et broker MQTT réinitialisés) : 86 devices sur 96 assignés automatiquement à la bonne area, dont 24 areas créées sans aucun échec. |
| **4.17** | 30/07/2026 | Claude | **Ajout de `device.suggested_area` en découverte (§8.5.4)**, à la demande de l'utilisateur ("il faut l'alimenter avec le lieu de taxonomie, pas le lieu précis, dans tous les programmes qui envoient des discovery"). Renomme/remplace un ancien champ `area_id` déclaré dans `HaMqttDevice` (`ha-mqtt.ts`) mais jamais alimenté nulle part et de toute façon inexploitable par HA (pas la bonne clé pour la découverte MQTT — `suggested_area` est la seule reconnue, effet limité à l'assignation automatique de l'entité à sa création). Alimenté dans les 4 applications qui envoient des messages de découverte : RFXCOM (devices bruts, récepteurs light/switch/cover, scènes), EVOO7 (device partagé, recalculé par entité), AREXX (capteurs), NOMMAGE (passthrough, n'altère que si un bloc `device` existe déjà dans le message relayé). Vérifié en conditions réelles sur le broker de test : 94/96 messages de découverte portent `suggested_area` avec la bonne valeur (lieu, pas lieu précis) ; les 2 exceptions correspondent à des données EVOO7 dont la taxonomie n'a simplement pas encore été saisie par l'utilisateur (comportement attendu, `suggested_area` omis plutôt qu'une valeur incorrecte). |
| **4.16** | 29/07/2026 | Claude | **Correction du format des topics état/commande/LWT (§8.5.4)** : ces topics ne doivent pas commencer par un `/` (un slash initial crée un premier niveau de topic MQTT vide, non-standard) — erreur présente depuis la définition initiale du format (v4.8) et repérée par l'utilisateur en examinant directement les messages retenus sur le broker d'une nouvelle installation HA en cours de test. Corrigé à la source unique (4 fonctions de `ha-mqtt.ts`) ; le topic de découverte (`homeassistant/...`) n'était pas affecté. Anciens topics retenus explicitement effacés du broker de test après coup pour éviter des entités dupliquées côté HA. |
| **4.15** | 28/07/2026 | Claude | **Nouvelle §5.6 "Porte d'authentification OAuth2 HA (accès externe)"**, mécanisme optionnel désactivé par défaut (`web.auth.enabled`), sans effet sur un déploiement interne — prévu pour une future instance externe dédiée derrière un reverse proxy TLS. Le flux OAuth2 natif de HA (`/auth/authorize` + `/auth/token`, vérifié contre `developers.home-assistant.io/docs/auth_api`) sert de portail de connexion uniquement ; un cookie de session signé HMAC-SHA256 (sans état côté serveur, sans nouvelle dépendance npm) protège ensuite toutes les routes REST **et** la connexion Socket.io elle-même (`io.use()` sur le handshake) — les deux canaux étaient jusqu'ici sans aucune authentification. Pas de permissions différenciées par utilisateur HA (choix explicite) : le serveur garde son propre jeton longue durée pour piloter HA. Nouveau `AuthService` (`infrastructure/auth/`), intégré dans `PresentationServer` et `SocketBridge`. Nouvelle section `web.auth` (§7.1). Vérifié sur une instance de test isolée (scratch, port séparé) : garde REST + Socket.io actives, cookie forgé/expiré rejeté, cookie valide accepté ; comportement du déploiement interne actuel inchangé (`web.auth` absent). |
| **4.14** | 24/07/2026 | Claude | **Restructuration `data/` en un sous-répertoire par application (§4.1, §7)**, à la demande de l'utilisateur, pour faciliter le déplacement d'une application d'une machine à une autre : le fichier unique `data/config.yaml` devient `data/core/config.yaml` (`ha`/`web`/`logging`) + un `data/{app}/config.yaml` par application (objet nu). `ConfigLoader` fusionne le tout en mémoire au chargement — `getConfig()` et le reste de l'API de `ConfigService` gardent une forme identique, `IAppConfigProvider`/code métier des applications inchangés. Écriture désormais mono-fichier et isolée par application (`saveConfig()` n'écrit que `data/core/config.yaml`, `saveModuleConfig()`/`savePartialConfig()` n'écrivent que le fichier de l'application concernée). |
| **4.13** | 22/07/2026 | Claude | **Correction §6 "Couche Présentation"** : la liste des invariants excluait encore Alpine.js ("Aucun framework UI tiers... Alpine.js"), affirmation devenue fausse depuis la réintroduction du framework le 22/07/2026 (voir `presentation_specs_v4.0.md` et le nouveau document dédié `alpinejs-implementation_specs_v1.0.md`). Le lien vers `presentation_specs` est mis à jour vers v4.0 ; la note historique v4.7 est conservée mais annotée obsolète. |
| **4.12** | 22/07/2026 | Claude | **Remplacement du client WebSocket HA maison par `home-assistant-js-websocket`** (lib officielle HA) : supprime `HaWsTransport.ts` et le bug de double authentification par connexion qu'il contenait (auth envoyée à la fois à l'ouverture du socket et en réponse à `auth_required`) — plus de boucle de reconnexion sur jeton invalide, la lib officielle renonce immédiatement sur `auth_invalid`. `HaWsClient` garde la même API publique ; `onMessage` disparaît (pas d'équivalent officiel), `HaCommandService` simplifié pour résoudre directement depuis la Promise de `sendCommand` au lieu d'un ré-appariement par id redondant et bugué. |
| **4.11** | 21/07/2026 | Claude | **Correction d'un gap fonctionnel réel (§8.5.2, découvert en implémentant les scènes RFXCOM)** : `publishDiscoveryFor` abonne désormais automatiquement le bridge au topic de commande d'une entité `commandEnabled: true` — avant ce correctif, aucun module métier n'appelait jamais `subscribeCommandsFor`, donc aucune commande HA→app n'était réellement reçue pour aucun module utilisant la découverte normale (§8.5.0), en dépit d'un code de réception/routage par ailleurs correct. |
| **4.10** | 21/07/2026 | Claude | **Séparation `exports.ts` (backend) / `ui-exports.ts` (navigateur)** (§4.2.1, suite à investigation "le core met-il ses objets dans dist et pas dans src ?") : `SocketService` retiré de `exports.ts` et déplacé dans le nouveau `ui-exports.ts`, `src/ui-exports.ts` exclu du build backend du core. Corrige une pollution constatée dans `nommage` et `arbreouquoi`, dont le `dist` backend contenait une copie morte de `SocketService.js` (code navigateur, inexécutable côté Node) simplement parce qu'ils importaient des types backend depuis `exports.ts`. `tsconfig.ui.json` du core gagne `declaration: true`/`declarationMap: true` pour permettre aux applications à `rootDir` restreint (ex: `arbreouquoi`) de consommer le `dist` UI du core avec des types corrects, sans `@ts-ignore`. |
| **4.9** | 21/07/2026 | Claude | **Ajout du Passthrough MQTT (§8.5.6, sur demande utilisateur)** : mécanisme pour les applications qui relaient des messages MQTT déjà formés (lus depuis une source tierce, ex: `nommage` relayant Zigbee2MQTT) vers le broker HA unique, sans normalisation de découverte. Mode "réécriture de préfixe" (`sourceTopic` → remplacement du 1er segment par `homeassistant`, QoS1/retain true) et mode "complet" (topic + payload intégraux, aucune transformation). Nouvelles méthodes `publishDiscoveryPassthrough`/`publishPassthrough` sur `HaMqttIntegrationService`, nouveaux événements EventBus `integration:{module}:passthrough:discovery`/`:publish`. |
| **4.8** | 21/07/2026 | Claude | **Précision du format MQTT (§8.5, sur demande utilisateur — analyse d'écart avec le code réel)** : un seul broker pour tout le socle ; mission par intégration = LWT + découverte persistante + état + réception des commandes ; nouveau concept `bridge_instance` (une intégration peut piloter plusieurs bridges physiques, chacun avec son propre LWT) ; nouveaux topics état/commande `/{moduleName}/{bridgeInstance}/{deviceId}/state\|set` (remplace l'ancien schéma `homeassistant/.../state\|set` et l'ancien LWT `ha-integration/{module}/status`) ; le topic de découverte HA standard reste inchangé ; `deviceId` est un identifiant opaque dont l'encodage est propre à chaque module (voir specs RFXCOM pour son encodage) ; répartition claire des responsabilités : le module métier fournit les données essentielles, `HaMqttIntegrationService` normalise et complète l'intégralité du message de découverte. |
| **4.7** | 21/07/2026 | Claude | **Suppression des références actives à Alpine.js** (stack technique, diagrammes, structure de répertoires, dépendances npm). La section 6 "Couche Présentation" ne duplique plus l'implémentation — elle renvoie vers `presentation_specs` (TypeScript pur + Web Components natifs depuis v3.0), qui reste la seule source de vérité pour cette couche. Les mentions historiques d'Alpine.js dans le changelog (v4.2) sont conservées. |
| **4.6** | 19/07/2026 | Mistral Vibe | **Restructuration complète de l'arborescence** : Déplacement de `src/applications/` et `src/applications_desactivees/` vers `applications/` et `applications_desactivees/` à la racine du projet. Chaque application (y compris le core) est maintenant autonome avec ses propres `package.json`, `tsconfig.json`, et `dist/`. **Le core ne peut pas être désactivé**. Activation/désactivation via sous-menu Paramètres Techniques. Mise à jour des mécanismes de détection et d'activation/désactivation via `AppService`. |
| **4.5** | 17/07/2026 | Mistral Vibe | Ajout du **démarrage automatique des services d'application** : AppService instancie et démarre automatiquement les services des applications activées via convention de factory (`create*Service`). Reconnection automatique sur changement de configuration via écoute de `app:module:config:saved`. **Traces obligatoires** au démarrage et gestion des erreurs de connexion (matériel absent, mauvais paramètres) avec logging WARN/ERROR et motif précis. Processus reproductible pour toute nouvelle application. |
| **4.4** | 14/07/2026 | Mistral Vibe | Ajout §4.3 "Gestion Dynamique des Applications" avec répertoires `applications/` et `applications_desactivees/`. Mécanisme d'activation/désactivation par déplacement de répertoires. |
| 4.3 | 10/07/2026 | - | Restructuration de la configuration HA avec flags d'activation (`ws_enable`, `mqtt_enable`) et regroupement MQTT sous HA. |
| 4.2 | - | - | Ajout du support Alpine.js pour la couche Présentation.
