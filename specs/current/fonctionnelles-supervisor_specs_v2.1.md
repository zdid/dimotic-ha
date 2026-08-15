# Spécifications Fonctionnelles - Supervision Multi-Machines (SUPERVISOR)

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
7. [Interface Web Unifiée](#7-interface-web-unifiée)
    - 7.1 [Événements Socket.io — déjà global par construction](#71-événements-socketio--déjà-global-par-construction)
    - 7.2 [Assets statiques (HTML/CSS/JS) cross-machine](#72-assets-statiques-htmlcssjs--la-pièce-manquante-ajoutée-en-v21)
8. [Cycle de Vie et Activation/Désactivation en Direct](#8-cycle-de-vie-et-activationdésactivation-en-direct)
9. [Redondances Multi-Instances (rpigpio/rfxcom)](#9-redondances-multi-instances-rpigpiorfxcom)
10. [Sécurité — Broker MQTT Anonyme](#10-sécurité--broker-mqtt-anonyme)
11. [Idées Complémentaires et Hors Scope](#11-idées-complémentaires-et-hors-scope)
12. [Plan de Mise en Œuvre](#12-plan-de-mise-en-œuvre)
13. [Annexes](#13-annexes)

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
  redémarrage du core), et la question explicite de l'utilisateur sur le maintien d'une interface
  web unique (§7).
- **Exclu** : toute implémentation de code (spec de conception uniquement), authentification MQTT
  (documentée comme risque, plus pressant qu'en v1.0 — voir §10).

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
- Conventions MQTT déjà standardisées (`techniques-socle-ha-mqtt_specs_v4.28` §8.5) : topics
  `{moduleName}/{bridgeInstance}/{deviceId}/state|set`, LWT par bridge (retain, QoS 1), un seul
  broker MQTT partagé (`ha.mqtt`). `bridgeInstance` est par instance d'application, jamais dérivé
  d'une identité machine.

### 2.4 ⭐ Mesure réelle du surcoût mémoire (nouveau, 15/08/2026)

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
défaut `os.hostname()`. `bridgeInstance` des applications matérielles dérivé de ce `machineId` par
défaut (`{appId}_{machineId}` plutôt qu'un défaut fixe partagé).

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
dimotic/supervisor/{machineId}/app/{appId}/command/{eventName}  # ce qu'écoutait onGeneric() avant
```

**v2.1** : le payload de `.../status` porte en plus `{ address, webPort }` (IP/hostname et port du
serveur Express de cette machine) — nécessaire pour que n'importe quel `core` puisse relayer une
requête HTTP vers celui qui héberge réellement une application donnée (§7.2).

Une application qui veut parler à une autre publie sur son topic `command/`, quelle que soit la
machine qui l'héberge — le registre (§6.3) permet de savoir sur quelle machine publier. Deux
applications sur la **même** machine passent donc, elles aussi, par le broker MQTT local (aller-retour
réseau, même en loopback) — changement réel de comportement par rapport à l'EventBus in-process
actuel (latence légèrement supérieure, jamais mesurée à ce stade, voir §12).

### 6.3 `MqttEventBus` — même interface que `EventBus`, implémentation différente

Nouvelle classe dans `core`, implémentant la **même interface `IEventBus`** que l'`EventBus`
actuel (`emit`/`emitGeneric`/`on`/`onGeneric`) mais backée par un client MQTT au lieu d'un
`EventEmitter` Node — c'est ce qui permet à `create*Service(eventBus, ...)` de ne rien changer :
l'application ne sait pas si son `eventBus` est local ou distribué. `emitGeneric(event, data)` publie
sur `.../app/{soi-même}/event/{event}` ; `onGeneric(event, cb)` s'abonne à
`dimotic/supervisor/+/app/+/event/{event}` (wildcard — n'importe quelle application, sur n'importe
quelle machine, peut être à l'origine de l'événement, comme c'était implicitement le cas en
in-process).

### 6.4 Registre de présence (inchangé dans le principe, v1.0 §5)

Chaque machine s'abonne à `dimotic/supervisor/+/status` et `dimotic/supervisor/+/apps` pour
construire sa vue agrégée — décentralisation par abonnement wildcard, pas de serveur de registre.

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

---

## 9. Redondances Multi-Instances (rpigpio/rfxcom)

Inchangé depuis la v1.0 (§7) : collision de configuration résolue par le `bridgeInstance` dérivé du
`machineId` (§4) + détection dans le registre agrégé ; doublon physique/RF documenté comme limite
connue, non résolu ; `rpigpio` non concerné (GPIO local, pas de partage radio).

---

## 10. Sécurité — Broker MQTT Anonyme

Constat inchangé (v1.0 §8) : les deux brokers observés (`ha2`, `stfort`) sont en accès anonyme, sans
authentification. **Plus pressant qu'en v1.0** : le bus MQTT ne porte plus seulement un registre de
présence et un relais cross-machine ponctuel, il porte **tout événement inter-application, y compris
intra-machine** — la surface exposée sans authentification est bien plus large. Recommandation
inchangée (authentification MQTT minimale avant tout déploiement réel, ou a minima validation stricte
par application de ce qu'elle accepte d'exécuter), mais son urgence augmente avec ce changement de
périmètre.

---

## 11. Idées Complémentaires et Hors Scope

### 11.1 Idées complémentaires

- Capacités machine dans le registre (inchangé, v1.0 §9.1).
- Heartbeat/santé au-delà du online/offline binaire (inchangé, v1.0 §9.1).
- **Politique de redémarrage par application** (nouveau, v2.0) : si un process d'application crashe
  seul (pas une désactivation volontaire), `supervisor/` pourrait le relancer automatiquement
  (backoff, comme `restart: unless-stopped` de Docker mais au niveau process) — désormais possible
  puisque chaque application est individuellement supervisable, alors qu'aujourd'hui un crash
  logique dans une app peut potentiellement affecter tout le process partagé.
- **Limites de ressources par process** (nouveau, v2.0) : `child_process.spawn` permet en principe
  de contraindre chaque application (ex: cgroups) — non nécessaire vu les chiffres §2.4, mais
  disponible si un jour une application spécifique consomme anormalement.

### 11.2 Explicitement hors scope

- Authentification MQTT elle-même (§10) — documentée comme prérequis probable, pas implémentée ici.
- Dédoublonnage RF cross-machine pour RFXCOM (§9).
- Migration des applications déjà en Docker séparé (`teleinfo`/`device-agent`, RPi1 ARMv6) — hors
  périmètre, déjà un modèle de déploiement distinct.

---

## 12. Plan de Mise en Œuvre

**Aucune implémentation dans cette version** — décision explicite de l'utilisateur, "nous y
reviendrons". Cette spec sert de référence pour une session ultérieure. Point d'attention à vérifier
en premier lors de l'implémentation : la latence réelle d'un aller-retour MQTT en loopback pour de
la communication intra-machine (jamais mesurée à ce stade, §6.2) — si elle s'avère un problème pour
des échanges très fréquents, prévoir un repli local (ex: MQTT bridge loopback court-circuité) plutôt
que de renoncer au modèle.

---

## 13. Annexes

### 13.1 Références
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.28.md) ⭐
- [Spécifications Fonctionnelles ESPDISPLAY](fonctionnelles-espdisplay_specs_v1.1.md) (§6.3, cas
  d'usage cible de la migration SSH → bus MQTT unifié)
- [Communication Inter-Applications](inter-app-communication_specs_v1.0.md)
- `fonctionnelles-supervisor_specs_v1.0.md` (archivée) — première mouture, cross-machine seulement
- Mémoire de session `project_multi_machine_supervision_prior_art` (23/07/2026 puis 15/08/2026) :
  système de supervision maison antérieur (PID+signaux, ~2015) — le **mécanisme** (process
  individuellement supervisables) est repris en v2.0, jamais le code lui-même.

### 13.2 Glossaire
| Terme | Définition |
|-------|------------|
| `machineId` | Identité d'une instance de la plateforme (une par machine physique), défaut = hostname |
| `MqttEventBus` | Implémentation de `IEventBus` backée par MQTT plutôt qu'un `EventEmitter` local — même interface, apps inchangées |
| `standalone.ts` | Nouveau point d'entrée par application (à côté de `domain/index.ts`), auto-suffisant : lit sa config, construit son `MqttEventBus`, appelle `create*Service()` |
| Registre agrégé | Vue locale, reconstruite par abonnement MQTT wildcard, de toutes les machines/applications/événements disponibles |

### 13.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 2.1 | 2026-08-15 | Claude | **§7 réécrite** en réponse à une question directe de l'utilisateur ("voir toutes les applis de toutes les machines sur la même interface web ?"). Corrige une incohérence de la v2.0 (pontage Socket.io limité à sa propre machine, alors que le bus MQTT lui-même était déjà global) — §7.1. Ajoute le proxy HTTP de repli pour les fichiers statiques d'une application distante — §7.2, seule pièce manquante puisque le service de fichiers ne passe jamais par le process de l'application. Registre étendu (`address`/`webPort` dans le payload de présence, §6.2). Ancienne version v2.0 archivée. |
| 2.0 | 2026-08-15 | Claude | **Refonte complète** : une application = un process OS (au lieu d'un seul process partagé), MQTT comme bus unifié intra+inter-machine (au lieu de cross-machine seulement), activation/désactivation d'application en direct par signal (résout le redémarrage complet actuel, jusque-là hors scope), interface web unique préservée (§7, Express/Socket.io restent dans `core`, seule la source du pontage change). Motivé par une mesure réelle sur `ha2` écartant la crainte de surcoût mémoire par process (§2.4). Ancienne version v1.0 archivée. |
| 1.0 | 2026-08-15 | Claude | Première spécification — conception validée avec l'utilisateur, aucun code écrit. Couvre l'identité machine, la visibilité décentralisée (présence + registre d'apps par MQTT), le relais de commandes inter-machines (cas cible : migration d'espdisplay hors SSH), le traitement des redondances rpigpio/rfxcom, et un constat de sécurité explicite sur l'absence d'authentification des brokers MQTT observés. |
