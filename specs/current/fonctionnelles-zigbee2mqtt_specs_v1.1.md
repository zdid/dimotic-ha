# Spécifications — Pilote zigbee2mqtt

**Version :** 1.1
**Date :** 16 Octobre 2026
**Statut :** Réalisé et essayé sur une instance de développement isolée (faux zigbee2mqtt) ; pas encore déployé
**Type :** Application d'intégration (process séparé), arrive **désactivée** (activation à chaud)
**Dépend de :** `conception-gestion-pilotes_specs` (v1.6, contrat des pilotes), `fonctionnelles-supervisor_specs` (§14ter, canal pilotes), `fonctionnelles-nommage_specs` (taxonomie QUOI---OÙ et relais des découvertes)

## 1. Objet et périmètre

Permettre à l'agent IA d'un site de **lister, qualifier, renommer, supprimer, remplacer et appairer** les appareils Zigbee d'une instance **zigbee2mqtt existante**, par le canal « gestion des pilotes ». L'application **n'installe ni ne démarre** zigbee2mqtt (voir `Zigbee2mqttDeployService` du cœur pour cela) : elle lui parle par MQTT.

Hors périmètre : les **découvertes HA** des appareils (zigbee2mqtt les publie lui-même sur `homeassist/…`, `nommage` les relaie vers `homeassistant/` — **inchangé**), la page web (pas d'écran dans cette version), les groupes et les scènes Zigbee.

## 2. Principe

Une application `zigbee2mqtt` autonome, comme `arexx` ou `rfxcom` (conception v1.1 §9). Elle utilise la connexion MQTT du socle en **passthrough** (`integration:zigbee2mqtt:passthrough:*`), annonce **un pont** `z2m_bridge_<machineId>` (type `zigbee2mqtt`) et implémente le contrat des pilotes. Le nom d'un appareil dans zigbee2mqtt (`friendly_name`) **est** son nommage : `quoi---lieu_précis--lieu` (ex. `frigo---cuisine--cuisine`), le même format que partout.

| Sujet suivi (QoS 1) | Contenu |
|---|---|
| `<base>/bridge/devices` (retenu) | appareils : `ieee_address`, `friendly_name`, `type`, `interviewing`, `interview_completed`, `supported`, `disabled`, `definition` |
| `<base>/bridge/state` | `online`/`offline` (texte en 1.x, `{"state":"online"}` en 2.x : les deux acceptés) |
| `<base>/bridge/info` | version |
| `<base>/bridge/response/#` | réponses aux requêtes, retrouvées par le champ **`transaction`** que l'application ajoute à chaque requête |

Les requêtes partent sur `<base>/bridge/request/<action>` (jamais retenues). Délai d'attente d'une réponse : `delaiReponseSec` (30 s).

## 3. Ordres

Le pont déclare : `lister`, `decouverts`, `adopter`, `modifier`, `remplacer`, `supprimer`, `appairer`. **Pas** d'`effacer`/`ignorer` (zigbee2mqtt garde sa liste d'appareils) ni de `redemarrer` (redémarrer zigbee2mqtt coupe tout le réseau Zigbee). Tout ordre est refusé si zigbee2mqtt est hors ligne ou muet.

| Ordre | Effet |
|---|---|
| `lister` | appareils du réseau, **sans le coordinateur** : id (adresse IEEE), nom, type, modèle, fabricant, interview (`en cours`/`terminée`/`incomplète`), `reconnu`, `desactive`, `qualifie` (nom au format `quoi---lieu`) |
| `decouverts` | appareils pas encore qualifiés : **interview en cours** ou nom **sans `---`** (souvent l'adresse IEEE) |
| `adopter` | `id` (IEEE ou nom), `quoi` et `lieu` **obligatoires**, `lieuPrecis`, `lieuPere` (étage), `lieuGrandPere` (bâtiment) facultatifs → `device/rename` avec `homeassistant_rename: true`. Refusé : appareil en interview (attendre la fin), déjà qualifié (utiliser `modifier`), nom déjà pris |
| `modifier` | renomme un appareil déjà qualifié ; les parties non données reprennent le nom actuel ; refusé si le nom ne change pas |
| `supprimer` | `device/remove` ; `force: true` pour un appareil mort qui ne répond plus (il n'est alors pas prévenu : s'il est encore sous tension, il se reconnectera) |
| `remplacer` | `ancien`, `nouveau` : **suppression de l'ancien PUIS renommage du neuf avec le nom de l'ancien** (même nommage → mêmes `entity_id`, comme pour l'AREXX). Le neuf doit être **déjà appairé**, sorti d'interview et non qualifié. `force` comme `supprimer`. Si la suppression échoue, le renommage n'est pas tenté |
| `appairer` | `permit_join` pour `duree` secondes (défaut `appairageDefautSec` 120), **plafonnée** à `appairageMaxSec` (254). Mettre l'appareil en mode appairage est une action **physique** : l'aperçu le rappelle |

**Nommage (v1.1)** : La distribution est **positionnelle** : sans précis ni père `quoi---lieu` ; un père (ou un grand-père) **sans lieu précis** répète le lieu en tête (`quoi---lieu--lieu--père`, forme déjà utilisée comme `frigo---cuisine--cuisine`) ; **un grand-père exige un père**. Paramètres des ordres : `quoi`, `lieu` (obligatoires), `lieuPrecis`, `lieuPere`, `lieuGrandPere` (facultatifs) ; avec `modifier`, seules les parties données changent (`""` efface une partie). Une seule fonction les compose (`composerNom` / `decomposerNom`, cœur `pilotes/nom.ts`), utilisée par tous les pilotes. L'agent lit d'abord les noms existants pour reprendre l'étage et le bâtiment du site, et ne demande que ce qui manque.

Règles communes (contrat) : aperçu + jeton (l'état concerné = appareils, noms, interviews, état de z2m), accord explicite, une modification à la fois, validation du nommage (`--` interdit dans les parties).

**Sauvegarde** : zigbee2mqtt écrit lui-même sa configuration ; **aucune sauvegarde côté dimotic-ha** (l'aperçu le dit). **Attention** : renommer change les sujets MQTT de l'appareil et ses `entity_id` dans HA — l'aperçu l'écrit ; les automatisations et tableaux de bord qui citaient l'ancien nom sont à corriger (hors `remplacer`, qui conserve le nom).

## 4. Configuration (`data/core/config.yaml`, section `zigbee2mqtt`)

| Clé | Défaut | Rôle |
|---|---|---|
| `baseTopic` | `zigbee2mqtt` | `mqtt.base_topic` de zigbee2mqtt |
| `bridgeInstance` | `z2m_bridge` | préfixe du pont ; `_<machineId>` y est ajouté |
| `delaiReponseSec` | 30 | attente d'une réponse |
| `appairageDefautSec` / `appairageMaxSec` | 120 / 254 | durées d'appairage |

Le broker est celui de `ha.mqtt` : zigbee2mqtt doit publier sur le **même** broker que dimotic-ha (cas de noisy2 et de Saint Fort, voir `zigbee2mqtt/data/configuration.yaml`).

## 5. Vérifié

- 15 tests automatisés (`applications/zigbee2mqtt`, `npm test`) : nommage, ordres, refus, ordre supprimer-puis-renommer, échec intermédiaire, plafond d'appairage, transactions des réponses, états 1.x/2.x.
- **Essai réel** (16/10/2026) sur une instance de développement isolée avec un **faux zigbee2mqtt** (broker privé) : activation à chaud, présence du pont, `decouverts`, `adopter` (aperçu → jeton → renommage reçu par le faux z2m avec `homeassistant_rename` et `transaction`), `lister`, `appairer 999` plafonné à 254 s.
- **Non vérifié** : avec un vrai zigbee2mqtt et un vrai appareil (interview, `remove`, effet sur les `entity_id` dans HA), le `remplacer` de bout en bout, la réaction des découvertes relayées par `nommage` après un renommage.
