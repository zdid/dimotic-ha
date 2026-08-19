# Runbook — Sauvegarde et installation du parc (ha2 + machines associées)

**Premier jet, 06/08/2026.** Rédigé après la session de récupération/réinstallation de `ha2` (carte SD, Zigbee2MQTT, Home Assistant, dimotic-ha) — les choix ci-dessous s'appuient sur ce qui a été vérifié en direct ce jour-là. À affiner/corriger avant de le considérer comme une procédure de référence.

---

## 1. Procédure de sauvegarde des éléments essentiels

### 1.1 Ce qui a de la valeur réelle (à sauvegarder)

| Machine/service | Chemin | Pourquoi c'est critique |
|---|---|---|
| Zigbee2MQTT | `data/coordinator_backup.json` | **Le plus critique** — clé réseau, PAN ID. Sans lui, remplacer le coordinateur = réappairer chaque device un par un. |
| Zigbee2MQTT | `data/database.db` | Base des devices (noms, IEEE, "exposes"). |
| Zigbee2MQTT | `data/configuration.yaml` (+ `configuration_backup_v*.yaml`) | Réglages (port série, MQTT, réglages par device). |
| Zigbee2MQTT | `data/automations.yaml`, `data/automationsV2.yaml` | Automatisations maison (ex: plan de travail ↔ vitrine). |
| Zigbee2MQTT | `data/external_extensions/*.js` (hors `.invalid`/`.disabled`) | Code sur mesure (`AutomatisationsExtension.js`, etc.) — pas dans un dépôt git, existe uniquement ici. |
| Home Assistant | `config/` entier une fois peuplé (surtout `.storage/`, `configuration.yaml`, `secrets.yaml`) | Areas, dashboards, utilisateurs, tokens. |
| dimotic-ha | `data/` entier (surtout `data/core/config.yaml` — token HA, MQTT) | Configuration par application, pas dans git (gitignored). |
| Tous | `/home/didier/docker/*/compose.yaml` | Définition de chaque service — petit, mais absent d'un dépôt git à ce jour. |

### 1.2 Ce qui n'a pas besoin d'être sauvegardé régulièrement

- **Mosquitto** : décision explicite du 05/08 — sans persistance, rien à sauvegarder par conception.
- **Modèles Whisper/Piper** (`docker/whisperpiper/wyoming/`) : volumineux (1.6 Go) mais ré-téléchargeables à l'identique depuis HuggingFace/Piper — sauvegarde one-shot suffisante, pas besoin de répéter.
- **Volume nommé `app-code` de dimotic-ha** : reconstruit automatiquement depuis l'image Docker Hub à chaque déploiement, rien d'unique dedans.
- **`node_modules/` de Zigbee2MQTT** : reconstructible (`npm install`), a fait perdre du temps aujourd'hui à cause de son poids (258 Mo) sans nécessité de le garder en l'état — ne garder que les paquets réellement utilisés par les extensions sur mesure (`yaml`, etc.) si on veut alléger.

### 1.3 Leçon de la session d'aujourd'hui — vérifier la fraîcheur

**Constat en direct** : une sauvegarde de 6 mois (21 janvier) dormait à côté d'une bien plus récente (4 août, 2 jours avant la panne) sur la même carte, dans un chemin différent (`/docker/zigbee2mqtt/` vs `/home/didier/docker/zigbee2mqtt/`). La confusion a fait perdre du temps et a bien failli faire garder la mauvaise version.

**À intégrer dans la procédure** : toute sauvegarde doit être nommée/horodatée sans ambiguïté (déjà fait aujourd'hui : `zigbee2mqtt-backup-carte-pi4-YYYY-MM-DD`), et un **seul chemin canonique par service** doit exister — pas deux installations en parallèle sur la même machine, ou alors avec une convention de nommage qui rend l'obsolescence évidente au premier coup d'œil.

### 1.4 Squelette de procédure (à valider avec l'utilisateur)

1. Script de sauvegarde (où ? cron sur `ha2` ? déclenché depuis cette machine via SSH comme aujourd'hui ?) qui `rsync` les chemins de la section 1.1 vers un stockage **hors de la carte SD/du Pi lui-même**.
2. Fréquence : quotidienne pour Zigbee2MQTT/HA (changent avec chaque appairage/réglage) ; à la demande avant toute manipulation risquée (reflash, changement de matériel) pour le reste.
3. Rétention : nombre de versions à garder (cf. règle générale du projet dimotic-ha — minimum 3 versions, voir `PROMPT_PROJET.md` §5).
4. Vérification post-sauvegarde : `diff -r` ou au minimum comparaison de dates, pour éviter de reproduire l'incident de la section 1.3.

### 1.5 Destination des sauvegardes — tranché le 06/08/2026

**Serveur OwnCloud dédié de l'utilisateur**, lui-même dupliqué par rsync vers un second site — donc déjà redondant géographiquement, espace disque généreux. Cette machine de développement est déjà synchronisée dessus (`/home/didier/ownCloud/dimotic-ha` en est la preuve directe).

Conséquence pratique : les sauvegardes n'ont **pas besoin d'un mécanisme de transport dédié** — il suffit qu'un script les dépose dans un dossier sous `/home/didier/ownCloud/` (mais **hors du dépôt git `dimotic-ha`**, pour ne pas mélanger sauvegardes d'infrastructure — potentiellement volumineuses, binaires — avec le code versionné ; un dossier frère du type `/home/didier/ownCloud/dimotic-ha-backups/` semble adapté). Le client OwnCloud existant se charge ensuite de la synchronisation vers le serveur dédié, qui gère lui-même la réplication vers le second site — rien à construire de ce côté.

Reste ouvert : le script de collecte tourne-t-il **depuis cette machine** (pull SSH depuis `ha2`, comme fait manuellement aujourd'hui) ou **depuis `ha2` lui-même** (push direct vers un montage/API OwnCloud) ? Le pull depuis cette machine est plus simple à mettre en place immédiatement (même mécanisme que ce qui a été fait à la main aujourd'hui, juste à scripter), sans dépendance nouvelle côté `ha2`.

---

## 2. Checklist minimale d'installation HA avant réception MQTT

Objectif : une fois Home Assistant démarré (instance neuve, décision du 05/08 — pas de restauration de l'ancienne config), quelles étapes minimales avant que tout arrive automatiquement via la découverte MQTT (Zigbee2MQTT, futur RFXCOM/EVOO7 via dimotic-ha) ?

1. **Onboarding** (`http://ha2.local:8123`) — compte admin, nom, unités, localisation.
2. **Intégration MQTT** — Paramètres → Appareils et services → Ajouter une intégration → MQTT → `localhost`, port `1883`, **sans identifiants** (Mosquitto tourne en `allow_anonymous`).
3. Rien à changer sur le préfixe de découverte — reste `homeassistant` par défaut, déjà ce que Zigbee2MQTT publie (`AExtensionController.js` désactivé aujourd'hui : c'est Nommage, côté dimotic-ha, qui gère maintenant la traduction `homeassist/…` → publication HA, pas de mécanisme concurrent).
4. Les devices Zigbee2MQTT devraient apparaître automatiquement (messages de découverte retenus, déjà publiés).
5. **Jeton longue durée** — Profil (bas de menu) → Sécurité → Créer un jeton — à saisir ensuite côté dimotic-ha.
6. **dimotic-ha** — Paramètres Techniques → Web Services : hôte/port MQTT (`localhost:1883`), hôte WS HA + jeton de l'étape 5.
7. RFXCOM reste désactivé sur `ha2` (pas de matériel branché ici) — à réactiver seulement si le dongle RFXCOM est un jour rattaché à cette machine.

*Point ouvert, non traité ce soir : intégrations Wyoming (Whisper `10300`/Piper `10200`, conteneurs actuellement arrêtés à la demande) — à ajouter à cette checklist si/quand l'assistant vocal est remis en service.*

---

## 3. Pistes futures — non traitées ce soir

**Communication inter-machines (ha2 ↔ OrangePi RFXCOM, etc.)** — évoqué en passant par l'utilisateur ("peut-être sur une base de communication intermachines pi"). MQTT est déjà une dépendance de premier plan sur toutes les machines du parc, donc pas de nouvelle brique à introduire — le vrai travail de conception serait :
- une convention de routage (topic incluant l'app/machine cible, éventuellement l'instance source) ;
- une corrélation requête/réponse (ID de corrélation + timeout, MQTT étant fire-and-forget par nature).

Ça s'articulerait avec le système de supervision PID+signaux déjà en place côté utilisateur (voir mémoire `project_multi_machine_supervision_prior_art`) — celui-là pour le cycle de vie des process, ceci pour le transport des événements applicatifs entre machines. À concevoir en session dédiée, pas ce soir.

---

## À trancher demain

- ~~Où stocker les sauvegardes~~ → tranché le 06/08 (§1.5) : serveur OwnCloud dédié de l'utilisateur, déjà répliqué sur un second site.
- Le script de sauvegarde tourne-t-il en pull depuis cette machine, ou en push depuis `ha2` ? (§1.5)
- Faut-il committer les `compose.yaml` de `/home/didier/docker/*/` dans un dépôt git (actuellement nulle part versionnés) ?
- Whisper/Piper : on les relance dans la checklist HA, ou on les garde à part tant que l'assistant vocal n'est pas prioritaire ?
