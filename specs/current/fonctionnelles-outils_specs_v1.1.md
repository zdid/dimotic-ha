# Spécifications Fonctionnelles — Application OUTILS

**Version :** 1.1
**Date :** 25 Septembre 2026
**Statut :** Document de référence pour l'application `applications/outils`

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

## 7. Scripts intégrés (état au 25/09/2026)

| Id | Titre | sudo | Rôle |
|----|-------|------|------|
| `prepare-sd-card` | 1/2 — Préparer une image carte SD/clé USB Raspberry Pi | oui | Pipeline de provisionnement, phase 1 (archive auto-extractible) |
| `flash-sd-card` | 2/2 — Flasher une carte SD/clé USB Raspberry Pi | oui | Phase 2 : flash + installation de base (Docker, dimotic-ha, Node, mqtt…) |
| `duckdns-caddy` | Accès externe (DuckDNS + Caddy) | oui | Domaines DuckDNS + reverse proxy HTTPS |
| `agent-ha-deploy` | Agent Claude Code — déploiement sur Home Assistant (SSH) | non | Préparation d'un agent sur une machine HA |
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
     choisi : **mineur** par défaut, patch ou majeur ; numéro modifiable ; refus d'un format
     invalide ou d'un tag existant ;
   - tag annoté + push du tag, puis `./docker/rebuild-and-deploy.sh X.Y.Z --build-only`
     (construction multi-architecture et publication, **aucun déploiement** sur les machines).

La compilation réelle de l'image se fait dans le conteneur (`Dockerfile` → `docker/build-apps.sh`) ;
rien de compilé localement n'entre dans l'image (`.dockerignore`).

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
- `checklist` n'accepte pas de valeur par défaut (`@outils:default` ignoré pour ce type).

---

## 11. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.1 | 25/09/2026 | Claude | **Exécution par SSH** (§5.5) : bouton à côté du téléchargement, machines du gossip + locale + saisie libre, clé de dimotic-ha avec prérequis `ssh-copy-id` affiché, sortie en direct et réponses tapées (pseudo-terminal), champ `execution` du `.yaml` pour présélectionner machine et dossier ; sécurisation reportée (TODO). v1.0 archivée. |
| 1.0 | 25/09/2026 | Claude | Première spécification formelle, à partir du code (livraison 18/09, restructuration en triplets et deux racines 20/09, contrôle des identifiants et chemins 24/09) ; nouveau script intégré `build-all` et `commit-push-docker` mis à jour (compilation de vérification avant le tag, type de version mineur/patch/majeur, dernier tag par numéro de version, suite sans commit) le 25/09/2026. |
