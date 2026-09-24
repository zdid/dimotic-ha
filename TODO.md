# Liste des problèmes à résoudre

## ✅ DÉCISION restauration (23/09/2026, à reporter dans la spec sauvegarde en fin de debug)
- **Remplacement d'une machine = la nouvelle machine reprend l'adresse IP de l'ancienne**
  (réservation DHCP sur sa MAC, source arrêtée) — aucune réécriture d'adresse dans les fichiers
  restaurés, les appareils (firmware) retrouvent HA seuls. Seul scénario traité pour l'instant.
  Réécriture source→destination (clone/essai sur autre IP) : écartée pour le moment.
- Premier essai : ha2 (arrêtée) restaurée sur orangepi4pro (192.168.1.147 → reprendra .51).
- Ordre de travail : interface graphique d'abord, script de restauration ensuite.
- **Compléments (23/09 soir)** : la restauration se pilote depuis N'IMPORTE QUEL dimotic-ha
  (ex. stfort → restaure ha2 sur orangepi4pro) vers une destination juste installée, dimotic-ha
  présent ou non — seul prérequis : `ssh-copy-id` de la clé de dimotic-ha vers root@destination
  (afficher clé publique + commande dans l'écran ①, et rappeler que root refuse souvent le mot de
  passe SSH sur une image fraîche → ajout manuel dans /root/.ssh/authorized_keys via sudo).
  Écran ④ : contrôles SSH root, docker + docker compose, curl, tar, espace libre. **Docker absent →
  installé** par l'étape 1 (script officiel get.docker.com, même méthode que prepare-sd-card.sh ;
  curl/tar installés par apt si absents). Point 10 (`/docker-temp`) ne concerne QUE le cas où la
  destination est la machine qui pilote ; piloter depuis une autre machine = cas recommandé,
  `/docker/dimotic-ha` de la destination traité comme toute autre application.
  ✅ Interface faite le 23/09 20:00 (bloc prérequis clé+commandes, bouton « Tester la destination »,
  contrôles dans ④) — testé : orangepi4pro tout ✅ 24 Go ; falbala → « clé non autorisée ».
  Reste : l'installation elle-même (dans le script de l'étape 1).
- 🟡 **Script de restauration + écrans ⑤/⑥ écrits le 23/09 20:40** : `RestoreScript.ts` (bash détaché,
  phase1/phase2, état `/dimotic-backup/restore-status.json`, journal conservé), `RestoreService.ts`
  (dépôt SSH script+netrc, lancement `setsid nohup`, relecture 3 s), événements `restore:start/start2/
  status`. Testé en bac à sable local (faux Nextcloud file://, faux /docker) : phase1+phase2 OK, bug de
  variable écrasée trouvé et corrigé. **Non testés** : docker compose stop/up réels, installation
  apt/Docker, relocalisation /docker-temp, échec de place.
  Essais réels 23/09 sur orangepi4pro : étape 1 stfort/stfort OK (19:37), étape 1 stfort/ha2 OK (19:48, 6
  éléments) mais « Timeout 30 s » au lancement → corrigé (`cd / ; setsid …` au lieu de `cd / && … &`).
  ✅ **24/09 : remplacement réel de ha2 (RPi4) par l'orangepi4pro RÉUSSI** — étape 2 lancée en .147, puis
  bascule DHCP .51 + reboot : Docker relance tout (`unless-stopped`), HA/mosquitto/dimotic-ha (identité
  ha2_811876)/zigbee2mqtt opérationnels en .51. Changement de machine ET de type de matériel, rapide.
  Reste : (a) zigbee2mqtt « ÉCHEC du démarrage » tant que le dongle n'est pas branché → prévoir un état
  « périphérique absent » + « Réessayer » par élément plutôt qu'un échec définitif ; (b) comprendre
  pourquoi l'étape 2 n'a pas pu être lancée directement en .51 ; (c) mqtt-io-rpigpio de ha2 en boucle
  de redémarrage sur l'orangepi4pro (config sans GPIO) — à retirer par l'utilisateur.
  (d) ✅ 24/09 : `docker compose pull` fait dès l'étape 1 (images absentes sur machine neuve → l'étape 2
  les téléchargeait, HA > 1 Go, `docker ps` vide pendant ce temps et coupure allongée) — à éprouver en réel.
- 🟡 **Écrans ①-④ livrés le 23/09 19:00** (lecture seule) : `sauvegarde/restauration.html` +
  `restauration-app.ts`, `NextcloudWebDavClient.ts`, événements `sauvegarde:restore:*`, entrée de menu
  « Restauration ». Testé : chargement, préremplissage, mot de passe refusé. ⭐ Destination = IP
  saisie (SSH root, préremplie avec l'IP locale) — remplace la décision 4 « locale seulement ». Reste : essai avec le vrai
  mot de passe, écrans ⑤/⑥ + script.
- **Décisions assistant (23/09)** : (1) emplacement à creuser ; (2) sauvegardes listées depuis
  Nextcloud (pas depuis la config) ; (3) mot de passe Nextcloud saisi dans l'assistant, jamais
  stocké ; (4) destination = la machine qui fait tourner dimotic-ha (locale) en V1 ; (5)
  avertissement non bloquant si IP destination ≠ IP source ; (6) une case « tout » + une case par
  élément du manifeste ; (7) dates journalier/hebdo mélangées dans une seule liste ; (8)
  progression par étapes ; (9) script bash généré ; (10) dimotic-ha dans l'archive : à trancher ;
  (11) l'existant est déplacé dans `/docker-backup-<date>` ; (12) **deux étapes** : restauration
  SANS aucun redémarrage, puis démarrage séparé après validation humaine (aller voir la machine,
  arrêter la source) ; (13) dongle zigbee : simple texte dans l'assistant ; (14) archive téléchargée
  et extraite SUR la machine cible — il faut connaître le volume décompressé pour vérifier la place.
- **Compléments tranchés (23/09)** :
  - (1) page « Restauration » dans l'app Sauvegarde (HTML/TS, Shadow DOM + Alpine) + lien depuis
    Paramètres Techniques ; permet aussi de saisir URL/utilisateur Nextcloud (machine vierge).
  - (10) si dimotic-ha est coché : le script (détaché via `setsid nohup`, avancement dans
    `/dimotic-backup/restore-status.json`, relu par l'assistant après reconnexion) arrête
    `/docker/dimotic-ha`, le déplace dans `/docker-temp/dimotic-ha`, le relance de là (volumes
    relatifs → garde ses propres données), attend `healthy`, puis continue. Étape 2 : il est
    remplacé EN DERNIER par celui restauré, `/docker-temp/dimotic-ha` part dans `/docker-backup-<date>/`.
    Étape sautée hors Docker (dev falbala).
  - (11)+(6) seuls les répertoires cochés sont déplacés dans `/docker-backup-<date>/<app>`.
  - (12) étape 1 = `docker compose stop` des éléments cochés, déplacement, extraction, AUCUN
    redémarrage ; étape 2 « Démarrer » = `up -d` après validation humaine.
  - (14) volume décompressé : écrit dans le manifeste au moment de la sauvegarde (`du -sb` total +
    par sous-répertoire) ; repli `tar -tvzf` pour les archives existantes. Contrôle : compressé +
    décompressé ≤ espace libre.
  - Exécution par SSH root sur la propre machine de dimotic-ha (conteneur sans accès à /docker),
    mot de passe Nextcloud par stdin.

## 🆕 Option de déploiement « sans paramétrage » (discussion du 23/09/2026, pas commencé)
- **Besoin** : un déploiement de dimotic-ha vers une nouvelle machine embarque les données de la
  machine source (constaté sur orangepi4pro 192.168.1.147 : token HA, hôte HA/MQTT, cibles
  apprises par gossip de falbala). ~~Bouton d'effacement~~ abandonné au profit d'une **option au
  niveau du déploiement** : déployer sans `data/` (config vierge), en gardant seulement ce qui est
  propre à la machine cible (machineId généré sur place, port web, clé SSH du parc).

## ✅ Sauvegarde : corrections d'id (23/09/2026, faites 18:30, pas encore retestées en réel) + manifeste avec tailles (`nom<TAB>octets`)
- Écran : id vide (pas `-`) tant que site ou machine est vide — un id invalide ne doit jamais être
  figé par `lockedIds`.
- Serveur : `resolveTarget` ne garde l'id envoyé que s'il désigne une ligne persistée de MÊME hôte,
  sinon `deriveTargetId(site, machine)` — une poussée ne doit jamais écraser une autre machine.
- Réparer `data/sauvegarde/config.yaml` (falbala) : remettre ha2 (192.168.1.51, déployé) en
  `stfort-ha2`, stfort en `stfort-stfort`, supprimer l'id `-`.

## 🐛 Sauvegarde : anomalies constatées en test live (23/09/2026)
- ✅ Corrigé le 23/09 (spec v1.4) : import gossip supprimé ; « Pousser »/« Lancer maintenant »
  sur les données à l'écran + enregistrement automatique après poussée réussie ; mot de passe
  visible à la saisie ; id `-` (recalcul tant que la ligne est nouvelle) ; timeout 15 min.
  **Pas encore retesté en réel.**
- 🟡 **Laissé en l'état (décision explicite du 23/09)** : mot de passe Nextcloud en clair dans les
  logs serveur ET renvoyé à tous les navigateurs — le pont générique `SocketBridge.registerAppSocketEvents`
  rediffuse aussi les événements client→serveur déclarés par une app, et `broadcast()` logue le
  payload. Piste : événements « client → serveur uniquement » déclarés par l'app + masquage des clés
  password/token/secret dans les logs (le token HA y est aussi en clair via `config:save`).
- 🟡 **Corrigé le 23/09, pas encore re-poussé ni retesté** — script : stderr de tar dans
  `/dimotic-backup/tar-<parent>-<date_heure>.log`, supprimé si code 0, conservé sinon ; code 1
  toléré (archive poussée), échec seulement à ≥ 2 ; `status.json` porte `tarExit`/`tarLog`.
  Reste : afficher à l'écran l'étape en échec plutôt que « ssh a quitté avec le code 1 ».
  Constat d'origine : 🐛 **Échec intermittent à l'étape `archive`** (2e essai réel, 23/09 16:49) : `tar -czf` a rendu
  un code ≠ 0 sur `/docker` (1,4 Go) alors que la même commande relancée juste après sort en 0.
  Cause très probable : code 1 de GNU tar = « fichier modifié/supprimé pendant la lecture »
  (base HA, mosquitto, logs actifs) — non fatal, mais le script (`BackupScript.ts`) traite tout
  code ≠ 0 comme un échec et **masque stderr** (`2>/dev/null`), donc aucune trace. Pistes : accepter
  le code 1 (échouer seulement à ≥ 2) et envoyer stderr de tar dans `cron.log`. Côté écran, le seul
  message était « ssh a quitté avec le code 1 » : remonter la sortie du script / `status.json`.
- 🐛 **Nouvelle ligne stfort a écrasé ha2 dans la config** (23/09 17:00) : l'id d'une ligne vide
  valait `-` au premier x-effect, identique à l'id historique `-` de la ligne ha2 → présent dans
  `lockedIds` → figé ; la poussée (upsert par id) a remplacé ha2 par stfort dans
  `data/sauvegarde/config.yaml`. Machines intactes (ha2 garde script+cron).
- 🟡 Poussée vers noisy (192.168.1.62) : `No route to host` depuis stfort — attendu (site distant).
- 🟡 Le mot de passe saisi est rattaché à l'id de la ligne : modifier site/machine d'une ligne
  NOUVELLE après avoir tapé le mot de passe le fait disparaître du champ (id recalculé).
- 🟡 « Lancer maintenant » : si le délai est dépassé, le script continue orphelin sur la machine
  (connexion SSH fermée) — l'écran affiche un échec alors que la sauvegarde peut réussir ; lire
  `/dimotic-backup/status.json` serait plus fiable.

## ✅ Accueil : lien HA périmé après changement de `ha.ws.host` (constaté et corrigé le 23/09/2026, pas retesté)
- **Symptôme** : après enregistrement de `ha.ws.host` 192.168.1.19 → 192.168.1.51 (Paramètres
  techniques), le core se reconnecte bien à la nouvelle HA mais la page d'accueil affiche toujours
  `http://192.168.1.19:8123` jusqu'au redémarrage.
- **Cause** : `app:ha-address` (événement persistant) n'est émis qu'une fois, dans
  `registerCoreSocketEvents()` (`applications/core/src/application/AppService.ts` ~l.821) ;
  `handleConfigReload()` (~l.339) ne le réémet pas.
- **Correctif prévu** : réémettre `SOCLE_SOCKET_EVENTS.HA_ADDRESS` avec `config.ha.ws` dans
  `handleConfigReload()`.

## 🔧 Plan : écoute passive RS485 du DDZY422-D2 chez noisy (préparé le 14/09/2026, pas encore exécuté)
- **Idée de l'utilisateur** : plutôt que d'interroger activement le DDZY422-D2 (bloqué depuis des
  semaines, `AcknowledgeError` systématique quel que soit l'esclave testé — voir plus bas), envoyer
  une **deuxième clé RS485→USB** à noisy et l'écouter **en parallèle, en mode passif** sur le même
  bus A/B que le module WiFi du compteur (déjà confirmé au connecteur du DDZY422-D2 sur photo) —
  capturer le vrai trafic Modbus RTU que le module WiFi échange en interne avec le compteur (LED
  "COM" du guide Huawei = cette liaison), sans jamais émettre. Approche jugée solide : évite de
  deviner l'adresse/les registres, on lit le protocole réel en observant un maître qui, lui,
  fonctionne déjà.
- **Répartition matérielle décidée** : le DDSU666H (interrogation active, modbus2mqtt/Docker)
  reste sur une machine capable type noisy (RPi3, ARMv7, qui héberge déjà RFXCOM) ; l'écoute
  passive du DDZY422-D2 ira sur un **Pi 1 dédié** (ARMv6, matériel séparé — évite tout risque
  d'ambiguïté entre deux adaptateurs USB identiques sur la même machine, cf. discussion `by-id`
  vs `by-path`). Adaptateur pas encore trouvé/précâblé par l'utilisateur — pas prêt à être expédié
  pour l'instant.
- **Deux versions du script préparées** (même logique : jamais d'émission, découpage par silence
  inter-octets ≥3.5 temps-caractère, décodage adresse/fonction/données, vérification CRC16) :
  - `scripts/rs485-sniffer.cjs` (Node.js) — pour du matériel Docker-friendly (ARMv7/8, ex. noisy2).
    Dépend du paquet npm `serialport` (déjà présent dans l'image
    `ghcr.io/modbus2mqtt/modbus2mqtt`, réutilisable via `docker run` comme les scripts de test du
    DDSU666H ce soir — commande complète en commentaire d'en-tête). Paramètres par défaut
    `/dev/ttyUSB1 9600 8N1`.
  - `scripts/rs485-sniffer.py` (Python, **retenu pour le Pi 1**) — pas de Docker (abandonné sur
    ARMv6 en 2026), juste `python3-serial` (`sudo apt-get install -y python3-serial`), léger.
    Paramètres par défaut déjà réglés sur ceux confirmés du DDZY422-D2 : `/dev/ttyUSB0 9600 8 E 1`
    (adresse 001/9600 bauds/parité paire/8 bits/1 stop — reconfirmés via la fiche Solarman
    helpcenter le 14/09, voir plus bas).
  - Aucune des deux versions testée en conditions réelles (pas de deuxième adaptateur disponible
    ce soir) — seulement `node --check`/`py_compile` (syntaxe validée).
- **Câblage** : brancher A-A, B-B en parallèle sur les mêmes bornes que le module WiFi existant,
  ne rien débrancher — le module WiFi continue de fonctionner normalement pendant l'écoute.
- **Reste à faire** : expédier la deuxième clé, la brancher sur place, lancer le script, identifier
  empiriquement débit/adresse/registres à partir des trames réelles capturées.

## Idées de fonctionnalité (à concevoir/implémenter plus tard)

### 💡 Système d'aide générique pour les applications dimotic-ha (18/09/2026)
- **Demande utilisateur** : "l'aide de l'application à noter dans todo" — repéré en travaillant sur
  Sauvegarde/Restauration, dont le tableau de bord avait initialement une procédure Nextcloud
  détaillée (étapes pour créer un mot de passe d'application) écrite en dur dans sa propre page —
  retirée depuis lors du nettoyage du tableau de bord (config déplacée vers Paramètres Techniques,
  voir `fonctionnelles-sauvegarde_specs`). Confirmé explicitement : pas juste "remettre ce guide
  quelque part", mais une **vraie capacité transverse**, utilisable par toute application
  dimotic-ha, pas seulement sauvegarde.
- **Rien conçu à ce jour** — aucune décision sur : bouton/panneau d'aide contextuelle générique
  (à la manière du champ `button`/`secretPush`/`rowActions` déjà ajoutés à `ConfigField` cette
  session pour d'autres besoins génériques), aide par section vs par application entière, contenu
  Markdown vs HTML, où le contenu vit (dans `ModuleUiMetadata` ? fichier séparé par app ?).
- **Pas bloquant** : différé, aucune application n'en dépend pour fonctionner.

### 💡 Procédure stop/start/restart généralisée pour TOUS les dockers de TOUTES les machines (14/09/2026)
- **Demande utilisateur** : "c'est une procédure qu'il faudra rajouter à dimotic-ha pour l'arrêt de
  tous les dockers de toutes les machines et de les relancer 'start' 'stop' 'restart'" — évoqué en
  contexte du nettoyage des messages MQTT retenus fantômes (voir rpigpio stfort ci-dessous),
  reporté à une exécution via cet outil plutôt qu'un nettoyage manuel `mosquitto_pub -n -r`.
- **Existant à ce jour** (insuffisant, à généraliser) : `docker/start-all.sh`/`docker/stop-all.sh`
  à la racine du dépôt — scripts **ad hoc pour un cas précis** ("cycle de test HA vierge" : tout
  arrêter + supprimer la config HA de ha2 + tout relancer avec ré-onboarding), pas une procédure
  générale. Périmètre actuel limité à ha2 (`dimotic-ha`, `zigbee2mqtt`, `mosquitto`,
  `homeassistant`) + orangepi (`dimotic-ha` seul) — **ne couvre pas** noisy/noisy2/stfort, ni
  `mqtt-io-rpigpio`/`portainer-agent`. `ORANGEPI_HOST` y est resté à l'ancienne IP `192.168.1.32`
  (obsolète, corrigée en `192.168.1.130` ailleurs le 30/08 — pas resynchronisé dans ce script).
  `stop-all.sh` est en plus destructif par conception (supprime `/docker/homeassistant/config`),
  donc pas réutilisable tel quel pour un simple cycle stop/start de maintenance.
- **Besoin réel** : une vraie procédure (probablement une commande/UI dans `core`, ou un script
  dédié séparé de `start-all.sh`/`stop-all.sh`) qui, pour CHAQUE machine connue du projet (ha2,
  noisy, noisy2, orangepi, stfort — liste à tenir à jour, cf. doublons d'IP déjà rencontrés) et
  CHAQUE conteneur qui y tourne (liste dynamique via `docker ps`, pas une liste figée dans le
  script comme aujourd'hui — sinon nouveau conteneur = oublié à chaque fois, cf. `mqtt-io-rpigpio`/
  `portainer-agent` absents des scripts actuels), permette : `stop` (tout arrêter proprement, ordre
  dépendant à respecter — voir `MIGRATION_noisy_2026-09-10.md` pour un exemple d'ordre correct côté
  noisy), `start` (tout relancer), `restart` (les deux) — **sans** le comportement destructif de
  l'actuel `stop-all.sh`.
- **Pas encore conçu** : mécanisme précis (nouvelle app dimotic-ha ? extension de `core` ? script
  seul ?), inventaire dynamique des machines/conteneurs, gestion de l'ordre de démarrage/arrêt.

## Problèmes prioritaires (suite du 14/09/2026, session noisy2)

### ✅ rpigpio de stfort corrigé — même bug de `config.yml` que noisy, PAS un problème côté nommage (14/09/2026)
- **Contexte** : question utilisateur "le rpigpio de stfort tourne bien ?" — vérifié en détail.
- `mqtt-io-rpigpio` sur stfort fonctionnait déjà correctement côté GPIO (connecté au MQTT de ha2,
  3 relais réels pilotés `phys7`/`phys13`/`phys15`) mais ses 3 entités n'ont jamais atteint HA.
- **Diagnostic corrigé par l'utilisateur en cours de route** : mon premier diagnostic ("nommage pas
  à jour sur ha2") était **faux** — le vrai problème était le **`config.yml` de mqtt-io-rpigpio sur
  stfort lui-même**, resté sur l'ancien format buggé : `ha_discovery.prefix:
  homeassist/rpigpio_bridge_stfort_stfort_578666` (bridge instance injecté en segment de topic
  supplémentaire → 6 segments après `homeassist/`, jamais couvert par aucun motif de `nommage`,
  même bug déjà trouvé et corrigé côté générateur cette nuit sur noisy dans
  `applications/rpigpio/src/domain/generator.ts`) — mais le fichier `config.yml` **déployé sur
  stfort** n'avait jamais été régénéré/redéployé avec le correctif, contrairement à celui de noisy.
- **Corrigé directement** (pas besoin d'attendre une diffusion) : `config.yml` de stfort édité pour
  matcher exactement le format déjà validé sur noisy — `client_id:
  rpigpio_bridge_stfort_stfort_578666` ajouté, `ha_discovery.prefix` remis à `homeassist` (nu, sans
  bridge instance). Sauvegarde `.bak-20260914` faite avant modif, conteneur recréé, **vérifié de
  bout en bout** : nouveaux topics à 5 segments (`homeassist/switch/rpigpio_bridge_.../15/config`),
  relayés par `nommage` jusqu'à `homeassistant/switch/...` avec les bons noms de pièce ("Relais15",
  "Radiateur"/Salle de bain du bas, "Petit grenier"/Grenier) — HA devrait créer les 3 entités.
  Anciens messages retenus (ancien format 6 segments, jamais parvenus à HA) laissés en l'état pour
  l'instant (nettoyage différé, voir entrée ci-dessous sur l'outil stop/start/restart généralisé).

### ✅ Rotation des logs Docker généralisée à TOUS les conteneurs, TOUTES les machines (14/09/2026)
- **Contexte** : le correctif de rotation (`logging: json-file, max-size: 10m, max-file: 5`) fait
  plus tôt dans la session n'avait été appliqué qu'au conteneur `dimotic-ha` lui-même (via
  `compose.yaml`/`compose.deploy.yaml` du dépôt), pas aux conteneurs compagnons ni aux autres
  machines. Audit demandé explicitement par l'utilisateur : "tu vas me vérifier pour tous les
  dockers installés les logs pour qu'elles rotatent... sur tous les modèles portés par dimotic-ha".
- **Inventaire complet fait** (`docker inspect $(docker ps -aq)` sur les 5 machines) : 16
  conteneurs trouvés sans rotation (sur ha2, noisy2, noisy, stfort, orangepi — `homeassistant`,
  `mosquitto`, `zigbee2mqtt`, `mqtt-io-rpigpio`, `dimotic-ha` sur les 3 machines pas encore
  resynchronisées avec le fix du dépôt, `portainer-agent`). Tous corrigés, vérifiés par un second
  balayage complet après coup — 100% des conteneurs actifs ont maintenant la limite (sauf
  `infallible_cohen` sur stfort, un `hello-world` de test arrêté depuis 2024, inoffensif, laissé
  tel quel).
- **Sauvegardes** : chaque `compose.yaml` modifié a été copié en `.bak-20260914` avant modification
  (14 fichiers au total, dont 1 nouveau créé — voir plus bas).
- **⭐ Découverte + correction (stfort) : conteneur `zigbee2mqtt` fantôme, supprimé** — trouvé en
  `docker run` brut, sans `compose.yaml` (seul cas non conforme à la convention `/docker/<app>/` du
  projet), planté depuis sa création en août 2025 (`/dev/ttyACM0` absent, seul `/dev/ttyUSB0` — déjà
  pris par RFXCOM — présent sur cette machine). D'abord régularisé en compose par erreur (pensant
  qu'un dongle avait été débranché depuis) — **corrigé par l'utilisateur** : stfort n'a **jamais** eu
  de clé/dongle Zigbee physique. `zdidnodezigbee` (bridge legacy — confirmé en lisant `zigbeeserv.js`
  : pont MQTT `zigbee2mqtt/#` ↔ `listsurvey`, même patron que `zdidnoderfxcom433e`/`zdidnodegpio`)
  est abonné aux messages MQTT **distants de ha2** (`zigbee.mq.address` dans `domo.properties`,
  cross-machine) et les traite normalement depuis là — aucun zigbee2mqtt local n'a jamais été
  nécessaire sur stfort. Conteneur arrêté + supprimé (`docker compose down`), fichier renommé
  `/docker/zigbee2mqtt/compose.yaml.disabled-20260914` avec une note explicative (gardé pour
  mémoire, à ne pas réactiver).
- **Incident annexe pendant le chantier** : un transfert `scp` vers stfort a été corrompu en route
  (même taille de fichier, MD5 différent — connexion instable ce soir-là, plusieurs timeouts SSH au
  niveau de l'échange de bannière malgré un ping qui répondait normalement) — détecté par
  vérification systématique des sommes MD5 locale/distante après coup sur les 14 fichiers touchés
  (tous les autres étaient intacts), re-transféré et revérifié avant de continuer. **Leçon** :
  toujours vérifier un MD5 après un `scp` vers une machine dont la connexion a montré des signes
  d'instabilité, ne pas se fier au code de retour de `scp` seul.

### 🟡 Compteur Solarman DDZY422-D2 (pilotage charge batterie) — conception faite, bloqué sur la doc registres (14/09/2026)
- **Contexte** : besoin de piloter la charge d'une batterie sur noisy → nécessite de lire le
  compteur électrique (grid side) de façon fiable. Le 3e logger Solarman (`10.10.10.7`, série
  2618005808, cf. section Solarman ci-dessous) est en fait ce compteur, pas un onduleur.
- **Diagnostic confirmé** : le module WiFi du compteur (protocole Solarman V5) rejette
  systématiquement les lectures Modbus locales (`AcknowledgeError`, indépendant du slave id/du
  profil) — cohérent avec les retours de la communauté HA francophone (fil dédié sur forum.hacf.fr,
  personne n'a de solution locale qui fonctionne pour ce modèle précis, y compris avec le fork plus
  complet `davidrapan/ha-solarman` — aucun profil `ddzy422-d2` n'existe dans aucun des deux forks,
  seul un cousin triphasé `solarman_dtsd422-d3.yaml` existe et ne fonctionne pas pour ce modèle).
- **✅ Bonne nouvelle trouvée** : le compteur a un vrai port RS485 (bornes A/B) **sur le compteur
  lui-même**, séparé du module WiFi (guide d'installation officiel Solarman, confirmé) —
  `Adresse 001, 9600 bps, parité Even, 8 bits, 1 stop`. Le module WiFi n'est qu'un relais RS485→cloud
  branché en interne ; en direct sur les bornes A/B on contourne le cloud et son "AcknowledgeError"
  intermittent. Le compteur a aussi un relais de coupure interne intégré (borne L↓ entrée grid /
  L↑ sortie vers charge, "Remote Control Meter" = coupure à distance native — pertinent pour le
  pilotage de charge envisagé).
- **Matériel** : l'utilisateur a un adaptateur RS485→USB, expédié avec le RPi4 ("noisy2") mais à
  brancher sur le **RPi3 "noisy"** (à côté physiquement du compteur — le RPi4 sera trop loin). HA
  tourne sur noisy2, pas sur noisy → architecture prévue : `ser2net`/`socat` sur noisy exposant
  `/dev/ttyUSB<N>` en Modbus-RTU-over-TCP, intégration `modbus:` native de HA (protocole
  `rtuovertcp`) sur noisy2 pointant sur `noisy:<port>` — pas besoin d'écrire une nouvelle app
  dimotic-ha, `mqtt-io` (déjà utilisé pour rpigpio) **ne supporte pas le Modbus RTU générique**
  (vérifié, seulement capteurs I2C/1-Wire/GPIO simples).
- **❌ Bloquant réel** : la table de registres Modbus du DDZY422-D2 n'est publiée nulle part
  publiquement trouvé (recherchée en profondeur : docs officielles Solarman = uniquement guides
  d'installation WiFi, pas de table de registres ; le document existe et est référencé par son nom
  — *"DDZY422-D2型单相远程费控智能电能表-modbus通讯内容 (HT-YF2018-0929-01)"* — mais son contenu
  n'est nulle part en ligne, même les mainteneurs des deux intégrations HA open-source ne l'ont pas).
  **Deux pistes pour la suite** : (1) contacter le support Solarman (`info@solarmanpv.com`) en
  citant ce nom de document exact ; (2) une fois le matériel sur place, scanner les registres
  0-100 en Modbus RTU standard (adresse 1, 9600/E/8/1) et comparer aux valeurs affichées sur
  l'écran du compteur (tension/courant/puissance/fréquence/PF/énergie déjà visibles en local) —
  probablement plus rapide que d'attendre une réponse du support.
  - **Reconfirmé le 14/09/2026** via la fiche produit Solarman helpcenter (variante GPRS
    DDZY422-D2-G, 3 pages, photos + caractéristiques, **toujours pas d'annexe table de
    registres**) : adresse esclave **001** par défaut, **9600 bauds, parité paire (E), 8 bits,
    1 stop** — identique à ce qui était déjà connu du guide rapide WiFi lu en début de soirée,
    rien de nouveau côté registres. Voir le plan d'écoute passive RS485 en tête de ce fichier
    (`scripts/rs485-sniffer.cjs`) — piste retenue pour obtenir la vraie table par l'observation
    du trafic réel plutôt que par la documentation (introuvable publiquement).
- **🟢 Piste alternative privilégiée : compteur Huawei DDSU666H de récupération** — l'utilisateur a
  un compteur Chint **DDSU666H** inutilisé, actuellement encore sur SON tableau électrique ici (pas
  encore chez noisy). Famille bien plus documentée que le DDZY422-D2 (intégration HA dédiée
  existante `helixzz/ha-modbus-powermeter`, registres connus pour la famille DDSU/DTSU666 en
  général : tension `0x2000`, courant `0x2002`, puissance `0x2004`, énergie import/export
  `0x4000`/`0x400A`). **Manuel officiel Chint DDSU666 lu en entier (ZTY0.464.1224, 21 pages)** —
  confirme : fonction Modbus **03H (Read Holding Registers) uniquement** (pas de 04H, à la
  différence d'autres compteurs de la même famille comme l'Eastron SDM), adresse esclave 1-247,
  trame série **8 bits données, PAS de parité, 2 bits de stop (8-N-2)** — ⚠️ **différent du
  DDZY422-D2 qui est en 8-E-1**, ne pas confondre si les deux coexistent un jour. Débit en bauds
  non trouvé dans ce manuel (table des registres de mesure absente — document séparé non publié) ;
  à lire sur l'écran/menu du compteur ou scanner (9600/19200/38400 les plus courants chez Chint).
  **Aucune spec DDSU666/DTSU666 toute faite** dans le dépôt communautaire `modbus2mqtt.config`
  (vérifié le 14/09/2026) — à construire empiriquement une fois branché (scan + comparaison avec
  l'affichage local, via l'UI web de modbus2mqtt qui a justement un outil de scan/découverte).
- **Outil retenu : [modbus2mqtt](https://github.com/modbus2mqtt)** (pas une nouvelle app
  dimotic-ha — décision utilisateur du 14/09/2026) — pont générique Modbus→MQTT avec découverte HA
  native, TypeScript/Node.js, déployable en conteneur compagnon **comme zigbee2mqtt sur ha2** (pas
  fusionné dans le `compose.yaml` de dimotic-ha lui-même). Template créé :
  `docker/modbus2mqtt/compose.yaml` (broker MQTT local, device RS485 à ajuster, publication prévue
  sur le préfixe `homeassist/` — même relais `nommage` déjà en place pour rpigpio/arexx, aucune
  modification de `nommage` nécessaire). Reste manuel (comme pour zigbee2mqtt à l'époque) : régler
  le "base/discovery topic" sur `homeassist` dans l'UI web de modbus2mqtt (port 3000) après premier
  démarrage.
- **✅✅ RÉSOLU le 14/09/2026 (après-midi) — carte de registres DDSU666H complète et vérifiée**.
  Adaptateur RS485→USB branché sur noisy2 pour test avant expédition (`/dev/ttyUSB0`, puce CH341,
  énumération USB instable au premier branchement — power-cycle automatique du port, résolu tout
  seul). `modbus2mqtt` déployé (`ghcr.io/modbus2mqtt/modbus2mqtt:latest` — **pas sur Docker Hub
  contrairement à sa propre doc**, corrigé dans `docker/modbus2mqtt/compose.yaml`,
  `network_mode: host` ajouté — sans ça `127.0.0.1` dans l'URL MQTT pointe vers le conteneur
  lui-même, `ECONNREFUSED`). **Éditeur web de spec trouvé très instable** (corruption de champs à
  plusieurs reprises, ex. `modbusAddress` empilant les saisies au lieu de remplacer) → **édition
  directe des fichiers JSON/YAML côté serveur** (`/docker/modbus2mqtt/config/modbus2mqtt/
  specifications/chint-ddsu666h.json`, `busses/bus.0/s1.yaml`) retenue, bien plus fiable.
  - **Paramètres réels confirmés par l'utilisateur sur l'appareil** : 9600 bauds, **adresse
    esclave 11** — 11 est l'adresse par défaut documentée dans le "DTSU666-HW Smart Power Sensor
    Quick Guide" officiel Huawei (confirme écosystème Huawei, cohérent avec son passé de moniteur
    sur un onduleur Huawei 5KTL).
  - **Carte de registres trouvée via <https://github.com/bcdiaconu/chint-mqtt-modbus-bridge/blob/main/docs/DDSU666-H.md>**
    (trouvé par l'utilisateur) puis **corrigée/complétée empiriquement** (2 adresses du doc
    original étaient fausses — trouvées par lecture brute + vérification physique
    P²+Q²=S² et PF=P/S, qui matchent exactement) :

    | Registre | Grandeur | Échelle | Note |
    |---|---|---|---|
    | `0x2000` | Tension (V) | ×1 | confirmé doc |
    | `0x2002` | Courant (A) | ×1 | confirmé doc |
    | `0x2006` | Puissance active (W) | **×1000** | confirmé doc — `0x2004` (hypothèse initiale) est toujours à 0, PAS le bon registre |
    | `0x200c` | Puissance réactive (var) | ×1000 | trouvé empiriquement, absent du doc GitHub |
    | `0x2012` | Puissance apparente (VA) | ×1000 | confirmé doc |
    | `0x2018` | Facteur de puissance | ×1 | **doc GitHub disait `0x2020`, faux** — corrigé par calcul PF=P/S |
    | `0x2020` | Fréquence (Hz) | ×1 | **doc GitHub disait `0x2021`, faux** — confirmé 49.98Hz |
    | `0x4000` | Énergie totale (kWh) | ×1 | confirmé doc |
    | `0x400A` | Énergie importée (kWh) | ×1 | confirmé doc + cohérence import−export=total |
    | `0x4014` | Énergie exportée (kWh) | ×1 | confirmé doc + cohérence import−export=total |

    Format commun à tous : Holding Registers (FC 03H), float32 (2 registres), big-endian. Signe
    puissance active : **négatif = injecté au réseau, positif = tiré du réseau** (convention Huawei).
  - **Plage de lecture valide** : `0x2000` à `0x2023` environ (au-delà, `Illegal data address`) —
    pas un bloc parfaitement contigu, certains registres intermédiaires (`0x2004`, `0x200a`,
    `0x2010`, `0x2016`, `0x201e`, `0x2022`) répondent mais valent 0 (réservé/non câblé sur cette
    variante monophasée).
  - **Fausse piste explorée et abandonnée** : au cours du diagnostic, une comparaison croisée avec
    `sensor.emma_puissance_active` (EMMA, compteur Huawei déjà en prod sur ha2) avait fait suspecter
    une pince ampèremétrique mal fermée (EMMA stable pendant que le courant du DDSU fluctuait) — en
    fait c'était juste le mauvais registre/la mauvaise échelle (`0x2004` au lieu de `0x2006`×1000) ;
    une fois corrigé, les valeurs sont cohérentes en interne (triangle des puissances vérifié) même
    si elles ne collent pas exactement à EMMA à tout instant (charge de la maison qui varie vite,
    pas la même prise de mesure au même moment). **Pas de problème matériel réel identifié.**

### ✅ Thermostats virtuels de l'ancienne domotique migrés vers `generic_thermostat` HA (14/09/2026)
- **Contexte** : l'ancien système avait 8 "thermostats virtuels" (`protocol: virtualther` dans
  `equipements.json`) — un trio {thermostat virtuel, capteur température, radiateur GPIO} par
  pièce, liés uniquement par correspondance de nom (`sarahname`/`lieu`). Le module
  `zdidnodevirtualther` ne gérait que la consigne (slider) ; la vraie logique de pilotage vivait
  dans `zdidnodedomoregles/regles/r0060chauffage.js` — hystérésis simple : ON si
  température ≤ consigne, OFF si température ≥ consigne + tolérance (tolérance globale, 0 par
  défaut sur ce site), bande morte entre les deux, avec un interrupteur global manuel/désactivation
  (`regles.chauffage.reglage.disable`/`.manuel`).
- **8 trios identifiés** (pièce → capteur → radiateur) : chambre de evan, salon (GPIO 18) et salle
  à manger (GPIO 13) — les deux dans le même `lieu` "salle" mais distingués par `sarahname` —,
  cuisine, chambre de drystan, chambre, salle de bain, toilettes (seule à utiliser un capteur
  RFXCOM `temp2` 0xde01 au lieu d'arexx).
- **Migré vers `generic_thermostat`** (intégration native HA, pas de code à écrire) :
  `/docker/homeassistant/config/climate.yaml` sur noisy2 (8 entrées, `!include` depuis
  `configuration.yaml`, backup `configuration.yaml.bak-pre-climate-20260914`), consignes/état
  initial repris de la dernière sauvegarde réelle (`thermostats.json`, 27/05/2026) ; `min_temp`/
  `max_temp` repris d'`equipements.json`. **Écart volontaire du comportement legacy** :
  `cold_tolerance`/`hot_tolerance` réglés à 0,3°C (l'ancien système utilisait 0/0, pas de marge —
  risque de cyclage rapide du relais si reproduit à l'identique) — à ajuster si un comportement
  plus strict est voulu.
- **Vérifié en conditions réelles** : `check_config` HA OK, 8 entités `climate.*` créées, cibles
  correctes. 2 sur 8 fonctionnels immédiatement avec de vraies valeurs (chambre : 24.8°C, chambre
  de drystan : 25.4°C) — les 6 autres capteurs arexx `unavailable` : **piles à changer** (confirmé
  utilisateur, pas un bug de config) ; `sensor.toilettes_temperature` (RFXCOM) à `unknown`, aucune
  trame reçue pour l'instant. Reprendra automatiquement sans reconfiguration une fois les capteurs
  de nouveau actifs.
- **Reste à faire** : changer les piles des capteurs arexx concernés ; vérifier que le capteur
  RFXCOM toilettes remonte bien une trame ; tester un vrai cycle de chauffe complet une fois les
  capteurs actifs.

### ✅ rpigpio : `ha_discovery.prefix` de mqtt-io décalait le format du topic de découverte HA d'un segment — corrigé, validé en conditions réelles sur `noisy`
- **Contexte (14/09/2026)**, trouvé en essayant de faire remonter les entités `rpigpio` de `noisy`
  dans le HA de `noisy2` (voir plus bas, chantier "noisy2 : bring-up complet") : les switches GPIO
  n'apparaissaient jamais dans HA, ni via `nommage`, ni nativement.
- **Cause racine** : `generateMqttIoConfig()` (`applications/rpigpio/src/domain/generator.ts`)
  injectait `/${effectiveBridgeInstance}` à la fois dans `topic_prefix` ET dans
  `ha_discovery.prefix` (fait le 06/09/2026, fonctionnelles-supervisor_specs v2.3 §9.2, pour éviter
  que deux machines rpigpio partagent le même préfixe mqtt-io par défaut). Pour `topic_prefix`
  (état/commande interne), aucun souci. Mais pour `ha_discovery.prefix`, ça décale le topic de
  découverte HA à **4 niveaux** (`prefix/bridgeInstance/component/node_id/object_id/config`) —
  or le format officiel de découverte MQTT HA n'accepte que **2-3 niveaux**
  (`prefix/component/[node_id/]object_id/config`). Ni HA lui-même, ni notre `nommage` (même
  contrainte, voir schéma ci-dessous) ne reconnaissent un topic à 4 niveaux — rejet **silencieux**
  des deux côtés (aucune erreur logguée, juste aucune entité créée).
- **Correctif** (`generator.ts`) : au lieu d'injecter le bridgeInstance dans `ha_discovery.prefix`,
  il est maintenant fourni comme `mqtt.client_id` explicite dans le config.yaml généré. mqtt-io
  l'utilise déjà nativement comme `node_id` du topic de découverte ET comme base d'`unique_id`
  (`home_assistant.py::hass_announce_digital_output`, `mqtt_options.client_id`) — même
  désambiguïsation multi-machines obtenue, sans segment de topic en plus. Bénéfice annexe : sans
  `client_id` explicite, mqtt-io serait retombé sur un hash SHA1 opaque du `topic_prefix`
  (`server.py::_run()`) — maintenant un identifiant lisible (`rpigpio_bridge_noisy_noisy`) au lieu
  d'un hash.
- **Vérifié en conditions réelles sur `noisy`** (pas juste en local) : `client_id:
  rpigpio_bridge_noisy_noisy` et `ha_discovery.prefix: homeassist` (propre) dans le config.yml
  généré ; topic réel confirmé à 3 niveaux (`homeassist/switch/rpigpio_bridge_noisy_noisy/7/config`) ;
  `unique_id: rpigpio_bridge_noisy_noisy_rpi_output_7` (lisible). Déployé via le bouton "Déployer"
  de l'UI rpigpio (tunnel SSH + navigateur), `mqtt-io-rpigpio` redémarré avec succès sur `noisy`.
  **Build fait** (`npm run build` dans `applications/rpigpio`), pas de tests automatisés existants
  pour ce module. **Patché en direct sur le conteneur `dimotic-ha` de `noisy`** (`docker cp` du
  `dist/domain/generator.js` compilé) pour validation avant relâchement versionné — **pas encore
  publié comme nouvelle version Docker officielle** (reste à faire : bump version, `docker buildx`
  multi-arch, push, redéploiement propre sur toutes les machines rpigpio — actuellement stfort tourne
  encore l'ancien code, fonctionnellement inchangé pour stfort tant que personne n'essaie de relayer
  ses entités via `nommage`/un pont comme ici).

### ✅ nommage : schéma `discoveryTopics` étendu à un 3e niveau (4 wildcards) — nécessaire mais pas suffisant à lui seul
- **Contexte (14/09/2026)** : avant de trouver le vrai correctif rpigpio ci-dessus, `nommage`
  (`applications/nommage/src/domain/config-schema.ts`) a été étendu pour accepter un pattern à 4
  wildcards (`prefix/+/+/+/+/config`), en plus des 2 patterns officiels HA déjà supportés — motivé à
  l'origine par le besoin (mal diagnostiqué sur le coup) de lire les topics rpigpio à 4 niveaux.
  Reste BORNÉ (pas un joker `#`), donc pas la même classe de risque que l'incident historique déjà
  documenté dans ce fichier (crash par afflux de messages). Build fait, patché en direct sur
  `noisy2` (`docker cp`), validé sans boucle (12 messages parsés puis stable). **Conservé** même
  après le vrai correctif rpigpio (utile si une future source a un format à 4 niveaux), mais **n'est
  plus le chemin emprunté par rpigpio** désormais (ses topics sont repassés à 3 niveaux).
- **Bug distinct trouvé au passage, PAS corrigé** : `emitPassthroughDiscovery()`
  (`NommageService.ts:479`) calcule `json_attributes_topic` à partir du topic SOURCE (préfixe
  étranger, ex. `homeassist/...`) au lieu du topic REWRITTEN (`homeassistant/...`) réellement publié
  — le champ `json_attributes_topic` dans le payload relayé pointe donc vers un préfixe que HA ne
  surveille pas, les attributs de taxonomie n'atteignent jamais l'entité HA. Cosmétique (n'empêche
  pas la création de l'entité elle-même), pas corrigé ce soir, à reprendre — vérifié en conditions
  réelles sur les switches rpigpio ET les capteurs arexx (même bug des deux côtés).

### ✅ Bug daemon Docker (conteneur fantôme après pull interrompu) et log sans rotation — voir entrées existantes plus bas
Retrouvés à nouveau ce soir sur `noisy2` pendant ce chantier — mêmes correctifs déjà appliqués
(`systemctl restart docker` pour le fantôme, `logging: {max-size, max-file}` pour la rotation, déjà
dans `compose.yaml`/`compose.deploy.yaml` du dépôt depuis plus tôt le 14/09).

## Prochaine session

- **📌 14/09/2026 (nuit même)** : **publier une vraie version Docker** des correctifs `nommage`
  (3e pattern discoveryTopics) + `rpigpio` (client_id au lieu du hash) validés ce soir sur `noisy`/
  `noisy2` uniquement en patch à chaud (`docker cp`, pas relâché officiellement) — bump version,
  `docker buildx` multi-arch, push `zdid2/dimotic-ha`, redéploiement propre sur `noisy`, `noisy2`,
  `stfort`, `ha2`, `orangepi` (stfort tourne encore l'ancien `generator.ts`, sans impact tant que
  personne n'y relaie via un pont comme celui posé sur noisy2 ce soir). Corriger au passage le bug
  `json_attributes_topic` de `nommage` trouvé au passage (voir entrée dédiée ci-dessus).
- **📌 14/09/2026** : `noisy2` a maintenant un **pont mosquitto permanent vers `noisy`**
  (`/docker/mosquitto/config/mosquitto.conf`, via le tunnel WireGuard) — à réévaluer une fois `noisy2`
  physiquement sur le LAN de `noisy` (probablement à retirer, LAN direct suffira).
- **📌 14/09/2026** : reprendre la migration du plan **HAPLAN** pour noisy (mise de côté ce soir le
  temps de résoudre la chaîne rpigpio→HA) — matière prête (`plan-original.png`, coordonnées
  `equipements.json`), et **maintenant que les 12 switches rpigpio ET les 8 capteurs arexx sont de
  vraies entités dans le HA de noisy2**, plus besoin de se limiter à arexx seul comme envisagé plus
  tôt dans la soirée.

### ✅✅ rfxcom activé sur noisy — trouvaille critique en route : conflit RÉEL d'accès au port série (pas juste théorique), corrigé
- **Contexte (14/09/2026 nuit)**, mise en service réelle de `rfxcom` sur noisy (demande explicite du
  13/09 au soir) : retrait de `rfxcom` de `disabledApps` (`data/core/config.yaml`), redémarrage de
  `dimotic-ha` — transceiver RFXCOM initialisé avec succès sur `/dev/ttyUSB0` (détecté via
  `/dev/serial/by-id/usb-RFXCOM_RFXtrx433_A1YKN7SN...`), 35 devices/20 récepteurs chargés,
  `bridgeInstance` correct (`rfx_bridge_noisy_noisy`), découverte publiée (55 topics).
- **⚠️ Trouvaille critique** : contrairement à ce qui était noté ("rfxcombridge.js déjà corrigé
  préventivement"), **le dossier live `/home/domotique/node_applications/zdidnoderfxcom433e/` sur
  noisy n'avait EN RÉALITÉ jamais reçu l'adaptation pont** — fichier `appmean.js` daté d'octobre
  2023, aucun `rfxcombridge.js` présent. Les fichiers adaptés (`zdidnoderfxcom433e-ha/`) n'avaient
  été préparés que dans `~/noisy-migration/noisy-stick/` sur le PC de dev, jamais réellement
  déployés sur le vrai noisy (contrairement au GPIO, qui lui avait bien été déployé le 13/09).
  **Conséquence concrète** : `vrfx` (module legacy) et le vrai driver `rfxcom` de dimotic-ha
  avaient **tous les deux `/dev/ttyUSB0` ouvert simultanément** (confirmé via `fuser`) — un vrai
  risque de corruption des trames RF reçues (lectures partagées de façon imprévisible entre deux
  processus), pas juste un risque théorique.
- **Corrigé** : backup du dossier live
  (`zdidnoderfxcom433e.bak-pre-bridge-20260914`), `supervisor forcestop rfx` (arrêt réel, pas juste
  un rebond), déploiement des 4 fichiers adaptés (`app.js`/`appmean.js`/`rfxcomserv.js`/
  `rfxcombridge.js`, `node --check` OK sur les 4), `supervisor start rfx`. **Premier `start` sans
  effet** (aucun process `vrfx` relancé) — cause : `appmean.js` lit `rfx.dimoticha` dans
  `domo.properties` (mécanisme jumeau de `gpio.dimoticha`, déjà écrit dans le fichier lors de la
  préparation mais jamais activé) pour choisir entre pont MQTT et accès matériel réel — valeur
  encore à `dimotic` (défaut), donc `appmean.js` tentait de charger le mode matériel réel envers
  et contre le port déjà tenu par dimotic-ha. **Corrigé** : `rfx.dimoticha=dimotic` → `ha` dans
  `domo.properties` (backup `domo.properties.bak-pre-rfx-dimoticha-20260914`) — modifier ce fichier
  déclenche un redémarrage complet du superviseur (fs.watch, comportement connu), `vrfx` reparti
  automatiquement. **Vérifié stable** : `fuser /dev/ttyUSB0` ne montre plus que le PID de
  dimotic-ha, `vrfx` confirmé actif sans le port (pont MQTT pur).
- **Reste à faire** : tester une vraie commande depuis l'ancienne interface (pas fait cette nuit),
  vérifier réception RF passive réelle (comme fait pour le GPIO plus tôt cette session).

- **📌 14/09/2026 (demain)** : construire un **utilitaire de diagnostic Solarman** (décoder les
  trames + vérifier qu'on a tout ce qu'il faut pour réussir une vraie intégration HA native
  Modbus/Solarman sur les loggers Deye de noisy) — intention exprimée par l'utilisateur le
  13/09/2026 au soir (contexte de la demande perdu, discuté plus tôt le 13/09 dans une partie de
  session antérieure non conservée en mémoire — repartir de zéro sur le "pourquoi"/le détail exact
  si besoin).
  - **Déjà validé ce soir (13/09/2026 tard)** : chemin réseau complet OK bout en bout — tunnel
    WireGuard + NAT sur noisy + négociation protocole Solarman réussie (poignée de main confirmée,
    numéro de série vérifié dans la trame retour) jusqu'au logger 2 (serial `2618005808`, adresse
    fantôme `10.10.10.7`, MAC `D4:27:87:7D:F2:3E`, retrouvé par découverte UDP broadcast
    `WIFIKIT-214028-READ` sur le port 48899).
  - **Pas encore trouvé** : la bonne carte de registres Modbus pour ce modèle Deye précis — essais
    à l'aveugle (holding + input registers, adresses 0/0x3C/0x96/0x150) tous rejetés en
    `AcknowledgeError` (négociation transport OK, mauvaise adresse/mauvais slave ID côté Modbus).
    **Prochaine étape** : demander/trouver le modèle exact de l'onduleur/logger (étiquette) pour
    chercher la carte de registres officielle, plutôt que deviner.
  - **Loggers 1 (`.157`) et 3 (`.119`) injoignables ce soir** (ping échoue même en LAN direct depuis
    noisy, hors tunnel) — probablement en veille nocturne (pas de soleil), à revérifier de jour.
  - Outillage prêt pour repartir dessus : venv Python `scratchpad/solarman-venv` (`pysolarmanv5`
    installé), script `scratchpad/test-solarman-tunnel.py` (non conservé — dans le scratchpad de
    session, à recréer si besoin).

## Problèmes prioritaires

### 🟡 stfort : deux brokers MQTT différents pour GPIO (`gpiobridge.js` → ha2, `mqtt-io` → local) — cause racine du silence total constaté en testant depuis l'ancienne domotique, corrigé, test bout en bout restant
- **Contexte (13/09/2026)**, trouvé en essayant de valider le correctif de double-inversion (voir
  entrée dédiée) sur stfort : **aucune commande GPIO de l'ancienne interface n'atteignait
  `mqtt-io`**, silence total (contrairement à noisy où la commande arrivait, juste inversée).
- **Cause** : `domo.properties` (`mqtt.server.addressport=192.168.1.51:1883`, **ha2**, pas le
  broker local de stfort) — confirmé par les connexions TCP réelles de `vgpio`/`vrfx`
  (`ss -tnp`, toutes vers `192.168.1.51:1883`). `gpiobridge.js` lit cette même propriété
  (`resolveMqttUrl()`) → publie donc aussi vers **ha2**. Mais `mqtt-io-rpigpio` (conteneur séparé,
  pas dimotic-ha) était configuré avec `mqtt.host: 127.0.0.1` (**broker local**) — deux brokers
  différents, et **aucun pont mosquitto pour `mqttio/rpigpio/#`** (seuls `rfxcom/#` et
  `zigbee2mqtt/#` sont pontés vers ha2 via `/etc/mosquitto/conf.d/bridge-ha2-*.conf`) — donc les
  deux bouts ne se rencontraient jamais. Pour RFXCOM, ce n'était pas un problème : le driver
  dimotic-ha (`ha.mqtt.host: 192.168.1.51`) et le pont mosquitto compensaient déjà le décalage.
- **Décision utilisateur (13/09/2026)** : architecture cible = **un seul broker central, celui de
  ha2** — pas de broker local sur stfort à terme. Donc PAS reconfigurer `domo.properties` vers le
  local (déjà tenté puis annulé dans la session), mais reconfigurer **`mqtt-io-rpigpio`** pour
  parler à ha2 lui aussi.
- **✅ Fait** : `data/rpigpio/config.yaml` de stfort (`mqtt.host`) changé de `127.0.0.1` →
  `192.168.1.51` (backup `.bak-pre-broker-ha2-20260913`), `dimotic-ha` redémarré pour recharger,
  redéployé via l'UI — `mqtt-io-rpigpio` confirmé connecté à ha2 (logs).
- **✅ Fait (13/09/2026)** : reliquat "on" sur `id=15`/`id=7` nettoyé — republié `OFF` avec
  `retain:true` **directement sur ha2** (192.168.1.51, pas le mosquitto local de stfort — les deux
  brokers ne sont pas pontés pour `mqttio/rpigpio/#`, piège tombé dedans une première fois avant de
  corriger). Vérifié par `raspi-gpio get 22`/`get 4` (level=0) et par les logs `mqtt-io-rpigpio`
  (`Digital output '15' set to False (off)`, idem `'7'`).
- **✅ Fait (13/09/2026)** : mosquitto natif local de stfort désactivé (`systemctl stop mosquitto
  && systemctl disable mosquitto`, confirmé `inactive`/`disabled`) — demande explicite utilisateur.
  Vérifié avant coupure qu'aucun service local (zigbee2mqtt, stick RFXCOM) ne dépendait du broker
  local (`systemctl list-units` : rien, seul mosquitto écoutait sur 1883) ; après coupure,
  `mqtt-io-rpigpio` et `dimotic-ha` tournent sans erreur (déjà connectés à ha2, non affectés).
- **⚠️ Reste à faire** :
  1. Tester bout en bout depuis l'ancienne interface (utilisateur indisponible en fin de session
     précédente) — à refaire dès que possible pour valider tout le chemin (double-inversion +
     BRIDGE_INSTANCE + broker ha2 + retain, ensemble).
  2. **✅ Fait (13/09/2026)** : `bridge-ha2-rfxcom.conf`/`bridge-ha2-zigbee.conf` supprimés de
     stfort (`/etc/mosquitto/conf.d/`, sauvegardés dans
     `backups/stfort-mosquitto-conf.d/*_backup_2026-09-13.conf`) — confirmés inertes (rien ne
     publiait plus localement sur `rfxcom/#`/`zigbee2mqtt/#`, mosquitto local déjà désactivé).
  3. Nettoyer aussi les résidus de découverte HA doublée trouvés plus tôt sous l'ancien nom
     `rpigpio_bridge_stfort` (sans suffixe machineId) sur `mqttio/rpigpio/#` et `homeassist/#` —
     namespace séparé de ce qui précède, nettoyage à faire sur ha2 directement.
  4. Vérifier si **noisy** a une configuration MQTT cohérente (à ce jour, tout pointe vers
     `127.0.0.1` sur noisy — noisy n'a pas de ha2/machine centrale équivalente à ce jour, donc ce
     problème spécifique ne devrait pas s'y poser, mais à confirmer si l'architecture évolue).

### 🟢 stfort : conflit cosmétique "conflicts with existing device trigger" sur les scènes RFXCOM — cause identifiée, pas de correctif codé (décision explicite)
- **Contexte (13/09/2026)**, trouvé en vérifiant la conformité des noms de bridge MQTT discovery
  sur ha2 suite à l'arrêt/redémarrage complet de la chaîne (HA + dimotic-ha toutes machines +
  dimotic stfort + zigbee2mqtt + mqtt-io-rpigpio + mosquitto, dans cet ordre, relancé en
  commençant par mosquitto sur ha2) : logs HA truffés de
  `[homeassistant.components.mqtt.device_trigger] Config for device trigger
  rfx_bridge_stfort_stfort_578666 rfxcom_scene_scene_100085{1,2,3} conflicts with existing device
  trigger`.
- **Vérifié : PAS un problème de nommage** — `homeassistant/device_automation/#` sur ha2 ne contient
  que 3 topics, tous sous le nom actuel correct `rfx_bridge_stfort_stfort_578666`, aucun résidu
  d'ancien nom (`rfx_bridge_local_test`, `rfx_bridge_stfort` sans suffixe...).
- **Cause réelle** : HA a publié son "birth message" (`homeassistant/status`=`online`) **deux fois
  en 26 secondes** (21:01:41 puis 21:02:07, logs `dimotic-ha` stfort, `grep 'birth message'`) —
  avant même l'opération d'arrêt/redémarrage de ce soir, donc un comportement pré-existant. Chaque
  birth message déclenche correctement (comportement standard attendu d'une intégration MQTT
  discovery) une republication complète de la découverte RFXCOM par `RfxComService.
  publishSceneDiscovery()` (`applications/rfxcom/src/domain/RfxComService.ts`). Deux republications
  quasi simultanées du même topic retenu → HA traite la 2e vague avant d'avoir fini d'enregistrer
  la 1ère → conflit interne.
- **Donc** : ni un bug de nommage, ni un bug dimotic-ha à proprement parler (il réagit correctement
  à chaque birth message reçu) — la vraie anomalie est que HA a émis 2 birth messages coup sur coup
  (cause côté HA non investiguée, ex. reconnexion MQTT qui flappe). Purement cosmétique : le trigger
  de la 1ère publication reste enregistré et fonctionnel, seule la 2e (identique) échoue à
  s'enregistrer en doublon.
- **Zéro occurrence** depuis le redémarrage propre de ce soir (21:39) au moment de l'investigation.
- **Décision utilisateur (13/09/2026)** : laisser tel quel pour l'instant, pas de correctif codé
  (anti-rebond sur le birth message envisagé mais pas implémenté), juste consigné ici pour
  référence si ça redevient gênant ou plus fréquent.

### 🔴 rpigpio : `data/rpigpio/config.yaml` en ancien format `target:` (singulier) — cassé en prod sur stfort
- **Contexte (13/09/2026)**, trouvé en déployant `rpigpio` pour de vrai sur noisy (premier vrai
  déploiement dimotic-ha sur cette machine) : le schéma `rpigpioConfigSchema`
  (`applications/rpigpio/src/domain/config-schema.ts`) attend `targets: [{id, host, hostDir,
  containerName, image}]` (tableau, max 1 élément) depuis le 23/08/2026 — `target:` (objet
  singulier, ancienne forme) n'existe plus dans le schéma et est simplement strippé par Zod, laissant
  `targets` vide.
- **Corrigé sur noisy** (`data/rpigpio/config.yaml`, forme tableau avec `id: noisy`) — sans ce
  correctif, `rpigpio:remote-op` échoue avec "Cible introuvable", aucun déploiement possible.
- **⚠️ Vérifié le même jour : stfort a EXACTEMENT le même problème en production**
  (`/docker/dimotic-ha/data/rpigpio/config.yaml` sur stfort, toujours `target:` singulier). Le
  conteneur `mqtt-io-rpigpio` déjà déployé là-bas continue de tourner (c'est juste un conteneur
  Docker existant, indépendant de la validité de la config dimotic-ha), mais **toute tentative de
  redéploiement/modification des pins depuis l'UI échouerait** tant que ce n'est pas corrigé. Pas
  touché — à corriger avec l'utilisateur avant la prochaine intervention sur les pins GPIO de
  stfort.

### 🔴 zdidnodedomoutil/appli.js : version PARTAGÉE noisy jamais alignée sur celle de stfort — appel objet vs positionnel
- **Contexte (13/09/2026)**, trouvé en déployant `zdidnodegpio` (bridge) pour de vrai sur noisy :
  `app.js` copié de stfort appelle `appli(appliname, {withreplication, withsensorstypes, loglevel,
  isloggermqtt, isonlyloggermqtt})` (forme objet) — mais `zdidnodedomoutil/appli.js`, un module
  **partagé** entre toutes les apps legacy de noisy, n'a jamais été mis à jour pour accepter cette
  forme : il attend toujours l'appel positionnel d'origine (`appli(appliname, logLevel,
  isloggermqtt, isonlyloggermqtt)`). Résultat : `TypeError: leveltype.toLowerCase is not a
  function`, plantage en boucle du module au démarrage.
- **Corrigé** pour `zdidnodegpio/app.js` (appel positionnel restauré) + préventivement pour le futur
  `zdidnoderfxcom433e-ha/app.js` (pas encore déployé sur noisy, même piège évité par anticipation).
- **Risque plus large non exploré** : d'autres divergences entre le `zdidnodedomoutil`/
  `zdidnodeutil` partagé de noisy et celui de stfort sont possibles (ce n'était qu'un symptôme
  trouvé par hasard) — à garder à l'esprit avant de recopier tout autre fichier "générique" de
  stfort vers noisy sans le tester en conditions réelles d'abord.

### 🔴 gpiobridge.js/rfxcombridge.js (legacy) : `BRIDGE_INSTANCE` en dur ne suit plus `computeBridgeInstance()` — risque réel sur stfort en prod
- **Contexte (13/09/2026)**, trouvé en préparant un test Docker pour noisy, AVANT tout déploiement :
  depuis le 06/09/2026, `computeBridgeInstance()` (`applications/core/src/ha/integration/types/
  ha-mqtt.ts`) suffixe `_<machineId>` au `bridgeInstance` configuré pour TOUTE app dimotic-ha
  (`arexx`/`evoo7`/`rfxcom`/`rpigpio`) — `config.bridgeInstance` n'est plus qu'un préfixe, l'identifiant
  final inclut le `machineId` de la machine (`RpigpioService.effectiveBridgeInstance`,
  `RfxComService.effectiveBridgeInstance`).
- Les ponts legacy `gpiobridge.js`/`rfxcombridge.js` (stfort ET la copie adaptée pour noisy) codent
  `BRIDGE_INSTANCE` en dur, **sans** le suffixe `_<machineId>` — ils datent du 17-28/08/2026, avant
  ce changement. **Corrigé pour noisy le 13/09/2026** (`rpigpio_bridge_noisy_noisy` /
  `rfx_bridge_noisy_noisy`, cohérent avec `machineId: noisy` fixé en dur dans son
  `data/core/config.yaml`).
- **✅✅ Volet gpio corrigé ET vérifié sur stfort le 13/09/2026**, en réactivant `rpigpio` sur
  stfort (désactivé jusque-là dans `disabledApps`, `target:`/`targets:` corrigé — voir plus bas) :
  `machineId` réel confirmé `stfort_578666` (auto-généré, pas fixé en dur comme noisy).
  - **Un premier essai a cassé la prod pendant quelques minutes** (leçon à retenir) : corriger
    `BRIDGE_INSTANCE` dans `gpiobridge.js` SEUL, sans redéployer `mqtt-io` en même temps, désynchronise
    immédiatement le pont du conteneur déjà tournant (qui utilisait encore l'ancien nom) — repéré et
    annulé (revert) en quelques minutes, avant tout impact durable.
  - **Refait correctement en séquence coordonnée**, sur demande explicite de l'utilisateur :
    0) `vgpio` arrêté (par l'utilisateur), 1) `mqtt-io-rpigpio` arrêté aussi (rien ne pilotait plus le
    GPIO), 2) `initial:off` réglé sur les 3 pins via l'UI, 3) `mqtt-io-rpigpio` redéployé avec le bon
    nom effectif (`rpigpio_bridge_stfort_stfort_578666` — au passage, clé SSH auto-générée manquante
    détectée et ajoutée à `authorized_keys`), 4) `gpiobridge.js` corrigé d'abord sur la référence
    locale `stfort-templates/` ("dev"), PAS juste le fichier live (même `BRIDGE_INSTANCE` que le
    conteneur + `retain:true` ajouté au passage, jamais fait sur cette référence), puis déployé sur
    stfort, 5) `vgpio` relancé. Vérifié stable + toujours en mode pont (`/proc/<pid>/maps`, aucun
    `/dev/mem`) + état électrique des 3 pins cohérent avec `initial:off` (`raspi-gpio`).
- **✅✅ Volet rfxcom vérifié ET corrigé sur stfort le 13/09/2026 — panne active confirmée, pas
  juste un risque théorique.** `rfxcombridge.js` utilisait `rfx_bridge_local_test`, qui ne
  correspondait déjà PAS au préfixe configuré (`data/rfxcom/config.yaml: bridgeInstance:
  rfx_bridge_stfort`), avant même le suffixe `_<machineId>`. Le vrai driver (confirmé dans les logs
  du conteneur dimotic-ha : `"Bridge connecté: rfxcom:rfx_bridge_stfort_stfort_578666"`) écoute sur
  `rfx_bridge_stfort_stfort_578666` — total désalignement, **aucune commande RFXCOM de l'ancienne
  interface n'atteignait le matériel physique** (câblé sur stfort, `/dev/ttyUSBRFXCOM` confirmé
  présent) depuis un moment. Contrairement à gpio, pas de conteneur séparé à redéployer ici (le
  driver rfxcom tourne en process interne du conteneur dimotic-ha, déjà avec le bon nom depuis le
  passage à 2.5.2) — une seule correction a suffi : `rfxcombridge.js` corrigé sur la référence dev
  `stfort-templates/` (repartant du VRAI fichier live, pas de la copie figée du 17/08 qui aurait
  fait régresser le correctif `resolveMqttUrl()` du 28/08 — backup
  `.bak-pre-bridgeinstance-fix-20260913`), déployé, `vrfx` relancé (`supervisor restart rfx`).
  Vérifié stable, toujours en mode pont (aucun fd tty ouvert sur le port série réel).

### 🔴 rpigpio : pas d'état initial au démarrage — **confirmé en conditions réelles, les 12 relais de noisy basculent à CHAQUE redémarrage du conteneur**
- **Contexte (13/09/2026)**, en croisant `equipements.json` (legacy, site "noisy") avec le
  `rpigpio-pins-v1.0.yaml` généré (voir `MIGRATION_noisy_2026-09-10.md` §5bis) : `equipements.json`
  encode un état initial au démarrage dans le champ `num` (`phys<N>:o:[inv:]<on|off>`) — sur les 12
  relais de noisy, seuls `phys7` (`ballon` garage, non inversé) et `phys16` (`journuit` garage,
  inversé) y sont explicitement marqués "démarrer allumés".
- `pinDefinitionSchema` (`applications/rpigpio/src/domain/storage-schema.ts`) et
  `generateMqttIoConfig`/`buildPinEntry` (`generator.ts`) n'ont **aucun champ** pour porter cette
  sémantique.
- **⚠️ Vérifié en conditions réelles le 13/09/2026, lors du reboot de noisy après le premier vrai
  déploiement `dimotic-ha`** : au redémarrage du conteneur `mqtt-io-rpigpio`, les **12** pins
  (pas seulement `phys7`/`phys16`) sont repartis à un niveau électrique LOW par défaut — une fois
  traduit par le flag `inverted` de chacun, ça donne un mélange ON/OFF qui ne correspond ABSOLUMENT
  PAS à l'état réel voulu (10 radiateurs qui étaient éteints se sont retrouvés "allumés" côté
  logique, ballon/journuit/chauffage garage qui devaient être allumés se sont éteints). Constaté et
  corrigé à la main via `mosquitto_pub` (état restauré à l'identique, vérifié par lecture
  `raspi-gpio`) — **mais ça se reproduira à chaque redémarrage du conteneur** (reboot machine,
  `docker restart`, mise à jour de l'image...) tant que ce n'est pas corrigé. Plus large que prévu
  au départ : même `phys33` (chauffage garage), qui n'a pourtant aucun "init:on" explicite dans
  `equipements.json`, était concerné — ce n'est pas qu'une question des 2 pins à "init on" du
  fichier statique, c'est TOUT état réel accumulé qui se perd au redémarrage.
- **✅ Corrigé le 13/09/2026** — vérifié dans le vrai code source `mqtt-io` installé (pas juste sa
  doc) : `digital_outputs` supporte nativement `initial: high|low` + `publish_initial: true/false`
  (`mqtt_io/config/config.schema.yml:791+`). Deux correctifs complémentaires appliqués :
  1. `pinDefinitionSchema.initial` (`'on'|'off'`, optionnel) + `generator.ts::buildInitialFields`
     (traduit en `high`/`low` selon `inverted`) + champ dans l'UI (`index.html`+`app.ts`, badge
     d'affichage inclus) — couvre le TOUT PREMIER démarrage. Build TypeScript OK, zéro erreur.
     **Committé dans le repo mais PAS ENCORE actif sur noisy** : `dimotic-ha` y tourne depuis
     l'image `zdid2/dimotic-ha` publiée sur Docker Hub, pas depuis ce code source local — il faudra
     une reconstruction+publication de l'image pour que ça prenne effet en réel.
  2. `gpiobridge.js` publie désormais ses commandes avec `retain: true` (au lieu de sans retain) —
     couvre TOUS les redémarrages suivants en restaurant le **dernier état réel commandé** (pas
     juste un défaut figé), y compris pour des pins sans valeur `initial` explicite dont l'état
     change dynamiquement (cron/thermostat, ex: `phys33` chauffage garage). **Déployé et vérifié en
     conditions réelles sur noisy** (`vgpio` rechargé via `supervisor restart gpio` — `stop` seul
     ne relance PAS automatiquement dans ce cas, contrairement à ce qu'on avait cru plus tôt ;
     confirmation empirique par souscription MQTT immédiate + lecture `raspi-gpio`, état électrique
     final identique à l'état réel voulu sur les 12 pins).
  - **✅ Reporté sur stfort le 13/09/2026** : `gpiobridge.js` (backup
    `.bak-pre-retain-20260913`) même correctif `retain:true`, `vgpio` rechargé
    (`supervisor restart gpio`, nouveau PID confirmé stable, toujours en mode pont — aucun accès
    `/dev/mem`). Pas de test d'écriture sur les vrais relais de stfort (pins/états voulus non
    documentés dans cette session, contrairement à noisy) — le `retain` se mettra en place
    naturellement à la première vraie commande envoyée par le système. Le champ `initial` (v2.5.2)
    n'a en revanche PAS été renseigné pour les pins de stfort (pas dans le périmètre de cette
    demande) — à faire séparément si souhaité.
- **✅✅ Les deux volets déployés ET validés en conditions réelles le 13/09/2026** : commit
  `a29e973` (branche `fix/rpigpio-initial-state`, fusionnée sur `main`), tag `v2.5.2`, build
  multi-arch + push Docker Hub via `docker/rebuild-and-deploy.sh 2.5.2 --skip-ha2 --skip-orangepi`
  (ha2/orangepi non touchés, contrainte de session respectée), déployé sur noisy (`docker compose
  pull && up -d`, "2.5.2 - noisy" confirmé dans l'UI). `phys7`/`phys16`/`phys33` réglés sur
  `initial: allumé` via le vrai formulaire de l'UI (pas en éditant le YAML à la main), puis
  "Déployer" cliqué pour régénérer `mqtt-io`. **Le conteneur `mqtt-io-rpigpio` a été recréé en
  vrai** pendant ce test (pas juste redémarré) : état électrique final vérifié identique à l'état
  réel voulu sur les 12 pins (`raspi-gpio`) — les deux mécanismes (`initial` pour les 3 pins
  configurés + `retain` en filet de sécurité pour tous) fonctionnent ensemble, testés bout en bout
  sur le vrai matériel, pas juste en théorie.
- Croisement complet vérifié par ailleurs (script Python, 12/12 pins) : `quoi`/`lieu`/`inverted`
  identiques entre `equipements.json` et le yaml généré, correspondance phys→BCM correcte — aucune
  autre divergence trouvée.

### 🟡 RFXCOM : cover piloté en Lighting2/AC — `coverType` sans valeur adaptée, à vérifier de près avant les volets de noisy
- **Contexte (11/09/2026)**, en préparant la config RFXCOM du site distant "noisy" (5 volets réels
  pilotés en Lighting2/AC, voir `MIGRATION_noisy_2026-09-10.md` §5bis) : le driver `ReceiverCover.ts`
  gère bien ce cas — `ReceiverManager.ts:51` résout le protocole du `primaryEmitter`, et si c'est
  `lighting2`, `open`→envoie `on`, `close`→envoie `off`, `stop`→fige juste la position calculée
  (Lighting2 n'a pas de STOP natif), position suivie par le temps écoulé (`openTimeSec`/
  `closeTimeSec`). Donc **pas bloquant**, mais deux points à examiner de près avant de compter
  dessus pour de vrais volets :
  1. **`coverType`** (`z.enum(['Curtain1','Curtain2','Curtain3','Blind1','Blind2','Blind3','RFY','RFYEXT','ASA'])`,
     `devices-config-schema.ts`) n'a **aucune valeur** représentant "piloté en AC" — utilisé
     uniquement dans le libellé de découverte HA (`model: ReceiverCover (${coverType})`,
     `ReceiverCover.ts:142`, cosmétique, n'affecte pas la trame RF émise) mais un libellé trompeur
     (`Blind1` mis en pratique alors que ce n'est pas un vrai Blinds1) reste un vrai défaut de
     clarté. Ajouter une valeur `AC`/`Lighting2` à l'enum (ou rendre `coverType` optionnel quand le
     primaryEmitter est lighting2).
  2. **Limitation déjà documentée dans le code** (`ReceiverCover.ts`, tête de fichier) : `set_position`
     démarre un mouvement calculé vers la position cible mais **n'envoie pas de commande STOP
     automatique** à l'atteinte de cette position — jamais vérifié en conditions réelles avec un
     vrai volet Lighting2/AC (aucun test connu sur stfort/ailleurs). À tester en réel avant de
     s'appuyer dessus pour les 5 volets de noisy.
- **Priorité** : Moyenne (rien de cassé, mais à vérifier avant mise en prod des volets de noisy —
  premier vrai test réel de ce chemin de code).

### 🟡 Nouvelle application "provisioning" (support bootable) — Conception, rien implémenté
- **Contexte (08/09/2026)** : en marge de la validation du correctif UART teleinfo (entrée
  ci-dessous), besoin exprimé de généraliser `scripts/flash-sd-card.js`+`prepare-sd-card.sh`
  (actuellement hors-git, root, câblés en dur pour `teleinfo` uniquement — voir
  [[project_sd_card_provisioning_pipeline]]) en une vraie application du projet. Détail complet de
  la conception dans [[project_provisioning_app_conception]].
- **Résumé** : support bootable (SD/clé/disque USB), distribution Raspbian selon le type de
  machine, toutes options en oui/non (WiFi, fuseau horaire par défaut Paris, clavier par défaut
  français, Node.js avec package.json gabarit ou téléversé, Python3, Docker CE réel + liste d'apps
  Docker à installer). Changement d'architecture confirmé : l'appli web génère un **script à
  télécharger**, exécuté par l'utilisateur lui-même en `sudo` (jamais par l'appli/Claude
  directement — bloqué par une demande de mot de passe en tentant de lancer le pipeline actuel,
  mot de passe jamais saisi à sa place).
- **Points ouverts** : second paquet Node "oublié" par l'utilisateur (deviné `mqtt`, pas confirmé),
  lib de gestion de queue Node (question posée, sans réponse), liste précise des applications
  Docker installables, authentification SSH mot de passe vs clé.
- **⭐ 16/09/2026, lien établi avec la sauvegarde/restauration** (`fonctionnelles-sauvegarde_specs_v1.0.md`
  §6bis) : l'installation de dimotic-ha doit explicitement faire partie des questions oui/non de ce
  pipeline — une fois installé, dimotic-ha sert lui-même de mécanisme de reprise après sinistre
  (restauration croisée depuis Nextcloud vers cette machine fraîchement provisionnée).
- **Statut** : Conception en cours de discussion, rien codé
- **Priorité** : Moyenne (pas bloquant, mais des points restent à clarifier avant de pouvoir coder)

### 🟡 Guide de création d'une nouvelle application obsolète — Marqué comme tel, contenu pas encore mis à jour
- **Contexte (08/09/2026)** : `guide-nouvelle-application_specs_v1.10.md` date du 04/08/2026 et ne
  couvre aucun des changements d'architecture devenus standard depuis (migration process séparé
  mi-août→24/08). Un avertissement a été ajouté en tête du document (voir CHANGELOG v1.10), mais le
  **contenu lui-même n'a pas été réécrit** — le suivre tel quel produirait toujours une application
  construite à l'ancienne.
- **À couvrir à la reprise** (liste identifiée en marquant le document obsolète, non exhaustive) :
  - Process séparé (`runsAsSeparateProcess`, `ProcessSupervisor`) — standard pour toutes les apps.
  - `HaBridgeClient` — remplace l'accès direct à `HaStructureRegistry`/`HaWsClient`.
  - `bridgedEvents` / `computeBridgeInstance()` / `DIMOTIC_MACHINE_ID` — pont d'événements et
    identifiants uniques par machine.
  - `core.disabledApps` comme seul vrai interrupteur d'activation (le champ `enabled` de chaque
    schéma n'est lu nulle part).
  - Cibles multi-machines (`targets[]`/`haStackTargets`, `TargetCards.js`, socle SSH/SCP partagé).
  - Registre gossip (`TargetGossipService`/`AppGossipService`) pour la visibilité inter-machines.
- **Statut** : Avertissement en place, contenu non mis à jour — différé, demande explicite de
  l'utilisateur pour plus tard.
- **Priorité** : Moyenne (bloquant seulement si une nouvelle application est créée avant la mise à
  jour — pas de nouvelle application prévue dans l'immédiat)

### 🟢 Teleinfo : conflit UART (login série) corrompait les trames — Corrigé, validé par un flash complet de bout en bout
- **Contexte (06/09/2026)** : après le redéploiement des noms SPA/Pompe à chaleur sur la carte SD
  reflashée via le nouveau pipeline (voir [[project_sd_card_provisioning_pipeline]]), plus aucune
  trame téléinfo remontée pendant 15+ minutes (0 à quelques octets reçus par cycle de 25s au lieu
  d'une trame complète), alors que le même matériel avait fonctionné juste avant.
- **Root-causé via une trace fine** ajoutée à la demande de l'utilisateur (`debug: true` dans
  `config.yaml` du device-agent, propagé à `teleinfo-reader.js`/`teleinfo-service.js`) :
  `serial-getty@ttyAMA0.service` (login série activé par défaut sur une image Raspberry Pi OS non
  personnalisée) et le process teleinfo se disputaient `/dev/ttyAMA0` (confirmé par `fuser -v`, 2 PID
  dessus), avec en plus `console=serial0,115200` dans `cmdline.txt`.
- **Corrigé en direct sur le RPi1** (`systemctl mask serial-getty@ttyAMA0` + retrait de
  `console=serial0,115200` du cmdline + reboot) — confirmé par la trace fine : trames complètes
  reçues pour les 2 ADCO à chaque cycle après coup. `debug: true` retiré ensuite (verbosité non
  destinée à la production).
- **Fix reporté dans les scripts de provisionnement** (`app_needs_serial_console_disabled` dans
  `prepare-sd-card.sh`, `APPS_NEEDING_SERIAL_CONSOLE_DISABLED` dans `flash-sd-card.js`) pour qu'une
  future carte flashée pour `teleinfo` n'ait plus jamais ce problème.
- **Validé le 08/09/2026** : flash complet de bout en bout avec le pipeline corrigé (carte de
  secours, `flash-sd-card.js`/`prepare-sd-card.sh`), carte inspectée avant insertion (montage
  `udisksctl`, sans sudo) puis RPi1 testé en direct après boot par SSH (clé dimotic-ha) — les deux
  volets du correctif tiennent dès le premier boot, sans aucune intervention manuelle :
  `systemctl is-enabled serial-getty@ttyAMA0.service` → `masked` (pas juste arrêté), `/proc/cmdline`
  réel (pas juste le fichier) sans `console=serial0,115200`, `/dev/ttyAMA0` libre (`fuser` vide).
  Device-agent teleinfo + `node_modules` déjà présents (pré-installés en chroot).
- **Statut** : Corrigé et validé de bout en bout (carte en place + pipeline de flashage)
- **Priorité** : —

### 🟢 Teleinfo : déploiement sur cible sans Node.js/npm — installation auto ajoutée, mais `apt-get install npm` entraînait ~400 paquets sans rapport — Corrigé
- **Contexte (05/09/2026)** : après reflash de la carte SD du RPi1, `node`/`npm` absents (voir aussi
  [[project_teleinfo_app]]). `DeployService.ensureNode()` ajouté pour détecter et installer
  automatiquement, avec progression visible en direct (`teleinfo:remote-op:progress`, même
  mécanisme `runSshStreaming` que les déploiements Docker core/rpigpio/arexx).
- **Bug réel découvert en conditions réelles** : `apt-get install -y nodejs npm` — le paquet Debian
  `npm` entraîne **plus de 400 paquets** en dépendances "automatic" sans rapport avec le besoin
  (eslint, webpack, git, jest, et une pile graphique X11/Mesa complète — sur un Pi headless qui ne
  fait que lire des trames série EDF). Plus de 15 minutes et toujours pas terminé lors du test ; un
  ancien essai tué par le timeout d'inactivité (90s, alors trop court pour ce CPU ARMv6 très faible)
  a aussi laissé un `apt-get`/`dpkg` **orphelin** tourner en arrière-plan sur la cible, bloquant la
  tentative suivante (verrou dpkg) — non nettoyé automatiquement (limite connue de `runSshStreaming` :
  tuer le process SSH local ne tue pas la commande distante, qui n'a pas de TTY à qui envoyer un
  signal de raccrochage).
- **Corrigé** : `node` seul reste installé via apt (léger, rapide, paquet Raspbian ARMv6 dédié).
  `npm` n'est plus jamais installé via apt — remplacé par un tarball autonome téléchargé directement
  depuis le registre npm officiel (`registry.npmjs.org/npm/-/npm-10.8.2.tgz`, version figée, pur JS
  donc aucune compilation native ni dépendance système) et exécuté par le node déjà installé.
- **Limite connue, non corrigée** : un déploiement interrompu en plein milieu d'un `apt-get`/`npm
  install` peut laisser un process orphelin sur la cible qui doit se terminer de lui-même (ou être
  tué manuellement) avant de pouvoir réessayer — pas de mécanisme de nettoyage automatique.
- **Priorité** : Résolu pour le cas npm/apt ; la limite d'orphelin sur timeout reste un angle mort
  généralisé (`runSshStreaming`, socle partagé core/rpigpio/arexx), pas propre à teleinfo.

### 🟢 Activation à chaud d'une app en process séparé : le formulaire "Paramètres Techniques" restait vide tant que core n'avait pas redémarré — Corrigé
- **Constaté (05/09/2026)**, en reprenant `teleinfo` en local après un reflash de sa cible RPi1 :
  activer une app depuis *Gestion des applications* faisait bien apparaître son entrée dans le menu
  latéral immédiatement (pas de redémarrage), mais cliquer dessus affichait "Pas de configuration UI
  disponible pour teleinfo" — malgré le message d'accueil de la page annonçant explicitement
  "Chaque application démarre/s'arrête indépendamment, sans redémarrage de l'application
  principale". Un redémarrage complet de `core` faisait disparaître le problème — ce qui masquait la
  vraie cause plutôt que la révéler.
- **Reproduit en direct** (navigateur piloté, logs serveur en parallèle) pour confirmer avant de
  corriger à l'aveugle (voir [[feedback_live_testing_workflow]]) : le serveur envoie bien
  `app:modules:list` (menu à jour, Sidebar.ts s'en sert directement) ET démarre bien le process
  séparé de l'app — mais `ConfigForm.ts` ne lit PAS ses métadonnées de formulaire depuis cette liste.
  Il les lit d'un cache client **séparé** (`ModuleManager.moduleUiMetadata`), rempli uniquement par
  l'événement `app:module:ui:register` — que seul le scan de démarrage complet
  (`AppService.emitModuleUiMetadata()`) émettait. Le chemin d'activation à chaud
  (`AppService.tryActivateSeparateProcessApp`, ajouté le 25/08/2026 justement pour éviter le
  redémarrage) ne l'émettait jamais pour la nouvelle app — deux caches client alimentés par deux
  chemins serveur différents, l'un mis à jour, l'autre oublié.
- **Correctif** (`AppService.tryActivateSeparateProcessApp`) : émettre aussi `app:module:ui:register`
  pour le module fraîchement activé (s'il a un `configUi`), juste après `app:modules:registered` —
  un seul module concerné, pas besoin de rejouer `emitModuleUiMetadata()` en entier.
- **Vérifié en conditions réelles** : cycle désactiver → réactiver → clic direct sur l'app dans le
  menu (sans rafraîchir la page) → formulaire complet affiché immédiatement, testé deux fois de
  suite avec `teleinfo`.
- **Effet de bord découvert au passage, non lié** : le menu latéral n'insère pas la nouvelle entrée à
  sa place triée (`menuOrder`) quand elle arrive après coup — elle est ajoutée en fin de liste
  (visible : "Téléinfo" après "Scripts HA" au lieu d'avant "ESPDISPLAY"). Purement cosmétique, pas
  creusé plus loin.
- **Priorité** : Résolu.

### 🟢 Instructions `ssh-copy-id` (déploiement d'une cible) : hôte générique `<hôte-de-la-cible>` à remplacer à la main — Corrigé
- **Retour utilisateur (05/09/2026)**, en configurant `teleinfo` pour la première fois sans être
  informaticien : les instructions de préparation SSH (`renderSshPrepSection`, `TargetCards.ts`,
  mutualisé rpigpio/teleinfo/arexx/core) affichaient toujours un placeholder générique
  `root@<hôte-de-la-cible>`, même une fois une cible réellement configurée avec un hôte connu —
  demande explicite : *"une fois paramétré le ssh-copy dans cible doit se compléter avec l'hôte
  cible"*.
- **Corrigé** : `renderSshPrepSection` accepte désormais un paramètre `targets` optionnel — dès
  qu'au moins une cible a un hôte renseigné, un bloc de commande complet (hôte réel déjà substitué)
  est affiché par hôte connu ; le placeholder générique ne reste qu'en repli si aucune cible n'a
  encore d'hôte. Câblé dans les 4 appelants (`rpigpio`, `teleinfo`, `arexx`, `core/DeploymentManager`
  — ce dernier combine ses 3 listes de cibles core/HA-stack/zigbee2mqtt et se re-rend à chaque mise à
  jour de l'une des trois, pas seulement au premier chargement).
- **Priorité** : Résolu.

- **Demande utilisateur (31/08/2026)** : permettre d'ajouter une nouvelle application, ou de
  remplacer le code d'une application déjà intégrée, directement dans `applications/` — sans passer
  par une opération manuelle (git/copie de fichiers). Aujourd'hui, seules l'activation/désactivation
  (liste `disabledApps` dans `data/core/config.yaml`) et la configuration d'une app déjà présente
  passent par l'UI (*Paramètres Techniques > Gestion des applications*, voir CLAUDE.md règle 7) —
  l'ajout ou le remplacement du CODE lui-même n'a aucun mécanisme dédié.

- **⭐ Conception retenue (01/09/2026) — mécanisme « racine externe » qui masque la racine interne** :

  Deux racines d'applications :
  - **interne** : `applications/` (livrée avec le dépôt / l'image Docker)
  - **externe** : `data/applications/` (hors dépôt, gitignored) — pour les apps ajoutées à
    l'exécution

  Nouvelle logique de balayage (au démarrage de core, et rejouée à chaud lors d'un ajout externe —
  voir « Ajout à chaud » ci-dessous) :
  ```
  balayage interne — pour chaque app de applications/ :
      nom ∈ disabledApps               → ignorer
      sinon <externe>/<nom> existe      → ignorer (l'externe la remplace)
      sinon                            → charger / exécuter

  puis balayage externe — pour chaque app de <externe>/ :
      nom ∈ disabledApps               → ignorer
      sinon                            → charger / exécuter
  ```

  Conséquences :
  - `<externe>/<nom>` inédit = **ajout** d'une nouvelle app
  - `<externe>/<nom>` == une app interne = **remplacement** ; l'app interne est seulement *masquée*,
    jamais touchée sur disque (pas de sauvegarde/swap/écrasement à gérer — c'était toute la
    complexité de la première ébauche de conception, éliminée par ce modèle)
  - retirer un remplacement = supprimer le dossier dans la racine externe → l'app interne reprend
    au balayage suivant
  - `disabledApps` reste une **liste de noms** dans `data/core/config.yaml` → s'applique aux deux
    racines sans aucune modification de son mécanisme ; une app (interne masquée ou externe) dont
    le nom est dans `disabledApps` **n'est pas lancée**, point — c'est la réponse au cas « app
    externe de même nom qu'une interne, mais elle-même désactivée »

- **Ajout à chaud (core déjà démarré)** : un dossier d'application peut être déposé dans la racine
  externe **pendant que le socle tourne déjà** — l'app n'a pas à être présente au démarrage. Il
  faut donc un déclencheur de re-balayage à l'exécution (action UI « prendre en compte les
  nouvelles applications », ou surveillance `fs.watch` de la racine externe) qui rejoue la même
  logique de chargement que l'activation actuelle : app `runsAsSeparateProcess` → spawn direct via
  `ProcessSupervisor` sans redémarrer core (`activateSeparateProcessHook` déjà en place) ; app
  in-process → `RestartManager.scheduleRestart(15s)`. Le retrait/remplacement à chaud suit la même
  voie (stop du process séparé, ou redémarrage planifié).

- **Code impacté** (aucune nouvelle infra, juste une 2ᵉ racine + la règle de masquage) :
  - `AppService` — **tous** les résolveurs de chemin de module, pas seulement
    `detectApplicationModules()` : aussi le hook d'activation en process séparé
    (`setActivateSeparateProcessHook`, qui reconstruit `appDir`), le résolveur de rechargement
    (`applications/{moduleId}/dist|src/domain/index`, ~ligne 1429) et le mapping des assets.
    Extraire une seule fonction « résous `appId` → dossier (externe prioritaire, sinon interne) »
    et l'appeler partout, sinon les deux copies divergeront.
  - `ApplicationManager` (`getApplicationsInDir` / `listAll` / `enable` / `disable` / `exists`) —
    connaître les deux racines ; `listAll` renvoie l'origine de chaque app
    (interne / externe / interne-remplacée) pour l'affichage UI. **L'activation/désactivation
    (écran *Gestion des applications*) fonctionne à l'identique pour les apps externes** : même
    liste `disabledApps` (par nom), mêmes boutons, même redémarrage planifié / spawn ciblé. Le
    contrôle d'existence de `enable()`/`disable()` (`existsSync(appsDir/appId)`) doit accepter
    l'une **ou** l'autre racine.
  - route statique `/applications/:appId/*` dans `presentation/server/index.ts` — résoudre aussi
    dans la racine externe, sinon les assets UI (`presentation/**`) d'une app externe partent en 404
  - `ProcessSupervisor` — **rien** : il reçoit déjà `appDir` en paramètre de `register()`, une app
    externe `runsAsSeparateProcess` se spawn exactement pareil

- **Décisions tranchées (01/09/2026)** :
  1. **Emplacement de la racine externe** : `data/applications/` — hors dépôt, gitignored. Bonus :
     `data/` est un volume hôte monté en Docker (voir `Dockerfile` / `compose.yaml`), donc les apps
     externes **survivent à un `docker compose pull && up -d`**, contrairement à tout ce qui est
     dans `applications/` (couches d'image, réécrites à chaque version).
  2. **App dont le nom est dans `disabledApps`** : elle n'est pas lancée, qu'elle soit interne
     masquée ou externe. Une entrée externe désactivée masque quand même l'interne du même nom
     (l'app ne tourne pas du tout).

- **Point de cohérence à vérifier — code externe vs données/config** : le code d'une app externe
  vit dans `data/applications/<appId>/`, mais sa config/données restent dans `data/<appId>/`
  (convention CLAUDE.md « un sous-répertoire `data/` par application »). Deux sous-répertoires
  distincts pour une même app externe — léger accroc à l'objectif de portabilité « copier UN seul
  sous-répertoire » ; à trancher : accepte-t-on les deux, ou l'app externe range-t-elle son code
  ET ses données sous `data/applications/<appId>/` ? Réserver aussi le nom `applications` comme
  `appId` interdit (collision avec `data/applications/`).

- **Hors périmètre de cette entrée (sujet distinct, à traiter ensuite)** : la façon dont un dossier
  d'application *arrive* dans la racine externe — upload d'une archive `.zip` via l'UI + validation
  (structure, `dist/` présent puisque l'image de prod n'a plus de chaîne de build — cf. `Dockerfile`
  / `build-apps.sh` : `npm prune --omit=dev` + suppression des `*.ts`), ou simple copie manuelle du
  sous-répertoire. Le mécanisme de balayage ci-dessus est indépendant de ce choix.

- **Statut** : Conception validée par l'utilisateur (01/09/2026), aucun code écrit
- **Priorité** : Moyenne

### 🟢 EVOO7 : écriture (`update`) systématiquement silencieuse — mot de passe haché en double — Corrigé
- **Contexte (30-31/08/2026)** : demande utilisateur d'automatiser le recalage du décalage de température ambiante d'EVOO7 (voir entrée `scriptsha` associée) a révélé, en testant en conditions réelles, que TOUTE commande `update` timeoutait après 10s sans `updateok` ni `updateko`, quel que soit le champ visé (`decalage_tdeg_ambiante`, `consigne_normal`, ...) — alors que les lectures (`datas`) arrivaient normalement et que l'interface web propre du boîtier fonctionnait très bien (signalé par l'utilisateur, qui a poussé à chercher la vraie cause côté code plutôt que d'accepter une explication "boîtier indisponible").
- **Fausse piste éliminée en premier** : un bug réel et distinct existait bel et bien (`socket.once('connect', ...)` ne se réexécutant qu'à la toute première connexion du process, laissant `this.connected` bloqué à `false` après toute coupure — corrigé, déployé en 2.4.2) mais ne suffisait pas à expliquer le symptôme : les écritures timeoutaient encore après ce correctif.
- **Root cause trouvée par sonde directe non destructive** (identification seule, aucune écriture, exécutée depuis le conteneur `ha2` avec le `socket.io-client` déjà installé de l'app) : `MD5(mot de passe stocké en config)` → `unauthorized` ; le mot de passe stocké **envoyé brut, sans hachage** → `authorized` (profils `telemetrie, telemetrieedf, regul, status`). Le mot de passe en config avait été repris du traducteur legacy `zdidEVOO7mqtt` (`appmean.js`), qui le stocke déjà haché en MD5 et l'envoie tel quel — `Evoo7SocketIoClient.connect()` le hachait donc une seconde fois à chaque identification, envoyant un mauvais identifiant. Le boîtier acceptait quand même la connexion Socket.IO et diffusait les lectures (pas d'auth requise pour `datas`), mais refusait l'identification en silence — d'où des écritures qui timeoutaient sans jamais d'erreur d'auth visible.
- **Corrigé** (`Evoo7SocketIoClient.ts`) : envoie désormais le mot de passe stocké **brut** en premier lors de l'identification, et ne retente avec son MD5 que si le boîtier répond `unauthorized` — couvre aussi bien un mot de passe déjà haché (cas vérifié en réel) qu'un futur mot de passe en clair saisi dans l'UI de config, sans avoir à savoir à l'avance lequel est stocké.
- **Déployé en 2.4.3, vérifié en conditions réelles (31/08/2026)** : plus aucun `unauthorized` au démarrage, écriture `décalage=5` confirmée sans timeout (état persistant relu via l'API HA). **Sens du décalage validé empiriquement** dans la foulée (historique HA, avant/après) : décalage `-0.5 → 5` (Δ +5,5) a fait passer `sensor.evoo7_control_temperature_ambiante` de `24.8 → 30.3` (Δ +5,5, correspondance 1:1) — le décalage s'AJOUTE bien à la lecture brute, `sens: 1` déjà retenu dans le script scriptsha est correct, aucune inversion nécessaire. Décalage remis à une valeur cohérente (`-2`, proche de l'idéal `-1.5` calculé sur les lectures du moment) après le test.
- **Statut** : Corrigé et vérifié en conditions réelles
- **Priorité** : Résolu

### 🟢 Scripts HA : automation EVOO7 décalage rejetée par HA au premier vrai déploiement (schéma `numeric_state`) — Corrigé
- **Contexte (31/08/2026)** : premier déploiement réel (bouton "Diffuser" du tableau de bord Scripts HA) de l'automation écrite le 30/08 pour recaler le décalage EVOO7 (voir entrée EVOO7 ci-dessus) → `HTTP 400` sans détail exploitable dans les logs (`HaWsClient.setDomainConfig()` jetait le corps de la réponse HTTP, ne remontant que le code — contrairement à `deleteDomainConfig()`, déjà corrigé pour la même raison le 25/08/2026).
- **Root cause trouvée** en rejouant la requête exacte (même id, même payload JSON) via `curl` directement contre l'API HA pour lire le vrai message : `"Message malformed: must contain at least one of below, above. @ data['conditions'][0]"` — les 3 conditions `numeric_state` du script n'avaient ni `above` ni `below` (l'intention était "cette entité a un état numérique exploitable", pas un seuil — schéma HA rejette `numeric_state` sans borne).
- **Corrigé** : les 3 `numeric_state` remplacées par une unique condition `template` qui écarte `unknown`/`unavailable`/`none` sur les 3 entités. `HaWsClient.setDomainConfig()` corrigé au passage pour inclure le corps de la réponse HTTP dans l'erreur (aligné sur `deleteDomainConfig()`), pour que le prochain échec de ce type soit lisible sans reconstruire la requête à la main.
- **Déployé en 2.4.4** — reste à confirmer via le bouton "Diffuser" que l'automation passe désormais, puis vérifier son premier cycle réel (déclenchement toutes les 30 min).
- **Statut** : Corrigé, déploiement en cours de vérification
- **Priorité** : Résolu (sous réserve de la vérification post-déploiement)

### 🟢 EVOO7 : connexion Socket.IO directe au boîtier — remplace le broker MQTT dédié + traducteur externe
- **Contexte (16/08/2026)** : l'utilisateur a fourni un ancien projet (`/home/didier/ownCloud/vinceworkspace/zdidEVOO7mqtt`, ~2019) qui traduit Socket.IO↔MQTT pour EVOO7 — analyse a révélé que MQTT n'est **pas** le protocole natif du boîtier : c'est une couche ajoutée par ce traducteur. Le vrai boîtier expose un serveur Socket.IO directement.
- **Vérifié en conditions réelles avant tout code** : boîtier localisé (192.168.1.55:80, deviné par élimination sur le sous-réseau, confirmé), connexion Socket.IO réussie avec `socket.io-client` v2 — **la v4 ne fonctionne pas** (erreur de poignée de main Engine.IO, firmware trop ancien pour EIO4 par défaut). Identification testée avec un mot de passe temporaire fourni par l'utilisateur, chiffré en **MD5** avant envoi (déduit du traducteur, `appmean.js` : `md5(motdepasse)`) — `authorized` avec profils `[telemetrie, telemetrieedf, regul, status]` (regul confirme les droits d'écriture).
- **Construit** : `Evoo7SocketIoClient` (nouvelle classe, `socket.io-client@2.5.0`, remplace `Evoo7MqttClient`/`mqtt` — dépendance retirée du `package.json`) — `connect/disconnect/isConnected/onData/onConnectionChange/sendUpdate`. `sendUpdate` en file d'attente stricte (une commande en vol à la fois, timeout 10s) : le boîtier ne fournit aucun moyen fiable de corréler une réponse (`updateok`/`updateko`) à une commande précise s'il y en avait plusieurs en parallèle.
- **`Evoo7Service.ts` réécrit** : la clé `id` de chaque donnée (déjà utilisée, ex: `temp_depart_pc`) s'est révélée être EXACTEMENT le nom natif Socket.IO du boîtier — aucune migration de données nécessaire. Simplification structurelle : la réception `datas` (Socket.IO) envoie TOUTES les clés d'un coup, contrairement à MQTT où seuls les topics souscrits arrivaient — tout le mécanisme d'abonnement/désabonnement par topic (`topicToId`, `subscribeTopic`/`unsubscribeTopic`, ~30 lignes à 4 endroits) a pu être supprimé ; le filtre `consultation` (déjà existant) se vérifie maintenant à la réception plutôt qu'à la souscription.
- **Config** : nouvelle section `evoo7.box` (adresse/port/user/password) remplace `evoo7.mqtt`/`topicCommand`/`formatMessageCommand` (retirés du schéma et du formulaire — n'auraient plus eu aucun effet, laissés visibles aurait été trompeur). Les champs `topicSensor`/`formatMessageSensor` **par donnée** (43 données, `donnees-config-schema.ts`) n'ont volontairement pas été touchés — cleanup plus large, plus risqué (persisté pour 43 enregistrements + UI dédiée), différé.
- **Sauvegarde faite avant modification** : `backups/evoo7_2026-08-16/` (src + data complets), conformément à la règle du projet (risque de corruption identifié — connexion à du vrai matériel de chauffage).
- **Vérifié en conditions réelles avec l'app complète** (mot de passe vide, lecture seule) : connexion directe réussie (`Evoo7SocketIoClient: Connecté au boîtier EVOO7`), tableau de bord affichant "Boîtier EVOO7: Connecté"/"Bridge HA: Connecté"/"Dernier message reçu" à jour, aucune erreur console ni serveur. `evoo7` redésactivée ensuite (état initial restauré).
- **Écriture testée en conditions réelles (2026-08-16, avec confirmation explicite préalable)** : `consigne_normal` (température thermostat) changée 18→15 via `Evoo7SocketIoClient.sendUpdate()` (le vrai code intégré à l'application, pas un script isolé), confirmée par le boîtier (`updateok`), relue via l'API (15 confirmé), **et vérifiée indépendamment sur l'écran du boîtier lui-même par l'utilisateur** — donc pas seulement une confirmation logicielle. Remise à 18 (valeur d'origine) ensuite, confirmée de la même manière.
- **Point vérifié en passant, sans rapport avec un bug** : la crainte initiale que `état_fonctionnement`/`état_eco` renvoient des libellés texte ("Chauffage"/"Arrêt") plutôt que les codes numériques attendus (`config-evoo7-donnees-v1.0.yaml`, `valeursPossibles`) s'est révélée non fondée — vérifié en direct, le boîtier renvoie bien des nombres (`état_fonctionnement: 1`, etc.), cohérent avec ce qui était déjà configuré.
- **Statut** : Implémenté et vérifié en lecture ET en écriture, en conditions réelles (2026-08-16)
- **Priorité** : Résolu

### 🟢 Présence/liveness `rpigpio`/`teleinfo` : LWT + battement de cœur — Implémenté et vérifié (teleinfo en conditions réelles)
- **(16/08/2026)**, suite à la décision de conception sur la présence des agents distants — implémenté pour les deux agents MQTT (rpigpio/mqtt-io et teleinfo/RPi1), pas pour BS500 Arexx (pas de MQTT, voir entrée séparée plus bas).
- **`rpigpio`** : `RpigpioService` ouvre désormais sa première connexion MQTT — en LECTURE SEULE, uniquement pour s'abonner au LWT natif de mqtt-io (`<topic_prefix>/<bridgeInstance>/status`, payload `"running"`/`"dead"`, déjà publié par mqtt-io lui-même, rien à ajouter côté agent). Toujours aucune écriture MQTT ni logique métier via ce canal (invariant conservé, juste plus "l'app ne parle jamais MQTT" — le commentaire en tête de fichier a été mis à jour).
- **`teleinfo`** : l'agent RPi1 (`device-agent/ha-publisher.js`, JS brut, pas de build — ARMv6/Node12) n'avait aucun mécanisme de présence — ajouté : LWT (`will` à la connexion, topic `teleinfo/agent/status`) + battement de cœur toutes les 30s, payload JSON `{status, timestamp}` (un timestamp permet un vrai "dernier contact" côté tableau de bord, contrairement à un LWT texte seul). `TeleinfoService` (core) s'abonne en lecture seule, même patron que rpigpio.
- **Tableaux de bord** : nouveaux champs "Agent mqtt-io"/"Agent RPi1" (En ligne/Hors ligne/Inconnu) + "Dernier contact" sur les deux apps.
- **`teleinfo` redéployé et vérifié en conditions réelles (16/08/2026, accord explicite utilisateur — RFXCOM déjà branché sur cette machine, seul le RPi1 restait à toucher)** : déploiement déclenché via le bouton "Générer et déployer" du tableau de bord (mécanisme SSH/SCP existant, `DeployService.ts`, copie tous les fichiers `device-agent/` dont le nouveau `ha-publisher.js`) — service systemd redémarré avec succès (`statut: active`), lecture réelle des 2 compteurs confirmée (`journalctl` sur le RPi1). Battement de cœur reçu et exploité de bout en bout : `agentOnline: true`, `agentLastSeenAt` se met à jour toutes les 30s pile (logs socle + tableau de bord vérifiés visuellement, "Agent RPi1: En ligne").
- **`rpigpio`/`ha2` non vérifié en conditions réelles** : le conteneur mqtt-io réel sur `ha2` n'a pas été redéployé avec le nouveau format de topic incluant `bridgeInstance` (contrainte "rien sur ha2/orangepi" toujours en vigueur cette session, utilisateur n'a autorisé que RPi1 cette fois) — affiche "Inconnu", cohérent avec l'absence de redéploiement, à vérifier au prochain redéploiement autorisé de mqtt-io sur `ha2`.
- **Statut** : Implémenté et vérifié (teleinfo) — 2026-08-16
- **Priorité** : Résolu pour teleinfo ; rpigpio en attente d'un redéploiement ha2 autorisé

### 🟢 Superviseur — Pont EventBus↔app migré : MQTT remplacé par IPC — Implémenté
- **Décision utilisateur (16/08/2026)**, suite à une discussion de conception : les apps migrées en process séparé restent sur la même machine que `core`, qui les lance lui-même via `child_process.spawn()` — la relation parent-enfant existe déjà physiquement, donc pas besoin de passer par un broker MQTT pour ce saut local. IPC (`process.send()`/`process.on('message')`, canal `stdio: [...,'ipc']`) remplace le pont MQTT générique construit plus tôt cette session pour ce cas précis.
- **Validé avant de tout reconstruire** : test isolé (parent/enfant minimal, à travers `tsx spawn()` exactement comme en dev) — canal IPC fonctionnel de bout en bout, y compris à travers le PID différent que crée le wrapper `tsx`.
- **Construit** : `IpcEventBus` (nouvelle classe, remplace `MqttEventBus` dans chaque `standalone.ts` — plus besoin de `ha.mqtt` pour ce canal, `deliverLocally()` conservé pour l'auto-écoute comme `MqttEventBus`). `SupervisorEventBridge` réécrit : `attachChild()`/`detachChild()` (appelés par `ProcessSupervisor` à chaque spawn/sortie), réception (app→core) générique par nature avec l'IPC (un `ChildProcess` est un tuyau point à point, tout ce qu'un enfant envoie arrive forcément — plus besoin du wildcard MQTT construit plus tôt), émission (core→app) routée explicitement par `(appId, eventName)` via une map `interestedApps` (reproduit la sémantique de diffusion que MQTT donnait gratuitement par abonnement partagé). `ProcessSupervisor.spawnChild()` : `stdio` étendu avec le canal `'ipc'`.
- **Simplifications obtenues** : plus besoin de bridger explicitement `app:menu:register`/`integration:bridge:register`/`unregister` (automatique, app→core) — seul le sens core→app reste à déclarer (`autoBridgeSocketEvents`, les 4 motifs `integration:{module}:*`, `app:module:config:saved`, `bridgedEvents` pour le cas bespoke). Les 7 `standalone.ts` n'ont plus besoin de lire `ha.mqtt` du tout pour leur propre EventBus (connexions MQTT métier propres à certaines apps — broker dédié evoo7, sources nommage — inchangées, indépendantes de ce canal).
- **`MqttEventBus`/le pont MQTT générique ne sont pas supprimés** (code toujours valide, testé) — juste plus utilisés par aucun `standalone.ts` aujourd'hui.
- **Vérifié en conditions réelles** : les 7 apps séparées redémarrées sous IPC, les 4 bridges `integration:*` connectés (logs `Bridge connecté`/`HA en ligne`), comptes d'événements Socket.io identiques à la version MQTT, round-trip testé sur rfxcom/arexx (dashboards, aucune erreur console), suite de tests de contrat `IEventBus` étendue à `IpcEventBus` (21/21 tests verts), suite complète core sans régression (131 tests).
- **Effet de bord trouvé et corrigé en testant sous trafic réel continu (sans rapport avec l'IPC)** : `nommage` — le client attendait `data.rawMessage` sur `nommage:discovery:parsed`, le serveur envoie `discoveryMessage` — jamais déclenché avant faute de trafic continu pendant les tests précédents (corrigé, `presentation/ts/app.ts`).
- **Statut** : Implémenté (2026-08-16)
- **Priorité** : Résolu

### 🟡 Présence/liveness agent BS500 Arexx (32 bits, futur) — À concevoir
- **Discuté (16/08/2026)**, sans conception ni code. Cas différent de Téléinfo/rpigpio (voir entrée LWT+heartbeat plus haut, celle-ci implémentée) : pas de MQTT du tout pour cet agent — ce serait un utilitaire paramétré par un fichier de config qui envoie ses relevés directement à l'application AREXX (mode "push HTTP" déjà prévu dans `ArexxService`, voir `acquisitionMode: 'push'`). Le mécanisme LWT/heartbeat MQTT ne s'applique donc pas tel quel ici — conception de présence/liveness à faire séparément pour ce cas, le moment venu.
- **Statut** : Non conçu — noté pour plus tard
- **Priorité** : Basse (aucun agent BS500 déployé aujourd'hui)

### 🟢 Socle : `app:menu:register` jamais relayé côté serveur — mécanisme mort depuis l'origine, pour toutes les apps — Corrigé
- **Découvert (16/08/2026)** en implémentant la Phase 1 du superviseur (pontage des événements d'`espdisplay` vers MQTT) : `SocketBridge.ts` ne déclarait `app:menu:register` dans **aucun** `*_SOCKET_EVENTS`, pour **aucune** application. Or `Sidebar.ts` (`socketService.on('app:menu:register', ...)`, `registerCustomMenu()`/`getAppMenuConfig()`) attend cet événement côté client pour permettre à une app de mettre à jour son menu dynamiquement après démarrage (badge, sous-page conditionnelle...), sans redémarrage de `core` — distinct du mécanisme qui fonctionne déjà (`app:modules:list`, scan statique figé avant démarrage du service). Sans relais serveur→Socket.io déclaré, cet événement ne pouvait **jamais** atteindre le navigateur.
- **Correctif (16/08/2026)** : ajouté `'app:menu:register': (data: {appId: string; menuConfig: unknown}) => void` à `ServerToClientEvents` (`types/events.ts`) et câblé le relais dans `SocketBridge.ts` — même patron que `app:module:ui:register` déjà existant (`onGeneric` + `broadcast` + cache `customMenus` par appId + rejeu aux nouvelles connexions). Choix : câbler plutôt que supprimer (garde la capacité pour un usage futur réel, même si aucune app n'exploite encore la mise à jour dynamique aujourd'hui — chacune renvoie sa config déjà connue via l'autre mécanisme).
- **Vérifié en direct** : le client reçoit désormais l'événement pour chaque app qui l'émet (`ia`, `planificateur`, `espdisplay`, `rpigpio`, `teleinfo`, `rfxcom`), aucune régression visuelle du menu.
- **Statut** : Corrigé (2026-08-16)
- **Priorité** : Résolu

### 🟢 Superviseur — Pont générique EventBus↔MQTT (fonctionnelles-supervisor_specs v2.5 §7.1) — Implémenté
- **Contexte (16/08/2026)** : après la migration de 6 apps consécutives (rpigpio/teleinfo/arexx/evoo7/nommage/rfxcom), énumérer `bridgedEvents` à la main pour chaque app s'est révélé fragile — un événement UI ajouté sans être répercuté dans `bridgedEvents` reste silencieusement mort (aucune erreur, juste rien ne se passe côté navigateur), déjà rencontré plusieurs fois pendant la session. Décision utilisateur explicite : passer à un relais générique.
- **Réception (MQTT → local) : rendue générique.** `MqttEventBus.onAnyGeneric()` (nouveau) pose UN SEUL abonnement MQTT wildcard (`dimotic/supervisor/+/app/+/event/#`) — `handleMessage()` (déjà capable de parser n'importe quel topic générique) invoque désormais aussi les listeners wildcard, en plus de la livraison ciblée existante. `SupervisorEventBridge` pose cet abonnement une seule fois dans son constructeur ; `bridgeEvent()` ne gère donc plus que le sens local → MQTT.
- **Émission (local → MQTT) : reste ciblée par nom** (l'EventBus local est un simple EventEmitter, aucun concept de wildcard côté réception d'un abonnement local) — mais l'essentiel n'exige plus de déclaration manuelle par app, via 3 mécanismes génériques :
  1. `SupervisorEventBridge.autoBridgeSocketEvents()` (nouveau) — dérive directement la liste des événements UI du **payload** d'`app:socket-events:registered` (que chaque app envoie déjà avec sa liste complète, `XXX_ALL_EVENTS` + `persistentEvents`), au lieu de recopier `Object.values(XXX_ALL_EVENTS)` dans `bridgedEvents`.
  2. Les 4 motifs génériques émis par `IntegrationBridge` vers un module (`integration:{module}:command/bridge:connection/ha:online/passthrough:message`) bridgés automatiquement par `AppService` pour toute app `type: 'integration'`, paramétrés par `appModule.id` — plus besoin de les lister un par un par app.
  3. `app:module:config:saved` bridgé automatiquement pour toute app séparée (rechargement à chaud de connexion après sauvegarde config, utilisé par evoo7/nommage, harmless pour les autres).
- **Résultat** : `bridgedEvents` retiré de `rpigpio`/`teleinfo`/`arexx`/`evoo7`/`nommage`/`rfxcom` (plus aucune entrée). `espdisplay` garde une seule entrée (`espdisplay:deploy-floorplan`, HAPLAN→espdisplay) — le seul cas restant vraiment bespoke, non couvert par les 3 mécanismes génériques. Le champ `ApplicationModule.bridgedEvents` reste dans le type comme échappatoire pour un futur cas non générique.
- **Vérifié en conditions réelles** : les 7 apps séparées démarrées simultanément (`arexx`/`evoo7`/`nommage` réactivées temporairement pour le test), tous les bridges `integration:*` connectés (`Bridge connecté`/`HA en ligne` en logs pour les 4 apps concernées), comptes d'événements Socket.io cohérents avec avant, round-trip client→serveur retesté sur arexx/evoo7/nommage/rfxcom (dashboards fonctionnels, aucune erreur console), `rfxcom` toujours aucune commande envoyée au démarrage. `arexx`/`evoo7`/`nommage` redésactivées ensuite (état restauré).
- **Effet de bord observé, sans rapport avec ce correctif** : le broker MQTT dédié d'evoo7 (192.168.1.53, indépendant du socle) s'est mis à se déconnecter/reconnecter en boucle (~10s) après quelques secondes de connexion stable — probablement une collision de `clientId` MQTT statique (`evoo7-app`, non randomisé contrairement à `bridgeInstance`) avec une instance evoo7 encore active ailleurs (ha2 ?). Le côté socle (`Bridge HA: Connecté`) fonctionnait normalement. Non creusé plus loin (hors périmètre du jour, evoo7 redésactivée après le test) — à surveiller si evoo7 est un jour remise en service ici.
- **Statut** : Implémenté (2026-08-16)
- **Priorité** : Résolu — bénéficiera automatiquement à toute future migration d'app (plus de `bridgedEvents` à tenir à jour pour les cas UI/integration standard)

### 🟢 Superviseur — Phase 1 implémentée et vérifiée : espdisplay en process séparé (MQTT)
- **Contexte (16/08/2026)** : première application migrée vers l'architecture cible du superviseur (`fonctionnelles-supervisor_specs_v2.5.md`) — un process OS séparé, communiquant par MQTT (`MqttEventBus`) plutôt que par l'`EventBus` in-process partagé. Migration progressive actée avec l'utilisateur (pas de big-bang sur les 9 apps), `espdisplay` choisie comme première candidate (faible enjeu).
- **Construit** : `core.machineId`, `MqttEventBus` (implémente `IEventBus` à l'identique, livraison locale synchrone + publication MQTT), suite de tests de contrat `IEventBus` (nouvelle, exécutée contre `EventBus` et `MqttEventBus`), module `supervisor/` (`ProcessSupervisor` avec backoff §8.4 codé pour la première fois, `SupervisorEventBridge` avec anti-boucle structurel), `runsAsSeparateProcess`/`bridgedEvents` (nouveaux champs `ApplicationModule`), `espdisplay/src/standalone.ts`, commandes MQTT start/stop/restart (généralisées à toute app séparée, demande utilisateur en cours de route), `machineId` exposé côté client.
- **Deux bugs réels trouvés et corrigés en testant en conditions réelles** :
  1. Process `espdisplay` orphelins à chaque redémarrage de `core` (jusqu'à 5 accumulés constatés) — `child_process.spawn()` ne meurt pas avec son parent. Corrigé : `AppService.stopAllSeparateProcesses()` sur arrêt propre + filet `process.on('exit')` dans `ProcessSupervisor`.
  2. `app:menu:register` jamais relayé côté socle — voir entrée dédiée ci-dessus, préexistant, sans rapport avec cette migration.
- **Vérifié en conditions réelles** (broker MQTT de production, machine `falbala`) : build + tests propres (124/125, 1 échec préexistant sans rapport) ; événement cross-process réel testé (simulation d'un ordre HAPLAN via `mosquitto_pub`, reçu et traité par `EspDisplayService` dans le process séparé, pipeline de déploiement réellement déclenché) ; backoff de crash observé (arrêt externe classé crash, retenté avec succès) ; commandes MQTT `start`/`stop` testées individuellement avec succès ; plus aucun orphelin après plusieurs cycles de redémarrage.
- **Statut** : Corrigé/Implémenté (2026-08-16) — voir `fonctionnelles-supervisor_specs_v2.5.md` §14
- **Priorité** : Résolu (Phase 1) — reste : étendre la migration aux autres apps (hors périmètre de cette phase, décision explicite de progressivité), affichage effectif du `machineId` sur chaque écran d'application (juste exposé pour l'instant)

### 🟢 Superviseur — Phase 2 : `rpigpio` en process séparé (premier test grandeur nature du pontage UI)
- **Contexte (16/08/2026)** : après Phase 1 (`espdisplay`, sans UI Socket.io), migration app par app décidée avec l'utilisateur — `rpigpio` choisie en premier (aucune dépendance `haStructureRegistry`/`haWsClient` ni `integration:*`, accès matériel déjà externalisé par SSH vers la machine cible). `arexx`/`evoo7`/`nommage`/`ia`/`planificateur`/`haplan`/`arbreouquoi` cartographiés pour la suite ; `rfxcom` volontairement en dernier (utilisateur prévenu avant de commencer, récepteur à rebrancher physiquement sur cette machine).
- **Écueil découvert avant `rpigpio` (pas encore rencontré avec `espdisplay`, qui n'a aucune UI)** : `SocketBridge` ne relaie **rien** automatiquement pour une app séparée avec UI — chaque nom d'événement `*_ALL_EVENTS` (client→serveur et serveur→client) doit être explicitement dans `bridgedEvents` pour traverser la frontière process, sans quoi le tableau de bord reste figé. Généralisé à toute app séparée (pas seulement `rpigpio`) : `AppService.detectApplicationModules()` ponte désormais automatiquement `app:socket-events:registered` (comme c'était déjà le cas pour `app:menu:register`), en plus de la liste `bridgedEvents` propre à chaque app.
- **Vérifié en conditions réelles** (navigateur, broker MQTT local `falbala` + pont vers `ha2`) : chargement du tableau de bord, ajout d'un pin (`SAVE_PIN`, aller-retour complet à travers le process séparé), suppression (`DELETE_PIN`), rejeu des événements persistants (`rpigpio:status`/`rpigpio:pins:list`) sur une nouvelle connexion — tout fonctionne à l'identique d'avant la migration.
- **Statut** : Corrigé/Implémenté (2026-08-16)
- **Priorité** : Résolu — suite : `teleinfo` (même profil que `rpigpio`), puis `arexx`/`evoo7`/`nommage` (même chantier UI + famille d'événements `integration:*` à ponter), `ia`/`planificateur`/`haplan`/`arbreouquoi` nécessitent une conception dédiée (dépendance à `haStructureRegistry`/`haWsClient`, objets vivants construits par `core`, non transportables tels quels par MQTT — `planificateur`/`haplan` exécutent réellement des commandes HA via `haWsClient`, même classe de risque que les incidents RFXCOM de sécurité au démarrage), `rfxcom` en tout dernier.

### 🟢 ArbreOuQuoi : `hideLoading`/`hideDetailsPanel` plantaient si l'utilisateur avait déjà quitté la page — Corrigé
- **Découvert (16/08/2026)**, sans rapport avec la migration superviseur en cours au moment de la découverte : `TypeError: Cannot read properties of null (reading 'style')` dans la console, provoqué par un événement Socket.io (`TREE_STRUCTURE`, rediffusé par le serveur après une mise à jour d'entité HA) reçu par le script `arbreouquoi/app.ts` **après** que l'utilisateur a navigué vers un autre module. `ModuleContainer.ts` ne désabonne jamais les écouteurs Socket.io d'un module quand on quitte sa page (limite déjà connue, voir plus bas "ModuleContainer : loadModuleContent s'exécute plusieurs fois...") — son DOM est remplacé par `innerHTML` en changeant de module, mais le handler reste actif et tente d'utiliser des éléments qui n'existent plus.
- **Correctif** : `$(id)!.style...` (non-null assertion TypeScript, qui s'efface à la compilation et ne protège de rien à l'exécution) remplacé par une vérification explicite dans les 4 endroits concernés (`showLoading`/`hideLoading`/`showEntityDetails`/`hideDetailsPanel`) — la fonction ne fait simplement rien si l'élément n'existe plus. Corrige le symptôme (plantage) sans s'attaquer à la cause structurelle (écouteurs jamais désabonnés), déjà documentée et hors périmètre de cette correction ponctuelle.
- **Portée plus large non corrigée** : le même risque (`$(id)!`) existe probablement dans les autres apps avec UI (non audité systématiquement).
- **Statut** : Corrigé (2026-08-16)
- **Priorité** : Résolu pour le symptôme observé

### 🟢 Superviseur — Phase 2 (suite) : `teleinfo` et `arexx` en process séparé
- **`teleinfo` (16/08/2026)** : même profil que `rpigpio`, migration mécanique identique (`bridgedEvents` = `TELEINFO_ALL_EVENTS`, `standalone.ts` identique). Vérifié en direct (dashboard, statut, liste des 2 compteurs).
- **`arexx` (16/08/2026)** : première app `type: 'integration'` migrée — a nécessité un second correctif générique dans `AppService.detectApplicationModules()`, même principe que pour `app:menu:register`/`app:socket-events:registered` : `integration:bridge:register`/`integration:bridge:unregister` (noms d'événements **partagés**, pas préfixés par moduleId, utilisés par toute app `type: 'integration'` pour s'annoncer auprès d'`IntegrationBridge`, qui reste in-process dans `core`) sont désormais bridgés automatiquement dès que `runsAsSeparateProcess && type === 'integration'`, sans avoir à les lister dans `bridgedEvents` à chaque app. Les événements **propres** au module (`integration:arexx:discovery`/`:state`) restent déclarés dans `bridgedEvents` d'AREXX_APP.
- **Activation/désactivation d'une app séparée déjà enregistrée** : confirmé que `ApplicationManager.enable()`/`disable()` (fix Phase 1) prend un chemin différent selon le cas — **activer** une app jusque-là désactivée redémarre tout `core` (le module doit être re-scanné/re-enregistré depuis zéro, jamais fait tant qu'elle est désactivée) ; **désactiver** une app déjà en cours d'exécution utilise `ProcessSupervisor.stop()` directement, aucun redémarrage de `core` — dissymétrie normale, pas un bug.
- **Vérifié en direct** : `arexx` activée temporairement pour le test (bridge MQTT connecté, `integration:bridge:register` bien reçu par `IntegrationBridge`, dashboard fonctionnel, `arexx:status:get` testé), puis redésactivée pour ne pas changer l'état existant du projet (elle n'était pas activée avant ce chantier).
- **Statut** : Corrigé/Implémenté (2026-08-16)
- **Priorité** : Résolu — suite : `evoo7` (même chantier + `integration:evoo7:command`/`:bridge:connection` bidirectionnels + `app:module:config:saved`), `nommage` (idem + `passthrough:*`/`:ha:online`), puis pause sur `ia`/`planificateur`/`haplan`/`arbreouquoi` (conception à faire), `rfxcom` en tout dernier (utilisateur à prévenir avant).

### 🟢 Superviseur — Phase 2 (suite) : `evoo7` en process séparé
- **(16/08/2026)** : même chantier qu'arexx, `bridgedEvents` = `EVOO7_ALL_EVENTS` + famille `integration:evoo7:*` complète (contrairement à arexx, evoo7 écoute aussi `integration:evoo7:command`/`:bridge:connection` — c'est un actionneur, pas seulement un capteur) + `app:module:config:saved` (rechargement à chaud de la connexion MQTT après sauvegarde config via l'UI, propre à evoo7/nommage, pas générique).
- **Vérifié en direct** : bridge MQTT connecté (`integration:bridge:register` reçu par `IntegrationBridge`), connexion evoo7 à son propre broker MQTT dédié (192.168.1.53, indépendant du broker HA) réussie depuis le process séparé, formulaire de config chargé avec les vraies valeurs venant du process séparé (`app:modules:config:get`/`app:module:config`), aucune erreur console. Activée temporairement pour le test puis redésactivée (état initial restauré, comme pour arexx).
- **Anomalie navigateur sans rapport, résolue en cours de route** : après un redémarrage de `core`, les clics de souris (outil d'automatisation) sur les en-têtes de section repliables de la barre latérale (Shadow DOM, Alpine.js) cessaient d'être reçus par le handler `@click` alors que l'élément ciblé était correct et Alpine bien initialisé sur l'arbre — cause non identifiée avec certitude (probablement propre à l'outil d'automatisation/CDP et la composition d'événements à travers un Shadow DOM, pas un bug de l'application : un clic déclenché en JS (`element.click()`) fonctionne normalement). Contournement : utiliser `element.click()` via JS plutôt que des clics par coordonnées pour piloter cette barre latérale en automatisation.
- **Statut** : Corrigé/Implémenté (2026-08-16)
- **Priorité** : Résolu — suite : `nommage` (dernière app de la famille `integration:*`, chantier similaire + `passthrough:*`/`:ha:online`), puis pause sur `ia`/`planificateur`/`haplan`/`arbreouquoi`, `rfxcom` en tout dernier.

### 🟢 Superviseur — Phase 2 (suite) : `nommage` en process séparé — famille `integration:*` complète migrée
- **(16/08/2026)** : dernière application `type: 'integration'` de la liste. `bridgedEvents` = `NOMMAGE_ALL_EVENTS` + le chemin passthrough propre à nommage (`integration:nommage:passthrough:publish/discovery` — pas de discovery/state classiques comme arexx/evoo7, voir `NommageMqttIntegrationService`) + `integration:nommage:ha:online` + `app:module:config:saved`.
- **Vérifié en direct, bout en bout réel** : dashboard nommage (process séparé) affichant "Connecté"/"Connecté" (application + MQTT), 474 messages déjà parsés, source `ha2.local` connectée — cette connexion passe par le **pont mosquitto local↔ha2** mis en place plus tôt cette session (`data/nommage/config.yaml` pointe désormais sur `127.0.0.1`, mirroré vers/depuis `ha2` par le broker local) : première validation en conditions réelles que ce pont fonctionne correctement avec une vraie application migrée, pas seulement un test `mosquitto_sub` manuel. Aucune erreur console. Activée temporairement pour le test puis redésactivée (état initial restauré).
- **Statut** : Corrigé/Implémenté (2026-08-16)
- **Priorité** : Résolu — **toutes les apps `type: 'integration'` et les apps "simples" (rpigpio/teleinfo) sont migrées**. Reste : `ia`/`planificateur`/`haplan`/`arbreouquoi` (conception à faire — dépendance à `haStructureRegistry`/`haWsClient`, objets vivants construits par `core`, non transportables tels quels par MQTT ; `planificateur`/`haplan` exécutent réellement des commandes HA, même classe de risque que les incidents de sécurité RFXCOM), puis `rfxcom` en tout dernier (utilisateur à prévenir avant, pour rebrancher le récepteur physique sur cette machine).

### 🟢 Superviseur — `ia`/`planificateur`/`haplan`/`arbreouquoi` : migration en process séparé — Corrigé
- **(16/08/2026)**, décision d'origine : migration différée, jugée exiger un proxy de commandes HA par MQTT pour un bénéfice nul tant que ces apps restent sur la même machine que `core`.
- **Reprise et clôturée le 24/08/2026** : la prémisse "il faut un proxy" était fausse — `CorrelatedRequester` (déjà construit pour le dialogue ia↔planificateur, dupliqué dans les deux apps) suffisait, centralisé dans le socle. Nouveaux `HaQueryBridge`/`HaBridgeClient` (canal générique requête/réponse `ha:bridge:request`/`:reply`, cache local synchrone tenu à jour par les événements déjà émis `ha:entity:state_changed`/`ha:ready`, aucun aller-retour réseau pour les lectures fréquentes). `HaCommandService` retiré de `planificateur` (redondant avec le timeout déjà porté par `CorrelatedRequester`). Détails complets : `fonctionnelles-supervisor_specs_v2.7.md` §14.12.
- **Vérifié en conditions réelles** : les 4 apps démarrent en process séparé sans erreur ; arbreouquoi (arbre HA complet), ia (`obtenir_etat` résolu via Mistral), planificateur (planifications `state_change` actives), haplan (plan avec états en direct) tous fonctionnels. **Objectif du chantier confirmé** : désactivation/réactivation de `haplan` depuis *Gestion des applications* sans jamais redémarrer `core` (uptime ininterrompu). Les 12 applications du socle tournent désormais toutes en process séparé.
- **Commande d'écriture réelle testée par l'utilisateur** depuis HAPLAN (extinction d'une lumière) — confirmée fonctionnelle de bout en bout à travers l'IPC.
- **Effet de bord découvert, non corrigé** : le bandeau UI *Gestion des applications* ("Redémarrage en cours...") reste affiché indéfiniment après désactivation d'une app séparée — texte hérité de l'époque où toute désactivation redémarrait `core`, trompeur mais sans conséquence réelle (l'app se désactive bien).
- **Statut** : Corrigé/Implémenté (2026-08-24)
- **Priorité** : Résolu

### 🟢 Superviseur — Phase 2 (fin) : `rfxcom` en process séparé — migration terminée pour toutes les apps prévues
- **(16/08/2026)**, dernière application migrée, comme convenu avec l'utilisateur (prévenu avant de commencer pour rebrancher physiquement le récepteur sur cette machine). Même chantier qu'arexx/evoo7/nommage : `bridgedEvents` = `RFXCOM_ALL_EVENTS` + famille `integration:rfxcom:*` complète, y compris le canal passthrough (`:passthrough:subscribe/publish/message`) qui porte le relais inter-instances "registered-devices" ajouté plus tôt cette session.
- **Prérequis découvert en préparant le test** : `data/rfxcom/config.yaml` pointait encore sur `/dev/ttyUSB0` — le vrai récepteur RFXtrx433XL fraîchement branché est apparu sur `/dev/ttyUSB1` (confirmé via `udevadm`, `idVendor=0403`/`manufacturer=RFXCOM`/`product=RFXtrx433XL` ; `/dev/ttyUSB0` est un adaptateur générique CH340 sans rapport). Corrigé avant de démarrer.
- **Vérifié en conditions réelles, avec le vrai matériel** : transceiver connecté (`433.92MHz, firmware ProXL 2 v1047`), 60 devices/23 récepteurs paramétrés, dashboard affichant un état à jour (dont un changement de valeur réel reçu ~40s après le démarrage — signal RF433 authentique capté passivement). **Aucune commande envoyée au démarrage** (vérifié explicitement dans les logs, vigilance particulière vu les deux incidents de sécurité de cette session) — les correctifs déjà en place dans `RfxComService`/`stateCommand.ts` tiennent sous la migration, inchangés. Le mécanisme d'exclusion inter-instances fonctionne correctement à travers le pont mosquitto local↔ha2 : ce process de test local voit bien la production (`rfx_bridge_0001` sur ha2) déjà propriétaire de tous ses devices réels et s'abstient de republier leur découverte.
- **Différence avec arexx/evoo7/nommage, initialement** : laissée **activée** après le test (pas redésactivée) — l'objectif de cette migration était que les futurs tests RFXCOM se fassent sur cette machine avec le matériel branché ici, pas une vérification ponctuelle à annuler ensuite.
- **Redésactivée le 16/08/2026 (même session, plus tard)** : l'utilisateur a remis le récepteur physique sur `orangepi` (retour à sa machine de production) — `rfxcom` désactivée ici via l'UI (Paramètres Techniques → Gestion des applications) pour éviter les erreurs "transceiver non connecté" en boucle sur `falbala` sans matériel. `arexx`/`evoo7`/`nommage`/`rfxcom` sont donc toutes les quatre désactivées sur cette machine à l'issue de la session — seuls `rpigpio`/`teleinfo` (agents distants réels) et `espdisplay` restent des apps séparées actives ici.
- **Statut** : Corrigé/Implémenté (2026-08-16)
- **Priorité** : Résolu — **migration superviseur Phase 2 terminée** pour toutes les apps prévues (`espdisplay`, `rpigpio`, `teleinfo`, `arexx`, `evoo7`, `nommage`, `rfxcom`). Restent en in-process par décision explicite : `ia`/`planificateur`/`haplan`/`arbreouquoi` (voir entrée dédiée ci-dessus).

### 🟢 RFXCOM : exclusion réelle + relais entre instances des valeurs captées pour un capteur qui n'est pas le sien — Vérifié en conditions réelles
- **⏳ À FAIRE dès que possible** : tester ce mécanisme (exclusion + relais + anti-écho) avec **2 récepteurs RFXCOM réellement actifs simultanément**, en recouvrement RF — impossible cette session (un seul dongle physique, reparti sur `orangepi`). Pas de suite de tests automatisée pour cette app, seule une vérification en conditions réelles peut confirmer le bon fonctionnement.
- **Idée utilisateur (16/08/2026)**, dans le prolongement du mécanisme `registered-devices` (chantier 4 du superviseur, `fonctionnelles-supervisor_specs` §9.4) : chaque instance RFXCOM connaît déjà, via ce mécanisme, la liste des devices possédés par les autres instances. Deux volets tranchés avec l'utilisateur avant construction :
  1. **Exclusion réelle de la liste "découverts"** — jusqu'ici `isClaimedByOtherInstance` n'alimentait qu'un avertissement séparé (`claimed-elsewhere`), sans jamais retirer le device de la liste envoyée à l'UI (vérifié dans le code avant de corriger). La déclaration reste **locale, au plus près du signal reçu** (pas de relais des métadonnées de découverte pour déclarer ailleurs — l'utilisateur a explicitement simplifié cette partie de l'idée initiale).
  2. **Relais de valeur** : quand une instance reçoit un signal RF433 pour un device qu'elle sait appartenir à une **autre** instance, elle le lui transmet ("j'ai vu une valeur pour ton capteur X") plutôt que de l'ignorer silencieusement — backup en cas de réception ratée côté propriétaire, jamais une publication concurrente vers HA (§9.1 "une entité, un endroit"). **Explicitement hors scope, demande utilisateur** : pas de relais de commande (aucun mécanisme pour qu'une instance sans portée RF fasse transmettre une commande par une autre).
- **Garde-fou anti-écho (cas identifié par l'utilisateur, traité)** : quand une instance exécute une commande (HA → `applyReceiverCommandInternal` → `transceiver.sendCommand()`), elle transmet réellement un signal RF433 en se faisant passer pour le `primaryEmitter` — un dongle d'une autre instance à portée le capte exactement comme une vraie pression télécommande. Sans garde-fou, le relais ferait remonter à l'émettrice l'écho de sa propre commande. Résolu : `recentlyCommandedEmitters` (Map uniqueId→expiration) posé juste après `sendCommand()`, fenêtre de 5s (`RELAY_ECHO_SUPPRESSION_MS`) — tout relais entrant pour ce device pendant la fenêtre est ignoré.
- **Construit (16/08/2026)**, `applications/rfxcom/src/domain/RfxComService.ts` : `emitDevicesList()` filtre désormais `discoveredDevices` par `isClaimedByOtherInstance` (recalculé aussi à chaque réception `registered-devices`, pas seulement au chargement — liste UI à jour en direct) ; `handleRfxMessage()` publie sur un nouveau topic `rfxcom/{bridgeInstance}/relayed-value` (non retenu, contrairement à `registered-devices`) dès qu'un signal concerne un device revendiqué ailleurs, et supprime l'émission `rfxcom:device:detected` pour ce cas ; `handleRelayedValueMessage()` (nouveau) reçoit le relais côté propriétaire, vérifie l'anti-écho puis l'appartenance réelle (`deviceManager.getDevice`), reconstruit `timestamp` (Date, perdu en `string` par l'aller-retour JSON du passthrough MQTT — sans quoi tout `.toISOString()` en aval aurait levé une exception), puis rejoue la trame par le même chemin que `handleRfxMessage` (état sensor si `transmitToHa`, `receiverManager.handleEmitterMessage` si type `Lighting*`).
- **Build propre** (`tsc -b`), pas de suite de tests pour cette application (aucun script `test`, cohérent avec le reste de RFXCOM).
- **⭐ 31/08/2026, débloqué** : il y a désormais bien 2 récepteurs RFXCOM réels et actifs simultanément — `stfort` (192.168.1.53, `bridgeInstance: rfx_bridge_stfort`, instance principale, ~76 devices configurés) et `orangepi` (192.168.1.130, IP changée depuis .32 le 30/08 — voir note plus bas, `bridgeInstance: rfx_bridge_0001`, présent uniquement pour faire relais selon l'utilisateur, 0 device configuré chez lui). Vérifié en direct :
  - Les deux `rfxcom:status` remontent `connected:true`, même modèle de transceiver (433.92MHz, firmware Ext v1006).
  - Le broker MQTT partagé contient bien 2 topics `registered-devices` distincts et à jour :
    `rfxcom/rfx_bridge_stfort/registered-devices` (liste complète des ~76 uniqueId de stfort) et
    `rfxcom/rfx_bridge_0001/registered-devices` ([], cohérent avec 0 device configuré côté
    orangepi) — la mécanique de publication/abonnement au recouvrement (§9.4) fonctionne donc
    bien de bout en bout entre les deux instances. (Un 3e topic orphelin `rfx_bridge_780922`
    traîne aussi, retenu — reste de l'ancienne instance rfxcom de `ha2`, désactivée depuis ;
    inoffensif, à purger un jour si ça gêne.)
  - **⭐ 31/08/2026, cas réel de recouvrement observé et confirmé** : l'utilisateur a déclenché
    physiquement 2 boutons/télécommandes RF (`0x017334A2/10` et `0x0156F0D6/11`, tous deux déjà
    revendiqués par `stfort`). Capturé en direct sur le broker MQTT (`mosquitto_sub` sur
    `rfxcom/+/relayed-value`, non retenu) : `orangepi` a bien publié 7 messages `relayed-value`
    correctement formés (`objectId`, `message` complet avec `commandDeviceId`/`signalLevel`/
    `batteryLevel`/`data`/`timestamp`) pour ces deux objectId — confirmant qu'il les a détectés,
    correctement identifiés comme revendiqués ailleurs (pas d'émission `rfxcom:device:detected`
    côté orangepi), et relayés plutôt que traités localement. **Côté réception, preuve directe et
    non ambiguë** : le fichier `config-rfxcom-devices-v1.0.yaml` de `stfort` lui-même montre
    `lastSeen` mis à jour à `2026-08-31T09:43:29.225Z` et `09:43:33.545Z` pour ces deux devices —
    horodatages qui correspondent exactement aux derniers messages relayés reçus, prouvant que
    `handleRelayedValueMessage()` a bien tourné côté propriétaire (`deviceManager.handleRawMessage`
    appelé comme pour une réception directe). Logs applicatifs de `stfort` muets sur toute cette
    fenêtre (aucun log explicite de succès n'existe sur ce chemin par construction, et ce sont des
    devices "Bouton"/émetteur sans topic d'état sensor propre — silence attendu, pas un doute) :
    c'est la preuve par le fichier de config lui-même qui a tranché, pas les logs.
  - Anti-écho non testé spécifiquement cette fois (aucune commande HA envoyée pendant la fenêtre
    d'observation), mais le reste de la chaîne (exclusion + relais + réception + mise à jour) est
    désormais vérifié de bout en bout, sur du vrai matériel, en conditions réelles.
- **Statut** : Vérifié en conditions réelles (2026-08-31) — exclusion, relais et réception confirmés sur un cas réel de recouvrement RF
- **Priorité** : Résolu

### 🟢 RFXCOM : commande OFF réelle envoyée au démarrage pour tout récepteur sans état connu — pouvait éteindre toute la maison — Corrigé
- **Constat utilisateur (15/08/2026)**, en creusant la rafale d'échecs "Transceiver RFXCOM non connecté" observée juste après un redémarrage d'`orangepi` : *"parfois ces commandes arrivent à passer et m'éteignent toute la maison"*. `publishReceiverStateAtStartup()` (`RfxComService.ts`) envoyait une vraie commande RF433 `turn_off` à tout récepteur commandable (light/switch) dont `lastOn` n'était pas connu au démarrage — comportement présent depuis l'origine de l'app, initialement pensé pour "initialiser l'état". Un device/récepteur n'ayant jamais reçu de commande individuelle depuis l'import de l'inventaire reconstitué (voir entrée "Reconstitution des équipements RFXCOM" de l'historique) déclenchait donc une vraie transmission OFF à **chaque** redémarrage — avec succès ou échec silencieux selon que le transceiver était déjà connecté à ce moment précis (course avec `protocolsPushGate`), d'où le caractère imprévisible ("parfois").
- **Diagnostic et correctif proposés par l'utilisateur, tranchés tels quels** : peu importe la cause exacte de l'état inconnu — la vraie erreur de conception est d'exécuter une commande matérielle sur un état supposé plutôt que de simplement le reporter à HA sans l'exécuter.
- **Corrigé (15/08/2026)** : `publishReceiverStateAtStartup()` republie désormais toujours l'état à HA de façon strictement passive (`publishReceiverState()`), qu'il soit connu ou non — plus aucune commande matérielle envoyée au démarrage. `getState()` retombe sur son défaut interne (`this.on = config.lastOn ?? false`) si l'état est inconnu : HA peut afficher une valeur optimiste incorrecte, mais plus jamais d'action physique non désirée.
- **Au passage** : correction d'une incohérence de documentation — `fonctionnelles-rfxcom_specs` §20 décrivait `lastOn`/`lastLevel` comme "strippés au chargement, non corrigés", alors que `devices-config-schema.ts` les déclare correctement depuis le 07/08/2026 (le tableau n'avait simplement jamais été mis à jour après ce correctif antérieur).
- **Vérifié en conditions réelles (v5.14 seule)** : build propre, déployé sur `ha2`/`orangepi` (image `1.7.0`), logs/MQTT contrôlés après un redémarrage physique d'`orangepi` — états publiés normalement, aucune commande matérielle constatée au démarrage.
- **Suite (15-16/08/2026, v5.15 puis découverte d'un second bug distinct)** : le gap `lastValue`/`commandDeviceId` traité (voir entrée dédiée juste en dessous), puis un second incident distinct découvert au moment de vérifier le déploiement en conditions réelles — voir entrée "commandes MQTT retenues" plus bas. Les deux déployés ensemble sur `ha2`/`orangepi` (image `1.7.1`).
- **Statut** : Corrigé (2026-08-15) — voir `fonctionnelles-rfxcom_specs_v5.14.md` §9.2bis (déployé, image `1.7.0`)
- **Priorité** : Était Critique (action physique non désirée sur des appareils réels du domicile) — résolu

### 🟢 RFXCOM : `lastValue`/`commandDeviceId` (devices) strippés au rechargement + nouvel horodatage global — Corrigé
- **Contexte (15/08/2026)**, suite directe de l'entrée ci-dessus : question utilisateur sur pourquoi la dernière valeur des capteurs n'était pas repositionnée au démarrage malgré le correctif récepteurs — `lastValue`/`commandDeviceId` n'étaient jamais déclarés dans `rfxComDeviceSchema` (contrairement à `lastOn`/`lastLevel` des récepteurs, corrigés le 07/08/2026), donc strippés à chaque rechargement de `config-rfxcom-devices-v1.0.yaml`. Confirmé dans le code : `device.lastValue = stateValue` bien assigné en mémoire à chaque message (`RfxComService.ts`), juste perdu au redémarrage suivant.
- **Correction de l'hypothèse initiale de l'utilisateur** : la fenêtre de fraîcheur de 30 min (`LAST_VALUE_MAX_AGE_MS`) n'est **pas** un bug de portée globale ("30 min depuis n'importe quel capteur") — `device.lastSeen` est bien un champ par device, correctement persisté et comparé individuellement. Le vrai problème était uniquement `lastValue` toujours `undefined`, rendant la condition de fraîcheur systématiquement fausse quel que soit `lastSeen`.
- **Corrigé (15/08/2026)**, trois demandes utilisateur distinctes traitées ensemble :
  1. `lastValue`/`commandDeviceId` ajoutés à `rfxComDeviceSchema` (`devices-config-schema.ts`) — survivent désormais au rechargement.
  2. Fenêtre de fraîcheur de 30 min **retirée** de `publishDeviceStateAtStartup()` — devenue sans objet une fois `lastValue` persisté correctement ("les dernières valeurs soient repositionnées... au démarrage", sans condition d'âge).
  3. Nouveau champ `lastAnyValueChangeAt` (niveau fichier, pas par device) : horodatage du dernier changement de valeur tous devices confondus, persisté, exposé dans `RfxComStatus` et affiché sur le tableau de bord ("Dernier changement (tous devices)") — demande explicite, sans logique de fraîcheur/alerte dessus pour l'instant ("on supprime le contrôle par rapport à la date").
- **Vérifié** : build propre (backend + UI), déployé sur `ha2`/`orangepi` (image `1.7.1`).
- **Statut** : Corrigé (2026-08-15, voir `fonctionnelles-rfxcom_specs_v5.15.md` §9.2/§9.2ter/§20)
- **Priorité** : Moyenne (cosmétique/confort — capteurs affichés "Indisponible" après chaque redémarrage jusqu'à la prochaine trame réelle, aucun risque physique contrairement à l'entrée ci-dessus)

### 🟢 Socle : commandes MQTT retenues rejouées à chaque redémarrage — second incident distinct découvert en vérifiant le déploiement — Corrigé
- **Découvert (16/08/2026)** en vérifiant le déploiement du correctif ci-dessus : après redémarrage d'`orangepi`, la même rafale "Échec de la commande turn_off... Transceiver RFXCOM non connecté" persistait — mais cette fois confirmé venir de `handleHaCommand()` (commande **reçue**, pas envoyée par notre propre code de démarrage, déjà corrigé). Hypothèse de l'utilisateur vérifiée et confirmée : abonnement direct au broker (`mosquitto_sub`, sans rien redémarrer) sur ces mêmes topics de commande → réponse immédiate "OFF"/"ON" — uniquement possible si le message est **retenu** (`retain: true`) sur le broker. ~21 topics de commande RFXCOM concernés (`rfxcom/rfx_bridge_0001/{receiverId}/set`), aucun autre module touché (evoo7/arexx/rpigpio vérifiés propres).
- **Cause probable** : un `mosquitto_pub -r` manuel ancien (session de test passée), pas un comportement actif de HA (HA ne retient pas ses commandes light/switch par défaut). Audit complet du code (socle + 5 apps) : aucun point de publication ne publie jamais de commande avec retain — confirmé que ce n'est pas notre code qui a produit ces messages.
- **Corrigé (16/08/2026)**, au niveau du socle (`stateCommand.ts::parseIncomingCommand()`) : tout message de commande arrivant avec `retain: true` est désormais ignoré — le flag était déjà capturé (`MqttTransport`/`MqttMessage.retain`), jamais vérifié avant ce correctif. Protège tous les modules du même patron (rfxcom, evoo7, arexx, nommage), pas seulement RFXCOM.
- **Nettoyage** : les 21 messages retenus déjà présents sur le broker de production purgés manuellement (payload vide en retain sur chaque topic concerné) — confirmé vide après coup.
- **Vérifié** : build + suite de tests core propres (110/111, 1 skip inchangé), déployé sur `ha2`/`orangepi` (image `1.7.1`).
- **Statut** : Corrigé (2026-08-16, voir `techniques-socle-ha-mqtt_specs_v4.30.md` §8.5.4ter)
- **Priorité** : Était Critique (même risque physique que l'entrée ci-dessus, cause différente) — résolu

### 🟢 IA : coût/latence des appels Mistral — Piste 1 (cache de prompt) faite, Pistes 2/3 non tranchées
- **Constat (10/08/2026)**, en testant en direct la résolution des lieux : les appels Mistral observés tournent entre 11k et 35k tokens de prompt (`RateLimiter` a atteint son budget 100k tokens/min pendant les tests). Cause principale identifiée : `RulesProvider.inject()` (`rules.ts`) préfixe **l'intégralité** de `regles_mistral.txt` (739 lignes) comme message system à **chaque** appel Mistral — que ce soit un ordre direct ou une réinterprétation de planification —, et `entities_snapshot` (394 entités) est reconstruit et renvoyé en entier à chaque fois. Aucune mémoire ni réduction entre deux appels, même successifs et quasi identiques (`DeployResponder.handle()` : un appel HTTP entièrement autonome à chaque déclenchement).
- **Piste 1 — cache de prompt Mistral — Fait (2026-08-11, commit `6056a68`)** : `prompt_cache_key` (identifiant stable côté appli) ajouté sur tous les appels Mistral partageant un préfixe (`MistralClient.ts`), jamais transmis en mode Anthropic (pas de cache côté compatibilité OpenAI). Vérifié en direct contre l'API Mistral réelle : premier appel `cached_tokens: 0`, second appel (même contenu, même clé) ~99% du prompt system servi depuis le cache (11232/11263 tokens), facturé à 10% du tarif normal. `cachedTokens` remonté de bout en bout (`streaming.ts` → `IaService.ts`) et affiché dans le journal des échanges. Documenté dans `fonctionnelles-ia_specs_v1.9.md`.
- **Piste 2 — séparer prompt "ordre direct" et prompt "planification"** : `regles_mistral.txt` contient ~300 lignes sur 739 (§1.G assistance guidée, §2 macro/sequence/gestion, §3 types de déclencheurs) qui ne servent jamais pour un ordre direct type "allume le salon" (estimé 80% des cas), uniquement pour créer/gérer une planification. Deux approches envisagées :
  - (A) un premier appel dédié à la classification, puis un second avec le prompt adapté — fiable mais ajoute un aller-retour Mistral **même pour les 80% d'ordres directs**, donc plus de latence sur le cas le plus sensible à la réactivité.
  - (B, préférée) prompt allégé par défaut (sans §1.G/§3/macro-sequence-gestion), avec échappatoire : si Mistral détecte qu'il lui manque la machinerie de planification, il le signale explicitement (ex. `{"type":"besoin_planification"}`) et on relance une seule fois avec le prompt complet. Aucun surcoût sur les 80% d'ordres directs, un aller-retour supplémentaire seulement sur les 20% de planifications (cas moins sensible à la latence). Nécessite un vrai travail de prompt engineering (apprendre à Mistral à détecter fiablement ce besoin plutôt que d'halluciner une réponse bancale) et des tests en direct, comme pour lieu_precis/lieu_pere.
- **Piste 3 — restructurer `entities_snapshot`** : actuellement une ligne plate par entité avec `area_id`/`lieu_precis`/`lieu_pere` répétés à chaque ligne (394 lignes). Regrouper par area/hiérarchie réduirait la répétition (donc les tokens) et pourrait aussi aider Mistral à repérer plus fiablement des cas comme "deux toilettes, étages différents" d'un coup d'œil plutôt qu'en scannant 394 lignes. Reste de la présentation de données, la résolution réelle reste entièrement côté `core` (`HaStructureRegistry`).
- **Non traité** : Pistes 2 et 3, toujours à l'état de discussion.
- **Statut** : Piste 1 faite (2026-08-11) — Pistes 2/3 non traitées (discussion)
- **Priorité** : Moyenne (pas de gêne fonctionnelle actuelle, optimisation de coût/latence)

### 🟡 Sauvegarde/duplication multi-machines de HA lui-même — à concevoir
- **Contexte (15/08/2026)**, issu de la discussion sur le point de défaillance unique du superviseur multi-machines (`fonctionnelles-supervisor_specs_v2.3.md` §6.4) : la piste initialement envisagée (un broker MQTT local par machine, ponté vers un broker partagé) a été écartée — MQTT est colocalisé avec HA, donc la panne du broker implique quasi systématiquement la panne de HA lui-même. Le vrai point de dépendance critique du système entier n'est pas MQTT, c'est **HA** : le perdre veut dire perdre le cerveau (toutes les discovery arrivent via ESPHome ou MQTT, dont HA est la destination), remonter une machine HA reste impératif dans tous les cas, quelle que soit l'architecture du superviseur.
- **Décision utilisateur (15/08/2026)** : ne pas chercher à rendre MQTT résilient (broker unique partagé reste la bonne décision) — investir plutôt dans une vraie stratégie de sauvegarde/duplication de HA lui-même (l'instance complète, pas seulement sa config), en complément de ce qui existe déjà par application (`data/rfxcom`, `data/rpigpio`, `data/evoo7`...) mais pas encore systématisé pour HA ni généralisé à toutes les apps.
- **À faire** : définir le périmètre (sauvegarde périodique de la configuration HA complète ? réplication d'une instance de secours prête à prendre le relais ? simple procédure de restauration documentée sur du matériel neuf ?), et vérifier que toutes les apps métier ont bien une stratégie de sauvegarde de leurs données locales (`data/{app}/`) équivalente à celle déjà en place pour rfxcom/rpigpio/evoo7 — liste exhaustive à établir, au moins une app mentionnée comme "oubliée" lors de la discussion, à identifier.
- **⭐ 16/09/2026 : promu en spec dédiée** — `specs/current/fonctionnelles-sauvegarde_specs_v1.0.md`. Destination et mécanisme de transport tranchés (Nextcloud auto-hébergé déjà dupliqué offsite, push direct WebDAV/curl par machine via WireGuard). Reste ouvert : structure de dossiers définitive, portée exacte HA, liste exhaustive des `data/{app}/`, fréquence/rotation — voir la spec pour le détail, ne pas dupliquer ici.
- **Statut** : Non traité pour l'implémentation — conception dans la spec dédiée
- **Priorité** : Moyenne (pas d'incident vécu sur ce point précis, mais rejoint directement l'incident carte SD Pi4 déjà vécu cette session)

### 🟡 Supervision multi-sites indépendante + alerte hors HA (conception, 16/09/2026)
- **⭐ 16/09/2026 : promu en spec dédiée** — `specs/current/fonctionnelles-supervision-externe_specs_v1.0.md`. Conception complète : 2 RPi1 "sacrifiables" (un par site, redondance cross-site via `TargetGossipService`/WireGuard), pattern agent minimal `teleinfo` inversé, canal SMS/email de repli (legacy noisy confirmé actif), **surveillance des sauvegardes intégrée** (consomme le marqueur de statut de `fonctionnelles-sauvegarde_specs_v1.0.md` §5ter). Reste ouvert : sondage zigbee2mqtt/autres, accès exact au marqueur de sauvegarde, surveillance mutuelle des deux RPi — voir la spec pour le détail, ne pas dupliquer ici.
- **Statut** : Non traité pour l'implémentation — conception dans la spec dédiée
- **Priorité** : Moyenne (pas d'incident vécu, mais rejoint la même discussion de résilience que la sauvegarde HA ci-dessus)

### 🟢 Socle : bridgeInstance absent du topic de découverte MQTT (collision entre deux instances) — Corrigé
- **Constat (10/08/2026)**, en manipulant deux instances RFXCOM en parallèle (locale de test `rfx_bridge_local_test`, orangepi production `rfx_bridge_0001`) pour le même appareil physique : le topic de découverte est `homeassistant/{component}/{objectId}/config` (`getDiscoveryTopic()`, `ha-mqtt.ts`) — **ne contient pas** le bridgeInstance, seulement `objectId` (ex: `recepteur_1000987`). Un seul message MQTT retenu existe donc par entité, quel que soit le nombre d'instances/bridges qui publient pour le même objectId — la dernière à publier écrase entièrement le message précédent (y compris ses champs `command_topic`/`state_topic`, qui eux embarquent bien le bridgeInstance). Résultat concret : impossible de savoir, sans interroger le broker, quelle instance "possède" actuellement une entité donnée dans HA — source de confusion réelle constatée cette session (tests locaux modifiant silencieusement la cible des commandes HA pour des entités de production).
- **Demande utilisateur (10/08/2026)** : le bridgeInstance devrait apparaître dans le topic de découverte lui-même (pas seulement dans les champs `command_topic`/`state_topic` à l'intérieur du payload) — HA supporte un segment `node_id` optionnel dans son format de découverte (`homeassistant/{component}/[node_id/]object_id/config`), utilisable pour ça sans rupture de protocole côté HA.
- **Conception tranchée (15/08/2026)**, discussion approfondie avec l'utilisateur dans le cadre de la refonte du superviseur multi-machines (`fonctionnelles-supervisor_specs_v2.3.md` §9, réécrite) :
  - **Une entité = un seul endroit**, sous la responsabilité de la personne qui paramètre — pas de résolution automatique (contrôle éventuel repoussé, "on verra").
  - **`node_id` = `bridgeInstance`** dans le topic de découverte (`homeassistant/{component}/{bridgeInstance}/{objectId}/config`) — tranché, à implémenter dans `discovery.ts` (socle), impacte rfxcom/evoo7/nommage.
  - **Défaut de `bridgeInstance`** : abandon de l'idée "dérivé du `machineId`" (v1.0/v2.x du superviseur) au profit d'un **tirage aléatoire suffisamment grand** (ex. 6 chiffres), généré une seule fois au premier démarrage et persisté — généralisé à **tous** les modules à bridge, y compris rfxcom (défaut actuel `rfx_bridge_0001`, une chaîne fixe partagée, vulnérable à la même collision). Ne change que le défaut d'une config générée à neuf, pas de migration rétroactive des instances déjà en production.
  - **Découverte en creusant ce point (15/08/2026)** : `rpigpio` n'a **aucun** `bridgeInstance` aujourd'hui, contrairement à rfxcom/evoo7/arexx — sa découverte HA passe par le processus externe **mqtt-io**, avec un `topicPrefix`/`discoveryPrefix` fixe et identique sur toute machine (`mqttio/rpigpio`/`homeassist`, `applications/rpigpio/src/domain/config-schema.ts`), sans passer par les conventions du socle (`getStateTopic()`/`getCommandTopic()`/`discovery.ts`). **Deux machines rpigpio non reconfigurées à la main collisionnent donc déjà aujourd'hui, réellement** — pas hypothétique comme le cas RFXCOM d'origine. À faire : donner à rpigpio un vrai `bridgeInstance` (même tirage aléatoire persisté), l'injecter dans le `topic_prefix`/`ha_discovery` généré pour mqtt-io (`applications/rpigpio/src/domain/generator.ts`, fonction `generateMqttIoConfig`).
  - **RFXCOM, cas distinct — recouvrement RF réel** (deux dongles voient probablement le même signal physique, pas une erreur de config) : nouveau mécanisme de diffusion — topic retenu `rfxcom/{bridgeInstance}/registered-devices` (liste JSON des devices enregistrés par cette instance, republiée à chaque changement), chaque instance s'abonne à `rfxcom/+/registered-devices` pour savoir ce qui est déjà revendiqué ailleurs et **ne pas publier** de découverte pour un device déjà revendiqué — avec un avertissement **visible** dans le tableau de bord RFXCOM (pas une exclusion silencieuse). Implémentable dès maintenant, indépendant du reste du superviseur (RFXCOM est déjà connecté au broker partagé).
  - **Zigbee (nommage)** : pas concerné, déjà résolu par `topicPrefix` distinct par source.
- **⭐ 31/08/2026, constaté largement implémenté en revue de TODO** (cette entrée n'avait jamais été mise à jour après coup) — vérifié dans le code, tout construit le 15/08/2026 même jour que la conception (commit `841d643`, "Implémente les prérequis 2/3/4/7 du superviseur multi-machines v2.3") :
  - `getDiscoveryTopic(component, objectId, bridgeInstance?)` (`ha-mqtt.ts`) injecte bien le `bridgeInstance` en `node_id` quand fourni, et `publishDiscovery()` nettoie activement l'ancien topic sans node_id à chaque publication (migration propre, sans message retenu orphelin).
  - Câblé de bout en bout via `HaMqttIntegrationService.publishDiscoveryFor()` / `IntegrationBridge` — `bridgeInstance` est un paramètre **obligatoire** à ce niveau, plus une simple option oubliable.
  - `generateRandomBridgeInstance(appId)` (tirage 6 chiffres, `{appId}_bridge_{suffix}`) existe et est utilisé pour générer/persister le défaut au premier démarrage de **rfxcom, evoo7, rpigpio, arexx** (pas teleinfo, qui n'a pas de concept de bridgeInstance du tout — device-agent à cible unique, pas concerné).
  - `rpigpio` a désormais son propre champ `bridgeInstance` (`rpigpio_bridge_0001` par défaut, randomisé au premier démarrage comme les autres) injecté dans `topic_prefix`/`discoveryPrefix` du config mqtt-io généré (`generator.ts::generateMqttIoConfig`) — la collision "réelle dès aujourd'hui" signalée dans cette entrée est donc déjà traitée à la source.
  - **Seule exception, volontaire et déjà tracée séparément** : `nommage` garde `BRIDGE_INSTANCE = 'main'` codé en dur (décision du 28/08/2026, voir entrée "Nommage : collision nommage-main" — nommage est un service unique par site, une collision doit être détectée comme erreur de config plutôt que masquée par un tirage aléatoire).
  - **Dernier point vérifié le 31/08/2026 (code, pas conditions réelles)** : le relais des découvertes rpigpio *via le pipeline nommage* préserve bien le `node_id`/`bridgeInstance` d'origine. Tracé bout en bout : `NommageService.handleDiscoveryMessage` transmet `sourceTopic` (le topic COMPLET reçu de mqtt-io, `node_id` rpigpio inclus depuis le correctif `generator.ts`) tel quel dans l'événement `passthrough:discovery` — `bridgeInstance: BRIDGE_INSTANCE` ('main') dans cet événement ne sert qu'à choisir la connexion MQTT de nommage à travers laquelle publier (`getBridgeOrWarn`), jamais à reconstruire le topic. `publishDiscoveryPassthrough()` (`passthrough.ts`) → `rewriteToHomeAssistantPrefix(sourceTopic)` ne réécrit QUE le premier segment (préfixe `homeassist`→`homeassistant`), tous les segments suivants — dont le node_id rpigpio — passent inchangés. Pas de perte.
- **Statut** : Corrigé/implémenté (15/08/2026 pour l'essentiel, jamais documenté comme tel — dernier point de vérification clos le 31/08/2026)
- **Priorité** : Résolu

### 🟡 RFXCOM : abonnements aux topics de commande non réappliqués après reconnexion/redémarrage — non confirmé
- **Constat initial (10/08/2026)**, en creusant pourquoi une commande "allumer" envoyée à HA (transceiver rebranché, correctement connecté) ne déclenchait toujours aucune transmission RF : `[ha:mqtt:transport] Reconnexion — 1 abonnement(s) réappliqué(s)` — seul `homeassistant/status` semblait réabonné après une reconnexion MQTT, jamais les topics de commande par récepteur.
- **Réinvestigation la même session, avec un log de diagnostic temporaire** (`IntegrationBridge.publishDiscoveryWithArea`, retiré après coup) : `publishDiscoveryFor()` (donc `subscribeCommandsFor()`) s'exécute bien pour chaque récepteur, sans blocage sur `ensureArea()`, et le message de découverte retenu sur le broker finit par refléter le `bridgeInstance` courant — mais avec un délai variable (jusqu'à plusieurs dizaines de secondes après le démarrage dans certains essais). Le "bug" observé au départ semble avoir été des vérifications faites trop tôt pendant une session de redémarrages très rapprochés, pas un blocage permanent.
- **Non tranché** : aucune cause de fond confirmée ni corrigée — seulement infirmé que ce soit un blocage permanent. Le délai de republication observé (jusqu'à ~30-45s) reste à comprendre si le problème revient.
- **Statut** : Non confirmé comme bug — à re-tester dans des conditions plus stables (un seul redémarrage, sans changement de config en parallèle) avant de rouvrir l'investigation.
- **Priorité** : Moyenne (dégradée depuis "Haute" — pas de reproduction fiable)

### 🟢 RFXCOM : reconnexion automatique du transceiver matériel (boucle 5s) — Fait
- **Demande utilisateur (10/08/2026)** : si le transceiver RFXCOM n'est pas connecté au démarrage, ou se déconnecte en cours de fonctionnement, retenter une connexion toutes les 5 secondes plutôt que d'exiger un redémarrage complet.
- **Fait** : `RfxComService.startReconnectLoop()`/`stopReconnectLoop()`/`attemptAutoReconnect()` — démarrée sur `onConnectionChange(connected=false)` (couvre à la fois l'échec initial et une déconnexion en cours de route, le callback étant enregistré avant le premier `connect()`), arrêtée dès `connected=true`, nettoyée à l'arrêt du service. `PortDetector` re-résolu à chaque tentative (le port `/dev/serial/by-id` peut réapparaître sous le même chemin stable). Build vérifié, non testé en conditions réelles de débranchement/rebranchement (transceiver resté connecté pendant le test).
- **Statut** : Fait (10/08/2026, commit 8105fc7)
- **Priorité** : Moyenne

### 🟢 RFXCOM : journal des ordres reçus avec résultat d'exécution (100 max) — Fait
- **Demande utilisateur (10/08/2026)**, suite à la découverte que Mistral confabule un succès ("La lumière de la salle est allumée 💡") alors que RFXCOM avait réellement refusé la commande (transceiver débranché) — l'ACK générique `homeassistant.turn_on` masque cet échec à tous les niveaux en amont (planificateur, IA).
- **Fait** : `RfxComService` tient désormais son propre journal (`recentOrders`, 100 max) de chaque ordre reçu (récepteur cible, commande, valeur) avec le résultat réel d'`applyReceiverCommand()` (connecté ou non, erreur de résolution/transmission) — nouvel événement `rfxcom:orders:list` (persistant) + carte "Journal des ordres reçus" sur le tableau de bord RFXCOM. Vérifié en direct : capture bien les échecs "Transceiver non connecté" et les erreurs de device.
- **Statut** : Fait (10/08/2026, commit 8105fc7)
- **Priorité** : Haute (résolu)

### 🟢 RFXCOM : publication optimiste de l'état HA même transceiver débranché — Corrigé
- **Constat utilisateur (10/08/2026)**, en testant le circuit complet IA→planificateur→HA→RFXCOM avec le transmetteur RFXCOM physiquement débranché : la commande "allumer" a quand même été relayée jusqu'à RFXCOM, qui a publié `state:"ON"` sur MQTT (confirmé retenu sur le broker via `mosquitto_sub`) — HA affichait la lumière allumée alors qu'aucune trame RF n'avait pu être émise.
- **Cause** : `RfxComService.applyReceiverCommand()` appelait `transceiver.sendCommand()` puis publiait l'état dans le même bloc `try`, sans vérifier la connexion — `sendCommand()` ne lève une exception que si le transceiver n'a jamais été initialisé depuis le démarrage, pas s'il a été débranché après une connexion antérieure réussie.
- **Corrigé** : vérification explicite de `transceiver.isConnected()` avant tout envoi — échec propre (`rfxcom:error`, log ERROR), aucune publication d'état optimiste.
- **Limitation restante, non traitée** : même connecté, `sendCommand()` reste optimiste sur la RÉCEPTION RF433 par le récepteur physique lui-même — la lib `rfxcom` ne remonte que la confirmation d'écriture bas niveau sur le port série (`buildAckLogger`, `RfxComTransceiver.ts`), jamais une confirmation que le récepteur cible a réellement exécuté la commande. Un récepteur hors de portée RF, ou une pile déchargée sur un émetteur intermédiaire, resterait donc silencieusement non détecté.
- **Statut** : Corrigé (cas transceiver débranché, 10/08/2026) — limitation RF de bout en bout restante, acceptée pour l'instant.
- **Priorité** : Haute (fausse confiance dans le pipeline IA/planificateur — un ordre peut sembler exécuté sans l'être)

### 🟡 IA : changement de paramètres non appliqué immédiatement
- **Constat utilisateur (10/08/2026)** : modifier les paramètres de l'application `ia` (formulaire générique "Paramètres du Module", comme pour les autres apps) ne les applique pas tout de suite — comportement à vérifier contre les autres apps (NOMMAGE a eu un bug similaire, corrigé, voir plus bas dans ce fichier : `app:module:config:saved` jamais écouté par `saveConfig()`).
- **Piste probable, à vérifier** : `applications/ia` n'écoute peut-être pas `app:module:config:saved` (chemin réellement emprunté par le formulaire générique) ou n'a pas de logique de rechargement à chaud équivalente à `reloadConfigAndReconnectMqtt()` de NOMMAGE — reste à confirmer en lisant `IaService`/le point d'entrée du module avant de corriger.
- **Statut** : Non traité — remonté par l'utilisateur, cause pas encore investiguée
- **Priorité** : Moyenne (gêne les tests IA prévus prochainement, contournement possible par redémarrage complet en attendant)

### 🟢 Voyant MQTT sur le tableau de bord + Uptime figé à "0s" — Corrigé
- **Demande utilisateur (07/08/2026)** : un voyant "MQTT connecté" équivalent au voyant "Web-Services" (HA WebSocket) existant, sur l'écran principal HA/MQTT.
- **Constat en creusant** : `mqtt:connected`/`mqtt:disconnected` étaient déjà déclarés dans `SOCLE_SOCKET_EVENTS` (`types/events.ts`) mais **jamais émis nulle part** — infrastructure morte, même symptôme que `--plan-scale` dans HAPLAN plus tôt cette session. `HaMqttIntegrationService` suit déjà les connexions/déconnexions **par bridge** (un par application métier), sans statut agrégé unique.
- **Fait** : `IntegrationBridge.updateAggregateMqttStatus()` dérive un statut agrégé (au moins un bridge connecté) à partir des transitions déjà suivies par bridge, et émet `mqtt:connected`/`mqtt:disconnected` sur transition uniquement. Nouveau store Alpine `mqtt` (`vendor/alpine.js`, même mécanisme que `ws`), nouveau voyant dans `Sidebar.ts`.
- **Deuxième bug découvert en vérifiant en direct** : l'Uptime restait figé à "0s" — signalé par l'utilisateur au même moment (*"quant au uptime, il ne sert a rien car il reste à 0"*). Cause : `app:started` (émis une seule fois au démarrage réel dans `index.ts`) n'était **jamais relayé à Socket.io**, absent de `SOCLE_SOCKET_EVENTS`/`persistentCoreEvents` — le handler client (`TechnicalConfigManager.ts`) n'avait donc jamais pu s'exécuter, de toute l'histoire du projet. Ajouté aux deux listes ; le payload utilise désormais `data.timestamp` (heure réelle de démarrage envoyée par le serveur) plutôt que `Date.now()` (heure de réception), l'événement étant maintenant persistant et donc rejouable bien après le démarrage réel à un client qui se connecte plus tard.
- **Vérifié en direct** après redémarrage complet du process de développement (le hot-reload de `tsx watch` ne suffisait pas à réinitialiser proprement les listeners Socket.io existants) : les deux voyants passent au vert, l'uptime s'incrémente en continu (48s → 1m 2s constaté).
- **Statut** : Corrigé (2026-08-07)
- **Priorité** : Moyenne (confort de diagnostic, rien de cassé fonctionnellement sans ces deux indicateurs)

### 🟢 Activation/désactivation d'application : remplacement du déplacement de fichier par la config — Fait
- **Contexte (07/08/2026)**, question utilisateur en creusant le piège du volume `stack_app-code` (voir entrée Docker ci-dessous) : *"pourquoi ne garde-t-il pas une trace de la version... si au lieu de déplacer, était géré dans le fichier config une liste des applications disable, l'activation ne se ferait plus simplement par la présence dans un répertoire mais par la présence dans un répertoire et par l'absence dans la liste ?"*
- **Constat** : `ApplicationManager.ts` déplaçait physiquement `applications/{app}/` ↔ `applications_désactivées/{app}/` via `fs.renameSync()` — **seule** raison documentée (`Dockerfile`) d'exiger un volume Docker nommé dédié pour `/app` (overlay2 renvoie `EXDEV` sans lui).
- **Fait** : remplacé par une liste `disabledApps` dans `data/core/config.yaml` (`ConfigService.getDisabledApps`/`setDisabledApps`) — une application désactivée reste physiquement dans `applications/`, seule sa présence dans cette liste l'empêche d'être chargée (`AppService.detectApplicationModules` filtre dessus). Plus aucun déplacement de fichier en fonctionnement normal. `migrateLegacyDisabledDir()` (`ApplicationManager`, one-shot au démarrage) rapatrie automatiquement toute application encore trouvée dans `applications_désactivées/` — sauf si le volume est recréé avant que ce code ait pu tourner au moins une fois contre l'ancien contenu (cas de `ha2` : `disabledApps: [rfxcom]` pré-rempli manuellement dans `data/core/config.yaml` pour cette transition précise, avant le redéploiement).
- **`docker/deploy-remote.sh` simplifié** : plus besoin de sauvegarder/réappliquer les applications désactivées avant de recréer le volume — cet état vit maintenant dans `data/` (bind-mount), jamais affecté par la recréation du volume.
- **Vérifié en direct sur `ha2`** : après déploiement, `rfxcom` reste physiquement dans `applications/` mais absent de "Modules détectés" (log `AppService`), `app:applications:list:result` le classe bien en désactivé.
- **Suite (07/08/2026, même jour)** : le volume nommé `stack_app-code` lui-même retiré de `Dockerfile`/`compose.yaml`/`compose.deploy.yaml` — plus aucune opération sous `/app` ne requiert de système de fichiers unique en écriture persistante à l'exécution, `/app` vit désormais dans les couches de l'image + la couche conteneur éphémère habituelle. `docker/deploy-remote.sh` simplifié à l'extrême (pull + up -d, plus de gestion de volume). Vérifié en local (build + démarrage sans aucun volume/bind-mount, HTTP 200 sur `/health`) et en direct sur `ha2` (image `0.1.7` : conteneur sain, `rfxcom` toujours absent de "Modules détectés", HA WebSocket reconnecté avec 307 entités, montages du conteneur limités à `data/`/`logs/`). L'ancien volume `stack_app-code` reste sur le disque de `ha2` (Docker ne supprime pas les volumes orphelins automatiquement) — `docker volume rm stack_app-code` à faire manuellement si l'espace disque doit être récupéré.
- **Statut** : Fait (2026-08-07)
- **Priorité** : Moyenne (fiabilité du mécanisme d'activation, simplifie le déploiement)

### 🟢 Config Technique : activer uniquement HA WebSocket échouait ("MQTT host is required") — Corrigé
- **Constat (06/08/2026)**, en direct sur `ha2` en reconnectant HA après la réinstallation suite à l'incident carte SD (voir plus bas) : `technicalConfigSchema` (`applications/core/src/types/config.ts`) exigeait `ws.host`/`ws.token`/`mqtt.host`/`mqtt.client_id` non vides dès que les sous-objets `ws`/`mqtt` étaient présents dans la charge `config:save` — indépendamment de `ws_enable`/`mqtt_enable`. Le client (`TechnicalConfigManager.ts`) envoie toujours les deux sous-objets complets, même quand une seule section vient d'être éditée (l'autre reste à ses valeurs par défaut, ex: `mqtt.host: ''`). Résultat : sauvegarder uniquement HA WebSocket (MQTT resté désactivé et vierge) échouait avec "MQTT host is required".
- **Corrigé** : `haConfigSchema` assouplit `ws`/`mqtt` (`.partial()`) et applique la vraie contrainte (host/token non vides) via `superRefine`, uniquement si le flag `_enable` correspondant est actif. Vérifié : build propre, 12 échecs de tests pré-existants inchangés (aucune régression), comportement confirmé en direct sur `ha2`.
- **Statut** : Corrigé (2026-08-06)
- **Priorité** : Était Haute (bloquait toute reconfiguration HA sur une instance fraîchement réinstallée) — résolu

### 🟢 HAPLAN : titres de fenêtre affichant l'entity_id brut pour les entités HA natives — Corrigé
- **Constat (06/08/2026)**, remonté par l'utilisateur sur `ha2` : le titre des fenêtres contextuelles HAPLAN affichait `light.chambre_de_jo_chevets_l2` brut au lieu d'un nom lisible. Cause première : HA WebSocket/MQTT n'avait jamais été reconfiguré après la réinstallation post-incident carte SD (`ws_enable: false`, voir aussi le correctif de validation ci-dessus qui bloquait la sauvegarde) — sans référentiel HA peuplé, `DataService` n'a aucun état pour l'entité, retombe tout en bas de la chaîne de repli (`getTaxonomyDisplayName` → `getNameEntity` → `entity_id`).
- **Deuxième cause, distincte, découverte en creusant une fois HA reconnecté** : `TaxonomyHaClassifier` (taxonomie virtuelle pour toute entité non publiée par nos propres intégrations MQTT — la majorité des entités HA natives, dont Zigbee2MQTT) utilisait l'`area_id` brut comme `lieu_principal` (`"chambre_de_jo"` au lieu de `"Chambre de jo"`) et ne renseignait jamais `lieu_precis` — donnant un titre du type "Lumière Chambre_de_jo" plutôt qu'un nom complet. `HaStructureRegistry.initialize()` attachait aussi `entity.device`/`entity.area` **après** l'appel au classifieur, les rendant inutilisables à ce moment-là.
- **Corrigé** : attachement `device`/`area` réordonné avant `classify()` ; `lieu_principal` utilise désormais `entity.area?.name` (repli sur `area_id` brut si absent) ; `lieu_precis` est reconstitué depuis `device.name` — sur les entités HA modernes "has_entity_name" (norme récente MQTT), `friendly_name` = `{device.name} {nom propre entité}` (observé en direct : `"-chevets"` + `"L2"` = `"-chevets L2"`, device.name lui-même hérité d'un renommage en masse antérieur d'où le tiret de tête nettoyé au passage).
- **Vérifié en direct** sur `ha2` : titre passé de `light.chambre_de_jo_chevets_l2` brut → `"Lumière Chambre_de_jo"` (premier correctif seul) → à valider avec le deuxième correctif une fois l'image 0.1.5 déployée.
- **Non traité, limitation acceptée** : `lieu_precis` reste `null` si `friendly_name` ne suit pas exactement le format `{device.name} {suffixe}` (entité avec nom personnalisé sans rapport avec le device, ou sans device du tout) — repli conservateur plutôt qu'une déduction hasardeuse.
- **Statut** : Corrigé (2026-08-06)
- **Priorité** : Était Moyenne (cosmétique, mais gênant sur un plan destiné à un usage quotidien) — résolu

### 🟢 Crash au démarrage (crash-loop) sur un champ YAML laissé vide — Corrigé
- **Entrée ajoutée rétroactivement (04/08/2026)** : ce correctif a été commité (`8e4217d`, 04/08/2026 16:06) sans jamais être journalisé ici ni dans les specs — seul le message de commit git en gardait la trace, repéré lors d'une session de vérification des specs.
- **Problème** : `deepMerge` (`applications/core/src/infrastructure/config/loader.ts`) laissait une valeur YAML explicitement `null` (ex: `token:` laissé vide en éditant `config.yaml` à la main avant le premier démarrage — YAML parse ça en `null`, pas en `""`) écraser silencieusement la valeur par défaut au lieu d'être traitée comme "non fournie". Zod rejetait ensuite ce `null` avec une erreur de type confuse (`Expected string, received null`) plutôt que le message habituel "Token requis" — dans un conteneur Docker (`restart: unless-stopped`), ce crash provoquait une boucle de redémarrage silencieuse, sans message d'erreur exploitable sans consulter les logs.
- **Corrigé (04/08/2026)** : `deepMerge` traite désormais `null` comme `undefined` (repli sur la valeur par défaut) — aucun champ du schéma n'accepte `null`. Deux tests de régression ajoutés : un champ isolé à `null` retombe sur le défaut (et échoue proprement à la validation), une section `ws` entièrement à `null` désactivée démarre normalement.
- **Documenté dans les specs** : `techniques-socle-ha-mqtt_specs_v4.23.md` §7.5.
- **Statut** : Corrigé (2026-08-04)
- **Priorité** : Était Haute (crash-loop) — résolu

### 🟢 Chaque dashboard ouvrait sa propre connexion Socket.io au lieu de réutiliser celle du core — Corrigé
- **Demande utilisateur (2026-07-24)**, explicitement "très prioritaire" : n'utiliser qu'une seule connexion Socket.io ; sinon expliquer pourquoi ce n'est pas possible.
- **Constat** : le core initialise une connexion unique et l'expose sur `window.app.socketService` (`applications/core/src/presentation/ui/ts/app.ts`). Mais **7 dashboards**, injectés dans le **même** `window`/Shadow DOM via `ModuleContainer` (pas une navigation réelle) — `arbreouquoi`, `nommage`, `evoo7`, `ia`, `arexx`, `rfxcom`, `planificateur` (`presentation/ts/app.ts` de chacun) — créaient chacun leur propre `new SocketService(); socket.connect()`, un pattern copié-collé sans raison technique. C'est directement ce qui alimentait le bug `ModuleContainer` ci-dessous : chaque exécution du script ouvrait une nouvelle connexion, qui déclenchait un nouveau rejeu des événements persistants côté serveur (`app:modules:list` etc., "rejoués à chaque connexion" — commentaire de `ModuleManager.ts:60-64`), pouvant redéclencher une nouvelle exécution.
- **Exception légitime, non touchée** : 4 pages dédiées (`evoo7/config-app.ts`, `rfxcom/config-app.ts`, `planificateur/config-app.ts`, `arexx/config-app.ts`) sont de vraies navigations de page complète (URL différente, document/`window` du navigateur entièrement séparé) — **impossible** techniquement de partager une connexion Socket.io à travers une vraie navigation (limite du navigateur, pas un choix d'architecture). Elles gardent chacune leur propre connexion.
- **Effet de bord positif identifié en creusant** : sans fermeture explicite (`ModuleContainer.ts` n'a aucun `disconnectedCallback`/logique de déconnexion), les connexions des dashboards s'accumulaient aussi simplement en naviguant d'une app à l'autre dans une même session — pas seulement via la course déjà documentée. Résolu de fait par la connexion unique.
- **Correctif** : les 7 dashboards réutilisent désormais `window.app.socketService` (`.getSocket()` pour ceux qui utilisaient le socket brut, l'instance `SocketService` directement pour `arbreouquoi` qui utilisait déjà ses méthodes wrapper). Comme la connexion est déjà établie au moment où ces scripts s'exécutent (jamais un `'connect'` frais), la logique de demande de données initiale a dû être adaptée : `arbreouquoi` factorise son handler `'connect'` et l'invoque aussi immédiatement si `socket.isConnected()` ; les 6 autres appelaient déjà leur requête initiale hors du handler `'connect'`, sans changement nécessaire. Un `global.d.ts` par app déclare le type minimal de `window.app.socketService` (créé pour `ia`/`planificateur`, qui n'en avaient pas).
- **Vérifié en direct** : `arbreouquoi` et `nommage` rechargés proprement, statuts "Connecté" corrects, aucune erreur console, build propre (backend + UI) sur les 7 apps et sur `core`.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était très prioritaire (demande explicite) — résolu

### 🟢 `MqttTransport.publish()` lève une exception synchrone sur déconnexion transitoire — fait planter tout le process — Corrigé
- **Constaté en direct (2026-07-24)**, pendant une session de tests navigateur sans rapport (vérification d'un correctif ArbreOuQuoi) : le serveur entier s'est arrêté brutalement, `curl` sur `:8080` refusait la connexion juste après.
- **Cause racine** (log `Uncaught Exception`) : le broker EVOO7 a flappé (connexions/déconnexions répétées en boucle, visibles juste avant dans les logs — `Bridge déconnecté: arexx:arexx_bridge_0001 (Client went offline)` / `(Connection closed by broker)`, plusieurs fois en quelques millisecondes). Pendant une fenêtre où le client MQTT du bridge était déconnecté, `Evoo7Service.handleEvoo7Message()` a reçu un message et tenté de relayer l'état vers HA via `HaMqttIntegrationService.publishState()` → `stateCommand.ts::publishState()` → `MqttTransport.publish()` (`applications/core/src/infrastructure/transport/MqttTransport.ts:131-135`), qui **levait une exception synchrone** (`throw new Error('Cannot publish: MQTT client is not connected')`) au lieu de gérer ce cas (déconnexion transitoire attendue, pas une erreur de programmation).
- **Pourquoi ça plantait tout le process** : la pile d'appel complète (`IntegrationBridge` → `EventBus.emitGeneric` → listener) est **100% synchrone**, sans aucun `try/catch` à aucun niveau. Le `throw` remontait donc jusqu'au callback `'message'` du client MQTT brut d'EVOO7 (`Evoo7MqttClient.ts`), déclenché par la librairie `mqtt` dans son propre event loop — un throw non intercepté à ce niveau devient une exception non capturée au niveau du process Node entier, qui tuait **toutes** les applications, pas seulement EVOO7.
- **Portée** : n'importe quel module d'intégration (EVOO7, RFXCOM, NOMMAGE, AREXX) publiant un état pendant une micro-fenêtre de déconnexion du bridge HA MQTT pouvait déclencher le même crash — pas spécifique à EVOO7.
- **Corrigé (2026-08-03)**, demande explicite de l'utilisateur ("avec une file d'attente de courte durée") :
  - `MqttTransport.publish()` : hors connexion, le message est mis en file d'attente (`pendingPublishes`, FIFO borné à 200 messages, expiration 30s) au lieu de lever. Rejouée dans l'ordre à la reconnexion (`handleConnect`) ; tout message plus vieux que 30s à ce moment-là est abandonné (avertissement journalisé) plutôt que republié avec une valeur potentiellement périmée. Au-delà de 200 messages en attente, le plus ancien est sacrifié pour faire de la place au plus récent.
  - `MqttTransport.subscribe()` : ne lève plus non plus — l'abonnement est mémorisé (`activeSubscriptions`) et réappliqué à **chaque** reconnexion (pas seulement la première tentative après la déconnexion).
  - **Défaut latent distinct découvert en implémentant ce correctif** : `scheduleReconnect()` recrée un client `mqtt.MqttClient` entièrement nouveau à chaque tentative de reconnexion (pas une reconnexion interne de la bibliothèque sur le même client) — sans le mécanisme de réabonnement ci-dessus, **toute réception de commande HA→app cessait silencieusement et définitivement de fonctionner après la moindre coupure MQTT**, jamais rapporté ni documenté avant ce chantier. Corrigé par le même mécanisme.
  - `MqttTransport` accepte désormais un `Logger` optionnel en second paramètre du constructeur (module `ha:mqtt:transport`), pour journaliser mises en attente/réémissions/réabonnements — silencieux sans lui. Seul appelant existant (`HaMqttIntegrationService.connectBridge`) mis à jour en conséquence.
  - Aucune méthode de `MqttTransport` ne lève plus désormais pour une raison de connexion.
- **Vérifié** : build propre (`applications/core`), suite de tests inchangée (mêmes 12 échecs préexistants sans rapport — `HaStructureRegistry`/`stateCommand`, confirmés déjà présents avant ce correctif via `git stash`), aucune régression introduite.
- **Détail complet** : voir `techniques-socle-ha-mqtt_specs_v4.20.md` §8.5.2.
- **Statut** : Corrigé (2026-08-03)
- **Priorité** : Était Haute — résolu

### 🟢 ModuleContainer : `loadModuleContent` s'exécute plusieurs fois pour une seule navigation — Corrigé
- **Rappel** : voir l'entrée détaillée plus bas dans "Problèmes secondaires" (section ArbreOuQuoi/dashboards) pour le diagnostic complet.
- **Correctif (2026-07-24)** : verrou par `moduleId` dans `ModuleContainer.ts` (`moduleLoading: Partial<Record<string, Promise<void>>>`) — un appel à `loadModuleContent()` alors qu'un chargement est déjà en cours pour ce module attend désormais la même Promise au lieu de lancer son propre `fetch()`/`innerHTML`/`executeScripts()`. Les événements dupliqués (`module:activated`/`modules:loaded`) continuent de se produire (cause non traitée, cosmétique), mais un seul chargement réel a lieu.
- **Vérifié en direct** : logs confirmant `loadModuleContent` toujours appelée 2 fois mais un seul `Fetch URL`/`Réponse reçue` ; bouton bascule OÙ/QUOI d'ArbreOuQuoi fonctionnel sur navigation fraîche (persistance confirmée dans `data/arbreouquoi/config.yaml`) ; Nommage se charge sans erreur console.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Haute — résolu

### 🟢 Nommage : `discoveryTopics` d'une source ignore son `topicPrefix` — abonnement aux mauvais topics MQTT — Corrigé
- **Problème**, trouvé en direct (2026-07-23) en testant le nouveau champ `array` "Sources" : après avoir ajouté une source `zigbee` (`topicPrefix: 'homeassist'`, broker `192.168.1.53` — réellement joignable), le service s'est abonné à **`ha/+/+/config`, `homeassistant/+/+/config`, `homeassistant/+/+/discovery`** (`NommageMqttIntegrationService`, log `[zigbee] Abonné à ...`) — les 3 topics par défaut du schéma (`sourceMqttConfigSchema`), au lieu d'un topic dérivé de `topicPrefix` (attendu : un seul topic, `homeassist/+/+/config`).
- **Cause racine** : `discoveryTopics` a été **volontairement exclu** des `itemFields` du champ `array` générique construit à l'Étape 4 (tableau imbriqué non supporté par ce mécanisme, voir commentaire dans `applications/nommage/src/domain/index.ts`). Résultat : une source ajoutée via l'UI retombe systématiquement sur le défaut du schéma pour `discoveryTopics`, sans lien avec le `topicPrefix` réellement saisi.
- **Conséquence concrète observée** : le broker `192.168.1.53` étant un vrai broker joignable, l'abonnement aux mauvais topics a fait affluer des centaines de messages de découverte non pertinents en quelques secondes (612 messages parsés, avalanche d'événements `nommage:status`/`nommage:taxonomy:structure` — a nécessité l'arrêt du serveur).
- **Aggravation constatée (2026-07-23, session suivante)** : au redémarrage du serveur pour un autre chantier (nouvelle application AREXX), le même abonnement erroné a cette fois fait **planter le process entier** (`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`) — le broker `192.168.1.53` livrant apparemment plus de messages retained qu'au premier constat. Contournement manuel temporaire appliqué (`discoveryTopics` figé dans `data/config.yaml`), remplacé depuis par le vrai correctif ci-dessous.
- **Corrigé (2026-07-24)** : `discoveryTopics` (`sourceMqttConfigSchema`, `applications/nommage/src/domain/config-schema.ts`) est maintenant **toujours recalculé** à partir de `topicPrefix` via un `.transform()` Zod, quelle que soit la valeur soumise par le client — plus de défaut fixe, plus de dépendance à un champ jamais exposé dans le formulaire `array`. Génère **deux patterns bornés** reflétant le format officiel de découverte MQTT HA (`<prefix>/<component>/[<node_id>/]<object_id>/config`, `node_id` optionnel) : `${prefix}/+/+/config` et `${prefix}/+/+/+/config` — pas un catch-all (`prefix/#`), qui réintroduirait le risque d'afflux déjà rencontré. `NommageService.loadConfig()` re-parse `nommageConfigSchema` à chaque démarrage, donc l'auto-correction s'applique aussi rétroactivement à toute configuration déjà sur disque, sans action manuelle. Vérifié en direct : `[zigbee] Abonné à homeassist/+/+/config` et `.../+/+/+/config` (topicPrefix `"homeassist"`, sans `/` final, correctement normalisé), plus besoin du contournement manuel dans `data/config.yaml`.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Haute — résolu

### 🟢 Nommage : la sauvegarde via le formulaire générique ne reconnectait pas les MQTT — Corrigé (+ bug de double-traitement des événements du socle découvert et corrigé au passage)
- **Demande utilisateur (2026-08-04)** : vérifier que changer les paramètres de Nommage arrête bien les connexions MQTT et les relance avec les nouveaux paramètres.
- **Constat (tracé en direct)** : non, ça ne le faisait pas. Nommage n'a pas d'UI de configuration dédiée — il utilise le formulaire générique "Paramètres du Module" du core, qui sauvegarde via `app:modules:config:save` → `AppService.handleModuleConfigSave()` → `ConfigService.saveModuleConfig()`, lequel **valide et écrit sur disque uniquement**, sans jamais émettre `nommage:config:save` — le seul événement écouté par `NommageService.saveConfig()` (`NommageService.ts:533-560`), qui est la méthode faisant réellement `configProvider.savePartialConfig()` → `mqttService.disconnect()` → `mqttService.connect()`. Résultat : les connexions MQTT en cours continuaient de tourner avec les anciens paramètres jusqu'au redémarrage complet de l'application — seul le fichier était à jour.
- **Correctif implémenté (2026-08-04), demande explicite ("oui corrige")** : nouveau listener dans `NommageService.setupEventListeners()` sur `app:module:config:saved` (déjà émis par `AppService.handleModuleConfigSave`, jusque-là jamais consommé par Nommage) — filtre sur `moduleId === 'nommage' && success`, puis recharge la config et reconnecte les MQTT via une nouvelle méthode `reloadConfigAndReconnectMqtt()` (factorisée hors de `saveConfig()`, réutilisée par les deux chemins). **Codé et compile, mais non committé** — modification actuellement non stagée dans `NommageService.ts`.
- **Bug distinct découvert en vérifiant ce correctif en direct** : côté serveur, l'événement `app:modules:config:save` est traité **deux fois** à chaque sauvegarde (confirmé dans les logs de test — session précédente, investigation coupée net avant conclusion, contexte migration `ws-ha` → `dimotic-ha`).
- **Cause racine confirmée (2026-08-04), en relançant l'investigation en direct** (serveur `dev:local` + script `socket.io-client` reproduisant exactement une sauvegarde du formulaire générique, logs `SocketBridge`/`AppService` observés) : `AppService.registerCoreSocketEvents()` (`AppService.ts:484-488`) enregistre `appId: 'core'` auprès de `SocketBridge` avec `socketEvents: SOCLE_SOCKET_EVENTS` — **l'objet entier**, alors que `SOCLE_SOCKET_EVENTS` (`types/events.ts:205-229`) mélange des événements Server→Client (`APP_STATUS`, `MODULES_LIST`, ...) **et** Client→Server (`CONFIG_GET`, `CONFIG_SAVE`, `CONFIG_VALIDATE`, `LOGS_GET`, `HA_STRUCTURE_GET`, `HA_COMMAND_SEND`, `MODULES_CONFIG_GET`, `MODULES_CONFIG_SAVE`). `SocketBridge.setupDynamicAppHandlers()` câble un `socket.on(eventName, ...)` pour **chaque** événement de **chaque** application enregistrée, sans exception pour le "core" — il ajoute donc un **second** `socket.on(...)` pour ces 8 événements Client→Server, en plus des handlers déjà codés en dur dans `SocketBridge.setupSocketIOHandlers()` (ex: `app:modules:config:get`/`save` lignes 287-298, `logs:get` ligne 280). Résultat : **chaque** émission client de l'un de ces 8 événements déclenche deux `socket.on(...)` sur le même socket, donc deux `eventBus.emit`/`emitGeneric`, donc le handler métier correspondant s'exécute deux fois — pas seulement `app:modules:config:save` (repéré via Nommage), mais potentiellement aussi `config:get`/`config:save`/`config:validate` (Paramètres Techniques, sections statiques), `logs:get`, `ha:structure:get`, et surtout **`ha:command:send`** (commande envoyée à Home Assistant depuis l'UI — portée fonctionnelle plus large qu'un simple bug d'affichage, à vérifier au cas par cas selon idempotence de chaque commande HA).
- **Vérifié en direct (2026-08-04)** : script de test reproduisant `app:modules:config:get` puis `app:modules:config:save` sur Nommage — logs confirmant deux `Socket.io → EventBus: app:modules:config:get` et deux `Broadcast app:module:config` pour un seul `get` envoyé ; de même deux `Traitement de app:modules:config:save` par `AppService` pour un seul `save` envoyé.
- **Corrigé (2026-08-04)** : `SOCLE_SOCKET_EVENTS` (`types/events.ts`) scindé en deux constantes, sur le même modèle que `NOMMAGE_SOCKET_EVENTS`/`NOMMAGE_CLIENT_EVENTS` — `SOCLE_SOCKET_EVENTS` ne contient plus que les 12 événements Server→Client, `SOCLE_CLIENT_EVENTS` (nouveau) regroupe les 8 événements Client→Server déjà câblés en dur dans `SocketBridge.setupSocketIOHandlers()` et n'est **jamais** transmis à `registerAppSocketEvents('core', ...)` — `AppService.registerCoreSocketEvents()` n'avait pas besoin de changer, il référence déjà uniquement `SOCLE_SOCKET_EVENTS`, correctement recentré par ce changement de définition.
- **Vérifié en direct (2026-08-04)**, serveur `dev:local` relancé à neuf : script de test rejouant un `app:modules:config:get`/`save` unique sur Nommage → un seul `Socket.io → EventBus: app:modules:config:get`, un seul `Traitement de app:modules:config:save`, un seul `Configuration rechargée, connexions MQTT reconfigurées` (donc plus de reconnexion MQTT en double). Deuxième test indépendant sur `logs:get` (événement du socle non lié à Nommage) → un seul traitement également, confirmant que le correctif est général et pas spécifique à Nommage. Build (`tsc`) et suite de tests (`vitest`) propres après le changement — mêmes 12 échecs préexistants (`HaStructureRegistry`), 133 passés, aucune régression.
- **Statut** : Corrigé (2026-08-04) — double-traitement des 8 événements du socle (dont `app:modules:config:get/save`, `config:get/save/validate`, `logs:get`, `ha:structure:get`, `ha:command:send`) + correctif de reconnexion MQTT Nommage, les deux vérifiés en direct et committés (`452b5b9`, `a462f2a`)
- **Priorité** : Était Haute — résolu, en attente de commit

### 🟢 Nommage : statut de connexion affiché incohérent avec l'état réel des sources — Corrigé (boutons)
- **Problème**, observé en direct (2026-07-23) juste après le bug ci-dessus : l'écran affiche "Statut de connexion : Déconnecté" en haut, alors que la liste des connexions par source affiche "zigbee : connecté" — et le log serveur confirme bien `[zigbee] Connecté au broker MQTT avec succès`. Le bouton "Rafraîchir le statut" n'a aucun effet visible. Le bouton "Voir la taxonomie" n'affiche rien.
- **Cause racine trouvée (2026-07-24)** : `applications/nommage/src/presentation/index.html` appelle les boutons via `onclick="refreshStatus()"`/`onclick="getTaxonomy()"` — des attributs inline qui résolvent contre `window.refreshStatus`/`window.getTaxonomy` directement. Mais `app.ts` n'exportait que `window.nommageApp = {init, refreshStatus, getTaxonomy}` (objet imbriqué), jamais les fonctions à plat sur `window` — chaque clic levait donc une `ReferenceError` silencieuse (piège déjà rencontré et corrigé côté `ia`, qui exporte bien les deux formes). Confirmé en direct : après correctif, aucune `ReferenceError` en console au clic sur les deux boutons.
- **Correctif** : ajout de `window.refreshStatus = refreshStatus;` et `window.getTaxonomy = getTaxonomy;` en plus de `window.nommageApp`. Suppression au passage d'un abonnement dupliqué à `nommage:status` (deux `socket.on('nommage:status', ...)` distincts appelaient chacun `updateStatusDisplay` sur le même payload — inoffensif mais source de confusion lors de l'investigation).
- **Non résolu / à re-tester** : l'incohérence *initiale* rapportée (badge du haut "Déconnecté" pendant que "zigbee" affichait "Connecté") n'a pas pu être reproduite avec une seule source active — le calcul serveur (`mqttConnected = connectedSources.size > 0`) et l'affichage semblent corrects à la relecture. Reste à confirmer en conditions réelles avec au moins 2 sources (dont une déconnectée) que le badge global et la liste par source restent synchronisés.
- **Statut** : Corrigé (boutons Rafraîchir/Voir la taxonomie) — incohérence d'affichage initiale à reconfirmer avec plusieurs sources
- **Priorité** : Moyenne

### 🟢 Le formulaire générique de config module ne valide rien côté serveur — peut écrire des données qui font planter un module au redémarrage — Corrigé
- **Problème**, constaté en direct sur Nommage (2026-07-23) : `ConfigService.saveModuleConfig()` (`applications/core/src/infrastructure/config/ConfigService.ts:205-219`), utilisé par le formulaire générique "Paramètres Techniques" (`app:modules:config:save`), fusionne et écrit sur disque **n'importe quelle forme de données pour un module, sans passer par son schéma Zod** (`nommageConfigSchema`, `evoo7ConfigSchema`, etc.). Une manipulation du champ `array` "Sources" de Nommage (suppression puis ajout d'une source) a laissé une entrée avec `id: ''` — invalide au regard de `nommageSourceSchema` (`id: z.string().min(1)`, `config-schema.ts:51`) — et le serveur a quand même répondu `success:true`, persistant l'entrée invalide dans `data/config.yaml`.
- **Pourquoi c'était grave** : chaque module recharge sa config au démarrage via un `.parse()` Zod **strict, qui lève une exception** en cas d'invalidité (`NommageService.loadConfig()`, `NommageService.ts:104`, même pattern probable pour EVOO7/RFXCOM). Le service en cours d'exécution n'était pas affecté immédiatement (le formulaire générique ne le notifiait jamais), mais **au prochain redémarrage du serveur, le module concerné plantait au démarrage**, sans qu'aucun avertissement n'ait été donné au moment de la sauvegarde invalide.
- **Corrigé en urgence en direct (2026-07-23)** : l'entrée `id: ''` retirée via l'UI (nouvelle sauvegarde valide) — contournement, cause racine non corrigée à ce stade.
- **Corrigé (2026-07-24)** :
  - `AppService` détecte désormais le schéma Zod exporté par chaque module (convention `{moduleId}ConfigSchema`, ex: `nommageConfigSchema`, déjà suivie par toutes les apps) au chargement, et l'enregistre via `ConfigService.registerModuleSchema()`.
  - `ConfigService.saveModuleConfig()` valide contre ce schéma avant toute écriture disque — renvoie `{success:false, error}` avec le détail Zod si invalide, au lieu du `success:true` optimiste précédent. Sans schéma enregistré pour un module (cas non attendu vu la convention), la sauvegarde procède sans validation dédiée (comportement antérieur, pas de régression).
  - Persiste la **sortie** de Zod (`validation.data`), pas la donnée brute soumise par le client — nécessaire pour que les `.transform()` de normalisation (ex: `discoveryTopics` de Nommage, voir entrée dédiée) s'appliquent réellement à ce qui est écrit sur disque.
- **Vérifié** : build propre sur les 7 apps (core, rfxcom, evoo7, arbreouquoi, arexx, ia, planificateur), aucune régression au démarrage réel.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Haute — résolu

### 🟡 Pages dédiées evoo7/rfxcom (Paramétrage & Données / Devices & Récepteurs) injoignables — Corrigé
- **Problème** : `menu.entry.path` et l'entrée `pages[]` "config" pointaient tous les deux vers `/evoo7/config`/`/rfxcom/config` — un chemin interne (jamais une vraie route servie par le serveur), et identique à `entry.path`, donc jamais rendu comme lien distinct par `Sidebar.ts` (`page.path !== entry.path`). Le seul endroit où ce lien apparaissait réellement était un `<a href="/evoo7/config">` en dur dans le tableau de bord de chaque app — un clic dessus donnait un 404. Même chantier que la migration Alpine.js (evoo7/rfxcom n'avaient pas non plus de pipeline de build navigateur pour ces pages dédiées : import `SocketService` cassé, pas de `type="module"`, et — spécifique aux pages de navigation complète, contrairement aux tableaux de bord injectés dans le Shadow DOM du core — pas de script socket.io chargé du tout, `io is not defined` au premier chargement).
- **Correctif** : chemins corrigés vers `/applications/{app}/presentation/{app}/config.html` (réellement servi), pipeline `tsconfig.ui.json` étendu pour compiler aussi `config-app.ts`, script socket.io CDN ajouté à chaque `config.html`.
- **Statut** : Corrigé (2026-07-23)
- **Priorité** : Basse (résolu)

### 🟢 Classification QUOI jamais implémentée (HaStructureRegistry) — Corrigé
- **Problème** : `HaStructureRegistry.test.ts` (11 tests) attend un classifieur qui assigne des QUOI (`eclairage`, `temperature`...) aux entités selon domaine/device_class — jamais implémenté en pratique. Confirmé par le test ET par l'instantané réel du référentiel HA (`ha-structure-debug.yaml`, toutes les `area.quoi` vides). Les tests sont corrects, c'est la fonctionnalité qui manque.
- **Corrigé (2026-07-23)**, dans le cadre de l'implémentation des applications `ia`/`planificateur` (qui en avaient besoin pour résoudre des entités par QUOI/OÙ) : nouveau `TaxonomyHaClassifier` (`applications/core/src/ha/sync/TaxonomyHaClassifier.ts`), branché à la place du stub `DefaultHaClassifier` dans `core/src/index.ts`. Priorité à `attributs_taxonomie` déjà posé par RFXCOM/AREXX/EVOO7/Nommage, repli sur domain/device_class HA sinon, avec synthèse d'une taxonomie "virtuelle" (lieu par défaut "maison") pour les entités qui n'en auront jamais.
- **Vérifié en direct** : `totalOuPaths` (ArbreOùQuoi) passé de 0 à 18 sur les 469 entités réelles. `resolved_service_call` (planificateur) confirmé fonctionnel de bout en bout grâce à cette classification (commande `homeassistant.turn_on` envoyée et reçue par HA).
- **Statut** : Corrigé (2026-07-23)

### 🟢 ArbreOuQuoi : 3 bugs révélés par le premier arbre réellement peuplé — Corrigé
- **Contexte** : avant le classifieur QUOI réel ci-dessus, `quoiGroups` était toujours vide côté serveur — ce chemin de rendu (arbre QUOI-first avec entités réelles) n'avait donc jamais été exercé. Les 3 bugs suivants, trouvés en surveillant la console navigateur en direct (2026-07-24) après le passage à 469 entités classées, étaient tous préexistants mais invisibles jusque-là.
- **1) Sérialisation Socket.io d'un `Map`** : `QuiGroupWithOu.entitiesByOu` était un `Map<string, HaStructuredEntity[]>` — un `Map` ne survit pas à la sérialisation Socket.io/JSON (devient `{}` côté client, aucun support natif dans `socket.io-parser`), plantait le rendu (`entitiesByOu.get is not a function`). **Corrigé** : remplacé par `Record<string, HaStructuredEntity[]>` (`types.ts`, `ArbreouquoiService.ts`, `app.ts`) — leçon déjà rencontrée cette session pour les références circulaires, généralisée : jamais de `Map`/`Set` dans un payload destiné au fil.
- **2) Désaccord de type client/serveur sur `HaQuoiDefinition`** : `app.ts` définissait localement `{id, name, icon?}` alors que le type réel côté serveur (`core/src/ha/types/ha-structure.ts`) est `{quoi_id, label, description?}` — plantait sur `Cannot read properties of undefined (reading 'toLowerCase')` dès qu'un vrai groupe QUOI arrivait. **Corrigé** : interface et tous les accès (`normalizeOuWithQuoi`, `normalizeQuoiFirstTree`, `renderEntity`, `renderQuoiCatalog`, détails d'entité) alignés sur les vrais noms de champs ; l'icône n'existant jamais côté serveur, toujours résolue via `getQuoiIcon(quoi_id)`.
- **3) Collision de classes CSS via `<link>` dupliqué dans le Shadow DOM** : l'arbre restait rendu (40 `<tree-node>` bien présents dans le DOM, aucune erreur console) mais visuellement invisible, poussé à ~1800px hors écran. Cause : `ModuleContainer.ts` injecte le `index.html` complet de chaque module via `innerHTML` (`container.innerHTML = ...html...`) — `arbreouquoi/index.html` liait, en plus de son propre `arbreouquoi.css`, le `/styles/main.css` de la coquille HA/MQTT (déjà chargé une fois au niveau document). Cette réinjection dupliquait `main.css` **à l'intérieur du Shadow DOM du module**, où sa règle générique `.app-container { display:flex; min-height:100vh }` (pensée pour la mise en page globale sidebar+contenu) entrait en collision avec la classe `.app-container` propre à `arbreouquoi.css` (simple wrapper `max-width`), cassant la mise en page interne du module. **Corrigé** : retiré le `<link href="/styles/main.css">` redondant de `arbreouquoi/index.html` (déjà chargé par la coquille, inutile à re-lier).
- **Portée plus large non corrigée** : les 6 autres apps (`arexx`, `evoo7`, `ia`, `nommage`, `planificateur`, `rfxcom`) lient toutes `/styles/main.css` dans leur propre `index.html` avec le même risque de collision — sans symptôme visible aujourd'hui car aucune ne réutilise encore des noms de classes génériques (`app-container`/`main-content`/...) en interne comme arbreouquoi. À traiter si l'une d'elles développe un jour une mise en page interne plus riche.
- **Vérifié en direct** : arbre QUOI-first affiché et correctement mis en page (469 entités, 18 chemins OÙ, 16 types QUOI), expansion d'un groupe (`Lumière`, 31 entités réparties par lieu) fonctionnelle, aucune erreur console.
- **Statut** : Corrigé (2026-07-24)

### 🟢 Les attributs de taxonomie n'atteignaient jamais HA (attributs_taxonomie) — Corrigé
- **Problème** : `rfxcom`/`evoo7`/`nommage` injectent tous `attributs_taxonomie` via `extra: {attributs_taxonomie: buildAttributsTaxonomie(...)}`, fusionné par `buildDiscoveryPayload()` (`applications/core/src/ha/integration/discovery.ts` ligne 77) comme clé de premier niveau dans le message de découverte MQTT (`homeassistant/{component}/{object_id}/config`). Confirmé en direct sur l'instance HA réelle (script de diagnostic jetable, `get_states` sur les 469 entités) : **aucune** n'a `attributs_taxonomie` dans ses attributs réels — HA valide le message de découverte contre un schéma strict par plateforme et ignore silencieusement les clés non reconnues. La fonctionnalité "injecter les attributs de taxonomie" (réglage `ha.injectTaxonomyAttributes` de Nommage, et l'équivalent RFXCOM/EVOO7) n'a donc jamais fonctionné, depuis le début — pas de régression récente, un problème de conception initiale.
- **Cause** : mauvais mécanisme MQTT utilisé. Le mécanisme HA officiel pour attacher des attributs libres à une entité via découverte MQTT est `json_attributes_topic` (+ `json_attributes_template` optionnel) — un champ de découverte qui indique à HA un topic à écouter, dont le JSON reçu est fusionné dans `entity.attributes`. Rien d'équivalent n'existe pour des clés glissées directement dans le message de découverte.
- **À faire** : **pas besoin d'un topic supplémentaire** — le topic d'état (`state_topic`) publie déjà `JSON.stringify({state, attributes})` (`stateCommand.ts::publishState`, `HaMqttStateMessage.attributes` déjà présent dans le type) et `value_template` extrait déjà `{{ value_json.state }}` (convention existante, `evoo7/classification.ts::buildValueTemplate`). Il suffit de : (1) faire pointer `json_attributes_topic` vers ce même `state_topic` dans `buildDiscoveryPayload()` (`discovery.ts`), avec `json_attributes_template: '{{ value_json.attributes | tojson }}'` ; (2) faire porter `attributs_taxonomie` par `HaMqttStateMessage.attributes` au moment de `publishState()`, au lieu du bloc `extra` de la découverte (qui reste utile pour les vraies clés de config reconnues par HA, mais plus pour des attributs libres).
- **Validé en direct (2026-07-22)** : test bout-en-bout sur l'instance HA réelle (device+entité MQTT créés de toutes pièces, découverte avec `json_attributes_topic` pointant vers `state_topic`, état publié avec `attributs_taxonomie` dans `attributes`, puis lu via `get_states`) — les 10 champs de taxonomie apparaissent correctement dans les attributs de l'entité. Solution confirmée fonctionnelle, nettoyé après test (rien laissé sur l'instance HA). Note en passant : l'`entity_id` réel généré par HA combine le nom du device et de l'entité (`has_entity_name`), différent de l'`object_id` fourni — sans impact sur le correctif, juste une nuance à connaître si on compare des `entity_id` en dur quelque part.
- **Implémenté (2026-07-22)** :
  - `discovery.ts` (core) : `buildDiscoveryPayload()` ajoute `json_attributes_topic`/`json_attributes_template` pointant vers le `state_topic` de l'entité, systématiquement.
  - `evoo7` (`Evoo7Service.ts`) et `rfxcom` (`RfxComService.ts` + `ReceiverSwitch`/`ReceiverLight`/`ReceiverCover`) : `attributs_taxonomie` retiré du bloc `extra` de la découverte, porté à la place par `HaMqttStateMessage.attributes` à chaque publication d'état (ils contrôlent leur propre `state_topic`, déjà en JSON `{state, attributes}`).
  - RFXCOM scène (`device_automation`) : `attributs_taxonomie` simplement retiré (pas d'équivalent possible, un déclencheur n'a pas d'entité/attributs au sens HA).
  - `nommage` (`NommageService.ts`) : cas différent — le `state_topic` relayé appartient à la source tierce (Zigbee2MQTT etc.), format hors de notre contrôle. Nouveau topic dédié que NOMMAGE possède (`getAttributesTopic()`, ajouté à `ha-mqtt.ts`), publié via le mécanisme Passthrough existant (`integration:nommage:passthrough:publish`, mode "complet"), déclaré en `json_attributes_topic` dans la découverte relayée.
  - `npm run build` propre sur les 4 packages, tests existants (`core`, seul avec une suite) : mêmes 16 échecs préexistants, aucune régression. Pas de test automatisé dans evoo7/rfxcom/nommage.
- **Statut** : Corrigé
- **Priorité** : Haute (fonctionnalité coeur de la taxonomie, jamais opérationnelle)

### 🟡 Niveau de log jamais synchronisé avec config.yaml au démarrage — Corrigé
- **Problème** : `index.ts` (`initializeDependencies()`) créait le `Logger` avec un niveau codé en dur (`'info'`), jamais lu depuis `logging.level` dans `config.yaml`. Le vrai niveau ne s'appliquait qu'après une sauvegarde de configuration (`config:reload` → `handleConfigReload()` → `logger.setLevel()`) — donc `logging.level: debug` dans le fichier au démarrage était silencieusement ignoré tant qu'aucune sauvegarde n'avait eu lieu depuis. Découvert car il bloquait silencieusement le nouveau traçage debug du référentiel HA (`HaRegistryTracer`) : aucune erreur, juste rien ne se créait.
- **Correctif** : le niveau est maintenant synchronisé juste après le chargement de la config, dès le démarrage.
- **Statut** : Corrigé (2026-07-22)

### 🟡 HaWsClient : device_registry/list lisait le mauvais champ d'identifiant — Corrigé
- **Problème** : `config/device_registry/list` (HA) renvoie l'identifiant du device dans le champ **`id`**, pas `device_id` — contrairement aux areas (`area_id`, correct) et aux entités (`device_id`/`area_id`, corrects). `HaWsClient.loadInitialRegistry()` lisait `rawDevice.device_id` (toujours `undefined`), donc `HaStructureRegistry` stockait chaque device sous la clé `undefined` — ils s'écrasaient tous mutuellement, un seul survivait (109 devices reçus → 1 seul conservé). Découvert et confirmé en direct via un script de diagnostic jetable connecté à l'instance HA réelle, en creusant l'instantané produit par `HaRegistryTracer` (voir ci-dessus).
- **Correctif** : `loadInitialRegistry()` remappe désormais `id` → `device_id` avant de retourner les devices.
- **Statut** : Corrigé (2026-07-22)

### 🟢 Tableaux de bord des apps (Applications) : scripts injectés inertes — Corrigé (4/4 apps)
- **Contexte** : `ModuleContainer.ts` injecte le `index.html` de chaque app via `innerHTML`, qui n'exécute jamais les `<script>` (comportement standard du DOM). Corrigé le 2026-07-22 en recréant les `<script>` après injection (`executeScripts()`) — combiné à la mise en place d'un vrai pipeline de build navigateur pour `arbreouquoi` (voir plus bas). Testé sur ArbreOuQuoi : toujours la coquille vide (pas d'arbre affiché), deux causes supplémentaires identifiées puis corrigées le 2026-07-23 (préalable nécessaire pour vérifier la migration Alpine.js Phase 2) :
  1. **`DOMContentLoaded` jamais déclenché** : `app.ts` attendait cet événement pour démarrer, mais le script n'est chargé que bien après le chargement initial de la page (au clic sur le module) — l'événement a déjà eu lieu, le listener ne se déclenche donc jamais. **Corrigé** : pattern `if (document.readyState === 'loading') {...} else {...}`, même parade que `nommage/config-app.ts`.
  2. **`document.getElementById` ne peut pas voir dans le Shadow DOM** : `ModuleContainer` est un composant à Shadow DOM — le `document` global d'un script d'app ne le traverse pas. **Corrigé** : `ModuleContainer.ts` expose désormais son shadow root sur `window.__moduleContainerRoot` (`connectedCallback()`) ; `arbreouquoi/app.ts` interroge ce root via un helper `$(id)` scopé (`document.getElementById(...)` remplacé partout).
- **Étendu à `evoo7`/`rfxcom`/`nommage` le jour même (commit `35da2c5`, 2026-07-23)** — même pattern (`window.__moduleContainerRoot` + `$()` + `readyState`) reproduit tel quel sur les 3 apps restantes. En vérifiant en conditions réelles, un bug backend distinct est apparu, empêchant les 3 tableaux de bord d'afficher quoi que ce soit même une fois le Shadow DOM corrigé : chaque app enregistrait seulement ses événements serveur→client (`_SOCKET_EVENTS`) auprès de `SocketBridge`, jamais `_ALL_EVENTS` (qui inclut aussi les événements client→serveur) — `setupDynamicAppHandlers()` ne câblait donc jamais les requêtes du client (`evoo7:status:get` etc.), qui n'atteignaient jamais le backend. Corrigé en même temps : les 3 `domain/index.ts` enregistrent désormais `_ALL_EVENTS`, et le rejeu du dernier statut à la reconnexion (qui comparait par erreur les clés d'événements aux valeurs réellement émises) a été aligné sur la convention déjà correcte d'ArbreOuQuoi.
- **Cette entrée TODO n'avait pas été mise à jour après le commit `35da2c5`** — trouvé et corrigé le 2026-07-24 en revérifiant en direct le tableau de bord EVOO7 (Broker EVOO7: Connecté, Bridge HA: Connecté, compteurs à jour, aucune erreur console) avant d'attaquer les items EVOO7 restants.
- **Statut** : Corrigé (2026-07-23) pour les 4 apps (arbreouquoi, evoo7, rfxcom, nommage)
- **Priorité** : Était Haute pour evoo7/rfxcom/nommage — résolu.

### 🟡 ArbreouquoiService : référence circulaire entity↔area/device faisait planter l'envoi de l'arbre — Corrigé
- **Problème** : `HaStructuredEntity.device`/`.area` (peuplés par `HaStructureRegistry`) sont des références d'objets complets, pas de simples ID — `device.entities`/`area.entities` pointent en retour vers la même entité : un graphe réellement circulaire. `ArbreouquoiService` envoyait ces entités telles quelles dans les payloads Socket.io (arbre, catalogue, détails d'entité), ce qui faisait boucler indéfiniment `socket.io-parser` (`hasBinary`, qui parcourt tout objet sans détection de cycle contrairement à `JSON.stringify`) — `RangeError: Maximum call stack size exceeded` côté serveur à chaque tentative, `arbreouquoi:tree:structure` n'atteignait donc jamais le client (seul `arbreouquoi:stats`, qui n'embarque pas les entités, passait). Découvert en vérifiant la migration Alpine.js Phase 2 en conditions réelles (469 entités, stack trace obtenue en loggant `error.stack` au lieu du seul message).
- **Correctif** : nouvelle méthode `sanitizeEntity()` qui ne garde que `{device_id, name}`/`{area_id, name}` pour `.device`/`.area`, appliquée à chaque point où des entités du référentiel sont récupérées avant d'être embarquées dans un payload (`buildOuFirstTree(Filtered)`, `buildQuoiFirstTree(Filtered)`, `emitEntityDetails`).
- **Statut** : Corrigé (2026-07-23)
- **Priorité** : Était Haute (bloquait tout affichage réel de l'arbre) — résolu.

### 🔴 ArbreouquoiService.handleConfigSave : boucle infinie corrompait data/config.yaml — Corrigé
- **Problème** : `handleConfigSave()` (déclenché par le bouton bascule OÙ/QUOI, entre autres) émettait son accusé de réception `{success: true, config: newConfig}` sur le **même** nom d'événement (`ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVE`) que celui écouté pour déclencher une sauvegarde — l'EventBus étant partagé, ce même handler se redéclenchait donc lui-même sur son propre accusé de réception, le traitant comme un nouveau `partialConfig` à fusionner (`{...currentConfig, success: true, config: newConfig}`), qui ré-émettait à son tour un accusé de réception, etc. Boucle infinie, une imbrication `.config.config.config...` de plus par itération, jusqu'à dépassement de la profondeur YAML max (100) — **`data/config.yaml` corrompu** (6778 lignes, 3,6 Mo, le serveur ne démarrait plus : `Invalid YAML... nesting exceeded maxDepth`). Découvert en vérifiant la migration Alpine.js Phase 2 (les clics de test sur le bouton bascule ont déclenché la boucle).
- **Correctif** : nouvel événement distinct `ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVED` (`arbreouquoi:config:saved`) pour l'accusé de réception, séparé de `CONFIG_SAVE` (la demande) — plus de rebouclage. `data/config.yaml` réparé manuellement (sauvegarde du fichier corrompu dans `backups/data/`, reconstruction de la section `arbreouquoi` à partir des valeurs cohérentes trouvées au premier niveau d'imbrication, le reste du fichier — `ha`/`web`/`logging`/`evoo7`/`nommage`/`rfxcom` — intact et non affecté).
- **Effet de bord découvert en testant le correctif** (non corrigé, distinct) : `newConfig = {...currentConfig, ...partialConfig}` fait une fusion **superficielle** — un `partialConfig.display` partiel (ex: `{viewMode: ...}` seul) remplace tout `currentConfig.display` au lieu de le fusionner en profondeur, perdant les autres champs (`showEntityIds`/`showQuoiIcons`/`theme`) à chaque sauvegarde partielle. À corriger séparément si besoin (fusion profonde comme le fait déjà `TechnicalConfigManager.mergeDeep` côté navigateur, core).
- **Statut** : Corrigé (2026-07-23) pour la boucle infinie — la fusion superficielle reste un problème mineur distinct, non corrigé.
- **Priorité** : Était Critique (corruption de données réelles) — résolu.

### 🟢 Libellé du bouton bascule OÙ/QUOI jamais mis à jour après le premier rendu — Corrigé
- **Problème** : `updateViewModeButton()` (arbreouquoi/app.ts) n'est appelée qu'une fois dans `initUI()` — ni après un clic sur le bouton lui-même, ni après réception d'un nouvel arbre (`TREE_STRUCTURE`, qui porte pourtant `payload.viewMode` à jour). Le texte du bouton reste figé sur son état initial même quand le mode bascule réellement (l'arbre affiché, lui, change bien). Préexistant, découvert en vérifiant la migration Alpine.js Phase 2 (non lié à Alpine — la logique de rendu de l'arbre elle-même bascule correctement).
- **Correctif (2026-07-24)** : ajout de `updateViewModeButton()` dans le handler `TREE_STRUCTURE` (juste après `state.viewMode = payload.viewMode`) et dans le handler de clic du bouton (juste après la mise à jour optimiste de `state.viewMode`).
- **Vérifié en direct** : après un rechargement complet de page (pour repartir d'un état d'exécution propre du script — voir le bug distinct découvert ci-dessous), le bouton affiche bien le libellé initial par défaut ("Passer en mode QUOI → OÙ") puis se corrige automatiquement dès réception de `TREE_STRUCTURE` pour refléter le vrai mode serveur persisté ("Passer en mode OÙ → QUOI", car `data/arbreouquoi/config.yaml` avait `viewMode: quoi-first`).
- **Statut** : Corrigé
- **Priorité** : Était Basse — résolu

### 🟢 ModuleContainer : `loadModuleContent` s'exécute plusieurs fois pour une seule navigation — écouteurs de clic morts après la 1ère visite d'un module dans l'onglet — Corrigé
- **Découvert par accident (2026-07-24)** en vérifiant le correctif ci-dessus : sur l'onglet navigateur utilisé pendant toute cette session (déjà naviguée vers `arbreouquoi` bien plus tôt), cliquer sur N'IMPORTE QUEL bouton du dashboard (Rafraîchir, bascule OÙ/QUOI) ne déclenchait plus AUCUN événement Socket.io — confirmé en patchant `Socket.prototype.emit` pour tracer tous les émissions `arbreouquoi:*` : liste vide après clic, alors qu'un `addEventListener` de test ajouté directement sur le même nœud DOM se déclenche bien lui.
- **Cause racine identifiée** : `applications/core/src/presentation/ui/ts/components/ModuleContainer.ts::loadModuleContent()` s'est exécuté **3 fois** pour une seule navigation vers `arbreouquoi` (confirmé via les logs console horodatés à la même seconde) — `window.addEventListener('module:activated', ...)`/`'modules:loaded'` semblent s'accumuler en doublons dans `setupEventListeners()` (appelée depuis `connectedCallback()`, qui peut se redéclencher si l'élément est détaché/rattaché au DOM). Chaque exécution refait un `fetch` + `container.innerHTML = ...` + `executeScripts()` qui **recrée entièrement** les nœuds DOM (boutons compris) et recrée une nouvelle instance du module `app.ts` (donc une nouvelle connexion Socket.io, un nouveau `state` local, de nouveaux écouteurs). La DERNIÈRE exécution gagne pour l'affichage visible, mais rien ne garantit qu'elle correspond à l'instance dont les écouteurs sont réellement attachés aux nœuds DOM finaux — d'où des clics qui ne déclenchent plus rien.
- **Repli déjà en place mais insuffisant** : le chemin "déjà chargé" (`moduleContents[moduleId]` + `moduleInited[moduleId]`) réutilise le HTML en cache SANS rejouer `executeScripts()` (commentaire explicite : éviter de rappeler `customElements.define()`) — correct en théorie pour une vraie 2e visite, mais si une exécution "premier chargement" concurrente est aussi en vol au même moment, le résultat final observé est un mélange imprévisible des deux chemins.
- **Impact** : après un premier passage sur un module dans un onglet donné, les boutons de son dashboard peuvent devenir silencieusement inertes jusqu'au prochain rechargement complet de la page — probablement la vraie explication de plusieurs symptômes "bouton sans effet visible" déjà rapportés sur plusieurs apps cette session (RFXCOM, Nommage), pas seulement arbreouquoi.
- **Correctif appliqué (2026-07-24)**, sans avoir eu besoin d'éliminer la cause du double-déclenchement d'événements elle-même : ajout d'un verrou `moduleLoading: Partial<Record<string, Promise<void>>>` dans `ModuleContainer`. `loadModuleContent()` factorisée — la logique fetch/innerHTML/executeScripts déplacée dans une méthode privée `fetchAndRenderModule()`, dont la Promise est stockée par `moduleId` pendant son exécution. Un appel concurrent pour le même `moduleId` réutilise (`await`) cette Promise au lieu de relancer son propre fetch. `module:activated`/`modules:loaded` continuent probablement de se déclencher en double (cause non identifiée avec certitude — hypothèses non retenues : `connectedCallback()` de `ModuleContainer`/`Sidebar` ne se redéclenchent qu'une fois à l'usage, code inspecté sans trouver de second point d'enregistrement), mais ça n'a plus d'effet néfaste puisque le second appel n'exécute plus rien de concurrent.
- **Vérifié en direct** : logs confirmant `loadModuleContent appelé pour module: arbreouquoi` toujours deux fois, mais `Fetch URL`/`Réponse reçue pour arbreouquoi` une seule fois désormais, avec le log `Chargement déjà en cours pour arbreouquoi, attente de celui-ci` pour le second appel. Bouton bascule OÙ/QUOI d'ArbreOuQuoi cliqué avec succès sur une navigation fraîche (libellé mis à jour, persistance confirmée dans `data/arbreouquoi/config.yaml`). Nommage testé également, chargement propre sans erreur console.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Haute — résolu

### 🟢 Pipeline de build navigateur pour arbreouquoi — Corrigé (étendu aux 3 autres apps)
- **Problème** : comme `nommage`/`evoo7`/`rfxcom`, `arbreouquoi` n'avait qu'un seul réglage TypeScript (orienté serveur, Node/CommonJS), appliqué aussi à `app.ts` (navigateur) — `require`/`exports` invalides dans un `<script>`, plus un import qui traversait vers `core/src` (jamais compilé en JS navigateur).
- **Correctif** : nouveau `tsconfig.ui.json` dédié (sortie ES modules), script `build:ui`, `SocketService` importé via l'URL déjà servie par `core` (`/js/ts/services/SocketService.js`) au lieu de traverser `core/src`, copie locale de `socket-events.ts` pour ne jamais mélanger build serveur/navigateur sur un même fichier, `type="module"` sur la balise `<script>`, middleware serveur `/applications/:appId` complète désormais `.js` automatiquement pour les imports sans extension.
- **Étendu à `evoo7`/`rfxcom`/`nommage`** le même jour (commit `35da2c5`, 2026-07-23) — même pipeline reproduit tel quel sur les 3 apps restantes.
- **Statut** : Corrigé (2026-07-23) pour les 4 apps
- **Priorité** : Était Basse — résolu

### 🟡 Indicateur de connexion RFXCOM — Corrigé (effet de bord du pipeline navigateur)
- **Problème** : L'UI affiche "Déconnecté" alors que le serveur a bien reçu des messages RFXCOM et broadcase `rfxcom:status` avec `connected:true`.
- **Cause réelle, identifiée rétrospectivement** : même bug que "Tableaux de bord des apps : scripts injectés inertes" — `updateStatusDisplay()` utilisait `document.getElementById('connection-badge')`, qui ne traverse pas le Shadow DOM de `ModuleContainer` ; l'élément n'était donc jamais trouvé et le badge restait figé sur sa valeur HTML par défaut ("Déconnecté"), quel que soit le vrai statut.
- **Correctif** : déjà résolu par le chantier pipeline navigateur + Shadow DOM du 2026-07-23 (`$()` scopé sur `window.__moduleContainerRoot`, voir "Pipeline de build navigateur pour arbreouquoi").
- **Vérifié en direct (2026-07-23)** : serveur sans transceiver physique réel connecté broadcastant tout de même `connected:true` (bibliothèque `rfxcom` en environnement de dev) — badge affiche bien "Connecté" (couleur verte), au lieu du défaut HTML "Déconnecté".
- **Statut** : Corrigé (2026-07-23)

### 🟢 Sidebar : section "Applications" repliée par défaut au démarrage — un clic supplémentaire à chaque session — Corrigé
- **Demande utilisateur (2026-07-24)** : ouvrir automatiquement la section "Applications" du menu latéral au chargement de la page, comme c'est déjà le cas pour "Paramètres Techniques" — évite un clic manuel systématique avant de pouvoir accéder à une application.
- **Corrigé (31/08/2026)** : `x-data="{ openSection: 'applications' }"` dans `Sidebar.ts` (au lieu de `null`). En vérifiant : "Paramètres Techniques" n'a en réalité jamais été ouverte par défaut non plus (`openSection` valait déjà `null` au tout premier commit de ce fichier) — la prémisse de la demande était donc légèrement fausse, mais l'objectif réel (pas de clic systématique avant d'atteindre une application) est atteint.
- **Statut** : Corrigé (2026-08-31)
- **Priorité** : Résolu

### 🟢 Sidebar : menu latéral pas adapté au téléphone — devrait glisser depuis le côté — Corrigé
- **Demande utilisateur (31/08/2026)** : sur téléphone, le menu latéral (`Sidebar`) prend toute la largeur / gêne l'affichage — il faudrait un menu qui glisse depuis le côté (drawer rétractable, pattern mobile classique) plutôt que le layout fixe actuel pensé pour desktop.
- **Corrigé (31/08/2026)** : `Sidebar.ts` — bouton ☰ fixe (hors du `<aside>`, reste visible sidebar masquée), sidebar translatée hors écran par défaut sous 768px (même seuil que `arbreouquoi.css`), ouverte via une classe `mobile-open` pilotée par un nouveau `x-data="{mobileOpen: false}"` sur un wrapper englobant bouton+sidebar, fond semi-transparent cliquable pour refermer. `main.css` : marge de 280px pour `.main-content` neutralisée sous 768px.
- **Non fait, volontairement laissé pour un futur passage** : pas de fermeture automatique du tiroir après un clic sur un lien de navigation (ouvre/ferme seulement via ☰ ou le fond) — comportement simple mais fonctionnel, pas testé sur un vrai téléphone (seulement en redimensionnant la fenêtre du navigateur).
- **Statut** : Corrigé (2026-08-31), à confirmer sur un vrai appareil
- **Priorité** : Résolu (sous réserve de la vérification sur téléphone réel)

---

## Problèmes secondaires

### 🟡 rpigpio : `generateComposeFile()` ne configure aucune rotation de log pour le conteneur mqtt-io (dimotic-ha lui-même : corrigé le 14/09/2026)
- **Contexte (13/09/2026)**, trouvé sur stfort en essayant de lire `docker logs mqtt-io-rpigpio` :
  le fichier de log JSON du conteneur (`/var/lib/docker/containers/<id>/<id>-json.log`) avait atteint
  **125 Mo**, jamais nettoyé depuis son premier déploiement (option `logging` absente du
  `compose.yaml` généré, donc Docker retombe sur son défaut = pas de rotation). Ce volume a
  provoqué une corruption du fichier (`docker logs -f` plantait en cours de lecture avec
  `invalid character '\x00' looking for beginning of value`).
- **Contourné dans l'urgence** (vider le fichier à chaud avec `truncate -s 0`) — **a cassé `docker
  logs` pour ce conteneur** (le daemon Docker garde un pointeur interne vers le fichier, devenu
  incohérent après un vidage à chaud) ; réparé en redémarrant le conteneur (`docker restart`,
  aucun impact sur le GPIO réel — état électrique identique avant/après grâce à `retain`/`initial`).
  **Leçon retenue : ne plus jamais `truncate` un fichier de log Docker à chaud, toujours redémarrer
  le conteneur pour vider proprement.**
- **Vrai correctif à faire** : ajouter une option `logging` (driver `json-file`, `max-size`/
  `max-file`, ex. `10m`/`3`) dans `generateComposeFile()` (`applications/rpigpio/src/domain/
  generator.ts`) — même genre de réglage que `logging.rotate` déjà présent dans `data/core/
  config.yaml` du socle lui-même, mais absent du conteneur `mqtt-io` qu'il déploie. Concerne tous
  les sites (stfort ET noisy tourneront dans le même problème avec le temps, pas propre à stfort).
- **Priorité** : moyenne, pas bloquant — reporté volontairement ("on corrigera plus tard").
- **✅ Le même gap trouvé sur `dimotic-ha` lui-même, corrigé le 14/09/2026** : sur `noisy2`, le log
  Docker de `dimotic-ha` (pas mqtt-io cette fois) avait atteint **6 Go en une seule journée**
  (niveau debug + redémarrages fréquents pendant cette session), rendant `docker logs`/
  `docker compose` extrêmement lents (timeouts SSH à répétition). Même trouvé sur `ha2` (537 Mo,
  accumulé plus progressivement). **Corrigé dans le dépôt** : `logging: {driver: json-file,
  options: {max-size: 10m, max-file: 5}}` ajouté à `compose.yaml` ET `compose.deploy.yaml` —
  s'appliquera à tout futur déploiement. **Appliqué en direct** sur `noisy2` (backup implicite via
  `docker compose up -d --force-recreate`, log retombé à 6,7 Ko) et `ha2` (backup
  `compose.yaml.bak-pre-logrotate-20260914`, log retombé à 62 Ko) — aucun autre conteneur affecté
  par le recreate (HA/mosquitto/zigbee2mqtt sur ha2 non touchés, 9h d'uptime préservées).
  **Reste à faire** : appliquer aussi sur `stfort`/`orangepi` (pas fait aujourd'hui, pas demandé) ;
  le correctif `generateComposeFile()` pour `mqtt-io` (ci-dessus) reste, lui, non fait.

### 🟢 Désactiver une application (déplacement vers applications_désactivées/) n'arrête pas son service en cours d'exécution — Corrigé (option 2 retenue)
- **Problème d'origine**, trouvé en discutant (2026-07-23) d'un essai de désactivation de Nommage : `ApplicationManager.disable()` se contentait d'un `renameSync()` — déplaçait le dossier sur disque, rien de plus. Le service déjà chargé en mémoire (connexions MQTT, serveurs HTTP, timers) continuait de tourner sans interruption jusqu'au prochain redémarrage complet du serveur.
- **Trois pistes avaient été discutées sans qu'aucune soit retenue** (câbler `stopApplicationService()` au cas par cas / redémarrage du process entier / superviseur avec un process enfant par application). Le sujet a été mis en pause par l'utilisateur, puis abordé à nouveau sous un angle différent (demande explicite de compte à rebours de 15s avant redémarrage lors d'une activation/désactivation, 07/08/2026) — sans lien conscient avec cette entrée au moment de la demande.
- **Résolu de fait par ce chantier** : `ApplicationManager` n'utilise plus `renameSync` (liste `disabledApps` en config, voir l'entrée dédiée plus haut) et toute activation/désactivation programme désormais un redémarrage complet du process (`RestartManager.scheduleRestart`, fenêtre glissante de 15s, immédiat si on change d'écran) relancé par `scripts/supervisor.js`. C'est exactement l'option 2 envisagée à l'époque (redémarrage du process entier plutôt que l'arrêt sélectif d'un seul service) — l'OS récupère tous les handles (sockets, timers, connexions MQTT) sans nettoyage manuel à écrire.
- **Statut** : Corrigé (via le chantier compte à rebours + superviseur, 2026-08-07 — non identifié comme la résolution de cette entrée au moment où il a été fait)
- **Priorité** : Résolu

### 🟡 Pages Découverte/Taxonomie/Logs de Nommage orphelines
- **Problème** : `discovery.html`, `taxonomy.html`, `logs.html` (`applications/nommage/src/presentation/nommage/`) existent mais ne sont référencées nulle part (ni route serveur dédiée, ni lien depuis l'app elle-même) — code mort. Retirées du menu "Paramètres Techniques" le 2026-07-22 (elles menaient de toute façon toutes au même affichage générique, jamais aux vraies pages).
- **À faire** : décider si ces pages doivent être raccrochées quelque part (ex: dans le tableau de bord de l'app) ou supprimées.
- **Statut** : Non traité
- **Priorité** : Basse

### 🟡 Build cassé sur les 4 apps métier (home-assistant-js-websocket) — Corrigé
- **Problème** : `evoo7`, `rfxcom`, `arbreouquoi`, `nommage` ne compilaient plus du tout depuis le remplacement du client WebSocket HA par `home-assistant-js-websocket` (session précédente) — jamais détecté car aucune de ces apps n'avait été rebuild depuis. Cause : ce package tiers n'expose pas de condition `types` dans son `package.json` `exports`, invisible sous `moduleResolution: node` (utilisé par `core`) mais bloquant sous `moduleResolution: NodeNext` (utilisé par les 4 apps métier).
- **Correctif** : mapping `paths` vers `applications/core/node_modules/home-assistant-js-websocket/dist/index.d.ts` ajouté dans les 4 `tsconfig.json`.
- **Statut** : Corrigé (2026-07-22)

### 🟡 Sauvegarde configuration avec anciennes données (module) — Corrigé
- **Problème** : Sur un module (testé EVOO7 et RFXCOM), modifier un champ (ex: `bridgeInstance`) et cliquer Sauvegarder réaffiche l'ancienne valeur à l'écran. Un arrêt/relance de l'application affiche bien la dernière valeur modifiée — donc la donnée envoyée et persistée en disque est correcte, seul l'affichage post-sauvegarde dans la même session reste faux.
- **Observé** : 
  - Client envoie : `serialPort: "/dev/ttyUSB0"` dans le payload
  - Serveur sauvegarde correctement (confirmé par redémarrage) mais l'UI réaffiche l'ancienne valeur juste après le clic Sauvegarder, sans redémarrage
- **Causes déjà corrigées, insuffisantes** (2026-07-22) :
  1. `ModuleManager.saveModuleConfig()` lisait `window.app.configManager.getConfig()[moduleId]` au lieu de `this.moduleConfigs[moduleId]` — corrigé.
  2. Les champs de module passaient par le handler générique de `ConfigForm.ts`, écrivant dans `TechnicalConfigManager.config` (écrasable par `config:current`) — corrigé en routant vers `ModuleManager.setModuleField`/`toggleModuleField`/`setSelectField`.
  3. `ConfigForm`'s listener `config:updated` faisait un `render()` inconditionnel qui réinjectait `moduleConfigFormHtml` figé — corrigé en sautant le `render()` quand `this.moduleId` est défini.
- **Cause racine réelle, trouvée le 2026-07-23** (en corrigeant un bug similaire sur le nouveau champ `array` de Nommage) : `app:modules:list` ET `app:module:ui:register` déclenchent chacun indépendamment `app:modules:config:get` pour un même module — au moins 2 réponses serveur `app:module:config` arrivent par module, chacune écrasant l'édition en cours dans `ModuleManager.moduleConfigs`. Un clic sur Sauvegarder juste avant l'arrivée de la 2e réponse voit donc son édition écrasée par l'ancienne valeur.
- **Correctif** (2026-07-23) : nouveau `ModuleManager.moduleConfigLoaded: Set<string>` — seule la toute première réponse `app:module:config` par module est acceptée, les suivantes sont ignorées.
- **Vérifié en direct (2026-07-23)** : champ `bridgeInstance` d'EVOO7 modifié puis sauvegardé — valeur conservée à l'écran (pas de réapparition de l'ancienne), confirmée persistée dans `data/config.yaml`, et toujours correcte après un rechargement complet de la page (qui redéclenche exactement le double appel `app:modules:config:get` en cause).
- **Statut** : Corrigé (2026-07-23)

### 🟢 Formulaire générique de module : valeur de champ non échappée casse le HTML si elle contient un guillemet — Corrigé
- **Problème**, trouvé en surveillant la console navigateur (2026-07-24) sur "Paramètres Techniques → EVOO7" : `ModuleManager.generateFieldHtml()` (`applications/core/src/presentation/ui/ts/config/ModuleManager.ts:340` et `:402`, cas `text`/`string`/`password`) insère la valeur du champ directement dans l'attribut HTML `value="${value || ''}"`, **sans échappement**. Le champ `formatMessageCommand` d'EVOO7 (`{ "num" : "$name$", "status" : "$value$" }`, ajouté au formulaire générique le 2026-07-24, voir "EVOO7 : formulaire générique et page dédiée...") contient des guillemets doubles littéraux, qui referment prématurément l'attribut `value="..."` — le reste de la chaîne se retrouve interprété comme des pseudo-attributs bruts sur la balise `<input>`, corrompant le HTML généré. Conséquence observée : Alpine (qui scanne tout le DOM du formulaire) tombait sur ce markup cassé et levait `Alpine Expression Error: Unexpected token '}'` sur `input#field-evoo7-formatMessageCommand` à chaque ouverture de la page — pas seulement un warning cosmétique, l'exception interrompait le traitement Alpine pour le reste du formulaire.
- **Cause plus large** : `ConfigForm.ts` (formulaire des sections statiques Web/MQTT/Serveur/Logs) échappe déjà correctement ses valeurs via `this.escapeHtml()` — seul `ModuleManager.ts` (formulaires de module) ne le faisait pas, alors qu'il possédait déjà un helper équivalent (`escapeHtmlAttr()`, utilisé uniquement pour le JSON des champs `array`). Bug latent pour tout module dont un champ texte contiendrait un jour un guillemet, pas seulement EVOO7.
- **Corrigé (2026-07-24)** : `value="${this.escapeHtmlAttr(String(value ?? ''))}"` appliqué aux cas `text`/`string` et `password` de `generateFieldHtml()`.
- **Vérifié en direct** : le champ "Format du message Commande" affiche maintenant correctement `{ "num" : "$name$", "status" : "$value$" }` (guillemets intacts, valeur non tronquée), plus aucune erreur Alpine à l'ouverture de "Paramètres Techniques → EVOO7".
- **Statut** : Corrigé (2026-07-24)

### 🟢 Aucune confirmation visible pour l'utilisateur après une sauvegarde de config — Corrigé
- **Problème** : `ConfigForm.saveConfig()`/`ModuleManager.saveModuleConfig()` réactivaient le bouton "Sauvegarder" après un simple `setTimeout(1000)`, sans jamais attendre ni afficher le vrai résultat de la sauvegarde (succès, erreurs de validation, échec d'écriture disque). Le serveur envoie pourtant deux événements dédiés à ce résultat réel (`config:save:result` pour la sauvegarde globale — émis aussi pour une sauvegarde de module, voir `AppService.handleModuleConfigSave` — et `app:module:config:saved` pour un module), mais côté UI, rien ne les écoutait vraiment (le second était reçu et... seulement `console.log`).
- **Corrigé (2026-07-24)** :
  - `TechnicalConfigManager` écoute désormais `config:save:result` et le redispatche en `CustomEvent('config-save-result')` (nom sans `:` — un sélecteur Alpine `x-on:nom.window` ne supporte pas les `:` au milieu du nom).
  - `ModuleManager` fait de même pour `app:module:config:saved` → `module-config-save-result`.
  - `ConfigForm.buildSaveButton()` (sections statiques) et `ModuleManager.generateModuleConfigForm()` (modules) affichent le résultat réel (succès en vert / erreur en rouge, avec le message serveur), auto-masqué après 4s.
  - **Piège découvert en vérifiant en direct** : une sauvegarde de section statique déclenche presque toujours un `config:current` juste après (`AppService.handleConfigSave`) — le `render()` qu'il provoque recréait un `x-data` Alpine local vierge pour le bouton, effaçant le résultat avant même qu'il ait pu s'afficher (la confirmation n'apparaissait jamais, même si l'événement arrivait bien). Corrigé en portant le résultat dans un champ du composant `ConfigForm` (`this.saveResult`, survit aux `render()` répétés), pas dans l'état local du bouton.
- **Vérifié en direct** : succès (section statique + module EVOO7) et échec (validation, `Hôte` vidé sur Web-Services) affichent tous deux le bon message.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Moyenne — résolu

### 🟢 Édition non sauvegardée écrasée par config:current (onglets statiques) — Corrigé
- **Problème** : Sur les onglets statiques (Web services, MQTT, Serveur Web, Journalisation), si une sauvegarde a lieu ailleurs (autre onglet ouvert, autre utilisateur) pendant qu'un champ vient d'être modifié mais pas encore sauvegardé, la réception de `config:current` déclenchait un `render()` dans `ConfigForm.ts` qui écrasait la saisie en cours avec la valeur serveur.
- **Corrigé (2026-07-24)** : nouveau `ConfigForm.dirtyFields: Set<string>` — tout champ modifié (`handleFieldChange`) y est ajouté. À la réception de `config:updated`, les valeurs des champs dirty sont réinjectées dans la config entrante avant fusion (au lieu d'un remplacement brut). Vidé uniquement après une sauvegarde **réussie**.
- **Piège découvert en vérifiant en direct** : `config:save:result` est un **broadcast global** (tous les clients connectés, pas seulement celui à l'origine de la sauvegarde) — vider `dirtyFields` sur n'importe quel succès aurait fait qu'une sauvegarde déclenchée par un AUTRE onglet efface la protection de l'édition en cours dans CE onglet. Corrigé avec un indicateur `pendingLocalSave`, positionné juste avant le clic réel sur "Sauvegarder" (écouteur JS dédié sur le bouton, en plus du `@click` Alpine) — seul un succès qui suit NOTRE propre clic vide `dirtyFields`.
- **Vérifié en direct** : deux onglets ouverts sur le même serveur — champ "Hôte" modifié (non sauvegardé) dans l'onglet A, sauvegarde déclenchée depuis l'onglet B (sans rapport) → la saisie en cours dans l'onglet A survit au `config:current` qui en résulte. Sauvegarde ensuite depuis l'onglet A lui-même → persistée normalement, `dirtyFields` vidé.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Basse — résolu

### 🟢 Port série RFXCOM détecté automatiquement via /dev/serial/by-id — Ajouté
- **Demande utilisateur (2026-07-24)** : `/dev/ttyUSB0` n'est pas garanti stable d'un redémarrage à l'autre (dépend de l'ordre d'énumération USB) — chercher dans `/dev/serial/by-id/` un lien dont le nom contient "rfxcom" ou "rfxtrx" (stable, basé sur vendor/produit/numéro de série USB), résoudre le lien vers le vrai `/dev/ttyUSBx` et **transmettre ce nom réel** à la bibliothèque `rfxcom` (pas le lien symbolique lui-même — problématique dans certains environnements, ex: Docker). Si rien n'est trouvé, se rabattre sur le port configuré manuellement (`rfxcom.port`).
- **Implémenté (2026-07-24)** : nouveau `transceiver/PortDetector.ts` (`detectRfxComPort()`) — lit `/dev/serial/by-id/`, filtre sur `/rfxcom|rfxtrx/i`, résout le lien symbolique trouvé (`fs.readlinkSync` + `path.resolve`). `RfxComService.resolvePort()` l'utilise en priorité, repli sur `this.config.port` si absent/non trouvé — appelé à chaque connexion (démarrage **et** reconnexion à chaud, voir "Changement de connexion broker/port série non pris en compte à chaud" ci-dessus), donc une détection fraîche à chaque tentative, pas une valeur mise en cache qui pourrait devenir périmée.
- **Vérifié en direct** : `/dev/serial/by-id/usb-RFXCOM_RFXtrx433_A1RST9E-if00-port0 -> ../../ttyUSB0` présent sur cette machine — log confirmé au démarrage : `[PortDetector] Port RFXCOM détecté via /dev/serial/by-id/usb-RFXCOM_RFXtrx433_A1RST9E-if00-port0 -> /dev/ttyUSB0`, connexion réussie avec le chemin résolu.
- **Statut** : Ajouté (2026-07-24)

### 🟢 Gestion des protocoles RFXCOM — Corrigé
- **Problème** : La librairie npm rfxcom permet de limiter la réception à certains protocoles. Il fallait gérer cela dans l'UI.
- **Décision d'implémentation** : la spec (§8.2) mentionne "récupérés dynamiquement depuis `rfxcom.protocols`", mais son propre exemple d'UI liste des cases à cocher `Lighting1/Lighting2/Lighting4/Lighting5/Lighting6/RfxSensor/RfxMeter` — qui correspond exactement à `RfxComDeviceType` (le typage interne déjà utilisé pour classifier les messages), **pas** au registre bitmap bas niveau de la bibliothèque (`rfxcom.protocols[receiverTypeCode]`, des sous-protocoles comme AC/ARC/X10/HOMEEASY/BLYSS/...). Ce dernier dépend du type de récepteur réellement connecté (déterminé seulement après connexion), n'est vérifiable qu'avec du matériel réel, et son API d'écriture (`saveRFXProtocols`) a un nombre de cycles d'écriture non-volatile limité. Implémenté comme un **filtre logiciel** sur le type de message (`RfxComTransceiver.setEnabledTypes()`, appliqué avant `emitMessage()`), conforme à l'exemple concret de la spec, sans dépendance au matériel.
- **Implémenté (2026-07-24)** :
  - `RfxComTransceiver.setEnabledTypes()`/`getEnabledTypes()` — liste vide = tous activés (défaut du schéma).
  - `RfxComService` : applique `config.enabledProtocols` au démarrage ; nouveaux handlers `rfxcom:protocols:list:get`, `rfxcom:protocol:toggle` (`{protocol, enabled}`), `rfxcom:protocols:update` (`{protocols}`) — persistent et appliquent immédiatement, pas de redémarrage nécessaire.
  - Nouvel onglet "Protocoles" dans la page dédiée RFXCOM (`config.html`/`config-app.ts`) — cases à cocher pour les 8 types.
  - **Piège découvert en implémentant** : `IAppConfigProvider.savePartialConfig()` **remplace** toute la section `rfxcom` malgré son nom (`ConfigService.savePartialConfig`: `{...this.config, [section]: partialConfig}`, pas de fusion) — sauvegarder seulement `{enabledProtocols}` aurait effacé `port`/`bridgeInstance`/`baudRate`/`autoDiscovery` à la première bascule. Corrigé en repartant de `this.config` complet avant d'écraser le seul champ modifié.
  - **Second piège découvert en vérifiant en direct** : après un `savePartialConfig()` réussi, l'UI réaffichait l'ancien état à chaque rechargement de page malgré un fichier correctement écrit — `ConfigService.savePartialConfig()` écrit sur disque mais ne rafraîchit jamais sa propre config en mémoire (contrairement à `AppService.handleModuleConfigSave`, qui appelle `reload()` avant d'émettre `app:module:config:saved`). Corrigé en appelant `configProvider.reload()` avant de relire la config.
- **Vérifié en direct** : décoché/coché Lighting1 via l'UI — persistance confirmée dans `config.yaml` (`port`/`bridgeInstance`/`baudRate` intacts), rechargement de page reflète correctement l'état après redémarrage serveur, retour à l'état "tout coché" collapse bien vers `enabledProtocols: []`.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Moyenne — résolu

### 🟢 Envoi devices vers HA au démarrage — Corrigé (bug de fond trouvé)
- **Constat (2026-07-24)** : le code SEMBLAIT déjà faire ceci — `RfxComService.start()` appelait `publishInitialDiscoveries()` juste après `transceiver.connect()` — mais c'était le **mauvais déclencheur**, donc peu fiable en pratique.
- **Cause racine** : `integration:bridge:register` (émis dans `start()`) ne garantit ABSOLUMENT PAS que le bridge MQTT→HA du socle soit déjà connecté au moment où `transceiver.connect()` se résout — `IntegrationBridge.connectBridge()` lance la connexion MQTT de façon asynchrone, sans attendre. Publier la découverte à ce moment précis échouait donc silencieusement à chaque fois que la connexion MQTT→HA n'était pas encore établie (`HaMqttIntegrationService.getBridgeOrWarn()`, simple warning, jamais remonté) — ce qui explique pourquoi "les devices n'apparaissent pas dans HA au démarrage" pouvait être vécu comme un problème malgré un code qui semblait pourtant le faire.
- **Corrigé (2026-07-24)** : la publication déclenche désormais sur `integration:rfxcom:bridge:connection` (`connected: true`) — même pattern déjà établi et fonctionnel pour EVOO7 (`Evoo7Service.setupSocleEventListeners`). La connexion RF433 elle-même (`transceiver.connect()`) reste indépendante : un transceiver RF433 indisponible n'empêche plus les devices déjà paramétrés d'apparaître dans HA.
- **Vérifié en direct** : "Dernière découverte" (tableau de bord RFXCOM) s'actualise correctement à chaque démarrage du service, alignée sur la connexion réelle au bridge HA.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Moyenne — résolu

### 🟢 EVOO7 : placeholder `$date$` jamais implémenté, `formatMessageSensor` jamais utilisé en lecture — Obsolète (mécanisme entier remplacé)
- **Problème d'origine**, trouvé en lisant `evoo7-templates.ts` (2026-07-23) :
  1. Le commentaire d'en-tête du fichier annonce la substitution de `$name$`/`$value$`/`$date$` dans les topics et formats de message, mais seuls `$name$` (`resolveTopic`) et `$value$` (`resolveCommandMessage`, commandes sortantes uniquement) sont réellement substitués — aucun `.replace(/\$date\$/g, ...)` n'existe nulle part. Si `$date$` est utilisé dans un topic ou un format (Commande ou Sensor), il repart tel quel, non substitué.
  2. Le champ `formatMessageSensor` (éditable par ligne dans l'onglet "Données", avec son propre bouton de sauvegarde) est bien stocké/persisté (`Evoo7Service.ts` ligne ~403) mais **jamais lu** pour interpréter les messages entrants : `extractSensorValue()` (`evoo7-templates.ts`) suppose toujours que le JSON reçu porte la valeur dans une clé `"status"`, quel que soit le format configuré. Seul `topicSensor` (via `$name$`) a un effet réel côté réception.
- **Confirmé (2026-07-24)**, en creusant l'entrée ci-dessous (formats perdus) : `$date$` (sous la forme `"___date":"$date$"`) est bien présent dans **41 des 43** `formatMessageSensor` réels capturés depuis EVOO7 (`applications/evoo7/seed/evoo7_donnees.json`, champ `format_message_sensor`) — donc bien utilisé en pratique, contrairement à ce qui était supposé ici. `$date$` repart donc actuellement tel quel (non substitué) dans le message envoyé pour la quasi-totalité des données EVOO7.
- **⭐ 31/08/2026, constaté obsolète en revue de TODO** : cette entrée décrit le mécanisme de l'ancien `Evoo7MqttClient` (broker MQTT dédié + traducteur `zdidEVOO7mqtt`, gabarits JSON par donnée). Remplacé le 16/08/2026 par `Evoo7SocketIoClient` (connexion Socket.IO directe au boîtier) — voir l'entrée "connexion Socket.IO directe" plus bas. `evoo7-templates.ts` (`extractSensorValue`/`resolveTopic`/`resolveCommandMessage`) **n'existe plus du tout** dans le code actuel ; l'événement `datas` du boîtier livre désormais les valeurs brutes nom→valeur directement, sans gabarit JSON à interpréter. Le champ `formatMessageSensor` traîne encore dans le schéma/seed/UI (donnée affichée, éditable) mais n'est plus lu nulle part par le chemin de lecture réel — plus un bug à corriger, un vestige d'UI à nettoyer un jour si on le souhaite (nouvelle entrée séparée si ça devient gênant).
- **Statut** : Obsolète — le mécanisme décrit n'existe plus
- **Priorité** : Aucune (rien à corriger, l'architecture qui portait ce bug a été remplacée)

### 🟢 EVOO7 : `formatMessageSensor` tronqué/perdu pour 2 données sur 43 dans le fichier persisté — Corrigé
- **Signalé par l'utilisateur (2026-07-24)** : "on a perdu tous les formats de messages initiaux attachés à une donnée". Re-signalé en test direct (2026-07-26) : "il a perdu toutes les descriptions des formats des messages 'Format sensor'" — revérifié à ce moment-là, l'ampleur réelle restait bien les 2 mêmes données (41/43 intactes), pas une régression plus large.
- **Confirmé** : `data/evoo7/config-evoo7-donnees-v1.0.yaml` contient bien le format complet d'origine (capturé dans `applications/evoo7/seed/evoo7_donnees.json`) pour 41 des 43 données, mais pour **`pente_loi_deau`** et **`consigne_eco`**, `formatMessageSensor` valait seulement `'{ '` (accolade ouvrante + espace) au lieu du gabarit JSON complet.
- **Cause probable** : édition manuelle via l'onglet "Données" (champ `formatMessageSensor`, sauvegarde par `evoo7:donnee:set_topic`) interrompue avant la fin de la saisie — la valeur partielle a été sauvegardée telle quelle, sans validation de format côté serveur (`Evoo7Service.ts` persiste la chaîne reçue sans vérifier qu'il s'agit d'un JSON valide/complet).
- **Corrigé (2026-07-26)** : les deux valeurs restaurées depuis le seed (`applications/evoo7/seed/evoo7_donnees.json`, champ `format_message_sensor`) directement dans `data/evoo7/config-evoo7-donnees-v1.0.yaml` (sauvegarde préalable dans `backups/evoo7/`, diff vérifié — seuls ces 2 champs changent de contenu, le reste n'est qu'un réagencement de style YAML sans impact sémantique, revalidé contre `evoo7DonneesConfigSchema`).
- **Reste à faire (non traité, périmètre différent)** : validation serveur basique (JSON valide, non vide) avant d'accepter une sauvegarde de `formatMessageSensor` via `evoo7:donnee:set_topic`, pour empêcher qu'une future saisie interrompue n'écrase silencieusement une valeur correcte — pas implémenté dans ce passage.
- **Statut** : Corrigé (2026-07-26) — les 43 données ont un `formatMessageSensor` complet. Validation préventive côté serveur toujours à faire.
- **Priorité** : Était Haute — perte de données résolue ; le point de robustesse restant est Moyenne.

### 🟢 EVOO7 : aucune saisie réelle de la taxonomie QUOI/OÙ pour les données sélectionnées — Corrigé
- **Demande utilisateur (2026-07-24, confirmée et implémentée 2026-07-26)** : ajouter la saisie des données de taxonomie pour les données EVOO7 sélectionnées (consultation et/ou mise à jour).
- **Constat d'origine** : `Evoo7Service.ts` construisait `attributs_taxonomie` via `extractTaxonomy(donnee.description)`, qui attend un format structuré `quoi---lieu_precis--lieu--pere--grandpere` — or `description` est une phrase en français libre figée, jamais dans ce format. La taxonomie publiée était donc inexploitable pour les 43 données depuis le début.
- **Décisions validées avec l'utilisateur (2026-07-26)** : 5 champs séparés (Quoi / Lieu précis / Lieu / Père / Grand-père) plutôt qu'un champ texte unique au format `quoi---lieu` ; visibles/éditables uniquement pour les données sélectionnées (`consultation || miseAJour`).
- **Implémenté (2026-07-26)** :
  - `Evoo7DataDefinition` (`types.ts`) + `evoo7DataDefinitionSchema` (`donnees-config-schema.ts`) : 5 nouveaux champs optionnels `taxonomieQuoi`/`taxonomieLieuPrecis`/`taxonomieLieu`/`taxonomiePere`/`taxonomieGrandPere`.
  - `taxonomy.ts` : nouvelle fonction `resolveTaxonomy(donnee)` — construit l'`ExtractedTaxonomy` directement depuis les 5 champs si `taxonomieQuoi` est renseigné, sinon repli sur l'ancien `extractTaxonomy(donnee.description)` (comportement historique, non cassé pour les données pas encore renseignées).
  - `Evoo7Service.ts` : les 2 sites d'appel (`handleEvoo7Message`, `publishDonneeDiscovery`) utilisent désormais `resolveTaxonomy()`. Nouveau handler `evoo7:donnee:set_taxonomy` (même pattern que `set_topic` : persistance avec rollback si échec, réponse honnête via `evoo7:donnee:save:response`) qui republie immédiatement la découverte HA si la donnée est actuellement sélectionnée (le nom/les attributs publiés changent).
  - `socket-events.ts` : nouvel événement client `DONNEE_SET_TAXONOMY`.
  - UI (`config-app.ts` + `config.html`, onglet Données) : nouvelle colonne "Taxonomie", 5 champs texte + bouton de sauvegarde affichés uniquement quand la donnée est sélectionnée (Consultation ou Mise à jour cochée), sinon message indicatif.
- **Vérifié** : build propre (`tsc` + `tsc -p tsconfig.ui.json`), serveur redémarré sans erreur, service EVOO7 démarré normalement.
- **Statut** : Corrigé (2026-07-26)
- **Priorité** : Était Haute — résolu

### 🟢 EVOO7 : formulaire générique et page dédiée éditent les mêmes champs par deux chemins de sauvegarde différents, dont un ne prend jamais effet à chaud — Corrigé
- **Problème**, trouvé en comparant "Paramètres Techniques → EVOO7" (formulaire générique du core) et l'onglet "Paramétrage" de la page dédiée (`config.html`) :
  1. **Duplication partielle** : `mqtt.host`, `mqtt.port`, `bridgeInstance`, `topicCommand` sont éditables aux deux endroits (`EVOO7_UI_METADATA.fields`, `applications/evoo7/src/domain/index.ts:37-72`, vs onglet Paramétrage de `config.html`). Utilisateur/mot de passe MQTT, QoS et le format du message Commande n'existent, eux, que dans la page dédiée.
  2. **Plus grave — deux chemins de sauvegarde distincts pour les mêmes champs** : la page dédiée sauvegardait via `evoo7:config:save`, géré directement par `Evoo7Service`, qui rechargeait son `this.config` en mémoire aussitôt. Le formulaire générique sauvegardait via `app:modules:config:save` (mécanisme du socle) — qui écrit bien sur disque, mais `Evoo7Service` n'écoutait jamais `config:reload` pour se resynchroniser.
  3. **Conséquence** : modifier `bridgeInstance`/`mqtt.host` etc. via "Paramètres Techniques → EVOO7" était bien persisté sur disque, mais le service EVOO7 en cours d'exécution continuait de travailler avec l'ancienne valeur jusqu'au redémarrage du serveur — silencieusement, sans même l'avertissement de redémarrage que la page dédiée affichait. Le formulaire générique était donc trompeur pour ces champs précis.
- **Constaté en testant en direct** (2026-07-23), en creusant après avoir remarqué le doublon visuel entre les deux écrans.
- **Corrigé (2026-07-24)**, option retenue : le formulaire générique (`Paramètres Techniques → EVOO7`) devient l'unique source de vérité pour tout le paramétrage.
  - `EVOO7_UI_METADATA` (`applications/evoo7/src/domain/index.ts`) complété avec les 4 champs qui n'existaient jusque-là que sur la page dédiée : `mqtt.username`, `mqtt.password`, `mqtt.qos`, `formatMessageCommand`.
  - Onglet "Paramétrage" retiré de `config.html` (EVOO7) — ne reste que "Données" (renommée en conséquence : titre, lien du tableau de bord, entrée de menu).
  - Handlers `evoo7:config:get`/`evoo7:config:save` (et leurs événements associés) retirés de `Evoo7Service.ts`/`socket-events.ts` — code mort une fois la page dédiée dépossédée de son propre chemin de sauvegarde.
  - La limitation "pas de rechargement à chaud" (voir entrée dédiée ci-dessous) reste entière mais n'est plus trompeuse : un seul chemin de sauvegarde, un seul avertissement à surveiller.
- **Vérifié en direct** : build propre (core + evoo7), formulaire générique affiche et sauvegarde bien les 8 champs, page dédiée n'affiche plus que "Données".
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Moyenne — résolu

### 🟢 Désélection d'une donnée/device ne retire pas sa découverte déjà publiée côté HA — Corrigé (EVOO7 + RFXCOM)
- **Problème** : Décocher "Consultation"/"Mise à jour" pour une donnée EVOO7 (`evoo7:donnee:set_selection`) ou `transmitToHa` pour un device/récepteur/scène RFXCOM (`rfxcom:device:set_transmit`, `rfxcom:receiver:update`, `rfxcom:scene:update`, ainsi que la suppression d'un récepteur/scène encore publié) — met bien à jour l'état interne et le persiste sur disque immédiatement, mais ne retirait **pas** la découverte MQTT déjà publiée côté Home Assistant. L'entité restait visible dans HA après désélection ; seule une nouvelle sélection republiait/actualisait. Le socle (`applications/core/src/ha/integration/discovery.ts`) n'avait aucun mécanisme de retrait de découverte MQTT.
- **Constaté en testant en direct** l'onglet "Données" d'EVOO7 (2026-07-23) — le comportement était documenté en commentaire dans le code (`Evoo7Service.ts`) mais pas encore adressé.
- **Corrigé (2026-07-24)**, dans le socle (réutilisable tel quel par les autres modules d'intégration) :
  - `discovery.ts` : nouvelle fonction `unpublishDiscovery()` — publie un payload **vide** (pas `{}`, une chaîne réellement vide) en `retain:true` sur le même topic de découverte que `publishDiscovery()` — convention MQTT Discovery standard pour faire supprimer une entité par HA.
  - `HaMqttIntegrationService.removeDiscoveryFor()` + nouvel événement EventBus `integration:{moduleName}:discovery:remove` câblé dans `IntegrationBridge.subscribeModuleEvents()`, symétrique à `integration:{moduleName}:discovery`.
  - `Evoo7Service.ts` : le handler `evoo7:donnee:set_selection` détecte désormais la transition "était publiée avant" (`previous.consultation || previous.miseAJour`) → "ne l'est plus" et émet `integration:evoo7:discovery:remove` (nouvelle méthode `removeDonneeDiscovery()`) au lieu de rester silencieux.
  - `RfxComService.ts` : même détection de transition pour `rfxcom:device:set_transmit`, `rfxcom:receiver:update`/`delete`, `rfxcom:scene:update`/`delete` (nouvelles méthodes `removeDeviceDiscovery()`/`removeReceiverDiscovery()`/`removeSceneDiscovery()`) — le `component`/`objectId` doit être capturé **avant** la mutation/suppression du récepteur ou de la scène (indisponible une fois retiré de `ReceiverManager`/`SceneManager`), et l'`objectId` d'une scène (`rfxcom_scene_...`) diffère de son `deviceId` d'état (`scene_...`), piège repéré en relisant `publishSceneDiscovery()`.
- **Vérifié en direct** (sans toucher à une donnée/un device réellement utilisé par un système en production) : `mosquitto_sub` sur le broker réel `ha2.local` confirme la publication du message de découverte complet à la sélection, puis un payload vide (`(null)`) au même topic à la désélection — testé pour EVOO7 (`pente_loi_deau`, remis dans son état d'origine) et pour RFXCOM (device de test créé/retiré via socket direct, jamais persisté sur disque — validation Zod du device a échoué sur un champ `defaultQuoi` vide, artefact du test qui contourne la découverte matérielle normale, sans impact sur le mécanisme de découverte/retrait lui-même).
- **Statut** : Corrigé (2026-07-24) pour EVOO7 et RFXCOM
- **Priorité** : Était Basse — résolu

### 🟢 Changement de connexion broker/port série non pris en compte à chaud — Corrigé (EVOO7 + RFXCOM)
- **Problème** : Sauvegarder un changement d'hôte/port/identifiants MQTT via "Paramètres Techniques → EVOO7", ou de port série via "Paramètres Techniques → RFXCOM", persistait bien la nouvelle config sur disque, mais la connexion déjà établie n'était pas reconfigurée à chaud — un redémarrage du serveur était nécessaire.
- **Corrigé (2026-07-24)** : le redémarrage automatique du service entier sur sauvegarde de config reste désactivé globalement (`AppService.setupEventListeners`, "comme demandé" — décision antérieure non remise en cause), mais `Evoo7Service`/`RfxComService` écoutent désormais eux-mêmes `app:module:config:saved` (déjà émis par `AppService.handleModuleConfigSave`, simplement jamais consommé pour ces modules) : si le `moduleId` correspond et `success`, rechargent leur config et comparent les champs de connexion (`mqtt` pour EVOO7, `port`/`baudRate` pour RFXCOM) — si différents, déconnectent puis reconnectent (`Evoo7MqttClient`/`RfxComTransceiver`) avec la nouvelle config, sans redémarrer le reste du service ni perturber `bridgeInstance`/le bridge HA.
- **Vérifié en direct** : EVOO7 (QoS basculé 1→0→1) et RFXCOM (`baudRate` basculé 38400→38401→38400, port série réel non modifié par prudence) — à chaque sauvegarde, `data/config.yaml` mis à jour, connexion restée active en continu, log confirmant une reconnexion réelle (pas un no-op), aucune app relancée (pas de ligne `[tsx] Restarting`, contrairement à un changement de fichier source).
- **Statut** : Corrigé (2026-07-24) pour EVOO7 et RFXCOM
- **Priorité** : Basse

### 🟢 Pages dédiées EVOO7/RFXCOM : aucun lien de retour vers l'application — Corrigé
- **Problème** : `config.html` d'EVOO7 (Données) et de RFXCOM (Devices & Récepteurs) sont de vraies navigations de page complète (pas injectées dans le Shadow DOM du core comme le tableau de bord) — une fois dessus, aucun lien/bouton ne ramenait vers l'interface principale (`/`), seul le bouton "Précédent" du navigateur permettait d'y revenir.
- **Corrigé (2026-07-24)** : lien `← Retour` (`href="/"`) ajouté en haut de chaque `config.html`.
- **Statut** : Corrigé (2026-07-24)
- **Priorité** : Était Basse — résolu

### 🟡 Définir et mettre en place l'interface web des applications IA et Planificateur
- **Constat actuel** :
  - IA (`applications/ia/src/presentation/`) : dashboard (`index.html`) avec statut Mistral/Ollama, outil de test conversationnel, historique des derniers échanges — mais aucune page de configuration dédiée ; les réglages (`mistralApiKey`, `mistralBaseUrl`, `ollamaHttpPort`, `rulesFile`, fournisseurs généralistes, voir `fonctionnelles-ia_specs` §12) passent uniquement par le formulaire générique de "Paramètres Techniques" (`ModuleManager`).
  - Planificateur (`applications/planificateur/src/presentation/`) : dashboard avec compteurs (macros/planifications/minuteurs actifs) + page `config.html` listant macros et planifications (activer/désactiver/supprimer) — pas de création via l'UI, volontairement 100% conversationnelle via `ia` (`fonctionnelles-planificateur_specs`).
- **À définir** : le périmètre voulu pour chaque application au-delà de l'existant — ex : consultation détaillée du contenu d'une macro/planification (séquence `execution`), historique des déploiements/exécutions passés, réglages avancés propres à `ia` (règles domotiques, routage multi-IA §6 de `fonctionnelles-ia_specs`).
- **À faire** : une fois le périmètre défini avec l'utilisateur, implémenter les pages manquantes selon le pipeline de build navigateur commun (`tsconfig.ui.json` dédié + Shadow DOM `ModuleContainer`, voir "Pipeline de build navigateur pour arbreouquoi" ci-dessus).
- **Statut** : Non défini
- **Priorité** : Moyenne

### 🟢 EVOO7 : entité `climate` composite (plusieurs données combinées) — Corrigé (entrée stale mise à jour)
- **Demande utilisateur (2026-07-26)**, en marge de l'ajout de `binary_sensor` (type HA forcé par donnée) : élargir aussi au type `climate`.
- **Constat (2026-08-03)**, en recherchant l'état réel du code pour le rattrapage des specs EVOO7 : cette entrée était restée "Non commencé" alors que la fonctionnalité est **entièrement implémentée** depuis un moment — mise à jour jamais faite après le travail réel.
- **Implémenté** : `Evoo7ThermostatConfig` (`{enabled, allowCooling}`) sur `Evoo7DonneesConfig.thermostat` ; 7 données dépendantes (`temp_amb`, `consigne_normal`, `etat_fonctionnement`, `etat_circulateur_pc`, `etat_circulateur_radiateur`, `etat_eco`, `temp_ext`, plus que les 3-5 pressenties à l'origine) ; un seul `command_topic` partagé pour température/mode/preset, discriminé par un champ `field` dans le `command_template` (contrainte du socle : une entité = un seul topic de commande) ; `hvac_action` calculé côté serveur à partir des deux circulateurs ; `temp_ext` publiée en attribut plutôt qu'en champ climate standard, conformément à ce qui était pressenti. UI : carte "Thermostat" dans l'onglet Données, socket `evoo7:thermostat:save`.
- **Détail complet** : voir `fonctionnelles-evoo7_specs_v1.2.md` §9 (nouvelle section, ajoutée dans le même rattrapage que cette correction TODO).
- **Statut** : Corrigé (déjà implémenté, non documenté ni mis à jour ici jusqu'au 2026-08-03)
- **Priorité** : Était Moyenne — résolu

### 🟡 IA : ambiguïté récurrent/one-shot sur les déclencheurs d'état ("quand X, fais Y")
- **Constat (2026-08-03)**, en concevant le nouveau trigger `state_change` (planificateur, voir conception en cours "quand la lumière du salon s'allume, éteins la cuisine") : une phrase du type "quand [événement X], [action Y]" ne précise pas si la règle doit se redéclencher à chaque occurrence future de X (recurring, ex: une minuterie) ou ne s'appliquer qu'une seule fois (one-shot, ex: "quand la lumière du salon s'allume ce soir, préviens-moi"). Contrairement aux déclencheurs temporels existants, où le type (`delay` vs `recurrence`) découle naturellement de la formulation ("dans 5 minutes" vs "tous les jours à 8h"), rien dans "quand X, Y" ne permet à Mistral de trancher de façon fiable.
- **À faire** : `ia` devra probablement détecter ce cas et poser une question de clarification à l'utilisateur (répétitif ou ponctuel ?) plutôt que de deviner — reste à définir précisément le mécanisme (nouvelle catégorie de réponse "clarification requise", ou repli sur un défaut avec confirmation implicite). Non tranché, à traiter pendant l'implémentation du trigger `state_change`.
- **Statut** : Non traité — noté pendant la conception, pas encore implémenté
- **Priorité** : Moyenne (fait partie du chantier trigger d'état en cours de conception)

### 🟢 AppService : le chargement dynamique des modules en production suppose un `dist/domain/index.js` à plat, faux pour 7 apps sur 8 — Corrigé (icône mise à jour lors de la revue du 31/08/2026, contenu déjà résolu depuis le 07/08)
- **Constat (2026-08-03)**, en testant pour la première fois le déploiement Docker (`node applications/core/dist/index.js`, sans `tsx`) : jusqu'ici, le projet n'avait **jamais tourné autrement qu'via `tsx watch`** (dev), qui masque ce problème — voir l'entrée juste en dessous pour un contournement immédiat côté Docker.
- **Cause racine** : `AppService.detectModules()`/`loadApplicationModule()` cherchent le module compilé d'une application à `applications/{app}/dist/domain/index.js`. Ce chemin n'est correct que pour `arbreouquoi` (`rootDir: "./src"` dans son `tsconfig.json`, aucun import de valeur réelle — pas juste des types — depuis `core/src`). Les **7 autres applications** (`arexx`, `evoo7`, `haplan`, `ia`, `nommage`, `planificateur`, `rfxcom`) importent au moins une valeur réelle (fonction, pas juste un type) depuis `../../../core/src/exports` (ex: `createRfxComError`, `getCommandTopic`) — TypeScript élargit alors leur `rootDir` à `".."` pour englober ce fichier extérieur à `src/`, et le fichier compilé atterrit à `applications/{app}/dist/{app}/src/domain/index.js` au lieu du chemin attendu. `AppService` ne trouvant pas le fichier au chemin standard retombe sur le `.ts` source, qui échoue à son tour sous `node` pur (pas d'interpréteur TypeScript) — `Cannot find module '.../src/domain/index.ts'`.
- **Deux corrections déjà faites au passage, réelles et nécessaires mais insuffisantes seules** (voir commit Docker du 03/08/2026) : (1) priorité inversée pour préférer `dist/domain/index.js` au `.ts` source, correcte mais qui ne change rien pour les 7 apps concernées puisque le chemin `dist/domain/index.js` n'existe simplement pas chez elles ; (2) `require()` direct pour le `.js` compilé au lieu d'un `import()` suivi d'un repli `require()` en cas d'échec — ce dernier laissait le résolveur de modules de Node dans un état incohérent pour un `import()` ultérieur du même fichier ailleurs dans le process (bug distinct, réel, découvert au passage).
- **Corrigé (2026-08-07)**, option 2 retenue (correction de la cause) après discussion — le core a en réalité toujours généré ses `.d.ts` (`declaration: true` hérité du `tsconfig.json` racine, fait non identifié au moment du constat initial du 03/08). Mise en œuvre en **TypeScript Project References**, plus robuste que le simple changement d'import :
  1. `applications/core/tsconfig.json` : ajout de `"composite": true`.
  2. Dans les 7 apps (`arexx`, `evoo7`, `haplan`, `ia`, `nommage`, `planificateur`, `rfxcom`) : `"rootDir": "./src"` (au lieu de `".."`), ajout de `"references": [{ "path": "../core" }]`, script `build` passé de `tsc` à `tsc -b`.
  3. Les 51 fichiers concernés (imports `core/src/exports`) repointés vers `core/dist/exports` (compilé + `.d.ts`) — remplacement mécanique identique partout, sauvegarde préalable dans `backups/project-references_2026-08-07/`.
- **Vérifié** : build complet (`docker/build-apps.sh`) propre sur core + 8 apps ; `dist/domain/index.js` à plat pour les 7 apps (confirmé aussi pour `arbreouquoi`, déjà correct) ; `require()` du module compilé testé directement (rfxcom) — charge et expose bien tous ses exports ; `AppService.ts` n'a nécessité aucune modification, sa logique de détection préférait déjà `dist/domain/index.js` quand il existe. `npm run typecheck`/`build` de `core` toujours propres avec `composite: true`.
- **Statut** : Corrigé
- **Priorité** : Résolu

### 🟢 Docker : exécution en JS compilé (`node dist/index.js`) non fonctionnelle tant que le point ci-dessus n'est pas corrigé — contournement en `tsx` viable — Corrigé (icône mise à jour lors de la revue du 31/08/2026, contenu déjà résolu)
- **Constat (2026-08-03)** : le déploiement Docker construit (`Dockerfile`/`compose.yaml`/`docker/build-apps.sh`) exécute `node applications/core/dist/index.js` — cassé pour 7 applications sur 8 par le bug ci-dessus. `core` lui-même et `arbreouquoi` démarrent correctement.
- **Contournement disponible et à faible risque** : faire tourner le conteneur via `tsx` (`applications/core/node_modules/.bin/tsx applications/core/src/index.ts`) plutôt que le JS compilé — reproduit exactement le mode qui a servi à tout le développement/tests de ce projet jusqu'ici (`npm run dev`/`dev:local`), y compris le chemin de chargement dynamique `.ts` déjà éprouvé (`import()` sous `tsx`, jamais changé). `tsx` est déjà présent (devDependency de `core`, jamais pruné par `docker/build-apps.sh`). Le `build:ui` (assets navigateur compilés, servis tels quels par Express) reste nécessaire et inchangé — seul le côté serveur passerait en interprété plutôt que précompilé.
- **Compromis à connaître** : `tsx` transpile sans vérification de type complète (comme `ts-node --transpile-only`) — une erreur de type qui aurait été détectée par `tsc` à la compilation pourrait glisser jusqu'à l'exécution. Léger surcoût de démarrage (transpilation à la volée). Accepté comme raisonnable vu que c'est déjà exactement le mode utilisé en développement depuis le début du projet — pas un changement de profil de risque, juste sa continuation en conteneur.
- **Appliqué (2026-08-03)**, décision utilisateur ("oui et nous verrons le problème de fond plus tard") : `CMD` du `Dockerfile` exécute désormais `applications/core/node_modules/.bin/tsx applications/core/src/index.ts`. **Vérifié en conditions réelles** : les 9 modules (core + 8 apps métier) se chargent et démarrent sans erreur, RFXCOM détecte et se connecte au transceiver réel (`/dev/serial/by-id` → `/dev/ttyUSB0`), les bridges MQTT (evoo7/arexx/nommage/rfxcom) se connectent, HA WebSocket s'authentifie et charge le référentiel (395 entités), `/health` répond.
- **Conception revue une seconde fois (2026-08-03)**, question utilisateur ("pourquoi les applications seraient déplacer en externe du docker pourquoi pas en interne ?") : la toute première version publiée montait `applications/`/`applications_désactivées/` depuis l'hôte, obligeant à `git clone` le dépôt à côté de l'image sur chaque machine cible — à l'encontre de l'intérêt même de Docker Hub. Le code est désormais construit **pendant le build de l'image** (`docker/build-apps.sh` appelé depuis le `Dockerfile`, plus de service `build` séparé) — `docker pull` + `docker compose up` suffisent, plus besoin de cloner quoi que ce soit sur la cible.
- **⚠️ Piège réel découvert en vérifiant ce nouveau design** : `fs.renameSync()` (activation/désactivation d'application) échoue avec `EXDEV` dès que le code applicatif vit uniquement dans les couches de l'image — `overlay2` refuse de renommer un répertoire encore uniquement présent dans une couche inférieure (même en lecture seule), quelle que soit l'organisation des couches (vérifié aussi avec les deux répertoires créés dans la MÊME instruction `RUN`). Vérifié aussi que **deux bind-mounts hôte séparés** (même disque physique) échouent pour la même raison — chaque `volumes:` déclaré ouvre son propre `st_dev`. La seule configuration qui fonctionne (vérifiée empiriquement à chaque étape) : un **volume Docker nommé unique** couvrant tout `/app`, peuplé automatiquement par Docker avec le contenu de l'image au premier démarrage — `data/`/`logs/` restent bind-mountés depuis l'hôte par-dessus (montage plus spécifique, sans risque puisque rien ne déplace de fichier entre `data/`/`applications/`), pour rester directement éditables sans `docker exec`.
- **Image republiée sur Docker Hub** avec ce design corrigé : `zdid2/dimotic-ha:latest`/`:0.1.0`, multi-architecture (`linux/amd64` + `linux/arm64`, utilisable telle quelle sur Raspberry Pi 3/4/5 en OS 64 bits) — build via `docker buildx` (builder dédié `dimotic-builder`, émulation QEMU pour arm64 enregistrée via `tonistiigi/binfmt`). L'image contenant désormais le code compilé pour de vrai, le build multi-arch est plus lent côté arm64 (émulation QEMU pour `npm install`/`tsc` des 9 apps) mais reste ponctuel (à refaire seulement lors d'une nouvelle version).
- **Statut** : Corrigé (contournement `tsx` + design volume nommé, tous deux appliqués et vérifiés) — le problème de fond (chemin `dist/domain/index.js` erroné pour 7 apps sur 8) est désormais réglé lui aussi (voir entrée précédente, 07/08/2026). `node dist/index.js` en JS compilé redeviendrait viable pour les 9 modules si on voulait un jour revenir dessus, mais le `CMD` du `Dockerfile` (`scripts/supervisor.js` → `tsx`) n'a pas été changé — ce choix reste indépendant (supervision/relance, pas seulement chargement des modules) et n'a pas été redemandé.
- **Priorité** : Résolu (cause de fond) — passage effectif en JS compilé non demandé, `tsx` reste en place

### 🟢 Socle : `ha:connected`/`ha:disconnected`/`mqtt:connected`/`mqtt:disconnected` jamais relayés vers Socket.io — indicateur tri-state bloqué sur orange/rouge quel que soit l'état réel — Corrigé
- **Constat (24/08/2026)**, en testant en conditions réelles l'indicateur tri-state HA WebSocket/MQTT (implémenté plus tôt cette session) : après régénération d'un Long-Lived Access Token et redémarrage, HA WebSocket restait affiché orange (connecté mais non authentifié) alors que la connexion était réellement établie et authentifiée (confirmé en logs : `Connexion WebSocket établie et authentifiée`, référentiel chargé, et une diffusion scriptsha ayant réellement réussi entre-temps).
- **Cause** : `AppService.startHaWsClient()`/`IntegrationBridge.updateAggregateMqttStatus()` émettent bien `ha:connected`/`ha:disconnected`/`mqtt:connected`/`mqtt:disconnected` sur l'EventBus interne, mais `SocketBridge.ts` ne les relayait vers aucun client Socket.io — absents à la fois des listeners câblés en dur (`setupEventBusListeners()`) et de tout `socketEvents` déclaré par une application. Le code client (`TechnicalConfigManager.ts`, `socket.on('ha:connected', ...)`) était pourtant correct et attendait ces événements depuis l'origine du chantier tri-state — jamais pu s'exécuter faute d'émission serveur. La vérification précédente du tri-state n'avait couvert que les états rouge/orange (qui sont la valeur par défaut en l'absence de toute émission), jamais le vert, d'où la découverte tardive.
- **Corrigé** : les 4 événements ajoutés à `ServerToClientEvents` (`types/events.ts`, `ha:connected`/`ha:disconnected` manquaient) et câblés dans `SocketBridge.ts` (`onGeneric`/`on` + `broadcast`), en **événements persistants** (comme `config:current`) — un client qui se connecte ou se reconnecte après l'établissement de la connexion reçoit désormais l'état réel immédiatement, pas seulement les transitions futures.
- **Vérifié en conditions réelles** : après rafraîchissement, indicateur HA WebSocket passé au vert (connexion ha2 réellement authentifiée, référentiel chargé).
- **Statut** : Corrigé (2026-08-24)
- **Priorité** : Résolu

### 🟢 Interface : navigation affichant la page RFXCOM au lieu de la section MQTT demandée — Corrigé
- **Constat utilisateur (24/08/2026)**, reproduit deux fois : en accédant à Paramètres Techniques → RFXCOM puis Paramètres Techniques → MQTT (sans détour), c'est le formulaire RFXCOM qui reste affiché à la place de MQTT. Contournement empirique trouvé par l'utilisateur : cliquer d'abord sur Web-services puis MQTT fonctionne.
- **Reproduit et tracé en direct** (navigateur, inspection DOM) : `#section-mqtt` était bien affiché (`display:block`), mais le `<app-config-form>` qu'il contient restait bloqué sur le formulaire RFXCOM.
- **Cause exacte** : deux mécanismes de navigation distincts dans `Sidebar.ts` — `showModuleConfig(moduleId)` (utilisé par les entrées "module" comme RFXCOM/AREXX sous Paramètres Techniques) affiche `#section-ha` et dispatche `module:config:show({moduleId})`, écouté **globalement** par les 4 instances de `<app-config-form>` (une par section statique ha/mqtt/web/logging) — chacune passe alors en "mode module", affichant le formulaire RFXCOM. `showContentSection(sectionId)` (utilisé par MQTT) réinitialise ce mode uniquement via `attributeChangedCallback` sur `data-section` (`ConfigForm.ts`) — mais cette callback native ne se déclenche QUE si la valeur de l'attribut change **textuellement**. Si `data-section` valait déjà "mqtt" avant le détour par RFXCOM (le détour ne touche jamais cet attribut, seulement l'événement), le reclic sur MQTT réécrit la même valeur "mqtt" → aucun changement détecté → `attributeChangedCallback` ne se déclenche pas → le mode module reste bloqué indéfiniment sur RFXCOM. Cliquer d'abord sur Web-services fonctionnait par accident : ça changeait réellement la valeur de l'attribut (mqtt→ha), déclenchant la réinitialisation.
- **Corrigé** : `Sidebar.ts::showContentSection()` dispatche désormais aussi `scroll-to-section` (vrai `CustomEvent`, toujours redéclenché, jamais soumis à la garde "valeur inchangée" des attributs) — `ConfigForm.ts` y réinitialise déjà correctement son mode module (listener préexistant, jusqu'ici seulement atteint par un autre chemin), donc plus besoin de dépendre de la comparaison d'attribut pour ce cas.
- **Vérifié en conditions réelles** (navigateur, séquence RFXCOM→MQTT rejouée après correctif) : MQTT s'affiche désormais correctement, plus de blocage.
- **Statut** : Corrigé (2026-08-24)
- **Priorité** : Résolu

### 🟡 IA : tenir une liste des modifications apportées au contexte de déploiement
- **Constat (2026-08-03)**, en ajoutant `triggered_entity_id` à `DeployContext`/`DeployRequest` (voir le trigger `state_change` ci-dessus) : le contexte envoyé à Mistral au moment du déploiement (`declenchement: {trigger_name, phrase_originale, macros, entites, heure, jour, date, ...}`, `DeployResponder.ts`) évolue au fil des besoins sans qu'aucun endroit ne liste ce qui a été ajouté et pourquoi — seul le diff du code en garde la trace. C'est le même symptôme que le décalage specs/code repéré aujourd'hui, mais à l'échelle d'un seul mécanisme.
- **À faire** : tenir une liste à jour des champs du contexte de déploiement (nom, depuis quand, à quoi il sert, quel type de déclencheur le renseigne) — dans cette entrée TODO en attendant mieux, à terme dans `fonctionnelles-ia_specs`. Champs connus à ce jour : `trigger_name`/`phrase_originale`/`triggered_at`/`macros`/`entites`/`heure`/`jour`/`date` (v1.0, tous triggers) ; `triggered_entity_id` (2026-08-03, uniquement pour un déclenchement `state_change` — voir `fonctionnelles-planificateur_specs` §6/§7).
- **Statut** : Non traité — liste à démarrer
- **Priorité** : Basse (confort de suivi, rien de cassé sans elle)

---

### 🟡 Services post-installation : recenser et rattacher toutes les fonctions dispersées de réinstallation HA — À concevoir
- **Demande utilisateur (31/08/2026)** : dresser la liste et organiser le déploiement de toutes les
  fonctions actuellement dispersées dans le projet qui concourent à réinstaller une HA complète
  (nouvelle version ou reconstruction totale à partir de zéro) — les rassembler plutôt que les
  laisser éparpillées.
- **Contexte déjà posé, à réutiliser plutôt que reconcevoir** : le sens exact de l'écran "Services
  post-installation" (`PostInstallManager.ts`/`HaPostInstallService.ts`) a déjà été précisé par
  l'utilisateur le 25/08/2026 — ce n'est PAS une simple liste d'automatisations pratiques, c'est
  censé être un **runbook complet** de reconstruction d'une HA depuis zéro, où toute étape non
  automatisable doit être documentée explicitement dans l'IHM (section "📋 Étapes manuelles
  restantes"), pas seulement notée dans ce TODO. Couvre aujourd'hui : MQTT, Whisper, Piper,
  openWakeWord, Ollama, + les étapes manuelles ESPHome documentées au 25/08 et 30/08. Voir aussi
  `RUNBOOK.md` (racine du dépôt, premier jet du 06/08/2026 : sauvegarde du parc + checklist HA,
  jamais relu/validé depuis).
- **À faire** : recenser TOUTES les fonctions de déploiement/installation dispersées dans le projet
  qui ne sont pas encore rattachées à cet écran ou à `RUNBOOK.md` — au minimum : déploiement des
  scripts scriptsha (script.*/automation.* embarqués), déploiement des écrans ESP (HAPLAN +
  poêle-display, `applications/espdisplay`), déploiement des agents distants (teleinfo RPi1,
  rpigpio mqtt-io, arexx BS500), import/synchronisation des helpers HA créés à la main (thermostats
  génériques, etc.), et toute autre étape identifiée en le faisant. Décider ensuite, item par item,
  ce qui doit être automatisé par le bouton "post-installation" vs simplement documenté à l'écran.
- **Étapes déjà identifiées à rattacher (liste à compléter au fil de l'eau)** :
  - **Bloc `http:` de `configuration.yaml` — `trusted_proxies` + `use_x_forwarded_for`**. Fait à
    la main sur ha2 le 01/09/2026 : ajout du reverse-proxy `192.168.1.167` (aucun bloc `http:`
    n'existait auparavant). Sans ça, HA journalise `http.forwarded ... your HTTP integration is
    not set-up for reverse proxies` et ignore les en-têtes `X-Forwarded-*` du proxy. Backup pris :
    `/docker/homeassistant/config/configuration.yaml.bak-2026-09-01_011515` sur ha2. À reproduire
    sur toute nouvelle instance HA placée derrière le proxy — candidat à l'automatisation (même
    mécanisme `check_config` + redémarrage conteneur que les autres écritures `configuration.yaml`
    de Services post-installation).
- **Statut** : Non traité — juste noté, recensement à faire
- **Priorité** : Moyenne

### 🟡 Services post-installation : ajouter l'intégration ESPHome — À concevoir
- **Constat (2026-08-25)**, en préparant le passage en production et le test réel des écrans HAPLAN
  (ESP32-S3) : `HaPostInstallService.ts` couvre MQTT/Whisper/Piper/openWakeWord/Ollama, mais pas
  l'intégration ESPHome elle-même — nécessaire pour que HA puisse lire/piloter chaque écran (device
  `homeassistant`/`homeassistant.service:` dans le YAML généré par
  `applications/haplan/tools/generate_esphome_floorplan.py`, voir son en-tête pour la confirmation
  qu'aucun token HA n'est jamais embarqué côté firmware — c'est HA qui se connecte VERS l'appareil).
  Ajoutée à la main dans HA en attendant (2026-08-25). ⭐ Documentée dans la section "Étapes
  manuelles restantes" de l'écran Services post-installation depuis le 25/08/2026 (voir
  `PostInstallManager.ts`) — objectif du projet : que l'écran capture TOUTE la mise en œuvre d'une
  HA reconstruite de zéro, automatisée ou non, pour ne rien oublier (précisé par l'utilisateur).
- **⭐ 30/08/2026, étape manuelle supplémentaire découverte** : ajouter l'appareil ESPHome dans HA ne
  suffit pas pour que le tap-to-toggle du plan fonctionne — case à cocher SÉPARÉE, décochée par
  défaut, à activer À LA MAIN pour CHAQUE appareil ESPHome qui envoie des `homeassistant.service:`
  (donc pour chaque écran HAPLAN) : Paramètres → Appareils et services → ESPHome → l'appareil →
  ⚙️ (Options) → "Autoriser l'appareil à effectuer des actions Home Assistant". Sans elle, les
  actions HA envoyées par l'appareil sont refusées SILENCIEUSEMENT (aucune erreur ni côté HA ni
  côté écran) — symptôme réel constaté : le plan s'affiche et se met à jour normalement (lecture
  seule fonctionne, cette case ne concerne qu'ENVOYER des actions), mais taper une icône ne fait
  rien du tout. Vérifié/corrigé en direct sur l'appareil "Plan HAPLAN" le 30/08/2026. À ajouter à
  la section "Étapes manuelles restantes" de `PostInstallManager.ts` en même temps que l'ajout de
  l'intégration ESPHome elle-même (même thème), et à automatiser plus tard si `installEsphome()`
  est un jour codé (voir "À faire" ci-dessous) — la case correspond à l'option `allow_service_calls`
  du config entry ESPHome côté HA.
- **Pourquoi pas codé tout de suite** : contrairement à Wyoming/Ollama/MQTT ci-dessus (flux
  `config_entries/flow` vérifiés en conditions réelles avant d'écrire le code, voir l'en-tête de
  `HaPostInstallService.ts`), le flux d'ajout ESPHome n'a pas été vérifié en direct — il implique
  potentiellement une découverte zeroconf/mDNS de l'appareil plutôt qu'un simple host/port, à
  confirmer contre une vraie HA avant d'écrire un handler `esphome` par simple analogie avec les
  autres (risque réel de deviner un flux faux, cf. la règle déjà établie dans ce fichier).
- **À faire** : vérifier manuellement le flux `config_entries/flow` avec `handler: 'esphome'` contre
  une HA réelle (probablement host+port comme Wyoming, éventuellement une étape de confirmation
  supplémentaire liée à la clé de chiffrement native déjà présente dans le YAML), puis ajouter
  `'esphome'` à `PostInstallServiceKind` + une méthode `installEsphome()` dans
  `HaPostInstallService.ts`, et l'entrée correspondante dans `PostInstallManager.ts` (UI).
- **Statut** : Non traité — ajout manuel en attendant
- **Priorité** : Basse (contournement manuel simple et déjà en place)

---

### 🟢 Services post-installation : groupe de notification "tous les téléphones" — Tranché : hors périmètre
- **Constat (2026-08-25)**, en corrigeant le script scriptsha "Rapport entités indisponibles/piles
  faibles" (`notify.mobile_app_TON_TELEPHONE`, placeholder à personnaliser par machine) : un seul
  téléphone existe aujourd'hui (`notify.mobile_app_telephone_de_didier`), donc l'appel direct
  suffit — mais dès qu'un deuxième arrivera, chaque script/automatisation visant "tout le monde"
  devra soit lister chaque service individuellement, soit passer par un groupe de notification HA
  (`configuration.yaml`, `notify: - platform: group ...`). ⭐ Documentée dans la section "Étapes
  manuelles restantes" de l'écran Services post-installation depuis le 25/08/2026 (voir
  `PostInstallManager.ts`) — même principe que l'entrée ESPHome ci-dessus : ne pas automatiser
  n'exempte pas de documenter l'étape sur l'écran, l'objectif étant de capturer toute la mise en
  œuvre pour ne rien oublier lors d'une reconstruction.
- **Décision (2026-08-25)** : dimotic-ha ne doit PAS écrire dans `configuration.yaml`, pour trois
  raisons — (1) mécanisme fondamentalement différent et plus risqué que les flux `config_entries/
  flow` déjà utilisés par Services post-installation : `configuration.yaml` est un fichier
  monolithique édité à la main par l'utilisateur, une fusion mal faite (ex: bloc `notify:` déjà
  existant écrasé au lieu d'être fusionné) peut casser tout le démarrage de HA, pas juste ce
  réglage ; (2) dimotic-ha n'a aujourd'hui aucun accès filesystem à HA (conteneur séparé) — il
  faudrait un nouveau mécanisme SSH+fusion prudente, plus complexe que mosquitto.conf déjà géré
  par `HaStackDeployService` (fichier de conf simple, pas un YAML aussi personnalisable) ;
  (3) faible valeur d'automatisation — contrairement à MQTT/Whisper/Piper (à refaire à chaque
  nouvelle machine/site), un groupe de notification se règle une seule fois pour toute une
  installation HA. À faire à la main dans HA, comme documenté dans l'échange qui a donné lieu à
  cette entrée (déclaration `notify: - platform: group ...` exacte).
- **Statut** : Tranché — restera manuel
- **Priorité** : N/A (pas une tâche à reprendre)

---

### 🟡 Interpréteur déterministe ia : gabarits restants + points non vérifiés en réel
- **Constat (2026-08-26)** : implémenté et vérifié en conditions réelles (voir
  `fonctionnelles-ia_specs_v1.10.md` §16, commits `2d9ba54`/`fd2835e`/`b2ee1c4`) — "allume/éteins
  le salon" cible bien les mêmes entités HA que le chemin Mistral, 0 token consommé, ~26ms au lieu
  de ~1,5-2s. **Jeu d'essai permanent** : `applications/ia/interpreter/tester.mjs` (44 cas, corpus
  fictif indépendant de l'état HA réel — `node interpreter/tester.mjs` après `npm run build`). Le
  moteur générique (DSL + matching) est complet ; seule une partie des gabarits `modelesv2.js` a
  été portée en YAML (`ordre_immediat`, `ordre_valeur`, `dans`, `attendre`, `a`, `pendant`,
  `touslesjours`, `touslesjourssemaine`, `leweekend`, `si_alors`).
- **Résolu le 26/08/2026 (session suivante, demande utilisateur)** : "attendre X" seul (usage
  macro réel : "allume le salon. attendre 3 heures. éteins le salon.", trois phrases séparées) est
  désormais reconnu comme un pas d'attente autonome, assemblé avec les autres énoncés de l'envoi
  en UNE commande `execution` (`ExecutionStep[]` plat, le seul type de premier niveau que
  `handler.ts` exécute immédiatement — vérifié dans le code avant d'implémenter, `sequence` n'existe
  qu'imbriqué). **Vérifié en réel** : "allume le salon. attendre cinq secondes. eteins le salon."
  → lumière allumée puis éteinte exactement 5s après, via `ExecutionEngine.executeSteps()` côté
  `planificateur` (pas juste reconnu : réellement exécuté avec la bonne temporisation). Deux vrais
  bugs du moteur trouvés en construisant le jeu d'essai et corrigés au passage (commit `fd2835e`) :
  un mot littéral lui-même ignorable (ex. "les") n'était jamais matché ; `<valeur>` rejetait les
  décimaux ("20.5").
- **Résolu le 26/08/2026 (session suivante encore)** : gabarits restants portés
  (`fonctionnelles-ia_specs_v1.11.md` §16.4, commit `dfb127c`) — `jusqua`/`de` fusionnés dans `a`
  (mêmes alternatives de surface), `entre <heure> et <heure>` (fenêtre, `trigger.type: 'window'`,
  déjà supporté par `scheduler.ts`), `donne` (interrogation, routée vers la résolution d'entités
  existante, pas un portage de `donnemoi.js`), exclusion `sauf <lieu>*` intégrée à `ordre_immediat`
  (pas un gabarit séparé). Corpus de test étendu à 53 cas. **Vrai bug trouvé en testant en direct** :
  une exclusion vidant entièrement une liste de lieux explicitement nommés ("allume le salon sauf le
  salon") produisait `lieux: []`, que `HaStructureRegistry.getEntitiesByQuoiAndLieux` traite comme
  "aucun filtre" — a réellement ciblé TOUTE la maison au lieu de rien. Corrigé : repli Mistral dans
  ce cas précis. **Cache des 100 dernières phrases + comptabilisation cache/interpréteur/Mistral**
  livré dans la même session (`PhraseCache`/`InterpreterMetrics`, partagés entre `IaService` et
  `DeployResponder`, gelés pendant un échange d'assistance Mistral en cours via `isFreshExchange()`)
  — voir §16.10 de la spec.
- **Résolu le 26/08/2026 (session suivante encore) — nouveau gabarit `soleil`** (demande
  utilisateur explicite : "le lever et le coucher de soleil sont utilisés dans toutes les
  implémentations de ma domotique, sauf chez moi") : `fonctionnelles-ia_specs_v1.12.md` §16.4 +
  `fonctionnelles-planificateur_specs_v1.10.md` §3.1bis. Plus "hors périmètre" — nouveau
  `trigger.type: 'sun'` côté `planificateur`, calcul réel via `suncalc` (nouvelle dépendance,
  position GPS lue une fois depuis HA elle-même via nouveau `HaBridgeClient.getHaConfig()`), pas
  juste `sun.sun` de HA (insuffisant combiné à un filtre de jours restrictif — voir la spec pour le
  raisonnement complet). Gabarit `soleil` composable avec les fragments de jours existants (ex. "le
  week end une heure après le coucher du soleil ferme le volet" — l'exemple exact donné par
  l'utilisateur). **Deux vrais bugs trouvés et corrigés en préparant ce gabarit** :
  jour/`<enum:jour>`/`<enum:week_end>`/`<enum:jours_ouvres>` capturaient des noms de jours
  FRANÇAIS alors que `scheduler.ts::triggerToMs` (et `regles_mistral.txt`) attendent des clés
  ANGLAISES 3 lettres (`mon`/`sat`/...) — tout filtre de jour produit par l'interpréteur était
  silencieusement inopérant depuis son introduction ; `touslesjours`+`jours_ouvres` ne posait même
  aucun filtre du tout (capture sous la mauvaise clé, `#jours` manquant). Corpus de test étendu à 58
  cas. **Validé par test unitaire déterministe** (marche jour-par-jour/offset/filtre de jours de
  `triggerToMs`, 9 cas ; sanity-check `suncalc` réel contre Paris) — **le round-trip complet
  `getHaConfig()` → position GPS réelle de l'installation HA n'est pas encore confirmé en conditions
  réelles** : un redémarrage local a rencontré la course démarrage/authentification WS déjà connue
  ("Cannot get config: not authenticated"), mécanisme de nouvel essai automatique ajouté en
  conséquence mais pas encore re-déclenché avec succès faute d'un trigger `sun` existant. Volontairement
  pas de planification réelle créée pour tester bout-en-bout (même prudence que `si_alors`) — à
  faire avec l'utilisateur au retour.
- **Reste hors périmètre, confirmé (pas juste différé)** : `delayrepeat` ("toutes les X") —
  `trigger.every` existe dans le schéma `triggerSchema` mais n'est lu nulle part dans `triggerToMs`.
  L'implémenter demande de câbler un vrai mécanisme d'intervalle répétitif côté `planificateur`
  d'abord, pas seulement d'ajouter un gabarit ici — à traiter comme un chantier séparé si le besoin
  se confirme.
- **À faire** :
  - Factoriser le sous-motif dupliqué "heure" entre `a`/`entre` en un gabarit privé réutilisable —
    actuellement laissé dupliqué faute de temps, pas un blocage.
  - `pendant <duree> (a <duree>)?` (durée d'exécution avant réaction inverse, distinct du "attendre"
    déjà résolu) pourrait maintenant réutiliser le même mécanisme d'assemblage `execution`
    (action → wait → action inverse) — pas encore fait, capturé mais sans effet exploitable pour
    l'instant.
  - `si_alors` et les gabarits de planification (`dans`/`touslesjours`+`a`/`entre`) sont validés par
    des tests unitaires isolés (`tester.mjs`, tous corrects) et par une vérification structurelle du
    code, mais **pas encore testés en réel contre `planificateur`** (contrairement à
    `ordre_immediat` et à la séquence action/wait/action, testées en direct) — volontairement,
    pour ne pas créer de vraie planification/déclencheur dans les données de l'utilisateur sans
    lui. À tester en priorité au retour.
  - Le chemin `DeployResponder` cache→interpréteur→Mistral (réinterprétation d'un déclenchement
    planifié) est câblé et type-vérifié mais **jamais testé en réel** — nécessiterait un vrai
    déclenchement planifié qui se déclenche pendant une session observée.
  - `context.lieuOrigine` (§16.6 de la spec) : crochet posé, mais aucune source réelle ne le
    renseigne encore (device_id du satellite Assist non transmis jusqu'à `ia` aujourd'hui) — à
    examiner séparément si le besoin se confirme.
  - Trigger `sun` : confirmer en réel que `getHaConfig()` résout bien la position GPS réelle de
    l'installation HA de l'utilisateur (pas juste le mécanisme de nouvel essai, jamais encore
    observé réussir), puis créer UNE planification `sun` réelle avec l'utilisateur pour valider le
    bout-en-bout (reconnaissance + `next_fire_at` calculé correctement) avant de considérer le
    gabarit pleinement livré.
- **Résolu le 27/08/2026 (session suivante) — lieu unique déduit du `quoi`**
  (`fonctionnelles-ia_specs_v1.13.md` §16.6bis, commit `a305f34`) : "allume le poêle" (sans lieu)
  cible désormais automatiquement le lieu du poêle si l'installation n'en a qu'un seul (niveau
  `lieu_principal`, pas `lieu_precis`), prioritaire sur `context.lieuOrigine`. Vérifié en conditions
  réelles : `lieux:["salle à manger"]`, 0 token. Corpus étendu à 59 cas.
- **Statut** : Moteur déterministe + cache/métriques + trigger `sun` + lieu unique du `quoi` livrés
  et vérifiés (unitairement pour `sun` — `getHaConfig()` en conditions réelles et
  `si_alors`/planification via `DeployResponder` restent à confirmer en conditions réelles avec
  l'utilisateur)
- **Priorité** : Moyenne (le sous-ensemble déjà livré couvre déjà le cas d'usage le plus fréquent)

### 🟢 Socle : visibilité multi-machines intra-site + page d'accueil — Implémenté et vérifié
- **Constat (2026-08-27)** : demande utilisateur — la diffusion par Docker empêche les tests/
  corrections ponctuelles sans reconstruire toute l'image, et créer une nouvelle application se
  fait sur une plateforme de dev non dockerisée. Discuté en session en mode plan (plusieurs allers-
  retours pour clarifier la portée — voir `fonctionnelles-supervisor_specs_v2.8.md` §14bis.1 pour le
  détail) : traité en deux temps, **cette partie couvre uniquement la visibilité**.
- **Livré** (`fonctionnelles-supervisor_specs_v2.8.md` §14bis, commits `7aa1a86`) : `AppGossipService`
  (registre d'applications par gossip MQTT, même patron que `TargetGossipService`), entrées
  distantes affichées en lecture seule à côté du menu existant (redirection simple au clic, pas de
  proxy), nouveau lien HA local, nouvelle liste personnelle de sites externes jamais gossipée
  (`core.externalSites` — une seule adresse par entrée, le site distant affiche déjà son propre lien
  HA une fois qu'on y accède), nouvelle page d'accueil par défaut (`HomeView.ts`).
- **Deux vrais bugs trouvés et corrigés en testant** : `ModuleManager.ts` avait sa propre logique
  dupliquée de sélection du module par défaut, qui écrasait systématiquement "accueil" juste après
  (constaté au navigateur : atterrissait sur `arbreouquoi`) — supprimée. `ConfigService
  .setDisabledApps()`/`saveConfig()`/`clearHaWsToken()` perdaient déjà silencieusement
  `zigbee2mqttTargets` (même classe de bug que l'incident `disabledApps` du 07/08/2026) — corrigé au
  passage.
- **Vérifié en conditions réelles** : publication/fusion du registre confirmée sur le broker MQTT
  réel (`mosquitto_sub`, simulation d'une seconde machine), et au navigateur (page d'accueil par
  défaut, lien HA correct, ajout/suppression d'un site externe, navigation retour vers Accueil).
- **Hors périmètre, différé explicitement** : le besoin d'origine (une application modifiée hors
  Docker remplace celle qui est dockerisée) — à reprendre en session dédiée, une fois cette base en
  place. WireGuard lui-même (infrastructure réseau) reste hors du dépôt de code.
- **Priorité** : Moyenne (base posée, le besoin d'origine qui a motivé la discussion reste à traiter)

### 🟢 TargetGossipService : pas de mise à jour ni de suppression d'une cible déjà apprise — Implémenté
- **Trouvé en passant (31/08/2026)** : l'IP d'`orangepi` a changé le 30/08/2026 (192.168.1.32 →
  192.168.1.130, DHCP/routeur — voir commentaire dans `docker/rebuild-and-deploy.sh`) mais le
  `target` gossipé pour `orangepi` dans `data/core/config.yaml` de `ha2` **et** `stfort` pointe
  toujours vers l'ancienne IP — les liens "Applications sur les autres machines" vers orangepi
  depuis la page d'accueil de ces deux machines sont cassés (orangepi lui-même reste joignable
  directement à la nouvelle IP ; `falbala`, source de cette cible, a déjà la bonne IP en local).
- **Cause racine confirmée dans le code** (`TargetGossipService.mergeTargets()`) : la fusion
  n'ajoute une cible reçue par gossip **que si son hôte est totalement inconnu**
  (`!knownHosts.has(t.host)`) — aucun chemin ne met à jour l'hôte d'une cible déjà apprise
  (identifiée par `{machine source}::{id local}`) quand la machine source republie avec un hôte
  différent. Un changement d'IP côté source ne se propage donc jamais aux autres machines déjà
  informées de l'ancien hôte.
- **Demande utilisateur (31/08/2026), scope élargi au-delà du seul cas IP** : le mécanisme a besoin
  de fonctionnalités d'**absence constatée** — détecter qu'une cible précédemment gossipée n'est
  plus annoncée par sa machine source (pas seulement "IP changée", aussi "machine éteinte/retirée
  pour de bon") —, avec possibilité de **suppression** (locale, ou déclenchée), et **propagation**
  de cette suppression aux autres machines du réseau gossip. Aujourd'hui le protocole est purement
  additif (aucune notion de retrait/tombstone) — un target appris ne disparaît jamais tout seul,
  même si sa machine source ne le republie plus.
- **À concevoir** : mécanisme de mise à jour en place (upsert par `{machine source, id local}`
  plutôt que par nouveauté d'hôte), + une forme de "dernière annonce vue" par cible pour détecter
  l'absence (LWT MQTT par machine ? réannonce périodique avec horodatage, cible retirée après N
  cycles sans nouvelle annonce ?), + message de retrait explicite propagé (tombstone) pour une
  suppression volontaire distincte d'une simple absence temporaire. Voir aussi le patron
  `registered-devices`/RFXCOM (§9.4) déjà retenu ailleurs dans le projet pour un problème apparenté
  (revendication/désistement d'un device) — pourrait inspirer la conception ici.
- **⭐ 31/08/2026, contournement appliqué pour le cas orangepi précis** : supprimé `falbala::orangepi`
  (192.168.1.32) via l'UI Déploiement sur `ha2` ET `stfort`, ajouté `orangepi` (192.168.1.130) en
  cible locale sur `ha2` — `stfort` a immédiatement réappris la bonne IP par gossip (`ha2::orangepi`)
  sans action supplémentaire, confirmant que le mécanisme fonctionne bien pour une cible réellement
  nouvelle (seul le cas "même source+id, hôte différent" reste cassé, voir ci-dessus). Les deux
  machines ont maintenant la bonne IP — ne règle que ce cas précis, pas le mécanisme lui-même.
- **⭐ 31/08/2026, conçu puis implémenté le même soir** (voir /home/didier/.claude/plans/
  smooth-wiggling-blum.md pour la conception détaillée) — décisions utilisateur tranchées avant
  d'écrire le code :
  1. **Réconciliation automatique tant que la source est vivante** — pas besoin de nouveau
     message : chaque annonce `known-targets` est déjà un instantané COMPLET des cibles locales de
     la source, pas un diff. `mergeTargets()` réécrit en upsert (par `{sourceMachineId}::{id}`) +
     suppression de toute cible apprise de cette source absente de l'annonce reçue. Couvre à la
     fois le changement d'IP (le bug d'origine) et une suppression volontaire à la source.
  2. **Présence via LWT MQTT natif** (`willTopic` — déjà pleinement supporté par `MqttTransport`,
     jamais utilisé jusqu'ici pour ce canal ; même patron que `rfxcom/{bridgeInstance}/status`) sur
     `dimotic/core/{machineId}/status`. Une machine qui devient silencieuse est une **anomalie
     signalée** (`core:machine:status:list`, badge "⚠️ Injoignable" sur ses cartes) — **jamais une
     suppression automatique**, décision explicite de l'utilisateur.
  3. **Suppression définitive = décision humaine** — bouton "🧹 Purger cette machine" sur les
     cartes gossipées (`TargetCards.ts`/`DeploymentManager.ts`), publie un tombstone retenu
     (`dimotic/core/{machineId}/removed`) + nettoie les topics retenus de la machine disparue ; tout
     pair qui reçoit ce message supprime localement.
  - Bug distinct trouvé et corrigé au passage : `AppService.ts` tronquait déjà le champ `origin`
    avant d'envoyer les 3 listes de cibles au navigateur (jamais exploitable côté UI, silencieux).
  - **Vérifié** : 13 nouveaux tests unitaires (`TargetGossipService.test.ts`), dont le test de
    régression exact du bug d'origine (mise à jour d'hôte en place) — build core + build:ui propres,
    suite complète 139 verts (126 avant), aucune régression. **Non encore vérifié en conditions
    réelles sur le parc ha2/stfort/orangepi** (pas déployé ce soir) — à faire au prochain
    déploiement : confirmer les topics `status` retenus sur le broker, tester une vraie coupure
    (badge sans suppression), tester une vraie purge (propagation + nettoyage broker confirmés).
- **Statut** : Implémenté et testé unitairement (2026-08-31) — vérification en conditions réelles
  (parc ha2/stfort/orangepi) à faire au prochain déploiement
- **Priorité** : Résolu (sous réserve de la vérification terrain)

### 🟢 Page d'accueil : couleur des liens (bleu) peu lisible sur le thème sombre — Corrigé
- **Signalé (28/08/2026)** par l'utilisateur : sur la page "Accueil" (`HomeView.ts`), la couleur bleue
  par défaut des liens (HA, sites externes, applications sur les autres machines) rend le texte
  difficile à lire sur le fond sombre de l'interface.
- **Corrigé (31/08/2026)** : nouvelles variables `--color-link`/`--color-link-visited` dans
  `main.css` (`:root`), règles `a`/`a:visited`/`a:hover`. **Deux endroits nécessaires, pas un
  seul** — la règle globale de `main.css` ne suffit pas pour la page Accueil, rendue à l'intérieur
  du Shadow DOM de `ModuleContainer.ts` (encapsulation : les règles de style ne traversent pas la
  frontière, seules les variables CSS personnalisées le font) — ajoutée donc aussi en scoped dans
  le `<style>` de `ModuleContainer.ts`, via `var(--color-link)` pour rester cohérent avec la
  palette définie une seule fois dans `main.css`.
- **Statut** : Corrigé (2026-08-31)
- **Priorité** : Résolu

### 🟡 Nommage : collision `nommage-main` sur MQTT — cause exacte non identifiée
- **Découvert (28/08/2026)** en diagnostiquant l'épuisement des descripteurs de fichiers de
  mosquitto sur `ha2` (voir incident du même jour) : le journal mosquitto (non purgé, 3 jours
  d'historique) contenait **14 346 "session taken over"** entre le 25/08 12:01 et le 28/08 09:50,
  quasi exclusivement `arexx-arexx_bridge_199931` et `nommage-main` — un rythme moyen d'environ une
  collision toutes les 17s, en continu, jamais reproduit depuis (stable sans interruption depuis
  09:50, y compris à travers deux redémarrages mosquitto ultérieurs le même jour).
- **Cause technique confirmée pour `nommage`** : `NommageService.ts:45`,
  `const BRIDGE_INSTANCE = 'main'` — codé en dur, jamais randomisé ni persisté par machine
  (contrairement à rfxcom/arexx/rpigpio, qui génèrent et persistent un identifiant aléatoire
  au premier démarrage — ⭐ 31/08/2026, correction en revue : teleinfo n'a en fait aucun concept de
  bridgeInstance, mention initiale inexacte, sans impact sur le diagnostic ci-dessous). Deux
  instances de `nommage` actives en même temps produiraient donc
  *garanti* le même client MQTT et se battraient en boucle pour la session.
- **Vérifié** : `nommage` n'est actuellement activée que sur `ha2` (désactivée sur orangepi, stfort,
  et la machine locale) — pas de collision inter-machines *en ce moment*. La cause exacte de
  l'épisode des 3 jours reste donc non expliquée (pas de trace exploitable : `data/*/config.yaml`
  gitignored, aucun historique pour vérifier si `nommage` a été activée ailleurs pendant cette
  fenêtre).
- **Décision (28/08/2026, discuté avec l'utilisateur)** : ne pas juste randomiser `BRIDGE_INSTANCE`
  comme les autres apps — `nommage` est conceptuellement un service **unique pour tout le site** (pas
  lié à du matériel spécifique comme rfxcom/arexx), donc une collision signifierait une vraie erreur
  de configuration (activée à deux endroits), pas un besoin légitime de plusieurs instances.
  Randomiser masquerait le symptôme sans traiter la cause.
- **Piste retenue à la place** : `nommage` détecte elle-même qu'une session existe déjà sous
  `nommage-main` avant de se connecter, et refuse de démarrer avec une erreur claire — rend l'erreur
  de configuration immédiatement visible au lieu de dégrader silencieusement le broker pendant des
  jours. Pas encore implémenté.
- **Statut** : Non traité — cause de fond non identifiée, piste de correctif discutée mais pas codée
- **Priorité** : Moyenne (pas actif actuellement, mais a contribué à un vrai incident — épuisement
  des descripteurs mosquitto sur `ha2` le 28/08)

---

## Notes techniques

### Package npm utilisé
- **Nom** : `rfxcom`
- **Version** : v2.6.2 (d'après specs-implementation-rfxcom_specs_v1.0.md)
- **Vérification** : Voir `src/applications/rfxcom/domain/RfxComService.ts` ligne 30 : `import * as rfxcomLib from 'rfxcom';`
- **Confirmation** : ✅ Oui, le package npm utilisé est bien `rfxcom`

### Utilisation dans le code
```typescript
import * as rfxcomLib from 'rfxcom';
// puis
this.transceiver = new rfxcomLib.RfxCom(serialPort, options);
```

---

## Historique des commits récents
- `1e84707` - Fix perte de focus lors de la saisie dans ConfigForm
- `9ba5658` - Correction sauvegarde automatique ConfigForm et gestion des champs modules  
- `32543ab` - Correction démarrage automatique RFXCOM et injection IAppConfigProvider
