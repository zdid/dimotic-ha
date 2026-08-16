# Spécifications Fonctionnelles — Application EVOO7

**Version :** 1.3
**Date :** 16 Août 2026
**Statut :** Document de référence pour l'application `applications/evoo7`

> Conforme à `techniques-socle-ha-mqtt_specs` (architecture 5 couches, EventBus, MQTT du socle
> côté HA — plus côté boîtier, voir v1.3), `nommage_specs` (taxonomie QUOI/OÙ),
> `guide-nouvelle-application_specs`, `fonctionnelles-supervisor_specs` (application migrée en
> process séparé le 16/08/2026, `runsAsSeparateProcess`/`standalone.ts` — architecture détaillée
> dans cette dernière, pas dupliquée ici).

> **⭐ v1.3 (16/08/2026)** : **remplacement complet du transport vers le boîtier** — MQTT
> (broker EVOO7 dédié + traducteur externe) remplacé par une connexion **Socket.IO directe**, le
> vrai protocole natif du boîtier. Découvert en analysant un ancien projet de traduction
> Socket.IO↔MQTT de l'utilisateur (`zdidEVOO7mqtt`, ~2019) : MQTT n'a jamais été le protocole du
> boîtier lui-même, seulement une couche ajoutée par ce traducteur, devenue inutile en parlant
> directement au boîtier. Voir §1/§4/§8 (réécrites), §14 (nouvelle, protocole natif détaillé).
> Vérifié en conditions réelles avant tout code, puis en lecture ET en écriture avec le vrai
> boîtier — voir §13.6. La couche `evoo7-templates.ts` (placeholders `$name$`/`$value$`/`$date$`,
> §6.2/§6.3 de la v1.2) est **supprimée** : sans objet une fois hors MQTT, la limitation qu'elle
> documentait n'existe donc plus (voir §6, révisée). `topicSensor`/`formatMessageSensor` par
> donnée restent dans le schéma/l'UI (cleanup séparé, plus risqué — 43 enregistrements persistés +
> UI dédiée — volontairement différé) mais sont désormais **entièrement vestigiaux** : plus lus
> nulle part dans le code (voir §6.4, nouvelle).

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

EVOO7 Control (VR Electronique) est un régulateur de chauffage/PAC exposant nativement ses données
via un **serveur Socket.IO** embarqué (`http://<host-evoo7>:80`, protocole ancien — voir §13.1 pour
la contrainte de version) — pas via MQTT, contrairement à ce que documentaient les versions
antérieures de cette spec (v1.0-v1.2). L'erreur venait d'un traducteur externe déjà en place
(analysé le 16/08/2026, `zdidEVOO7mqtt`, ~2019) qui exposait le boîtier en MQTT pour le reste du
système d'origine de l'utilisateur — cette couche de traduction n'a jamais fait partie du boîtier
lui-même.

`applications/evoo7` joue le rôle de traducteur/"postier" entre ces deux mondes, sur le même
principe que RFXCOM/nommage, mais avec des protocoles différents de chaque côté (⭐ v1.3) :
**Socket.IO natif** vers le boîtier (`Evoo7SocketIoClient`, connexion directe, §14), **MQTT** via
le socle vers le broker HA (mécanisme générique `integration:evoo7:discovery/:state/:command`,
identique à RFXCOM, inchangé).

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

## 4. Fichier de configuration centralisé et paramétrage (⭐ révisé v1.3 — Socket.IO)

`data/evoo7/config-evoo7-donnees-v1.0.yaml` — `ConfigFileManager` : chargement, validation Zod,
sauvegarde atomique, pré-remplissage depuis le seed si absent. **Inchangé par la migration v1.3** :
la clé `id` de chaque donnée (ex: `temp_depart_pc`) s'est révélée être exactement le nom natif
Socket.IO du boîtier — aucune migration de données n'a été nécessaire.

**Paramétrage général** (`data/evoo7/config.yaml`, objet nu) — le formulaire générique "Paramètres
Techniques → EVOO7" (`EVOO7_UI_METADATA`, `applications/evoo7/src/domain/index.ts`) reste l'unique
source de vérité, mais son contenu change entièrement (⭐ v1.3) — schéma `evoo7ConfigSchema` :
```yaml
enabled: true
bridgeInstance: evoo7_bridge_0001
box:
  address: 192.168.1.55   # découverte par élimination sur le sous-réseau, voir §13.1
  port: 80
  user: domotique
  password: ''
donneesConfigFile: config-evoo7-donnees-v1.0.yaml
```
- **Boîtier EVOO7** (`box`) : `address`, `port`, `user`, `password` — remplace intégralement
  l'ancien groupe "Broker EVOO7" (`mqtt.host`/`port`/`username`/`password`/`qos`), **retiré** du
  schéma et du formulaire (n'aurait plus eu aucun effet).
- **`topicCommand`/`formatMessageCommand`** — le groupe "Commande EVOO7" (topic/format global des
  commandes sortantes) est **retiré** : sans objet en Socket.IO, où `sendUpdate(name, value)` cible
  directement la clé native de la donnée, sans topic ni template à construire (voir §13.4).
- `bridgeInstance` (identifiant du bridge côté socle HA, inchangé) reste seul champ commun entre
  les deux versions du schéma.

Aucune migration de `data/evoo7/config.yaml` n'a été nécessaire au-delà de la réécriture manuelle de
ce fichier (les anciennes clés `mqtt`/`topicCommand`/`formatMessageCommand` auraient simplement été
silencieusement ignorées par Zod en l'absence de `.passthrough()` sur le schéma, sans faire échouer
le chargement — vérifié, pas exploité en pratique puisque le fichier a été réécrit directement).

L'onglet "Paramétrage" de la page dédiée (`config.html`) reste retiré depuis la v1.2 — ne reste que
"Données".

**Rechargement à chaud** (fonctionnel depuis la v1.2, principe inchangé en v1.3) :
`Evoo7Service` s'abonne à `app:module:config:saved` (`reconnectBoxIfConfigChanged()` — renommée,
anciennement `reconnectMqttIfConfigChanged()`), recharge sa config, compare `box` par valeur
(`JSON.stringify`) et ne déconnecte/reconnecte `Evoo7SocketIoClient` **que si** la configuration du
boîtier a réellement changé.

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

### 6.1 Listes de valeurs non traduites (inchangé depuis v1.1, réévalué partiellement en v1.3)

Les codes numériques documentés dans les commentaires HTML de la page de configuration EVOO7 (ex:
`etat_fonctionnement` → `0=Arrêt, 1=Chauffage, 2=Raffraichissement`) étaient présumés **ne pas
correspondre aux valeurs réellement observées sur le fil MQTT** (sniffing du broker EVOO7, avant la
migration Socket.IO). Décision inchangée : toute donnée à liste de valeurs reste exposée en lecture
seule (`sensor`, passthrough), sans traduction ni commande.

**⭐ v1.3** : re-vérifié en conditions réelles pour `etat_fonctionnement` uniquement (pas les autres
données à liste de valeurs) — le boîtier renvoie bien un **nombre** (`1` observé pendant un
chauffage réel), cohérent avec le mapping documenté (`valeursPossibles`,
`config-evoo7-donnees-v1.0.yaml`). L'écart constaté par le sniffing MQTT d'origine venait donc très
probablement du traducteur externe (§1), pas du boîtier lui-même — sans certitude totale, les autres
données à liste n'ayant pas été revérifiées. La décision de lecture seule reste inchangée (prudence),
indépendamment de cette clarification partielle.

### 6.2 ⭐ Templates `$name$`/`$value$`/`$date$` — supprimés, limitation sans objet (v1.3)

`evoo7-templates.ts` (topicSensor/formatMessage* via placeholders `$name$`/`$value$`/`$date$`,
propre au dialecte MQTT du traducteur externe) est **supprimé** — la limitation documentée en v1.2
(`$date$` jamais substitué) n'a donc plus lieu d'être : il n'y a simplement plus de mécanisme de
template du tout sur le chemin réel (voir §13.4). Voir §6.4 (nouvelle) pour le sort des champs
persistés `topicSensor`/`formatMessageSensor`, devenus vestigiaux plutôt que supprimés.

### 6.3 `formatMessageSensor` jamais relu en lecture — devenu sans objet (v1.3)

La limitation documentée depuis la v1.1 (`extractSensorValue()` ignorait déjà `formatMessageSensor`
en lecture) est **structurellement dépassée** : il n'y a plus d'extraction par payload/clé JSON du
tout — la réception `datas` (Socket.IO) livre directement `{nom_natif: valeur}` par clé, voir §13.4.
Le champ reste persisté (voir §6.4) mais la question de son "utilité en lecture" ne se pose même
plus, le mécanisme entier auquel il appartenait a disparu.

### 6.4 ⭐ `topicSensor`/`formatMessageSensor` par donnée — entièrement vestigiaux (nouveau v1.3)

Ces deux champs (§3.2, persistés dans `config-evoo7-donnees-v1.0.yaml`, éditables dans l'UI, 43
enregistrements) n'ont **volontairement pas été retirés** du schéma/de l'UI lors de la migration
Socket.IO — cleanup séparé, plus risqué (43 enregistrements persistés + colonnes UI dédiées),
délibérément différé (voir `TODO.md`). Grep confirmé (16/08/2026) : **plus lus nulle part** dans
`Evoo7Service.ts`/`Evoo7SocketIoClient.ts` — seuls écrits par `evoo7:donnee:save` (§3.3), sans
aucun effet sur le comportement réel de l'application. Rester visibles dans l'UI aujourd'hui est
trompeur (suggère un effet qu'ils n'ont plus) — signalé pour le cleanup futur, pas corrigé ici.

### 6.5 Pas de validation serveur de `formatMessageSensor`

Aucune vérification (JSON valide, non vide) avant d'accepter une sauvegarde de
`formatMessageSensor` — une saisie interrompue peut écraser silencieusement une valeur correcte
(déjà arrivé une fois en pratique, corrigé manuellement par restauration depuis le seed). Pertinence
réduite depuis v1.3 (§6.4) : le champ n'a plus d'effet fonctionnel, seul le risque de perte de
données déjà saisies subsiste.

## 7. Templates HA (value_template / command_template)

Le topic d'état de notre socle porte l'enveloppe JSON `{"state": ...}` — `value_template` lit donc
`value_json.state` pour les composants sensor/switch/cover/binary_sensor. Le composant `light`
(non utilisé par EVOO7 à ce jour, réservé à d'éventuelles évolutions) attendrait
`state_value_template` — voir `techniques-socle-ha-mqtt_specs` §8.5.4 pour la distinction générale.

`command_template` (nécessaire pour `number`/`text` uniquement) encapsule la valeur brute publiée
par HA dans `{"value": ...}` :
- `number` : `{"value": {{ value }} }` (valeur numérique non quotée)
- `text` : `{"value": "{{ value }}"}` (valeur quotée)

## 8. Flux de données (⭐ réécrit v1.3 — Socket.IO)

### 8.1 État EVOO7 → HA

1. `Evoo7SocketIoClient` reçoit un événement `datas` du boîtier — un objet portant **toutes** les
   clés connues d'un coup (pas seulement celles sélectionnées, contrairement au topic-par-donnée de
   l'ancien schéma MQTT) — voir §13.4 pour la simplification structurelle que ça permet.
2. `onData(name, value)` (callback enregistré par `Evoo7Service`) est invoqué une fois par clé —
   `Evoo7Service.handleEvoo7Data(id, rawValue)` filtre alors sur `donnee.consultation === true`
   (le filtre s'applique désormais **à la réception**, plus à la souscription — il n'y a plus de
   souscription par topic à poser/retirer).
3. `Evoo7Service` publie `integration:evoo7:state {bridgeInstance, deviceId, state: {state: value}}`
   — inchangé depuis v1.2 (pas de bloc `attributes: {evoo7_id: id}`, taxonomie via le topic dédié
   du socle, §10).

### 8.2 Commande HA → EVOO7

1. HA publie sur le topic de commande de l'entité (encapsulé en JSON par `command_template`, §7 —
   **inchangé**, ce chemin socle↔HA ne dépend pas du protocole utilisé côté boîtier).
2. Le socle route vers `integration:evoo7:command {deviceId, command: {value}}`.
3. `Evoo7Service.sendEvoo7Command` vérifie `updatable && miseAJour` et que le composant n'est pas
   `sensor`, puis appelle `Evoo7SocketIoClient.sendUpdate(donnee.id, rawValue)` — `id` est
   directement le nom natif Socket.IO de la donnée, plus de construction de message via template
   (voir §13.4).

⚠️ Pas de confirmation immédiate : si la donnée n'est pas aussi en `consultation=true`, HA ne
recevra jamais d'écho de la nouvelle valeur tant qu'EVOO7 ne republie pas spontanément (inchangé
depuis v1.2 — cette limitation est indépendante du protocole de transport).

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
  **documentés, et leur sens confirmé en lecture** (⭐ v1.3, §6.1 : `1` observé en conditions
  réelles pendant un chauffage réel), **mais l'écriture d'une commande `mode` elle-même reste non
  testée formellement** — seule l'écriture de `field: 'temperature'` (`consigne_normal`) a été
  vérifiée en conditions réelles, voir §13.6 ; **bypass délibéré** de la règle "lecture seule pour
  les énumérations" — voir note dans le code, commande envoyée malgré tout car nécessaire au
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

## 13. ⭐ Protocole natif du boîtier EVOO7 (Socket.IO) — nouveau v1.3

### 13.1 Découverte et version de protocole

Adresse réelle découverte par élimination sur le sous-réseau (`192.168.1.55:80`) — l'adresse
présumée initialement (`.53`) s'est révélée être uniquement le broker MQTT du traducteur externe
(§1), port 80 fermé à cet endroit. **Contrainte de version critique** : le boîtier tourne un
serveur Socket.IO **ancien** (protocole Engine.IO v2, ~2015-2019) — `socket.io-client` **v4**
(installé par défaut par npm) échoue la poignée de main (`connect_error: server error`) ; seul
`socket.io-client@2.5.0` fonctionne. Épinglé explicitement dans `package.json` (pas de plage
semver large) pour éviter qu'un futur `npm install` ne remonte silencieusement vers v4.

### 13.2 Identification

`socket.emit('identification', { user, passwd })` immédiatement après connexion — `passwd` est le
mot de passe en clair **haché en MD5** avant envoi (déduit du traducteur externe,
`appmean.js::md5(data.evoo7passwd)` — pas documenté ailleurs, trouvé par lecture de code). Réponse
`authorized` (avec la liste des profils accordés, ex. `[telemetrie, telemetrieedf, regul, status]`
— `regul` confirme les droits d'écriture) ou `unauthorized`. Testé avec un mot de passe temporaire
fourni explicitement par l'utilisateur pour cette vérification (16/08/2026) — jamais persisté tel
quel, voir `data/evoo7/config.yaml` (`box.password` laissé vide après le test).

### 13.3 Réception des données — événement `datas`

Après identification réussie, le boîtier envoie (et continue d'envoyer, spontanément, à chaque
changement) un événement `datas` : un objet unique portant **toutes** les clés connues du boîtier
d'un coup (`{nom_natif: valeur, ...}`) — pas un message par donnée comme le laissait supposer
l'ancien modèle par topic MQTT. `Evoo7SocketIoClient.onData(callback)` déclenche `callback(name,
value)` une fois par clé présente dans l'objet reçu.

### 13.4 ⭐ Simplification structurelle permise par ce modèle de réception

Parce que **toutes** les clés arrivent systématiquement (contrairement à MQTT où seuls les topics
souscrits arrivaient), tout le mécanisme d'abonnement/désabonnement par topic devient inutile :
`topicToId` (Map), `subscribeTopic()`/`unsubscribeTopic()` (~30 lignes réparties sur 4 points
d'appel dans `Evoo7Service.ts` v1.2) ont pu être **supprimés entièrement**. Le filtre
`consultation === true` (déjà existant) s'applique désormais **à la réception** de chaque valeur
(`handleEvoo7Data()`, §8.1) plutôt qu'à la souscription — la donnée EVOO7 continue d'être reçue par
le client Socket.IO même si elle n'est pas sélectionnée, simplement ignorée après réception (léger
surcoût réseau/CPU négligeable face à la simplicité gagnée).

Écriture : `sendUpdate(name, value)` émet directement `socket.emit('update', { name, value,
echange: true })` — `name` est le nom natif de la donnée (= `donnee.id`, §2/§3), `value` la valeur
brute en chaîne. Plus de construction de topic ni de template JSON à encapsuler.

### 13.5 Confirmation de commande — file d'attente stricte

Le boîtier répond `updateok` ou `updateko` à une commande envoyée, mais **ne fournit aucun moyen
fiable de corréler une réponse à une commande précise** s'il y en avait plusieurs simultanément en
vol (pas d'identifiant de requête dans le protocole observé). `sendUpdate()` maintient donc une
**file d'attente stricte, une seule commande en vol à la fois** (timeout 10s, la suivante n'est
envoyée qu'après résolution/rejet de la précédente) — plus lent en cas de rafale de commandes, mais
sans ambiguïté possible sur quelle réponse correspond à quelle commande.

### 13.6 Vérifié en conditions réelles — lecture et écriture

**Lecture** (16/08/2026, mot de passe vide, sans écriture) : connexion directe réussie, tableau de
bord à jour, aucune erreur console/serveur.

**Écriture** (16/08/2026, avec confirmation explicite préalable de l'utilisateur) : `consigne_normal`
(température thermostat, §9.4 `field: 'temperature'`) changée 18→15 via le vrai code intégré
(`Evoo7SocketIoClient.sendUpdate()`, pas un script isolé) — confirmée par le boîtier (`updateok`),
relue via l'API (`15` confirmé), **et vérifiée indépendamment par l'utilisateur sur l'écran du
boîtier lui-même** (pas seulement une confirmation logicielle). Remise à 18 (valeur d'origine)
ensuite, confirmée de la même manière. Seule `field: 'temperature'` a été testée en écriture — voir
§9.4 pour la réserve restant sur `field: 'mode'`.

## 14. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 21/07/2026 | Claude | Version initiale — implémentation complète (domaine, MQTT double connexion, UI 2 onglets), validée en conditions réelles. |
| 1.1 | 24/07/2026 | Claude | Correction de chemins uniquement, suite à la restructuration `data/`. Aucun changement de contenu propre à EVOO7. |
| 1.2 | 03/08/2026 | Claude | **Rattrapage de dérive code/specs** : taxonomie en 5 champs séparés (§3.3, `resolveTaxonomy`, événement `evoo7:donnee:save` consolidé), paramétrage consolidé dans le formulaire générique avec rechargement à chaud désormais fonctionnel (§4, contredit la limitation documentée en v1.1), classification étendue (`binary_sensor` forcé, `deviceClass`/`unitOfMeasurement`, `entity_category` réellement `diagnostic` pour les données en lecture seule — §5), entité `climate` composite **entièrement implémentée** (§9, nouvelle — `TODO.md` la liste encore par erreur comme non commencée), topic MQTT dédié aux attributs de taxonomie et retrait de découverte (§10), précision sur `$date$` (43/43 formats concernés, pas 41/43) et inventaire Socket.io réel (§11, remplace une liste partielle et en partie obsolète). |
| 1.3 | 16/08/2026 | Claude | **⭐ Remplacement complet du transport vers le boîtier** : MQTT (broker EVOO7 dédié + traducteur externe) remplacé par Socket.IO natif, découvert en analysant un ancien projet de traduction de l'utilisateur (§1, réécrite). Nouveau §13 : protocole natif détaillé (identification MD5, réception `datas` en bloc, `sendUpdate()`, file d'attente stricte des commandes) — vérifié en conditions réelles en lecture ET en écriture (§13.6, avec confirmation physique indépendante de l'utilisateur sur l'écran du boîtier). Config revue (§4) : `box.{address,port,user,password}` remplace `mqtt.*`/`topicCommand`/`formatMessageCommand`. Flux de données réécrit (§8) : filtre `consultation` appliqué à la réception plutôt qu'à la souscription, simplification structurelle (§13.4, suppression de `topicToId`/`subscribeTopic`/`unsubscribeTopic`). Limitations §6.2/§6.3 (v1.2, `$date$`/`formatMessageSensor`) devenues sans objet — `evoo7-templates.ts` supprimé ; `topicSensor`/`formatMessageSensor` par donnée volontairement laissés dans le schéma/l'UI mais désormais entièrement vestigiaux (§6.4, nouvelle). Réévaluation partielle de §6.1 : `etat_fonctionnement` confirmé numérique en conditions réelles (`1` = Chauffage observé), contrairement à la présomption de la v1.1/v1.2 basée sur un sniffing antérieur au traducteur, probablement en cause. Sauvegarde complète avant modification (`backups/evoo7_2026-08-16/`, risque de corruption identifié — matériel de chauffage réel). |
