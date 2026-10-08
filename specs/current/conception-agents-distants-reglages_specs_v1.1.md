# Conception — Agents distants sur l'écran Déploiement, page « Réglages » du core

*Version 1.1 - 8 Octobre 2026*
*v1.1 : **Claude Code** ajouté aux agents concernés (§3) — déclaré par l'application `ia`, mis en place par le script « Agent Claude Code » de l'application Outils en attendant l'écran ; voir `conception-claude-code-automatisations` §2ter. v1.0 archivée.*
*Version 1.0 - 3 Octobre 2026*
*Spécification de **conception** (aucun code écrit). Rassemble les décisions de l'utilisateur du 03/10/2026 :
un seul écran pour déployer et suivre les agents des applications, liens croisés, paramétrage de la sauvegarde
remonté au core, et regroupement des réglages techniques du core sur une page. Les specs des applications et du
socle concernées seront versionnées au moment de la mise en œuvre (§9).*

---

## 📌 Table des Matières

1. Objet et décisions
2. Vocabulaire
3. Les agents concernés
4. Déclaration d'un agent par son application
5. L'écran Déploiement étendu
6. Liens croisés applications ↔ Déploiement
7. Sauvegarde : paramétrage au core, répertoire fixe
8. Page « Réglages » du core
9. Specs et code impactés
10. Points ouverts
11. Plan de mise en œuvre
12. Historique

---

## 1. Objet et décisions

Décisions de l'utilisateur (03/10/2026), dans l'ordre où elles ont été prises :

| # | Décision |
|---|---|
| D1 | Un **seul écran** pour déployer et suivre les programmes installés par des applications sur d'autres machines, **sur un même principe** pour tous : **rpigpio, teleinfo, DDSU666-H** (futur compteurmodbus) et **arexx**. |
| D2 | Cet écran est **l'écran « Déploiement » existant** du core (Paramètres techniques), qui gère déjà dimotic-ha, la pile HA + Mosquitto et zigbee2mqtt. |
| D3 | Sur les écrans **arexx et rpigpio** (et teleinfo, compteur), un **lien vers l'écran Déploiement**, et **inversement**. |
| D4 | Le **paramétrage de la sauvegarde** (Nextcloud) passe **au niveau du core**. |
| D5 | Le **nom du répertoire distant** de sauvegarde **n'est plus demandé** : il est **fixe** (`backups-dimotic`). |
| D6 | Les **réglages techniques du core** sont regroupés sur **une seule page**, avec **un bouton « Enregistrer » par bloc**, **y compris la Gestion des applications**. |
| D7 | Restent des pages **séparées** : **Site**, **Déploiement**, **Services post-installation**. |

Menu « Paramètres techniques » cible : **Site · Réglages · Déploiement · Services post-installation**.

---

## 2. Vocabulaire

- **Agent distant** : programme installé par une application dimotic-ha sur une machine (par SSH, clé unique de
  l'installation) et qui y tourne seul : conteneur Docker, service systemd ou tâche cron. Il communique ensuite par
  MQTT.
- **Cible** : la machine qui porte un agent (`targets[]` de l'application, une machine = une ligne).
- À ne pas confondre avec la **diffusion** des fichiers `data/` entre machines (`techniques-diffusion-data_specs`),
  qui reste sur la page **Site**.

---

## 3. Les agents concernés

| Application | Agent | Type | Machines aujourd'hui | Présence MQTT |
|---|---|---|---|---|
| rpigpio | mqtt-io (relais GPIO) | Docker | noisy, stfort | LWT mqtt-io (`app/rpigpio-presence-…`) |
| teleinfo | agent Node (2 compteurs EDF) | systemd | RPi1 | `teleinfo/agent/status` (LWT + battement 30 s) |
| **DDSU666-H** (compteurmodbus) | agent Python, lecture Modbus RTU | systemd | noisy (installé **à la main** le 01/10/2026) | à ajouter (`compteurmodbus/<cible>/agent/status`) |
| arexx | envoi BS-1000 / pilote TL-500 (`deploy-sender.sh`, `DriversBundle`) | systemd / cron | RPi1, ha2 | à vérifier |
| sauvegarde | script de sauvegarde + cron + secret | cron | toutes les machines couvertes | `status.json` lu par SSH |
| **ia** (⭐ v1.1) | **Claude Code** (agent de mise au point et d'automatisation, un par site) | `screen` sous compte dédié | ici ; site distant à venir | à définir (session Remote Control visible, `ia` joignable en MCP) |

**Claude Code** (⭐ v1.1) : mis en place aujourd'hui par le script « Agent Claude Code » de l'application Outils
(`fonctionnelles-outils` §7.4), sans passer par cet écran. Cible : le déclarer ici comme agent de l'application `ia`
(machine, version de Claude Code installée, état du `screen`, jeton MCP propre à la machine, niveau d'autorisation),
avec les actions communes (Déployer · Démarrer · Arrêter · Voir la log · Retirer). Voir
`conception-claude-code-automatisations` §2ter.

**DDSU666-H** : ce déploiement est **à créer** — le service tourne sur noisy depuis le 01/10/2026 mais a été posé à la
main (`/root/ddsu666h-mqtt.py`, `/etc/systemd/system/ddsu666h-mqtt.service`, broker local `192.168.1.62` depuis le
03/10/2026). Il entre dans l'écran Déploiement par l'application **compteurmodbus**
(`fonctionnelles-compteurmodbus_specs` v1.0, dont §8 décrit déjà le déploiement SSH + systemd et §12 la reprise de
l'installation manuelle de noisy).

Hors périmètre de cette version : **espdisplay** (firmware ESPHome compilé puis envoyé par OTA, pas un agent qui
tourne sur une machine du parc), **tasmota** (appareils pilotés par MQTT, rien n'est installé par SSH).

---

## 4. Déclaration d'un agent par son application

Le core ne connaît **pas** le métier des agents (autonomie des applications) : chaque application **déclare** ses
agents, le core les rassemble et les affiche. Déclaration proposée, dans le module de l'application
(`ApplicationModule.remoteAgents`) ou envoyée à son démarrage (événement `app:remote-agents:register`) :

| Champ | Rôle |
|---|---|
| `id` | identifiant de l'agent dans l'application (`mqttio`, `agent`, `compteur`, `sender`, `script`) |
| `name` / `icon` | libellé affiché |
| `kind` | `docker` · `systemd` · `cron` |
| `targets` | liste des cibles (`id`, `machine`, `host`), lue dans la configuration de l'application |
| `presenceTopic` | sujet MQTT de présence (facultatif) |
| `version` | version disponible (dans l'application) ; la version installée est lue sur la cible |
| `configPage` | lien vers l'écran de l'application qui porte sa configuration métier (D3) |

Les **actions** restent exécutées **par l'application** (elle seule sait générer la configuration de son agent) :
le core relaie la demande par l'événement générique déjà utilisé par teleinfo/rpigpio/arexx
(`<app>:remote-op` → `<app>:remote-op:result`, `{ targetId, action }`), avec les actions communes :
`deploy`, `start`, `stop`, `restart`, `logs`, `remove`, `status`.

Les briques partagées existent déjà dans le socle : `runSsh`/`runScp`, la clé SSH unique, `SystemdUnitController`,
`DockerContainerController`, le composant d'écran `TargetCards`.

---

## 5. L'écran Déploiement étendu

En plus des trois sections actuelles (dimotic-ha, HA + Mosquitto, zigbee2mqtt), une section **« Agents des
applications »** :

- **Tableau, une ligne par machine × agent** : machine, application / agent, type, version installée / disponible,
  **état** (en marche · arrêté · absent · inconnu), **dernier contact** (présence MQTT), dernier déploiement et son
  résultat.
- **Regroupement par machine** (repliable) : tout ce qui tourne sur noisy, sur ha2, etc.
- **Actions par ligne**, les mêmes pour tous : Déployer · Démarrer · Arrêter · Redémarrer · **Voir la log** ·
  Retirer (avec confirmation).
- **Bouton « Configurer »** → écran de l'application (D3).
- Les applications **désactivées** n'apparaissent pas (pas de service pour exécuter l'action) ; une ligne indique
  qu'il faut les activer depuis la page Réglages.
- La **sauvegarde** y figure comme un agent de type `cron` (envoi du script + cron + secret sur chaque machine
  couverte), à la place du bouton « Pousser » de son application.

---

## 6. Liens croisés applications ↔ Déploiement

- Écrans **arexx, rpigpio, teleinfo, compteurmodbus** (et sauvegarde) : un lien « 🚀 Déploiement de mes agents »
  vers l'écran Déploiement, **filtré** sur l'application (`#deployment?app=<id>`).
- Écran Déploiement : sur chaque ligne, « Configurer » ouvre l'écran de l'application (`configPage`).
- Les cartes de cibles actuelles de ces applications (`TargetCards`) restent dans un premier temps, puis sont
  remplacées par ce lien une fois l'écran Déploiement validé (évite deux endroits pour la même action).

---

## 7. Sauvegarde : paramétrage au core, répertoire fixe

- **Au core** (page Réglages, bloc « Sauvegarde ») : **serveur Nextcloud** (`serverUrl`), **utilisateur** (`user`),
  **mot de passe d'application** (saisi, poussé sur les machines comme aujourd'hui — jamais stocké en clair dans les
  fichiers diffusés).
- **Répertoire distant fixe** : `backups-dimotic` (constante, plus de champ `rootPath` à l'écran ; la valeur actuelle
  de la configuration reste lue pour ne rien casser, puis le champ est retiré).
- **Reste dans l'application Sauvegarde** : liste des machines sauvegardées, état des sauvegardes, journal (« Voir la
  log »), **assistant de restauration**.
- **Va à l'écran Déploiement** : l'envoi du script, du cron et du secret sur les machines (§5).
- Couche de configuration : ces réglages Nextcloud sont **communs au foyer** (diffusés), sauf le mot de passe
  (secret).

---

## 8. Page « Réglages » du core

Une page, des **blocs indépendants**, chacun avec **son bouton « Enregistrer »** et son message de résultat :

| Bloc | Contenu actuel (page d'origine) | Effet de l'enregistrement |
|---|---|---|
| **Home Assistant (Web-services)** | WebSocket HA : activé, hôte, port, jeton, délai | reconnexion HA |
| **MQTT** | broker : activé, hôte, port, client_id, utilisateur, mot de passe | reconnexion MQTT |
| **Serveur Web** | adresse, port | **redémarrage** nécessaire (signalé) |
| **Journalisation** | niveau, rotation | immédiat |
| **Sauvegarde** | Nextcloud (§7) | immédiat |
| **Gestion des applications** | activer / désactiver, relancer, état (page actuelle intégrée telle quelle) | à chaud, sans redémarrage du core |

Règles :
- Un bloc n'enregistre **que sa section** (pas de sauvegarde globale qui écraserait une autre section modifiée
  ailleurs). La validation stricte reste par section (démarrage tolérant `ha.ws`/`ha.mqtt`, socle §7.2).
- Les **voyants** (HA WebSocket, MQTT) et les erreurs de validation (champs « Requis ») s'affichent dans leur bloc.
- **Site** (nom de machine, site, Diffuser / Recevoir) **reste une page séparée** (D7).
- Menu : **Site · Réglages · Déploiement · Services post-installation**.

---

## 9. Specs et code impactés

| Élément | Changement |
|---|---|
| `techniques-socle-ha-mqtt_specs` | `ApplicationModule.remoteAgents` (ou événement d'enregistrement), page Réglages, menu |
| `fonctionnelles-supervisor_specs` | Gestion des applications intégrée à la page Réglages |
| `fonctionnelles-sauvegarde_specs` | paramétrage au core, répertoire fixe, envoi via Déploiement |
| `fonctionnelles-rpigpio_specs`, `fonctionnelles-teleinfo_specs`, `fonctionnelles-arexx_specs` | déclaration des agents, lien vers Déploiement |
| `fonctionnelles-compteurmodbus_specs` | l'application déclare l'agent DDSU666-H ; reprise de l'installation manuelle de noisy |
| Code core | `DeploymentManager.ts` (section agents), page Réglages (regroupe `ConfigForm`/`ApplicationsManager`), `Sidebar.ts` |
| Code applications | déclaration `remoteAgents`, liens ; sauvegarde : retrait du champ `rootPath` et du bouton « Pousser » |

---

## 10. Points ouverts

1. **Déclaration** par champ du module (`remoteAgents`, statique) ou par événement au démarrage (dynamique, suit les
   cibles ajoutées) — le second permet de mettre à jour la liste sans redémarrer.
2. **Versions** : chaque agent n'a pas aujourd'hui de numéro de version lisible sur la cible (teleinfo, arexx) —
   ajouter un fichier `VERSION` dans le répertoire déployé ?
3. **arexx** : quel est précisément l'agent (envoi BS-1000, pilote TL-500, les deux) et sa présence MQTT.
4. **Droits** : l'écran Déploiement et la page Réglages réservés aux administrateurs ?
5. Ordre de mise en œuvre de compteurmodbus (application complète) par rapport à cet écran.

---

## 11. Plan de mise en œuvre

Chaque étape vérifiée (build, essai réel) avant la suivante :

1. **Page Réglages** (D6/D7) : regroupement des pages existantes, un bouton par bloc, menu. Aucun changement de
   comportement des réglages eux-mêmes.
2. **Sauvegarde** (D4/D5) : bloc au core, répertoire fixe, l'application garde état + restauration.
3. **Déclaration des agents** dans le socle + **section « Agents des applications »** de l'écran Déploiement, avec
   **rpigpio** en premier (Docker, déjà le plus outillé).
4. **teleinfo**, **arexx**, puis **sauvegarde** (cron).
5. **compteurmodbus / DDSU666-H** : l'application (spec v1.0), son agent déclaré ici, reprise de l'installation
   manuelle de noisy.
6. **Liens croisés** (D3) et retrait des cartes de cibles en double.

---

## 12. Historique

| Version | Date | Changements |
|---|---|---|
| 1.0 | 03/10/2026 | Première version (conception) : décisions D1–D7 de l'utilisateur, agents rpigpio / teleinfo / DDSU666-H / arexx (+ sauvegarde) sur l'écran Déploiement, page Réglages du core avec la Gestion des applications, Site / Déploiement / Services post-installation séparés. |
