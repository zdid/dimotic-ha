# Spécifications Fonctionnelles — Application OUTILS

**Version :** 1.14
**Date :** 28 Octobre 2026
**Statut :** Document de référence pour l'application `applications/outils`

> **v1.14 (28/10/2026)** — **« Installer l'IA sur une machine Home Assistant »** (`installer-ia`, §7.4) **remplace** « Agent Claude Code —
> déploiement sur Home Assistant (SSH) » (`agent-ha-deploy`, retiré). Exigence (MEMO_mise-en-place-ia-screen_2026-10-28) : l'IA marche du premier coup,
> sans SSH ; seule étape manuelle, la connexion au compte Claude. Le script se lance SUR la machine, lit tout sur place (site, Home Assistant, MCP),
> active le MCP de `ia` sur l'IP réseau (jeton généré), pré-répond aux premières questions de Claude Code, installe une session permanente
> (screen « claude » + Remote Control « <site> automatisation HA ») et prépare le panneau « IA » (screen_console) sans assistant. Décisions du 28/10 :
> **plus d'accès direct à Home Assistant par jeton** (MCP seul ; section `30-ha-direct` du modèle retirée, modèle v1.3.0), compte `claude` **avec**
> sudo sans mot de passe et docker. Script carte SD (§7.2) : l'option `claude-code` pose en plus l'installateur et un **minuteur de premier démarrage**.
>
> **v1.13 (26/10/2026)** — nouveau script intégré **« Gérer les images de cartes SD/clés USB »** (`images-sd`, §7.5) : menu sur les
> images déjà créées par le script carte SD — **1) écrire** une image de machine sur une carte sans rien reconstruire, **2) supprimer** une
> image (machine, base, échec, officielle), **3) monter** une image sous `/mnt/image-<nom>` (lecture seule par défaut).
> Script carte SD (§7.2) : intégration **`screen_console`** ajoutée aux intégrations HA, paquet **`screen`** à la liste des paquets.
> **Saisie DuckDNS + Caddy simplifiée** : 10 champs remplacés par des cases à cocher des adresses connues (cible déjà remplie) et une saisie libre `nom`, `nom:port` ou `nom=machine:port` (machine vide = la carte elle-même).
> **Chemins en `~`** (clé personnelle, clé du compte claude, image Orange Pi) : s'ils sont absents de `$HOME` (cas d'un lancement par « Exécution par SSH » en root, `$HOME = /root`), ils sont cherchés dans `/home/*` et pris chez le seul utilisateur qui les a ; plusieurs : note et chemin complet à donner.
> **`/docker/dimotic-ha/data` et `logs` donnés à l'uid 1000** dans l'image de base (utilisateur `node` du conteneur) : créés en root, ils bloquaient le démarrage du cœur (`EACCES … mkdir '/app/data/core'`, constaté sur noisy3).
> **root par mot de passe** (demande explicite) : avec `SSH_DURCISSEMENT=oui`, `PermitRootLogin yes` et bloc `Match User <utilisateur>,root` ; root reçoit le **même mot de passe** que l'utilisateur (haché : `chpasswd` de cloud-init en trixie, `/etc/shadow` de l'image en bookworm et Orange Pi) ; mot de passe toujours refusé pour les autres comptes, contrôlé dans l'image (`sshd -T` pour l'utilisateur, root et un autre compte).
> Nouveau script intégré **« Durcir l'accès d'une machine (SSH + fail2ban) »** (`durcissement-acces`, §7.6).
>
> **v1.12 (26/10/2026)** — script « Carte SD / clé USB » (§7.2) : **cases à cocher** pour préparer une machine complète sans rien
> démarrer — services Docker (`SERVICES` : homeassistant, zigbee2mqtt, mosquitto, dimotic-maj, portainer-agent, **whisper**, **piper**),
> intégrations Home Assistant (`INTEGRATIONS_HA` : hacs, dimotic_taxonomie, dimotic_plans), comptes (`COMPTES` : didier, claude),
> options du système (`OPTIONS_SYSTEME` : rotation des journaux Docker, fuseau Paris, dossier de sauvegarde Nextcloud, WireGuard, **Claude Code**) et
> **accès externe DuckDNS + Caddy** (jeton, 2 adresses externes à choisir dans la liste de noisy/stfort, machine et port). Nouveau fichier
> `scripts/sd-extras.sh`, modèles `scripts/modeles/`, nouveau mode `extras-machine` de `prepare-sd-card.sh`. 22 tests.

> **v1.11 (12/10/2026)** — script « Agent Claude Code » (§7.4) : **Claude Code sans suivi de la souris** dans le compte dédié — `export CLAUDE_CODE_DISABLE_MOUSE=1` ajouté (idempotent) à `~/.bashrc` du compte, et `env CLAUDE_CODE_DISABLE_MOUSE=1` dans la commande de lancement du screen. Raison : dans un terminal web (console HA, SCREEN2HTTP) les clics laissaient la fin d'une séquence (`60;46m`) dans la saisie ; un Claude Code relancé à la main dans le screen n'avait pas la variable. Ne concerne que les nouvelles installations (mode « installer »).
> **v1.11 (suite, 12/10/2026)** — même script : nouveau champ facultatif **`DIMOTIC_DATA_DIR`** (défaut `/docker/dimotic-ha/data`, vide = aucun accès) : le compte dédié reçoit la **lecture/écriture des données de dimotic-ha par ACL** (`setfacl -R -m u:<compte>:rwX`, puis `-R -d` pour les futurs fichiers ; paquet `acl` installé au besoin), PUIS un **refus explicite** (`u:<compte>:---`, y compris par défaut pour les dossiers) sur les secrets : `secrets_*`, `.mcp_token`, `id_ed25519`/`id_rsa`, `sauvegarde/config.yaml`, `core/machine_ssh/`, `outils/saved-values/`. L'ordre est impératif (le refus passe en dernier). Un refus nommé l'emporte sur des droits « autres » en 644 (cas réel constaté sur ha2 : quatre `secrets_config.yaml` lisibles par tous). Le modèle du `CLAUDE.md` passe en 1.2.3 (site ha2 : données de dimotic-ha modifiables, secrets exclus, code jamais). Pour une installation existante : poser les ACL à la main puis lancer le mode « mettre_a_jour_claude_md ».

> **v1.9 (08/10/2026)** — script « Agent Claude Code » (§7.4) : le `CLAUDE.md` n'est plus écrit en dur dans le script mais **rendu à partir d'un
> modèle versionné du dépôt** (`applications/ia/agent/claude-md/`, embarqué dans l'archive) ; nouveau **mode `mettre_a_jour_claude_md`** qui
> ne réécrit que ce fichier sur une installation existante.

> **v1.8 (08/10/2026)** — script « Agent Claude Code » (§7.4) : Claude Code est **cherché dans le compte dédié** (installation
> habituelle : `~/.local/bin`), plus seulement dans le PATH de `root`.

> **v1.7 (08/10/2026)** — script « Agent Claude Code » (`agent-ha-deploy`, §7.4) **aligné sur la conception Claude Code** :
> compte Linux dédié sans sudo, liaison avec le serveur MCP de dimotic-ha, permissions posées (lecture seule sur la
> configuration de Home Assistant, secrets exclus, confirmation avant toute action), jeton Home Assistant **facultatif**.

> **v1.6 (07/10/2026)** — script « Carte SD / clé USB » (§7.2) : **fail2ban et durcissement SSH** installés dans l'image
> (comme stfort : root par clé seulement, mot de passe refusé sauf pour l'utilisateur du profil, fail2ban sur le journal
> systemd) et **Orange Pi Zero 2 / 4 Pro** gérées à partir de l'image officielle Debian bookworm téléchargée à la main.
> Nouveaux champs du formulaire : `SSH_DURCISSEMENT`, `FAIL2BAN_IGNOREIP`, `IMAGE_ORANGEPI`.
>
> **v1.5 (30/09/2026)** — « Commit + push + tag + build Docker » : **un seul format de version, `X.Y.Z`**,
> proposé, affiché et saisi (le script proposait `v3.3.4` mais annonçait « la version 3.3.4 » : taper
> `3.4.0` était refusé). Le `v` saisi reste accepté ; le tag git garde son `v` (`vX.Y.Z`).

> **v1.4 (29/09/2026)** — script **« Configurer un appareil Tasmota (à distance) » retiré** (ancien §7.3,
> demande utilisateur) : entièrement repris par l'application `tasmota` (fiche « Appliquer », mise à jour
> OTA, recherche et mise en service des Tasmota inconnus — `fonctionnelles-tasmota_specs` v1.2).

> **v1.3 (28/09/2026)** — nouveau script intégré **« Configurer un appareil Tasmota (à distance) »**
> (§7, §7.3, demande utilisateur : « un script qui ne me laisse que les variables ») : configuration
> par l'interface web de l'appareil, installation standard Tasmota.

> **v1.2 (26/09/2026)** — **Carte SD Raspberry Pi : un seul script** (§7.2, demande utilisateur) :
> « Préparer et écrire une carte SD/clé USB Raspberry Pi » remplace les deux scripts « 1/2 —
> Préparer » et « 2/2 — Flasher ». Toutes les questions au départ (WiFi compris), une seule pause pour
> choisir la carte avec possibilité de s'arrêter ; les installations lourdes se font dans une **image
> de base préparée dans qemu et gardée en cache** (plus sur la carte physique) ; **trixie-lite
> (cloud-init) par défaut**, bookworm-lite conservé. Progression du téléchargement : une ligne tous
> les 250 blocs (la page Outils semblait figée).

> **v1.1 (25/09/2026)** — **Exécution par SSH** à côté du téléchargement (§5.5, décisions
> utilisateur) : Outils se connecte lui-même à la machine choisie avec la clé SSH de dimotic-ha, y
> copie le script et le lance ; sortie affichée en direct, réponses aux questions du script tapées
> dans la page. Champ facultatif `execution` dans le `.yaml` (§3.1). La sécurité de cette
> exécution (confirmation, journal, restriction d'accès) est notée au TODO, pas encore traitée (§9).

> **v1.0 (25/09/2026)** — première spécification formelle, écrite à partir du code en service
> (application livrée le 18/09/2026, restructurée le 20/09/2026, revue de code le 24/09/2026) et à
> la demande de l'utilisateur, qui compte s'en servir de plus en plus (compilation, images Docker,
> et des scripts sans rapport avec dimotic-ha).

---

## 1. Objet

Outils est une **bibliothèque de scripts shell paramétrables**. L'utilisateur choisit un script dans
une liste, remplit un formulaire construit automatiquement à partir du script lui-même, puis
télécharge le script prêt à l'emploi et la commande pour le lancer (souvent avec `sudo`).

**Principe fondateur : l'application ne connaît le contenu d'aucun script.** Un script se décrit
lui-même (variables, listes de choix, cases à cocher, aides, valeurs par défaut) par des
commentaires spéciaux (§4). Ajouter un script ne demande **jamais** de modifier le code de
l'application. Les scripts peuvent n'avoir aucun rapport avec dimotic-ha.

Outils génère le script, que l'utilisateur télécharge et lance lui-même — **ou**, depuis la v1.1,
qu'Outils **exécute par SSH** sur la machine choisie (§5.5).

---

## 2. Intégration dans le socle

| Élément | Valeur |
|---------|--------|
| Identifiant | `outils` |
| Type | `standalone`, audience `configuration` |
| Process | séparé (`runsAsSeparateProcess: true`, `standalone.ts`) |
| MQTT / WebSocket HA | non (`requiredMqtt: false`, `requiredHaWs: false`) |
| Menu | *Paramètres Techniques › Outils* → page « Bibliothèque de scripts » (`presentation/index.html`) |
| Configuration | aucune (`outilsConfigSchema` vide, conservé pour la signature standard) — pas de formulaire générique |
| Événement ponté | `outils:internal:upload` (`bridgedEvents`) — dépôt de fichier relayé par le core |

Routes HTTP génériques du core utilisées (`presentation/server/index.ts`) :
- `POST /api/apps/outils/upload` — dépôt d'un fichier (yaml, wrapper, moteur, zip), relayé à
  l'application par `outils:internal:upload`.
- `GET /api/apps/outils/download/:token` — téléchargement d'une archive préparée côté serveur
  (`data/outils/tmp/downloads/<token>` + `<token>.meta.json`), fichier supprimé après téléchargement.

---

## 3. Stockage des scripts

Un script = un **triplet de fichiers**, dans l'une de deux arborescences parallèles :

```
<racine>/yaml/<id>.yaml      métadonnées (§3.1)
<racine>/wrappers/<id>.sh    le script proposé au téléchargement (variables + directives, §4)
<racine>/scripts/            bassin partagé de « moteurs » : fichiers réels embarqués par
                             @outils:bundle (§5.2), partageables entre plusieurs scripts
```

| Racine | Emplacement | Contenu | Modifiable depuis l'écran |
|--------|-------------|---------|---------------------------|
| **Intégrée** | `applications/outils/reposcripts/` (dépôt git, donc dans l'image Docker) | scripts livrés avec dimotic-ha | non (ni ajout ni suppression) |
| **Ajoutée** | `data/outils/reposcripts/` (propre à chaque machine, hors git) | scripts déposés par l'utilisateur | oui |

La liste affichée fusionne les deux. Un identifiant intégré prime toujours ; déposer un script
ajouté avec l'identifiant d'un script intégré est refusé.

### 3.1 Métadonnées (`<id>.yaml`, `outilScriptSchema`)

| Champ | Rôle | Contrainte |
|-------|------|------------|
| `id` | clé technique, sert à construire les chemins de fichiers | lettres, chiffres, `-`, `_` ; commence par une lettre ou un chiffre (⭐ 24/09/2026) |
| `title` | titre affiché dans la liste | non vide |
| `description` | description affichée dès la liste | texte libre |
| `filename` | nom du fichier téléchargé (ex. `flash-sd-card.sh`) | lettres, chiffres, `.`, `-`, `_`, sans `/` ni `..` (⭐ 24/09/2026) |
| `requiresSudo` | la commande proposée est `sudo bash <filename>` au lieu de `bash <filename>` | booléen, `false` par défaut |
| `execution` | ⭐ v1.1 — facultatif : `{ machine, utilisateur, dossier }` présélectionne la machine (identifiant du gossip ou adresse), l'utilisateur SSH (défaut `root`) et le dossier de travail de l'exécution par SSH (§5.5), ex. « Commit + push » et « Compiler » : `{ machine: falbala_817412, utilisateur: didier, dossier: /home/didier/ownCloud/dimotic-ha }` — sous `root`, git refuserait le dépôt d'un autre utilisateur et les fichiers créés lui appartiendraient | objet facultatif, champs facultatifs |

Un `<id>.yaml` illisible ou invalide est ignoré individuellement (les autres scripts restent listés).

**Bonne pratique** (retour utilisateur du 18/09/2026) : tout comportement systématique ou par défaut
d'un script doit être dit dans sa `description` (visible dès la liste), pas seulement dans une aide
de champ (visible seulement après sélection).

---

## 4. Auto-description d'un script (wrapper)

### 4.1 Variables

Toute occurrence `__NOM__` (majuscules, chiffres, `_`) est une variable : un champ est créé dans le
formulaire, dans l'ordre de première apparition. La génération remplace chaque `__NOM__` par la
valeur saisie. Aucune déclaration séparée : le script **est** sa propre définition.

### 4.2 Directives (commentaires `# @outils:...`)

| Directive | Effet sur le formulaire |
|-----------|-------------------------|
| `# @outils:hint NOM = texte` | aide affichée sous le champ `NOM` (champ texte si rien d'autre) |
| `# @outils:select NOM = a, b, c` | liste déroulante ; valeur substituée = l'option choisie |
| `# @outils:checklist NOM = a, b` | cases à cocher ; valeur substituée = options cochées **jointes par des virgules** (une seule option `oui` → `oui` si cochée, vide sinon : c'est le motif « case à cocher » utilisé par les scripts, testé par `[ -n "$NOM" ]`) |
| `# @outils:default NOM = valeur` | valeur initiale d'un champ texte ou option présélectionnée d'un `select` (sans effet sur `checklist`) |
| `# @outils:bundle <chemin> [=> <destination>]` | fichier ou dossier du dépôt à embarquer avec le script (§5.2) |

Exemple :

```bash
# @outils:hint COMMIT_TITLE = Résumé court du commit.
# @outils:select VERSION_BUMP = mineur, patch, majeur
# @outils:default VERSION_BUMP = mineur
# @outils:checklist BUILD_DOCKER = oui
VERSION_BUMP="__VERSION_BUMP__"
```

---

## 5. Génération et téléchargement

La substitution des variables se fait **dans le navigateur** (le contenu du wrapper lui est envoyé à
la sélection). Si des variables sont restées vides, l'écran demande confirmation avant de
télécharger. Trois formes de téléchargement :

### 5.1 Script seul (`.sh`)

Script sans directive `@outils:bundle` : téléchargement direct du texte substitué, sans aller-retour
serveur.

### 5.2 Archive auto-extractible (`@outils:bundle`)

Pour un script qui a besoin de fichiers réels du dépôt pour fonctionner hors d'un clone (ex.
pipeline carte SD : `flash-sd-card.js`, `node_modules/js-yaml`, clé SSH publique…). Le serveur
(`BundleBuilder.buildBundle`) produit un seul `.sh` : un petit en-tête bash d'extraction + une
archive `.tar.gz` collée après le marqueur `__ARCHIVE_BELOW__` (technique type *makeself*).
- `run.sh` (script substitué) + chaque chemin déclaré, copiés tels quels dans une arborescence
  miroir de la racine du dépôt (liens symboliques déréférencés).
- Extraction vers un emplacement **fixe** (`${XDG_CACHE_HOME:-$HOME/.cache}/dimotic-ha-outils`),
  jamais purgé : deux scripts en plusieurs phases (préparer / flasher) y retrouvent les mêmes
  fichiers.
- Les chemins embarqués sont relus depuis le **gabarit** du script côté serveur, jamais depuis le
  contenu envoyé par le navigateur.

### 5.3 Archive `.zip`

Proposée pour **tout** script : wrapper substitué + son `<id>.yaml` + les éventuels fichiers
`@outils:bundle`. Sert aussi à **partager un script ajouté entre sites** (import §6.2).

### 5.4 Valeurs mémorisées

Les dernières valeurs saisies pour un script sont enregistrées
(`data/outils/saved-values/<id>.json`) et reproposées à la sélection suivante — seulement pour un
script réellement connu (⭐ 24/09/2026).

### 5.5 Exécution par SSH (⭐ v1.1)

Bouton **« ▶️ Exécuter par SSH »** à côté de « Générer et télécharger », mêmes valeurs de variables.

| Décision (25/09/2026) | Contenu |
|---|---|
| Où | **par SSH uniquement** — jamais localement dans le process/conteneur de dimotic-ha (en Docker, le script ne pourrait rien faire sur la machine hôte) ; pour agir sur la machine locale, on la vise par SSH comme une autre |
| Machines proposées | celles du **gossip** (`app:remote-apps`, adresse annoncée) + la **machine locale** + une **saisie libre** (hôte + utilisateur, `root` par défaut) pour une machine sans dimotic-ha |
| Clé | la clé unique de dimotic-ha (`data/core/ssh/id_ed25519`) ; prérequis `ssh-copy-id` **affiché à l'écran**, comme pour les autres applications (bloc commun `renderSshPrepSection`, hôte choisi déjà substitué) |
| Questions du script | sortie affichée **en direct** ; un champ permet de **répondre** : le texte tapé est envoyé au script comme dans un terminal (SSH avec pseudo-terminal, `-tt`) ; bouton **Arrêter** |
| Présélection | champ `execution` du `.yaml` (§3.1) : machine, utilisateur et dossier de travail proposés, modifiables |

Déroulé côté serveur : script substitué (ou archive auto-extractible §5.2 pour un script
`@outils:bundle`) écrit dans un fichier temporaire → copié par `scp` en `/tmp/outils-<run>.sh` sur la
machine → `ssh -tt <utilisateur>@<hôte> "cd <dossier> && bash /tmp/outils-<run>.sh"` (fichier distant
supprimé à la fin) → code de retour affiché. Pas de délai maximal (script interactif, arrêt manuel).

---

## 6. Ajout et suppression de scripts

### 6.1 Ajout par dépôt de fichiers

Trois dépôts séparés, reliés par un identifiant de lot (`batchId`, généré par le navigateur) :
- `yaml` (obligatoire) — les métadonnées ;
- `wrapper` (obligatoire) — le script `.sh` ;
- `engine` (facultatif) — un fichier moteur déposé dans le bassin `scripts/`.

Le script est enregistré dès que yaml **et** wrapper sont arrivés. Un lot incomplet est oublié après
10 minutes. Refus (message lisible) si : yaml invalide, identifiant ou nom de fichier non conforme
(§3.1), identifiant déjà pris par un script intégré, nom de fichier moteur non conforme.

### 6.2 Import d'un `.zip`

Un `.zip` exporté par §5.3 (depuis ce site ou un autre) : seuls le `.yaml` et le wrapper qu'il
désigne (`filename`) sont lus ; les dépendances `@outils:bundle` ne sont pas réimportées.
L'archive n'est jamais extraite telle quelle : aucun chemin disque n'est construit à partir d'un nom
d'entrée de l'archive, uniquement à partir de `id`/`filename` validés.

### 6.3 Suppression

Scripts ajoutés uniquement (yaml + wrapper). Un script intégré ne peut pas être retiré. Un fichier
moteur partagé n'est pas supprimé (il peut servir à d'autres scripts).

---

## 7. Scripts intégrés (état au 28/09/2026)

| Id | Titre | sudo | Rôle |
|----|-------|------|------|
| `prepare-sd-card` | Préparer et écrire une carte SD/clé USB Raspberry Pi | oui | ⭐ v1.2 — voir §7.2 (archive auto-extractible). Remplace « 1/2 — Préparer » et « 2/2 — Flasher » (`flash-sd-card`, retiré). |
| `duckdns-caddy` | Accès externe (DuckDNS + Caddy) | oui | Domaines DuckDNS + reverse proxy HTTPS |
| `agent-ha-deploy` | Agent Claude Code — déploiement sur Home Assistant (SSH) | non | ⭐ v1.7 — voir §7.4 : Claude Code dans un `screen`, compte dédié, MCP dimotic-ha, Remote Control. |
| `build-all` | Compiler toutes les applications dimotic-ha | non | ⭐ 25/09/2026 — compilation locale : core puis chaque application (serveur + écrans), option `npm install`, arrêt et nom de la première application en échec. **Sans** `npm prune` (réservé à l'image Docker) |
| `commit-push-docker` | Commit + push + tag + build Docker | non | Voir §7.1 |

### 7.1 « Commit + push + tag + build Docker »

À lancer depuis un clone du dépôt. Étapes, avec confirmation avant chaque action irréversible :
1. `git add -A`, commit (titre obligatoire s'il y a des modifications), push. Rien à committer : on
   passe directement à la suite (⭐ 25/09/2026).
2. Case « construire Docker » cochée :
   - **compilation de vérification** de toutes les applications (même boucle que `build-all`) —
     un échec arrête tout **avant** le tag (⭐ 25/09/2026 : sans elle, une application qui ne
     compile pas faisait échouer l'image après le push du tag) ;
   - tag proposé depuis le plus haut `vX.Y.Z` du dépôt **par numéro de version**, selon le type
     choisi : **mineur** par défaut, patch ou majeur ; numéro proposé et saisi sous la forme **`X.Y.Z`**
     (⭐ v1.5 : un `v` devant est accepté et ignoré, le tag git est `vX.Y.Z`) ; refus d'un format
     invalide ou d'une version existante ;
   - tag annoté + push du tag, puis `./docker/rebuild-and-deploy.sh X.Y.Z --build-only`
     (construction multi-architecture et publication, **aucun déploiement** sur les machines).

La compilation réelle de l'image se fait dans le conteneur (`Dockerfile` → `docker/build-apps.sh`) ;
rien de compilé localement n'entre dans l'image (`.dockerignore`).

### 7.2 « Préparer et écrire une carte SD/clé USB Raspberry Pi » (⭐ v1.2)

Moteur : `reposcripts/scripts/flash-sd-card.js` (déroulé) + `prepare-sd-card.sh` (travail dans
l'image, jamais sur la carte). Archive auto-extractible, lancée avec `sudo` sur la machine qui
prépare (prérequis vérifiés au départ : `nodejs xz-utils qemu-user-static binfmt-support parted
e2fsprogs file openssl`).

1. **Questions, toutes au départ** : machine, modèle (Raspberry Pi, ou **Orange Pi Zero 2 / Orange Pi 4 Pro**),
   distribution (`trixie-lite` par défaut, `bookworm-lite` ; ignorée pour une Orange Pi), nom d'hôte,
   utilisateur, mot de passe, clé SSH personnelle (case), **durcissement SSH** (`SSH_DURCISSEMENT`, `oui` par
   défaut), **adresses jamais bannies par fail2ban** (`FAIL2BAN_IGNOREIP`, `192.168.0.0/16` par défaut ; 127.0.0.1 et
   ::1 toujours incluses), paquets, apps, **WiFi** (SSID vide = Ethernet, pays `FR` par défaut), et pour une Orange Pi
   le **chemin de l'image** (`IMAGE_ORANGEPI`).
2. **Image officielle** (catalogue Raspberry Pi Imager), téléchargée et vérifiée (SHA256), en cache. **Orange Pi** : pas de
   catalogue ni de téléchargement automatique (liens orangepi.org sur Google Drive/Baidu) — l'utilisateur fournit l'archive
   `.7z` (ou `.img.xz`, `.img`) ; elle est décompressée dans `data/.sd-card-image-cache/orangepi/`, et l'empreinte est
   comparée au fichier `.sha` livré par Orange Pi (calculée sans vérification s'il manque). Prérequis en plus : `7z`
   (`p7zip-full`) et `qemu-aarch64-static`. Images vérifiées : `Orangepizero2_3.1.0` (serveur) et `Orangepi4pro_1.0.6`
   (bureau XFCE) — Debian 12, **une seule partition** (racine, `/boot` dedans, U-Boot avant la partition), utilisateur
   `orangepi` par défaut, assistant de premier lancement `/root/.not_logged_in_yet`, NetworkManager.
3. **Image de base, en cache** — clé de cache : image officielle, paquets, apps, clé SSH dimotic-ha,
   `compose.deploy.yaml`, script `prepare-sd-card.sh`, contenu des device-agents. Construite une fois
   par combinaison, **dans qemu sur la machine qui prépare** (chroot, `qemu-user-static`) :
   agrandissement de 2 Go, paquets, Node.js + npm (tarball) + `serialport`/`mqtt` globaux,
   mosquitto-clients, build-essential, curl, **Docker CE** (get.docker.com, service activé au
   démarrage), `/docker/dimotic-ha/` (compose, **non démarré**), device-agents des apps (+ console
   série désactivée pour `teleinfo`), accès SSH root par la clé dimotic-ha, **fail2ban** (`fail2ban`, `python3-systemd`,
   `nftables` ; `jail.local` : 5 essais en 10 minutes puis 12 heures, `backend = systemd`, `banaction = nftables`, jail `sshd`)
   et **durcissement SSH** (drop-ins : `PermitRootLogin prohibit-password`, `PasswordAuthentication no`,
   `KbdInteractiveAuthentication no` ; `--ssh-hardening no` rétablit l'ancien `PermitRootLogin yes`). **Contrôle dans l'image** :
   `sshd -t` et `sshd -T` (root : pas de mot de passe), `fail2ban-client -t` — la construction échoue si l'un d'eux échoue.
   Sur Orange Pi (`--layout single`) : agrandissement de la partition 1, `apt-get update` toléré en cas d'échec (dépôts Orange Pi
   parfois injoignables). **Nettoyage avant
   clonage** : clés d'hôte SSH supprimées (régénérées au premier démarrage), `/etc/machine-id`
   remis à `uninitialized`, état cloud-init supprimé, cache apt vidé, binaire qemu retiré.
4. **Image de la machine** (quelques secondes) : copie creuse de la base, puis :
   - **Durcissement par machine** (tous les modes) : seul l'**utilisateur du profil** garde le mot de passe SSH — bloc
     `Match User <utilisateur>` tout à la **fin** de `sshd_config` (comme stfort) — et un drop-in
     `fail2ban/jail.d/zz-ignoreip.local` porte les adresses jamais bannies. Sur `trixie-lite` (cloud-init), `write_files`
     ajoute ces deux fichiers et **`ssh_pwauth` n'est volontairement pas écrit** (cloud-init ajouterait sa ligne
     `PasswordAuthentication` après le bloc `Match`, donc dans sa portée, et couperait le mot de passe de cet utilisateur) ;
     avec `SSH_DURCISSEMENT=non`, `ssh_pwauth: true` comme avant. Vérifié avec le vrai `sshd -T -C user=…` : root et les autres
     refusés, l'utilisateur du profil accepté ;
   - **Orange Pi** (mode `opi-machine`, dans l'image, via chroot) : nom d'hôte, fuseau Europe/Paris, **utilisateur du
     profil créé** (groupes sudo, docker, dialout…, mot de passe haché passé par l'environnement `PASSWORD_HASH`),
     utilisateur `orangepi` par défaut **supprimé**, **mot de passe root verrouillé** (accès root par clé), assistant de premier
     lancement désactivé (`/root/.not_logged_in_yet` retiré — `orangepi-firstrun-config` n'a alors plus d'objet), clés
     personnelles pour root et l'utilisateur, WiFi par une connexion NetworkManager, clés d'hôte SSH recréées au premier
     démarrage par `orangepi-firstrun`. Le système s'agrandit seul à la carte (`orangepi-resize-filesystem`) ;
   - `trixie-lite` — **cloud-init** sur bootfs : `user-data` (nom d'hôte, fuseau Europe/Paris,
     clavier fr, utilisateur avec mot de passe chiffré SHA-512 et clés perso, clés perso ajoutées à
     root, `disable_root: false`, `ssh_pwauth: true`), `network-config` (WiFi, netplan v2),
     `meta-data` (`instance-id` unique par machine) + fichier `ssh`. Format vérifié sur l'image
     officielle 2026-09-15 (NoCloud lu sur `/boot/firmware`, création de l'utilisateur par
     `userconf-pi`) ;
   - `bookworm-lite` (pas de cloud-init) — fichier `ssh` + `userconf.txt` sur bootfs, nom d'hôte,
     clés perso (root + utilisateur) et WiFi (`imager_custom set_wlan`, NetworkManager) dans rootfs.
5. **Pause : choix de la carte** (amovibles de taille non nulle, taille ≥ image) — `q` ou Entrée
   **pour s'arrêter là**, `r` pour relister. Relancer avec la même machine et les mêmes réponses
   reprend **directement** à ce choix (image de la machine réutilisée si le profil est identique).
6. **Écriture** (`dd`). L'agrandissement à la taille de la carte se fait au premier démarrage.

Rien n'est installé au premier démarrage : il ne fait que la configuration propre à la machine
(pas besoin d'Internet pour démarrer ; WiFi requis seulement pour être joignable).

#### Cases à cocher : services, intégrations, comptes, options, DuckDNS + Caddy (⭐ v1.12)

But (demande utilisateur, 26/10/2026) : préparer en une fois la carte d'une machine de remplacement (ex. le Pi4 4 Go qui
remplace noisy2) avec tout ce qui doit s'y trouver. **Décision : tout est posé, rien n'est démarré** (aucun conteneur dans
l'image) — la machine reçoit ensuite sa configuration par la restauration (application Sauvegarde) ou à la main, et deux machines
ne portent jamais la même identité par accident. Aucune image Docker n'est préchargée (HA seule fait plus de 2 Go) : elles
sont téléchargées au premier démarrage des services.

Champs ajoutés au formulaire (listes à cocher, sauf mention) et champs du profil correspondants :

| Champ | Profil | Effet |
|---|---|---|
| `SERVICES` | `services` | `/docker/<service>/` avec son `compose.yaml` (modèles `scripts/modeles/`, tirés des machines réelles) : `homeassistant`, `zigbee2mqtt` (dongle `/dev/ttyUSB0`, variable `ZIGBEE_DEVICE`), `mosquitto` (+ `config/mosquitto.conf`), `portainer-agent`, `whisper` (`rhasspy/wyoming-whisper`, `small-int8`, français, port 10300) et `piper` (`rhasspy/wyoming-piper`, voix `fr_FR-siwis-medium`, port 10200) ; `dimotic-maj` active le profil `maj` du compose de dimotic-ha (`COMPOSE_PROFILES=maj` dans `/docker/dimotic-ha/.env`). Les dossiers `config/`, `data/` sont créés. |
| `INTEGRATIONS_HA` | `integrationsHa` | Dans `/docker/homeassistant/config/custom_components/` : `hacs` (dernière release `hacs/integration`), `dimotic_taxonomie`, `dimotic_plans` et **`screen_console`** (⭐ v1.13, dépôt `dimotic-ha-screen-console` : console `screen` dans HA ; paquet `screen` à cocher aussi dans `PACKAGES`, clé SSH et script de contrôle `screen-console-gate` posés ensuite en suivant l'assistant de l'intégration) (dernière release GitHub de `zdid/dimotic-ha-taxonomie` et `zdid/dimotic-ha-plans`). Exige `homeassistant` coché. L'ajout dans HA (Paramètres > Appareils et services) reste à faire. |
| `COMPTES` | `accounts` | `didier` (sudo, docker, clés personnelles) et `claude` (sudo sans mot de passe, docker, clé publique `CLAUDE_SSH_KEY` / `claudeSshKey`), **connexion par clé seulement** ; le compte identique à l'utilisateur principal du profil est ignoré. |
| `OPTIONS_SYSTEME` | `options` | `rotation-journaux-docker` (`/etc/docker/daemon.json`, 10 Mo × 5), `fuseau-paris`, `sauvegarde-nextcloud` (paquets `cron` `tar` ; **script, mot de passe d'application et horaire posés par machine** — voir la ligne suivante), `wireguard` (paquet `wireguard-tools`, `/etc/wireguard/` vide — configuration à poser), `claude-code` (**Claude Code installé** pour tous les comptes par `npm install -g @anthropic-ai/claude-code` dans l'image de base ; système **64 bits** seulement, refusé sinon ; ⭐ v1.14 : **installateur de l'IA posé par machine** — `/dimotic-ha-addons/agent-ha/installer-ia.sh` (valeurs par défaut du formulaire) + modèle `claude-md/`, service `dimotic-installer-ia` lancé par un **minuteur** 3 min après le démarrage puis toutes les 5 min en mode `--auto` : « pas encore prêt » (code 75) tant que dimotic-ha (restauration) ou Home Assistant manquent, minuteur retiré une fois tout en place — voir §7.4 ; la connexion au compte Claude reste manuelle). |
| `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_DOSSIER`, `SAUVEGARDE_SITE` (liste noisy/stfort), `SAUVEGARDE_MACHINE` (vide = nom d'hôte), `NEXTCLOUD_MOT_DE_PASSE` | `sauvegarde` | **Obligatoires si `sauvegarde-nextcloud` est coché.** Le script `/dimotic-backup/nextcloud-backup.sh` est rendu par le **vrai générateur** de l'application Sauvegarde (`BackupScript.js` embarqué dans l'archive, `sauvegarde-rendu/rendre.js`, `shellQuote` fourni par un shim) : c'est celui que « Pousser » déposerait. Le script **ne contient pas** le mot de passe : il le lit dans `/dimotic-secrets/nextcloud-backup` (600, dossier 700), écrit à partir de `NEXTCLOUD_MOT_DE_PASSE` (champ sensible, masqué à l'affichage, passé par l'environnement). Le cron (`5 3 * * *`, journal `/dimotic-backup/cron.log`) est dans le **crontab de root**, comme « Pousser », donc un « Pousser » ultérieur le retrouve sans doublon. |
| `DUCKDNS_TOKEN` (texte) | `duckdns.token` | Jeton du compte DuckDNS ; vide = ni DuckDNS ni Caddy. Écrit dans le script de mise à jour (mode 700), **masqué** à l'affichage du profil. |
| `DUCKDNS_ADRESSES` (cases à cocher) | `duckdns.domains[]` | ⭐ v1.13 — **adresses connues, cible déjà remplie** (relevées le 26/10/2026 sur les Caddy de noisy et de Saint Fort) : `dimotic-noisy-ha → 192.168.1.201:8123`, `dimoticnoisy → 192.168.1.62:8081`, `dimotic-stfort-ha → 192.168.1.51:8123`, `dimoticloud → 192.168.1.13:11000`. |
| `DUCKDNS_AUTRES` (texte) | `duckdns.domains[]` | ⭐ v1.13 — autres adresses séparées par des espaces : `nom` (cette carte, port 8123), `nom:port` (cette carte) ou `nom=machine:port` ; **machine vide = la carte elle-même** (`localhost`, Caddy étant en `network_mode: host`), port vide = 8123 ; `.duckdns.org` accepté et retiré. Conversion par `extras_duckdns_entrees` (`sd-extras.sh`). Plus de limite à deux adresses ; une même adresse deux fois est refusée. (Avant v1.13 : `DUCKDNS_DOMAINE_1/2`, `_AUTRE`, `DUCKDNS_MACHINE_1/2`, `_AUTRE`, `DUCKDNS_PORT_1/2`, soit 10 champs.) |

DuckDNS : un script de mise à jour et un cron (toutes les 5 minutes) par domaine (`/dimotic-ha-addons/duckdns/<domaine>.sh|.cron`,
lien dans `/etc/cron.d/`, comme le script « Accès externe »), `/docker/caddy/Caddyfile` (un bloc `reverse_proxy` par domaine) et
`compose.yaml` de Caddy ; **Caddy est ajouté automatiquement** aux services dès qu'un domaine est rempli.

Mise en œuvre : `prepare-sd-card.sh base` reçoit `--services`, `--integrations`, `--options` (dans l'**image de base**, donc dans
sa clé de cache : `BASE_RECIPE_VERSION` 3 + empreinte de `sd-extras.sh` et de `modeles/`) ; le nouveau mode **`extras-machine`**
(comptes et DuckDNS, propres à la machine, quel que soit le modèle de Pi) tourne après la personnalisation de la machine, le jeton
DuckDNS passant par l'environnement et jamais par la ligne de commande. Le moteur (`flash-sd-card.js`) valide les valeurs (liste
fermée, 2 domaines au plus, nom `[a-z0-9-]+`, cible `hôte:port`, intégrations sans `homeassistant` refusées, `claude` sans clé
refusé). **Tests** : `PrepareSdCardExtras.test.ts` (22) — champs du formulaire, pose des services/intégrations/options sur une racine
factice, DuckDNS (jeton jamais affiché, droits 700), comptes, archive piégée refusée, profil du moteur. **Pas encore éprouvé** : une
construction réelle de l'image de base avec ces options (qemu) et le démarrage d'une carte ainsi préparée.

### 7.4 « Installer l'IA sur une machine Home Assistant (Claude Code) » (⭐ v1.14, remplace « Agent Claude Code » de la v1.7)

Script `installer-ia` (`reposcripts/wrappers/installer-ia.sh`), **lancé sur la machine** qui porte Home Assistant et dimotic-ha
(`sudo`, ou « Exécution par SSH ») ; modèle du `CLAUDE.md` embarqué (`@outils:bundle applications/ia/agent/claude-md`).
Exigence de l'utilisateur : ouvrir le panneau « IA » de Home Assistant et y trouver Claude Code branché sur le MCP de dimotic-ha,
**sans commande SSH ni manipulation sur la machine** ; seule étape manuelle admise : la **connexion au compte Claude par le web**.

| Champ | Défaut | Rôle |
|---|---|---|
| `MODE` | `installer` | `installer` : tout, relançable sans dommage. `mettre_a_jour_claude_md` : réécrit seulement le `CLAUDE.md` puis relance la session |
| `CLAUDE_USER` | `claude` | compte qui exécute Claude Code ; créé s'il manque, **sudo sans mot de passe et groupe docker** (décision du 28/10/2026) |
| `DIMOTIC_DIR` | `/docker/dimotic-ha` | dimotic-ha (compose + `data/`) |
| `HA_CONFIG_DIR` | `/docker/homeassistant/config` | configuration de Home Assistant (lecture de 4 fichiers autorisée, `secrets.yaml` et `.storage` interdits, aucune écriture) |
| `FICHE_SITE` | `automatique` | fiche `sites/<nom>.md` ajoutée en `site.md` (jamais écrasée si présente) ; automatique : `ha2` pour le site `stfort`, `noisy2` pour `noisy` |
| `NOM_SESSION` | vide | nom de la session dans le Remote Control ; vide = **« <site> automatisation HA »** (site lu dans `data/core/machine_config.yaml`) |
| `ADRESSE_MACHINE` | vide | IP réseau de la machine pour le MCP ; vide = adresse de la route par défaut ; **jamais 127.0.0.1** |
| `PERMISSION_MODE` | `default` | `default` ou `acceptEdits` |

**Lu sur la machine, rien à saisir** : site (`core.site`), adresse de Home Assistant (`ha.ws.host`/`port` de `data/core/config.yaml`),
jeton de dimotic-ha (`ha.ws.token` des secrets du cœur, pour créer l'entrée de l'intégration), réglages MCP de `ia`.

**Étapes** (chacune vérifie l'existant) :
1. paquets `screen`, `acl`, `python3`, `curl`, `openssh-client` ; compte `claude` ; données de dimotic-ha en lecture/écriture par ACL, **secrets refusés**
   (`secrets_*`, `sauvegarde/config.yaml`, `core/machine_ssh/`, `outils/saved-values/`) ;
2. Claude Code : cherché dans le compte puis globalement ; sinon **installeur natif** dans le compte ;
3. **MCP de `ia`** (`fonctionnelles-ia` §19) : `mcpEnabled: true`, `mcpHost` = IP de la machine, jeton `mcpToken` généré s'il manque (fichiers
   sauvegardés avant), redémarrage de dimotic-ha si quelque chose a changé ; contrôle par une requête `initialize` ;
4. dossier de travail **`/dimotic-ha-addons/agent-ha`** (700, au compte) : `CLAUDE.md` (modèle v1.3.0 + `site.md`), `.mcp.json` (serveur `dimotic`,
   `http://<IP>:8765/mcp`, jeton), `.claude/settings.json` (`enabledMcpjsonServers: ["dimotic"]`, `ask` = `executer_action`, règles de lecture de HA),
   `lancer-claude.sh` ;
5. **premières questions pré-répondues** dans `~/.claude.json` du compte (service arrêté avant, copie de sauvegarde) : accueil terminé, thème,
   **confiance du dossier** et **approbation du serveur `dimotic`** pour ce dossier ;
6. **service `claude-screen`** : `screen -DmS claude lancer-claude.sh` → `claude --remote-control "<nom>" --permission-mode …`
   (`CLAUDE_CODE_DISABLE_MOUSE=1`), **`Restart=always`** : la session revient après un `/exit`, un plantage ou un redémarrage. La même session est
   dans le panneau « IA » (screen `claude`) et dans le Remote Control (claude.ai/code, application Claude, onglet « Code ») ;
7. **panneau « IA »** (si l'intégration `screen_console` est dans `custom_components`) : paire de clés créée à l'endroit où l'intégration la lit
   (`<config>/.storage/screen_console_ed25519`, réutilisée par `ensure_key`), script de contrôle `~claude/bin/screen-console-gate` (`list`/`attach`
   seulement), ligne `authorized_keys` limitée (`from="127.0.0.1,::1"`, `command=…`, sans redirections), **entrée de l'intégration créée par l'API de
   HA** (flux `config_entries/flow`, compte `claude`) si elle n'existe pas. Exception à la règle « jamais localhost » : la console se connecte en SSH
   à la machine elle-même (`LOOPBACK_HOSTS` de l'intégration), adresse qui ne se diffuse pas.

**Mode `--auto`** (minuteur posé par la carte SD, §7.2) : aucune question ; code **75** (« pas encore prêt ») si dimotic-ha n'est pas configuré,
`ia` pas initialisée, réseau absent, MCP muet ou intégration pas encore chargée par HA ; une fois tout en place, le minuteur
`dimotic-installer-ia.timer` est désactivé.

**Test de réception** (fait le 28/10/2026 sur opi4pro, site stfort, machine déjà en service) : code 0 ; session « claude » ouverte dans le
compte déjà connecté, **aucune question** affichée, `/rc active` (Remote Control « stfort automatisation HA »), `claude mcp list` : `dimotic`
**connecté**. **Non éprouvé** : machine neuve (création du compte, installeur natif, entrée de l'intégration par l'API), mode `--auto` depuis une carte.

### 7.5 « Gérer les images de cartes SD/clés USB » (⭐ v1.13)

`reposcripts/wrappers/images-sd.sh` (+ `yaml/images-sd.yaml`), archive auto-extractible lancée avec `sudo` depuis un vrai
terminal, **sans aucune question au départ** : un menu en boucle, qui affiche à chaque fois la **liste de toutes les images** puis les trois actions. Il travaille sur le **même dossier** que le script carte SD
(§7.2) — l'archive s'extrait dans le dossier fixe `~/.cache/dimotic-ha-outils` (utilisateur réel, même sous `sudo`), images dans
`data/.sd-card-image-cache/`. Il n'est donc utile que sur la machine qui a préparé les images.

Types d'images listés (type, chemin relatif, taille, date) : **machine** (`prepared/<machine>.img`), **échec** (`*.echec`,
`*.partial`), **base** (`base/*.img`), **officielle** (`*.img`, `*.img.xz` à la racine, `orangepi/`).

1. **Écrire une image de machine sur une carte** — seules les images *machine* sont proposées (une image de base n'a pas
   d'identité). Même choix de périphérique que §7.2 (amovibles ou USB de taille non nulle, trop petit signalé et refusé,
   `r` pour relister, Entrée pour revenir), avec en plus les **points de montage** de chaque disque (« ⚠️ EN SERVICE, monté
   sur … ») ; confirmation en retapant le nom exact du périphérique ; partitions démontées puis `dd` (bs=4M, `conv=fsync`),
   `sync`, `partprobe`.
2. **Supprimer une image** — tous types ; confirmation en retapant le nom du fichier ; refus si l'image est attachée à un
   périphérique loop ; une image *machine* emporte son `.profile.json`. Le message rappelle la conséquence (base reconstruite
   dans qemu, image officielle retéléchargée, image de machine recréée en quelques secondes).
3. **Monter une image** — tous types sauf compressés (`.xz`, `.7z`) ; **lecture seule par défaut** (`losetup -r`, `mount -o ro`),
   lecture-écriture sur demande ; chaque partition reconnue par `blkid` montée sous `/mnt/image-<nom>/` (`boot` pour vfat,
   `racine` pour ext*/btrfs/f2fs) ; Entrée démonte tout et détache le loop ; démontage aussi sur Ctrl+C ou sortie. Refus si
   `/mnt/image-<nom>` existe déjà.

**Vérifié** (sans root, faux dossier d'images) : listes, suppression (avec `.profile.json`), liste des périphériques et refus du
montage sans droits. **Non vérifié** : écriture réelle sur une carte et montage réel (root nécessaire).

### 7.6 « Durcir l'accès d'une machine (SSH + fail2ban) » (⭐ v1.13)

`reposcripts/wrappers/durcissement-acces.sh` (+ `yaml/durcissement-acces.yaml`), script seul lancé avec `sudo` sur une machine
**déjà installée** (ou par « Exécution par SSH »), **à passer après l'installation** : la carte (§7.2) laisse root se connecter
par mot de passe pour faciliter l'installation, ce script le **supprime** (demande explicite, 26/10/2026).

Champs : `UTILISATEUR` (`didier` par défaut : seul compte qui garde le mot de passe SSH ; doit exister et avoir un mot de passe,
sinon arrêt), `FAIL2BAN_IGNOREIP` (`192.168.0.0/16` par défaut). **root : par clé seulement**, sans option
(`PermitRootLogin prohibit-password`, root hors du bloc Match) ; son mot de passe n'est pas modifié (utile en console) ;
avertissement si `/root/.ssh/authorized_keys` ne contient aucune clé.

Déroulé : vérifications ; **sauvegarde** de `/etc/ssh`, `/etc/fail2ban` et `/etc/shadow` dans `/root/durcissement-acces-<date>/` ;
drop-in `sshd_config.d/01-dimotic-durcissement.conf` (`PermitRootLogin prohibit-password`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no` — préfixe `01-` pour passer avant les drop-ins de la carte ou un `50-cloud-init.conf`, sshd
gardant la première valeur lue ; ligne `Include` ajoutée si absente) ; bloc `Match User <utilisateur>` **entre repères** en fin de
`sshd_config` (remplacé à chaque passage) ; **contrôles avant rechargement** (`sshd -t`, `sshd -T` : mot de passe oui pour
l'utilisateur, non pour root et pour un autre compte ; `PermitRootLogin`) — en cas d'échec, **configuration d'origine remise en
place** et rien n'est rechargé ; fail2ban installé si absent (`fail2ban`, `python3-systemd`, `nftables`), `jail.local` identique
aux cartes + `jail.d/zz-ignoreip.local`, `fail2ban-client -t` ; rechargement de SSH (`systemctl reload`, sessions ouvertes
conservées), fail2ban activé et redémarré ; bilan (comptes avec mot de passe, clés de root, ports ouverts).

**Vérifié** dans un conteneur Debian bookworm jetable (vrai `sshd`, `50-cloud-init.conf` à `yes` présent : root et un autre compte
refusés, l'utilisateur accepté, second passage sans doublon), et **sur noisy3** (26/10/2026, version précédente avec root par mot
de passe : script complet réussi, méthodes réellement proposées par le serveur vérifiées par de nouvelles connexions).

### 7.3 (retiré en v1.4)

Le script « Configurer un appareil Tasmota (à distance) » (v1.3) est retiré : l'application `tasmota`
fait tout ce qu'il faisait (état de l'appareil, modèle, MQTT/noms/heure/position, mise à jour OTA,
vérification), et davantage (liste stockée, publication vers HA, règles, modes). Le fichier reste dans
l'historique git (commit d'avant le 29/09/2026).

---

## 8. Événements Socket.io

| Événement | Sens | Rôle |
|-----------|------|------|
| `outils:status:get` / `outils:status` | client → serveur / serveur → client | liste des scripts (persistant, rejoué à la connexion) |
| `outils:script:get` / `outils:script:result` | ↔ | détail : contenu, variables, directives, valeurs mémorisées, yaml, `hasBundling` |
| `outils:bundle:build` / `outils:bundle:result` | ↔ | archive auto-extractible `{success, token, filename}` (§5.2) |
| `outils:zip:build` / `outils:zip:result` | ↔ | archive `.zip` (§5.3) |
| `outils:script:delete` / `outils:script:delete:result` | ↔ | suppression (§6.3) |
| `outils:values:save` | client → serveur | valeurs mémorisées (§5.4), sans réponse |
| `outils:script:add:result` | serveur → client | résultat d'un ajout ou d'un import (§6) |
| `outils:error` | serveur → client | erreur de lecture d'un script |
| `outils:exec:start` / `outils:exec:started` | ↔ | ⭐ v1.1 — lancer une exécution `{id, content, host, user, dossier}` → `{runId}` (§5.5) |
| `outils:exec:output` | serveur → client | morceau de sortie `{runId, chunk}` |
| `outils:exec:input` | client → serveur | réponse tapée `{runId, text}` (envoyée suivie d'un retour à la ligne) |
| `outils:exec:cancel` | client → serveur | arrêter l'exécution `{runId}` |
| `outils:exec:end` | serveur → client | fin `{runId, code, error?}` |

---

## 9. Sécurité

- La page n'a pas d'authentification propre (comme le reste de l'interface) : tout poste du réseau
  local peut déposer un script. D'où le contrôle strict des identifiants et noms de fichiers
  (§3.1, ⭐ 24/09/2026) : un identifiant `../../core/config` écrivait auparavant hors de
  `data/outils`.
- Un script téléchargé est exécuté par l'utilisateur, souvent avec `sudo` : Outils ne vérifie pas
  ce que fait un script ajouté. Ne déposer que des scripts de confiance.
- Les téléchargements préparés côté serveur (§5.2/§5.3) passent par un jeton, jamais par un chemin.
- ⭐ v1.1 — **Exécution par SSH (§5.5)** : elle donne un accès `root` à distance depuis une page web
  sans mot de passe, ouverte au réseau local. **Décision utilisateur (25/09/2026) : réalisée telle
  quelle, sécurisation notée au TODO** — confirmation affichant script + machine + utilisateur avant
  lancement, journal de chaque exécution (qui, quand, où, code de retour) dans `data/outils/`,
  éventuellement exécution autorisée seulement depuis localhost ou derrière un mot de passe.

---

## 10. Limites connues

- Pas d'édition d'un script depuis l'écran : le modifier = le supprimer puis le redéposer (script
  ajouté) ou changer le dépôt git (script intégré, pris en compte à la prochaine image).
- L'import `.zip` ne réimporte pas les dépendances `@outils:bundle`.
- Un vrai téléchargement `.sh` depuis une URL HTTP (archive §5.2) peut déclencher l'avertissement
  « fichier potentiellement dangereux » de Chrome.
- `checklist` n'accepte pas de valeur par défaut (`@outils:default` ignoré pour ce type) : le durcissement SSH est donc un
  `select` (`oui` par défaut) et non une case à cocher.
- **Orange Pi : conçu et vérifié sur les images (structure, outils présents, empreintes) mais pas encore éprouvé sur une
  carte réelle** — le chroot (QEMU), l'agrandissement et le premier démarrage sont à valider au premier flashage. Les apps
  pré-installées (agent teleinfo, console série) ne sont pas gérées sur ces images. Image du 4 Pro : variante « bureau »
  (5,8 Go, XFCE) fournie ; une variante serveur est préférable pour un usage sans écran.
- **fail2ban sur Trixie / Orange Pi** : configuration contrôlée dans l'image, mais l'effet réel (bannissement) n'a été
  observé que sur Raspbian 10 / Debian 12 hors de ce script.

---

## 11. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.13 | 26/10/2026 | Claude | Nouveaux scripts intégrés **« Gérer les images de cartes SD/clés USB »** (§7.5 : écrire, supprimer, monter) et **« Durcir l'accès d'une machine (SSH + fail2ban) »** (§7.6) ; carte SD : `screen_console`, saisie DuckDNS simplifiée, root par mot de passe à l'installation (même que l'utilisateur ; retiré ensuite par §7.6), `data/`/`logs/` de dimotic-ha à l'uid 1000, chemins `~` cherchés dans `/home`. v1.12 archivée. |
| 1.12 | 26/10/2026 | Claude | Script « Carte SD » : **cases à cocher** (services Docker dont Whisper/Piper, intégrations HA, comptes didier/claude, options système, **DuckDNS + Caddy** avec 2 adresses externes), tout posé et non démarré (§7.2). v1.11 archivée. |
| 1.10 | 08/10/2026 | Claude | Script « Agent Claude Code » : section « Site » (`site.md`) ajoutée au `CLAUDE.md` rendu, variable `{{HA_TOKEN_FILE}}` (`~/.ha_token` si déjà en place) (§7.4). |
| 1.11 | 12/10/2026 | Claude | Script « Agent Claude Code » : souris de Claude Code désactivée (`CLAUDE_CODE_DISABLE_MOUSE=1` dans `~/.bashrc` du compte dédié et dans la commande de lancement du screen). Champ `DIMOTIC_DATA_DIR` : ACL lecture/écriture sur les données de dimotic-ha, secrets refusés ; modèle `CLAUDE.md` 1.2.3. |
| 1.9 | 08/10/2026 | Claude | **Modèle versionné du `CLAUDE.md`** (§7.4) : `applications/ia/agent/claude-md/`, embarqué par `@outils:bundle`, rendu sur la machine ; nouveau mode `mettre_a_jour_claude_md` (réécrit seulement le `CLAUDE.md`, sans ressaisir de jeton) ; `agent.conf` mémorise les choix sans secret. v1.8 archivée. |
| 1.8 | 08/10/2026 | Claude | **Claude Code cherché dans le compte dédié** (§7.4) — PATH de connexion, `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, puis PATH global ; installation npm globale seulement en dernier recours ; lancement par chemin résolu dans un shell de connexion. v1.7 archivée. |
| 1.7 | 08/10/2026 | Claude | **Script « Agent Claude Code » aligné sur la conception** (§7.4) : compte dédié sans sudo (`CLAUDE_USER`), liaison avec le serveur MCP de dimotic-ha (`MCP_TOKEN`/`MCP_URL`), permissions posées (lecture seule sur la configuration Home Assistant via `HA_CONFIG_DIR`, secrets exclus, confirmation d'`executer_action`), jeton Home Assistant **facultatif** (conservé pour contrôler des résultats), copie du script supprimée après exécution. v1.6 archivée. |
| 1.6 | 07/10/2026 | Claude | Script « Carte SD » : **fail2ban + durcissement SSH** dans l'image et par machine (champs `SSH_DURCISSEMENT`, `FAIL2BAN_IGNOREIP`), **Orange Pi Zero 2 / 4 Pro** (image officielle fournie à la main, `IMAGE_ORANGEPI`, mode `opi-machine`, image à une partition) (§7.2) ; **Docker activé explicitement au démarrage** dans l'image (get.docker.com échoue dans un chroot) ; **en cas d'échec de construction l'image est conservée** (`*.echec`) et les commandes d'un terminal interactif dedans (mode `shell` de `prepare-sd-card.sh`, local ou `ssh -t`) sont affichées. v1.5 archivée. |
| 1.5 | 30/09/2026 | Claude | Version de l'image : format unique `X.Y.Z` proposé/affiché/saisi (`v` accepté), tag git `vX.Y.Z` (§7.1). v1.4 archivée. |
| 1.4 | 29/09/2026 | Claude | Script « Configurer un appareil Tasmota (à distance) » retiré (§7.3), repris par l'application `tasmota`. v1.3 archivée. |
| 1.3 | 28/09/2026 | Claude | Script intégré « Configurer un appareil Tasmota (à distance) » (§7.3). v1.2 archivée. |
| 1.2 | 26/09/2026 | Claude | **Carte SD Raspberry Pi en un seul script** (§7.2) : questions au départ (WiFi compris), image de base préparée dans qemu et gardée en cache (installations hors de la carte), nettoyage avant clonage (clés d'hôte SSH, machine-id, cloud-init), trixie-lite par cloud-init par défaut + bookworm-lite, pause unique pour choisir la carte avec arrêt possible et reprise directe ; `flash-sd-card` retiré. Progression du téléchargement allégée. v1.1 archivée. |
| 1.1 | 25/09/2026 | Claude | **Exécution par SSH** (§5.5) : bouton à côté du téléchargement, machines du gossip + locale + saisie libre, clé de dimotic-ha avec prérequis `ssh-copy-id` affiché, sortie en direct et réponses tapées (pseudo-terminal), champ `execution` du `.yaml` pour présélectionner machine et dossier ; sécurisation reportée (TODO). v1.0 archivée. |
| 1.0 | 25/09/2026 | Claude | Première spécification formelle, à partir du code (livraison 18/09, restructuration en triplets et deux racines 20/09, contrôle des identifiants et chemins 24/09) ; nouveau script intégré `build-all` et `commit-push-docker` mis à jour (compilation de vérification avant le tag, type de version mineur/patch/majeur, dernier tag par numéro de version, suite sans commit) le 25/09/2026. |
