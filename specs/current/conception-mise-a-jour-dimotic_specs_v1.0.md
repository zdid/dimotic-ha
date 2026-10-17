# Conception — Mise à jour de dimotic-ha par commande MQTT (agent hôte `maj-dimotic`)

*Version 1.0 — 17 octobre 2026 — **conception à valider, aucun code écrit**. Décisions issues de la discussion du 17/10/2026.*

## 1. Objet

Permettre de **mettre à jour dimotic-ha sur une machine par une commande MQTT**, sans SSH ni intervention sur la machine, et **diffuser ce mécanisme en même temps que dimotic-ha** (installation neuve comme machines déjà installées).

Pourquoi une conception à part : une mise à jour **remplace le conteneur qui l'exécute** et redémarre le cœur. Elle ne peut donc pas être faite *depuis* le conteneur ; et une mise à jour ratée ne doit jamais laisser une machine sans dimotic-ha.

Hors périmètre : l'**agent IA** (Claude) n'a **aucun outil** de mise à jour (décision de l'utilisateur, 17/10/2026) ; la mise à jour automatique planifiée (non voulue) ; la mise à jour de Home Assistant, de zigbee2mqtt ou du système.

## 2. Principes

1. **Un agent sur l'hôte, hors du conteneur** (service `systemd`, un seul script `maj-dimotic.sh` + un petit écouteur MQTT). Il survit au remplacement du conteneur. `docker.sock` n'est **jamais** monté dans le conteneur (équivaut à root sur la machine).
2. **Une seule chose modifiable : la version.** Le tag demandé doit être de la forme `X.Y.Z` **et exister sur le Docker Hub** ; jamais une image libre, jamais une commande shell fournie par le message.
3. **Aperçu puis exécution**, comme les pilotes : l'aperçu ne change rien et renvoie un **jeton** lié à l'état (version actuelle + version cible) ; l'ordre réel est refusé si l'état a changé.
4. **Signature obligatoire** pour tout ordre qui modifie (HMAC-SHA256, même mécanisme que `conception-gestion-pilotes` §11), avec un **secret propre** à la mise à jour (`core.maj.secret`, distinct de `core.pilotes.secret` : l'enjeu est plus grand).
5. **Retour arrière automatique** : si le nouveau conteneur ne devient pas `healthy` dans le délai, l'ancien tag est remis et relancé.
6. **Une seule mise à jour à la fois** par machine (verrou), jamais pendant une autre.

## 3. Architecture

```
┌─ machine ─────────────────────────────────────────────┐
│  systemd : dimotic-maj.service (hôte)                 │
│     └─ écouteur MQTT  ──►  maj-dimotic.sh (docker CLI) │
│  /docker/dimotic-ha/ : compose.yaml, .env, data/, logs/│
│  conteneur dimotic-ha  (remplacé par docker compose)   │
└────────────────────────────────────────────────────────┘
        ▲ commande signée / état retenu  (MQTT du site)
```

- **`maj-dimotic.sh`** (bash, sans dépendance au-delà de `docker`, `curl`, `openssl`, `mosquitto_pub/sub`) : fait tout le travail (§6). Utilisable à la main : `maj-dimotic.sh 3.9.7`.
- **Écouteur** : même script en mode `--ecouter`, lancé par `dimotic-maj.service` (`Restart=always`). Il se connecte au broker du site avec les identifiants de `data/core/config.yaml`, lit le secret dans `data/core/secrets_config.yaml`.
- **Aucun changement du cœur** pour la mise à jour elle-même. La supervision (v1.7+) affiche déjà versions installée et publiée (entité `update` de HA).

## 4. Canal MQTT

Racine : `dimotic/<site>/maj/` (même notion de `site` que les pilotes, `core.site`).

| Topic | Sens | Contenu |
|---|---|---|
| `…/<machine>/etat` | agent → tous (retenu, LWT `hors_ligne`) | `{ etat: libre\|en_cours\|echec, version, cible?, etape?, date }` |
| `…/<machine>/commande/<id>` | demandeur → agent (non retenu) | ordre signé (§5) |
| `…/<machine>/reponse/<id>` | agent → demandeur | résultat, erreur, sauvegarde |

`<machine>` = `machineId` du core (celui des annonces `known-apps`). Chaque agent n'écoute **que sa machine**.

## 5. Ordres

| Ordre | Modifie ? | Rôle |
|---|---|---|
| `etat` | non | version installée, version cible possible, espace disque, santé du conteneur |
| `verifier` | non | la version `X.Y.Z` existe-t-elle sur le hub, pour l'architecture de cette machine ? |
| `mettre_a_jour` | **oui** | `{ version }` — aperçu (sans `confirme`) puis exécution (§6) |
| `revenir` | **oui** | remet la version précédente (celle du dernier `.env` sauvegardé) |

Requête : `{ id, ordre, parametres, apercu?, jeton?, date, signature }`. Signature = HMAC-SHA256 du JSON canonique (clés triées) de `{ machine, ordre, parametres, id, date }`. Refus si la date s'écarte de plus de 60 s, si l'`id` a déjà été vu (anti-rejeu), si la signature est fausse.

## 6. Déroulement de `mettre_a_jour`

1. **Contrôles** : tag `^[0-9]+\.[0-9]+\.[0-9]+$` ; existence sur le Docker Hub pour l'architecture locale ; espace disque suffisant ; verrou libre ; version cible ≠ version actuelle (sinon sans effet).
2. **Aperçu** (sans `confirme`) : version actuelle → cible, taille à télécharger, ce qui sera redémarré (le cœur et toutes ses applications, quelques dizaines de secondes), jeton.
3. **Sauvegarde** : copie datée de `.env` (et de `compose.yaml`) ; l'ancien tag est retenu.
4. **Téléchargement d'abord** : `docker pull zdid2/dimotic-ha:<cible>` **avant** d'arrêter quoi que ce soit (un échec réseau ne coûte rien).
5. **Bascule** : `DIMOTIC_TAG=<cible>` dans `.env`, puis `docker compose up -d`.
6. **Santé** : attente de `healthy` (délai 5 min par défaut, 10 min sur matériel lent). État publié à chaque étape.
7. **Succès** : état `libre`, version publiée ; la supervision et HA voient la nouvelle version par l'annonce du cœur.
8. **Échec** : `DIMOTIC_TAG=<ancien>` remis, `docker compose up -d`, état `echec` avec la raison ; l'ancienne image est toujours sur la machine, le retour est rapide.

Le script ne touche **jamais** à `data/` ni `logs/`.

## 7. Sécurité

- Secret `core.maj.secret` (≥ 32 octets aléatoires) dans `data/core/secrets_config.yaml`, **jamais affiché** ; posé par un script du type `docker/definir-secret-pilotes.sh` (à décliner pour la mise à jour, avec sauvegarde et mode essai).
- Sans secret défini, l'agent **refuse tout ordre modifiant** (lecture seule).
- ACL du broker (si le site en utilise) : seul le demandeur autorisé peut publier sur `…/commande/#`.
- Journal local de chaque ordre (qui/quand/quoi/résultat) dans `logs/maj.log`.
- **L'agent IA ne l'utilise pas** ; ses outils MCP n'exposent rien de ce canal.

## 8. Diffusion avec dimotic-ha

Le mécanisme doit arriver **partout où dimotic-ha est installé**, par les chemins d'installation qui existent déjà :

| Cas | Comment le script arrive |
|---|---|
| **Image** | `docker/maj-dimotic.sh` + `dimotic-maj.service` sont copiés dans l'image (`/app/scripts/maj/`) : la version du script est toujours celle de l'image |
| **Déploiement distant** (`CoreDeployService`, `docker/deploy-remote.sh`) | copiés avec `compose.deploy.yaml` (déjà copié seul sur la machine) ; le service est installé et activé à l'étape « seed-config » |
| **Carte SD** (`prepare-sd-card.sh`, script Outils) | déclarés `# @outils:bundle` comme `compose.deploy.yaml` ; le service est activé au premier démarrage |
| **Installation manuelle** (`INSTALLATION.md`) | une commande : `docker run --rm zdid2/dimotic-ha:<v> cat /app/scripts/maj/installer.sh \| sudo bash` (ou copie du dossier) |
| **Machines déjà installées** (ha2, stfort, noisy, noisy2…) | **une seule fois**, installation par le compte `claude` de la machine (clé dédiée, sudo) : dépôt du script, du service et du secret, avec sauvegarde |
| **Mises à jour ultérieures du script** | `maj-dimotic.sh` se remplace par la copie de l'image qu'il vient de tirer (`docker create` + `docker cp`), puis se relance : le script suit les versions de dimotic-ha sans autre étape |

## 9. Intégration Home Assistant (étape ultérieure)

L'entité `update` déclarée par la supervision (v1.7) est **en lecture seule** (installée / dernière version). Option à décider : lui donner un bouton « Installer » — HA publierait une demande ; un **relais dans le cœur** (qui détient le secret) signerait et transmettrait l'ordre, après aperçu confirmé par l'utilisateur. Rien de tel n'est fait tant que le §7 n'est pas validé.

## 10. Plan de réalisation

1. `maj-dimotic.sh` utilisable **à la main** (contrôles, sauvegarde, bascule, retour arrière) + essai réel sur une machine non critique (falbala, conteneur d'essai).
2. Écouteur MQTT + service `systemd` + signature + secret (essai avec un faux secret).
3. Diffusion : image, `CoreDeployService`, carte SD, `INSTALLATION.md`.
4. Installation sur ha2 puis stfort, essai d'une vraie mise à jour (avec retour arrière provoqué).
5. (Option) relais HA du §9.

## 11. Impacts

`docker/maj-dimotic.sh` (nouveau), `docker/dimotic-maj.service` (nouveau), `Dockerfile` (copie), `CoreDeployService.ts` et `docker/deploy-remote.sh` (copie + activation), `prepare-sd-card.sh` (`@outils:bundle`), `INSTALLATION.md`, `core.maj.secret` (schéma de config du cœur), spec `techniques-socle-ha-mqtt` §11.4 (déploiement), `fonctionnelles-supervision` §3ter (renvoi).

## 12. Points ouverts

1. **Secret séparé** (`core.maj.secret`) : recommandé ; à confirmer.
2. **Qui est autorisé à envoyer** l'ordre : un script d'administration sur falbala ? le relais HA (§9) ? les deux ?
3. **Machines en 32 bits** (arm/v7) : le script vérifie l'architecture ; les images 3.9.x publiées l'incluent.
4. **Machines sans accès Internet** (pas de Docker Hub) : `mettre_a_jour` ne peut pas tirer ; prévoir `docker load` d'une archive posée sur la machine ?
5. **Délai de santé** par machine (RPi 3 lent).
6. **Orangepi / noisy** : à installer quand elles sont joignables.
