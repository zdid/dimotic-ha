# Spécifications Fonctionnelles - Supervision Multi-Machines (SUPERVISOR)

*Version 1.0 - 15 Août 2026*
*Première spécification — conception validée avec l'utilisateur (14-15/08/2026), **aucun code
écrit à ce stade**. Document de référence pour une implémentation future ("nous y reviendrons").*

---

## 📌 Table des Matières
1. [Introduction](#1-introduction)
2. [Faits Vérifiés (état actuel du code)](#2-faits-vérifiés-état-actuel-du-code)
3. [Architecture Proposée](#3-architecture-proposée)
4. [Identité Machine](#4-identité-machine)
5. [Visibilité Décentralisée](#5-visibilité-décentralisée)
6. [Relais de Commandes Inter-Machines](#6-relais-de-commandes-inter-machines)
7. [Redondances Multi-Instances (rpigpio/rfxcom)](#7-redondances-multi-instances-rpigpiorfxcom)
8. [Sécurité — Broker MQTT Anonyme](#8-sécurité--broker-mqtt-anonyme)
9. [Idées Complémentaires et Hors Scope](#9-idées-complémentaires-et-hors-scope)
10. [Plan de Mise en Œuvre](#10-plan-de-mise-en-œuvre)
11. [Annexes](#11-annexes)

---

## 1. Introduction

### 1.1 Origine du besoin

Chaque machine (`ha2`, `orangepi`, une machine de dev "falbala"…) fait tourner aujourd'hui sa
propre instance complète et **totalement isolée** de la plateforme — aucune machine ne sait qu'une
autre existe, ni quelles applications y tournent. Deux problèmes concrets, rencontrés dans la même
session (13-15/08/2026), en découlent directement :

1. **`espdisplay`** a dû mettre en place un accès SSH point-à-point (clé dédiée, commande forcée)
   pour déléguer son pipeline de compilation ESPHome à `falbala` depuis `ha2` — faute d'un
   mécanisme générique de communication inter-machines, chaque nouveau besoin de ce type
   nécessiterait de refaire le même bricolage.
2. **Rien n'empêche** aujourd'hui deux machines de faire tourner la même application matérielle
   (`rpigpio`, `rfxcom`) avec une configuration qui se marche dessus (même `bridgeInstance` par
   défaut sur les deux, par exemple), sans que personne ne le voie avant que ça casse en pratique.

### 1.2 Décision de conception

Système **neuf et décentralisé** — pas de machine centrale, pas de serveur de registre séparé.
Chaque machine :
- publie sa propre présence et la liste de ses applications actives sur le broker MQTT déjà partagé
  par toute la plateforme (`ha.mqtt`, voir `techniques-socle-ha-mqtt_specs`) ;
- s'abonne aux mêmes topics (wildcard) publiés par toutes les autres machines pour construire sa
  propre vue agrégée.

Décision explicite de **repartir sur une conception neuve** plutôt que d'adapter le système de
supervision maison antérieur de l'utilisateur (PID+signaux, vintage ~2015, sujet mis en pause le
23/07/2026 — voir §11.1).

### 1.3 Périmètre de cette version

- **Inclus** : identité machine, présence + registre d'applications décentralisé (lecture seule,
  visibilité), relais générique de commandes inter-machines par MQTT, traitement explicite de la
  redondance `rpigpio`/`rfxcom`.
- **Exclu** : toute implémentation de code (cette version est une spec de conception uniquement),
  activation/désactivation d'application réellement dynamique (reste liée à un redémarrage complet
  du process, voir §2), authentification MQTT (documentée comme risque, pas résolue ici).

---

## 2. Faits Vérifiés (état actuel du code)

Vérifiés directement dans le code au moment de la conception (15/08/2026) :

- **Aucune identité machine n'existe nulle part** dans le socle — `grep -rn
  "machineId\|instanceId\|hostname" applications/core/src/` ne retourne aucun résultat, y compris
  dans le schéma Zod de `data/core/config.yaml`.
- **`EventBus.emitGeneric`/`onGeneric`** (`applications/core/src/application/EventBus.ts`) est le
  canal générique inter-app actuel — **strictement in-process**, aucune portée réseau. `SocketBridge`
  (core) le ponte vers Socket.io de façon **dynamique, pilotée par convention de nommage** : pour
  chaque événement déclaré dans la constante `*_SOCKET_EVENTS` d'un module, il pose un
  `eventBus.onGeneric(eventName, ...)` qui rediffuse vers les clients socket
  (`SocketBridge.registerAppSocketEvents()`). C'est le patron exact à reproduire pour un pontage
  EventBus → MQTT (voir §6).
- **`ApplicationManager.enable()`/`disable()`** ne déplacent **plus** de dossier entre
  `applications/` et `applications_désactivées/` — ce mécanisme a été abandonné le 07/08/2026 (échec
  `EXDEV` constaté sous overlay2 Docker le 03/08/2026). Le mécanisme réel : bascule de la liste
  `disabledApps` dans `data/core/config.yaml`, puis `RestartManager.scheduleRestart(15000, ...)` —
  un redémarrage complet du process Node 15 secondes plus tard. **Conséquence directe pour cette
  conception** : la liste des applications actives d'une machine ne change jamais "en direct", donc
  le futur registre multi-machines n'a besoin d'être republié qu'au démarrage du process, jamais en
  continu.
- **Conventions MQTT déjà standardisées** (`techniques-socle-ha-mqtt_specs_v4.28` §8.5, à
  reprendre à l'identique, pas à réinventer) :
  - Topics état/commande : `{moduleName}/{bridgeInstance}/{deviceId}/state|set`, construits par
    `getStateTopic()`/`getCommandTopic()`
    (`applications/core/src/ha/integration/types/ha-mqtt.ts`).
  - LWT par bridge : `{moduleName}/{bridgeInstance}/status`, payload `online`/`offline`, **retain**,
    **QoS 1** (`MqttTransport.ts`, `getBridgeStatusTopic()`).
  - Second déclencheur de republication : abonnement à `homeassistant/status` (birth HA natif,
    distinct du LWT par bridge), relayé en événement générique `integration:{moduleName}:ha:online`.
  - `bridgeInstance` est un identifiant **par instance d'application**, assigné manuellement par
    l'utilisateur (`rfx_bridge_0001` par défaut, `applications/rfxcom/src/domain/config-schema.ts`)
    — **jamais dérivé d'une identité machine**, d'où le risque de collision documenté en §7.
  - **Un seul broker MQTT partagé** (`ha.mqtt`) pour toute intégration de ce projet — pas de
    nouveau broker à créer pour ce système de supervision.
- ⚠️ **Confirmé en conditions réelles cette même session** : les deux brokers mosquitto observés
  (`ha2`, `stfort`/192.168.1.53) tournent en **accès anonyme, sans authentification** (voir §8).

---

## 3. Architecture Proposée

### 3.1 Emplacement du code

`applications/core/src/supervisor/` — nouveau sous-dossier du **socle**, au même niveau que
`application/`/`ha/`/`infrastructure/`, **pas** une application séparée sous `applications/`.

**Justification** (décision utilisateur) : ce module a besoin d'un accès privilégié à
`AppService.getModules()` (liste réelle des applications actives sur cette machine), à `EventBus`
et à `ConfigService` — une application classique sous `applications/` n'a normalement accès à ces
objets qu'au travers des paramètres fournis à sa factory `create*Service(eventBus, logger,
configProvider, ...)`, sans jamais recevoir `AppService` lui-même.

### 3.2 Vue d'ensemble

```
Machine A (ha2)                          Machine B (falbala)
┌─────────────────────────┐              ┌─────────────────────────┐
│ AppService.getModules() │              │ AppService.getModules() │
│         │                │              │         │                │
│         v                │              │         v                │
│  supervisor/ (core)      │  ◄── MQTT ──►│  supervisor/ (core)      │
│  - publie présence+apps  │   (broker    │  - publie présence+apps  │
│  - s'abonne aux autres   │   ha.mqtt    │  - s'abonne aux autres   │
│  - emitToMachine()       │   partagé)   │  - emitToMachine()       │
└─────────────────────────┘              └─────────────────────────┘
```

Aucun élément central autre que le broker MQTT déjà utilisé par toute la plateforme — la
décentralisation vient du fait que chaque machine construit sa propre vue par abonnement wildcard,
sans jamais interroger un serveur de registre dédié.

---

## 4. Identité Machine

Nouveau champ optionnel `core.machineId` dans le schéma Zod du socle (`data/core/config.yaml`) —
défaut : `os.hostname()`.

**Recommandation** : dériver aussi le `bridgeInstance` par défaut des applications matérielles
(`rfxcom`, `rpigpio`, `evoo7`...) de ce `machineId` — par exemple `{appId}_{machineId}` au lieu d'un
défaut fixe partagé par toutes les installations (`rfx_bridge_0001` aujourd'hui, identique pour
n'importe quelle machine tant que l'utilisateur ne le change pas explicitement). Ce changement
supprime **structurellement** toute une classe de bug ("même `bridgeInstance` sur 2 machines par
oubli"), plutôt que de compter sur la vigilance de l'utilisateur à chaque nouvelle installation.

---

## 5. Visibilité Décentralisée

### 5.1 Topics (même style que l'existant, §2)

```
dimotic/supervisor/{machineId}/status   # LWT online/offline, retain, QoS 1
dimotic/supervisor/{machineId}/apps     # retenu, JSON {activated: [...], disabled: [...], updatedAt}
```

`.../status` reprend exactement le mécanisme de `getBridgeStatusTopic()` (§2), avec `"supervisor"`
comme `moduleName` conceptuel. `.../apps` reflète directement `AppService.getModules()`, publié une
seule fois au démarrage du process (voir constat §2 : les applications actives ne changent jamais
sans redémarrage complet).

### 5.2 Construction de la vue agrégée

Chaque machine s'abonne à `dimotic/supervisor/+/status` et `dimotic/supervisor/+/apps` (wildcard
MQTT standard) pour construire sa propre vue de toutes les autres machines — c'est ce mécanisme,
et lui seul, qui réalise la décentralisation : aucun serveur de registre séparé, juste le broker
partagé déjà en place.

### 5.3 Exposition UI

`ApplicationsManager.ts` (`applications/core/src/presentation/ui/ts/components/`, déjà existant,
gère aujourd'hui "Paramètres Techniques > Gestion des applications" sur la machine locale
uniquement) affiche en plus, pour chaque application, sur quelle(s) machine(s) elle tourne
réellement — donne une visibilité directe sur les redondances potentielles (§7).

---

## 6. Relais de Commandes Inter-Machines

### 6.1 Principe

Nouvelle méthode, soit directement sur `EventBus`, soit dans un wrapper dédié du module
`supervisor/` : `emitToMachine(machineId, event, data)`.

- Publie sur `dimotic/supervisor/{machineId}/command/{event}`.
- La machine ciblée s'abonne à `dimotic/supervisor/{elle-même}/command/+` et ré-émet localement en
  `eventBus.emitGeneric(event, data)` — **même mécanisme de pontage dynamique que `SocketBridge`**
  (§2), appliqué à MQTT au lieu de Socket.io.

### 6.2 Cas d'usage cible : migration d'espdisplay

`espdisplay` migrerait de son SSH point-à-point actuel
(`applications/espdisplay/src/domain/EspDisplayService.ts::runPipelineRemote`, mis en place le
14/08/2026, voir `fonctionnelles-espdisplay_specs_v1.0.md` §6.2) vers :
```typescript
eventBus.emitToMachine(<machine hébergeant le conteneur esphome>, 'espdisplay:deploy-floorplan', {...});
```
La machine cible serait déterminée via le registre de présence (§5), pas codée en dur dans
`data/espdisplay/config.yaml` (`remote.host`) comme c'est le cas aujourd'hui.

---

## 7. Redondances Multi-Instances (rpigpio/rfxcom)

Deux classes de redondance distinctes, à traiter différemment :

### 7.1 Collision de configuration

Deux machines déclarant le même `{appId}:{bridgeInstance}` (ex: `rfxcom:rfx_bridge_0001` sur `ha2`
ET `orangepi`) publieraient sur les **mêmes topics MQTT état/commande**, se marchant dessus
silencieusement. Résolu structurellement par le `bridgeInstance` dérivé du `machineId` (§4), plus
une **détection explicite** dans le registre agrégé (§5.2) : si deux entrées déclarent le même
`{appId}:{bridgeInstance}`, avertir visiblement dans l'UI (§5.3) plutôt que laisser l'incident se
produire sans signal.

### 7.2 Doublon physique/RF (rfxcom uniquement)

Deux dongles RFXCOM sur deux machines différentes peuvent, si les deux sont à portée radio du même
appareil physique, capter la **même trame RF** — chacun la publierait sous son propre
`bridgeInstance`, créant deux entités HA distinctes pour un seul appareil physique réel.

**Documenté comme limite connue, non résolue par cette conception** — un dédoublonnage par adresse
device à travers plusieurs `bridgeInstance` nécessiterait une corrélation cross-machine
significativement plus poussée que le registre de présence proposé ici. Hors scope de cette
itération.

`rpigpio` **n'est pas concerné** par cette classe de problème — GPIO strictement local à la
machine qui l'héberge, aucun partage radio possible entre deux instances.

---

## 8. Sécurité — Broker MQTT Anonyme

Constat factuel de cette même session (14/08/2026, vérifié en direct sur `ha2` et
`stfort`/192.168.1.53) : les deux brokers mosquitto observés tournent en **accès anonyme, sans
authentification** (`allow_anonymous true` explicite sur l'un, comportement par défaut faute de
configuration sur l'autre).

Introduire un canal de **commandes** (§6, pas seulement de l'état passif comme aujourd'hui) sur ce
même broker change réellement la surface de risque — n'importe quel appareil du réseau local peut
aujourd'hui publier sur ce broker sans identification.

**Recommandation, non tranchée à ce stade** — deux options, à choisir avec l'utilisateur avant toute
implémentation réelle du relais de commandes (§6) :
1. Activer une authentification MQTT minimale (utilisateur/mot de passe, voire ACL par topic) sur
   les deux brokers avant de déployer ce relais en usage réel.
2. À défaut, conserver au minimum la discipline déjà appliquée à la clé SSH d'`espdisplay`
   (commande forcée, périmètre strictement whitelisté, voir `fonctionnelles-espdisplay_specs_v1.0.md`
   §3.1) : chaque machine ne doit accepter/exécuter que des commandes pour des applications qu'elle
   héberge réellement, avec validation stricte du payload — jamais une exécution arbitraire au seul
   motif que le message est arrivé sur le bon topic.

---

## 9. Idées Complémentaires et Hors Scope

### 9.1 Idées complémentaires (proposées, pas encore tranchées)

- **Capacités machine dans le registre** : au-delà de "quelles applications tournent", publier
  aussi des capacités déclarées (conteneur `esphome` présent ? RAM disponible ? — lien direct avec
  l'incident `ha2`/Pi4 de cette session, RAM insuffisante pour compiler ESP-IDF) pour qu'une
  décision future ("quelle machine doit héberger X") puisse s'appuyer sur des faits publiés plutôt
  que sur une configuration codée en dur comme `espdisplay.remote.host` aujourd'hui.
- **Heartbeat/santé au-delà du online/offline binaire** (uptime, nombre d'applications actives) —
  présenté comme amélioration possible, pas nécessaire à une première version.

### 9.2 Explicitement hors scope

- Rendre `enable()`/`disable()` réellement dynamiques (start/stop en direct, sans redémarrage
  complet du process) — rejoint le système de supervision PID+signaux mis en pause le 23/07/2026
  (voir §11.1), pas rouvert par cette spec.
- Authentification MQTT elle-même (§8) — documentée comme prérequis probable, pas implémentée ici.
- Dédoublonnage RF cross-machine pour RFXCOM (§7.2).

---

## 10. Plan de Mise en Œuvre

**Aucune implémentation dans cette version** — décision explicite de l'utilisateur ("nous y
reviendrons"). Cette spec sert de référence pour une session ultérieure. Aucun ordre d'implémentation
n'est fixé à ce stade.

---

## 11. Annexes

### 11.1 Références
- [Spécifications Techniques Socle **OBLIGATOIRE**](techniques-socle-ha-mqtt_specs_v4.28.md) ⭐
  (§8.5, conventions MQTT reprises à l'identique)
- [Spécifications Fonctionnelles ESPDISPLAY](fonctionnelles-espdisplay_specs_v1.0.md) (§6.2, cas
  d'usage cible de la migration SSH → relais MQTT)
- [Communication Inter-Applications](inter-app-communication_specs_v1.0.md)
- Mémoire de session `project_multi_machine_supervision_prior_art` (23/07/2026) : système de
  supervision maison antérieur de l'utilisateur (PID+signaux, ~2015), sujet mis en pause,
  explicitement non repris par cette conception (décision du 14-15/08/2026 : repartir sur un
  système neuf).

### 11.2 Glossaire
| Terme | Définition |
|-------|------------|
| `machineId` | Identité d'une instance de la plateforme (une par machine physique), défaut = hostname |
| `bridgeInstance` | Identifiant d'une instance d'application (ex: un dongle RFXCOM précis) — existant, indépendant de `machineId` jusqu'à cette conception |
| Registre agrégé | Vue locale, reconstruite par abonnement MQTT wildcard, de toutes les machines et applications actives connues |
| Relais de commandes | Mécanisme `emitToMachine()` faisant transiter un événement EventBus générique vers une autre machine via MQTT |

### 11.3 Historique
| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-08-15 | Claude | Première spécification — conception validée avec l'utilisateur, aucun code écrit. Couvre l'identité machine, la visibilité décentralisée (présence + registre d'apps par MQTT), le relais de commandes inter-machines (cas cible : migration d'espdisplay hors SSH), le traitement des redondances rpigpio/rfxcom, et un constat de sécurité explicite sur l'absence d'authentification des brokers MQTT observés. |
