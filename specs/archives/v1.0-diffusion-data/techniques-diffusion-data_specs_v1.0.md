# Spécifications — Diffusion des fichiers de `data/` entre machines (core)

**Version :** 1.0
**Date :** 28 Septembre 2026
**Statut :** Conception — points ouverts §10 tous tranchés le 29/09/2026 ; **à valider dans son ensemble avant le code**. Reprend la conception
du 06/09/2026 (mise en pause), précisée par les décisions de l'utilisateur du 28/09/2026.
**Rôle :** mécanisme **du core** (aucune application ne le réimplémente).

---

## 1. Objet

Le paramétrage et les données de chaque application (`data/<app>/…`) sont **reproduits sur toutes
les machines dimotic-ha du site**, même celles où l'application ne tourne pas : une application
peut être déplacée d'une machine à l'autre ou relancée ailleurs, avec ses données à jour. Ce n'est
pas de la haute disponibilité : chaque machine garde une copie complète et à jour.

## 2. Décisions (utilisateur, 28/09/2026)

| # | Décision |
|---|---|
| D1 | **Le nom dit si un fichier est reproduit** : un fichier (ou un répertoire) dont le nom commence par **`machine_`** n'est **jamais reproduit** ; **tous les autres** fichiers de `data/` le sont. |
| D2 | **Transport : MQTT, SANS message retenu** (29/09/2026, remplace « MQTT retenu » du 28/09) — rien de `data/` ne reste stocké sur le broker ; les machines s'échangent inventaires et fichiers au moment voulu (§4-§6). Le garage passe par le pont Mosquitto (topics `dimotic/data/#` à laisser passer). |
| D3 | **Conflit : le plus récent gagne** (date de modification) ; la version remplacée est gardée localement (historique). |
| D4 | Exclus en plus des `machine_*` : tout ce qui est sous un répertoire **`tmp/`**, et les fichiers de **plus de 1 Mo** (signalés comme non reproduits). |
| D6 | (29/09/2026) **Secrets** dans des fichiers **`secrets_*`** — **non reproduits pour l'instant** (traitement à décider plus tard). Ex. le mot de passe Wi-Fi de tasmota passera dans `data/tasmota/secrets_config.yaml`. |
| D7 | (29/09/2026) **Exclus** : les répertoires **`node_modules/`** (y compris sous `data/applications/`), les fichiers **`*.bak`** et **`*.origine.yaml`**. |
| D8 | (29/09/2026) **Applications externes** (`data/applications/<app>/`) : on n'y dépose que les **sources** ; `node_modules/` n'est jamais reproduit (D7) — le core **réinstalle les dépendances et recompile** lui-même sur chaque machine (§8bis). |
| D5 | **Exception à D4 (29/09/2026) : les images de plan** (`data/haplan/images/`) sont **reproduites quelle que soit leur taille** (plafond technique 20 Mo par image). Diffusion rare : une fois faite, le message retenu ne change plus. |

## 3. Périmètre

Racine : `data/` (le `PROJECT_ROOT/data` de chaque machine). Chemin d'un fichier = son chemin
relatif à `data/` (ex. `tasmota/rules.yaml`).

**Non reproduits** (en plus de D1/D4), par construction :
- fichiers temporaires d'écriture atomique et d'éditeurs : `*.tmp`, `*~`, `.*.swp`, `.#*` ;
- `data/core/ssh/` (**clé SSH privée de l'installation**) — renommé `data/core/machine_ssh/` (§8) ;
- le répertoire d'historique de la diffusion elle-même (`data/core/machine_diffusion/`) ;
- les répertoires de travail temporaires nommés `tmp` ou se terminant par `-tmp` (ex.
  `haplan/images/.lovelace-tmp/`, fichiers intermédiaires du dépôt Lovelace).

**Taille** : 1 Mo au plus (D4), sauf les images de plan (D5, 20 Mo au plus) — un seul message par
fichier, sans découpage (le broker n'a pas de limite de taille configurée ; une image n'est envoyée qu'à sa
modification ou à la demande d'une machine qui ne l'a pas).

## 4. Messages MQTT (aucun retenu)

| Topic | Émis par | Contenu |
|---|---|---|
| `dimotic/data/fichier/<machine>` | une machine, quand un de ses fichiers change, ou en réponse à une demande | `{ path, mtime, sha256, size, origin, deleted, content? }` (`content` en base64, absent si `deleted`) |
| `dimotic/data/inventaire/demande` | une machine qui démarre, se reconnecte, ou sur « Resynchroniser » | `{ from, at }` |
| `dimotic/data/inventaire/<machine>` | chaque machine, en réponse à une demande | `{ from, files: [{ path, mtime, sha256, size, deleted }] }` — suppressions comprises (§7) |
| `dimotic/data/demande/<machine>` | une machine qui veut des fichiers d'une autre | `{ from, paths: [...] }` |

`origin`/`from`/`<machine>` = `core.machineId`. QoS 1, `retain: false` partout. Chaque core s'abonne
à `dimotic/data/#` et ignore ses propres messages.

## 5. Émission

1. **Surveillance** de `data/` (récursive), regroupement des modifications sur **2 s**.
2. Pour chaque fichier reproductible modifié (ou supprimé) : empreinte ; si elle diffère de la
   dernière connue pour ce chemin → envoi sur `dimotic/data/fichier/<machine>` (une fois ; seules les
   machines allumées le reçoivent — les autres le récupèrent par l'inventaire, §6).
3. **Au démarrage, à chaque reconnexion MQTT et sur « Resynchroniser »** : demande d'inventaire.
   Pendant **10 s**, les inventaires reçus sont comparés au local, chemin par chemin ; pour chaque
   chemin plus récent ailleurs, une demande est adressée à **la** machine qui a la version la plus
   récente ; les chemins plus récents en local sont envoyés d'office.
4. **Réponse à une demande** : les fichiers demandés sont envoyés un par un (espacés de 200 ms pour ne
   pas encombrer le broker, les images de plan comprises).

## 6. Réception d'un fichier

| Situation | Action |
|---|---|
| empreinte identique au fichier local | rien |
| message plus récent que le fichier local (ou fichier absent) | l'ancienne version locale va dans l'historique (§7), le fichier est écrit (`.tmp` puis renommage), sa date est mise à `mtime` ; l'empreinte est mémorisée pour que la surveillance ne le renvoie pas |
| message plus ancien que le fichier local | rien (la machine émettrice le récupérera par l'inventaire) |
| `deleted` plus récent | le fichier local va dans l'historique puis est supprimé |
| même date, empreintes différentes | départage stable : l'`origin` le plus grand (ordre alphabétique) gagne |

**Limite assumée** : une modification n'atteint une machine éteinte que si, à son retour, **au moins
une machine qui la possède est allumée** (ha2, toujours en marche, joue ce rôle en pratique).

**Horloges** : « le plus récent gagne » suppose des machines à l'heure (NTP) ; un message daté de plus
de 5 min dans le futur est signalé.

## 7. Historique local et suppressions

`data/core/machine_diffusion/historique/<chemin>.<horodatage>` — les **5** dernières versions par
fichier. Jamais reproduit (D1). Permet de revenir en arrière après un écrasement non voulu.

Les **suppressions** sont notées dans `data/core/machine_diffusion/suppressions.yaml` (chemin, date,
machine) et figurent dans l'inventaire (30 jours), pour qu'une machine éteinte au moment de la
suppression ne fasse pas « revivre » le fichier à son retour.

## 8. Fichiers propres à une machine et secrets — migrations

### 8.1 Trois fichiers de configuration par application, superposés par le core

Pour chaque application (core compris), dans `data/<app>/` :

| Fichier | Contenu | Reproduit |
|---|---|---|
| `config.yaml` | réglages communs à toutes les machines | oui |
| `machine_config.yaml` | réglages propres à la machine (port série, chemins locaux, identifiant…) | non (D1) |
| `secrets_config.yaml` | mots de passe, jetons, clés d'API | non (D6) |

**Le core s'en charge** (décision utilisateur, 29/09/2026) — il lit et écrit déjà seul tous les
`config.yaml` (`ConfigLoader.mergeAppSections`, `ConfigWriter.saveModuleFile`) ; aucune application ne
lit ni n'écrit ces fichiers elle-même :
- **lecture** (`ConfigLoader`) : `config.yaml`, puis `machine_config.yaml`, puis `secrets_config.yaml`,
  fusionnés dans cet ordre (objets fusionnés clé par clé, valeurs simples et listes remplacées) ; le
  code métier voit toujours une seule section, via `IAppConfigProvider`, sans changement ;
- **écriture** (`ConfigWriter`, sauvegarde depuis l'interface ou `savePartialConfig`) : chaque clé est
  réécrite **dans le fichier où elle se trouve déjà** (§8.2) ;
- **migration** au premier démarrage de la version qui introduit la diffusion : les clés de
  l'inventaire (§8.3) trouvées dans `config.yaml` sont déplacées dans leur fichier
  (sauvegarde préalable de l'ancien `config.yaml` dans `data/core/machine_diffusion/historique/`).

### 8.2 Où va chaque réglage — sans rien dans `package.json`

**Pas de logique dans `package.json`** (refus de l'utilisateur, 29/09/2026). Règles :
- **Lecture** : fusion des trois fichiers s'ils existent — aucune déclaration nécessaire.
- **Écriture** : chaque réglage est réécrit **dans le fichier où il se trouve déjà** ; un réglage nouveau
  va dans `config.yaml`, sauf s'il porte, sur son `ConfigField` (code de l'application, `domain/index.ts`) :
  - **`storage: 'secret'`** → `secrets_config.yaml` ;
  - **`storage: 'machine'`** → `machine_config.yaml`.
- **Secret ≠ saisie masquée** (confirmé le 29/09/2026) : `storage: 'secret'` ne décide QUE du fichier
  de rangement (non reproduit) ; le masquage à l'écran reste le seul fait du type `password` du champ,
  choisi indépendamment. Un secret peut être saisi et affiché en clair (ex. mot de passe Wi-Fi de
  tasmota, D6 de sa spec) ; un champ masqué n'est pas forcément un secret.
- **Migration** (une seule fois) : l'inventaire du §8.3 est appliqué par une étape de migration du core
  à la mise en service de la diffusion (ou à la main, fichier par fichier) ; ensuite la règle « le
  réglage reste là où il est » suffit.

### 8.3 Inventaire (données réelles de falbala et schémas, 29/09/2026)

| Application | `machine_config.yaml` | `secrets_config.yaml` | Autres fichiers |
|---|---|---|---|
| **core** | `core.machineId`, `core.site`, `ha.*` (sauf secrets), `web.*`, `logging.*`, `disabledApps`, `knownApps` | `ha.ws.token`, `ha.mqtt.password` | reproduits dans `config.yaml` : `core.appGossipIntervalSeconds`, `targets`, `haStackTargets`, `zigbee2mqttTargets`, `externalSites` ; `ssh/` → `machine_ssh/` ; `ha-structure-*.yaml` → `machine_ha-structure-*.yaml` |
| arbreouquoi | — | — | tout reproduit |
| arexx | — | — | `drivers/` → `machine_drivers/` (code d'arexx à adapter) ; capteurs reproduits |
| espdisplay | `remote.host`, `remote.sshUser`, `remote.sshKeyPath`, `esphomeContainer`, `esphomeConfigDir`, `pipelineScriptPath`, `pythonBin` | — | — |
| evoo7 | — | `box.password` | données reproduites |
| haplan | — | — | plans et images reproduits (D5) |
| ia | `ollamaHttpPort` | `mistralApiKey`, `anthropicApiKey` | règles, gabarits, vocabulaire reproduits ; `comparatif.log` → `machine_comparatif.log` |
| nommage | — | `sources[].mqtt.password` (ancienne forme, migrée en `prefixes`) | traductions reproduites |
| outils | — | — | `saved-values/` reproduit, **sauf** les valeurs de variables sensibles (nom contenant `PASS`, `PASSWORD`, `TOKEN`, `KEY`, `SECRET`) → `saved-values/secrets_<id>.json` (code d'outils à adapter) |
| planificateur | — | — | macros et planifications reproduites |
| rfxcom | `port`, `baudRate` | — | fichier des appareils → `machine_config-rfxcom-devices-v1.0.yaml` (code de rfxcom à adapter) |
| rpigpio | — | `mqtt.password` | broches reproduites |
| sauvegarde | — | — (le mot de passe Nextcloud est déjà hors de `data/`, `/dimotic-secrets/`) | reproduit |
| scriptsha | — | — | reproduit |
| supervision | — | — | `selection.yaml` reproduit (déjà diffusé aussi par MQTT) |
| tasmota | — | `wifi.password` | `rules.yaml` reproduit |
| teleinfo | — | `mqtt.password` | reproduit (`gpio`, `serialPort` décrivent le RPi1 cible, pas la machine qui exécute) |
| testcycle | — | — | reproduit |

## 8bis. Applications externes : dépendances et compilation sur place (D8)

Une application déposée (ou reçue par la diffusion) dans `data/applications/<app>/` n'a que ses
sources (`package.json`, `package-lock.json`, `tsconfig*.json`, `src/`…). Le core, à la détection :

1. si `node_modules/` est absent, ou si `package.json`/`package-lock.json` sont plus récents que la
   dernière installation (repère `node_modules/.dimotic-install`) → `npm install` dans le dossier ;
2. si `dist/` est absent ou plus ancien que `src/` → `npm run build` ;
3. compte rendu dans *Gestion des applications* (état « dépendances en cours d'installation »,
   « compilation en échec » avec la sortie) ; l'application ne peut être activée qu'une fois prête ;
   bouton **Réinstaller / recompiler** pour forcer.

`dist/` sous `data/applications/` n'est donc pas reproduit non plus (chaque machine compile) — à
confirmer (§10). Nécessite `npm` dans l'image Docker (présent : image `node`) et l'accès au dépôt
npm depuis la machine.

## 9. Prise en compte par les applications et interface

- **`config.yaml` d'une application reçu** : le core recharge la configuration et émet
  `app:module:config:saved` `{ moduleId, success: true }` — le même événement qu'une sauvegarde depuis
  l'interface : les applications qui savent déjà se recharger le font sans modification.
- **Autre fichier reçu** : événement `core:data:file:changed` `{ app, path, origin }` (ponté vers les
  applications en process séparé). Une application qui ne l'écoute pas prend le fichier en compte à
  son prochain démarrage — liste des applications à adapter tenue dans le TODO.
- **Interface** (*Paramètres Techniques › Diffusion des données*) : fichiers de `data/` avec leur état
  (à jour / envoyé / reçu de <machine> à <heure> / non reproduit : `machine_`, `tmp/`, > 1 Mo),
  bouton **Resynchroniser**, accès à l'historique d'un fichier.

## 10. Points ouverts — à trancher avant le code

1. ~~`data/applications/`~~ — tranché (D7) : reproduit sans ses `node_modules/`.
2. ~~Secrets~~ — tranché (D6) : fichiers `secrets_*`, non reproduits pour l'instant.
3. ~~Classement du 06/09~~ — revu le 29/09 : arbreouquoi reproduit, arexx reproduit sauf
   `machine_drivers/`, rfxcom : `port`/`baudRate` en `machine_config.yaml` (§8).
4. ~~`.bak` / `.origine.yaml`~~ — tranché (D7) : ignorés.
5. **Persistance des messages** (29/09/2026, gêne exprimée par l'utilisateur) : D2 (messages retenus,
   copie complète de `data/` conservée sur le broker) à remplacer par un échange **sans message retenu**
   (inventaires demandés au démarrage / à la reconnexion / à la resynchronisation, fichiers envoyés à la
   demande) — **validé le 29/09/2026** : §4 à §6 à réécrire en conséquence (voir ci-dessous).
6. ~~`dist/` des applications externes~~ — tranché : non reproduit (compilé sur chaque machine, §8bis).
7. ~~Fichier des appareils rfxcom~~ — tranché : `machine_…`.

## 10bis. Ordre de mise en place dans le code (décidé le 29/09/2026)

**Le core s'occupe de la diffusion** (comme des trois fichiers de configuration), et il est modifié
**en deux temps**, séparés par la migration de **toutes** les applications : la diffusion n'est mise
en service qu'une fois la dernière application migrée — aucun réglage propre à une machine ni aucun
secret ne peut donc partir avant sa migration (pas besoin de liste d'applications autorisées).

**Temps 1 — core : trois fichiers de configuration** (§8.1-§8.2) : lecture fusionnée, écriture « là
où il est », attribut `storage` sur `ConfigField`, étape de migration ; appliqué d'abord au **core
lui-même** (`data/core/config.yaml` → `machine_config.yaml` + `secrets_config.yaml` + `config.yaml`
commun ; `ssh/` → `machine_ssh/` ; `ha-structure-*` → `machine_…` ; `CONFIG_PATH` des
compose/commandes).

**Temps 2 — applications, une par une** (chacune : migration de ses clés, renommages dans son code,
prise en compte de `core:data:file:changed` si elle lit d'autres fichiers que sa config, essai) — des
plus simples aux plus sensibles :

| Ordre | Application(s) | Travail |
|---|---|---|
| 1 | **tasmota** (pilote) | `wifi.password` → secret ; relecture de `rules.yaml` reçu |
| 2 | supervision, arbreouquoi, testcycle | rien à migrer ; relecture des fichiers reçus |
| 3 | scriptsha, planificateur | relecture des fichiers reçus |
| 4 | haplan | plans + images (D5, gros fichiers) |
| 5 | ia | clés d'API → secret, `ollamaHttpPort` → machine, `comparatif.log` → `machine_…` |
| 6 | evoo7, rpigpio, teleinfo | mots de passe → secret |
| 7 | outils | valeurs sensibles → `saved-values/secrets_<id>.json` (code) |
| 8 | espdisplay | 7 réglages → machine |
| 9 | nommage, sauvegarde | vérification (rien de propre à la machine attendu) |
| 10 | arexx | `drivers/` → `machine_drivers/` (code) |
| 11 | **rfxcom** (en production sur stfort/noisy : en dernier) | `port`/`baudRate` → machine, fichier des appareils → `machine_…` (code) |

**Temps 3 — core : la diffusion** (§4-§7, §9 : surveillance, inventaires, demandes, historique,
suppressions, `core:data:file:changed`, page *Diffusion des données*), puis les **applications
externes** (§8bis : dépendances et compilation sur place).

Chaque étape : sauvegarde, commit, essai ; déploiement Docker sur les machines seulement quand
l'utilisateur le décide.

## 11. Historique

| Version | Date | Auteur | Modifications |
|---|---|---|---|
| 1.0 | 28/09/2026 | Claude | (29/09, avant validation) D5 : images de plan reproduites quelle que soit leur taille ; répertoires `*-tmp` exclus. D6-D8 : `secrets_*`, exclusions `node_modules`/`.bak`/`.origine.yaml`, applications externes compilées sur place. D2 : plus de message retenu (inventaires + demandes). §8 : trois fichiers de config superposés par le core (décidé), réglage rangé là où il est + `storage` sur `ConfigField` (rien dans `package.json`), secret ≠ saisie masquée, inventaire par application. |
| 1.0 | 28/09/2026 | Claude | Création : règle `machine_`, MQTT retenu `dimotic/data/<chemin>`, le plus récent gagne + historique, exclusions `tmp/` et > 1 Mo, migrations (core → `machine_config.yaml`, clé SSH), rechargement des applications, points ouverts. |
