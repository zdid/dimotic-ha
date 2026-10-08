# Spécifications Fonctionnelles — Application OUTILS

**Version :** 1.10
**Date :** 8 Octobre 2026
**Statut :** Document de référence pour l'application `applications/outils`

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

### 7.4 « Agent Claude Code — déploiement sur Home Assistant (SSH) » (⭐ v1.7)

Spec de conception : `conception-claude-code-automatisations` (échelle d'autorisations §5, lecture seule §6). Le script se
dépose par `scp` sur la machine visée, s'y exécute par `ssh`, puis lance `claude remote-control` dans un `screen` détaché.

| Champ | Rôle |
|---|---|
| `TARGET_HOST` / `TARGET_USER` | machine visée et compte de connexion SSH (défaut `root`) |
| `CLAUDE_USER` | compte Linux **dédié** qui exécute Claude Code (défaut `claude`) : créé s'il n'existe pas, **refusé s'il est dans `sudo`/`wheel`/`root`** ; vide = compte de connexion (déconseillé) |
| `MCP_TOKEN` / `MCP_URL` | jeton et adresse du serveur MCP de dimotic-ha de **cette** machine (`fonctionnelles-ia` §19 ; défaut `http://127.0.0.1:8765/mcp`) ; vide = pas de liaison |
| `HA_URL` / `HA_TOKEN` | **facultatifs** — accès direct à l'API Home Assistant pour **contrôler des résultats** pendant la mise au point (décision du 08/10/2026 : conservé). Compte HA dédié non-administrateur recommandé ; le jeton donne un accès complet au compte qui l'a créé |
| `HA_CONFIG_DIR` | facultatif, chemin absolu — lecture autorisée de `automations.yaml`, `scripts.yaml`, `scenes.yaml`, `configuration.yaml` ; `secrets.yaml` et `.storage` interdits ; aucune écriture |
| `SESSION_NAME`, `PERMISSION_MODE` | nom du `screen` ; `manual` (défaut) ou `acceptEdits` |
| `MODE` (⭐ v1.9) | `installer` (défaut) : tout. `mettre_a_jour_claude_md` : réécrit **seulement** le `CLAUDE.md` d'une installation existante — ni le compte, ni les jetons, ni la session ne sont touchés ; aucun jeton à ressaisir |

Au moins l'un de `MCP_TOKEN` / `HA_TOKEN` est obligatoire ; `HA_URL` l'est avec `HA_TOKEN`.

**Modèle du `CLAUDE.md`** (⭐ v1.9) : source unique `applications/ia/agent/claude-md/` (sections `00-role`, `10-dimotic-mcp`,
`20-ha-config`, `30-ha-direct`, `90-securite`, fichier `VERSION`, `LISEZ-MOI.md`), déclarée par `@outils:bundle` — le script téléchargé est
donc une archive auto-extractible qui embarque le modèle ; lancé depuis un clone du dépôt, il le trouve à côté. Il dépose le modèle
sur la machine (`/dimotic-ha-addons/agent-ha/claude-md/`, remplacé à chaque exécution, aucun secret) et y rend le `CLAUDE.md`. Variables
de rendu : `{{TARGET_HOST}}`, `{{HA_URL}}`, `{{HA_CONFIG_DIR}}`, `{{HA_TOKEN_FILE}}` (⭐ v1.10 : `./ha_token` si le script l'a installé, sinon `~/.ha_token` quand c'est le fichier déjà en place sur la machine). Sections incluses selon les choix : `10` si le MCP est relié, `20` si un
dossier de configuration est donné, `30` si un jeton Home Assistant est donné. La première ligne du fichier rendu porte la version
(`<!-- agent-claude-md vX.Y.Z — généré le … -->`). Les choix d'installation sans secret sont mémorisés dans `agent.conf` (600), relus par
le mode `mettre_a_jour_claude_md`. Un `CLAUDE.md` modifié est **pris en compte au prochain démarrage de la session** Claude Code.

**Section « Site »** (⭐ v1.10) : si `site.md` existe à côté du `CLAUDE.md` sur la machine (copie de `applications/ia/agent/claude-md/sites/<machine>.md` : connaissances propres au site et niveau d'autorisation — `ha2.md`, `dev.md`), il est **ajouté à la fin** du `CLAUDE.md` rendu. Il n'est jamais écrasé par une installation ni par le mode `mettre_a_jour_claude_md`. Modèle `VERSION` 1.2.1 (rôle : niveau 0 par défaut, « sauf indication contraire de la section Site »).

**Où est Claude Code** (⭐ v1.8) : installé normalement **dans le compte dédié** (installeur natif, `~/.local/bin/claude`, ou
npm utilisateur). Le script le cherche dans cet ordre : PATH de connexion du compte → emplacements usuels du compte
(`~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`) → PATH global ; à défaut, installation globale par npm si présent,
sinon arrêt avec un message demandant de l'installer sous le compte. Le chemin trouvé est affiché et utilisé tel quel pour lancer
le `screen`, dans un shell de connexion du compte.

**Ce que la machine reçoit** (`/dimotic-ha-addons/agent-ha/`, propriété du compte dédié, mode 700) :
- `.mcp.json` (600) : serveur MCP « dimotic », en-tête `Authorization: Bearer …` ;
- `.claude/settings.json` (600) : `allow` = lecture des quatre fichiers de configuration ; `ask` =
  `mcp__dimotic__executer_action` (confirmation à chaque appel) ; `deny` = lecture de `secrets.yaml` et `.storage/**`,
  **écriture** dans le dossier de configuration. Ces règles sont une barrière « au mieux » : la barrière réelle est le
  compte dédié et les droits de fichiers ;
- `ha_token` (600), seulement si `HA_TOKEN` est renseigné ;
- `CLAUDE.md` : rôle (niveau 0 : lit et propose, n'écrit pas dans Home Assistant), outils de dimotic-ha, accès direct
  (lecture, avec confirmation avant toute modification), sécurité.

**Première mise en œuvre** (une fois, en SSH puis `su - <compte> -c 'screen -r <session>'`) : connexion Claude.ai, confiance
du dossier, **approbation du serveur MCP du projet**, activation du Remote Control ; détacher par `Ctrl-A D`. Ensuite
la session se retrouve dans l'application Claude Code (onglet « Code ») du même compte Claude.ai.

**Limites** : la session s'arrête si la machine redémarre (relancer le script) ; la copie du script déposée (elle contient les
jetons saisis) est **supprimée dès la fin**, succès ou échec ; un jeton contenant un guillemet ou un `$` n'est pas pris en
charge (valeurs insérées telles quelles dans le script). Éprouvé en simulation (`screen`/`claude`/`useradd` simulés) : création du
compte, fichiers et droits, JSON valides, refus d'un compte sudo, validations locales. **Non vérifié** : exécution réelle sur
une machine et lancement effectif de Claude Code.

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
| 1.10 | 08/10/2026 | Claude | Script « Agent Claude Code » : section « Site » (`site.md`) ajoutée au `CLAUDE.md` rendu, variable `{{HA_TOKEN_FILE}}` (`~/.ha_token` si déjà en place) (§7.4). |
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
