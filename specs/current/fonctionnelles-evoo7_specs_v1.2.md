# Spécifications Fonctionnelles — Application EVOO7

**Version :** 1.2
**Date :** 3 Août 2026
**Statut :** Document de référence pour l'application `applications/evoo7`

> Conforme à `techniques-socle-ha-mqtt_specs` (architecture 5 couches, EventBus, MQTT du socle),
> `nommage_specs` (taxonomie QUOI/OÙ), `guide-nouvelle-application_specs`.

> **v1.2** : Rattrapage de dérive code/specs (session du 03/08/2026) — plusieurs fonctionnalités
> réelles n'étaient pas documentées, une était même documentée comme "non commencée" alors que
> **pleinement implémentée** :
> - **§3.3 (nouvelle)** : taxonomie en 5 champs séparés (Quoi/Lieu précis/Lieu/Père/Grand-père),
>   remplace l'ancien parsing de `description` (texte libre, jamais réellement parseable).
> - **§4** : consolidation du paramétrage — le formulaire générique "Paramètres Techniques" est
>   désormais l'unique source de vérité (les événements `evoo7:config:get`/`:save` et l'onglet
>   "Paramétrage" de la page dédiée ont été retirés), avec **rechargement à chaud** désormais
>   fonctionnel pour la connexion MQTT (contredit la v1.1, qui documentait "nécessite un
>   redémarrage").
> - **§9 (nouvelle)** : entité `climate` composite (température, consigne, mode, action) —
>   **entièrement implémentée**, alors que `TODO.md` la liste encore comme "non commencée" (entrée
>   TODO stale, à corriger séparément).
> - **§5** : classification étendue — `binary_sensor` forcé, `deviceClass`/`unitOfMeasurement`,
>   `entity_category` réellement `"diagnostic"` (pas simplement omis) pour les données en lecture
>   seule.
> - **§10** : topic MQTT dédié aux attributs de taxonomie (mécanisme commun du socle, voir
>   `techniques-socle-ha-mqtt_specs` §8.5.4) et retrait de découverte à la désélection.
> - **§6** : précision sur `$date$` (toujours non substitué, mais 43/43 formats concernés, pas
>   41/43) et sur `formatMessageSensor` (toujours jamais relu en pratique) — restent des
>   limitations ouvertes, pas des régressions.

---

## 1. Contexte

EVOO7 Control (VR Electronique) est un régulateur de chauffage/PAC exposant ses données via un
plugin MQTT propre (interface web `http://<host-evoo7>:8082`, onglets "EVOO7 Domotique" /
"Paramétrage" / "Données"). EVOO7 a son propre dialecte MQTT — topics fixes par donnée pour l'état
(`Sensor`), un seul topic partagé pour les commandes, placeholders `$name$`/`$value$`/`$date$` —
distinct du format normalisé du socle HA-MQTT de ce projet.

`applications/evoo7` joue le rôle de traducteur/"postier" entre ces deux mondes, sur le même
principe que RFXCOM/nommage : **deux connexions MQTT indépendantes** — l'une vers le broker EVOO7
(propre à l'application), l'autre via le socle vers le broker HA (mécanisme générique
`integration:evoo7:discovery/:state/:command`, identique à RFXCOM).

## 2. Source des données

Le fichier `applications/evoo7/seed/evoo7_donnees.json` liste les 43 données connues d'EVOO7
Control. Ce fichier sert de **seed** : au premier démarrage, si
`data/evoo7/config-evoo7-donnees-v1.0.yaml` n'existe pas encore, il est généré à partir de ce JSON
(voir §4). Le JSON n'est plus relu ensuite — toute évolution ultérieure passe par le YAML.

## 3. Modèle de donnée

Chaque donnée EVOO7 (`Evoo7DataDefinition`, `applications/evoo7/src/domain/types.ts`) porte les
champs de sélection suivants.

### 3.1 Champs figés (dérivés une fois du JSON source, jamais modifiés par l'UI)

| Champ | Dérivation | Rôle |
|-------|-----------|------|
| `updatable` | `mise_a_jour !== null` dans le JSON source | Conditionne l'affichage de la case "Mise à jour" — si `false`, la donnée n'est **jamais** modifiable. |
| `isConfigData` | `!consultation_originale` dans le JSON source | 8 données sur 43 étaient cochées "Consultation" d'origine sur EVOO7 (mesures/états) — les 35 autres sont des données de configuration. Voir §5 pour son effet réel sur `entity_category` (corrigé v1.2). |

### 3.2 Champs modifiables par l'utilisateur (persistés dans le YAML)

| Champ | Rôle |
|-------|-----------|
| `consultation` | Abonnement au topic Sensor de la donnée + publication découverte/état. |
| `miseAJour` | N'a de sens que si `updatable=true` — active la commande HA→EVOO7. |
| `topicSensor` / `formatMessageSensor` | Surchargeables par donnée. |
| `deviceClass` / `unitOfMeasurement` | ⭐ v1.2 — voir §5.2 |
| `forcedComponent` / `payloadOn` / `payloadOff` | ⭐ v1.2 — voir §5.3 |
| `taxonomieQuoi` / `taxonomieLieuPrecis` / `taxonomieLieu` / `taxonomiePere` / `taxonomieGrandPere` | ⭐ v1.2 — voir §3.3 |

**Règle de découverte** : `integration:evoo7:discovery` est émis pour une donnée ssi
`consultation === true OU miseAJour === true`.

### 3.3 ⭐ Taxonomie en 5 champs séparés (nouveau v1.2)

**Contexte** : `Evoo7Service` construisait initialement `attributs_taxonomie` via
`extractTaxonomy(donnee.description)` — or `description` est une phrase en français libre figée
(ex: "Température ambiante mesurée dans le séjour"), jamais dans le format structuré
`quoi---lieu_precis--lieu--pere--grandpere` attendu. La taxonomie publiée était donc inexploitable
pour les 43 données depuis le début de l'application.

**Solution retenue** (validée avec l'utilisateur) : 5 champs séparés plutôt qu'un champ texte
unique au format `quoi---lieu` — `taxonomieQuoi`/`taxonomieLieuPrecis`/`taxonomieLieu`/
`taxonomiePere`/`taxonomieGrandPere` (`Evoo7DataDefinition`, tous `z.string().optional()` dans
`donnees-config-schema.ts`), visibles/éditables uniquement pour les données sélectionnées
(`consultation || miseAJour`).

`taxonomy.ts::resolveTaxonomy(donnee)` : construit l'`ExtractedTaxonomy` directement depuis les 5
champs si `taxonomieQuoi` est renseigné, sinon **repli** sur l'ancien
`extractTaxonomy(donnee.description)` (comportement historique conservé pour les données pas
encore renseignées — ne casse rien).

**UI** (`config.html`/`config-app.ts`, onglet Données) : colonne "Taxonomie (Quoi / Lieu précis /
Lieu / Père / Grand-père)" — pré-remplit lieu/père/grand-père (jamais `quoi`, spécifique à chaque
donnée) depuis le dernier lieu saisi dans la session (confort de saisie, pas une valeur par
défaut persistée).

**Sauvegarde** : ⭐ contrairement à ce que suggérait un premier jet documenté ailleurs dans le
projet, il n'existe **pas** d'événement `evoo7:donnee:set_taxonomy` séparé — la taxonomie fait
partie du **seul événement de sauvegarde par ligne**, `evoo7:donnee:save` (voir §7), qui porte
d'un coup sélection + topic/format + taxonomie + classe HA. C'est une consolidation volontaire :
*"Un seul événement de sauvegarde par ligne"* (commentaire du code), remplaçant les événements
plus granulaires d'une première conception.

## 4. Fichier de configuration centralisé et paramétrage (⭐ consolidé v1.2)

`data/evoo7/config-evoo7-donnees-v1.0.yaml` — `ConfigFileManager` : chargement, validation Zod,
sauvegarde atomique, pré-remplissage depuis le seed si absent.

**Paramétrage général** (`data/evoo7/config.yaml`, objet nu) — **consolidé** depuis v1.2 : le
formulaire générique "Paramètres Techniques → EVOO7" (`EVOO7_UI_METADATA`,
`applications/evoo7/src/domain/index.ts`) est désormais l'**unique** source de vérité pour tout le
paramétrage (connexion broker EVOO7, `bridgeInstance`, topic/format de commande global). Deux
groupes de champs :
- **Broker EVOO7** : `mqtt.host`, `mqtt.port`, `mqtt.username`, `mqtt.password`, `mqtt.qos`,
  `bridgeInstance`.
- **Commande EVOO7** : `topicCommand`, `formatMessageCommand`.

L'onglet "Paramétrage" de la page dédiée (`config.html`) a été **retiré** — ne reste que
"Données". Les événements `evoo7:config:get`/`evoo7:config:save`, qui géraient auparavant un
second chemin de sauvegarde concurrent pour ces mêmes champs (documenté comme limitation en v1.1 —
*"nécessite un redémarrage du serveur"*), sont **supprimés** du code.

**⭐ Rechargement à chaud désormais fonctionnel** — contredit directement la limitation documentée
en v1.1 : `Evoo7Service` s'abonne à `app:module:config:saved`
(`reconnectMqttIfConfigChanged()`), recharge sa config, compare `mqtt` par valeur (`JSON.stringify`)
et ne déconnecte/reconnecte `Evoo7MqttClient` **que si** la configuration broker a réellement
changé — plus besoin de redémarrer le serveur pour appliquer un changement d'hôte/port/identifiants
du broker EVOO7.

## 5. Détermination du composant HA (étendu v1.2)

### 5.1 Règle de base

`determineComponent()` (`classification.ts`) :

| Forme de la donnée | `updatable=true` | `updatable=false` |
|---|---|---|
| `min`/`max` (nombre) | `number` | `sensor` |
| `valeursPossibles` (liste de valeurs) | **`sensor`** (jamais commandable — voir §6) | `sensor` |
| ni l'un ni l'autre (texte libre) | `text` | `sensor` |

Cette règle de base est désormais **surchageable** par `forcedComponent` (§5.3) et par
l'appartenance à l'entité composite `climate` (§9, qui retire ses données dépendantes du flux de
publication individuelle standard).

### 5.2 ⭐ `deviceClass` / `unitOfMeasurement` (nouveau v1.2)

Champs optionnels par donnée, saisis dans l'UI (`config-app.ts::renderDeviceClassCell`, pilotés
par des tables `DEVICE_CLASS_UNITS`/`DEVICE_CLASS_LABELS`) — alimentent directement les clés HA
standard `device_class`/`unit_of_measurement` du message de découverte. L'unité n'est émise que si
`deviceClass` est renseigné.

### 5.3 ⭐ `binary_sensor` forcé (nouveau v1.2)

`Evoo7Component` admet désormais une 5ème valeur : `'binary_sensor'`. Champ `forcedComponent` sur
la donnée (avec `payloadOn`/`payloadOff` associés, mappés vers `payload_on`/`payload_off` dans la
découverte) — permet de forcer une donnée textuelle/numérique à s'afficher comme `binary_sensor`
côté HA plutôt que `sensor`, indépendamment de la règle §5.1. Prioritaire sur toute autre règle de
classification.

### 5.4 ⭐ `entity_category` — comportement réel (corrigé v1.2)

La v1.1 documentait *"`isConfigData=true` pilote `entity_category: "config"`, omis pour les 8
non-config"* — **inexact**. Le comportement réel :
- `isConfigData=true` **et** composant commandable (`number`/`text`) → `entity_category: "config"`
- `isConfigData=true` **et** composant en lecture seule (`sensor`/`binary_sensor`) →
  `entity_category: "diagnostic"` (**pas** `"config"` — HA **rejette silencieusement** toute
  entité déclarée `entity_category: "config"` sur une plateforme en lecture seule ; l'entité
  n'apparaît alors jamais dans HA, sans message d'erreur exploitable).
- `isConfigData=false` (les 8 données "mesure/état" d'origine) → pas de `entity_category`
  (entité "principale").

Puisque la majorité des 43 données EVOO7 sont des capteurs en lecture seule (`sensor`), la
correction touche la quasi-totalité du parc — la v1.1 aurait fait échouer silencieusement la
publication de la plupart des entités `isConfigData=true` en lecture seule si elle avait
effectivement été appliquée telle quelle.

Toutes les entités partagent le même bloc `device` HA (`identifiers: ["evoo7_control"]`), sauf
l'entité `climate` composite (§9), qui a son propre bloc distinct.

## 6. ⚠️ Limitations connues

### 6.1 Listes de valeurs non traduites (inchangé depuis v1.1)

Les codes numériques documentés dans les commentaires HTML de la page de configuration EVOO7 (ex:
`etat_fonctionnement` → `0=Arrêt, 1=Chauffage, 2=Raffraichissement`) **ne correspondent pas aux
valeurs réellement observées sur le fil MQTT** (vérifié par sniffing du broker EVOO7). Décision :
toute donnée à liste de valeurs reste exposée en lecture seule (`sensor`, passthrough), sans
traduction ni commande.

### 6.2 ⭐ `$date$` jamais substitué (précision de portée, v1.2)

Le commentaire d'en-tête de `evoo7-templates.ts` annonce la substitution de `$name$`/`$value$`/
`$date$` — seuls `$name$` (topics) et `$value$` (commandes sortantes) sont réellement substitués.
**Aucun `.replace(/\$date\$/g, ...)` n'existe nulle part dans le code.** Vérifié : le placeholder
`"___date":"$date$"` est présent dans **43 des 43** `formatMessageSensor` du seed actuel (chiffre
corrigé — une évaluation antérieure avait compté 41/43, à cause de deux entrées temporairement
tronquées dans le fichier persisté, depuis restaurées) — `$date$` repart donc actuellement tel
quel, non substitué, dans la quasi-totalité des messages traités.

### 6.3 `formatMessageSensor` jamais relu en lecture (inchangé depuis v1.1, reformulé)

`extractSensorValue(payload)` prend `payload` comme **seul** paramètre et suppose toujours que la
valeur est portée par la clé JSON `"status"` — `formatMessageSensor` (éditable par donnée, avec sa
propre icône de sauvegarde) est bien **persisté**, mais **jamais lu** pour interpréter les messages
entrants. Si une donnée EVOO7 changeait un jour de format réel, cette configuration resterait
inerte sur le chemin de lecture (seul `topicSensor`, via `$name$`, a un effet réel côté réception).

### 6.4 Pas de validation serveur de `formatMessageSensor`

Aucune vérification (JSON valide, non vide) avant d'accepter une sauvegarde de
`formatMessageSensor` — une saisie interrompue peut écraser silencieusement une valeur correcte
(déjà arrivé une fois en pratique, corrigé manuellement par restauration depuis le seed).

## 7. Templates HA (value_template / command_template)

Le topic d'état de notre socle porte l'enveloppe JSON `{"state": ...}` — `value_template` lit donc
`value_json.state` pour les composants sensor/switch/cover/binary_sensor. Le composant `light`
(non utilisé par EVOO7 à ce jour, réservé à d'éventuelles évolutions) attendrait
`state_value_template` — voir `techniques-socle-ha-mqtt_specs` §8.5.4 pour la distinction générale.

`command_template` (nécessaire pour `number`/`text` uniquement) encapsule la valeur brute publiée
par HA dans `{"value": ...}` :
- `number` : `{"value": {{ value }} }` (valeur numérique non quotée)
- `text` : `{"value": "{{ value }}"}` (valeur quotée)

## 8. Flux de données

### 8.1 État EVOO7 → HA

1. `Evoo7MqttClient` reçoit un message JSON sur le topic Sensor d'une donnée sélectionnée.
2. `extractSensorValue()` extrait la clé `status` du payload (voir limitation §6.3).
3. `Evoo7Service` publie `integration:evoo7:state {bridgeInstance, deviceId, state: {state: value}}`
   — **⭐ v1.2** : ne porte plus de bloc `attributes: {evoo7_id: id}` comme en v1.1 — les
   identifiants internes ne sont plus dupliqués dans l'état (déjà connus de HA via `unique_id`).
   La taxonomie suit désormais le mécanisme générique du socle (topic dédié, §10), pas l'état.

### 8.2 Commande HA → EVOO7

1. HA publie sur le topic de commande de l'entité (encapsulé en JSON par `command_template`).
2. Le socle route vers `integration:evoo7:command {deviceId, command: {value}}`.
3. `Evoo7Service.handleHaCommand` vérifie `updatable && miseAJour` et que le composant n'est pas
   `sensor`, puis construit le message EVOO7 et le publie sur le topic Commande unique d'EVOO7.

⚠️ Pas de confirmation immédiate : si la donnée n'est pas aussi en `consultation=true`, HA ne
recevra jamais d'écho de la nouvelle valeur tant qu'EVOO7 ne republie pas spontanément.

## 9. ⭐ Entité `climate` composite — implémentée (nouveau v1.2)

> ⚠️ **`TODO.md` liste encore cette fonctionnalité comme "non commencée"** — entrée stale, à
> corriger séparément (hors périmètre de cette mise à jour de specs). Elle est en réalité
> **entièrement implémentée et fonctionnelle**, contrairement à ce qui était supposé au moment où
> le rattrapage de ce document a été engagé.

### 9.1 Principe

Une entité `climate` HA a besoin de plusieurs valeurs liées (température courante, consigne
cible, mode/action de fonctionnement) qui correspondent à **plusieurs données EVOO7 distinctes** —
impossible à traiter comme un simple `forcedComponent` sur une donnée isolée (§5.3). L'entité
`climate` est donc une **entité composite**, agrégeant 7 données EVOO7 sous une seule entité HA.

### 9.2 Configuration

`Evoo7DonneesConfig` porte désormais deux clés au premier niveau : `{ evoo7_donnees, thermostat }`.
`Evoo7ThermostatConfig` : `{ enabled: boolean, allowCooling: boolean }` (défaut `{false, false}`).

### 9.3 Données dépendantes

7 données EVOO7, plus que les 3-5 pressenties lors de la première évocation de cette idée :
`temp_amb`, `consigne_normal`, `etat_fonctionnement`, `etat_circulateur_pc`,
`etat_circulateur_radiateur`, `etat_eco`, `temp_ext`.

Activer le thermostat (`evoo7:thermostat:save`, `enabled: true`) force-sélectionne automatiquement
les 7 dépendantes (`consultation: true`) ; le désactiver **ne** les désélectionne **pas**
automatiquement (choix délibéré — elles peuvent rester utiles indépendamment).

### 9.4 Discovery et topics — un seul `command_topic` pour trois champs

**Contrainte du socle** : une entité ne peut avoir qu'**un seul** `command_topic`, mais `climate`
a besoin d'en piloter trois (température, mode, préréglage). Résolu par un discriminant `field`
dans le `command_template` — température/mode/preset ciblent tous le **même** topic de commande,
et `Evoo7Service.handleThermostatCommand()` route en interne selon le `field` reçu.

Les topics d'**état** de l'entité composite **réutilisent** les topics d'état déjà publiés par
chaque donnée dépendante — aucune republication dupliquée.

- `field: 'temperature'` → écrit `consigne_normal`
- `field: 'mode'` → écrit `etat_fonctionnement` (off/heat/cool → codes `'0'`/`'1'`/`'2'` — codes
  **documentés mais jamais formellement vérifiés sur le fil**, même réserve que §6.1 pour les
  énumérations EVOO7 en général ; **bypass délibéré** de la règle "lecture seule pour les
  énumérations" — voir note dans le code, commande envoyée malgré tout car nécessaire au
  fonctionnement du climate)
- `field: 'preset_mode'` → écrit `etat_eco`

### 9.5 Action HVAC calculée côté serveur

`publishThermostatState()` calcule `hvac_action` (`heating`/`idle`/`off`) à partir de
`etat_circulateur_pc`/`etat_circulateur_radiateur` et du mode courant — HA ne le déduit pas
lui-même. Tolère deux encodages observés pour les valeurs booléennes EVOO7 (`'1'`/`'0'` documenté
ET `'on'`/`'off'` réellement observé sur le fil) via `buildModeStateTemplate()`.
`temp_ext` est publiée comme simple attribut de l'entité `climate` (pas un champ climate standard
HA).

### 9.6 UI

Carte "Thermostat" dans `config.html` (onglet Données) : case "Activé", case "Autoriser le
refroidissement". Socket : `evoo7:thermostat:save` / `evoo7:thermostat:save:response`.

## 10. ⭐ Attributs de taxonomie et retrait de découverte (nouveau v1.2)

EVOO7 suit désormais le mécanisme générique du socle (voir `techniques-socle-ha-mqtt_specs`
§8.5.4) : `attributsTaxonomie` (construit via `resolveTaxonomy()`, §3.3) est fourni dans
`EssentialEntityData` et publié sur un **topic MQTT dédié**
(`homeassistant/{component}/{objectId}/attributs`), **uniquement à la (re)découverte** — plus dans
l'état (voir §8.1, différence avec la v1.1).

**Retrait de découverte** : décocher `consultation`/`miseAJour` (transition "était publiée" →
"ne l'est plus") déclenche `removeDonneeDiscovery()` — publication d'une chaîne vide retenue sur
le topic de découverte, faisant disparaître l'entité côté HA (mécanisme générique du socle,
`unpublishDiscovery`).

## 11. Socket.io (inventaire réel, remplace la liste partielle de v1.1)

**Server → Client** (persistants : `evoo7:status`, `evoo7:donnees:list`) :
```typescript
'evoo7:status'
'evoo7:donnees:list'
'evoo7:donnee:updated'
'evoo7:donnee:save:response'
'evoo7:thermostat:save:response'
'evoo7:error'
```

**Client → Server :**
```typescript
'evoo7:status:get'
'evoo7:donnees:list:get'
'evoo7:donnee:save'       // ⭐ un seul événement par ligne : sélection + topic/format + taxonomie + classe HA
'evoo7:thermostat:save'   // ⭐ voir §9
```

> ⚠️ `evoo7:donnee:set_selection` / `evoo7:donnee:set_topic` / `evoo7:donnee:set_taxonomy` /
> `evoo7:config:get` / `evoo7:config:save` (tous documentés en v1.1) **n'existent plus** — grep
> confirmé sur l'ensemble de `applications/evoo7/src/` (seules des mentions dans des commentaires
> obsolètes subsistent).

## 12. UI

Un seul onglet — **Données** (l'onglet "Paramétrage" a été retiré, voir §4) : tableau des 43
données (badge config/donnée, contraintes, case Consultation, case Mise à jour, topic/format
Sensor éditables, **colonne Taxonomie** en 5 champs — §3.3, **colonne Classe HA** —
`deviceClass`/`unitOfMeasurement`/`forcedComponent` — §5), plus la carte "Thermostat" (§9.6).

Dashboard : statut des deux connexions (broker EVOO7, bridge socle), compteurs (données connues,
en consultation, en mise à jour), dernier message reçu.

## 13. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 21/07/2026 | Claude | Version initiale — implémentation complète (domaine, MQTT double connexion, UI 2 onglets), validée en conditions réelles. |
| 1.1 | 24/07/2026 | Claude | Correction de chemins uniquement, suite à la restructuration `data/`. Aucun changement de contenu propre à EVOO7. |
| 1.2 | 03/08/2026 | Claude | **Rattrapage de dérive code/specs** : taxonomie en 5 champs séparés (§3.3, `resolveTaxonomy`, événement `evoo7:donnee:save` consolidé), paramétrage consolidé dans le formulaire générique avec rechargement à chaud désormais fonctionnel (§4, contredit la limitation documentée en v1.1), classification étendue (`binary_sensor` forcé, `deviceClass`/`unitOfMeasurement`, `entity_category` réellement `diagnostic` pour les données en lecture seule — §5), entité `climate` composite **entièrement implémentée** (§9, nouvelle — `TODO.md` la liste encore par erreur comme non commencée), topic MQTT dédié aux attributs de taxonomie et retrait de découverte (§10), précision sur `$date$` (43/43 formats concernés, pas 41/43) et inventaire Socket.io réel (§11, remplace une liste partielle et en partie obsolète). |
