# Synchronisation Nextcloud → machine distante

**Statut au 26/09/2026 : en préparation, PAS activée.** Machine distante pas encore nommée par
l'utilisateur ("on la nommera plus tard") — rien ne tourne encore en cron.

Machine concernée : **`nextcloud.home`** (hostname réel `nextcloud`), un Raspberry Pi 4 dédié à
Nextcloud (Docker AIO) — **distinct** du Pi4 qui tournait dimotic-ha/testcycle et du site "noisy".
Accès : `ssh root@nextcloud.home` (clé déjà en place depuis falbala, pas de mot de passe).

## Pourquoi ce document

Écrit à la demande explicite de l'utilisateur ("c'est trop rapide note tout ca dans un md") après
un enchaînement d'actions faites d'affilée sans pause : recherche, décisions, écriture et
installation du script, en une seule séquence. Ce fichier sert de point d'arrêt et de référence
avant de continuer.

## 1. Origine de la demande

L'utilisateur pensait qu'un script de synchronisation vers une machine distante existait déjà sur
`nextcloud.home` et devait être en cron, mais ne le retrouvait plus. **Recherche faite (26/09) :
rien de tel n'existe ni n'a jamais existé sous cette forme.**

Ce qui a été trouvé en cherchant :
- **4 scripts DuckDNS actifs** en cron (`/etc/cron.d/duckdns-*` → `/dimotic-ha-addons/duckdns/*.sh`,
  toutes les 5 min) : mise à jour d'IP dynamique, **rien à voir** avec une synchronisation de
  fichiers.
- **`/root/duckdns/duckv2.sh`** : un doublon DuckDNS abandonné, copié depuis `192.168.1.8` début
  mars 2026 (`scp -r root@192.168.1.8:/root/duckdns ./`), **non référencé** dans aucun cron.
- **`/home/didier/testrsyncfrom`** : dossier **vide** (4 Ko). L'historique bash montre qu'il avait
  servi début mars à un essai manuel ponctuel (`cp -a /etc ./testrsyncfrom/`), pas une tâche
  planifiée — tout son contenu a depuis été supprimé.
- La crontab de `root` est vide (hors modèle Debian par défaut) ; aucun autre utilisateur n'a de
  crontab.
- Historique bash : plusieurs connexions SSH + `ssh-copy-id` vers **`192.168.1.8`** (mars 2026),
  sans script de sync retrouvé nulle part sur `nextcloud.home` en lien avec cette machine.

**Conclusion : il n'y a rien à réparer, il faut créer cette synchronisation.**

## 2. Objectif reformulé par l'utilisateur

> « l'objet est de faire une synchronisation avec un système distant des données stockées dans
> nextcloud »

Donc : un **nouveau** projet de sauvegarde/synchronisation des données Nextcloud vers une machine
distante — pas la récupération d'un script perdu.

## 3. État réel de Nextcloud sur cette machine (vérifié 26/09/2026)

| Point | Constat |
|---|---|
| Stockage | **`/dev/sda4` → `/cloud`**, 3,6 To, **584 Go utilisés**, 2,8 To libres |
| Données Nextcloud | `NEXTCLOUD_DATADIR=/cloud/cloudata` (variable du mastercontainer AIO) |
| Déploiement | Nextcloud **AIO** (`nextcloud-aio-*`, 10 conteneurs Docker) + `caddy` en reverse-proxy |
| Sauvegarde intégrée AIO (Borg) | **PAS activée** (aucun conteneur Borg, aucune variable de backup sur le mastercontainer) → la source à synchroniser est donc directement `/cloud/cloudata`, en fonctionnement normal |
| Mode maintenance Nextcloud | Disponible (`occ maintenance:mode`), **pas utilisé** pour l'instant pendant la copie (décision implicite, à revoir si besoin de cohérence stricte) |
| Clé SSH sur la machine | `/root/.ssh/id_rsa` déjà en place (commentaire `root@dns323` — provient probablement d'un ancien NAS), déjà réutilisée pour pousser vers DuckDNS/dimoticloud. Réutilisée telle quelle pour ce script plutôt que d'en créer une dédiée. |

⚠️ **Correction d'une note antérieure** (mémoire) : ce Pi4 ne porte pas "4 disques USB3" mais un
disque unique de 3,6 To sur `/cloud`. À corriger dans les notes de suivi.

## 4. Décisions prises avec l'utilisateur

| # | Question posée | Réponse |
|---|---|---|
| 1 | Machine distante cible | **Pas encore choisie** — "on la nommera plus tard" |
| 2 | Outil de synchronisation | **rsync par SSH** (recommandé, choisi) — pas Borgbackup pour l'instant |

Choix faits sans repasser par l'utilisateur, à confirmer/discuter :
- **Miroir simple** (`rsync -aAX --delete`) : un fichier supprimé côté source l'est aussi côté
  distant. **Aucun historique de versions.** Une suppression accidentelle ou une corruption se
  répercute telle quelle côté distant. Évolution possible plus tard : instantanés quotidiens
  (`rsync --link-dest`) ou passage à Borgbackup si on veut remonter dans le temps — **pas fait,
  à trancher**.
- Pas de mode maintenance Nextcloud pendant la copie (données vivantes, rsync tourne à froid par
  rapport à l'activité Nextcloud) : un fichier modifié pile pendant la synchronisation peut repartir
  incomplet une fois, repris correctement au passage suivant. Compromis pour ne pas couper l'accès
  à Nextcloud chaque nuit — **pas discuté explicitement avec l'utilisateur**.
- Horaire proposé : **2h du matin**, quotidien — **pas confirmé**.
- Chemin distant proposé : `/backup/nextcloud-cloudata/` — **à confirmer selon l'espace disponible
  côté machine distante**, une fois celle-ci choisie.

## 5. Ce qui est installé sur `nextcloud.home` (mis à jour 26/09/2026, v2)

**Rien n'est actif.** Le script existe mais s'arrête immédiatement (`REMOTE_HOST` vide → erreur
explicite) ; la tâche cron est présente mais **en commentaire**.

- **`/root/sync-nextcloud-remote/sync.sh`** (mode 700) :
  - `SRC=/cloud/cloudata/`
  - `REMOTE_HOST=""` ← **à renseigner**
  - `REMOTE_USER="root"`
  - `REMOTE_DIR="/backup/nextcloud-cloudata"` ← à confirmer
  - `SSH_KEY=/root/.ssh/id_rsa` (clé existante, pas nouvelle)
  - `rsync -aAX --delete --partial --human-readable --stats [--bwlimit=$BWLIMIT_KBPS]` via
    `ssh -o BatchMode=yes -o ConnectTimeout=15`
  - **`MAX_DURATION_S=5h`**, via `timeout -k 60s 5h rsync …` — arrêt propre (TERM puis KILL après
    60s de grâce) si la séance dépasse 5h ; `--partial` garde les fichiers en cours pour la nuit
    suivante.
  - `BWLIMIT_KBPS` : vide = pas de limite (demande utilisateur, pas encore chiffrée).
  - Verrou (`flock` sur `/var/run/sync-nextcloud-remote.lock`) : deux exécutions ne se chevauchent
    pas.
  - Journal : `/var/log/sync-nextcloud-remote.log`.
  - **`status.json`** (à côté du script) + **publication MQTT** (`mosquitto_pub`, installé) vers le
    broker de ha2 (`192.168.1.51:1883`, sans authentification, préfixe de découverte `homeassist`
    comme le reste du projet) : capteur HA **« Synchro Nextcloud »**
    (`homeassist/sensor/nextcloudsync/state` = `a_jour` / `en_rattrapage` / `erreur`,
    attributs `started_at`, `ended_at`, `duration_s`, `exit_code`, `completed`,
    `files_transferred`, `bytes_transferred`). Découverte publiée (retenue) à chaque exécution.
- **`/etc/cron.d/sync-nextcloud-remote`** : ligne `0 2 * * * root /root/sync-nextcloud-remote/sync.sh`
  **en commentaire**.
- **`/etc/logrotate.d/sync-nextcloud-remote`** : rotation hebdomadaire, 4 semaines conservées.

Pas encore fait/vérifié : premier essai réel une fois `REMOTE_HOST` connu (le capteur HA n'a jamais
été vu apparaître en pratique, seule la syntaxe du script a été validée : `bash -n`).

Rien de tout ça n'est dans le dépôt `dimotic-ha` (ce n'est pas une application dimotic-ha, c'est de
l'infra sur une machine séparée) — uniquement sur `nextcloud.home` elle-même. Ce fichier
`NEXTCLOUDSYNC.md` est le seul endroit qui en garde la trace côté dépôt.

## 5bis. Besoins complémentaires (26/09/2026, suite — avant toute nouvelle installation)

Précisés par l'utilisateur après la première version du script (§5) :

1. **Plage de nuit avec durée maximale.** La machine distante avait été débranchée ; une première
   synchronisation locale date de **~7 mois**, il y a donc **énormément de fichiers désynchronisés**
   — le premier passage ne pourra pas tout transférer en une nuit. Le script doit :
   - démarrer à une heure fixe, tourner **au plus** une durée maximale, puis **s'arrêter proprement**
     même si le transfert n'est pas terminé (`timeout` autour de `rsync`, envoi de `SIGTERM` puis
     `SIGKILL` — rsync s'interrompt proprement, aucune corruption de fichier en cours de copie côté
     distant grâce à `--partial` ou aux fichiers temporaires `.~tmp~`) ;
   - reprendre automatiquement la **nuit suivante** exactement là où c'est utile : rsync compare de
     toute façon systématiquement source/destination (taille+date), donc relancer le même script
     chaque nuit **rattrape tout seul** ce qui n'a pas pu passer la veille — pas besoin d'une liste
     de reprise séparée, juste de **plusieurs séances** jusqu'à ce qu'une nuit se termine sans
     atteindre le temps maximum (= rattrapage terminé, la suite ne sera plus que l'entretien
     quotidien, bien plus rapide).
   - **Confirmé (26/09/2026) : 02h00 → 07h00, soit 5h max.**
3. **Limite de bande passante** (demande utilisateur) : `rsync --bwlimit`. Ajouté au script en
   paramètre `BWLIMIT_KBPS`, **vide par défaut (pas de limite)** — à chiffrer si besoin (Ko/s).

2. **Suivi dans HA** de chaque séance : date/heure, fichiers et octets transférés, durée, **terminée
   dans les temps** ou **arrêtée par le temps maximum** (→ signale qu'il reste du rattrapage), erreur
   éventuelle. Si HA s'avère trop compliqué : repli sur un suivi dans une application dimotic-ha.
   - **Vérifié faisable simplement** : `nextcloud.home` joint le broker MQTT de ha2
     (`192.168.1.51:1883`) — un simple script y publie un capteur par **découverte MQTT HA**, sans
     application dimotic-ha, comme le font déjà teleinfo/rpigpio depuis leurs propres machines. Pas
     besoin du repli pour l'instant.
   - `mosquitto-clients` pas encore installé sur `nextcloud.home` — à faire.
   - Capteur envisagé : état (`en rattrapage` / `à jour` / `erreur`), avec en attributs : dernière
     séance (début, fin, durée), fichiers/octets transférés cette séance, terminée dans les temps ou
     non.

## 6. Reste à faire, dans l'ordre

1. **Nommer la machine distante** (adresse/nom, espace disque disponible, accessibilité réseau
   depuis `nextcloud.home` — réseau local, VPN WireGuard type site noisy, ou autre).
2. Installer la clé publique de `nextcloud.home` sur cette machine (`ssh-copy-id`, comme déjà fait
   pour DuckDNS/dimoticloud).
3. Renseigner `REMOTE_HOST` et `REMOTE_DIR` dans `sync.sh`, créer le dossier distant si besoin.
4. **Premier essai manuel** (`/root/sync-nextcloud-remote/sync.sh`), en surveillant le journal —
   584 Go au premier passage, prévoir le temps et la bande passante nécessaires.
5. Revoir avec l'utilisateur : miroir simple vs historique de versions, mode maintenance pendant la
   copie ou non.
6. Ajouter la limite de durée (§5bis-1) : plage horaire + durée max confirmées, `timeout` autour de
   `rsync`, sortie propre.
7. Ajouter le suivi HA (§5bis-2) : `mosquitto-clients` sur `nextcloud.home`, découverte MQTT +
   publication de l'état à chaque séance.
8. Décommenter la ligne dans `/etc/cron.d/sync-nextcloud-remote` une fois tout validé.

## Historique

| Date | Action |
|---|---|
| 26/09/2026 | Recherche sur `nextcloud.home` (rien trouvé), objectif reformulé, script + cron désactivé + logrotate installés, ce document créé sur demande explicite de l'utilisateur. |
