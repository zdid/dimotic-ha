# Spécifications Fonctionnelles - Sauvegarde/Restauration (SAUVEGARDE)

**Version 1.0 — 16/09/2026 — Claude**

Statut : **conception, discussion seulement — aucun code écrit**. Première version de cette spec,
extraite d'une discussion avec l'utilisateur ce jour, elle-même issue d'un point de résilience laissé
ouvert dans `fonctionnelles-supervisor_specs_v2.8.md` §6.4 et suivi jusqu'ici uniquement dans
`TODO.md` ("🟡 Sauvegarde/duplication multi-machines de HA lui-même").

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
  répertoire couvert par la sauvegarde elle-même (§4) — ex. `/docker/.secrets/nextcloud-backup` —
  permissions restrictives (`chmod 600`, lisible seulement par l'utilisateur qui exécute le script
  hôte, voir §5bis). Choix structurel plutôt qu'une exclusion à maintenir dans une liste (§4bis) : le
  secret n'est simplement jamais sous un chemin que le script parcourt, donc rien à exclure. Ce même
  fichier est la source pour le script hôte (§5bis) **et** pour l'application dimotic-ha (§6) — un
  seul exemplaire du secret par machine, pas deux copies à maintenir en cohérence.
- **Jamais dans `data/<app>/config.yaml`** de l'application dimotic-ha dédiée (§6) : sa config ne
  garde qu'une **référence** (chemin vers le fichier ci-dessus), jamais la valeur elle-même — sans
  quoi le mot de passe se retrouverait lui-même inclus dans le contenu de la sauvegarde `dimotic-ha`
  poussée vers Nextcloud (§4), un comble pour un secret qui sert justement à y accéder.
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

## 4. Unité de sauvegarde et structure de dossiers — reconçu (16/09/2026)

⭐ **Reconception explicite, en remplacement de la version précédente de cette section** (qui
distinguait HA / dimotic-ha / services externes comme trois catégories différentes). Point de départ :
**il peut exister plusieurs instances du même logiciel** (deux zigbee2mqtt, deux dimotic-ha...), et la
convention déjà en place sur toutes les machines les distingue déjà par **le nom de leur répertoire de
déploiement** (`/docker/<nom>/`, un répertoire par instance Docker — voir `docker/deploy-remote.sh`,
`REMOTE_DIR=/docker/dimotic-ha` etc.). Cette réalité déjà sur le disque devient la seule clé
d'organisation de la sauvegarde, remplaçant toute catégorisation par "type" :

- **L'unité de sauvegarde est le répertoire de déploiement entier**, pas seulement son sous-dossier de
  données : `compose.yaml` inclus s'il y en a un, `data/` inclus, tout ce qui s'y trouve — moins les
  fichiers à exclure au cas par cas s'il y en a (§4bis). Ça règle en même temps la portée HA,
  dimotic-ha (qui n'est déjà qu'**un seul** répertoire Docker contenant tous les `data/{app}/` — plus
  besoin de les lister séparément) et tout service tiers (zigbee2mqtt, modbus2mqtt...) avec un seul
  mécanisme.
- **⭐ Généralisé au-delà de Docker (16/09/2026, point soulevé par l'utilisateur)** : "répertoire de
  déploiement" plutôt que strictement "répertoire Docker" — certains modules dimotic-ha ne tournent
  pas en Docker sur toutes les machines :
  - **rpigpio via mqtt-io** : reste un vrai répertoire Docker (`/docker/mqttio-rpigpio/` par ex.),
    déjà couvert sans rien de spécial — juste un répertoire de plus dans la liste (voir l'arborescence
    ci-dessous).
  - **teleinfo sur RPi1** : **pas de Docker du tout** — l'agent (`device-agent/ha-publisher.js`,
    `fonctionnelles-supervisor_specs_v2.8.md` §11.5) est un répertoire de déploiement classique
    (systemd) sur le disque de la machine. Même mécanisme générique (§5bis le prévoit déjà : le script
    tourne au niveau de l'hôte, "en dehors de tout conteneur" pour ce cas précis) — juste un
    répertoire de plus, non-Docker, à couvrir sur ces machines contraintes.
  - Principe général : **tout répertoire de déploiement identifiable sur une machine** (Docker ou non)
    est une unité de sauvegarde candidate — pas seulement ceux qui ont un `compose.yaml`.
- **Aucune catégorisation par type** (HA/dimotic-ha/externe) dans l'arborescence — juste le nom réel
  du répertoire tel qu'il existe sur la machine. Une deuxième instance du même logiciel (répertoire au
  nom différent, ex. `/docker/dimotic-ha-2/`) se sauvegarde naturellement sous son propre chemin, sans
  rien de spécial à prévoir.

### 4ter. Harmonisation des emplacements de déploiement — tranché (16/09/2026)

⭐ Constat en creusant §4, vérifié dans le code réel (`config-schema.ts` de chaque app) et en direct
sur les machines de production (`docker inspect`, stfort **et** noisy) :

- **Docker, déjà cohérent** : dimotic-ha, rpigpio (via mqtt-io), HA, zigbee2mqtt, modbus2mqtt vivent
  tous sous `/docker/<nom>/` — confirmé en direct pour rpigpio (`/docker/mqttio-rpigpio/config.yml`
  sur les deux machines testées). Rien à changer ici.
- **Hors Docker, dispersé** : teleinfo (`/opt/teleinfo`, défaut du schéma) et arexx
  (`/root/arexx-drivers`, défaut du schéma) — deux emplacements différents, ni l'un ni l'autre
  regroupé avec le reste.

**Décision** : un second parent dédié, **`/dimotic-ha-addons/`** (à la racine, comme `/docker/` —
pas niché sous `/root/`), pour tout agent géré par dimotic-ha qui **n'est pas** Docker (teleinfo,
arexx, et tout futur agent du même genre). Résultat : deux conventions parallèles et propres au lieu
de trois emplacements dispersés — `/docker/<app>/` pour ce qui est Docker, `/dimotic-ha-addons/<app>/`
pour les agents bruts (systemd/RPi contraint) — plutôt qu'un seul parent unique qui mélangerait les
deux natures de déploiement sous un nom trompeur.

**Bénéfice direct pour cette spec** : le script de sauvegarde (§5bis) peut **énumérer** le contenu de
ces deux parents plutôt que de connaître une liste de chemins en dur par application — cohérent avec
le principe déjà posé "un seul script générique, réutilisé sans code spécifique par répertoire" (§5).

**Portée du changement** : nouveau défaut pour les **futures** cibles teleinfo/arexx uniquement
(`config-schema.ts`, `remoteDir`) — pas de migration rétroactive des instances déjà en production
(même principe que le changement de défaut `bridgeInstance`, déjà appliqué ailleurs dans le projet).
Implémentation (changement des défauts) non faite dans cette session — à faire séparément, hors
périmètre de cette spec elle-même.

```
<racine Nextcloud>/
  <site>/
    <machine>/
      <répertoire-de-déploiement>/  (ex. dimotic-ha, homeassistant, zigbee2mqtt, modbus2mqtt,
                                      mqttio-rpigpio [tous /docker/<nom>/ sur la machine],
                                      teleinfo, arexx-drivers [/dimotic-ha-addons/<nom>/, non-Docker]...)
        courant.tar.gz
        mensuel/
          2026-09.tar.gz
          2026-08.tar.gz
          ...
```

Un dossier par site (`stfort`, `noisy`), un sous-dossier par machine (`ha2`, `orangepi`, `stfort`,
`noisy`, `noisy2`), puis **un sous-dossier par répertoire de déploiement réel** présent sur cette
machine (Docker ou non, voir ci-dessus) — autant de sous-dossiers que d'instances à couvrir, chacun
nommé d'après son répertoire d'origine.

**Deux cadences tranchées (16/09/2026), à l'intérieur de chaque dossier `<répertoire-docker>/`** :

- **Courant** (`courant.tar.gz` ou nom équivalent fixe) : écrasé à chaque poussée régulière — pas de
  différentiel construit par nous (§3ter), historique fin disponible nativement via les versions
  Nextcloud si besoin.
- **Mensuel, nommage daté** (`mensuel/AAAA-MM.tar.gz`, ex. `2026-09.tar.gz`) : un fichier par mois,
  poussé une fois par mois (ex. le 1er). **Décision explicite (16/09/2026)** : nommage horodaté par
  année-mois plutôt qu'un simple numéro de mois (01-12) réutilisé chaque année — l'utilisateur veut
  une clarté absolue en cas de restauration sous pression ("est-ce bien celle de cette année ?"),
  quitte à ajouter une étape de purge explicite plutôt que de compter sur un écrasement implicite.
  **Rotation 12 mois glissants** : au moment de pousser le mois courant, supprimer (requête WebDAV
  DELETE) le fichier du **même mois, année précédente** (ex. en pousser `2026-09.tar.gz`, supprimer
  `2025-09.tar.gz` s'il existe) — nom du fichier à supprimer calculé déterministiquement, pas de
  liste/scan du dossier nécessaire. Toujours exactement 12 sauvegardes mensuelles conservées, sans
  ambiguïté sur leur date.

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

**Risque de snapshot incohérent sur une base SQLite active (ex. `home-assistant_v2.db`) — résolu,
pas seulement accepté (16/09/2026)** : plutôt que de garder ce risque en l'état, utiliser la commande
de sauvegarde native de SQLite (`sqlite3 home-assistant_v2.db ".backup <chemin-cible>"`) à la place
d'une copie de fichier brute (`cp`/inclusion directe dans le `tar`) pour ce fichier précis — elle
produit un instantané transactionnellement cohérent même avec des écritures concurrentes, sans arrêter
HA ni exclure la base. Coût : `sqlite3` (CLI) doit être présent sur l'hôte (paquet standard, léger) —
à vérifier/installer à l'implémentation si absent. Le reste du répertoire continue d'être copié
brutalement (§4bis ci-dessus) — seul ce fichier précis bénéficie d'un traitement spécial, pas une
remise en cause du principe général de copie brute. Voir aussi §5 (horaire nocturne) qui réduit encore
la probabilité de conflit, en complément de cette solution plutôt qu'à sa place.

**Restauration HA** : reste une procédure documentée/semi-assistée plutôt qu'un bouton "restaurer" en
un clic pour ce cas précis — HA Core (installation utilisée aujourd'hui, sans Supervisor) ne peut pas
se remplacer proprement en live via son propre mécanisme natif. Sans objet pour la restauration par
copie brute d'un répertoire entier pendant que le conteneur est arrêté (voir §6) — HA Supervised
reste écarté pour ce seul bénéfice (changement d'infrastructure disproportionné).

## 5. Fréquence, déclenchement, rotation — tranché (16/09/2026)

**Rotation** (voir §4) : "courant" repose sur l'historique de versions natif Nextcloud (rien à
construire), "mensuel" par suppression déterministe du même mois l'année précédente à chaque poussée
(toujours 12 mois glissants).

**Fréquence "courant"** : hebdomadaire garanti (jour à définir), **plus quotidien si changement
détecté**.

**Horaire — fenêtre nocturne de faible activité (⭐ demande explicite, 16/09/2026)** : déclencher
pendant une plage nocturne où l'activité réelle du foyer est la plus basse (certaines heures de la
nuit sont identifiées comme inactives) — réduit encore la probabilité de conflit sur un fichier actif
au moment de la copie, en complément de la solution SQLite (§4bis) plutôt qu'à sa place, et limite
toute interférence avec un usage réel en cours. Heure exacte non fixée dans cette version (dépend du
rythme réel du foyer) — même cadran horaire pour "courant" (quotidien si déclenché) et "mensuel".

**Détection de changement — mécanisme unique et générique, décentralisé (pas de message entre
machines)** :

- Comparaison de date de modification : `find <dossier> -newer <fichier-marqueur> -type f` — le
  marqueur (fichier vide) est retouché (`touch`) à chaque sauvegarde effectuée ; si `find` retourne au
  moins un résultat, quelque chose a changé depuis la dernière fois. Choisi plutôt qu'un hachage :
  aucun outillage supplémentaire, marche tel quel sur le RPi1 le plus contraint.
- **Un seul script générique, réutilisé sans code spécifique par répertoire** — appelé une fois par
  répertoire de déploiement à couvrir sur la machine (§4), avec une exclusion de scan **optionnelle**,
  propre à ce répertoire si besoin (même liste que les exclusions de contenu, §4bis, mais peut en
  différer : un fichier peut rester dans la sauvegarde tout en étant ignoré du scan de détection) :
  - Exemple type — répertoire HA : `home-assistant_v2.db*` exclue du **scan de détection**
    uniquement (elle reste copiée dans le contenu de la sauvegarde une fois déclenchée, §4bis) — sans
    cette exclusion, la base s'écrivant en continu dès que HA tourne normalement, le scan verrait
    "changement" tous les jours systématiquement, rendant la distinction hebdo/quotidien sans objet.
    Un ajout/suppression d'entité côté dimotic-ha se reflète dans `.storage/` de toute façon
    (découverte MQTT), donc ce signal capte indirectement une bonne partie des changements pertinents
    ailleurs dans le système.
  - Exemple type — répertoire dimotic-ha, zigbee2mqtt et similaires : **sans exclusion** — accepté que
    des logiciels à état fréquemment mis à jour dans un fichier unique mêlant vraie config et données
    volatiles (ex. rfxcom : `lastSeen`/`lastPosition`/`lastValue` mêlés à la config des récepteurs ;
    zigbee2mqtt : `database.db` mis à jour en continu par l'activité normale du réseau) déclenchent une
    sauvegarde quotidienne quasi systématique en usage normal. Jugé acceptable (pas de tri fin
    possible/utile à l'intérieur d'un même fichier, et une sauvegarde "trop fréquente mais toujours à
    jour" n'est pas un problème vu l'absence de contrainte de stockage).
- **Décentralisé par construction** : chaque machine décide pour elle-même, localement, sans dépendre
  d'un signal émis par une autre machine ni d'un nouveau canal de coordination (MQTT ou autre) — cohérent
  avec le principe déjà appliqué ailleurs dans le projet (registre de présence décentralisé,
  `fonctionnelles-supervisor_specs_v2.8.md` §6.4).

**Déclenchement (création/poussée)** : cron sur chaque machine, via le script générique — **différé,
"voir plus tard"** (décision explicite 16/09/2026). Raison : le RPi1 ne peut pas faire tourner
dimotic-ha (`fonctionnelles-supervisor_specs_v2.8.md` §11 — matériel/runtime trop ancien), donc ce
mécanisme de création/poussée doit rester **indépendant de dimotic-ha**, autonome sur chaque machine
(y compris les plus contraintes) — pas piloté ni configuré depuis l'application §6. Jour/heure
exacts et détail du script non fixés dans cette version.

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

**Déploiement du script lui-même — greffé sur un mécanisme de poussée existant** (⭐ demande
explicite) : pas de nouveau système de déploiement à construire — la copie du script sur une machine
se fait **en même temps qu'un autre objet déjà poussé** sur cette machine par un mécanisme existant
(ex. `docker/rebuild-and-deploy.sh`/`deploy_to()` lors d'une mise à jour de version dimotic-ha, ou
`DriversBundle`/`DeployService` lors d'un "Générer et déployer" pour arexx/teleinfo/rpigpio) — un
fichier de plus copié au passage, pas une étape de déploiement séparée à déclencher.

### 5ter. Vérification et statut — tranché (16/09/2026)

⭐ Deux ajouts au script générique (§5bis), peu coûteux, pour éviter un échec silencieux :

- **Intégrité de l'archive avant poussée** : `tar -tzf <archive>` (test de lecture, sans extraire)
  avant tout `curl` — détecte une archive tronquée (ex. disque plein pendant la création) avant
  qu'elle n'écrase une bonne sauvegarde "courante" sur Nextcloud.
- **Vérification du résultat de la poussée** : contrôler le code retour HTTP de `curl` (pas seulement
  supposer que l'envoi a réussi) — un échec réseau/quota Nextcloud dépassé ne doit pas passer inaperçu.
- **Marqueur de statut local** (ex. `dernière-sauvegarde.json` : horodatage + succès/échec, par
  répertoire de déploiement couvert) — écrit par le script à chaque exécution, coût quasi nul puisqu'il connaît
  déjà ce résultat. Point d'accroche pour `fonctionnelles-supervision-externe_specs_v1.0.md` §4 (spec
  dédiée) : elle n'a qu'à lire ce fichier plutôt que d'inventer un nouveau protocole de statut de
  sauvegarde — pas de dépendance construite dans l'autre sens (ce script n'a besoin de rien de la
  supervision pour fonctionner).

## 6. Application dédiée dimotic-ha « Sauvegarde/Restauration » — configuration et restauration

⭐ Décision architecturale (16/09/2026) : une **nouvelle application dimotic-ha**, nommée
**« Sauvegarde/Restauration »** (⭐ nom tranché, 16/09/2026 — même intitulé que le titre de cette
spec), suivant le pattern standard des applications existantes (`guide-nouvelle-application_specs`,
même famille que `teleinfo`/`arexx`/`rpigpio` — config + `targets[]` propres à l'app, pas dans le
core), responsable de :

- **Configuration** : connexion Nextcloud (URL, référence au mot de passe d'application — voir §3),
  liste des répertoires de déploiement couverts (par site/machine, voir §4).
- **Restauration, pilotée depuis l'interface** (pas en ligne de commande) : l'utilisateur choisit un
  **répertoire de déploiement** à restaurer (HA, dimotic-ha, rpigpio, teleinfo, un service externe —
  même liste que §4, aucune distinction de traitement), une **date/version** parmi celles disponibles
  (courant, ou une des mensuelles — l'app doit lister ce qui existe réellement sur Nextcloud, pas une
  liste supposée), puis
  déclenche.
  - **Restauration croisée entre machines** (⭐ demande explicite) : la sauvegarde source (site/machine
    d'origine, voir arborescence §4) et la machine cible de la restauration sont deux choix
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

**Hors périmètre de cette app (différé, voir §5)** : la création/poussée des sauvegardes elle-même —
mécanisme indépendant, autonome par machine, car doit aussi fonctionner sur le RPi1 qui ne fait pas
tourner dimotic-ha. L'app lit ce qui existe déjà sur Nextcloud, elle ne le produit pas.

## 7. Hors scope de cette version

- Le mécanisme de **supervision/alerte** (détection qu'une sauvegarde a échoué ou n'a pas eu lieu)
  est traité séparément — voir `TODO.md`, "Supervision multi-sites indépendante + alerte hors HA"
  (conception du 16/09/2026, pas encore une spec dédiée).
- HA Supervised / réplication d'une instance de secours prête à prendre le relais — écarté pour
  l'instant (voir §5).

## 8. Plan de mise en œuvre (à faire)

Décisions de conception prises pour la destination/transport/cadences/portée (§2 à §5bis) et pour le
rôle de l'application dédiée (§6). Deux chantiers désormais distincts :

**A. Création/poussée des sauvegardes (indépendant de dimotic-ha, différé — voir §5)**
1. Confirmer l'accessibilité réseau du Nextcloud via WireGuard depuis chaque machine cible, et
   ajouter les IP/noms nécessaires à `trusted_domains`.
2. Créer un mot de passe d'application Nextcloud par machine.
3. Écrire le script générique unique (autonome, marche sans dimotic-ha — RPi1 inclus, tourne au
   niveau de l'hôte, voir §5bis) : détection de changement (§5) + création de l'archive (tar) + test
   d'intégrité + push WebDAV courant + purge/push mensuel (§4) + vérification du résultat + marqueur
   de statut local (§5ter) — un seul répertoire de déploiement par appel, réutilisé pour chacun présent
   sur la machine (HA, dimotic-ha, rpigpio, teleinfo, tout service externe, §4).
4. Brancher sa copie sur un mécanisme de poussée existant par machine (§5bis — pas de nouveau
   déploiement à construire) et poser le déclenchement (cron hôte) une fois présent.

**B. Application dimotic-ha dédiée (configuration + restauration, §6)**
5. Nouvelle application « Sauvegarde/Restauration », pattern standard (`guide-nouvelle-application_specs`) :
   config Nextcloud + `targets[]`, lecture du contenu réel disponible sur Nextcloud (par
   site/machine/répertoire/date), interface de choix source→cible→date, déclenchement de restauration
   (téléchargement, arrêt du service concerné, sauvegarde de l'état actuel avant écrasement, extraction,
   redémarrage, vérification).

**C. Validation**
6. Documenter/vérifier les nuances par répertoire (base HA potentiellement incohérente §4bis —
   `PRAGMA integrity_check` avant redémarrage ; `coordinator_backup.json` distinct de `database.db`
   pour zigbee2mqtt — identité réseau du dongle).
7. Tester une sauvegarde réelle puis une restauration réelle (y compris croisée entre deux machines)
   sur du matériel de test avant de considérer le mécanisme fiable.
