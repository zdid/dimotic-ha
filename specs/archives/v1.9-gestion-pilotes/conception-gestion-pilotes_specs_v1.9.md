# Conception — Gestion des pilotes par l'agent IA (ponts, découverts, adoption, remplacement)

*Version 1.9 — 16 octobre 2026 — **remplacement : attendre la suppression dans HA** (§7.2) avant de créer. *Version 1.8 — 16 octobre 2026 — **nommage corrigé** (§5.4) : lieu précis absent = lieu ; lieu père / grand-père facultatifs, souvent étage et bâtiment mais pas une règle. *Version 1.7 — règle de nommage complète (§5.4). *Version 1.6 — 16 octobre 2026 — **étape 5 : pilote zigbee2mqtt réalisé** (application `zigbee2mqtt`, `fonctionnelles-zigbee2mqtt` v1.0 : lister, decouverts, adopter, modifier, remplacer, supprimer, appairer ; pas d'effacer/ignorer/redemarrer). *Version 1.5 — 15 octobre 2026 — **étape 4 : outils MCP `pilotes_*` dans `ia`** (§12) ; le cœur signe pour l'agent (`supervisor` v2.12 §14ter.7), `fonctionnelles-ia` v1.24 §19.12 ; `CLAUDE.md` des agents réécrits. *Version 1.4 — **étapes 1 (cœur + pont de test), 2 (AREXX) et 3 (RFXCOM : devices, récepteurs, scènes) réalisées et essayées** (`fonctionnelles-supervisor` v2.11 §14ter, `fonctionnelles-arexx` v1.7 §6.5, `fonctionnelles-rfxcom` v7.2 §13bis) ; remplacement AREXX **vérifié dans un vrai HA** (même `entity_id`, aucun doublon, historique continu) ; v1.3 : écarts corrigés §4 testament, §11/§14 signature, §14 retrait complet et états non retenus ; écarts corrigés ici : §4 testament, §11/§14 signature, §14 retrait complet et états non retenus. Décisions issues de la discussion du 15/10/2026. **Changement par rapport à la v1.0 : l'adaptateur zigbee2mqtt n'est plus dans `nommage` mais dans une application `zigbee2mqtt` à part (§9, §12, §14).***

## 1. Objet

Permettre à l'**agent Claude d'un site** (noisy2 pour noisy, ha2 pour Saint Fort) de **retrouver et modifier les paramètres des pilotes** (AREXX, RFXCOM, GPIO, zigbee2mqtt…) **sans passer par HA ni par un accès SSH**, par des **messages MQTT reçus par le cœur** et transmis à l'application concernée, avec les ordres `lister`, `adopter`, `remplacer`, `effacer`, `supprimer`…

Cas d'usage de référence : un capteur AREXX tombe en panne. L'agent liste les ponts, liste les capteurs, repère le neuf parmi les **découverts**, le qualifie (quoi, lieu, lieu précis), remplace l'ancien, redémarre le pilote et vérifie la mesure dans HA.

Remplace la piste « accès SSH restreint » (`applications/ia/agent/acces-pilotes/`, abandonnée car trop lourde à installer : compte, clé, script, `authorized_keys`).

**Hors périmètre** : les intégrations propres à HA (Solarman, Marstek, Omnibattery, Maestro…), qui se gèrent dans HA.

## 2. Vocabulaire

| Terme | Définition |
|---|---|
| **Pilote** | une application dimotic-ha qui parle à du matériel (arexx, rfxcom, rpigpio, teleinfo, tasmota, evoo7) ou un service tiers relié par un adaptateur (zigbee2mqtt). |
| **Pont** | **une instance d'un pilote sur une machine**, identifiée par son nom complet (`arexx_bridge_<machine>`, `bridgeInstance` complet du RFXCOM…) ; il peut y en avoir plusieurs par type, sur plusieurs machines, pour la **qualité de réception radio**. |
| **Ressource** | ce qu'un pont gère : capteur (AREXX), device / récepteur / scène (RFXCOM), broche (GPIO), appareil Zigbee (z2m). |
| **Découvert** | ressource détectée automatiquement mais **non qualifiée** : conservée **en mémoire du pont seulement**, **jamais publiée vers HA**. |
| **Adopter** | qualifier un découvert (taxonomie QUOI---OÙ complète) et le déclarer ; c'est alors seulement qu'il peut être transmis à HA. |
| **Agent** | l'assistant Claude Code du site (voir `conception-claude-code-automatisations`). |

## 3. Architecture

```
Agent Claude ──MCP (app ia)──► MQTT du site ──► cœur du pont ──► application pilote (ou adaptateur)
   (noisy2 / ha2)   outils pilotes_*      (sujets §4)     (relais d'événements)      ▲
                                                                                      └ réponse sur MQTT
```

- Le **cœur** de chaque machine reçoit les requêtes MQTT destinées à ses ponts et les transmet à l'application par son pont d'événements existant (`SupervisorEventBridge`) ; la **réponse** suit le chemin inverse. `MqttEventBus` (sujets `dimotic/supervisor/<machine>/app/<app>/event/<événement>`, aujourd'hui sans appelant) est la base de départ.
- Les **sites sont étanches** : le nom du site figure dans tous les sujets ; l'agent d'un site ne voit que les ponts de son site.
- Les requêtes passent par le **broker du cœur** de chaque machine ; entre machines d'un même site, par le pont MQTT du site (sujets `dimotic/<site>/pilotes/#` à ajouter aux ponts Mosquitto de noisy/noisy2, et de ha2/stfort).
- L'agent n'écrit **jamais** directement sur MQTT : il utilise les outils MCP `pilotes_*` de l'application `ia` (même modèle que `deposer_automatisation`, avec aperçu puis `confirme: true`).

## 4. Canal MQTT

| Sujet | Contenu | Règles |
|---|---|---|
| `dimotic/<site>/pilotes/<pont>/presence` | JSON : `pont`, `machine`, `appId`, `type` (arexx, rfxcom, gpio, zigbee2mqtt…), `version`, `capacites[]`, `etat`, `date` | **retenu** (c'est un état) |
| `dimotic/<site>/pilotes/<pont>/requete/<id>` | JSON : `ordre`, `parametres`, `apercu` (booléen), `jeton` (voir §5.3), `emetteur` | **JAMAIS retenu**, QoS 1, durée de vie courte |
| `dimotic/<site>/pilotes/<pont>/reponse/<id>` | JSON : `ok`, `resultat` ou `erreur` (codes standardisés), `apercu`, `jeton`, `sauvegarde` | non retenu |

- **Testament** (écart constaté à l'essai, v1.2) : MQTT n'en permet qu'**un par connexion**. Il porte donc sur la **machine** (`dimotic/<site>/pilotes/_machines/<machineId>`, retenu) et non sur chaque pont. Après un arrêt brutal du cœur, les présences retenues des ponts restent `en_ligne` : **un pont est injoignable si sa machine est `hors_ligne`**, et le cœur corrige au redémarrage les présences périmées de sa machine (délai 15 s).
- **`ponts` n'est pas un ordre** : c'est la lecture des messages `presence` retenus de `dimotic/<site>/pilotes/+/presence`. Un pont sans présence est **injoignable**, pas inexistant.
- Aucun ordre n'est jamais publié en retenu (règle du projet : un ordre ancien ne doit jamais être rejoué au redémarrage).
- Identifiants et droits du broker : l'agent n'a le droit de publier que sous `…/requete/#` et de lire `…/reponse/#` et `…/presence`.

## 5. Contrat des ordres

### 5.1 Ordres

| Ordre | Effet | Modifie ? |
|---|---|---|
| `lister` | ressources configurées du pont (filtrables par type de ressource) | non |
| `decouverts` | ressources détectées non adoptées : identifiant, dernière valeur, date, **qualité de réception**, pont(s) qui l'entendent | non |
| `adopter` | qualifie un découvert (taxonomie QUOI---OÙ complète : quoi, lieu, lieu précis, lieu père, lieu grand-père — §5.4) puis le déclare ; `transmitToHa` explicite | oui |
| `creer` | crée une ressource **non découvrable** (récepteur, scène RFXCOM ; broche GPIO) | oui |
| `modifier` | change des champs d'une ressource configurée | oui |
| `remplacer` | l'ancienne ressource est remplacée par le neuf **en gardant nom, place et réglages** ; réalisé comme **une suppression suivie d'un ajout qui reprend le même nommage** (§7.2) ; corrige toutes les références | oui |
| `effacer` | retire un **découvert** de la liste du pont (il réapparaît s'il émet à nouveau) ; `effacer tout` vide la liste | oui (mémoire du pont) |
| `ignorer` | met un découvert en **liste d'exclusion** : il n'est plus jamais proposé | oui |
| `supprimer` | supprime une ressource **configurée** ; si elle est transmise à HA, **supprime aussi son entité dans HA** | oui |
| `redemarrer` | relit la configuration (désactivation puis activation à chaud de l'application, **jamais du cœur**) | oui |
| `appairer` | ouvre un mode d'appairage limité dans le temps (z2m `permit_join`, …) | oui |

Chaque pilote **déclare ses capacités** dans sa présence : l'agent n'essaie jamais un ordre non déclaré.

### 5.2 Règles communes

1. **Aperçu d'abord.** Tout ordre qui modifie accepte `apercu: true` : le pont renvoie ce qu'il ferait (avant / après, entités HA touchées) **sans rien changer**.
2. **Accord de l'utilisateur** avant d'appliquer : l'agent montre l'aperçu et n'envoie la requête réelle qu'après un « oui » explicite dans la conversation.
3. **Sauvegarde automatique** du fichier modifié (`.bak-AAAAMMJJ-HHMMSS`) avant toute écriture, avec son chemin dans la réponse.
4. **Validation** : YAML/JSON contrôlé ; vocabulaire de nommage (quoi, lieux, lieu précis) vérifié contre `nommage` ; refus de tout ce qui contient un secret.
5. **Une modification à la fois**, **idempotente** (rejouer le même ordre ne duplique rien), **journalisée** (qui, quand, quoi, résultat).
6. **Vérification après coup** : le pont renvoie l'état ; l'agent contrôle dans HA (outils MCP existants) que l'entité reçoit des valeurs.

### 5.4 Règle de nommage

**Règle de nommage commune des pilotes (v1.8, 16/10/2026).** Le nom d'une ressource suit le protocole `nommage_specs` §3.3 : `quoi---lieu_précis--lieu--lieu_père--lieu_grand_père`. `quoi` et `lieu` sont **obligatoires**. `lieu_précis` est facultatif : **absent, il vaut le `lieu`** (d'où `quoi---lieu` quand seul le lieu est donné). `lieu_père` et `lieu_grand_père` sont **facultatifs** : ce sont **souvent** l'étage et le bâtiment, **mais ce n'est pas une règle** (aucun sens imposé, ne pas les deviner). La distribution est **positionnelle** : sans précis ni père `quoi---lieu` ; un père (ou un grand-père) **sans lieu précis** répète le lieu en tête (`quoi---lieu--lieu--père`, forme déjà utilisée comme `frigo---cuisine--cuisine`) ; **un grand-père exige un père** (sa position dans le nom). Paramètres des ordres : `quoi`, `lieu`, `lieuPrecis`, `lieuPere`, `lieuGrandPere` ; avec `modifier`, seules les parties données changent (`""` efface une partie). Une seule fonction les compose (`composerNom` / `decomposerNom`, cœur `pilotes/nom.ts`), utilisée par tous les pilotes. L'agent lit d'abord les noms existants pour reprendre la convention du site et ne demande père / grand-père que s'ils y sont d'usage ou si l'utilisateur en parle.

### 5.3 Jeton d'aperçu

L'aperçu renvoie un `jeton` (empreinte de l'état courant + ordre). L'ordre réel doit le présenter : si la configuration a changé entre l'aperçu et l'application, le pont refuse (« l'état a changé, refaire l'aperçu »).

## 6. Découverts

- La détection reste **continue et passive** ; la liste est **en mémoire** du pont (comme `SensorRegistry` de l'AREXX et la liste « à déclarer » du RFXCOM §6.2).
- Un découvert **n'a pas d'entité dans HA** : `transmitToHa` est faux tant qu'il n'est pas adopté, et il ne peut pas être adopté sans qualification **complète**.
- `effacer` / `ignorer` d'un découvert **ne touchent pas HA**. `supprimer` d'une ressource adoptée retire aussi l'entité de HA (aperçu et confirmation obligatoires).
- `decouverts` **regroupe par ressource** un même appareil entendu par plusieurs ponts et indique, par pont, la qualité de réception.

## 7. Plusieurs ponts

1. L'agent commence **toujours** par la liste des ponts (`presence`). Un seul pont du type voulu → il le prend ; plusieurs → il demande lequel (ou tous).
2. À l'`adopter`, si la ressource est entendue par plusieurs ponts, l'agent demande **quel pont la porte** et peut recommander le mieux reçu (le RFXCOM sait déjà qu'un appareil est « revendiqué » par une instance : relais, anti-écho, déduplication — RFXCOM §12).
3. Au `remplacer`, le neuf peut être entendu par un autre pont que l'ancien : l'agent le signale et demande si le pont porteur change.

### 7.2 Remplacement : références à corriger

**Règle commune (16/10/2026)** : au `remplacer` (et à toute modification qui renomme une entité), le pilote **attend que HA ait réellement supprimé l'ancienne entité avant de lancer la création**. Il ne suffit pas d'avoir publié le retrait : tant que HA n'a pas traité le message, le nom est pris et la neuve serait suffixée `_2`. Le pilote demande au cœur (événement `pilotes:ha:retrait:attendre`, fonction `attendreRetraitHa` du cœur) ; le cœur sonde son registre HA (500 ms, 20 s au plus) jusqu'à ce qu'aucune entité ne porte plus ce nom, puis répond (`pilotes:ha:retrait:resultat`). La création suit seulement ensuite ; si la suppression n'est pas confirmée à temps, la réponse de l'ordre le dit (`attenteSuppressionHa`) pour que l'agent vérifie dans HA. Appliqué à AREXX, RFXCOM et zigbee2mqtt (entre `device/remove` et `device/rename`).

- **AREXX** : le numéro du capteur (`arexx_<numéro>`) est la clé du fichier des capteurs, mais **n'apparaît pas dans le nom ni dans l'`entity_id` HA** (ceux-ci viennent de la taxonomie QUOI---OÙ). Le remplacement est donc une **suppression** (retrait de la découverte MQTT et de l'entité HA, messages MQTT habituels) **puis un ajout qui reprend exactement le même nommage** : l'entité renaît avec le même `entity_id`. L'**ordre est important** : supprimer d'abord (sinon HA suffixe le nouvel `entity_id` en `_2`). C'est le fonctionnement voulu dès l'origine du pilote (une modification = suppression + ajout). **Vérifié dans un vrai HA (15/10)** : même `entity_id`, aucun doublon `_2`, ancienne entrée de registre disparue, une seule chronologie.
- **RFXCOM** : le nouvel émetteur remplace l'ancien **partout** (émetteur principal et émetteurs associés de tous les récepteurs, `commandDeviceId`). L'**appairage physique** du module avec le nouvel émetteur se fait **hors dimotic-ha** : l'agent le rappelle et demande s'il est fait.
- **zigbee2mqtt** : pas de remplacement natif — suite d'étapes (appairer le neuf, le renommer comme l'ancien, corriger les automatisations et tableaux de bord qui citaient l'ancien), chacune avec aperçu.
- **GPIO** : changer la broche d'une ressource ; redémarrage de mqtt-io (production, relais : prévenir).

## 8. Ressources par pilote

| Pilote | Ressources | Découvrables | Particularités |
|---|---|---|---|
| **AREXX** | capteurs (`arexx_<numéro>`, fichier `arexx-sensors-v1.0.yaml`) | oui | `adopter` exige quoi/lieu/lieu précis ; bases BS-1000 multiples possibles : **à terme**, une base qui entend un capteur absent de sa liste **relaie la réception** au pont qui le porte, comme le RFXCOM (§12 de sa spec) — évolution de la spec AREXX, à venir |
| **RFXCOM** | **devices** (capteurs, compteurs, émetteurs), **récepteurs** (`switch`, `light`, `cover`), **scènes** | devices seulement | récepteur : `primaryEmitter` obligatoire pris parmi les devices adoptés, `emitters[]` (action, valeur, `followReceivedSignal`), `cover` : type et durées d'ouverture/fermeture ; `light` : variable, niveau par défaut |
| **GPIO** (`rpigpio` → mqtt-io) | broches (quoi / où / broche) | non | `creer`/`modifier`/`supprimer` puis redémarrage de mqtt-io (production) |
| **teleinfo, tasmota, evoo7** | à détailler à la réalisation | selon le pilote | — |
| **zigbee2mqtt** (application à part) | appareils Zigbee | oui (interview en cours, ou encore nommés par l'adresse IEEE) | voir §9 |

## 9. Pilote zigbee2mqtt (application à part)

zigbee2mqtt a **son propre protocole d'interrogation** (`<base>/bridge/request/…`, `<base>/bridge/response/…`, `<base>/bridge/devices`). L'adaptateur traduit le contrat :

| Contrat | zigbee2mqtt |
|---|---|
| `ponts` | une présence par instance z2m (sujet de base, machine, version du coordinateur) |
| `lister` | `bridge/devices` |
| `decouverts` | appareils en interview ou dont le `friendly_name` est l'adresse IEEE |
| `adopter` | `bridge/request/device/rename` (nom QUOI---OÙ) + pièce |
| `supprimer` | `bridge/request/device/remove` (option `force` pour un appareil mort) |
| `appairer` | `bridge/request/permit_join` : **durée courte**, accord explicite, refermeture contrôlée ; mettre l'appareil en mode appairage reste une action **physique** de l'utilisateur |
| `remplacer` | suite d'étapes (§7.2) |

Le pilote est une **application `zigbee2mqtt` autonome**, comme `arexx` ou `rfxcom` (décision du 15/10, v1.1) : `nommage` est le service de nommage de **tous** les pilotes (z2m, RFXCOM, AREXX, GPIO), pas un pilote ; z2m ne doit donc pas y être un cas à part. L'application implémente le contrat, publie sa présence comme un pont et **demande à `nommage` de valider** les noms `quoi---lieu--lieu précis` et les pièces, comme les autres pilotes. Le **relais des messages z2m** que `nommage` fait déjà pour tous les pilotes (réécriture des découvertes) **n'est pas déplacé**. Comme toute application nouvelle, elle arrive désactivée (activation à chaud). `ia` reste indépendant des pilotes. Attention : renommer un appareil dans z2m change ses sujets MQTT et son `entity_id` HA — l'aperçu doit lister les entités touchées.

## 10. Parcours de l'agent et questions à poser

### 10.1 Communes à tous les pilotes
1. **Quel type de pilote et quel pont ?** (liste des ponts d'abord ; un seul → pris d'office.)
2. Que veux-tu faire : lister, adopter un découvert, remplacer, supprimer, effacer des découverts ?
3. Montrer l'**aperçu**, demander l'accord, appliquer, **vérifier dans HA**, annoncer comment annuler (sauvegarde indiquée).

### 10.2 AREXX — remplacer un capteur
1. Lister les capteurs (numéro, nom, dernière mesure) ; proposer ceux **sans mesure récente** comme candidats à l'ancien.
2. Lister les découverts ; pour **identifier le neuf** : numéro écrit sur la sonde, ou réchauffer la sonde dans la main (la température monte).
3. Garder nom, lieu, lieu précis, envoi à HA du capteur remplacé ? (par défaut oui, avec confirmation.)
4. Autres découverts : `effacer`, `ignorer` ou `adopter` ?

### 10.3 AREXX / RFXCOM — adopter un découvert
C'est quoi (température, détecteur, télécommande…) ? Dans quel lieu ? Quel lieu précis ? Quel pont le porte (s'il est entendu par plusieurs) ? L'envoyer à HA maintenant ?

### 10.4 RFXCOM — créer un récepteur
1. Type : lumière, prise ou volet ? Quel nom, quel lieu ?
2. Quel **émetteur principal** (liste des émetteurs adoptés) ?
3. Lumière : variable ? niveau par défaut ? Volet : type, durée d'ouverture, durée de fermeture ?
4. Émetteurs associés : lesquels, avec quelle action, en **action fixe** ou en **suivant le signal reçu** ?
5. L'**appairage physique** du module est-il fait ? Rappel : sans appairage, HA affichera l'état mais personne ne fera bouger le module (RFXCOM §7.3, §16).

### 10.5 zigbee2mqtt
Quel appareil (liste des découverts) ? Nom QUOI---OÙ et pièce ? Pour appairer : accord pour ouvrir l'appairage combien de temps ? L'appareil est-il en mode appairage ?

## 11. Sécurité

- Publication réservée à l'agent par les outils MCP ; droits du broker limités aux sujets §4.
- **Aucun ordre en retenu** ; ordres à durée de vie courte ; jeton d'aperçu ; journal de chaque requête (qui, quand, quoi, résultat).
- **Production** : les pilotes RFXCOM et GPIO pilotent de vrais relais ; un `redemarrer`/`supprimer` les coupe un instant → l'agent **prévient** et attend l'accord.
- **Jamais** : arrêt ou redémarrage du cœur, écriture de fichiers de secrets, ordres sur un autre site que le sien.
- Retour arrière : sauvegarde `.bak-…` indiquée dans chaque réponse ; l'ordre inverse (`supprimer` d'une ressource adoptée, ou restauration du fichier) est proposé à chaque fois.

## 12. Impacts

| Élément | Changement |
|---|---|
| **Cœur** | reçoit les requêtes MQTT `dimotic/<site>/pilotes/<pont>/requete/*`, les transmet à l'application, renvoie la réponse ; publie la présence des ponts de la machine (avec testament) |
| **Nouvelle application `zigbee2mqtt`** | pilote z2m (contrat + traduction vers l'API `bridge/request/…` de z2m) ; arrive désactivée ; spécification `fonctionnelles-zigbee2mqtt` à écrire |
| **Pilotes** | implémentent le contrat (présence, capacités, `lister`, `decouverts`, `adopter`…) — d'abord **AREXX** |
| **Application `ia`** | **réalisé (v1.5)** : trois outils MCP **génériques** `pilotes_ponts`, `pilotes_lire` (lister, decouverts), `pilotes_modifier` (tous les ordres modifiants ; aperçu puis `confirme: true`) plutôt qu'un outil par ordre — le contrat est commun à tous les pilotes. `ia` demande au **cœur** de signer et publier (le secret ne sort pas du cœur) ; il garde le jeton de l'aperçu et refuse d'appliquer sans aperçu préalable |
| **CLAUDE.md des agents** | **réalisé (v1.5)** : sections « pilotes » de `sites/noisy2.md` et `sites/ha2.md` réécrites d'après §10 (déployées sur les machines à la prochaine mise à jour) |
| **Specs à faire évoluer** | `fonctionnelles-arexx` (v1.6), `fonctionnelles-rfxcom` (v7.1), spécifications du cœur (canal pilotes), `fonctionnelles-ia` (outils), `fonctionnelles-rpigpio` |
| **Ponts Mosquitto** | laisser passer `dimotic/<site>/pilotes/#` entre les machines d'un site |
| **Retirer** | `applications/ia/agent/acces-pilotes/` (accès SSH restreint) si cette conception est retenue |

## 13. Plan de réalisation

1. **Cœur** : présence des ponts + réception/relais des requêtes, avec un pont de test (`testcycle`).
2. **AREXX** : contrat complet (`lister`, `decouverts`, `adopter`, `remplacer`, `effacer`, `ignorer`, `supprimer`, `redemarrer`) ; essai de bout en bout sur noisy2 puis noisy.
3. **Outils MCP `pilotes_*`** et sections du CLAUDE.md — **réalisé (15/10)** ; reste l'essai de bout en bout avec un vrai Claude Code sur noisy2.
4. **RFXCOM** (devices, puis récepteurs, puis scènes) — **réalisé (15/10)** ; **zigbee2mqtt** — **réalisé (16/10, essai avec un faux z2m)** ; **GPIO** reste à faire.
5. Nouvelle image Docker, déploiement noisy, noisy2, ha2, stfort.

Chaque étape est testée **sans Docker d'abord** (instance de développement), puis en réel.

## 14. Points ouverts

- **AREXX, plusieurs bases** : **tranché (15/10)** — pas de doublon dans HA ; à l'avenir, relais de la réception vers le pont porteur quand le capteur n'est pas dans la liste de la base qui l'entend (comme le RFXCOM). À spécifier dans `fonctionnelles-arexx`.
- **Remplacement AREXX** : **tranché (15/10)** — suppression puis ajout au même nommage (le numéro n'est pas dans le nom HA). **Réalisé (étape 2)** et essayé sur un broker de test : retrait des sujets de l'ancien (découverte, attributs, état : messages vides retenus), publication du neuf. **Vérifié dans un vrai HA (15/10)** : même `entity_id` retrouvé, historique continu (supprimer **avant** d'ajouter).
- **Messages retenus (décision du 15/10)** : **seules les découvertes (et attributs) sont retenues, jamais les états**. Appliqué à l'AREXX (`retain: false`) ; **les autres pilotes retiennent encore leurs états** (défaut du cœur) — à décider pilote par pilote ou globalement. Le retrait d'une entité vide désormais aussi ses attributs et son état retenus (`socle` v4.46).
- **Vocabulaire de `nommage`** : l'`adopter` AREXX vérifie la forme du nom (quoi et lieu obligatoires, pas de `--`) mais **pas encore** le vocabulaire (quoi/lieux connus) — à brancher.
- **Présence des ponts** : **tranché (15/10)** — les présences MQTT suffisent : la demande « liste des ponts » reçoit la réponse de ceux qui sont là. Le registre d'applications par gossip reste un **autre sujet** (connaître les machines disparues) et n'est pas utilisé ici.
- **Où implémenter le pilote z2m** : **tranché (15/10, v1.1)** — application `zigbee2mqtt` à part (en v1.0 : dans `nommage`, écarté car `nommage` sert tous les pilotes).
- **teleinfo/tasmota/evoo7** : étape ultérieure. **RFXCOM réalisé (étape 3)** : `creer` couvre récepteurs, scènes et volet RFY manuel ; `remplacer` ne vise que les devices (un récepteur se modifie) ; `supprimer` refuse une ressource encore utilisée ; liste d'exclusion `rfxcom_ignored`.
- **Authentification des requêtes** : **tranché (15/10, v1.2)** — signature HMAC-SHA256 avec un secret par site (`core.pilotes.secret`, `secrets_config.yaml`), suite de `supervisor` §10 ; **sans secret, lecture seule** (lister, decouverts). Distribution du secret : manuelle ; outil de mise en place à prévoir.
