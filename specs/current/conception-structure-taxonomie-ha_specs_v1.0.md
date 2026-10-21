# Conception — Structure de HA déduite du nommage (pièces, étages, étiquettes) pour tous les appareils

*Version 1.0 — 21 octobre 2026 — **conception, rien n'est réalisé**. Périmètre : **ha2 (Saint Fort) seulement** ; noisy2 n'est pas touché. Les points marqués « à valider » sont des recommandations qui n'ont pas encore reçu l'accord de l'utilisateur.*

## 1. Objet

Tout appareil de HA, quelle que soit son intégration, doit profiter de la taxonomie du nommage `quoi---[lieu précis--]lieu[--père[--grand-père]]` : l'agent IA le retrouve par « quoi » et « où », l'assistant vocal comprend ses pièces, les automatisations ciblent des étages et des étiquettes. Un appareil neuf devient exploitable dès qu'il porte un nom au bon format.

## 2. Constat (ha2, simulation du 21/10/2026)

- 154 appareils examinés : **107** portent les attributs `attributs_taxonomie` (appareils MQTT passés par `nommage`), **30** n'ont qu'un nom conforme (renommés à la main le 20/10 : Huawei, climatiseurs, Cast, imprimante…), **22** n'ont aucune taxonomie (téléphones, appareils « dimotic-ha », thermostats Zigbee indisponibles…).
- HA ne permet **pas** d'ajouter un attribut personnalisé à l'entité d'une autre intégration : seul le MQTT le permet (la découverte est écrite par nous).
- Le cœur (`DeviceAreaAssigner.reconcilierNoms`, toutes les 10 min) range déjà tout appareil dans la **pièce de son lieu** (2ᵉ segment du nom). Vérifié : les 30 appareils renommés sont dans la bonne pièce.
- **Aucun étage** défini dans HA (42 pièces à ha2, aucune rattachée à un étage). Les 4 étiquettes existantes (Ballon, Lumières, Association, Rappels) ne servent qu'à ranger les automatisations dans le tableau « Automatisations » (filtre `domain: automation` + étiquette).
- **Valeurs non unifiées** : père « rez de chaussée » ×25 contre « rez-de-chaussée » ×31 ; « extérieur » ×16 contre « exterieur » ×1 ; « maison » utilisé comme père pour 4 appareils (et comme grand-père pour 57). Les **identifiants normalisés** (`slug_*`) sont déjà identiques (`rez_de_chaussee`) : seule la valeur affichée diffère.

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

## 8. Points à valider par l'utilisateur

1. Formes de référence des niveaux, et « maison » comme père.
2. Règle du lieu précis (liste validée + pièces existantes) et liste des lieux précis qui sont de vraies pièces.
3. Préfixe des étiquettes et ce qui les porte (entités pour le « quoi », pièces pour père et grand-père).
4. Moment du redémarrage de RFXCOM.
5. Confirmation du périmètre : ha2 seulement.
