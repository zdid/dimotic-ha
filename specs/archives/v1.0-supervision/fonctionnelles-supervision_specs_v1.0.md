# Spécifications Fonctionnelles — Application SUPERVISION

**Version :** 1.0
**Date :** 25 Septembre 2026
**Statut :** **Conception validée par l'utilisateur, aucun code écrit** — à relire avant implémentation.

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
| 6 | Les sauvegardes sont **demandées à l'application sauvegarde** : SUPERVISION ne connaît ni Nextcloud ni SSH (§5). |

## 3. Inventaire (source : gossip)

Chaque core publie déjà, message **retenu**, sur `dimotic/core/<machineId>/known-apps`
(`AppGossipService`, `fonctionnelles-supervisor_specs` §14bis) :
`{ address, webPort, runningInDocker, apps: [{ id, name, icon, audience }] }` — `apps` = applications
**actives** de la machine, sans le core.

- SUPERVISION s'abonne à `dimotic/core/+/known-apps` via la connexion MQTT du socle
  (`integration:supervision:passthrough:subscribe`, réabonnement automatique à chaque reconnexion).
  Cet abonnement inclut **la machine locale** (le registre agrégé du core, lui, l'exclut).
- **Inventaire** = union des machines du gossip et des machines déjà sélectionnées (§4) : une machine
  sélectionnée qui n'annonce plus rien reste listée, marquée **« absente du gossip »**.
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
SUPERVISION s'abonne à `app/dimotic-core-appgossip-+/status` → machine **« en ligne »** / **« perdue »**.

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

## 4. Sélection (paramétrage) — diffusée

- Par machine : une case « supervisée » ; pour une machine supervisée, une case par application.
- **Nouveauté** (machine ou application qui apparaît dans le gossip) : **non sélectionnée** par défaut —
  même règle que « une application nouvelle arrive désactivée ».
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

## 5. Sauvegardes en face de chaque machine

**Demande à l'application sauvegarde** (requête/réponse corrélée sur l'EventBus,
`techniques-socle-ha-mqtt_specs` §9bis) : nouvel échange `sauvegarde:supervision:status` /
`sauvegarde:supervision:status:reply`, à ajouter côté sauvegarde. Réponse, **pour chaque machine
couverte** par sauvegarde (`targets[]` : site, machine, host) :

| Donnée | Source (côté sauvegarde) |
|--------|--------------------------|
| Dernière archive **par cadence** (`journalier` / `hebdomadaire`) : date, taille | liste Nextcloud (`NextcloudWebDavClient.listBackups`) — ce qui est **réellement** sauvegardé, visible même machine éteinte |
| Dernière exécution du script : heure, succès/échec par dossier (`docker`, `dimotic-ha-addons`), code `tar`, journal d'erreur éventuel | `/dimotic-backup/status.json` de la machine, lu par SSH (clé déjà utilisée par sauvegarde) — donne la **cause** d'un échec |

- **Correspondance** machine de sauvegarde ↔ machine du gossip : **par adresse IP** (`host` ↔
  `address`), automatique. Sans correspondance : « sauvegarde non configurée ».
- **Affichage** : date de la dernière archive par cadence, succès/échec de la dernière exécution et sa
  cause ; mise en évidence si la dernière archive est plus ancienne que la cadence attendue
  (`journalier` > 2 jours — une exécution peut se terminer avec un code d'erreur toléré, `hebdomadaire` > 8 jours) — **affichage seulement**, pas d'alerte (§8).
- **Rafraîchissement** : à l'ouverture de la page, bouton « Rafraîchir », et toutes les heures.
- **Sauvegarde non active** sur cette machine ou sans réponse (délai 60 s) : colonne « sauvegardes
  indisponibles » avec la raison, le reste de la page fonctionne.

## 6. Écran

Une page « Supervision » :
- **Machines supervisées** : identifiant (+ libellé), adresse, Docker oui/non, **en ligne / perdue**
  (LWT, §3bis), heure de la dernière annonce (**périmée** signalée), présente/absente du gossip,
  applications (cochées = supervisées) avec l'**état de leur process** (application sélectionnée mais
  plus annoncée, ou plantée : signalée), colonne sauvegardes (§5).
- **Autres machines** (vues dans le gossip, non supervisées) : repliées, avec la case pour les ajouter.
- Bouton **« Enregistrer la sélection »** → diffusion (§4) ; indication de la dernière modification
  (heure, machine).

## 7. Intégration dans le socle

| Élément | Valeur |
|---------|--------|
| Identifiant | `supervision` |
| Type | `integration` (connexion MQTT du socle, bridge `main`), process séparé |
| MQTT / WebSocket HA | `requiredMqtt: true`, `requiredHaWs: false` |
| Menu | *Paramètres Techniques › Supervision* |
| Données | `data/supervision/selection.yaml` (§4) |
| Dépendance | application **sauvegarde** active sur la même machine pour la colonne sauvegardes (§5) — facultative pour le reste |
| Modification du core | `AppGossipService` : annonce enrichie (état des process, `publishedAt`), republiée à chaque changement d'état et toutes les 5 min (§3bis) |

## 8. Hors périmètre de cette version (à établir ensuite)

- **Actions** : alertes dans HA, repli SMS/email hors HA (`fonctionnelles-supervision-externe_specs` §5).
- Nœuds de supervision **indépendants** (RPi 1 par site) et surveillance mutuelle.
- Autres éléments que dimotic-ha (zigbee2mqtt…) ; vue **inter-sites**.

## 9. Plan de mise en œuvre

0. Côté core : annonce `known-apps` enrichie et périodique (§3bis).
1. Côté sauvegarde : échange `sauvegarde:supervision:status` (§5), lecture de `status.json` par SSH.
2. Application `supervision` : inventaire par gossip (§3), sélection diffusée + copie locale (§4).
3. Colonne sauvegardes (§5) et écran (§6).
4. Vérification en réel sur le site stfort : sélection faite sur une machine, retrouvée sur une autre ;
   falbala non sélectionnée ; sauvegardes de ha2/stfort affichées ; une application arrêtée apparaît en
   quelques secondes ; une machine débranchée passe « perdue » en ~90 s.

## 10. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.0 | 25/09/2026 | Claude | Conception validée par l'utilisateur (inventaire par gossip, sélection diffusée, sauvegardes en face de chaque machine demandées à l'application sauvegarde — seuils 2 j `journalier` / 8 j `hebdomadaire`, présence des machines par LWT, annonce du core enrichie de l'état des process et republiée à chaque changement + toutes les 5 min, site courant, actions reportées). Aucun code. |
