# Spécifications Fonctionnelles - Module Scripts HA (scriptsha)

*Version 1.2 - 18 Août 2026*
*Généralisation du provisionnement (§4bis réécrite) : le mécanisme n'est plus câblé en dur sur le
script "Ensemble de minuterie" — un champ structuré `provisioning` (pas un nouveau format de
fichier) sur n'importe quelle entrée de script active désormais le même moteur générique. Nommage
des helpers créés basé sur la taxonomie QUOI/OÙ déjà calculée par le core (convention du projet),
avec anti-collision par suffixe numérique. Revérifié en conditions réelles avec le nouveau nommage
(35 lumières → 35 timers, dont 2 collisions taxonomiques réelles correctement désambiguïsées).
Ancienne version v1.1 archivée.*

*Version 1.1 - 18 Août 2026*
*Provisionnement automatique lumières↔timers (première version, câblée en dur sur un seul script) :
au déploiement du script d'illustration "Ensemble de minuterie", création du helper `timer`
manquant pour chaque lumière existante, et détection continue des nouvelles lumières tant que ce
script reste diffusé. Vérifié en conditions réelles contre la HA de production.*

*Version 1.0 - 18 Août 2026*
*Première spécification, écrite en même temps que le code — application créée en process séparé
dès l'origine, premier point d'entrée générique pour l'API REST config de HA (`HaRestBridge`, côté
core) et la première route d'upload générique (`POST /api/apps/:appId/upload`).*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Modèle de données](#3-modèle-de-données)
4. [Intégration HA — pont générique HaRestBridge](#4-intégration-ha--pont-générique-harestbridge)
    - 4bis. [Provisionnement générique par entité (v1.2)](#4bis-provisionnement-générique-par-entité-nouveau-v12-18082026)
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
  provisionnement générique optionnel par script (§4bis) — n'importe quel script peut porter un
  `provisioning` déclaratif, pas seulement le script d'illustration.
- **Exclus** : édition du contenu YAML depuis l'IHM (dépôt uniquement — un nouveau dépôt avec le
  même titre crée une nouvelle entrée, pas un remplacement), détection de dérive si un script est
  modifié/supprimé manuellement côté HA (le statut local reste la seule source de vérité, voir §9),
  validation sémantique du contenu YAML au-delà de "c'est un objet YAML", édition du `provisioning`
  depuis l'IHM (positionné en code aujourd'hui, uniquement pour le script d'illustration — voir
  §4bis.1).

---

## 2. Architecture

### 2.1 Composants (`applications/scriptsha/src/domain/`)

| Fichier | Rôle |
|---|---|
| `ScriptsHaService.ts` | Orchestrateur : CRUD des scripts, upload, diffusion/retrait via `HaRestBridge`, provisionnement générique via `HaHelperBridge` (§4bis), événements Socket.io |
| `config-schema.ts` | Schéma Zod minimal (`enabled`) — aucun réglage de connexion propre |
| `storage-schema.ts` | Schéma Zod d'une entrée (`ScriptEntry`, `ProvisioningConfig`) |
| `yaml/ConfigFileManager.ts` | Chargement/sauvegarde atomique du YAML des métadonnées (copie locale du pattern rpigpio/planificateur) |
| `socket-events.ts` | Catalogue des événements Socket.io |
| `index.ts` | Manifeste du module (`SCRIPTSHA_APP`) + factories |
| `standalone.ts` | Bootstrap process séparé (patron rpigpio/espdisplay) |

**Manifeste** (`SCRIPTSHA_APP`) : `id: 'scriptsha'`, `type: 'standalone'`, `requiredMqtt: false`,
`requiredHaWs: false`, `runsAsSeparateProcess: true`,
`bridgedEvents: ['scriptsha:internal:upload', 'scriptsha:ha:rest:result', 'scriptsha:ha:helper:result', 'scriptsha:ha:entities:list:result', 'ha:entity:updated']`
— inchangé depuis v1.1, la généralisation du provisionnement (§4bis) ne touche que la couche
`ScriptsHaService`, pas le manifeste ni les ponts core.

### 2.2 Process séparé

Comme RFXCOM/espdisplay/rpigpio (`fonctionnelles-supervisor_specs` §2.4). `bridgedEvents` ne liste
que le sens **core→enfant** (le sens enfant→core est automatique) :
- `scriptsha:internal:upload` — relayé depuis la route générique d'upload (§5).
- `scriptsha:ha:rest:result` — relayé depuis `HaRestBridge` (§4).
- `scriptsha:ha:helper:result` / `scriptsha:ha:entities:list:result` — relayés depuis
  `HaHelperBridge` (§4bis).
- `ha:entity:updated` — événement générique déjà émis par le core, utilisé pour détecter une
  nouvelle entité surveillée en continu (§4bis.4).

### 2.3 Flux de données (diffusion d'un script portant un `provisioning`)

```
IHM (formulaire dépôt : titre, description, fichier .yaml)
    |
    v
ScriptsHaService : écrit data/scriptsha/scripts/<id>.yaml + entrée dans scriptsha-scripts-v1.0.yaml
    |
    v (bouton "Diffuser")
ScriptsHaService émet ha:rest:request { appId:'scriptsha', method:'set', domain:'script', id, config }
    |
    v
HaRestBridge (core) : HaWsClient.setDomainConfig('script', id, config) + sendCommand('script','reload',{})
    |
    v
Home Assistant : crée/modifie l'entité script.<id>
    |
    v
ScriptsHaService : deployed=true, diffuse scriptsha:scripts:list
    |
    v (si entry.provisioning défini — générique, voir §4bis)
ScriptsHaService::reconcileEntityHelpers(entry.provisioning)
```

---

## 3. Modèle de données

### 3.1 `ScriptEntry` (`storage-schema.ts`)

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `id` | string | oui (généré) | Slug du titre — sert aussi de nom de fichier ET de `script_id` HA |
| `title` | string | oui | Titre saisi par l'utilisateur |
| `description` | string | non (défaut `''`) | Explication libre |
| `originalFilename` | string | oui | Nom du fichier tel que déposé |
| `deployed` | boolean | oui (défaut `false`) | Statut courant — source de vérité locale |
| `deployedAt` | string | non | Horodatage ISO de la dernière diffusion réussie |
| `createdAt` | string | oui | Horodatage ISO du dépôt |
| `updatedAt` | string | non | Horodatage ISO de la dernière diffusion/retrait |
| `provisioning` | `ProvisioningConfig` | non | ⭐ v1.2 — active le provisionnement générique (§4bis) |

### 3.2 `ProvisioningConfig` (`storage-schema.ts`, ⭐ nouveau v1.2)

| Champ | Type | Description |
|---|---|---|
| `watchDomain` | string | Domaine HA à surveiller (ex: `light`) |
| `helperDomain` | string | Domaine de helper HA à créer (ex: `timer`) |
| `namePrefix` | string | Préfixe du nom (ex: `Minuterie`) — le reste vient de la taxonomie OÙ (§4bis.4) |
| `helperData` | `Record<string, unknown>` (optionnel) | Champs additionnels passés tels quels à la création (ex: `{ duration: '00:10:00' }`) |

Métadonnées structurées, **pas un nouveau format de fichier** — le contenu YAML du script lui-même
reste un script HA pur, jamais interprété. Écarté en revue de conception : un format "à chapitres"
dans le fichier déposé (chapitre exécutable + chapitre recette), jugé équivalent à inventer "un
langage propre à scriptsha" pour un besoin qui se réduit en réalité à ces 4 champs fixes.

### 3.3 Persistance

- `data/scriptsha/scriptsha-scripts-v1.0.yaml` — tableau `scripts: ScriptEntry[]` (métadonnées).
- `data/scriptsha/scripts/<id>.yaml` — un fichier par script, le corps YAML brut attendu par l'API
  config HA, **sans** clé `<id>:` de tête.
- Les helpers créés par le provisionnement (§4bis) ne sont **pas** suivis dans un fichier local —
  l'état réel de HA (`{helperDomain}/list`) est la seule source de vérité.

---

## 4. Intégration HA — pont générique HaRestBridge

*(inchangé depuis v1.1 — voir version précédente pour le détail complet)*

### 4.1 Pourquoi pas de commande WebSocket

HA n'expose aucune commande WebSocket pour créer/modifier/supprimer la config brute d'un script —
le CRUD passe par la route REST `GET/POST/DELETE /api/config/script/config/{id}`.

### 4.2 Centralisation — `HaWsClient.getDomainConfig/setDomainConfig/deleteDomainConfig`

3 méthodes génériques (`applications/core/src/ha/sync/HaWsClient.ts`), également utilisées par
`HaAutomationBackupService` (refactorée pour les réutiliser).

### 4.3 `HaRestBridge` — pont générique par `appId`

`applications/core/src/ha/HaRestBridge.ts` — écoute `ha:rest:request`, répond sur
`<appId>:ha:rest:result`. Toujours instancié, répond `{ success: false, error: 'HA non connecté' }`
si HA WebSocket n'est pas configuré.

### 4.4 Corrélation côté `scriptsha`

`pendingAction: Map<id, 'deploy'|'undeploy'>` — une seule action en vol par script à la fois.

---

## 4bis. Provisionnement générique par entité (⭐ nouveau v1.2, 18/08/2026)

### 4bis.1 Généralisation depuis v1.1

v1.1 câblait en dur `if (id === EXAMPLE_SCRIPT_ID)` dans `ScriptsHaService` — constat de
l'utilisateur en revue : contradiction avec le principe que l'app "ne sait pas ce que font les
scripts". Discussion de conception menée jusqu'à un arbitrage clair (voir mémoire de session) :
- **Contrainte technique établie** (pas un choix) : HA n'a aucun service permettant à un
  script/automatisation de créer lui-même une ressource de registre (helper, area, un autre
  script, entité, device, dashboard, utilisateur/intégration) — seule l'API admin WS/REST y a
  accès. Un "chapitre" du script exécuté par HA ne peut donc techniquement pas créer un timer.
- **Piste "chapitres dans le fichier" écartée** : équivalait à inventer un langage propre à
  scriptsha pour un seul cas d'usage.
- **Passage en revue des 7 catégories** "registre HA inaccessible aux scripts" (helpers, areas,
  scripts/automations/scenes, entity registry, device registry, dashboards, users/intégrations) —
  seule la catégorie helpers reste pertinente aujourd'hui pour ce projet.
- **Conclusion retenue** : généraliser modestement (4 champs fixes, `ProvisioningConfig` §3.2), pas
  un DSL extensible — toujours "l'app ne connaît aucun script en particulier", mais sans coût de
  langage nouveau. Seul le script d'illustration renseigne ce champ aujourd'hui (positionné en
  code, pas d'UI de configuration) — rien n'empêche un futur dépôt de script d'en porter un aussi,
  une fois une UI construite si le besoin se confirme.

### 4bis.2 `HaWsClient` — CRUD générique des "helpers" HA

3 méthodes (`listHelpers`/`createHelper`/`deleteHelper`), commandes WebSocket admin génériques
`{domain}/create|list|delete` (`timer`, `input_boolean`, `input_number`, `counter`, `schedule`...).
Vérifié empiriquement : `timer/create {name, duration}` → `{id, name, duration, restore}`
(`id` = slug HA du `name`).

### 4bis.3 `HaHelperBridge` — pont générique (helpers + référentiel d'entités enrichi)

`applications/core/src/ha/HaHelperBridge.ts`, **sans connaissance d'aucun nom d'app**. Deux
capacités :
- `ha:helper:request` → `<appId>:ha:helper:result` : CRUD helper, corrélé par `requestId` (généré
  côté appelant — contrairement à `HaRestBridge`, aucun identifiant métier réutilisable ici : une
  requête `list` n'a pas d'id cible, une création n'a pas d'id connu avant coup).
- `ha:entities:list:request` → `<appId>:ha:entities:list:result` : photo ponctuelle du référentiel
  d'entités par domaine (`HaStructureRegistry.getAllEntities()`). **⭐ v1.2** : chaque entité
  retournée inclut désormais `area_id`, `quoiIds`, et surtout `taxonomy` (`lieuPrecis`,
  `lieuPrincipal`, `lieuPere`, `lieuGrandPere`) — lu depuis `entity.attributes.attributs_taxonomie`,
  déjà posé par `TaxonomyHaClassifier` pour chaque entité (même mécanisme qu'`arbreouquoi`/
  `nommage`), pas recalculé.

  **Écart avec le guide** (déjà constaté en v1.1) : `ha:structure:get`/`ha:structure` documentés
  mais jamais implémentés — d'où la construction de `ha:entities:list:request` plutôt que de s'y
  appuyer.

### 4bis.4 Nommage des helpers — convention QUOI/OÙ du projet (⭐ nouveau v1.2)

`ScriptsHaService::buildHelperName()` — même patron que `rpigpio::buildQuoiOuLabel` (déjà dans le
projet) : `{namePrefix}---{lieu_precis si différent}--{lieu_principal}--{lieu_pere}--{lieu_grand_pere}`.
`namePrefix` (ex: "Minuterie") remplace le "quoi" de l'entité — pas la peine de le répéter (un
timer n'est pas "une lumière", il *appartient* à une lumière). Repli sur le suffixe brut de
l'`entity_id` si aucune taxonomie n'est disponible (garantit toujours un nom, jamais d'échec).

**Anti-collision** (décision utilisateur explicite, la taxonomie ne garantit pas une unicité
absolue) : un `Set` des noms déjà attribués **durant la passe en cours** — si un nom calculé est
déjà réclamé par une AUTRE entité de cette même réconciliation, suffixe numérique (` 2`, ` 3`...)
avant de vérifier la présence côté HA. Vérifié en conditions réelles : "Chevets L1"/"Chevets L2"
(2 lumières, même pièce, taxonomie insuffisamment distincte) → `Minuterie---chevets--chambre de
jo--1er étage` et `... 2`, correctement désambiguïsés plutôt que collisionnés silencieusement.

### 4bis.5 `matchesWatchCondition()` — isolée à dessein

```ts
private matchesWatchCondition(entity: { entity_id: string; quoiIds?: string[] }, entityDomain: string, provisioning: ProvisioningConfig): boolean {
  return entityDomain === provisioning.watchDomain;
}
```

Aujourd'hui : simple égalité de domaine. Isolée dans sa propre méthode **à la demande explicite de
l'utilisateur** ("isoler bien la partie condition qui pourrait évoluer très vite") — un futur
besoin de filtre plus riche (exclusion par `quoiIds`, filtre sur `area_id`, etc. — voir §9, 2 des
35 lumières réelles ne sont pas des lumières de pièce) n'aura qu'un seul point à modifier. `entity`
porte déjà `quoiIds` (retourné par `HaHelperBridge`, §4bis.3) bien qu'inutilisé aujourd'hui —
disponible pour cette évolution sans nouveau round-trip core.

### 4bis.6 `reconcileEntityHelpers(provisioning)` — moteur générique

Remplace l'ancien `reconcileLightTimers()` (v1.1, câblé en dur) :
1. Émet en parallèle `ha:entities:list:request {domain: provisioning.watchDomain}` et
   `ha:helper:request {method:'list', domain: provisioning.helperDomain}`.
2. Filtre les entités via `matchesWatchCondition()` (§4bis.5).
3. Pour chaque entité surveillée : calcule le nom (§4bis.4) avec anti-collision intra-passe, puis
   compare l'id attendu (`slugify()`) à la liste réelle des helpers existants — **"détection de
   mise en œuvre"** (terme de la demande utilisateur), pas d'état local séparé.
4. Crée en parallèle (`Promise.all`) chaque helper manquant, avec `provisioning.helperData` en
   payload additionnel.

**Déclenchement**, désormais générique (plus aucune référence à un id de script précis) :
- `handleHaRestResult` : `if (action === 'deploy' && entry.provisioning) reconcileEntityHelpers(entry.provisioning)`.
- `handleEntityUpdated` : pour **chaque script actuellement diffusé** dont le `watchDomain`
  correspond au domaine de l'entité créée, relance une réconciliation (boucle sur `this.scripts`,
  pas un seul script visé en dur).

Mutex (`reconcilingProvisioning`) inchangé depuis v1.1 — évite deux réconciliations concurrentes.

### 4bis.7 Vérifié en conditions réelles (18/08/2026, revérifié après généralisation)

- Diffusion du script minuterie → **35 lumières réelles** → **35 timers créés**, noms au format
  QUOI/OÙ confirmés (ex: `Minuterie---bureau--salle à manger--rez de chaussée`).
- **2 collisions taxonomiques réelles rencontrées et correctement désambiguïsées** ("Chevets
  L1"/"L2", les 2 rétroéclairages d'écran HAPLAN) — confirme que l'anti-collision intra-passe
  fonctionne, pas seulement en théorie.
- Rejouer la diffusion → **idempotent** ("rien à installer"), y compris pour les entrées
  désambiguïsées par suffixe — confirme que le calcul du nom (donc de l'id attendu) est
  déterministe d'une passe à l'autre.
- Script et 35 timers **retirés après validation** (état de test, pas laissé en production).
- Détection réactive (§4bis.6, 2e déclencheur) : **toujours non vérifiée en conditions réelles**
  (pas de nouvelle lumière physique disponible) — repose sur `ha:entity:updated`, confirmé réel.

---

## 5. Upload de fichier — route générique

*(inchangé depuis v1.1)*

### 5.1 `POST /api/apps/:appId/upload`

Généralisation du précédent HAPLAN — relaie `buffer`, `filename`, `mimetype`, `fields: req.body`
via `<appId>:internal:upload`.

### 5.2 Sérialisation IPC du buffer

`ScriptsHaService::toBuffer()` reconstruit un vrai `Buffer` depuis `{ type: 'Buffer', data: [...] }`
(sérialisation JSON par défaut du canal IPC).

---

## 6. Configuration

`data/scriptsha/config.yaml` — un seul champ, `enabled: boolean` (défaut `true`).

---

## 7. Interface Web et Socket.io

### 7.1 Tableau de bord (`presentation/index.html`)

- Formulaire de dépôt : titre, description, fichier `.yaml`/`.yml` → `fetch`+`FormData` vers
  `/api/apps/scriptsha/upload`.
- Liste : titre, description, badge (diffusé/non diffusé/en cours), "Voir le contenu",
  "Diffuser"/"Retirer", "Supprimer" (si non diffusé).
- Le provisionnement (§4bis) n'a pas d'IHM dédiée — silencieux côté utilisateur, visible dans les
  logs et dans HA (liste des helpers). Pas d'IHM non plus pour éditer/créer un `provisioning`
  (§1.2) — positionné en code pour le script d'illustration uniquement.

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
'ha:rest:request'                    // enfant→core, voir §4.3 (générique)
'scriptsha:ha:rest:result'          // core→enfant, voir §4.3
'ha:helper:request'                  // enfant→core, voir §4bis.3 (générique)
'scriptsha:ha:helper:result'        // core→enfant, voir §4bis.3
'ha:entities:list:request'           // enfant→core, voir §4bis.3 (générique)
'scriptsha:ha:entities:list:result' // core→enfant, voir §4bis.3
'ha:entity:updated'                  // core→enfant, générique déjà existant, voir §4bis.6
```

---

## 8. Écart documenté au guide-nouvelle-application_specs

`guide-nouvelle-application_specs_v1.9.md` §3.6/§11 décrit `InterAppClient`/
`ApplicationCapabilities` obligatoire — confirmé absent du code réel dans les 12 applications
existantes au moment de la création de `scriptsha`. `scriptsha` suit le code réel : ni
`capabilities.ts`, ni `InterAppClient`. Le besoin cross-app avec `core` est couvert par
`HaRestBridge`/`HaHelperBridge` (§4, §4bis), mécanismes plus étroits et déjà éprouvés
(`bridgedEvents`, existant depuis `espdisplay`). Même constat pour `ha:structure:get`/
`ha:structure`, également jamais implémenté (§4bis.3).

---

## 9. Limites et Contraintes Connues

| Limite | Impact | Statut |
|--------|--------|--------|
| Pas de détection de dérive config↔HA | Statut local (`deployed`) ne s'actualise pas si modifié manuellement dans HA | Non corrigé |
| Pas d'édition du contenu déposé | Un script mal formé doit être supprimé (si non diffusé) puis redéposé | Accepté (hors périmètre v1, §1.2) |
| Une seule action en vol par script | `pendingAction` (§4.4) — un second clic pendant une action en cours n'est pas mis en file | Accepté |
| Validation YAML minimale | Seule la validité syntaxique est vérifiée au dépôt | Accepté |
| Pas d'IHM pour le `provisioning` | Positionné en code, uniquement pour le script d'illustration (§4bis.1) | Accepté, à construire si un 2e besoin réel se confirme |
| Domaine `light.*` brut pour le script d'illustration | Des entités non "lumière de pièce" (rétroéclairages d'écran) reçoivent aussi un timer — `matchesWatchCondition` (§4bis.5) pourrait filtrer plus finement | Accepté (décision explicite), isolé pour évolution facile |
| Ordre de `getAllEntities()` supposé stable | L'anti-collision intra-passe (§4bis.4) suppose un ordre déterministe d'un appel à l'autre pour rester idempotente — vérifié empiriquement 2 fois de suite, pas garanti formellement par l'API | Accepté, risque théorique faible |
| Détection réactive non vérifiée en conditions réelles | Le chemin `ha:entity:updated` → réconciliation repose sur un événement confirmé réel, jamais rejoué de bout en bout (pas de nouvelle lumière physique disponible) | À vérifier à la prochaine occasion |

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
- [Spécifications Fonctionnelles RPIGPIO](fonctionnelles-rpigpio_specs_v1.1.md) (`buildQuoiOuLabel`,
  patron de nommage QUOI/OÙ repris ici pour les helpers)

### 11.2 Glossaire
| Terme | Définition |
|-------|------------|
| Script HA | Entité native Home Assistant `script.*` — séquence d'actions déclenchable, YAML |
| Diffuser | Pousser le contenu déposé vers HA via l'API config REST (§4) |
| Retirer | Supprimer l'entité `script.<id>` côté HA (`deployed` repasse à `false`) |
| `HaRestBridge` | Pont générique core pour le CRUD REST config HA (script/automation/scene) |
| `HaHelperBridge` | Pont générique core pour le CRUD WS des helpers HA + requête d'entités par domaine |
| `ProvisioningConfig` | ⭐ v1.2 — métadonnées structurées activant le provisionnement générique pour un script |
| Réconciliation | Comparaison de l'état réel de HA à l'état attendu — "détection de mise en œuvre" |

### 11.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.2 | 2026-08-18 | Claude | Généralisation du provisionnement (§4bis) : `ProvisioningConfig` structuré remplace le câblage en dur sur un id de script ; nommage des helpers basé sur la taxonomie QUOI/OÙ du projet (`HaHelperBridge` étendu : `area_id`/`quoiIds`/`taxonomy` par entité) avec anti-collision intra-passe ; `matchesWatchCondition()` isolée pour évolution rapide (demande explicite utilisateur). Revérifié en conditions réelles avec le nouveau nommage — 2 collisions taxonomiques réelles correctement désambiguïsées, idempotence confirmée. Ancienne version v1.1 archivée. |
| 1.1 | 2026-08-18 | Claude | Provisionnement automatique lumières↔timers (première version, câblée en dur). `HaWsClient.listHelpers/createHelper/deleteHelper`, `HaHelperBridge`. Vérifié en conditions réelles (35 lumières → 35 timers). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-18 | Claude | Première spécification. `HaWsClient.getDomainConfig/setDomainConfig/deleteDomainConfig`, `HaRestBridge`, route générique `POST /api/apps/:appId/upload`. |
