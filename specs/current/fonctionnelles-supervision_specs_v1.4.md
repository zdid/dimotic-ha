# Spécifications Fonctionnelles — Application SUPERVISION

**Version :** 1.4
**Date :** 25 Septembre 2026
**Statut :** **Implémentée** (étapes 0 à 4 du §9, vérifiées en local sur falbala le 25/09/2026) — vérification multi-machines (étape 5) restante.

> **v1.4 (25/09/2026)** — **Plusieurs adresses par machine** : ha2 est joignable en .51 (ethernet) et
> .106 (wifi) ; son core n'annonçait que la première IPv4 trouvée (le wifi) et Sauvegarde la connaît en
> .51 — pas de correspondance. L'annonce `known-apps` porte maintenant `addresses` (toutes les IPv4,
> ethernet d'abord, wifi en dernier, interfaces Docker exclues) et l'adresse principale préfère
> l'ethernet ; la correspondance des sauvegardes se fait sur **n'importe laquelle** des adresses (§5).

> **v1.3 (25/09/2026)** — **implémentation** (`applications/supervision/`), écarts et précisions :
> - **Activée d'office** déclarée dans le `package.json` de l'application (`"dimotic": { "enabledByDefault":
>   true }`) et non dans `ApplicationModule` : le core doit le savoir avant de charger l'application
>   (§7.1). Vérifié : installation où elle est nouvelle → activée ; application apparue pendant que le core
>   tourne → démarrée à chaud.
> - **Pas de menu** : drapeau générique `noMenu` de `ApplicationModule` (le menu latéral l'ignore).
> - **Inventaire** élargi aux machines vues **seulement par leur LWT** (core sans annonce `known-apps`
>   retenue — constaté sur stfort et orangepizero2) : listées, « absentes du gossip » (§3).
> - **Correspondance sauvegardes par adresse IP seulement**, jamais par nom (un nom peut désigner deux
>   machines successives) ; sans adresse annoncée : « adresse inconnue » (§5).
> - Cocher une machine **coche ses applications annoncées** avec elle (décochables ensuite) (§4).
> - Emplacement du core : `presentation/accueil.html` (balisage) + `presentation/ts/accueil.js` (chargé une
>   fois, `window.supervisionAccueil.init(slot)` à chaque visite) (§6.2).

> **v1.2 (25/09/2026)** — **Sauvegardes par `status.json` seulement** (§5, option A retenue par
> l'utilisateur) : l'application sauvegarde n'a pas le mot de passe Nextcloud (saisi à chaque
> restauration, présent seulement sur les machines) et ne peut donc pas lister Nextcloud seule.
> Constat réel au passage : ha2 (remplacé le 24/09) n'avait plus aucune sauvegarde — exactement le cas
> à signaler (« aucune sauvegarde »).

> **v1.1 (25/09/2026)** — décisions utilisateur : la supervision s'affiche sur la **page d'accueil**
> (visibilité immédiate) et la sélection se fait **directement dessus** — plus de page de paramétrage
> (§6) ; toute la logique reste dans l'application `supervision`, **pas dans le core** (le core ne
> fournit qu'un emplacement sur la page d'accueil, §6.2) ; l'application est **activée d'office**
> (§7.1, exception à « une application nouvelle arrive désactivée »). Correction : le LWT se lit sur
> `app/+/status` filtré (§3bis — `app/dimotic-core-appgossip-+/status` est refusé par le broker :
> le joker `+` doit occuper un niveau entier).

> Première version concrète de `fonctionnelles-supervision-externe_specs` (décision utilisateur du
> 25/09/2026) : une **application dimotic-ha** qui recense les machines de la domotique et leurs
> applications, laisse choisir lesquelles sont supervisées, et affiche en face de chaque machine
> l'état de ses sauvegardes. Les **actions** (alertes HA, SMS/email, nœuds RPi indépendants…) viendront
> dans une version ultérieure. Ne pas confondre avec `fonctionnelles-supervisor_specs` (SUPERVISOR :
> cycle de vie des applications et bus MQTT interne du socle), dont elle réutilise le gossip.

---

## 1. Objet

- **Recenser** les machines qui participent à la domotique du site, et les applications que chacune
  exploite — à partir du gossip déjà en place (§3).
- **Sélectionner** celles qui font partie de la supervision. Toutes n'en font pas partie : certaines
  machines ne sont là que ponctuellement (essais, machine de développement comme falbala).
- **Afficher en face de chaque machine** l'état de ses sauvegardes (§5).
- **Pas d'action** dans cette version : ni alerte, ni notification (§8).

## 2. Décisions de conception (25/09/2026)

| # | Décision |
|---|----------|
| 1 | La **sélection est diffusée** : identique sur toutes les machines du site (§4), pas propre à chacune. |
| 2 | Cette application est la **première version de la supervision externe** (`fonctionnelles-supervision-externe_specs`). |
| 3 | Les **sauvegardes de chaque machine** remontent en face de la machine (§5). |
| 4 | Périmètre : **site courant uniquement** (même broker MQTT) — pas de vue inter-sites. |
| 5 | Les **actions** (alertes…) sont établies dans un second temps. |
| 6 | Les sauvegardes sont **demandées à l'application sauvegarde**, qui les lit **par SSH** sur chaque machine (`status.json` + marqueurs par cadence) — jamais Nextcloud (§5, v1.2). SUPERVISION ne connaît ni SSH ni Nextcloud. |

## 3. Inventaire (source : gossip)

Chaque core publie déjà, message **retenu**, sur `dimotic/core/<machineId>/known-apps`
(`AppGossipService`, `fonctionnelles-supervisor_specs` §14bis) :
`{ address, addresses, webPort, runningInDocker, apps: [{ id, name, icon, audience }] }` (`addresses` : toutes
les IPv4 de la machine, ethernet d'abord — v1.4 ; `address` : la première) — `apps` = applications
**actives** de la machine, sans le core.

- SUPERVISION s'abonne à `dimotic/core/+/known-apps` via la connexion MQTT du socle
  (`integration:supervision:passthrough:subscribe`, réabonnement automatique à chaque reconnexion).
  Cet abonnement inclut **la machine locale** (le registre agrégé du core, lui, l'exclut).
- **Inventaire** = union des machines du gossip, des machines vues par leur LWT (§3bis, v1.3) et des
  machines déjà sélectionnées (§4) : une machine sélectionnée qui n'annonce plus rien, ou connue par son
  seul LWT, reste listée, marquée **« absente du gossip »**.
- L'annonce étant retenue, une machine éteinte reste présente dans le gossip : le gossip dit « qui
  existe » ; « qui est vivant » vient de §3bis.

## 3bis. Présence des machines et état des applications (décision du 25/09/2026)

**Existant, vérifié dans le code** : l'annonce `known-apps` n'est publiée qu'au démarrage du core et à
chaque activation/désactivation d'une application — ni périodiquement, ni horodatée ; elle dit quelles
applications sont **activées**, pas si leur process tourne.

**1. Présence de la machine — LWT (existant, exploité tel quel)** : la connexion du gossip de chaque
core publie `online` (retenu) sur `app/dimotic-core-appgossip-<machineId>/status` à la connexion ; à un
arrêt propre le core publie `offline` immédiatement ; à une mort brutale (courant, réseau, process
bloqué) le **broker** publie `offline` au bout d'environ 1,5 × keepalive (~90 s avec 60 s).
SUPERVISION s'abonne à `app/+/status` et ne retient que les identifiants `dimotic-core-appgossip-<machineId>` (le joker `+` MQTT doit occuper un niveau entier) → machine **« en ligne »** / **« perdue »**. Vérifié en réel le 25/09/2026 : falbala, ha2, orangepizero2, stfort publient `online`.

**2. Annonce enrichie et périodique — modification du core (`AppGossipService`)** :
- chaque application de l'annonce porte l'**état de son process** (`running`, `starting`,
  `restarting`, `crashed`, `stopped` — états de `ProcessSupervisor` ; `in-process` pour une
  application sans process séparé) ;
- l'annonce porte l'**heure de publication** (`publishedAt`) ;
- elle est republiée **à chaque changement d'état** d'une application (détection en quelques
  secondes) **et périodiquement, toutes les 5 minutes** (demande utilisateur : une information
  périodique en plus des événements et du LWT).
- Côté SUPERVISION : annonce **« périmée »** si `publishedAt` a plus de **3 périodes (15 min)** —
  couvre un core bloqué dont la connexion MQTT reste pourtant ouverte. Période et seuil : valeurs par
  défaut, réglables dans la config du core (`core.appGossipIntervalSeconds`, défaut 300) et de
  SUPERVISION (`staleAfterPeriods`, défaut 3).
- Compatibilité : les champs ajoutés sont facultatifs — une machine pas encore mise à jour reste
  affichée (état des applications « inconnu », pas de contrôle de péremption).

## 4. Sélection — diffusée, faite sur la page d'accueil

- Par machine : une case « supervisée » ; pour une machine supervisée, une case par application —
  **directement sur la page d'accueil** (§6), pas de page de paramétrage (v1.1).
- **Nouveauté** (machine ou application qui apparaît dans le gossip) : **non sélectionnée** par défaut.
- Cocher une machine coche avec elle ses applications **annoncées à ce moment** (décochables ensuite, v1.3).
- **Diffusion immédiate** à chaque case cochée/décochée (pas de bouton « Enregistrer », v1.1).
- **Sélection entière** remplacée à chaque modification (pas case par case) — décision utilisateur :
  il n'y aura jamais qu'un seul administrateur, deux modifications simultanées ne se produisent pas.
- **Format** :
  ```yaml
  updatedAt: 2026-09-25T10:00:00Z   # horodatage de la dernière modification
  updatedBy: <machineId>            # machine d'où la modification a été faite
  machines:
    <machineId>:
      label: <libellé libre, facultatif>
      apps: [<appId>, ...]
  ```
- **Diffusion** : publiée en message **retenu** sur `dimotic/supervision/selection`
  (`integration:supervision:passthrough:publish`) ; chaque instance s'y abonne et adopte la version
  la plus récente (`updatedAt`) — la dernière modification l'emporte.
- **Copie locale** : `data/supervision/selection.yaml`, réécrite à chaque version adoptée — sert au
  démarrage et si le broker est injoignable ; publiée au démarrage si elle est plus récente que la
  version retenue sur le broker.

## 5. Sauvegardes en face de chaque machine (v1.2)

**Demande à l'application sauvegarde** (requête/réponse corrélée sur l'EventBus,
`techniques-socle-ha-mqtt_specs` §9bis) : `sauvegarde:supervision:status` /
`sauvegarde:supervision:status:reply` (`fonctionnelles-sauvegarde_specs` §5quater). Sauvegarde lit
**par SSH**, pour chaque machine couverte (`targets[]` : site, machine, host) — **jamais Nextcloud**
(pas de mot de passe dans dimotic-ha) :

| Donnée | Source sur la machine |
|--------|-----------------------|
| Script et cron installés ? | `/dimotic-backup/nextcloud-backup.sh`, crontab de root |
| Dernière exécution : heure, succès/échec par dossier (`docker`, `dimotic-ha-addons`), cadences envoyées et **en échec**, code `tar`, journal d'erreur | `/dimotic-backup/status.json` |
| **Dernière réussite par dossier et par cadence** (`journalier`, `hebdomadaire`) | marqueurs `/dimotic-backup/last-<dossier>-<cadence>` (date ISO), écrits par le script après un envoi accepté par Nextcloud |

Une réussite n'est inscrite qu'après vérification du code HTTP de l'envoi : « réussi » = réellement
déposé sur Nextcloud.

- **Correspondance** machine de sauvegarde ↔ machine du gossip : **par adresse IP seulement** (`host` ↔
  `address` ou n'importe laquelle des `addresses` — ethernet, wifi…, v1.4), automatique — jamais par nom (v1.3). Sans correspondance : « sauvegarde non configurée »
  (avec la raison : aucune machine de cette adresse dans Sauvegarde, ou adresse inconnue).
- **Signalé** (affichage seulement, pas d'alerte, §8) : **aucune sauvegarde** (script/cron absents ou
  jamais exécuté — cas de ha2 le 25/09/2026), machine **injoignable** par SSH, **échec** de la dernière
  exécution (avec sa cause), dernière réussite **trop ancienne** : `journalier` > 2 jours (une
  exécution peut se terminer avec un code d'erreur toléré), `hebdomadaire` > 8 jours.
- Les marqueurs par cadence n'existent qu'une fois le nouveau script poussé (« 📤 Pousser ») :
  avant, seule la dernière exécution est connue.
- **Rafraîchissement** : à l'ouverture de la page d'accueil, bouton « Rafraîchir », et toutes les heures.
- **Sauvegarde non active** sur cette machine ou sans réponse (délai 60 s) : « sauvegardes
  indisponibles » avec la raison, le reste de l'affichage fonctionne.

## 6. Écran — page d'accueil (v1.1)

### 6.1 Contenu

Un bloc **« Machines du site »** sur la page d'accueil, à la place de « Applications sur les autres
machines » quand SUPERVISION est active :
- **Toutes les machines** du gossip, **machine locale comprise** ; les **supervisées en haut**, les
  autres **grisées et repliées** en dessous (dépliables).
- **Par machine** : case « supervisée », identifiant (+ libellé), adresse, Docker oui/non, **en ligne /
  perdue** (LWT, §3bis), heure de la dernière annonce (**périmée** signalée), présente/absente du
  gossip, colonne **sauvegardes** (§5) pour une machine supervisée.
- **Par application** : case « supervisée », **état du process** (en marche, en redémarrage, plantée,
  arrêtée…), et clic qui ouvre l'application sur sa machine (comportement actuel conservé) ;
  application sélectionnée mais plus annoncée, ou plantée : signalée.
- Cocher/décocher diffuse aussitôt la sélection (§4).

### 6.2 Répartition core / application — rien de la supervision dans le core

- Le **core** ne fournit qu'un **emplacement** sur la page d'accueil (`HomeView.ts`). Si l'application
  `supervision` est active, il y charge **l'affichage fourni par l'application** :
  `presentation/accueil.html` (balisage) et `presentation/ts/accueil.js` (chargé une seule fois, définit
  `window.supervisionAccueil.init(slot)`, appelé à chaque visite de l'accueil) ; sinon, ou si le
  chargement échoue, il garde le bloc actuel « Applications sur les autres machines ».
- Toute la logique (abonnements gossip/LWT, sélection et sa diffusion, demande à sauvegarde, calcul
  des états « perdue/périmée ») reste dans l'application, dans son propre process.
- Pas de menu ni de page propre à l'application (v1.1).

## 7. Intégration dans le socle

| Élément | Valeur |
|---------|--------|
| Identifiant | `supervision` |
| Type | `integration` (connexion MQTT du socle, bridge `main`), process séparé |
| MQTT / WebSocket HA | `requiredMqtt: true`, `requiredHaWs: false` |
| Menu | aucun — `noMenu: true` (drapeau générique de `ApplicationModule`, v1.3) ; affichage sur la page d'accueil (§6) |
| Données | `data/supervision/selection.yaml` (§4) |
| Dépendance | application **sauvegarde** active sur la même machine pour la colonne sauvegardes (§5) — facultative pour le reste |
| Modifications du core | `AppGossipService` : annonce enrichie (état des process, `publishedAt`), republiée à chaque changement d'état et toutes les 5 min (§3bis, **fait** le 25/09/2026) ; emplacement sur la page d'accueil qui charge l'affichage de l'application (§6.2) ; activation d'office (§7.1) |

### 7.1 Activée d'office (décision utilisateur, v1.1)

Exception à la règle « une application nouvelle (jamais vue, ou installation neuve) arrive
désactivée » (`fonctionnelles-supervisor_specs` §8) : une application peut déclarer
`"dimotic": { "enabledByDefault": true }` dans son **`package.json`** (v1.3 — pas dans
`ApplicationModule` : le core décide avant de charger l'application, `appRoots.isEnabledByDefault`) ;
le core la **active** à sa première apparition au lieu de la désactiver — au démarrage comme à chaud
(application apparue pendant que le core tourne, `AppService.handleApplicationsList`). SUPERVISION est la seule à le déclarer. L'utilisateur
peut toujours la désactiver ensuite (le choix est alors conservé, comme pour toute application).

## 8. Hors périmètre de cette version (à établir ensuite)

- **Actions** : alertes dans HA, repli SMS/email hors HA (`fonctionnelles-supervision-externe_specs` §5).
- Nœuds de supervision **indépendants** (RPi 1 par site) et surveillance mutuelle.
- **zigbee2mqtt** et **Home Assistant** (HA : possible par l'accès WebSocket du core) — prochaines
  versions (demande utilisateur).
- **Tasmota** (arrivée prochaine dans le périmètre) — fera l'objet d'une **étude préalable** séparée.
- Vue **inter-sites**.

## 9. Plan de mise en œuvre

0. Côté core : annonce `known-apps` enrichie et périodique (§3bis) — **fait** (commit `cd73c8d`).
1. Côté sauvegarde : marqueurs par cadence + cadences en échec dans le script, échange `sauvegarde:supervision:status` (§5) — **fait** (commit `e9c01f2`).
2. Côté core : `enabledByDefault` (§7.1) et emplacement de la page d'accueil (§6.2) — **fait** (v1.3).
3. Application `supervision` : inventaire par gossip (§3), présence/état (§3bis), sélection diffusée + copie locale (§4) — **fait** (v1.3).
4. Affichage sur la page d'accueil (§6) et colonne sauvegardes (§5) — **fait** (v1.3), vérifié en local sur falbala.
5. Vérification en réel sur le site stfort : sélection faite sur une machine, retrouvée sur une autre ;
   falbala non sélectionnée ; sauvegardes de ha2/stfort affichées ; une application arrêtée apparaît en
   quelques secondes ; une machine débranchée passe « perdue » en ~90 s.

## 10. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.4 | 25/09/2026 | Claude | Plusieurs adresses par machine : `addresses` dans l'annonce (ethernet d'abord, Docker exclu), adresse principale ethernet de préférence, correspondance des sauvegardes sur n'importe laquelle (cas réel ha2 .51/.106). v1.3 archivée. |
| 1.3 | 25/09/2026 | Claude | **Implémentation** (étapes 0-4) : activée d'office déclarée dans le `package.json`, drapeau `noMenu`, inventaire élargi aux machines vues par LWT seul, correspondance sauvegardes par IP seulement, machine cochée = ses applications cochées, fichiers de l'emplacement d'accueil précisés. v1.2 archivée. |
| 1.2 | 25/09/2026 | Claude | Sauvegardes lues **par SSH** (`status.json`, marqueurs de dernière réussite par dossier et cadence, script/cron installés) — jamais Nextcloud, faute de mot de passe dans dimotic-ha (option A) ; « aucune sauvegarde » et « injoignable » signalés (cas réel : ha2). v1.1 archivée. |
| 1.1 | 25/09/2026 | Claude | Affichage et sélection sur la **page d'accueil** (plus de page de paramétrage, diffusion immédiate), logique entièrement dans l'application (le core ne fournit qu'un emplacement qui charge son affichage), application **activée d'office** (`enabledByDefault`), correction du topic LWT (`app/+/status` filtré). v1.0 archivée. |
| 1.0 | 25/09/2026 | Claude | Conception validée par l'utilisateur (inventaire par gossip, sélection diffusée, sauvegardes en face de chaque machine demandées à l'application sauvegarde — seuils 2 j `journalier` / 8 j `hebdomadaire`, présence des machines par LWT, annonce du core enrichie de l'état des process et republiée à chaque changement + toutes les 5 min, site courant, actions reportées). Aucun code. |
