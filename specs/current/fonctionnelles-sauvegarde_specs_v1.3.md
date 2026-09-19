# Spécifications Fonctionnelles - Sauvegarde/Restauration (SAUVEGARDE)

**Version 1.3 — 18/09/2026 — Claude**

Statut : **chantier A (§5/§5bis/§5ter) écrit et vérifié localement (pas encore en conditions réelles
sur une vraie machine/vrai Nextcloud) ; chantier B (§6) en cours d'implémentation, restauration
(§6bis) en conception active**. Cette version amende profondément §4/§4quater (unité de sauvegarde
et arborescence Nextcloud, simplifiées à nouveau), §5/§5bis (le script existe enfin,
`applications/sauvegarde/src/domain/BackupScript.ts`), §6 (déploiement du script + pose du cron
ajoutés au bouton « Pousser », configuration entièrement rapatriée sur Paramètres Techniques) et
§6bis (première conception concrète de la restauration, plusieurs décisions actées). Suite directe
de la v1.2 (emplacement fixe du secret, tag persistant), qui amendait déjà v1.1 (arborescence
Nextcloud) et v1.0 (conception d'origine). Première version : extraite d'une discussion avec
l'utilisateur le 16/09/2026, elle-même issue d'un point de résilience laissé ouvert dans
`fonctionnelles-supervisor_specs_v2.8.md` §6.4 et suivi jusqu'ici uniquement dans `TODO.md`
("🟡 Sauvegarde/duplication multi-machines de HA lui-même").

---

## 1. Origine du besoin

`fonctionnelles-supervisor_specs_v2.8.md` §6.4 a identifié que le vrai point de dépendance critique
du système entier n'est pas le broker MQTT partagé (décision : ne pas chercher à le rendre résilient,
il est colocalisé avec HA — sa panne implique presque toujours celle de HA) mais **HA lui-même** :
le perdre veut dire perdre le cerveau du système (toute la découverte MQTT/ESPHome le cible). Remonter
une instance HA reste impératif quelle que soit l'architecture de supervision choisie par ailleurs.

À cela s'ajoute un second constat, plus large : chaque application métier de dimotic-ha a aujourd'hui
sa propre stratégie de sauvegarde de ses données locales (`data/{app}/`), au cas par cas (rfxcom,
rpigpio, evoo7 mentionnés comme ayant déjà quelque chose), jamais systématisée ni vérifiée exhaustive
application par application.

Cette spec couvre **tout logiciel Docker déployé sur les machines du foyer**, HA, dimotic-ha et
services tiers (zigbee2mqtt en premier lieu) traités par le **même** mécanisme générique — voir §4.

## 2. Destination retenue

Le Nextcloud auto-hébergé de l'utilisateur (tourne sur un Raspberry Pi 4 du site stfort — voir
`TODO.md`, "Incident carte SD Pi4"), **lui-même dupliqué offsite sur un autre site**.

Décision explicite : ne pas construire de mécanisme de réplication supplémentaire — cette duplication
offsite existe déjà, est déjà fiable et utilisée quotidiennement (le dépôt `dimotic-ha` lui-même vit
dans ce Nextcloud sur la machine de développement `falbala`). Réutiliser cette infrastructure évite
un nouveau système à maintenir/faire confiance.

## 3. Mécanisme de transport

**Push direct depuis chaque machine**, plutôt qu'un rapatriement centralisé par `falbala` — décidé
après avoir noté que `falbala` est la seule machine réellement synchronisée avec Nextcloud
aujourd'hui ; un rapatriement centralisé en ferait un intermédiaire obligatoire et un nouveau point
de fragilité pour toutes les autres machines.

- **Protocole** : WebDAV natif de Nextcloud (`https://<nextcloud>/remote.php/dav/files/<user>/<chemin>`).
  Un simple `curl -T <fichier> -u <user>:<app_password> <URL>` suffit — aucun client de synchro lourd
  à installer.
- **Pourquoi ce choix plutôt qu'un client dédié (Nextcloud client, rclone...)** : uniformité — un seul
  mécanisme pour toutes les machines, **y compris le RPi1 le plus contraint** (ARMv6, ne peut pas
  faire tourner la stack moderne du socle — voir `fonctionnelles-supervisor_specs_v2.8.md` §11 pour
  le même raisonnement appliqué à la présence). `curl` est déjà disponible partout.
- **Authentification** : un mot de passe d'application Nextcloud **dédié par machine** (pas le compte
  principal de l'utilisateur) — révocable indépendamment, périmètre limité.

### 3bis. Gestion des mots de passe d'application — tranché (16/09/2026)

- **Création** : manuelle, une fois par machine, via l'interface Nextcloud (Paramètres > Sécurité >
  Créer un nouveau mot de passe d'application) — pas d'API stable pour la créer par script sans
  session authentifiée/2FA, donc une étape humaine assumée, pas automatisable ici. À faire au fil de
  la mise en œuvre, pas un audit préalable à finir avant de commencer (même principe que §4bis).
- **Stockage sur chaque machine** : dans un fichier **au niveau de l'hôte**, en dehors de **tout**
  répertoire couvert par la sauvegarde elle-même (§4) — chemin **fixe**, `/dimotic-secrets/
  nextcloud-backup` (⭐ amendé 17/09/2026, remplace l'ancien exemple `/docker/.secrets/
  nextcloud-backup` : `/dimotic-secrets/` est un **troisième parent dédié** à la racine, au même
  niveau que `/docker/` et `/dimotic-ha-addons/` §4ter, plutôt qu'un chemin arbitraire niché sous
  `/docker/` — même bénéfice structurel, nom qui rejoint la convention du reste du projet). Permissions
  restrictives (`chmod 600`, lisible seulement par l'utilisateur qui exécute le script hôte, voir
  §5bis). Choix structurel plutôt qu'une exclusion à maintenir dans une liste (§4bis) : le secret n'est
  simplement jamais sous un chemin que le script parcourt, donc rien à exclure. Ce même fichier est la
  source pour le script hôte (§5bis) **et** pour l'application dimotic-ha (§6) — un seul exemplaire du
  secret par machine, pas deux copies à maintenir en cohérence.
- **Jamais dans `data/<app>/config.yaml`** de l'application dimotic-ha dédiée (§6) : sa config ne
  garde même plus de référence de chemin (⭐ amendé 17/09/2026 — le chemin est désormais fixe partout,
  rien à référencer), seulement un **tag persistant** (`secretDeployed`, booléen) qui indique que la
  dernière poussée SSH vers ce fichier a réussi — jamais la valeur du secret elle-même, ni son chemin.
  Sans quoi le mot de passe se retrouverait lui-même inclus dans le contenu de la sauvegarde
  `dimotic-ha` poussée vers Nextcloud (§4), un comble pour un secret qui sert justement à y accéder.
- **Révocation** : dédié par machine (déjà acté ci-dessus) — retirer une machine du parc, ou suspecter
  une compromission, se traite en révoquant uniquement son mot de passe côté Nextcloud, sans toucher
  aux autres.
- **Rotation périodique** : non retenue comme exigence pour cette version — foyer domestique, menace
  modeste ; possible plus tard sans changement de conception (juste régénérer + remplacer le fichier
  hôte).

- **Réseau** : le WebDAV passe par le tunnel **WireGuard** déjà en place entre les sites (stfort↔noisy),
  pas par l'accès web public du cloud — plus sûr, cohérent avec le fait que ce tunnel existe déjà pour
  les usages inter-sites de dimotic-ha (gossip, etc.).
  - ⚠️ **Point de vigilance identifié** : Nextcloud rejette toute requête dont le nom d'hôte/IP
    n'est pas dans `trusted_domains` (`config.php`) — même en accès réseau interne. L'IP/nom
    WireGuard du Nextcloud devra y être ajouté, sans quoi le push échoue avec une erreur "Untrusted
    Domain" malgré une connectivité réseau correcte. À vérifier/faire à l'implémentation.

### 3ter. Différentiel vs. remplacement complet — tranché (16/09/2026)

**Remplacement complet à chaque poussée**, pas de différentiel construit par nous :

- Le RPi1 le plus contraint (`curl` seul, aucun outillage de diff) rend un vrai mécanisme
  différentiel disproportionné — même principe "rester modeste" que §11.2 de
  `fonctionnelles-supervisor_specs_v2.8.md`.
- HA produit lui-même des sauvegardes **complètes** via son système natif (pas de mode incrémental
  pilotable depuis l'extérieur) — la question ne se pose même pas à notre niveau pour ce volet.
- Pour `data/{app}/` (petits fichiers config/état), la taille d'une copie complète est négligeable.
- Nextcloud garde nativement un historique de versions sur un fichier écrasé au même chemin — un
  retour-arrière fin existe donc déjà gratuitement pour la sauvegarde "courante" (§4), sans rotation
  applicative à construire pour ce niveau-là.

## 4. Unité de sauvegarde et structure de dossiers — reconçu (16/09/2026), simplifié à nouveau (18/09/2026)

⭐ **Re-simplifié une dernière fois (18/09/2026), demande explicite** : la version précédente de
cette section (16-17/09/2026) faisait du **répertoire de déploiement** individuel (`/docker/<nom>/`,
un par application) l'unité de sauvegarde — remplacé par une unité encore plus large :

- **L'unité de sauvegarde est `/docker/` et `/dimotic-ha-addons/` PRIS ENTIERS**, chacun comme un seul
  bloc — le script ne s'occupe plus de ce qu'il y a dedans (pas de distinction par application). Au
  plus deux archives par machine et par cadence (une par parent, §4ter), en sautant celui qui
  n'existe pas sur cette machine (`test -d`).
- **Manifeste** : en listant les sous-répertoires immédiats de chaque parent avant de l'archiver, le
  script écrit un fichier de suivi daté à côté de l'archive, même radical de nom (ex.
  `docker-2026-09-18.tar.gz` + `docker-2026-09-18.manifest.txt`) — poussé sur Nextcloud avec
  l'archive (pas seulement gardé en local), pour savoir ce qu'une archive contient sans la
  télécharger/l'extraire. Sert de base à la restauration application par application (§6bis).
- **Raison du changement** : la granularité par application ajoutait de la complexité (une archive
  par répertoire de déploiement, donc N poussées WebDAV par machine) sans bénéfice retenu — le
  manifeste donne la même visibilité côté Nextcloud (on sait ce qu'une archive contient) sans avoir à
  la découper.
- **Compression** : confirmée nécessaire (tar.gz, pas tar seul) — `tar` est de toute façon requis pour
  pousser un seul fichier en un seul `curl -T` (§3), et la compression est quasi gratuite en CPU une
  fois qu'on tar, avec un vrai bénéfice sur le lien WireGuard inter-sites pour des fichiers
  texte/config/JSON/SQLite qui compressent bien.

### 4ter. Harmonisation des emplacements de déploiement — tranché (16/09/2026)

⭐ Constat en creusant §4, vérifié dans le code réel (`config-schema.ts` de chaque app) et en direct
sur les machines de production (`docker inspect`, stfort **et** noisy) :

- **Docker, déjà cohérent** : dimotic-ha, rpigpio (via mqtt-io), HA, zigbee2mqtt, modbus2mqtt vivent
  tous sous `/docker/<nom>/` — confirmé en direct pour rpigpio (`/docker/mqttio-rpigpio/config.yml`
  sur les deux machines testées). Rien à changer ici.
- **Hors Docker, dispersé** (au moment de la conception — corrigé depuis dans le code, voir
  `[[project_teleinfo_app]]` : teleinfo et arexx migrés en production le 17/09/2026) : teleinfo
  (`/opt/teleinfo`, ancien défaut du schéma) et arexx (`/root/arexx-drivers`, ancien défaut du
  schéma) — deux emplacements différents, ni l'un ni l'autre regroupé avec le reste.

**Décision** : un second parent dédié, **`/dimotic-ha-addons/`** (à la racine, comme `/docker/` —
pas niché sous `/root/`), pour tout agent géré par dimotic-ha qui **n'est pas** Docker (teleinfo,
arexx, et tout futur agent du même genre). Résultat : deux conventions parallèles et propres au lieu
de trois emplacements dispersés — `/docker/<app>/` pour ce qui est Docker, `/dimotic-ha-addons/<app>/`
pour les agents bruts (systemd/RPi contraint) — plutôt qu'un seul parent unique qui mélangerait les
deux natures de déploiement sous un nom trompeur.

**Bénéfice direct pour cette spec** : le script de sauvegarde (§5bis) peut **énumérer** le contenu de
ces deux parents plutôt que de connaître une liste de chemins en dur par application — cohérent avec
le principe déjà posé "un seul script générique, réutilisé sans code spécifique par répertoire" (§5).

**Portée du changement** : nouveau défaut pour les **futures** cibles teleinfo/arexx (`config-schema.ts`,
`remoteDir`) — même principe que le changement de défaut `bridgeInstance`, déjà appliqué ailleurs dans
le projet. ⭐ 17/09/2026 : les cibles réelles de production (teleinfo sur 192.168.1.183, arexx/bs510
sur 192.168.1.10) ont depuis été migrées manuellement vers cette nouvelle convention — voir
`[[project_teleinfo_app]]`.

### 4quater. Arborescence Nextcloud — refondue (18/09/2026)

⭐ **Refondue une troisième fois (18/09/2026), remplace toutes les versions précédentes de ce
diagramme** — conséquence directe de la nouvelle unité de sauvegarde (§4) : plus de sous-dossier par
application, et le niveau intermédiaire `docker`/`dimotic-ha-addons` devient le dernier niveau (pas un
niveau intercalé entre machine et application, puisqu'il n'y a plus de sous-dossier d'application) :

```
<rootPath>/                          (préfixe optionnel, config nextcloud.rootPath — ex. "backups-dimotic")
  <site>/
    <machine>/
      journalier/
        docker-2026-09-18.tar.gz
        docker-2026-09-18.manifest.txt
        dimotic-ha-addons-2026-09-18.tar.gz
        dimotic-ha-addons-2026-09-18.manifest.txt
      hebdomadaire/
        docker-2026-09-14.tar.gz
        docker-2026-09-14.manifest.txt
        dimotic-ha-addons-2026-09-14.tar.gz
        dimotic-ha-addons-2026-09-14.manifest.txt
```

Un dossier par site, un sous-dossier par machine, puis `journalier/` et `hebdomadaire/` — **ordre
décidé explicitement** (site/machine avant la cadence, pas l'inverse) pour que la navigation de
restauration se fasse dans cet ordre naturel (§6bis). Au plus 2 fichiers `.tar.gz` (+ 2 manifestes)
par cadence par machine (un par parent, §4ter) — nommage `<parent>-AAAA-MM-JJ.tar.gz`, même radical
pour le manifeste associé.

**Deux cadences (remplace "courant"/"mensuel" — ⭐ 18/09/2026, demande explicite)** :

- **Journalier** : poussé tous les jours, **rétention 10 jours glissants** (au moment de pousser le
  fichier du jour, retire par requête WebDAV DELETE le fichier daté à J-10 — calcul déterministe,
  pas de scan du dossier, même principe que l'ancienne rotation mensuelle).
- **Hebdomadaire** : poussé un jour fixe par semaine (dimanche, `WEEKLY_DOW=7` — voir §5), **rétention
  10 semaines glissantes** (retire le fichier daté à S-10 au même moment).
- **Plus de "courant" écrasé** : chaque poussée journalière est elle-même datée (`AAAA-MM-JJ`), pas de
  fichier à nom fixe réécrit — cohérent avec la rétention 10 jours (10 points de restauration récents
  disponibles, pas juste le dernier).
- **Pas de détection de changement pour cette version (⭐ simplification V1, 18/09/2026)** : le
  mécanisme `find -newer`/marqueur décrit dans la v1.0-v1.2 de cette spec (§5 ci-dessous) n'a **pas**
  été implémenté dans le script réel — poussée inconditionnelle sur le calendrier fixe (tous les
  jours + dimanche), cohérent avec l'esprit "sans s'occuper de ce qu'il y a dedans" de la nouvelle
  unité de sauvegarde. À reconsidérer plus tard si la fréquence s'avère trop coûteuse en pratique, pas
  une exigence immédiate.

## 4bis. Exclusions — au cas par cas, pas d'audit exhaustif préalable

**Copie brute intégrale par défaut**, sans tri ni audit préalable exhaustif — décision explicite de
l'utilisateur (répétée à plusieurs reprises pendant la conception) : pas la peine d'établir une liste
de ce qui est "important" avant de sauvegarder. Des exclusions ponctuelles restent possibles répertoire
par répertoire si un besoin réel apparaît (ex. un très gros fichier sans valeur) — à traiter au cas par
cas, jamais comme un audit préalable bloquant la mise en œuvre.

Le cas du mot de passe d'application Nextcloud lui-même (secret le plus évident à ne pas laisser fuiter
dans une sauvegarde) est déjà réglé **structurellement**, pas par une exclusion à maintenir : voir §3bis
— il vit hors de tout répertoire couvert, donc rien à exclure explicitement pour lui.

Le stockage n'est pas une contrainte (Nextcloud, capacité suffisante — décision utilisateur explicite).

**Risque de snapshot incohérent sur une base SQLite active (ex. `home-assistant_v2.db`)** : la
mitigation envisagée en conception (16/09/2026 — `sqlite3 ... ".backup <cible>"` plutôt qu'une copie
`tar` brute) **n'est pas implémentée dans le script V1** (`BackupScript.ts`, 18/09/2026) — celui-ci
fait un `tar czf` brut de `/docker`/`/dimotic-ha-addons` en entier, sans traitement spécial d'aucun
fichier (cohérent avec la nouvelle unité de sauvegarde §4, "sans s'occuper de ce qu'il y a dedans").
Risque accepté pour cette version, pas résolu — la fenêtre nocturne (§5, 3h05) réduit la probabilité
de conflit sans l'éliminer. À reconsidérer si un besoin réel de cohérence transactionnelle se
confirme (voir aussi §7/§8 « C. Validation »).

**Restauration HA** : reste une procédure documentée/semi-assistée plutôt qu'un bouton "restaurer" en
un clic pour ce cas précis — HA Core (installation utilisée aujourd'hui, sans Supervisor) ne peut pas
se remplacer proprement en live via son propre mécanisme natif. Sans objet pour la restauration par
copie brute d'un répertoire entier pendant que le conteneur est arrêté (voir §6bis) — HA Supervised
reste écarté pour ce seul bénéfice (changement d'infrastructure disproportionné).

## 5. Fréquence, déclenchement, rotation — tranché (16/09/2026)

**Rotation** (voir §4quater) : 10 jours glissants (journalier), 10 semaines glissantes
(hebdomadaire) — suppression déterministe du fichier daté à J-10/S-10 à chaque poussée, jamais de
scan du dossier distant.

**Fréquence — ⭐ tranchée définitivement (18/09/2026)** : journalier tous les jours (pas de condition
de changement — voir §4quater), hebdomadaire un jour fixe par semaine (dimanche).

**Horaire — ⭐ tranché définitivement (18/09/2026) : 3h05 tous les jours** (`BACKUP_CRON_HOUR`/
`BACKUP_CRON_MINUTE`, `BackupScript.ts`) — fenêtre nocturne de faible activité comme prévu en
conception (16/09/2026), décalé de 3h00 pile pour ne pas croiser des automatisations d'extinction de
lumières existantes chez l'utilisateur à cette heure précise.

**Détection de changement — abandonnée pour cette version (⭐ 18/09/2026)** : le mécanisme
`find -newer`/marqueur envisagé en conception (16/09/2026) n'a pas été retenu dans le script réel —
voir §4quater. Le script pousse inconditionnellement sur son calendrier fixe.

**Déclenchement (création/poussée) — ⭐ implémenté (18/09/2026), n'est plus différé** : cron **posé
directement par l'application dimotic-ha elle-même**, via SSH, au moment où l'utilisateur clique
« Pousser » sur Paramètres Techniques (§6) — pas un mécanisme totalement autonome/indépendant de
dimotic-ha comme envisagé en conception initiale, mais le script UNE FOIS déployé et son cron posé
**tourne ensuite seul**, sans dépendre de dimotic-ha pour s'exécuter (seul le déploiement initial
passe par l'application). Reste vrai pour le RPi1 le plus contraint : le script bash + `curl` ne
nécessite aucun runtime dimotic-ha sur la machine cible, seul le PUSH initial du fichier se fait
depuis dimotic-ha (par SSH, la machine cible n'a besoin de rien d'installé pour le recevoir).

### 5bis. Le script de sauvegarde tourne au niveau de l'hôte, pas dans un conteneur

⭐ Constat (16/09/2026) : le script doit lire les dossiers de données de **plusieurs conteneurs
différents** sur une même machine (`data/` de dimotic-ha, `config/` de HA, `data/` de zigbee2mqtt, de
modbus2mqtt...) — des conteneurs isolés les uns des autres par nature. Un script embarqué **dans**
une image (dimotic-ha ou autre) n'aurait normalement pas accès aux volumes des conteneurs voisins. Il
doit donc tourner au niveau de **l'hôte** (le système Linux qui héberge tous les conteneurs Docker de
la machine), avec le cron de l'hôte, un accès direct à `/docker/*/data` en tant que fichiers — pas
"dans l'image" de quoi que ce soit.

Ça règle au passage deux cas particuliers :
- **rpigpio via mqtt-io** : image tierce (`flyte/mqtt-io`), pas la nôtre — non concerné, le script
  hôte agit à côté, pas dedans.
- **teleinfo sur RPi1** : pas de Docker du tout, agent brut en systemd — le script hôte tourne pareil,
  en dehors de tout conteneur.

**Déploiement du script lui-même — ⭐ implémenté (18/09/2026)** : greffé sur le bouton « Pousser » déjà
existant (poussée du secret, §3bis) plutôt qu'un mécanisme de déploiement dimotic-ha générique comme
envisagé en conception (`rebuild-and-deploy.sh` etc.) — cohérent avec le principe "pas de nouveau
système de déploiement à construire" : `ScriptPushService` (`applications/sauvegarde/src/domain/`)
enchaîne, sur un seul clic, écriture du secret → écriture du script (`/dimotic-backup/
nextcloud-backup.sh`, SSH, contenu via stdin comme le secret) → pose du cron (§5, remplace toute
entrée précédente référençant ce même script, sans toucher aux autres lignes du crontab de la
machine). Le tag persistant `secretDeployed` (§3bis/§6) ne passe à vrai que si les **trois** étapes
réussissent.

**Emplacement sur la cible — ⭐ nouveau (18/09/2026)** : 4e répertoire de convention,
**`/dimotic-backup/`**, à la racine comme `/docker/`, `/dimotic-ha-addons/` et `/dimotic-secrets/`
mais **jamais sauvegardé** (hors des deux arborescences couvertes, §4) :
- `/dimotic-backup/nextcloud-backup.sh` — le script lui-même.
- `/dimotic-backup/status.json` — marqueur de statut (§5ter).
- `/dimotic-backup/cron.log` — sortie du cron (`>> ... 2>&1`).

**Déclenchement à la demande — ⭐ nouveau (18/09/2026), demande explicite** ("je dois pouvoir
déclencher une sauvegarde à la demande, suite à de grosses modifications par exemple") : bouton
« ▶️ Lancer maintenant » par machine sur Paramètres Techniques, à côté de « Pousser » — exécute par
SSH le script déjà déployé, sans attendre le cron (`SauvegardeService.handleBackupRunNow`, timeout
étendu à 5 minutes). Suppose que « Pousser » a déjà réussi au moins une fois pour cette machine —
sinon le script est simplement absent, erreur explicite.

**Testabilité — ⭐ nouveau (18/09/2026), demande explicite** ("comment ce script peut être testé...
des fréquences différentes ?") : les variables clés du script (`RETENTION_DAYS`, `RETENTION_WEEKS`,
`WEEKLY_DOW`, `TODAY`, `DOW`) sont surchargeables via l'environnement au lancement manuel par SSH
(`: "${VAR:=défaut}"`, bash), sans affecter le comportement normal du cron — ex.
`WEEKLY_DOW=$(date +%u) /dimotic-backup/nextcloud-backup.sh` force la poussée hebdomadaire le jour
même, `RETENTION_DAYS=2 RETENTION_WEEKS=2 ...` pour observer la rotation sans attendre 10
jours/semaines réels. Documenté en commentaire en tête du script généré.

### 5ter. Vérification et statut — tranché (16/09/2026), implémenté (18/09/2026)

⭐ Deux ajouts au script générique (§5bis), peu coûteux, pour éviter un échec silencieux :

- **Intégrité de l'archive avant poussée** : `tar -tzf <archive>` (test de lecture, sans extraire)
  avant tout `curl` — détecte une archive tronquée (ex. disque plein pendant la création) avant
  qu'elle n'écrase une bonne sauvegarde sur Nextcloud.
- **Vérification du résultat de la poussée** : contrôle du code retour HTTP de `curl` (pas seulement
  supposer que l'envoi a réussi) — un échec réseau/quota Nextcloud dépassé ne doit pas passer inaperçu.
- **Marqueur de statut local** (`/dimotic-backup/status.json` — horodatage + succès/échec + cadences
  effectivement poussées, par parent `docker`/`dimotic-ha-addons`) — écrit à chaque exécution. Point
  d'accroche pour `fonctionnelles-supervision-externe_specs_v1.0.md` §4 (spec dédiée) : elle n'a qu'à
  lire ce fichier (ainsi que `/dimotic-backup/cron.log`, §5bis) plutôt que d'inventer un nouveau
  protocole de statut de sauvegarde — pas de dépendance construite dans l'autre sens.

## 6. Application dédiée dimotic-ha « Sauvegarde/Restauration » — configuration et restauration

⭐ Décision architecturale (16/09/2026) : une **nouvelle application dimotic-ha**, nommée
**« Sauvegarde/Restauration »** (⭐ nom tranché, 16/09/2026 — même intitulé que le titre de cette
spec), suivant le pattern standard des applications existantes (même famille que `teleinfo`/`arexx`/
`rpigpio` — config + `targets[]` propres à l'app, pas dans le core ; voir `applications/sauvegarde/`,
squelette déjà livré le 17/09/2026), responsable de :

- **Configuration** : connexion Nextcloud (URL du serveur + utilisateur — le chemin WebDAV complet est
  reconstruit automatiquement, jamais saisi à la main, avec un aperçu affiché en direct pendant la
  saisie), plus une **liste de machines couvertes** — ⭐ simplifiée à trois reprises pendant
  l'implémentation (17/09/2026) jusqu'à une seule ligne par machine, sans distinction de type :
  `{id, site, machine, host}`. `id` n'est **plus saisi à la main** (⭐ 17/09/2026, "à quoi sert la
  zone identifiant ?") : dérivé automatiquement de site+machine, une seule fois, jamais recalculé
  pour une ligne déjà persistée. `host` est requis. Le bouton « Importer depuis le gossip » propose
  une ligne pour chaque machine dimotic-ha/stack HA déjà connue par gossip, sans jamais écraser une
  entrée existante — voir `SauvegardeService.handleGossipImport`, `CorrelatedRequester` vers
  `TargetGossipService` (core). **Tout ceci vit exclusivement sur Paramètres Techniques** (⭐
  17/09/2026, demande explicite : "on ne travaille que sur la page de paramètres techniques") — le
  tableau de bord (page application) a été délesté de tout ce qui précède (import gossip, ajout de
  machine, mot de passe), il ne garde que le statut et un lien vers la restauration ; sa refonte
  complète reste différée à plus tard.
- **Mot de passe d'application Nextcloud + script de sauvegarde + cron, par machine** (§3bis/§5bis) :
  une ligne par machine sur Paramètres Techniques, avec son propre champ mot de passe et son propre
  bouton « Pousser » — qui écrit **dans le même clic** le secret (`/dimotic-secrets/nextcloud-backup`),
  le script (`/dimotic-backup/nextcloud-backup.sh`) et son cron (3h05 quotidien), jamais dans la
  config de dimotic-ha elle-même (⭐ 18/09/2026, élargi depuis la version 17/09/2026 qui ne poussait
  que le mot de passe). Un **tag persistant** (`secretDeployed`) affiché à côté ne passe à
  « Déployé » que si les **trois** étapes réussissent. Un second bouton, « ▶️ Lancer maintenant »
  (⭐ 18/09/2026), exécute le script déjà déployé tout de suite par SSH, sans attendre le cron.
- **Restauration, pilotée depuis l'interface** (pas en ligne de commande) — voir §6bis pour la
  conception détaillée (en cours, 18/09/2026) : choix source (site → machine → parent → cadence →
  date réelle, listée sur Nextcloud) → application unique ou arborescence entière (via le manifeste,
  §4) → destination → confirmation → exécution.
  - **Restauration croisée entre machines** (⭐ demande explicite) : la sauvegarde source (site/machine
    d'origine, voir arborescence §4quater) et la machine cible de la restauration sont deux choix
    indépendants — permet de restaurer sur une machine de remplacement les données d'une machine
    tombée en panne, pas seulement "restaurer sur soi-même".

### 6bis. Reconstruction complète d'une machine — le vrai scénario de sinistre, tranché (16/09/2026)

⭐ Point insisté explicitement par l'utilisateur : cette application **est** le mécanisme de reprise
après sinistre pour une machine entièrement perdue, pas seulement un outil de confort — dès lors que
dimotic-ha est installé sur une machine (neuve ou de remplacement), **tout le reste peut se faire
depuis elle** : configurer Nextcloud (§6), lister les sauvegardes disponibles pour n'importe quelle
machine du foyer (grâce à la restauration croisée déjà tranchée ci-dessus), et restaurer directement
sur cette nouvelle machine.

**Conséquence sur le pipeline de provisionnement** (⭐ nouveau lien établi, 16/09/2026) : la future
application "provisioning" (`TODO.md`, "Nouvelle application 'provisioning' (support bootable)" —
généralisation de `scripts/flash-sd-card.js`/`prepare-sd-card.sh`, conception en cours,
[[project_provisioning_app_conception]]) pose déjà des questions oui/non sur ce qu'elle installe
(WiFi, Node.js, Python3, Docker CE + liste d'apps Docker). **L'installation de dimotic-ha doit
explicitement faire partie de ces questions** — une fois cochée, la machine fraîchement provisionnée
peut immédiatement servir à restaurer ce qui a été perdu, sans étape intermédiaire. Ce lien est à
reporter dans la conception de l'application provisioning elle-même quand elle sera reprise (référence
croisée à ajouter là-bas vers la présente section).

**Création/poussée des sauvegardes elle-même** (⭐ mise à jour 18/09/2026, corrige la version
16/09/2026 de ce paragraphe) : n'est **plus** hors périmètre de cette app — voir §5bis, le bouton
« Pousser » la déclenche désormais directement. Ce qui reste vrai de l'intention d'origine : une fois
déployé, le script tourne **seul** sur son cron, sans dépendre de dimotic-ha pour s'exécuter au
quotidien (fonctionne même sur le RPi1 qui ne fait pas tourner dimotic-ha) — seul le déploiement
initial (et un « Lancer maintenant » ponctuel) passe par l'application.

### 6ter. Conception de l'assistant de restauration — en cours (18/09/2026)

⭐ Décisions actées pendant la conception, aucun code encore écrit (`NextcloudWebDavClient`,
l'assistant lui-même et `SauvegardeRestoreService` restent à faire) :

- **Granularité — application unique possible** (⭐ demande explicite, tranché contre l'option "toute
  l'arborescence seulement") : le manifeste (§4) est téléchargé et affiché après le choix de la date —
  l'utilisateur choisit soit de tout restaurer, soit une seule application listée dedans. Extraction
  partielle de l'archive (`tar` sait extraire un seul sous-chemin) plutôt qu'un réarchivage préalable.
- **Séquence de téléchargement — inchangée depuis la conception d'origine** : toujours en local
  d'abord (sur la machine qui fait tourner dimotic-ha), puis `runScp` vers la destination si distante
  — jamais un accès Nextcloud direct depuis la destination, qui n'a explicitement aucun accès
  Nextcloud à elle (cas disaster-recovery, machine neuve jamais configurée).
- **Arrêt/redémarrage du ou des services concernés, par parent** :
  - **`/docker/`** : **pas de nom de conteneur à connaître** — vérifié dans le code réel
    (`docker/deploy-remote.sh`, `REMOTE_DIR=/docker/dimotic-ha`) : le déploiement fait déjà
    `cd /docker/<nom> && docker compose ...`, sans `-f` ni nom de projet explicite — `docker compose`
    utilise par défaut le nom du répertoire courant comme nom de projet. La restauration réutilise
    exactement ça : `cd /docker/<nom> && docker compose stop` puis `up -d` après extraction.
  - **`/dimotic-ha-addons/`** : ⭐ nouvelle convention actée (18/09/2026, voir
    `guide-nouvelle-application_specs_v1.11.md`, note v1.11) — chaque répertoire de déploiement
    contient son **propre fichier d'activation** à sa racine, `<nom>.service` (systemd) ou `<nom>.cron`
    (fragment cron.d, format système AVEC colonne utilisateur), plutôt qu'écrit uniquement dans
    `/etc/systemd/system/`/`/etc/cron.d/` comme c'était le cas jusqu'ici (`teleinfo/DeployService.ts`,
    à corriger en conséquence — pas encore fait). Le déploiement installe un **lien symbolique**
    depuis ce fichier canonique vers l'emplacement système attendu. À la restauration : si l'un des
    deux fichiers est présent à la racine du répertoire restauré, refaire le même lien puis
    `systemctl enable --now` (service) ou laisser cron détecter le nouveau fichier (cron.d, pas de
    rechargement explicite nécessaire) — jamais de nom à deviner ou faire saisir.
  - **Restauration de l'arborescence entière (pas une seule app)** : **boucle simple** sur les entrées
    du manifeste, arrêt de chacune avant extraction puis redémarrage de chacune après (⭐ tranché
    18/09/2026, plutôt que d'attendre un futur outil stop/start généralisé pour toutes les machines —
    voir `TODO.md`, idée notée le 14/09/2026 — qui reste un chantier séparé, non bloquant ici).
- **Encore ouvert** : protocole Socket.io exact de l'assistant (source→date→manifeste→destination→
  confirmation→progression), gestion d'une destination jamais configurée (machine neuve, §6bis),
  sauvegarde de l'état actuel avant écrasement (toujours prévue, `mv ... .before-restore-<horodatage>`,
  détail d'implémentation pas encore revu depuis la conception d'origine), cas HA (§4bis, procédure
  semi-assistée plutôt qu'un clic).

## 7. Hors scope de cette version

- Le mécanisme de **supervision/alerte** (détection qu'une sauvegarde a échoué ou n'a pas eu lieu)
  est traité séparément — voir `TODO.md`, "Supervision multi-sites indépendante + alerte hors HA"
  (conception du 16/09/2026, pas encore une spec dédiée).
- HA Supervised / réplication d'une instance de secours prête à prendre le relais — écarté pour
  l'instant (voir §5).

## 8. Plan de mise en œuvre

Décisions de conception prises pour la destination/transport/cadences/portée (§2 à §5ter) et pour le
rôle de l'application dédiée (§6). Deux chantiers, plus imbriqués que prévu à l'origine — le
déploiement du chantier A se fait finalement PAR le chantier B (§5bis) :

**A. Script de création/poussée des sauvegardes** — ⭐ écrit et vérifié localement (18/09/2026),
**pas encore testé en conditions réelles** (vraie machine, vrai Nextcloud).
1. ⬜ Confirmer l'accessibilité réseau du Nextcloud via WireGuard depuis chaque machine cible, et
   ajouter les IP/noms nécessaires à `trusted_domains` — pas encore refait depuis la conception
   d'origine (16/09/2026).
2. ⬜ Créer un mot de passe d'application Nextcloud par machine — procédure documentée (§3bis),
   jamais exécutée pour une vraie machine cible de production à ce jour.
3. ✅ Script générique écrit (`applications/sauvegarde/src/domain/BackupScript.ts`) : archive
   `/docker`/`/dimotic-ha-addons` en entier (§4) + manifeste + test d'intégrité + push WebDAV
   journalier/hebdomadaire + purge déterministe (§4quater) + vérification du code HTTP + marqueur de
   statut (`/dimotic-backup/status.json`, §5ter). Détection de changement **non implémentée**
   (§4quater — simplification V1 assumée). Vérifié en local (répertoires factices, `curl` simulé,
   rotation forcée par surcharge d'environnement) — jamais exécuté contre un vrai `/docker` ni un
   vrai Nextcloud.
4. ✅ Déploiement (`ScriptPushService`) et déclenchement (cron 3h05 + « Lancer maintenant ») —
   greffés sur le bouton « Pousser » de l'application (§5bis), pas un mécanisme totalement externe
   comme envisagé initialement.

**B. Application dimotic-ha dédiée (configuration + restauration, §6)** — en cours.
5. ✅ Configuration : connexion Nextcloud (URL serveur + utilisateur + aperçu WebDAV en direct) +
   `targets[]` (une ligne par machine, id dérivé/invisible, host requis, §6) + import gossip + bouton
   « Pousser » (secret + script + cron, tag `secretDeployed` unique) + « Lancer maintenant » — tout
   sur Paramètres Techniques, tableau de bord réduit au statut seul.
6. ⬜ Reste à faire : `NextcloudWebDavClient` (PROPFIND + GET selon l'arborescence §4quater),
   `SauvegardeRestoreService` (séquence complète §6ter — téléchargement, extraction partielle/totale
   via le manifeste, arrêt/redémarrage par parent, sauvegarde de l'état actuel, vérification),
   interface de l'assistant (source→manifeste→destination→confirmation→progression). Conception
   avancée (§6ter), aucun code encore écrit.
7. ⬜ Convention systemd/cron auto-descriptive (§6ter, `guide-nouvelle-application_specs_v1.11.md`) —
   décidée, mais `teleinfo/DeployService.ts` (et tout futur agent du même genre) doit encore être
   corrigé pour écrire son unité/cron **dans** son répertoire de déploiement plutôt que directement
   dans `/etc/systemd/system/`/`/etc/cron.d/`, sans quoi la restauration ne pourra pas s'appuyer
   dessus pour teleinfo tel qu'il est déployé aujourd'hui.

**C. Validation** — non commencée.
8. Documenter/vérifier les nuances par répertoire (base HA potentiellement incohérente §4bis —
   `PRAGMA integrity_check` avant redémarrage ; `coordinator_backup.json` distinct de `database.db`
   pour zigbee2mqtt — identité réseau du dongle).
9. Tester une sauvegarde réelle puis une restauration réelle (y compris croisée entre deux machines)
   sur du matériel de test avant de considérer le mécanisme fiable.
