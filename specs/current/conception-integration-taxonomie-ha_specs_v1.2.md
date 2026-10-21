# Conception — Intégration HA « taxonomie » (cœur-HA) : phase 1

*Version 1.2 — 21 octobre 2026 — **phase 1 réalisée et validée sur ha2** (§13 : résultats) ; la parité avec le cœur actuel est de 6 327 requêtes sur 6 327. *Version 1.1 — 21 octobre 2026 — **ajoute l'origine des « quoi »** (§5bis) et tranche le point ouvert n° 1. *Version 1.0 — 21 octobre 2026 — **conception de la phase 1 (réalisée : voir §13)**. Suite de `conception-structure-taxonomie-ha` v1.1 §9.3 (architecture B). La décision d'architecture globale (et le sort du planificateur) reste **en réflexion** chez l'utilisateur ; cette phase est volontairement **isolée et réversible** : elle n'oblige à aucune migration.*

## 1. Objet

Mettre en place, dans HA, une **intégration dédiée à l'exploitation de la taxonomie** (« cœur-HA ») qui offre les services d'accès aux entités taxonomiées, **accessibles aussi aux programmes extérieurs à HA**, et la **valider** en la comparant au cœur actuel de dimotic-ha.

## 2. Périmètre de la phase 1

**Dans le périmètre** : (1) inventaire des services et de leur forme (§4, §6) ; (2) écriture de l'intégration en Python ; (3) tests ; (4) validation ; (5) comparaison des résultats avec ceux du cœur actuel sur les mêmes données (§8).

**Hors périmètre** : migration des applications (`ia`, `planificateur`, `arbreouquoi`) ; remise en cause du planificateur ; synchronisation de pièces, étages, étiquettes et alias dans HA ; ponts vers Assist ; écriture quelconque dans HA (**lecture seule**). Le cœur actuel n'est **pas modifié**.

## 3. Données sources dans HA

L'intégration lit, **dans le processus de HA**, sans cache réseau : le registre des entités, le registre des appareils, le registre des pièces, et l'état de chaque entité. La taxonomie d'une entité vient de :
1. l'attribut `attributs_taxonomie` de son état (posé par `nommage` pour les appareils MQTT) : `quoi`, `slug_quoi`, `quoi_appareil`/`slug_quoi_appareil`, `lieu_precis`, `slug_precis`, `lieu_principal`, `slug_lieu`, `lieu_pere`, `slug_pere`, `lieu_grand_pere`, `slug_grand_pere` ;
2. à défaut, **le nom de l'appareil** (`name_by_user`, sinon `name`) au format `quoi---[précis--]lieu[--père[--grand-père]]` (appareils non MQTT : un seul segment = lieu ; deux = précis, lieu ; trois ou quatre = + père, grand-père), **avec la pièce HA comme lieu de repli** pour une entité sans taxonomie.

## 4. Inventaire des services du cœur actuel (ce que les applications appellent réellement)

Relevé sur le code (hors tests) : seules **5 fonctions de lecture** et quelques événements sont utilisés.

| Fonction du cœur (`HaStructureRegistry` / `HaBridgeClient`) | Rôle | Appelants (appels) |
|---|---|---|
| `getAllEntities()` | toutes les entités enrichies (taxonomie, pièce, appareil, catégorie) | `ia` 5, `arbreouquoi` 6, `planificateur` 1, `scriptsha` 1 |
| `getEntity(entityId)` | une entité | `ia` 2, `arbreouquoi` 1 |
| `getEntitiesByQuoiAndLieux(quoi, lieux[], includeTechnical)` | **la recherche** « quoi + où » | `ia` 8, `planificateur` 2 |
| `getQuoiCatalog()` | catalogue des « quoi » (`quoi_id`, `label`, `description`) | `ia` 4, `arbreouquoi` 3 |
| `getLieuCatalog(excludedQuoiIds?)` | tous les lieux connus, tous niveaux, valeurs d'affichage | `ia` 4 |
| `onStateChanged`, `isAvailable`, `refresh` | abonnement aux changements d'état, disponibilité, resynchronisation | `planificateur`, `ia` |

Non repris en phase 1 : tout ce qui **écrit** (ajout/mise à jour d'entités, de pièces, d'appareils du registre), `getEntitiesByQuoi`/`ByArea`/`ByAreaAndQuoi` (peu ou pas appelés hors du cœur).

## 5. Règles de résolution à reproduire à l'identique

Reprise de `getEntitiesByQuoiAndLieux` (le comportement actuel fait foi) :

1. **Quoi** : candidats = entités du quoi demandé, sinon toutes. **Repli** : si aucun candidat et que le « quoi » demandé est en fait un **lieu précis** (« plafonnier »), on cherche par lieu précis.
2. **Termes de lieu** : un terme qui est un **nœud du graphe de lieux** (« salon », « chambre », « rez de chaussée ») est une **alternative** (OU entre eux) ; un terme qui est un **lieu précis** est un **qualificatif** (ET avec les lieux : « plafonnier » + « chambre » = le plafonnier de la chambre). Un mot vide initial est retiré (« la chambre »).
3. **Graphe de lieux** (englobement) : arêtes grand-père → père → lieu, construites à partir des taxonomies ; **le lieu précis n'en fait jamais partie** (étiquette locale à l'entité). Parcours sûr vis-à-vis des cycles.
4. **Phrase composée** : essayée d'abord telle quelle ; sinon découpée en mots significatifs (sans « de, du, des, la, le, les, l, au, aux, à, et »), tous doivent correspondre (ET).
5. **Repli par le nom** (si la taxonomie ne donne rien) : tous les mots significatifs (3 lettres ou plus) des lieux doivent figurer dans le nom ou l'identifiant ; jamais au-delà du « quoi » demandé ; **plus de 25 résultats = aucun** (recherche trop vague).
6. **Entités « utilisateur »** seulement par défaut : ni `entity_category` (config, diagnostic), ni désactivée (`includeTechnical` les inclut).
7. Le `slug_quoi_appareil` sert aussi de qualificatif (« mode indicateur du four »).
8. **Catalogue de lieux** : valeurs d'affichage de `lieu_precis`, `lieu_principal`, `lieu_pere`, `lieu_grand_pere` des entités « utilisateur » ; ni nombre seul, ni quoi exclu ; tri français.

## 5bis. Origine des « quoi » (relevée dans `TaxonomyHaClassifier` du cœur actuel)

Le catalogue de « quoi » n'est écrit nulle part : il se construit entité après entité. Trois origines :

1. **Taxonomie déjà posée** (`attributs_taxonomie.slug_quoi`, par `nommage`, RFXCOM, AREXX, EVOO7) : le « quoi » est repris tel quel. **Un « quoi » inconnu, arrivé par MQTT, est créé automatiquement au catalogue**, sans déclaration. Il n'y entre que si l'entité est « utilisateur » (ni réglage ni diagnostic, ni désactivée) et qu'il désigne un **objet** (`quoi` = `quoi_appareil`, ou pas de `quoi_appareil`) ou une **grandeur connue** (classe : puissance, tension…). Le libellé propre d'une entité secondaire (« disjoncteur puissance », « mode indicateur ») n'y figure pas : on la trouve par l'appareil (`quoi_appareil`).
2. **Table des classes** (`DEVICE_CLASS_QUOI_MAP` : température, humidité, puissance, ampérage, énergie, tension, puissance apparente, pression, luminosité, présence, ouverture, portail, fumée, batterie, connectivité). Elle sert **aux deux cas** : (a) déduire le « quoi » d'une entité **hors taxonomie** ; (b) donner un « quoi » aux **capteurs d'un appareil MQTT géré** par `nommage` (`quoiFromDeviceClass`, source unique partagée) et admettre ces grandeurs au catalogue.
3. **Table des domaines** (`DOMAIN_QUOI_MAP` : `light` → Lumière, `climate` → Température, `water_heater` → Ballon, `lock` → Serrure, `fan` → Ventilateur, `humidifier`/`dehumidifier` → Humidité, `media_player` → Média, `vacuum` → Aspirateur). **Concerne uniquement les entités hors taxonomie.** `switch`, `cover`, `sensor`, `binary_sensor` en sont **volontairement absents** (trop génériques) : sans classe exploitable l'entité reste **non classée** plutôt que mal classée.

Pour les entités hors taxonomie, le cœur écrit aussi une **taxonomie « virtuelle »** (`virtuel: true`) : lieu = nom de la pièce HA (sinon « maison »), `quoi_appareil` = nom nettoyé de l'appareil, lieu précis dérivé du nom de l'appareil et du nom de l'entité.

**Décision de la phase 1** : **reprendre ces deux tables à l'identique** (parité avec le cœur actuel). Les enrichir (un « quoi » plus fin pour les `switch` et les `climate`, qui désignent selon le cas un climatiseur, un thermostat, un poêle…) est un chantier **ultérieur**, hors phase 1.

## 6. Forme des services dans HA

Domaine `dimotic_taxonomie`, chargé comme intégration (HACS, comme Plans), **lecture seule**.

### 6.1 Commandes WebSocket (accès pour les programmes extérieurs à HA)

Même canal et même authentification que celui qu'utilise déjà le cœur : `ws://<hôte HA>:8123/api/websocket`, jeton d'accès (jeton longue durée d'un utilisateur de HA).

| Commande | Paramètres | Résultat |
|---|---|---|
| `dimotic_taxonomie/etat` | — | version, nombre d'entités classées, d'appareils, de lieux, date du dernier calcul |
| `dimotic_taxonomie/entites` | `domaine?`, `inclure_techniques?` (faux) | liste d'entités normalisées (§6.3) |
| `dimotic_taxonomie/entite` | `entity_id` | une entité normalisée, ou `null` |
| `dimotic_taxonomie/chercher` | `quoi?`, `lieux?: string[]`, `inclure_techniques?` | entités normalisées + `methode` (`taxonomie`, `repli_precis`, `repli_nom`) |
| `dimotic_taxonomie/catalogue_quoi` | — | `[{quoi_id, label, description?}]` |
| `dimotic_taxonomie/catalogue_lieux` | `quoi_exclus?: string[]` | `[string]` (valeurs d'affichage, tri français) |
| `dimotic_taxonomie/arbre` | — | graphe d'englobement : `[{noeud, parent?, enfants[]}]` |
| `dimotic_taxonomie/abonner` | `evenements?` | flux d'événements (§6.4) |

### 6.2 Service HA avec réponse

`dimotic_taxonomie.chercher` (mêmes paramètres que la commande, **réponse** lue dans une variable d'automatisation) ; utilisable depuis une automatisation ou un script de HA.

### 6.3 Entité normalisée

`entity_id`, `friendly_name`, `domaine`, `device_class?`, `etat`, `device_id?`, `area_id?`, `pièce?` (nom), `plateforme?`, `entity_category?`, `hidden_by?`, `disabled_by?`, et le bloc `taxonomie` : `{quoi, slug_quoi, quoi_appareil?, precis?, lieu, pere?, grand_pere?, source: "attributs" | "nom" | "piece"}`. **Aucun secret** dans les réponses.

### 6.4 Événements

`entite_changee` (taxonomie, pièce ou état d'une entité modifiés), `structure_changee` (appareil, pièce ou lieu ajouté, retiré ou renommé) : de quoi invalider le cache d'un client extérieur.

### 6.5 Accès sans WebSocket (facultatif)

Une vue HTTP `POST /api/dimotic_taxonomie/chercher` (jeton en en-tête) pour les clients simples (`curl`, scripts). Même contenu que `chercher`.

### 6.6 Droits

Toutes les commandes sont en **lecture** et exigent un utilisateur authentifié de HA. Pas de commande d'action en phase 1.

## 7. Calcul interne

Index reconstruits **à partir des événements** des registres et du bus d'états de HA (pas de scrutation) ; graphe d'englobement recalculé à l'invalidation ; résultat stable à chaque appel.

## 8. Comparaison avec le cœur actuel (validation)

1. **Jeu de données figé** : export du registre des entités, des appareils, des pièces et des états de **ha2** (et d'un jeu réduit à contenu connu pour les tests).
2. **Banc** : alimenter avec les mêmes données (a) le cœur actuel (`HaStructureRegistry` du TypeScript, exécuté sous Node) et (b) l'intégration (logique Python testée hors HA), puis comparer, sur un **corpus de requêtes**, les listes d'entités renvoyées : `chercher(quoi, lieux)` (cas simples, qualificatifs de lieu précis, phrases composées, repli par le nom, entités techniques), `catalogue_lieux`, `catalogue_quoi`, `entite`, `entites`.
3. **Corpus** : requêtes réelles de l'agent IA et du planificateur (extraites des journaux et des planifications de ha2), complétées par des cas limites.
4. **Critère** : **aucune différence** sur le corpus, ou chaque différence expliquée et validée par l'utilisateur. Rapport lisible (tableau).

## 9. Tests

Tests unitaires en Python **sans HA** pour toute la logique (analyse de taxonomie, normalisation, graphe, recherche, catalogues), avec fixtures ; tests d'intégration sur HA (chargement, commandes WebSocket, service, événements) ; tests de parité (§8). Les règles du §5 sont chacune couvertes par au moins un test nommé.

## 10. Dépôt

Nouveau dépôt **`dimotic-ha-taxonomie`** (disposition HACS comme `dimotic-ha-plans` : `custom_components/dimotic_taxonomie/`, `hacs.json`, `tests/`), séparé de Plans (une responsabilité, une version). Aucune dépendance de Plans, qui pourra l'utiliser plus tard.

## 11. Livrables et critère de sortie de la phase 1

Intégration installable ; commandes §6 fonctionnelles et accessibles par jeton depuis une machine extérieure à HA (essai réel depuis falbala vers ha2) ; tests ; rapport de parité sans écart non expliqué ; documentation d'installation ; spécification mise à jour. **Sortie** : l'utilisateur valide le rapport de parité ; aucune migration n'est faite à ce stade.

## 12. Points ouverts

1. ~~Origine du catalogue de « quoi »~~ : **tranché le 21/10/2026** (§5bis) : tables du cœur reprises à l'identique en phase 1 ; enrichissement ultérieur.
2. **Lieux précis qui ne sont pas des lieux** (« télécommande 1.1 », « colonne 5-rangée 1 ») : le cœur actuel les exclut du catalogue par `excludedQuoiIds` à la demande de l'appelant ; à garder tel quel en phase 1.
3. **Entités sans taxonomie** : lieu de repli = pièce HA ; à confirmer.
4. **Jeton** : un utilisateur dédié à lecture seule pour les programmes extérieurs, plutôt que le jeton d'administration actuel.
5. **Décision d'architecture globale** (cœur-HA ou projection) et sort du planificateur : en attente de l'utilisateur.

## 13. Résultats de la phase 1 (21/10/2026)

**Réalisé** dans le dépôt `dimotic-ha-taxonomie` (v0.1.0, local ; pas encore publié sur GitHub) et **installé sur ha2** (HA 2026.8.3) :

- logique en Python sans dépendance à HA (`taxonomie.py`, environ 450 lignes) : normalisation, analyse des noms, classifieur (§5bis), registre, recherche, catalogues, graphe des lieux ; **23 tests** nommés par règle du §5 ;
- branchement dans HA (registres, cache invalidé par événements, huit commandes WebSocket, service avec réponse, vue HTTP, abonnement, option « taxonomie lue dans le nom de l'appareil » désactivée par défaut) ; **9 tests** avec doublures de HA ; **35 tests** au total ;
- banc de parité (`tools/`, `docs/PARITE.md`) : export des données, corpus de **6 327 requêtes**, exécuteurs sur le cœur actuel (TypeScript sous Node), sur la logique Python et sur le **vrai service** ;
- **essai réel** : intégration chargée sans erreur ; client extérieur à HA (falbala, jeton) : commandes, service avec réponse, vue HTTP, abonnement (événements `structure_changee`) validés.

**Critère de sortie (§11) : atteint.** Parité en conditions réelles **6 327 identiques sur 6 327**, en Python seul puis contre le service installé. Le banc détecte les écarts (essai par mutation de quatre règles : 114, 114, 10 et 71 requêtes en désaccord ; 0 sans mutation). Performance : `chercher` médiane 1,1 ms ; `entites` (879) 29 ms ; `etat` 45 ms.

**Observation sur le cœur actuel** (reproduite pour la parité, à corriger **après** la phase 1) : la table des classes (§5bis point 2) ne joue jamais en pratique — le cœur lit `device_class` dans le registre des entités (valeur imposée par l'utilisateur) : sur ha2, **0** entité sur 879 en a une, alors que **363** en ont une dans leur état. Les capteurs non MQTT (puissance, tension, température…) ne sont donc classés que par le domaine.

**Points ouverts restants** : exclusion des faux lieux (§12, point 2) ; lieu de repli des entités sans taxonomie (§12, point 3) ; jeton en lecture seule pour les programmes extérieurs (§12, point 4) ; publication du dépôt sur GitHub ; décision d'architecture globale et sort du planificateur (§12, point 5). **Aucune migration** n'a été faite : le cœur actuel de dimotic-ha n'a pas été modifié.
