# Spécifications Fonctionnelles - Module Scripts HA (scriptsha)

*Version 1.1 - 18 Août 2026*
*Provisionnement automatique lumières↔timers (§4bis, nouvelle) : au déploiement du script
d'illustration "Ensemble de minuterie", création du helper `timer` manquant pour chaque lumière
existante, et détection continue des nouvelles lumières tant que ce script reste diffusé. Vérifié
en conditions réelles contre la HA de production (35 lumières réelles, 35 timers créés puis
nettoyés après validation — voir §4bis.5). Ancienne version v1.0 archivée.*

*Version 1.0 - 18 Août 2026*
*Première spécification, écrite en même temps que le code — application créée en process séparé
dès l'origine (contrairement à RFXCOM/rpigpio, migrés après coup), premier point d'entrée générique
pour l'API REST config de HA (`HaRestBridge`, côté core) et la première route d'upload générique
(`POST /api/apps/:appId/upload`, qui remplace le précédent dédié HAPLAN pour toute nouvelle app).*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Modèle de données](#3-modèle-de-données)
4. [Intégration HA — pont générique HaRestBridge](#4-intégration-ha--pont-générique-harestbridge)
    - 4bis. [Provisionnement automatique — minuterie par lumière (v1.1)](#4bis-provisionnement-automatique--minuterie-par-lumière-nouveau-v11-18082026)
5. [Upload de fichier — route générique](#5-upload-de-fichier--route-générique)
6. [Configuration](#6-configuration)
7. [Interface Web et Socket.io](#7-interface-web-et-socketio)
8. [Écart documenté au guide-nouvelle-application_specs](#8-écart-documenté-au-guide-nouvelle-application_specs)
9. [Limites et Contraintes Connues](#9-limites-et-contraintes-connues)
10. [Arborescence des Programmes](#10-arborescence-des-programmes)
11. [Annexes](#11-annexes)

---

## 1. Introduction

### 1.1 Objectif

`applications/scriptsha` gère des scripts Home Assistant natifs (entité `script.*`, pas un script
Node interne) : dépôt d'un fichier YAML (le format natif d'un script HA — `alias`, `sequence`,
`mode`, etc.), annotation (titre + explication), suivi d'un statut diffusé/non diffusé, et
diffusion/retrait à la demande vers HA.

### 1.2 Périmètre

- **Inclus** : dépôt de fichier (titre, description, contenu YAML), liste avec statut
  diffusé/non diffusé, consultation du contenu, diffusion/retrait à la demande, suppression d'un
  enregistrement non diffusé, un script d'illustration pré-chargé ("Ensemble de minuterie"),
  provisionnement automatique des helpers `timer` associés à ce script d'illustration (§4bis).
- **Exclus** : édition du contenu YAML depuis l'IHM (dépôt uniquement — un nouveau dépôt avec le
  même titre crée une nouvelle entrée, pas un remplacement), détection de dérive si un script est
  modifié/supprimé manuellement côté HA (le statut local reste la seule source de vérité, voir §9),
  validation sémantique du contenu YAML au-delà de "c'est un objet YAML" (la structure exacte
  attendue par un script HA n'est pas revérifiée par cette application — HA lui-même rejette un
  contenu structurellement invalide au moment de la diffusion), provisionnement générique
  déclarable par n'importe quel script déposé (§4bis est spécifique au script minuterie pour
  l'instant, décision explicite — voir §4bis.1).

---

## 2. Architecture

### 2.1 Composants (`applications/scriptsha/src/domain/`)

| Fichier | Rôle |
|---|---|
| `ScriptsHaService.ts` | Orchestrateur : CRUD des scripts, upload, diffusion/retrait via `HaRestBridge`, provisionnement lumières↔timers via `HaHelperBridge` (§4bis), événements Socket.io |
| `config-schema.ts` | Schéma Zod minimal (`enabled`) — aucun réglage de connexion propre |
| `storage-schema.ts` | Schéma Zod d'une entrée (`ScriptEntry`) |
| `yaml/ConfigFileManager.ts` | Chargement/sauvegarde atomique du YAML des métadonnées (copie locale du pattern rpigpio/planificateur) |
| `socket-events.ts` | Catalogue des événements Socket.io |
| `index.ts` | Manifeste du module (`SCRIPTSHA_APP`) + factories |
| `standalone.ts` | Bootstrap process séparé (patron rpigpio/espdisplay) |

**Manifeste** (`SCRIPTSHA_APP`) : `id: 'scriptsha'`, `type: 'standalone'`, `requiredMqtt: false`,
`requiredHaWs: false`, `runsAsSeparateProcess: true`,
`bridgedEvents: ['scriptsha:internal:upload', 'scriptsha:ha:rest:result', 'scriptsha:ha:helper:result', 'scriptsha:ha:entities:list:result', 'ha:entity:updated']`
— l'application ne se connecte elle-même à aucun broker ni à HA directement (aucun `HaWsClient`,
qui n'existe que dans le process `core`), toute action HA transite par les ponts génériques décrits
aux §4 et §4bis.

### 2.2 Process séparé

Comme RFXCOM/espdisplay/rpigpio (`fonctionnelles-supervisor_specs` §2.4 pour l'architecture
générique, pas dupliquée ici) — `applications/scriptsha/src/standalone.ts`, construit son propre
`IpcEventBus`, lancé par `ProcessSupervisor`. `bridgedEvents` ne liste que le sens **core→enfant**
(le sens enfant→core est automatique, tout `process.send()` d'un enfant est relayé par
`SupervisorEventBridge.attachChild()`) :
- `scriptsha:internal:upload` — relayé depuis la route générique d'upload (§5).
- `scriptsha:ha:rest:result` — relayé depuis `HaRestBridge` (§4), réponse à une requête
  `ha:rest:request` émise par ce service.
- `scriptsha:ha:helper:result` / `scriptsha:ha:entities:list:result` — relayés depuis
  `HaHelperBridge` (§4bis).
- `ha:entity:updated` — événement générique déjà émis par le core pour tout
  `entity_registry_updated` (pas préfixé scriptsha) — utilisé pour détecter une nouvelle lumière en
  continu (§4bis.4).

### 2.3 Flux de données (diffusion d'un script)

```
IHM (formulaire dépôt : titre, description, fichier .yaml)
    |
    v (fetch + FormData → POST /api/apps/scriptsha/upload, route générique core)
core émet scriptsha:internal:upload (relayé à l'enfant via bridgedEvents)
    |
    v
ScriptsHaService : écrit data/scriptsha/scripts/<id>.yaml + entrée dans scriptsha-scripts-v1.0.yaml
    |
    v (bouton "Diffuser")
ScriptsHaService émet ha:rest:request { appId:'scriptsha', method:'set', domain:'script', id, config }
    |
    v (reçu automatiquement côté core, aucune déclaration nécessaire pour ce sens)
HaRestBridge (core) : HaWsClient.setDomainConfig('script', id, config) + sendCommand('script','reload',{})
    |
    v (POST /api/config/script/config/{id}, API REST HA — voir §4)
Home Assistant : crée/modifie l'entité script.<id>
    |
    v
HaRestBridge émet scriptsha:ha:rest:result (relayé à l'enfant via bridgedEvents)
    |
    v
ScriptsHaService : deployed=true, deployedAt, diffuse scriptsha:scripts:list
    |
    v (si id === script minuterie — voir §4bis)
ScriptsHaService::reconcileLightTimers()
```

---

## 3. Modèle de données

### 3.1 `ScriptEntry` (`storage-schema.ts`)

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `id` | string | oui (généré) | Slug du titre (dédupliqué si collision) — sert aussi de nom de fichier ET de `script_id` HA (`entity_id` final : `script.<id>`) |
| `title` | string | oui | Titre saisi par l'utilisateur |
| `description` | string | non (défaut `''`) | Explication libre |
| `originalFilename` | string | oui | Nom du fichier tel que déposé (traçabilité uniquement, le contenu réel vit sous `<id>.yaml`) |
| `deployed` | boolean | oui (défaut `false`) | Statut courant — source de vérité locale, pas revérifié contre HA (voir §9) |
| `deployedAt` | string | non | Horodatage ISO de la dernière diffusion réussie |
| `createdAt` | string | oui | Horodatage ISO du dépôt |
| `updatedAt` | string | non | Horodatage ISO de la dernière diffusion/retrait |

`id` est généré côté serveur (`ScriptsHaService::generateId`, `slugify(title)`, suffixe numérique en
cas de collision) — jamais saisi directement.

### 3.2 Persistance

- `data/scriptsha/scriptsha-scripts-v1.0.yaml` — tableau `scripts: ScriptEntry[]` (métadonnées).
- `data/scriptsha/scripts/<id>.yaml` — un fichier par script, le corps YAML brut attendu par l'API
  config HA (`alias`, `sequence`, `mode`, etc.), **sans** clé `<id>:` de tête (l'id est déjà porté
  par le chemin de l'appel REST, voir §4).
- Les timers créés par le provisionnement (§4bis) ne sont **pas** suivis dans un fichier local —
  l'état réel de HA (`timer/list`) est la seule source de vérité, voir §4bis.3.

---

## 4. Intégration HA — pont générique HaRestBridge

### 4.1 Pourquoi pas de commande WebSocket

HA n'expose aucune commande WebSocket pour créer/modifier/supprimer la config brute d'un script —
seul le service `script.reload` (un vrai appel de service, WS) l'est. Le CRUD lui-même passe par la
route REST `GET/POST/DELETE /api/config/script/config/{id}` (celle qu'utilise l'éditeur de scripts
du frontend HA lui-même), avec le jeton longue durée déjà utilisé pour le WebSocket. Constaté au
préalable dans `HaAutomationBackupService` (`applications/core/src/ha/automations/`, même besoin
pour les automatisations — HA sert `script`/`automation`/`scene` avec la même vue interne
`EditKeyBasedConfigView`).

### 4.2 Centralisation — `HaWsClient.getDomainConfig/setDomainConfig/deleteDomainConfig`

Ces 3 méthodes génériques (`applications/core/src/ha/sync/HaWsClient.ts`) construisent l'URL depuis
la config HA déjà détenue par `HaWsClient` (`host`/`port`/`token`). `HaAutomationBackupService` a
été refactorée pour les utiliser aussi (`getDomainConfig('automation', id)`), remplaçant son
`fetch()` privé dupliqué — une seule implémentation de cet appel REST dans tout le projet.

### 4.3 `HaRestBridge` — pont générique par `appId`

`applications/core/src/ha/HaRestBridge.ts`, instancié dans le bootstrap du core
(`applications/core/src/index.ts`, aux côtés de `AreaEnsureService`) — **sans connaissance d'aucun
nom d'app**. Écoute `ha:rest:request` (`{ appId, method: 'set'|'delete'|'get', domain, id, config? }`),
appelle la méthode `HaWsClient` correspondante (+ `sendCommand(domain, 'reload', {})` après un `set`
réussi), répond sur `<appId>:ha:rest:result` (`{ id, success, result?, error? }`). N'importe quelle
future app process séparé peut l'utiliser en déclarant `<sonAppId>:ha:rest:result` dans son propre
`bridgedEvents` — exactement le même principe que `espdisplay:deploy-floorplan`
(`guide-nouvelle-application_specs`). Toujours instancié, même si HA WebSocket n'est pas configuré
(répond alors `{ success: false, error: 'HA non connecté' }` plutôt que de laisser la requête sans
réponse).

### 4.4 Corrélation côté `scriptsha`

`HaRestBridge` ne renvoie pas la `method` d'origine dans sa réponse — `ScriptsHaService` maintient
en mémoire (non persisté) une map `pendingAction: Map<id, 'deploy'|'undeploy'>`, posée juste avant
l'émission de la requête et consommée à la réception du résultat, pour savoir quel champ mettre à
jour (`deployed=true`/`false`). Suffisant pour cet usage : une seule action en vol par script à la
fois (pas de file d'attente).

---

## 4bis. Provisionnement automatique — minuterie par lumière (⭐ nouveau v1.1, 18/08/2026)

### 4bis.1 Contexte et portée

Le script d'illustration "Ensemble de minuterie" démarre toutes les entités `timer.*` de la maison
— mais rien ne les créait avant cette version, une par lumière. Demande utilisateur : au moment où
ce script est diffusé, créer le timer manquant de chaque lumière existante, et continuer à agir pour
toute nouvelle lumière ajoutée par la suite. **Décision explicite de portée** : logique codée
spécifiquement pour ce script (`EXAMPLE_SCRIPT_ID`), pas un mécanisme générique déclarable par
n'importe quel script déposé — à généraliser si un 2e cas se présente, pas de framework construit
pour un seul exemple.

### 4bis.2 `HaWsClient` — CRUD générique des "helpers" HA

Ajout de 3 méthodes (`listHelpers`/`createHelper`/`deleteHelper`), construites sur
`{domain}/create|list|delete` — **de vraies commandes WebSocket** (contrairement au CRUD REST du
§4, qui concerne `script`/`automation`/`scene`), génériques à tous les "helpers" HA (`timer`,
`input_boolean`, `input_number`, `counter`, `schedule`...). Vérifié empiriquement contre la HA de
production le 18/08/2026 : `timer/create {name, duration}` → `{id, name, duration, restore}` (`id`
= slug HA du `name`), `timer/delete {timer_id}`, `timer/list` → tableau.

### 4bis.3 `HaHelperBridge` — pont générique (helpers + référentiel d'entités)

`applications/core/src/ha/HaHelperBridge.ts`, instancié dans le bootstrap du core aux côtés de
`HaRestBridge` — même principe générique, **sans connaissance d'aucun nom d'app**. Deux capacités :
- `ha:helper:request` → `<appId>:ha:helper:result` : CRUD helper (`{appId, requestId, method, domain, id?, data?}`
  → `{requestId, success, result?, error?}`). Contrairement à `HaRestBridge`, la réponse ne porte
  aucun identifiant métier réutilisable pour corréler (une requête `list` n'a pas d'id cible, et une
  création n'a pas d'id connu avant coup) — `requestId` généré côté appelant, échoé tel quel.
- `ha:entities:list:request` → `<appId>:ha:entities:list:result` : photo ponctuelle du référentiel
  d'entités HA déjà tenu par le core (`HaStructureRegistry.getAllEntities()`, déjà utilisé de façon
  identique par `HaAutomationBackupService`), filtré par domaine (`{appId, domain}` →
  `{domain, entities: [{entity_id, name?}]}`). Ne couvre que la photo initiale — le suivi des
  nouvelles entités passe par l'événement générique `ha:entity:updated` (§4bis.4), déjà réel et
  câblé (`AppService.ts`, émis pour tout `entity_registry_updated`), pas dupliqué ici.

  **Écart avec le guide constaté en creusant ce besoin** : le guide documente aussi un événement
  `ha:structure:get`/`ha:structure` (référentiel complet) — vérifié **jamais implémenté** dans le
  code réel (seule occurrence dans `types/events.ts`, aucun handler nulle part), même type d'écart
  que `InterAppClient` (§8). D'où le choix de construire `ha:entities:list:request` plutôt que de
  s'appuyer sur cet événement documenté mais fantôme.

### 4bis.4 Réconciliation côté `scriptsha`

`ScriptsHaService::reconcileLightTimers()` :
1. Émet en parallèle `ha:entities:list:request {domain:'light'}` et `ha:helper:request {method:'list', domain:'timer'}`.
2. Pour chaque lumière, nom de timer candidat = `Minuterie <suffixe entity_id>` (suffixe brut, pas
   le `friendly_name` — unique par construction, contrairement au `friendly_name` qui peut se
   répéter entre pièces, ex: plusieurs "Plafonnier"). Id attendu = `slugify()` (déjà écrit dans
   `ScriptsHaService`) de ce nom.
3. **"Détection de mise en œuvre"** (terme de la demande utilisateur) : compare l'id attendu à la
   liste réelle des timers existants (`timer/list`) — pas d'état local séparé, résilient à une perte
   du fichier local ou à un ajout/suppression manuel côté HA. Vérifié empiriquement : l'id que HA
   génère lui-même pour un `name` donné correspond exactement au résultat de ce `slugify()` — la
   comparaison est fiable.
4. Crée un timer (`duration: '00:10:00'`) pour chaque lumière manquante, en parallèle
   (`Promise.all`), corrélé par `requestId` (§4bis.3).

**Déclenchement** :
- Diffusion réussie du script minuterie (`handleHaRestResult`, `action==='deploy' && id===EXAMPLE_SCRIPT_ID`).
- `ha:entity:updated` avec `domain==='light' && action==='create'`, **seulement si** le script
  minuterie est actuellement `deployed===true` (pas d'intérêt à provisionner pour un script retiré)
  — relance une réconciliation complète (35 lumières restant un volume négligeable, pas de logique
  ciblée séparée pour la seule nouvelle lumière).

Un mutex (`reconcilingLightTimers`) évite deux réconciliations concurrentes (déploiement et
détection réactive survenant en même temps).

### 4bis.5 Vérifié en conditions réelles (18/08/2026)

- Diffusion du script minuterie sur la HA de production → **35 lumières réelles** détectées, **35
  timers créés** (`timer.minuterie_<suffixe>`), confirmé via `GET /api/states`.
- Rejouer la diffusion → **"rien à installer"** (0 création), confirme l'idempotence face à l'état
  réel de HA.
- **Constat** (signalé, pas un blocage) : 2 des 35 "lumières" ne sont pas des lumières de pièce
  (`light.status_ring`, rétroéclairages d'écrans HAPLAN) — conséquence assumée du choix "domaine
  `light.*` brut" plutôt que la taxonomie QUOI=lumière du pipeline nommage (décision explicite de
  l'utilisateur). Corrigeable après coup (suppression manuelle du timer superflu, ou passage à la
  taxonomie QUOI si ça devient gênant).
- Script et 35 timers **retirés après validation** (à la demande de l'utilisateur, retour à l'état
  d'avant ce test) — la fonctionnalité reste disponible, prête à être re-diffusée à la demande.
- Détection réactive d'une nouvelle lumière (§4bis.4, 2e point de déclenchement) : **non vérifiée en
  conditions réelles** (pas de nouvelle lumière physique disponible pour un vrai test) — repose sur
  `ha:entity:updated`, déjà confirmé réel et câblé (§4bis.3), mais le chemin complet
  détection→réconciliation n'a pas été rejoué de bout en bout.

---

## 5. Upload de fichier — route générique

### 5.1 `POST /api/apps/:appId/upload`

`applications/core/src/presentation/server/index.ts` — généralisation du précédent HAPLAN (route
dédiée `POST /api/haplan/floorplans/upload`, restée inchangée, pas de migration rétroactive). La
route générique ne connaît ni le type de fichier attendu ni les champs texte du formulaire — elle
relaie tel quel (`buffer`, `filename`, `mimetype`, `fields: req.body`) via
`<appId>:internal:upload`, à charge pour l'app réceptrice de valider son propre contenu.

### 5.2 Sérialisation IPC du buffer

Le canal IPC (`process.send()`/`process.on('message')`) sérialise en JSON par défaut (pas de
`serialization: 'advanced'` dans `ProcessSupervisor.spawn()`) — un `Buffer` y perd son prototype et
arrive sous la forme `{ type: 'Buffer', data: [...] }`. `ScriptsHaService::toBuffer()` reconstruit
un vrai `Buffer` à la réception (`scriptsha:internal:upload`) avant de l'écrire sur disque.

---

## 6. Configuration

`data/scriptsha/config.yaml` — un seul champ, `enabled: boolean` (défaut `true`). Aucun réglage de
connexion propre (voir §2.1).

---

## 7. Interface Web et Socket.io

### 7.1 Tableau de bord (`presentation/index.html`)

- Formulaire de dépôt : titre, description, sélecteur de fichier (`.yaml`/`.yml`) → `fetch` +
  `FormData` vers `/api/apps/scriptsha/upload` (pas de Socket.io pour ce transfert binaire, même
  convention que HAPLAN).
- Liste des scripts : titre, description, badge (diffusé / non diffusé / en cours), boutons "Voir
  le contenu" (modale, lecture seule), "Diffuser"/"Retirer" (selon statut), "Supprimer" (visible
  seulement si non diffusé).
- Le provisionnement lumières↔timers (§4bis) n'a pas d'IHM dédiée — silencieux côté utilisateur,
  visible seulement dans les logs et dans HA lui-même (liste des helpers).

### 7.2 Événements Socket.io

**Server → Client** (persistant : `scriptsha:scripts:list`) :
```typescript
'scriptsha:scripts:list'   // ScriptEntry[] enrichi d'un champ transitoire `pending: boolean`
'scriptsha:script:content' // { id, content }
'scriptsha:error'          // { message, id? }
```

**Client → Server :**
```typescript
'scriptsha:scripts:get'
'scriptsha:script:deploy'      // { id }
'scriptsha:script:undeploy'    // { id }
'scriptsha:script:delete'      // { id } — refusé si deployed=true
'scriptsha:script:get_content' // { id }
```

### 7.3 Événements internes core↔enfant (pas des événements Socket.io)

```typescript
'scriptsha:internal:upload'         // core→enfant, voir §5
'ha:rest:request'                    // enfant→core, voir §4.3 (générique, pas préfixé scriptsha)
'scriptsha:ha:rest:result'          // core→enfant, voir §4.3
'ha:helper:request'                  // enfant→core, voir §4bis.3 (générique)
'scriptsha:ha:helper:result'        // core→enfant, voir §4bis.3
'ha:entities:list:request'           // enfant→core, voir §4bis.3 (générique)
'scriptsha:ha:entities:list:result' // core→enfant, voir §4bis.3
'ha:entity:updated'                  // core→enfant, générique déjà existant, voir §4bis.4
```

---

## 8. Écart documenté au guide-nouvelle-application_specs

`guide-nouvelle-application_specs_v1.9.md` §3.6/§11 décrit un système `InterAppClient`/
`ApplicationCapabilities` obligatoire pour toute application. Vérifié absent du code réel dans les
12 applications existantes au moment de la création de `scriptsha` (commentaire explicite dans
`applications/planificateur/src/domain/correlation.ts` : *"InterAppClient confirmé absent du code
réel"*). `scriptsha` suit donc le code réel plutôt que ce passage précis du guide — ni
`capabilities.ts`, ni `InterAppClient`, ni `ApplicationCapabilities` ne sont implémentés. Le besoin
de communication cross-app avec `core` est couvert par les ponts `HaRestBridge`/`HaHelperBridge`
(§4, §4bis), des mécanismes plus étroits et déjà éprouvés (`bridgedEvents`, existant depuis
`espdisplay`) plutôt qu'un framework générique non implémenté ailleurs. Le même guide documente
aussi `ha:structure:get`/`ha:structure`, également jamais implémenté (§4bis.3) — deux écarts de même
nature trouvés indépendamment.

---

## 9. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| Pas de détection de dérive config↔HA | Si un script est supprimé/modifié manuellement dans HA, le statut local (`deployed`) ne s'actualise pas tout seul — reste `true` jusqu'à une action explicite depuis l'IHM | Non corrigé |
| Pas d'édition du contenu déposé | Un script mal formé doit être supprimé (si non diffusé) puis redéposé, pas de correction en place | Accepté (hors périmètre v1, voir §1.2) |
| Une seule action en vol par script | `pendingAction` (§4.4) n'accepte qu'une action à la fois par id — un second clic pendant une action en cours n'est pas mis en file, l'IHM masque les boutons tant que `pending` est vrai côté client | Accepté |
| Validation YAML minimale | Seule la validité syntaxique YAML est vérifiée au dépôt, pas la conformité au schéma d'un script HA — une erreur de structure n'apparaît qu'au moment de la diffusion (retour d'erreur HA relayé tel quel) | Accepté |
| Provisionnement spécifique à un seul script (§4bis.1) | Pas de mécanisme déclaratif générique — un futur 2e script ayant le même besoin demandera un nouveau code dédié, pas une simple déclaration | Accepté (décision explicite) |
| Domaine `light.*` brut, pas la taxonomie QUOI (§4bis.5) | Des entités non "lumière de pièce" (rétroéclairages d'écran, etc.) reçoivent aussi un timer | Accepté (décision explicite), corrigeable après coup |
| Détection réactive non vérifiée en conditions réelles (§4bis.5) | Le chemin `ha:entity:updated` → réconciliation repose sur un événement confirmé réel, mais jamais rejoué de bout en bout faute de nouvelle lumière physique disponible | À vérifier à la prochaine occasion |

---

## 10. Arborescence des Programmes

```
applications/scriptsha/
├── package.json, tsconfig.json
├── src/
│   ├── standalone.ts
│   ├── domain/
│   │   ├── ScriptsHaService.ts
│   │   ├── config-schema.ts, storage-schema.ts, socket-events.ts, index.ts
│   │   └── yaml/ConfigFileManager.ts
│   └── presentation/
│       ├── index.html, ts/app.ts    # Tableau de bord (dépôt + liste)
│       └── ts/global.d.ts
```

---

## 11. Annexes

### 11.1 Références
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.14.md) ⭐
- [Spécifications Fonctionnelles Supervision Multi-Machines](fonctionnelles-supervisor_specs_v2.6.md)
  (architecture process séparé, `bridgedEvents`)
- [Spécifications Fonctionnelles RPIGPIO](fonctionnelles-rpigpio_specs_v1.1.md) (application sœur,
  même patron process séparé + tableau de bord Socket.io)

### 11.2 Glossaire
| Terme | Définition |
|-------|------------|
| Script HA | Entité native Home Assistant `script.*` — séquence d'actions déclenchable, définie en YAML (`alias`, `sequence`, `mode`...) |
| Diffuser | Pousser le contenu déposé vers HA via l'API config REST (§4) — crée ou met à jour l'entité `script.<id>` |
| Retirer | Supprimer l'entité `script.<id>` côté HA (le fichier/l'enregistrement local restent, `deployed` repasse à `false`) |
| `HaRestBridge` | Pont générique core, routé par `appId`, pour toute app process séparé ayant besoin d'un appel REST config HA (§4.3) |
| `HaHelperBridge` | Pont générique core, routé par `appId`, pour le CRUD des helpers HA (WebSocket) et la requête ponctuelle du référentiel d'entités par domaine (§4bis.3) |
| Helper HA | Entité HA gérée par l'UI "Aides" (`timer`, `input_boolean`, `counter`...), CRUD par commandes WebSocket `{domain}/create|list|delete` |
| Réconciliation | Comparaison de l'état réel de HA à l'état attendu (§4bis.4) — "détection de mise en œuvre" dans les termes de la demande utilisateur |

### 11.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.1 | 2026-08-18 | Claude | Provisionnement automatique lumières↔timers (§4bis) : `HaWsClient.listHelpers/createHelper/deleteHelper` (WS générique), `HaHelperBridge` (pont générique CRUD helpers + requête référentiel d'entités par domaine), `ScriptsHaService::reconcileLightTimers()`. Déclenché à la diffusion du script minuterie et en continu pour les nouvelles lumières (`ha:entity:updated`, déjà réel, écart constaté avec `ha:structure:get` jamais implémenté). Vérifié en conditions réelles (35 lumières → 35 timers, idempotence confirmée, nettoyé après validation). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-18 | Claude | Première spécification, écrite avec le code. Ajoute côté core : `HaWsClient.getDomainConfig/setDomainConfig/deleteDomainConfig` (généralisation, refactor de `HaAutomationBackupService`), `HaRestBridge` (pont générique par `appId`), route générique `POST /api/apps/:appId/upload`. |
