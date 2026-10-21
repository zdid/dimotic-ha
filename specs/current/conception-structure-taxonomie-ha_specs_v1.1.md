# Conception — Structure de HA déduite du nommage (pièces, étages, étiquettes) pour tous les appareils

*Version 1.1 — 21 octobre 2026 — **conception, rien n'est réalisé** ; ajoute ce que HA comprend (ou non) de la taxonomie (§2bis), les alias, les ponts vers Assist, le principe « une seule logique » et deux architectures (§9 : tout dans le cœur, ou taxonomie **portée dans HA** avec remise en cause du planificateur). *Version 1.0 — 21 octobre 2026 — première rédaction. Périmètre : **ha2 (Saint Fort) seulement** ; noisy2 n'est pas touché. Les points marqués « à valider » sont des recommandations qui n'ont pas encore reçu l'accord de l'utilisateur.*

## 1. Objet

Tout appareil de HA, quelle que soit son intégration, doit profiter de la taxonomie du nommage `quoi---[lieu précis--]lieu[--père[--grand-père]]` : l'agent IA le retrouve par « quoi » et « où », l'assistant vocal comprend ses pièces, les automatisations ciblent des étages et des étiquettes. Un appareil neuf devient exploitable dès qu'il porte un nom au bon format.

## 2. Constat (ha2, simulation du 21/10/2026)

- 154 appareils examinés : **107** portent les attributs `attributs_taxonomie` (appareils MQTT passés par `nommage`), **30** n'ont qu'un nom conforme (renommés à la main le 20/10 : Huawei, climatiseurs, Cast, imprimante…), **22** n'ont aucune taxonomie (téléphones, appareils « dimotic-ha », thermostats Zigbee indisponibles…).
- HA ne permet **pas** d'ajouter un attribut personnalisé à l'entité d'une autre intégration : seul le MQTT le permet (la découverte est écrite par nous).
- Le cœur (`DeviceAreaAssigner.reconcilierNoms`, toutes les 10 min) range déjà tout appareil dans la **pièce de son lieu** (2ᵉ segment du nom). Vérifié : les 30 appareils renommés sont dans la bonne pièce.
- **Aucun étage** défini dans HA (42 pièces à ha2, aucune rattachée à un étage). Les 4 étiquettes existantes (Ballon, Lumières, Association, Rappels) ne servent qu'à ranger les automatisations dans le tableau « Automatisations » (filtre `domain: automation` + étiquette).
- **Valeurs non unifiées** : père « rez de chaussée » ×25 contre « rez-de-chaussée » ×31 ; « extérieur » ×16 contre « exterieur » ×1 ; « maison » utilisé comme père pour 4 appareils (et comme grand-père pour 57). Les **identifiants normalisés** (`slug_*`) sont déjà identiques (`rez_de_chaussee`) : seule la valeur affichée diffère.

## 2bis. Ce que HA comprend de la taxonomie (et ce qu'il ignore)

| Notion | Dans HA |
|---|---|
| **où** | **pièce** et **étage**, natifs : voix (Assist), cibles d'automatisation, interface |
| **quoi** | seulement le **domaine technique** (`light`, `climate`, `switch`…) : pas fonctionnel (`climate` peut être un climatiseur, un thermostat de radiateur, la pompe à chaleur) |
| **quoi fonctionnel** | seulement par **étiquette** (libre, ciblable, filtrable) et par **alias** (voix) |

Conséquence : le « quoi » (climatiseur, poêle, gros ballon…) n'existe pas pour HA sauf s'il est posé en étiquette ou en alias. Aujourd'hui **seul dimotic** (agent IA, interpréteur, arbre où quoi, planificateur) exploite la taxonomie ; HA n'en reçoit que ce que `nommage` met dans les attributs MQTT. Pour l'utilisateur, ces notions sont **essentielles** : l'objectif est que HA les prenne en compte, par synchronisation (§3 à §5) et par une intégration (§9).

### Alias

Un alias est un autre nom d'entité, de pièce ou d'étage que l'assistant vocal reconnaît en plus du nom officiel. Alias déduits de la taxonomie, posés par le cœur dans le registre : `poêle---salon--salle` → « le poêle », « le poêle du salon » ; `light.salon_salle` → « la lumière du salon ». Limites : l'entité doit être **exposée à Assist** ; Assist ne comprend pas les étiquettes ; deux entités de même alias dans la même pièce sont ambiguës.

## 3. Schéma cible (à valider)

| Niveau du nom | Structure de HA |
|---|---|
| lieu précis | **pièce** (`area`), **seulement si c'est un vrai lieu** |
| lieu | **étage** (`floor`) regroupant les pièces |
| père | **étiquette** |
| grand-père | **étiquette** |
| quoi | **étiquette** sur les entités |

Intérêt : « allume la lumière du salon » à la voix vise la pièce « Salon » (aujourd'hui « Salle », trop large) ; l'étage « Salle » regroupe Salon, Salle à manger, Bibliothèque ; une automatisation peut cibler une étiquette de père ou de grand-père (« extérieur », « rez de chaussée »).

### 3.1 Le problème du lieu précis

Le lieu précis n'est pas toujours un lieu. Simulation : 90 pièces proposées pour 42 existantes (71 à créer), 27 étages, 102 appareils changeraient de pièce, 6 cas ambigus. Exemples de lieux précis qui **ne sont pas des lieux** : « plafonnier » (6 lieux différents), « Huawei 5ktl », « HP LaserJet », « Freebox pop », « colonne 5-rangée 1 » (14 optimiseurs), « télécommande 1.1 » (11).

Règle recommandée (à valider) : un lieu précis devient une **pièce** seulement s'il figure dans une **liste de lieux validée par l'utilisateur** ou s'il existe déjà comme pièce dans HA ; sinon il reste une **précision de l'appareil** (dans le cœur), sans pièce.

### 3.2 Étages

« Extérieur » est un étage comme un autre (le nom d'un étage n'est pas limité aux niveaux d'un bâtiment). Une pièce appartient à **un seul** étage : un père qui diffère entre appareils d'une même pièce (ex. cuisine d'été : rez de chaussée / extérieur) se porte alors par étiquette sur l'appareil.

### 3.3 Étiquettes

Préfixe obligatoire pour ne pas confondre avec les étiquettes d'automatisations (Ballon, Lumières…) : par exemple `quoi: lumière` (préfixe **à valider**). Posées sur les entités pour le « quoi », sur les pièces pour le père et le grand-père (HA accepte les étiquettes sur les pièces).

## 4. Couche 1 — le cœur calcule la taxonomie de tout appareil bien nommé

Pour les appareils non MQTT, le cœur déduit quoi, lieu précis, lieu, père, grand-père **du nom** et les garde dans son **cache** (sans rien écrire dans HA) : l'agent IA, l'arbre où quoi, le planificateur et l'audit en profitent. À préciser : le champ d'une même taxonomie (quoi, précis, lieu, père, grand-père) est le même que `attributs_taxonomie` (§ HaBridgeClient).

## 5. Couche 2 — structures natives de HA

Le cœur, dans sa boucle de réconciliation, crée ce qui manque (étage, étiquette) et range : pièce selon §3.1, étage de la pièce, étiquettes. **Il ne crée jamais une pièce « objet »**. Création d'abord en **simulation** (rapport sans écriture).

## 6. Harmonisation des valeurs

### 6.1 À la source (premier chantier, avant tout le reste)

Valeurs de référence (à valider) : « rez de chaussée », « étage », « extérieur », « maison ». Corrections :

| Source | Où | À corriger |
|---|---|---|
| RFXCOM (stfort) | `data/rfxcom/machine_config-rfxcom-devices-v1.0.yaml` | 30 noms avec `rez-de-chaussée` ; **redémarrage de l'application RFXCOM** nécessaire (moment à fixer avec l'utilisateur) |
| Zigbee2MQTT (ha2) | appareil `télé---salon--salle--rez-de-chaussée--maison` | renommage par le pont de z2m, à chaud, sans changer l'`entity_id` |
| teleinfo (ha2) | `teleinfo-compteurs-v1.0.yaml` : `lieuGrandPere: exterieur` (spa, père « infra ») | `extérieur` |

Les `entity_id` ne changent pas (même forme normalisée).

**À trancher** : « maison » comme **père** de 4 appareils (père attendu : un étage).

### 6.2 Dans `nommage` — la valeur existante l'emporte

Registre mémorisé sur disque, par niveau (lieu précis, lieu, père, grand-père). Une valeur nouvelle est comparée aux valeurs du registre **sans accent, sans tiret et sans casse** : si elle correspond, **on utilise la valeur du registre** ; sinon elle entre au registre telle quelle. La valeur du registre ne change plus ; aucune republication. **Amorçage du registre sur les valeurs corrigées à la source** (donc après §6.1).

## 7. Ordre de réalisation (à valider)

1. Cette spécification ; décisions de l'utilisateur sur les points « à valider ».
2. Cœur, couche 1 (cache), avec tests.
3. Corrections à la source (§6.1), puis `nommage` (§6.2).
4. Couche 2 : simulation, validation, puis écriture (étages, étiquettes, pièces validées).
5. Spécifications du cœur, de `nommage` et de `ia` mises à jour ; nouvelle image.

## 8bis. Étages « extérieur » et lieu précis

Un étage peut s'appeler « Extérieur » (un étage de HA n'est qu'un nom). Une pièce appartient à un seul étage. Variante étudiée (à valider) : lieu précis → pièce, lieu → étage, père et grand-père → étiquettes ; limite : le lieu précis n'est pas toujours un lieu (§3.1).

## 9. Architectures étudiées

### 9.1 Principe de conception (posé le 21/10/2026)

**La logique de résolution (quoi + où → entités) existe en un seul endroit.** Jamais de seconde implémentation (Python à côté du TypeScript du cœur) : tout service offert par HA est soit un **relais léger** vers le cœur, soit la logique elle-même si celle-ci est portée dans HA (§9.3).

### 9.2 Architecture A — la logique reste dans le cœur

HA reçoit une **projection** (pièces, étages, étiquettes de « quoi », alias) ; le cœur reste la source. Ciblage dans HA : (a) **scripts génériques** à base de fonctions de modèles (`label_entities`, `floor_entities`…) une fois la synchronisation faite, sans code, avec un « quoi » = une étiquette ; (b) un service HA `cibler(quoi, lieu, action)` qui **demande au cœur** (relais). Le cœur doit être joignable depuis HA.

### 9.3 Architecture B — la taxonomie portée dans HA (envisagée, à décider)

Une **intégration dédiée** (séparée de Plans) reprend du cœur l'exploitation de la taxonomie : lecture (attributs MQTT, et nom pour les autres appareils), hiérarchie des lieux, rangement des entités par quoi/où, catalogues, recherche. `nommage` reste dans dimotic (il fabrique les attributs des appareils MQTT). Elle expose :

- des **commandes WebSocket** accessibles aux programmes extérieurs à HA avec un jeton : `catalogue`, `entités` (par quoi, lieu, père…), `arbre`, abonnement aux changements ;
- des **services avec réponse** (`cibler`, `résoudre`) utilisables par les automatisations de HA (la réponse est lue dans une variable) ;
- l'accès pour **Assist** (§9.4).

L'agent IA, le planificateur, l'arbre où quoi et le cœur deviendraient des **clients** de cette API au lieu de tenir leur cache (`HaBridgeClient`, `HaStructureRegistry`). Avantages : plus de copie des entités à tenir à jour ; une seule logique près des données ; fonctionne sans le cœur ; services natifs. Coûts : réécriture en Python de la partie taxonomie à tester à résultat identique ; migration par étapes (sinon deux logiques) ; l'intégration doit être installée dans chaque HA (HACS) ; droits (lecture ouverte à un utilisateur limité, actions réservées à un administrateur).

Chemin envisagé : (1) lecture seule (catalogue, entités, arbre) ; (2) le cœur et l'IA lisent ce service derrière un interrupteur ; (3) services de ciblage et Assist ; (4) suppression du code devenu inutile.

### 9.4 Ponts vers Assist (perspectives, aucune réalisation décidée)

Un service de HA n'est pas visible d'Assist par défaut. Trois ponts : (1) une **automatisation à déclencheur par phrase** (« éteins tous les {quoi} de {lieu} ») qui appelle le service de ciblage ; (2) des **phrases personnalisées** avec listes (« quoi », « lieu ») et un `intent_script`, listes générées à partir de la taxonomie ; (3) un **outil** offert à un agent de conversation à modèle de langage. Précautions : **liste blanche** de « quoi » commandables à la voix (jamais serrures ni alarmes), confirmation des actions lourdes (ballons, poêle), et décider qui répond (HA ou dimotic) pour éviter une double action.

### 9.5 Conséquence sur le planificateur

Le planificateur (`fonctionnelles-planificateur` v1.12) stocke des planifications en langage naturel, calcule les échéances, et exécute à chaque tir une structure décidée à la création, recalculée en code ; il est le seul point d'exécution. HA sait déjà faire les déclencheurs (horaires, solaires, changement d'état), les conditions, les attentes et la reprise ; l'agent « claude automatisation » dépose déjà des automatisations directement dans HA. **Seul manque de HA : la résolution dynamique à chaque tir** (« les volets du rez-de-chaussée à 22 h » vise les volets qui existent ce soir-là). L'architecture B comble ce manque : l'automatisation appelle le service de ciblage. Le planificateur n'aurait alors plus de rôle propre : macros → **scripts HA**, `state_change` avec attente → automatisations avec `for:`. **Non décidé** : à faire précéder d'un **inventaire** des planifications actives sur ha2 et noisy2 (cas non couverts par HA : plages `window`/`duration` en mémoire…) et des applications qui dépendent de lui comme point d'exécution (`ia`, `executer_action`).

## 10. Niveaux d'ambition (à choisir)

1. **Synchronisation seule** : pièces, étages, étiquettes de « quoi », alias.
2. 1 + cache de taxonomie dans le cœur pour tous les appareils (§4).
3. 2 + services de ciblage (relais vers le cœur, §9.2) ou architecture B (§9.3).

## 8. Points à valider par l'utilisateur

0. **Architecture** : tout dans le cœur (§9.2) ou taxonomie portée dans HA (§9.3), et sort du planificateur (§9.5) — l'utilisateur continue d'y réfléchir (21/10/2026).
1. Formes de référence des niveaux, et « maison » comme père.
2. Règle du lieu précis (liste validée + pièces existantes) et liste des lieux précis qui sont de vraies pièces.
3. Préfixe des étiquettes et ce qui les porte (entités pour le « quoi », pièces pour père et grand-père).
4. Moment du redémarrage de RFXCOM.
5. Confirmation du périmètre : ha2 seulement.
