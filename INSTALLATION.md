# Installation sur une nouvelle machine

Ce guide couvre deux installations distinctes :
- **Partie A** — `dimotic-ha` (le socle + les applications), via Docker. Nécessaire sur toute
  nouvelle machine qui doit exécuter le projet.
- **Partie B** — le pont de compatibilité RFXCOM (`rfxcombridge.js`), qui ne concerne **que** les
  machines devant faire cohabiter le matériel RFXCOM physique avec l'ancien système `dimotic`
  encore en place (cas réel : stfort, 192.168.1.53). Si la nouvelle machine n'a pas ce besoin,
  ignorer la partie B.

---

## Partie A — `dimotic-ha` (Docker)

### A.1 Prérequis

| Besoin | Détail |
|---|---|
| Docker + le plugin `docker compose` (v2, syntaxe avec espace) | `docker compose version` doit répondre |
| Accès réseau à Home Assistant et au broker MQTT | Depuis la machine cible elle-même (voir §A.4, `network_mode: host`) |
| Si RFXCOM physique sur cette machine | Le port série doit être visible du conteneur (§A.3) |

Aucun clone du dépôt ni build local nécessaire — l'image `zdid2/dimotic-ha` (Docker Hub,
multi-arch : `amd64`/`arm64`/`arm/v7`) est autosuffisante.

### A.2 Fichiers à copier sur la machine cible

Un seul fichier suffit, `compose.deploy.yaml` du dépôt (renommé `compose.yaml` sur la cible) —
ne jamais copier `compose.yaml` du dépôt lui-même, réservé à la machine de développement (celui-ci
référence un `build:` local).

```bash
scp compose.deploy.yaml <user>@<machine-cible>:/docker/dimotic-ha/compose.yaml
```

Convention de répertoire du projet : `/docker/dimotic-ha/` sur la machine cible (même convention
que `/docker/<app>/` pour tout autre service Docker de l'infra).

### A.3 Ajustements du `compose.yaml` selon la machine

Le fichier copié fonctionne tel quel dans le cas général. Deux points à vérifier/adapter :

- **RFXCOM physique sur cette machine** : `privileged: true` + volume `/dev:/dev` déjà présents
  (accès dynamique à `/dev/ttyUSBx`, quel que soit son numéro). Alternative plus restrictive si le
  port ne change jamais : remplacer par `devices: ["/dev/ttyUSB0:/dev/ttyUSB0"]` +
  `group_add: ["dialout"]` (déjà présent dans le fichier).
- **Port par défaut (8087) déjà utilisé sur cette machine** (rencontré sur stfort — l'ancien
  système dimotic occupe le port 8080, d'où le choix de 8087 comme défaut) : pas de remapping
  possible en `network_mode: host` — changer `web.port` dans `data/core/config.yaml` (§A.5) vers
  un port libre. Depuis le 25/08/2026, le `HEALTHCHECK` intégré à l'image lit lui-même `web.port`
  dans ce fichier (repli sur 8087 si absent) — plus besoin de surcharge manuelle dans
  `compose.yaml` pour que le healthcheck suive.

### A.4 Premier démarrage

```bash
cd /docker/dimotic-ha
mkdir -p data logs                    # vides, rien à pré-remplir
docker compose pull
docker compose up -d
```

Un `data/core/config.yaml` absent est toléré (valeurs par défaut,
`applications/core/src/infrastructure/config/loader.ts`) — pas besoin de le créer à la main avant
le premier démarrage.

**⚠️ Propriétaire des fichiers** : si `data/`/`logs/` sont créés par un utilisateur autre que celui
qui a fait le `scp` (ex: copié en `root`), les corriger avant le démarrage — l'image tourne avec
l'utilisateur intégré `node` (uid/gid 1000) :
```bash
chown -R 1000:1000 data logs
```
Sans ça : `EACCES` au démarrage sur l'écriture des logs.

### A.5 Configuration (après le premier démarrage)

Ouvrir `http://<IP de la machine>:8087` (défaut — ou le port choisi en §A.3) → **Paramètres Techniques →
Web Services** : y saisir la connexion MQTT et le WebSocket Home Assistant DE CETTE machine — la
sauvegarde écrit elle-même `data/core/config.yaml`, pas besoin de l'éditer à la main.

Champs principaux du fichier généré (pour référence, ne pas éditer à la main sauf besoin précis) :
```yaml
ha:
  ws_enable: true
  mqtt_enable: true
  ws: { host, port, token, reconnect_delay }
  mqtt: { host, port, client_id, username, password, keepalive, reconnect_delay }
  structure: { include_unassigned, unassigned_label }
web: { port, host }
logging: { level, rotate: { max_size_mb, max_files } }
disabledApps: [...]   # ex: [arexx, evoo7, nommage, rfxcom] — applications à désactiver sur CETTE machine
```

**`disabledApps`** : penser à désactiver les applications déjà hébergées ailleurs (éviter deux
instances actives du même module MQTT — collision de `bridgeInstance`, vécu réellement lors du
déploiement stfort/ha2 cette session).

### A.6 Vérification

```bash
docker ps --filter name=dimotic-ha --format '{{.Names}} {{.Status}}'
# doit afficher: dimotic-ha   Up ... (healthy)
docker logs --tail 50 dimotic-ha
```

### A.7 Mise à jour ultérieure

```bash
cd /docker/dimotic-ha && docker compose pull && docker compose up -d
```
Suffisant depuis le 07/08/2026 (plus de volume nommé pour `/app` — Docker recrée automatiquement
le conteneur dès qu'il détecte que l'image a changé). Voir `docker/deploy-remote.sh` pour un
script prêt à l'emploi (attend le `healthy`, affiche le statut final).

---

## Partie B — Pont de compatibilité RFXCOM (`rfxcombridge.js`)

**Ne s'applique que si** la machine cible héberge déjà (ou doit héberger) l'ancien système
`dimotic` ET le matériel RFXCOM physique, et doit relayer les commandes de l'ancien système vers
le nouveau pilote `dimotic-ha` (partie A) — cas réel : stfort (192.168.1.53).

Ce guide suppose que l'ancien système `dimotic` (`zdidnodesuperdimotic` et ses modules) est **déjà
installé et fonctionnel** sur la machine cible — sa réinstallation n'est pas couverte ici (système
legacy, sans procédure d'installation reproductible documentée par ailleurs).

### B.1 Prérequis spécifiques

| Besoin | Pourquoi |
|---|---|
| Node.js (même version que le reste de l'installation `dimotic` déjà en place sur cette machine) | Le pont tourne comme n'importe quel module supervisé par l'ancien système, pas dans Docker |
| **Python 3 + outils de compilation** (`build-essential`/`make gcc g++` sous Debian/Ubuntu, ou `python3 make gcc g++ linux-headers` sous Alpine) | La dépendance npm `rfxcom` embarque `serialport`, un module natif — `npm install` le compile via `node-gyp`, qui requiert Python 3 |
| Mosquitto (broker MQTT local) | Le pont s'y connecte en local (`127.0.0.1:1883`) — voir §B.3 pour le pont vers `ha2` |
| Port série RFXCOM accessible | `/dev/ttyUSBx` — établir un lien symbolique stable (`/dev/serial/by-id/...`, voir §B.4) plutôt que de dépendre du numéro, qui peut changer |

Vérifier `python3 --version` et la présence d'un compilateur (`gcc --version`) avant de lancer
`npm install` — sans ça, l'installation de `rfxcom`/`serialport` échoue avec une erreur
`node-gyp`/`Python` peu explicite.

### B.2 Fichiers à copier

Répertoire complet à copier sur la machine cible (mêmes chemins relatifs requis — `rfxcombridge.js`
dépend de `../zdidnodeutil` et `../zdidnodedomoutil` par `require()` relatif) :

```
zdidnoderfxcom433e/     # ce pont — rfxcombridge.js, rfxcomserv.js, appmean.js
zdidnodeutil/            # dépendance sœur
zdidnodedomoutil/        # dépendance sœur (mqttdimotic)
```

Sur la machine de développement, ces trois répertoires vivent sous
`/home/didier/ownCloud/workspace6/`. Copier les trois avec la même hiérarchie relative sur la
cible (ex: `/home/domotique/node_applications/`), puis :

```bash
cd zdidnoderfxcom433e && npm install
```

### B.3 Configuration du pont

Deux constantes à vérifier/adapter dans `rfxcombridge.js` en tête de fichier :

```js
const BRIDGE_INSTANCE = 'rfx_bridge_local_test';  // doit correspondre à bridgeInstance dans
                                                    // data/rfxcom/config.yaml du pilote dimotic-ha
                                                    // (partie A) qui a le matériel RFXCOM branché
const MQTT_URL = 'mqtt://127.0.0.1:1883';          // broker LOCAL à cette machine
```

**Pont mosquitto local → `ha2`** (nécessaire pour que les messages atteignent le pilote
`dimotic-ha`, qui se connecte lui-même au MQTT de `ha2`) — fichier
`/etc/mosquitto/conf.d/bridge-<machine>-rfxcom.conf` :
```
connection ha2-rfxcom-bridge
address 192.168.1.51:1883
topic rfxcom/# both 0
```
Redémarrer mosquitto après ajout : `systemctl restart mosquitto`.

### B.4 Port série stable

Éviter de dépendre du numéro `/dev/ttyUSBx` (peut changer entre redémarrages/rebranchements) :
```bash
ls -la /dev/serial/by-id/    # repérer le lien stable du RFXCOM
```
Utiliser ce chemin stable (ex: `/dev/ttyUSBRFXCOM` si un lien symbolique dédié existe déjà, ou le
chemin `/dev/serial/by-id/...` directement) dans `data/rfxcom/config.yaml` du pilote `dimotic-ha`
(partie A), champ `port`.

### B.5 Intégration à l'ancien système

Le module RFXCOM de l'ancien système (`vrfx` dans sa nomenclature) doit charger `appmean.js` de ce
répertoire au lieu du module RFXCOM d'origine — déjà en place si cette machine faisait déjà tourner
l'ancien système avec RFXCOM ; sinon, se référer à la configuration de supervision de l'ancien
système (`zdidnodesuperdimotic/SUPERVISEDNODES2.json`) pour l'ajouter.

### B.6 Vérification

```bash
# Redémarrer uniquement le module RFX de l'ancien système :
mosquitto_pub -h 127.0.0.1 -p 1883 -t 'domitic/command/supervisor' -m 'restart rfx'
```
Puis tester une commande réelle depuis l'ancienne interface (dimoweb) sur un appareil déjà
paramétré côté `dimotic-ha` — vérifier son exécution physique.

---

## Annexes

### Références
- `docker/rebuild-and-deploy.sh`, `docker/deploy-remote.sh`, `docker/start-all.sh`,
  `docker/stop-all.sh` — scripts opérationnels du dépôt, à privilégier une fois l'installation
  initiale faite.
- `specs/current/fonctionnelles-supervisor_specs_v2.6.md` — architecture de supervision
  (process séparés, IPC) du socle.
- `CLAUDE.md` (racine du dépôt) — règles du projet (specs, sauvegardes, structure).

### Historique
| Date | Changements |
|------|-------------|
| 19/08/2026 | Première version — rédigée après les déploiements réels de la session (ha2, stfort, orangepi). |
