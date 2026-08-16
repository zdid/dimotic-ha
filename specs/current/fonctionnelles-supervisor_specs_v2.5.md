# Spécifications Fonctionnelles - Supervision Multi-Machines (SUPERVISOR)

*Version 2.5 - 16 Août 2026*
*⭐ Phase 1 implémentée et vérifiée en conditions réelles — première application migrée
(`espdisplay`) en process séparé, communiquant par MQTT (`MqttEventBus`) avec `core` resté
in-process. Nouvelle §14 "Phase 1 — Bilan d'implémentation" : ce qui a été construit, deux
problèmes réels découverts et corrigés en testant (process orphelins au redémarrage de core,
`app:menu:register` jamais relayé côté socle — préexistant, sans rapport avec cette migration),
deux décisions prises en cours de route (aucune signature/auth sur le canal de commandes,
commandes start/stop/restart génériques par MQTT plutôt que réservées aux machines contraintes).
Ancienne version v2.4 archivée.*

*Version 2.4 - 16 Août 2026*
*Correction de référence croisée uniquement — `techniques-socle-ha-mqtt_specs` v4.29 → v4.30
(§8.5.4ter, rejet des commandes MQTT retenues). Aucun changement de contenu propre à cette spec.*

*Version 2.3 - 15 Août 2026*
*Discussion approfondie, point par point, avant tout passage à l'implémentation : persistance
horodatée locale du registre (§6.4), conception détaillée des redondances rpigpio/rfxcom (§9,
réécrite), décision de sécurité concrète — signature HMAC du canal de commandes plutôt
qu'authentification broker/TLS (§10), nouvelle section Agent Minimal pour machines contraintes
type ARMv6 (§11, referme le "hors scope" de la v2.2), et une liste de prérequis avant
implémentation (§13.1, nouvelle). Toujours **aucun code écrit**.*

*Version 2.2 - 15 Août 2026*
*Ajoute la politique de redémarrage en cas de crash (§8.4) : backoff exponentiel plafonné à 30s,
réarmement du compteur après 60s de fonctionnement stable, abandon après 5 tentatives rapprochées
(état terminal `crashed`, redémarrage manuel requis) — discutée puis validée avec l'utilisateur
avant rédaction.*

*Version 2.1 - 15 Août 2026*
*Corrige et complète la v2.0 (même jour) : §7 réécrite en réponse à une question directe de
l'utilisateur ("comment voir toutes les applis de toutes les machines sur la même interface web ?").
Corrige au passage une incohérence de la v2.0 (le pontage Socket.io ne s'abonnait qu'à sa propre
machine, alors que `MqttEventBus` s'abonnait déjà en wildcard toutes machines) et ajoute le seul
mécanisme réellement manquant : un proxy HTTP de repli pour les fichiers statiques (HTML/CSS/JS)
d'une application hébergée sur une autre machine. Toujours **aucun code écrit**.*

*Version 2.0 - 15 Août 2026*
*Refonte de la v1.0 (même jour) : passage à **une application = un process OS**, avec MQTT comme
bus unique — intra-machine ET inter-machine, plus seulement pour le relais cross-machine. Motivé
par une question de l'utilisateur : "pour la simplicité, pourquoi ne pas repasser à du tout MQTT ?
Ça permettrait aussi de gérer les applications sans redémarrer l'application entière." Vérifié
avant d'accepter (voir §2.4) : le surcoût mémoire d'un process par application, crainte initiale,
ne tient pas face aux chiffres réels mesurés sur `ha2`.*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Faits Vérifiés (état actuel du code)](#2-faits-vérifiés-état-actuel-du-code)
3. [Architecture Proposée](#3-architecture-proposée)
4. [Identité Machine](#4-identité-machine)
5. [Démarrage des Applications (injection)](#5-démarrage-des-applications-injection)
6. [Bus MQTT Unifié](#6-bus-mqtt-unifié)
    - 6.4 [Registre de présence — vue live + historique local persisté](#64-registre-de-présence--vue-live--historique-local-persisté-v23)
7. [Interface Web Unifiée](#7-interface-web-unifiée)
    - 7.1 [Événements Socket.io — déjà global par construction](#71-événements-socketio--déjà-global-par-construction)
    - 7.2 [Assets statiques (HTML/CSS/JS) cross-machine](#72-assets-statiques-htmlcssjs--la-pièce-manquante-ajoutée-en-v21)
8. [Cycle de Vie et Activation/Désactivation en Direct](#8-cycle-de-vie-et-activationdésactivation-en-direct)
    - 8.4 [Politique de redémarrage en cas de crash](#84-politique-de-redémarrage-en-cas-de-crash-v22)
9. [Redondances Multi-Instances (rpigpio/rfxcom) — Conception détaillée](#9-redondances-multi-instances-rpigpiorfxcom--conception-détaillée-v23)
    - 9.1 [Principe retenu](#91-principe-retenu--une-entité-un-seul-endroit-responsabilité-du-paramétreur)
    - 9.2 [Collision par défaut partagé](#92-collision-par-défaut-partagé--tirage-aléatoire-pas-de-dérivation-de-machineid)
    - 9.3 [Topic de découverte MQTT](#93-topic-de-découverte-mqtt--bridgeinstance-en-node_id)
    - 9.4 [RFXCOM — recouvrement RF réel](#94-rfxcom--recouvrement-rf-réel-visibilité-par-diffusion-nouveau-v23)
    - 9.5 [Cas non concernés](#95-cas-non-concernés)
10. [Sécurité — Canal de Commandes Signé](#10-sécurité--canal-de-commandes-signé)
11. [Agent Minimal pour Machines Contraintes](#11-agent-minimal-pour-machines-contraintes)
12. [Idées Complémentaires et Hors Scope](#12-idées-complémentaires-et-hors-scope)
13. [Plan de Mise en Œuvre](#13-plan-de-mise-en-œuvre)
    - 13.1 [Prérequis avant implémentation](#131-prérequis-avant-le-passage-à-cette-architecture-v23-15082026)
14. [Phase 1 — Bilan d'implémentation](#14-phase-1--bilan-dimplémentation--nouveau-v25-16082026)
15. [Annexes](#15-annexes)

---

## 1. Introduction

### 1.1 Origine du besoin (inchangé depuis v1.0)

Chaque machine (`ha2`, `orangepi`, une machine de dev "falbala"…) fait tourner aujourd'hui sa
propre instance complète et **totalement isolée** de la plateforme — aucune machine ne sait qu'une
autre existe, ni quelles applications y tournent. Deux problèmes concrets, rencontrés dans la même
session (13-15/08/2026), en découlent directement :

1. **`espdisplay`** a dû mettre en place un accès SSH point-à-point (clé dédiée, commande forcée)
   pour déléguer son pipeline de compilation ESPHome à `falbala` depuis `ha2`.
2. **Rien n'empêche** aujourd'hui deux machines de faire tourner la même application matérielle
   (`rpigpio`, `rfxcom`) avec une configuration qui se marche dessus.

### 1.2 Pourquoi cette refonte (v1.0 → v2.0)

La v1.0 gardait le core mono-process actuel intact, et ajoutait MQTT **seulement** pour le cas
cross-machine (registre de présence + relais de commandes explicite `emitToMachine()`). Un
troisième problème, présent depuis toujours mais non résolu par la v1.0, a motivé la refonte :

3. **`ApplicationManager.enable()`/`disable()` exige un redémarrage complet du process** — toutes
   les applications tournent dans le **même** process Node partagé, donc arrêter proprement une
   seule d'entre elles sans affecter les autres n'est pas possible aujourd'hui (voir §2.2).

**Décision de conception (15/08/2026)** : plutôt que de résoudre le problème 3 séparément (rejoignait
le sujet PID+signaux mis en pause le 23/07/2026, explicitement exclu de la v1.0), le résoudre **par
le même mécanisme** que les problèmes 1 et 2 — passer à une architecture **une application = un
process OS**, communiquant exclusivement par MQTT (y compris pour deux applications sur la **même**
machine, pas seulement entre machines). Un process peut être démarré/arrêté individuellement
(signal), ce qui résout le problème 3 sans mécanisme séparé.

### 1.3 Périmètre de cette version

- **Inclus** : tout le périmètre de la v1.0 (identité machine, visibilité décentralisée, relais de
  commandes, redondances rpigpio/rfxcom) **plus** : passage au modèle un-process-par-application,
  bus MQTT unifié intra+inter-machine, activation/désactivation d'application en direct (sans
  redémarrage du core), la question explicite de l'utilisateur sur le maintien d'une interface web
  unique (§7), la persistance horodatée locale du registre (§6.4), la conception détaillée des
  redondances (§9), une décision de sécurité concrète (§10), et un agent minimal pour machines
  contraintes (§11).
- **Exclu** : toute implémentation de code (spec de conception uniquement).

---

## 2. Faits Vérifiés (état actuel du code)

### 2.1 à 2.3 — repris de la v1.0 (toujours vérifiés, inchangés)

- **Aucune identité machine n'existe nulle part** dans le socle (`grep machineId/instanceId/hostname`
  sur `applications/core/src/` : zéro résultat).
- **`EventBus.emitGeneric`/`onGeneric`** (`applications/core/src/application/EventBus.ts`) est le
  canal générique inter-app actuel — **strictement in-process**. `SocketBridge` le ponte vers
  Socket.io de façon **dynamique, pilotée par convention de nommage** (pour chaque événement déclaré
  dans `*_SOCKET_EVENTS`, pose un `eventBus.onGeneric(eventName, ...)` qui rediffuse vers les
  clients socket) — le patron exact repris pour le pontage MQTT ↔ Socket.io (§7).
- **`ApplicationManager.enable()`/`disable()`** ne déplacent plus de dossier (abandonné le
  07/08/2026) — bascule `disabledApps` dans `data/core/config.yaml`, puis
  `RestartManager.scheduleRestart(15000, ...)`, un redémarrage complet du process Node. **C'est
  précisément ce mécanisme que la v2.0 remplace** (§8).
- Conventions MQTT déjà standardisées (`techniques-socle-ha-mqtt_specs` §8.5) : topics
  `{moduleName}/{bridgeInstance}/{deviceId}/state|set`, LWT par bridge (retain, QoS 1), un seul
  broker MQTT partagé (`ha.mqtt`). `bridgeInstance` est par instance d'application — voir §9.2 pour
  la conception détaillée de son défaut.

### 2.4 ⭐ Mesure réelle du surcoût mémoire (v2.0, 15/08/2026)

Crainte initiale (première mouture de cette discussion) : un process par application coûterait trop
cher en RAM sur du matériel contraint (`ha2`, Pi4, 1.8 Go — déjà vu saturer lors de l'essai de
compilation ESP-IDF, voir `fonctionnelles-espdisplay_specs` §6.2). **Vérifiée directement sur `ha2`
et écartée** :

```
docker top dimotic-ha  (architecture actuelle, TOUTES les apps dans 1 process "logique")
  supervisor.js (wrapper)      38 Mo
  tsx (CLI)                    45 Mo
  node (l'appli, tout chargé)  235 Mo
  esbuild (service tsx)        14 Mo
  ────────────────────────────────
  Total                        ~332 Mo (sur 1,8 Go)
```

Constat clé : l'architecture "un seul process" actuelle en fait déjà tourner **4** à cause de la
couche `tsx` (exécution TypeScript directe même en usage "production", voir `Dockerfile`). Un
process Node **compilé et lancé nu** (`node dist/index.js`, sans tsx/esbuild) pèse en pratique
30-50 Mo de base. Avec ~8 applications actives typiques : 250-450 Mo au total — **comparable, voire
inférieur**, à ce que l'architecture actuelle consomme déjà pour tout faire tenir dans un seul
process avec sa couche tsx. Argument renforcé par l'expérience directe de l'utilisateur : son
ancien système de supervision (PID+signaux, ~2015) faisait tourner plus de 10 applications sur un
Raspberry Pi 3 (moins de RAM qu'un Pi4) avec des temps de réponse immédiats.

---

## 3. Architecture Proposée

### 3.1 Vue d'ensemble

```
Machine (ex: ha2)
┌──────────────────────────────────────────────────────────────────┐
│  core (process unique, toujours actif)                            │
│  ┌────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ Express + Socket.io │  │ supervisor/ (nouveau module core)    │ │
│  │ (UI, INCHANGÉ, 1    │◄─┤ - spawn/kill des process d'app       │ │
│  │  seul port/URL, §7) │  │ - pont MQTT ↔ Socket.io (§7)         │ │
│  └────────────────────┘  │ - publie présence+registre (§6)       │ │
│                            └──────────────┬────────────────────────┘ │
└────────────────────────────────────────────┼──────────────────────┘
                                              │ MQTT (broker ha.mqtt partagé)
                     ┌────────────────────────┼────────────────────────┐
                     │                        │                        │
              ┌──────▼──────┐         ┌───────▼──────┐          ┌──────▼──────┐
              │ haplan       │         │ espdisplay    │          │ rfxcom       │
              │ (process OS  │         │ (process OS   │          │ (process OS  │
              │  séparé)     │         │  séparé)      │          │  séparé)     │
              └─────────────┘         └──────────────┘          └─────────────┘
```

Chaque application devient un **process OS indépendant**, démarré/arrêté par `core` (§5, §8), qui
communique avec `core` et les autres applications **exclusivement par MQTT** (§6) — plus de
`eventBus` partagé en mémoire entre applications. `core` reste le seul point d'entrée web (§7) et le
seul superviseur de processus sur sa machine.

### 3.2 Emplacement du code

`applications/core/src/supervisor/` — nouveau sous-dossier du socle, comme en v1.0, mais rôle élargi
: en v1.0 il ne faisait que publier/lire un registre MQTT en lecture seule ; en v2.0 il **démarre et
arrête réellement les process** des applications (§5, §8), en plus de la présence/registre (§6) et
du pont web (§7).

---

## 4. Identité Machine

Inchangé depuis la v1.0 : nouveau champ optionnel `core.machineId` dans le schéma Zod du socle,
défaut `os.hostname()`. Sert d'identifiant pour le registre de présence (§6.4) et pour le proxy web
cross-machine (§7.2) — **ne sert plus à dériver `bridgeInstance`** par défaut, voir §9.2 pour le
changement de décision.

---

## 5. Démarrage des Applications (injection)

### 5.1 Aujourd'hui : injection en mémoire par `AppService`

`AppService.startApplicationService(moduleId)` charge le module, trouve sa factory
`create*Service`, et l'appelle **directement en mémoire** avec les dépendances déjà construites par
`core` : `create*Service(eventBus, logger, configProvider, [haStructureRegistry], [haWsClient])` —
l'arité de la factory (3 à 5 paramètres) détermine ce qui lui est injecté.

### 5.2 v2.0 : chaque application se démarre elle-même

Ce même contrat de factory est **conservé à l'identique** — c'est le point clé qui évite de
réécrire le code métier de chaque application (`HaplanService.ts`, `EspDisplayService.ts`, etc. ne
changent pas). Ce qui change : **qui appelle la factory**.

Nouveau point d'entrée par application, `applications/<app>/src/standalone.ts` (à côté de
`domain/index.ts`, qui reste inchangé et continue d'exporter `create*Service`) :

```typescript
// applications/<app>/src/standalone.ts — squelette, un seul fichier par app, quasi identique partout
import { createLogger, ConfigLoader } from '../../core/dist/exports';
import { MqttEventBus } from '../../core/dist/exports';           // nouveau, voir §6.3
import { create<App>Service } from './domain';

const config = new ConfigLoader().load();                          // lit data/<app>/config.yaml
const logger = createLogger(config.logging);
const eventBus = new MqttEventBus({ appId: '<app>', mqttConfig: config.ha.mqtt, machineId: config.core.machineId });
const configProvider = /* AppConfigProvider comme aujourd'hui */;

const service = create<App>Service(eventBus, logger, configProvider);
service.start();

process.on('SIGTERM', () => service.stop().then(() => process.exit(0)));  // voir §8.2
```

Chaque application lit **elle-même** sa config (`data/<app>/config.yaml`, même mécanisme
`ConfigLoader` qu'aujourd'hui) et la config MQTT partagée (`data/core/config.yaml` — lecture directe
du fichier, pas d'injection par un parent) — plus besoin qu'un process central construise et
distribue ces objets, chaque process se bootstrap lui-même de façon identique.

### 5.3 Qui lance ces process ?

`supervisor/` (dans `core`), au démarrage de la machine : pour chaque application activée
(`!disabledApps`), `child_process.spawn('node', ['applications/<app>/dist/standalone.js'])` (ou
l'équivalent `tsx` en dev), garde le PID. **C'est le même geste, appliqué app par app, que
l'ancien système de supervision de l'utilisateur (PID+signaux, ~2015)** — repris comme mécanisme,
pas comme code (toujours pas de portage direct, voir v1.0 §11.1 archivée).

---

## 6. Bus MQTT Unifié

### 6.1 Principe — extension de la v1.0, plus seulement pour le cross-machine

En v1.0, MQTT ne servait qu'au registre de présence et à un relais explicite `emitToMachine()` pour
les cas cross-machine. En v2.0, **MQTT est le bus par défaut pour tout événement générique**, que
les deux applications communicantes soient sur la même machine ou non — il n'y a plus de canal
"in-process" du tout puisque chaque application est déjà un process séparé.

### 6.2 Topics (généralisent §5/§6 de la v1.0)

```
dimotic/supervisor/{machineId}/status              # LWT online/offline + { address, webPort } (v2.1 — voir §7.2)
dimotic/supervisor/{machineId}/apps                # retenu, registre des apps actives sur cette machine
dimotic/supervisor/{machineId}/app/{appId}/event/{eventName}    # ce qu'émettait emitGeneric() avant
dimotic/supervisor/{machineId}/app/{appId}/command/{eventName}  # ce qu'écoutait onGeneric() avant — signé, voir §10
```

**v2.1** : le payload de `.../status` porte en plus `{ address, webPort }` (IP/hostname et port du
serveur Express de cette machine) — nécessaire pour que n'importe quel `core` puisse relayer une
requête HTTP vers celui qui héberge réellement une application donnée (§7.2).

Une application qui veut parler à une autre publie sur son topic `command/`, quelle que soit la
machine qui l'héberge — le registre (§6.4) permet de savoir sur quelle machine publier. Deux
applications sur la **même** machine passent donc, elles aussi, par le broker MQTT local (aller-retour
réseau, même en loopback) — changement réel de comportement par rapport à l'EventBus in-process
actuel (latence légèrement supérieure, jamais mesurée à ce stade, voir §13.2).

### 6.3 `MqttEventBus` — même interface que `EventBus`, implémentation différente

Nouvelle classe dans `core`, implémentant la **même interface `IEventBus`** que l'`EventBus`
actuel (`emit`/`emitGeneric`/`on`/`onGeneric`) mais backée par un client MQTT au lieu d'un
`EventEmitter` Node — c'est ce qui permet à `create*Service(eventBus, ...)` de ne rien changer :
l'application ne sait pas si son `eventBus` est local ou distribué. `emitGeneric(event, data)` publie
sur `.../app/{soi-même}/event/{event}` ; `onGeneric(event, cb)` s'abonne à
`dimotic/supervisor/+/app/+/event/{event}` (wildcard — n'importe quelle application, sur n'importe
quelle machine, peut être à l'origine de l'événement, comme c'était implicitement le cas en
in-process).

### 6.4 Registre de présence — vue live + historique local persisté (v2.3)

Chaque machine s'abonne à `dimotic/supervisor/+/status` et `dimotic/supervisor/+/apps` pour
construire sa vue agrégée — décentralisation par abonnement wildcard, pas de serveur de registre
(inchangé depuis la v1.0).

**Nouveau (v2.3), en réponse à une question utilisateur explicite** ("si jamais une machine entière
venait à manquer, qu'est-ce qu'on peut savoir de ce qui tournait dessus ?") : le retain MQTT résout
déjà la resynchronisation d'une machine qui se reconnecte, **tant que le broker garde son état** —
mais rien ne survit si le broker lui-même perd son retain (redémarrage mosquitto, migration) ou si
la machine observatrice était elle-même hors ligne au moment de la dernière publication d'une autre.

Chaque machine tient donc, en plus de sa vue en mémoire, une **copie locale sur disque** (une entrée
par `machineId` connu, dans `data/core/`) de la dernière publication reçue de chaque autre machine —
mise à jour à chaque message `.../status`/`.../apps` reçu. **Règle de résolution** : c'est
l'horodatage **source** (`updatedAt`, écrit par la machine émettrice au moment de sa publication, pas
l'heure de réception locale) qui détermine quelle entrée est la plus récente — évite tout biais lié à
un décalage d'horloge entre machines. Ce mécanisme ne dépend pas de coordination entre observateurs :
chaque machine écrase simplement sa propre entrée locale dès qu'elle reçoit une publication plus
récente que celle qu'elle avait déjà, jamais de fusion/négociation entre plusieurs copies.

Effet recherché : si `ha2` disparaît totalement, n'importe quelle autre machine survivante peut
répondre "voici la dernière liste d'applications connue pour `ha2`, à telle heure" — sans dépendre de
`ha2` elle-même ni du broker pour retrouver cette information. Extension UI attendue :
`ApplicationsManager.ts` (existant, v1.0 §5.3) affiche déjà, par app, sur quelle(s) machine(s) elle
tourne en live — à compléter pour distinguer une entrée "live" d'une entrée "dernière connue"
(machine hors ligne).

**Question de résilience plus large soulevée en marge de cette discussion** : le broker MQTT partagé
est colocalisé avec HA — sa panne implique presque toujours celle de HA, donc pas la peine de
chercher à rendre MQTT résilient en soi (un broker local par machine + bridge a été envisagé puis
écarté, la panne à mitiger n'est pas "MQTT down" mais "HA down"). Le vrai sujet de résilience à
traiter est **la sauvegarde/duplication de HA lui-même** — hors périmètre de cette spec, suivi
séparément dans `TODO.md`.

### 6.5 Cas d'usage cible : migration d'espdisplay (inchangé, v1.0 §6.2)

`espdisplay` migrerait de son SSH point-à-point vers `emitGeneric('espdisplay:deploy-floorplan',
{...})` tout court — en v2.0, ce n'est plus un cas spécial nécessitant `emitToMachine()` : c'est le
comportement **par défaut** de n'importe quel `emitGeneric`, qu'HAPLAN et ESPDISPLAY soient sur la
même machine ou non.

---

## 7. Interface Web Unifiée

Question explicite de l'utilisateur, en deux temps : (1) comment garder **une seule** interface web
alors que les applications ne partagent plus de process avec `core` ? (2) peut-on voir **toutes les
applications de toutes les machines** sur cette même interface, pas seulement celles de la machine
qu'on visite ?

**Réponse courte à la question (1) : rien ne change côté navigateur.** Express + Socket.io restent
**exclusivement dans `core`** — une seule URL, un seul port (8080), comme aujourd'hui.

**Réponse à la question (2), plus intéressante : c'est déjà presque acquis pour les événements
(§7.1), il manque une pièce pour les fichiers statiques HTML/CSS/JS (§7.2).**

### 7.1 Événements Socket.io — déjà global par construction

⚠️ **Correction apportée en v2.1** : une première version de ce tableau (v2.0) faisait s'abonner
`SocketBridge` uniquement aux événements de **sa propre** machine (`.../{soi}/app/+/...`) — incohérent
avec `MqttEventBus` (§6.3) qui s'abonne déjà, lui, à `+/app/+/...` (toutes les machines). Corrigé :

| | Aujourd'hui | v2.1 |
|---|---|---|
| Serveur → Client | `eventBus.onGeneric(eventName, ...)` (in-process, forcément local) → `io.emit(...)` | `mqttClient.subscribe('dimotic/supervisor/+/app/+/event/{eventName}')` **(wildcard machine — toutes)** → `io.emit(...)` |
| Client → Serveur | `socket.on(eventName, data => eventBus.emitGeneric(eventName, data))` | `socket.on(eventName, data => { const targetMachineId = registre.getMachineForApp(cibleAppId); mqttClient.publish(\`dimotic/supervisor/${targetMachineId}/app/${cibleAppId}/command/${eventName}\`, data); })` — **résolution via le registre agrégé (§6.4)**, plus un `{soi}` supposé à tort |
| Découverte des événements d'une app | `app:socket-events:registered` (in-process, au chargement du module) | Topic retenu `dimotic/supervisor/{machineId}/app/{appId}/socket-events`, **abonné en wildcard `+/app/+/socket-events`** — n'importe quel `core` apprend les événements de n'importe quelle application, où qu'elle tourne |

Conséquence directe : **n'importe quel `core`, sur n'importe quelle machine, voit et relaie déjà les
événements de toutes les applications de toutes les machines** — c'est un sous-produit naturel du bus
MQTT unifié (§6), pas un mécanisme séparé à construire. Le pontage dynamique par convention de
nommage (§2.2) reste inchangé dans son principe.

### 7.2 Assets statiques (HTML/CSS/JS) — la pièce manquante, ajoutée en v2.1

Contrairement aux événements, servir le HTML/CSS/JS d'une application est aujourd'hui une **lecture
disque directe**, jamais passée par le process de l'application (vérifié dans le code réel,
`core/src/presentation/server/index.ts` L211 : `this.app.use('/applications/:appId', (req, res) =>
{ ... res.sendFile(candidate) ... })`, cherche `applications/{appId}/dist|src/{chemin}` sur le
système de fichiers local). Ce mécanisme continue de fonctionner sans changement **tant que
l'application demandée tourne sur la même machine que le `core` visité** — mais rien ne le fait
fonctionner pour une application hébergée ailleurs : ses fichiers ne sont physiquement pas sur ce
disque.

**Solution proposée : proxy HTTP de repli, adossé au registre (§6.4)** — étend le handler existant :

```typescript
this.app.use('/applications/:appId', async (req, res, next) => {
  // ... candidats locaux existants (dist/src) inchangés, res.sendFile() si trouvé ...

  // v2.1 — repli si l'application n'est pas hébergée ici :
  const remote = registre.getMachineForApp(req.params.appId);   // depuis dimotic/supervisor/+/apps
  if (remote && remote.machineId !== monMachineId) {
    const url = `http://${remote.address}:${remote.webPort}${req.originalUrl}`;  // §6.2, payload étendu
    return proxyRequest(url, req, res);   // fetch + pipe de la réponse, ou http-proxy-middleware
  }
  next();  // vraiment introuvable nulle part → 404 normal
});
```

Le navigateur continue de parler **uniquement** au `core` visité, sur une seule URL/port — c'est ce
`core` qui va chercher les fichiers auprès du bon `core` distant en coulisse, de façon transparente.
Aucun changement côté navigateur, aucun changement pour l'application distante elle-même (son `core`
local la sert déjà normalement, comme pour n'importe quel visiteur direct).

### 7.3 Synthèse

Avec §7.1 (déjà acquis par construction du bus MQTT) et §7.2 (proxy de repli, seule pièce réellement
nouvelle), **n'importe quel `core`, sur n'importe quelle machine, peut présenter une interface
complète et unifiée de toutes les applications de toutes les machines** — pas seulement les
siennes. Aucune application ne parle directement à Socket.io, au navigateur, ni au disque d'une autre
machine ; `core` reste le seul traducteur/proxy, comme aujourd'hui pour sa propre machine.

---

## 8. Cycle de Vie et Activation/Désactivation en Direct

### 8.1 Aujourd'hui : redémarrage complet du process (§2.2)

`enable()`/`disable()` basculent `disabledApps` puis programment un redémarrage de **tout** le
process Node 15 secondes plus tard — la seule façon connue de garantir qu'une application arrêtée
ne laisse rien tourner (connexions, listeners) puisque `stop()` ne désabonne pas toujours
proprement tout (limite déjà documentée, ex. HAPLAN).

### 8.2 v2.0 : arrêt/démarrage par process, sans toucher aux autres applications

`disable(appId)` : `supervisor/` envoie `SIGTERM` au PID de cette application précise (grâce period,
`SIGKILL` en repli si elle ne s'arrête pas — pattern standard, celui de systemd/Docker/PM2, et de
l'ancien système de l'utilisateur). Le process meurt, l'OS récupère tout ce qu'il tenait
(sockets, descripteurs de fichiers) — plus besoin que `stop()` soit parfait, la mort du process
nettoie ce qu'un `stop()` incomplet aurait laissé traîner. `enable(appId)` : nouveau `spawn()`, comme
au démarrage normal (§5.3). **Aucun impact sur les autres applications ni sur `core` lui-même** —
c'est le changement concret qui répond à la question initiale de l'utilisateur.

### 8.3 `RestartManager` — toujours utile, périmètre réduit

Reste pertinent pour les changements qui affectent réellement `core` lui-même (ex: modification de
la config `ha.ws`/`ha.mqtt` du socle) — plus nécessaire pour une simple activation/désactivation
d'application, qui devient une opération locale à `supervisor/`.

### 8.4 Politique de redémarrage en cas de crash (v2.2)

Distinct d'une désactivation volontaire (§8.2, `supervisor/` connaît son intention avant d'envoyer
le signal) : un **crash** est une sortie du process qu'il n'a **pas** demandée, quel que soit le
code de sortie.

**Backoff exponentiel, pas de boucle serrée** — redémarrer immédiatement une application qui crashe
en boucle (config cassée, dépendance manquante) brûlerait du CPU et spammerait les journaux sans
jamais réussir. Délai avant chaque nouvelle tentative : `min(1s × 2^tentative, 30s)` — 1s, 2s, 4s,
8s, 16s, puis plafonné à 30s. **Réarmement** : si l'application a tourné plus de **60s** sans
incident avant de recrasher, le compteur de tentatives repart à zéro — un crash après 2h de
fonctionnement normal n'a pas le même degré d'urgence qu'un crash en boucle au démarrage, et ne doit
pas hériter d'un historique d'échecs déjà ancien.

**Abandon après 5 tentatives rapprochées** (sans franchir le seuil de stabilité de 60s ci-dessus) :
`supervisor/` arrête d'insister et passe l'application dans un état terminal `crashed` — pas de
nouvelle tentative automatique, redémarrage **manuel** requis (l'utilisateur ré-active l'application
depuis l'UI, ce qui repart de `starting` avec un compteur de tentatives neuf).

**Machine à états** :
```
stopped ──[enable]──► starting ──► running
running ──[crash]──► attente (backoff) ──► starting ──► running        (boucle, compteur += 1)
running ──[crash après >60s stable]──► attente (backoff, compteur remis à 0) ──► starting ──► running
running ──[disable]──► stopping (SIGTERM) ──► stopped                  (jamais de redémarrage auto)
attente ──[5 tentatives dépassées]──► crashed (terminal, visible UI, ré-activation manuelle requise)
```

**Visibilité** : le registre (§6.2, topic `.../apps`) porte, en plus de `activated`/`disabled`, un
état par application (`running`/`restarting`/`crashed`) — remonté dans `ApplicationsManager.ts`
(§5.3 de la v1.0, déjà prévu pour la visibilité cross-machine) plutôt que de laisser une application
en échec silencieux comme c'est implicitement le cas aujourd'hui (un `stop()`/crash imparfait dans
le process partagé actuel n'est pas forcément visible tant que tout le reste continue de tourner).

---

## 9. Redondances Multi-Instances (rpigpio/rfxcom) — Conception détaillée (v2.3)

### 9.1 Principe retenu : une entité, un seul endroit, responsabilité du paramétreur

Décision utilisateur (15/08/2026) : le système ne tranche pas automatiquement quelle instance
"possède" un appareil quand deux bridges pourraient légitimement le publier — c'est à la personne
qui paramètre de s'assurer qu'un appareil n'est déclaré qu'à un seul endroit. Un contrôle/une
validation pourra être ajouté plus tard, non conçu à ce stade ("on verra").

### 9.2 Collision par défaut partagé — tirage aléatoire, pas de dérivation de machineId

**Changement de décision par rapport à la v1.0/v2.0-v2.2** : celles-ci proposaient de dériver
`bridgeInstance` du `machineId` (§4) par défaut. Remplacé (15/08/2026) par un **tirage aléatoire
suffisamment grand** (ex. 6 chiffres — la probabilité de collision entre la poignée de machines
réellement en jeu est négligeable, paradoxe des anniversaires), **généré une seule fois au premier
démarrage et persisté** dans `data/{app}/config.yaml` — jamais régénéré aux redémarrages suivants
(casserait l'identité des entités déjà connues de HA). Raison du changement : indépendant d'un
hostname qui pourrait lui-même ne pas être unique, plus simple à mettre en œuvre qu'une dérivation.

**Généralisé à tous les modules à bridge**, y compris `rfxcom`, pas seulement aux nouveaux modules
sans défaut existant — les défauts actuels (`rfx_bridge_0001` etc.) restent des chaînes fixes
partagées, donc vulnérables à la même collision par oversight que celle qui a motivé cette
discussion. **Portée du changement** : n'affecte que les configurations générées à neuf — une
instance déjà en production avec son défaut actuel écrit en dur sur disque garde cette valeur tant
que personne n'y touche manuellement (pas une migration rétroactive).

**Cas particulier découvert en vérifiant le code réel (15/08/2026) : `rpigpio` n'a aucun
`bridgeInstance`.** Contrairement à rfxcom/evoo7/arexx, `rpigpio` ne passe jamais par les
conventions du socle (`getStateTopic()`/`getCommandTopic()`/`discovery.ts` — voir
`techniques-socle-ha-mqtt_specs` §8.5) : sa découverte HA est produite directement par le processus
externe **mqtt-io** (déployé à distance, hors de notre code), via un `topicPrefix`/`discoveryPrefix`
fixe et identique sur toute machine (`mqttio/rpigpio` / `homeassist`,
`applications/rpigpio/src/domain/config-schema.ts`). Deux machines rpigpio non reconfigurées à la
main collisionnent donc déjà aujourd'hui, réellement, pas hypothétiquement. **À faire** : donner à
`rpigpio` un vrai `bridgeInstance` (même tirage aléatoire persisté que les autres modules), l'injecter
dans le `topic_prefix`/`ha_discovery` généré pour mqtt-io (`applications/rpigpio/src/domain/generator.ts`,
fonction `generateMqttIoConfig`) au lieu du préfixe fixe actuel.

### 9.3 Topic de découverte MQTT — `bridgeInstance` en `node_id`

Problème distinct (déjà suivi séparément dans `TODO.md`, priorité 🔴 Haute avant cette discussion) :
même avec des `bridgeInstance` bien distincts, le topic de découverte HA
(`homeassistant/{component}/{objectId}/config`, `getDiscoveryTopic()` du socle) **n'embarque pas**
`bridgeInstance` — seul `objectId`. Si deux bridges publient un jour pour le même `objectId` (voir
§9.4 ci-dessous pour le cas RF), le dernier à publier écrase silencieusement le message de découverte
du précédent (y compris son `command_topic`/`state_topic`), sans que rien ne signale côté HA quelle
instance "possède" réellement l'entité.

**Tranché (15/08/2026)** : `bridgeInstance` devient le segment `node_id` optionnel du format de
découverte HA (`homeassistant/{component}/[node_id/]object_id/config`, supporté nativement, pas de
rupture de protocole) — `homeassistant/{component}/{bridgeInstance}/{objectId}/config`. À implémenter
dans `discovery.ts` (socle), impacte tous les modules qui publient une découverte via ce mécanisme
(rfxcom, evoo7, nommage — pas rpigpio, qui ne passe pas par lui, voir §9.2).

### 9.4 RFXCOM — recouvrement RF réel, visibilité par diffusion (nouveau, v2.3)

Cas distinct de la collision par défaut partagé (§9.2) : deux dongles RFXCOM sur deux machines ont
de très bonnes chances de recevoir le **même** signal RF pour un même appareil physique (la RF ne
respecte aucune frontière machine) — pas une erreur de configuration, une conséquence physique
normale. Décision utilisateur : ça doit rester pris en compte à **un seul endroit**, mais de façon
visible plutôt que par une résolution automatique opaque.

**Mécanisme retenu** :
- Nouveau topic retenu par instance : `rfxcom/{bridgeInstance}/registered-devices` — liste JSON des
  identifiants de devices enregistrés sur cette instance, republiée à chaque ajout/retrait.
- Chaque instance RFXCOM s'abonne à `rfxcom/+/registered-devices` (toutes les autres instances) et
  construit localement l'ensemble "déjà revendiqué ailleurs".
- Avant de publier une découverte pour un device, vérification : son identifiant apparaît-il dans la
  liste d'une **autre** instance ? Si oui, la découverte n'est **pas** publiée depuis celle-ci.
- **Pas une exclusion silencieuse** : un avertissement visible est affiché dans le tableau de bord
  RFXCOM ("ce device est déjà revendiqué par l'instance X") — cohérent avec le principe §9.1
  (responsabilité du paramétreur, qui doit pouvoir *voir* le conflit, pas juste le subir sans
  explication).

**Indépendant de cette refonte superviseur** : RFXCOM est déjà connecté au broker MQTT partagé
aujourd'hui — ce mécanisme est implémentable dès maintenant, sans attendre le reste de
l'architecture v2.x.

### 9.5 Cas non concernés

- **`rpigpio`** : pas de recouvrement physique possible (GPIO local à la machine, contrairement à la
  RF) — seule la collision par défaut partagé (§9.2) le concerne.
- **Zigbee (nommage)** : déjà résolu structurellement — chaque source a son propre `topicPrefix`
  (`applications/nommage/src/domain/config-schema.ts`, `sources[]`), donc deux clés zigbee
  distinctes obtiennent naturellement deux préfixes de topics différents, sans nouveau travail.
- **Dédoublonnage RF cross-machine** (savoir si deux dongles ont vraiment vu le *même* événement RF,
  au-delà de la simple visibilité de qui l'a enregistré) reste hors scope — voir §12.2.

---

## 10. Sécurité — Canal de Commandes Signé

Constat inchangé (v1.0 §8) : les deux brokers observés (`ha2`, `stfort`) sont en accès anonyme, sans
authentification. **Plus pressant qu'en v1.0** : le bus MQTT ne porte plus seulement un registre de
présence et un relais cross-machine ponctuel, il porte **tout événement inter-application, y compris
intra-machine** — la surface exposée sans authentification est bien plus large.

**Tranché (15/08/2026)** : pas d'authentification au niveau du broker lui-même (resterait anonyme),
ni de TLS — décision explicite de rester léger, notamment pour les machines contraintes (§11). À la
place, **signature du canal de commandes** (`.../app/{appId}/command/{event}`, §6.2, et le canal de
commandes de l'agent minimal, §11) : HMAC à clé partagée (secret commun distribué à toutes les
machines légitimes), pas de paire clé publique/privée par machine — plus léger à calculer et à
distribuer, suffisant pour garantir qu'une commande reçue est légitime sans avoir besoin de savoir
précisément *qui* parmi les machines autorisées l'a émise. **Portée volontairement limitée aux
commandes** — état/présence non signés (une fausse trame d'état est gênante, pas dangereuse comme une
fausse commande ; signer aussi l'état serait plus coûteux pour un bénéfice moindre).

**Reste à définir avant implémentation** : mécanisme de distribution/rotation du secret partagé —
hors périmètre de cette spec de conception.

---

## 11. Agent Minimal pour Machines Contraintes

### 11.1 Contexte

Certaines machines (ex: RPi1/`teleinfo`, ARMv6/Node12) ne peuvent pas faire tourner la stack
moderne du socle (`standalone.ts`/`MqttEventBus`/TypeScript Project References) — matériel/runtime
trop ancien. La v2.2 excluait explicitement ce cas du périmètre (§11.2 de cette version-là, devenue
§12.2 ici). Réouvert (15/08/2026) : le vrai besoin exprimé n'est pas de porter le socle complet sur
ce matériel (impossible), mais de donner à ces machines une visibilité minimale dans le registre
(§6.4) sans rien réécrire de leur code existant.

### 11.2 Scope retenu — délibérément modeste

Décision utilisateur explicite ("restons modeste sur ces machines") : pas d'agent générique de type
RPC, pas d'exécution de commande arbitraire (shell). Deux capacités seulement :

1. **Présence** ("je suis là") : publication du même contrat minimal que les machines complètes —
   `dimotic/supervisor/{machineId}/status` (LWT online/offline) et `.../apps` — une app déjà
   connectée à MQTT (comme `teleinfo` l'est déjà) n'a qu'à ajouter ces deux publications, sans porter
   le reste de l'architecture.
2. **Commandes nommées, liste fermée** : réception d'une commande et retour d'un résultat corrélé,
   mais uniquement parmi un **jeu de commandes prédéfini par l'application elle-même** (ex. pour
   `teleinfo` : "redémarre le service", "renvoie la dernière trame reçue", "renvoie ton statut") —
   jamais "exécute cette chaîne arbitraire". Même principe que la commande forcée déjà en place pour
   la clé SSH d'`espdisplay` vers `falbala` (`fonctionnelles-espdisplay_specs` §6.3) : périmètre
   strictement whitelisté, pas un canal ouvert.

### 11.3 Sécurité

Le canal de commandes de l'agent suit la même règle que §10 : signature HMAC à clé partagée,
périmètre limité aux commandes (pas à la présence).

### 11.4 Hors scope de cette section

- Écrire un "agent" générique réutilisable tel quel par n'importe quelle app contrainte — chaque app
  définit son propre jeu de commandes, pas de framework d'agent partagé conçu ici.
- Migrer `teleinfo`/`rpigpio` déployés en Docker séparé vers l'architecture standalone du socle
  (§5) — reste un modèle de déploiement distinct, cette section ne fait qu'ajouter de la visibilité
  par-dessus, sans rien changer à leur fonctionnement interne.

---

## 12. Idées Complémentaires et Hors Scope

### 12.1 Idées complémentaires

- Capacités machine dans le registre (inchangé, v1.0 §9.1).
- Heartbeat/santé au-delà du online/offline binaire (inchangé, v1.0 §9.1).
- ~~Politique de redémarrage par application~~ — **formalisée en §8.4 (v2.2)**, n'est plus une idée
  ouverte.
- **Limites de ressources par process** (nouveau, v2.0) : `child_process.spawn` permet en principe
  de contraindre chaque application (ex: cgroups) — non nécessaire vu les chiffres §2.4, mais
  disponible si un jour une application spécifique consomme anormalement.

### 12.2 Explicitement hors scope

- Authentification/TLS au niveau du broker lui-même — écarté au profit de la signature du canal de
  commandes (§10), pas juste "pas encore implémenté".
- Dédoublonnage RF cross-machine pour RFXCOM (§9.4) — la visibilité/exclusion par diffusion n'est pas
  une vraie déduplication de l'événement RF physique lui-même.
- Framework d'agent générique réutilisable (§11.4).

---

## 13. Plan de Mise en Œuvre

**Aucune implémentation dans cette version** — décision explicite de l'utilisateur, "nous y
reviendrons". Cette spec sert de référence pour une session ultérieure.

### 13.1 Prérequis avant le passage à cette architecture (v2.3, 15/08/2026)

Liste consolidée des chantiers identifiés comme nécessaires ou fortement recommandés **avant** de
commencer l'implémentation du superviseur lui-même — certains sont indépendants et peuvent démarrer
dès maintenant, d'autres sont des décisions encore à finaliser :

1. **Sauvegarde/duplication de HA lui-même** — le vrai point de dépendance critique du système
   (§6.4), pas MQTT. Suivi comme chantier séparé dans `TODO.md`, à concevoir avant de compter sur le
   superviseur pour quoi que ce soit de critique.
2. **Topic de découverte MQTT avec `node_id`** (§9.3) — changement dans `discovery.ts` du socle,
   indépendant du superviseur, impacte rfxcom/evoo7/nommage.
3. **`bridgeInstance` par tirage aléatoire persisté**, généralisé à tous les modules à bridge, y
   compris donner ce concept à `rpigpio` qui ne l'a pas du tout aujourd'hui (§9.2) — inclut
   d'adapter `generator.ts` de rpigpio pour injecter ce `bridgeInstance` dans la config mqtt-io
   générée.
4. **RFXCOM : diffusion de la liste des devices enregistrés + avertissement UI** (§9.4) —
   implémentable dès maintenant, indépendant du reste.
5. **Mécanisme de signature HMAC du canal de commandes** (§10) — inclut de décider comment le secret
   partagé est distribué/tourné, pas encore conçu.
6. **Définir le jeu de commandes fermé par app contrainte**, en commençant par `teleinfo` (§11.2) —
   préalable concret à tout agent minimal.
7. **Mesurer la latence réelle d'un aller-retour MQTT en loopback** pour la communication
   intra-machine (§13.2 ci-dessous, jamais mesurée) — pourrait remettre en cause le choix "MQTT pour
   tout, même intra-machine" si elle s'avère problématique pour des échanges très fréquents.

### 13.2 Point d'attention initial (inchangé depuis v2.0)

Point d'attention à vérifier en premier lors de l'implémentation : la latence réelle d'un
aller-retour MQTT en loopback pour de la communication intra-machine (jamais mesurée à ce stade,
§6.2) — si elle s'avère un problème pour des échanges très fréquents, prévoir un repli local (ex:
MQTT bridge loopback court-circuité) plutôt que de renoncer au modèle.

---

## 14. Phase 1 — Bilan d'implémentation (⭐ nouveau v2.5, 16/08/2026)

Première application migrée : `espdisplay`. Implémenté et vérifié en conditions réelles (broker
MQTT de production, `falbala`) — pas un test isolé. Ce qui suit documente ce qui a réellement été
construit, deux vrais problèmes trouvés en testant (pas anticipés en conception), et deux
décisions prises pendant l'implémentation, absentes de la conception v2.3/v2.4.

### 14.1 Ce qui a été construit

- **`core.machineId`** : nouveau champ Zod (`infrastructure/config/schema.ts`), défaut
  `os.hostname()`.
- **`MqttEventBus`** (`application/MqttEventBus.ts`) : implémente `IEventBus` intégralement (typé +
  générique), sur une connexion `MqttTransport` dédiée. Topics conformes à §6.2. **Livraison locale
  synchrone en plus de la publication MQTT** (`emitGeneric()`) — nécessaire pour qu'un process qui
  émet et écoute son propre événement se comporte comme `EventBus` (`EventEmitter`), trouvé en
  écrivant la suite de tests de contrat (voir plus bas), pas anticipé en conception.
- **Suite de tests de contrat** (`EventBus.contract.test.ts`, nouvelle — aucune n'existait pour
  `IEventBus` avant) : même jeu de tests exécuté contre `EventBus` et `MqttEventBus`. A trouvé le
  défaut de livraison locale ci-dessus avant tout test manuel.
- **`applications/core/src/supervisor/`** : `ProcessSupervisor` (spawn/kill/backoff, §8.4 codé pour
  la première fois) + `SupervisorEventBridge` (pont EventBus local ↔ MQTT, anti-boucle structurel —
  un registre interne "en cours d'injection", pas un flag sur le payload).
- **`runsAsSeparateProcess`** (nouveau champ `ApplicationModule`, distinct de `type`) +
  **`bridgedEvents`** (nouveau champ, liste des événements génériques à ponter — `ESPDISPLAY_APP`
  n'a pas de `socketEvents` Socket.io, ces deux mécanismes sont distincts).
- **`applications/espdisplay/src/standalone.ts`** : bootstrap autonome, factory `createEspDisplayServiceWithConfig`
  existante réutilisée telle quelle.
- **Commandes MQTT start/stop/restart** (§14.3 ci-dessous — décision prise en cours de route, hors
  conception initiale).
- **`machineId` exposé côté client** (`app:machine-id`, événement persistant) — juste exposé, pas
  encore affiché sur chaque écran d'application (reste à faire au fil de l'eau, comme prévu).

### 14.2 Deux problèmes réels trouvés en testant

1. **Process orphelins au redémarrage de `core`** — `child_process.spawn()` ne meurt pas
   automatiquement avec son parent ; `core` (sous `tsx watch`, qui redémarre à chaque modification
   de fichier) laissait un `espdisplay` orphelin à chaque cycle — jusqu'à 5 process accumulés
   constatés en conditions réelles. Corrigé à deux niveaux : `AppService.stopAllSeparateProcesses()`
   appelée par `ApplicationBootstrap.stop()` (arrêt propre, SIGTERM/SIGINT) + un filet `process.on('exit', ...)`
   dans `ProcessSupervisor` lui-même (arrêt moins propre, ex. signal externe). Aucune trace de ce
   problème dans la conception v2.0-v2.4 — le "un process par app" n'avait jamais été poussé jusqu'à
   ce détail de cycle de vie.
2. **`app:menu:register` n'a jamais été relayé côté socle** — découvert en cherchant comment ponter
   cet événement : `SocketBridge.ts` ne le déclare dans aucun `*_SOCKET_EVENTS`, pour **aucune**
   application (pas seulement `espdisplay`) — le mécanisme "menu dynamique" de `Sidebar.ts` (event
   `app:menu:register` sur le socket) semble mort depuis l'origine, le menu réel provenant de
   `app:modules:list` (scan statique, indépendant du démarrage du service). **Préexistant, sans
   rapport avec cette migration** — non corrigé ici (hors périmètre), signalé dans `TODO.md`.
   L'événement reste ponté par précaution (inoffensif), mais ne doit pas servir de test de bout en
   bout pour une future migration : utiliser `app:modules:list`, qui fonctionne réellement.

### 14.3 Deux décisions prises pendant l'implémentation

- **Commandes MQTT start/stop/restart généralisées à toute app `runsAsSeparateProcess`**, pas
  réservées à l'agent minimal des machines contraintes (§11) — demande explicite reformulée en
  cours de route : "chaque machine pourrait recevoir des commandes de start/stop/restart". Topic
  `dimotic/supervisor/{machineId}/app/{appId}/command/lifecycle`, `{action: 'start'|'stop'|'restart'}`.
  Testé en direct via `mosquitto_pub` — fonctionne dans les deux sens.
- **Aucune signature/authentification sur ce canal de commandes pour cette phase** — clarifié en
  cours de route : l'authentification obligatoire viendra du broker mosquitto lui-même (sujet
  séparé, pas une signature applicative comme le proposait §10). §10 de cette spec reste donc à
  jour comme *décision*, mais son *implémentation* n'a pas eu lieu dans cette phase et le sujet
  broker reste ouvert.

### 14.4 Vérifié en conditions réelles

Build + suite de tests core propres (124/125, 1 échec préexistant sans rapport). Événement
cross-process réel testé (simulation d'un ordre HAPLAN via `mosquitto_pub` directement sur le topic
`event/espdisplay:deploy-floorplan`) — reçu et traité par `EspDisplayService` dans le process séparé
(déclenchement réel du pipeline de déploiement, confirmé par les logs). Backoff de crash observé en
conditions réelles (un arrêt externe non voulu classé crash, tentative avec délai, réussie).
Commandes MQTT `stop`/`start` testées individuellement, effet confirmé sur le process réel à chaque
fois. Plus aucun orphelin après plusieurs cycles de redémarrage de `core`.

## 15. Annexes

### 15.1 Références
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.30.md) ⭐
- [Spécifications Fonctionnelles ESPDISPLAY](fonctionnelles-espdisplay_specs_v1.1.md) (§6.3, cas
  d'usage cible de la migration SSH → bus MQTT unifié, et précédent pour la commande forcée
  whitelisté reprise en §11.2)
- [Communication Inter-Applications](inter-app-communication_specs_v1.0.md)
- `fonctionnelles-supervisor_specs_v2.2.md` (archivée) — avant la conception détaillée des
  redondances, la décision de sécurité concrète et l'agent minimal
- `fonctionnelles-supervisor_specs_v1.0.md` (archivée) — première mouture, cross-machine seulement
- Mémoire de session `project_multi_machine_supervision_prior_art` (23/07/2026 puis 15/08/2026) :
  système de supervision maison antérieur (PID+signaux, ~2015) — le **mécanisme** (process
  individuellement supervisables) est repris en v2.0, jamais le code lui-même.
- `TODO.md` — chantiers dérivés de cette discussion suivis en dehors de cette spec (sauvegarde HA,
  bridgeInstance/rpigpio, diffusion RFXCOM).

### 15.2 Glossaire
| Terme | Définition |
|-------|------------|
| `machineId` | Identité d'une instance de la plateforme (une par machine physique), défaut = hostname |
| `MqttEventBus` | Implémentation de `IEventBus` backée par MQTT plutôt qu'un `EventEmitter` local — même interface, apps inchangées |
| `standalone.ts` | Nouveau point d'entrée par application (à côté de `domain/index.ts`), auto-suffisant : lit sa config, construit son `MqttEventBus`, appelle `create*Service()` |
| Registre agrégé | Vue locale, reconstruite par abonnement MQTT wildcard, de toutes les machines/applications/événements disponibles, complétée (v2.3) d'une copie locale persistée horodatée |
| Agent minimal | Publication du contrat de présence + un jeu fermé de commandes nommées, sans porter le reste de la stack — pour machines contraintes (§11) |

### 15.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 2.4 | 2026-08-16 | Claude | Correction de référence croisée uniquement (`techniques-socle-ha-mqtt_specs` v4.29→v4.30, §8.5.4ter rejet des commandes MQTT retenues). Aucun changement de contenu propre à cette spec. Ancienne version v2.3 archivée. |
| 2.5 | 2026-08-16 | Claude | **⭐ Phase 1 implémentée et vérifiée en conditions réelles** (§14, nouvelle) : `espdisplay` migrée en process séparé (`MqttEventBus`, `ProcessSupervisor`, `SupervisorEventBridge`, `standalone.ts`). Deux problèmes réels trouvés en testant : process orphelins au redémarrage de `core` (corrigé, `stopAllSeparateProcesses()` + filet `process.on('exit')`), `app:menu:register` jamais relayé côté socle pour aucune app (préexistant, non corrigé ici, signalé dans `TODO.md`). Deux décisions prises en cours de route : commandes MQTT start/stop/restart généralisées à toute app séparée (pas réservées à l'agent minimal §11), aucune signature sur ce canal pour cette phase (authentification prévue au niveau du broker mosquitto, sujet séparé). Ancienne version v2.4 archivée. |
| 2.3 | 2026-08-15 | Claude | Discussion approfondie, point par point, avant implémentation. **§6.4 étendue** : persistance locale horodatée du registre par machine (résilience si le broker perd son retain), horodatage source fait foi. **§9 entièrement réécrite** : principe "une entité, un endroit, responsabilité du paramétreur" ; `bridgeInstance` par défaut passe de "dérivé du machineId" à un tirage aléatoire persisté, généralisé à tous les modules à bridge ; `rpigpio` découvert sans aucun `bridgeInstance` (passe par mqtt-io externe, collision réelle aujourd'hui) ; `node_id`=`bridgeInstance` tranché pour le topic de découverte (rejoint l'item 🔴 Haute de `TODO.md`) ; nouveau mécanisme RFXCOM de diffusion des devices enregistrés + avertissement UI pour le recouvrement RF réel. **§10 réécrite** : décision concrète de signature HMAC du canal de commandes (clé partagée), authentification broker/TLS explicitement écartée. **§11 nouvelle** : Agent Minimal pour Machines Contraintes (ARMv6/teleinfo) — referme le hors-scope de la v2.2, scope délibérément modeste (présence + commandes nommées fermées, même principe que la commande forcée SSH d'espdisplay). **§13.1 nouvelle** : liste consolidée de 7 prérequis avant implémentation. Ancienne version v2.2 archivée. |
| 2.2 | 2026-08-15 | Claude | **Politique de redémarrage en cas de crash** (§8.4, nouvelle) : backoff exponentiel (1s→30s plafond), réarmement du compteur de tentatives après 60s de fonctionnement stable, abandon après 5 tentatives rapprochées (état terminal `crashed`, redémarrage manuel). Machine à états explicite, registre étendu d'un statut par application (`running`/`restarting`/`crashed`). Discutée puis validée avec l'utilisateur avant rédaction. Ancienne version v2.1 archivée. |
| 2.1 | 2026-08-15 | Claude | **§7 réécrite** en réponse à une question directe de l'utilisateur ("voir toutes les applis de toutes les machines sur la même interface web ?"). Corrige une incohérence de la v2.0 (pontage Socket.io limité à sa propre machine, alors que le bus MQTT lui-même était déjà global) — §7.1. Ajoute le proxy HTTP de repli pour les fichiers statiques d'une application distante — §7.2, seule pièce manquante puisque le service de fichiers ne passe jamais par le process de l'application. Registre étendu (`address`/`webPort` dans le payload de présence, §6.2). Ancienne version v2.0 archivée. |
| 2.0 | 2026-08-15 | Claude | **Refonte complète** : une application = un process OS (au lieu d'un seul process partagé), MQTT comme bus unifié intra+inter-machine (au lieu de cross-machine seulement), activation/désactivation d'application en direct par signal (résout le redémarrage complet actuel, jusque-là hors scope), interface web unique préservée (§7, Express/Socket.io restent dans `core`, seule la source du pontage change). Motivé par une mesure réelle sur `ha2` écartant la crainte de surcoût mémoire par process (§2.4). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-15 | Claude | Première spécification — conception validée avec l'utilisateur, aucun code écrit. Couvre l'identité machine, la visibilité décentralisée (présence + registre d'apps par MQTT), le relais de commandes inter-machines (cas cible : migration d'espdisplay hors SSH), le traitement des redondances rpigpio/rfxcom, et un constat de sécurité explicite sur l'absence d'authentification des brokers MQTT observés. |
