## Site ha2 (Saint Fort) — connaissances propres à cette maison

Section propre à CE site (fichier `site.md` posé à côté du CLAUDE.md ; modèle versionné : `applications/ia/agent/claude-md/sites/ha2.md`).
Mission sur ce site : **créer et maintenir des automatismes dans Home Assistant** ; tu utilises le système en place, tu ne le développes pas.
**Niveau d'autorisation de ce site : niveau 2 : dépôt dans Home Assistant par les outils MCP de dimotic**, de façon encadrée (aperçu, accord de l'utilisateur, sauvegarde —
voir « Déposer un automatisme dans HA ») ; ceci remplace le « niveau 0 » par défaut du rôle ci-dessus.
Rédigé le 2026-10-07 d'après les specs ; ce qui n'a pas été revérifié en réel est signalé « à vérifier ».

### Règles d'or du site

1. **Lire avant d'écrire.** Toujours inventorier l'existant (entités, automatisations, scripts, helpers) avant d'en créer.
2. **Production réelle, habitants à la maison.** Pas de test qui allume/éteint/ouvre/ferme sans prévenir. Le **poêle** est en production : ne pas y toucher sans accord explicite.
3. **Sauvegarder avant toute modification de fichier** (`cp x x.bak-AAAAMMJJ`) ; ne jamais modifier un fichier de `.storage/` HA quand HA tourne.
4. **Pas de redémarrage** de HA, zigbee2mqtt, mosquitto ou dimotic-ha sans l'accord de l'utilisateur ; si un redémarrage est nécessaire, le dire et attendre.
5. **Ne jamais éditer la config de dimotic-ha ni du code** (`/docker/dimotic-ha/...`) : c'est un autre chantier, géré ailleurs. Lecture seule.
6. **Anti-boucle** (incident du 18/08 : une automatisation en boucle a mis ha2 hors service ~1h20). Toute automatisation qui agit sur ce qu'elle observe : déclencheur `platform: state` avec `from`/`to` explicites, `mode: single`, condition de garde, jamais d'action qui re-déclenche son propre trigger.
7. **Réponses courtes, agir plutôt qu'expliquer.** Rendre compte : ce qui est créé (entity_id), comment le tester, comment l'annuler.
8. Demander confirmation pour tout ce qui est difficile à annuler ou touche une autre machine.

### 2. Architecture en une page

```
Matériel / protocoles ──► drivers ──► MQTT (mosquitto sur ha2) ──► Home Assistant
   Zigbee (dongle ha2) ──► zigbee2mqtt ──┘                              ▲
   RF433, GPIO, Modbus, Tasmota, AREXX... ─► dimotic-ha (drivers) ──────┘
                                              + nommage (QUOI/OÙ, Areas)
```

Sur ha2, en Docker, répertoire `/docker/<service>/` (compose.yaml + config) :

| Service | Rôle | Config |
|---|---|---|
| `homeassistant` | Home Assistant | `/docker/homeassistant/config` |
| `mosquitto` | broker MQTT | `/docker/mosquitto` |
| `zigbee2mqtt` | passerelle Zigbee (le seul dongle Zigbee du site est sur ha2) | `/docker/zigbee2mqtt` |
| `dimotic-ha` | applications domotiques (ci-dessous) | `/docker/dimotic-ha`, UI web du core |

`docker ps` pour confirmer l'état. Les logs sont en rotation (10 Mo × 5).

### 2bis. Compte, root et accès à HA

- **Compte** : tu tournes sous l'utilisateur `claude` (un par machine du parc). Ce compte n'est pas root.
- **Root** : tu n'as **pas** d'accès root automatique. Si une action l'exige (édition hors de ton périmètre, redémarrage d'un service, installation d'un paquet), **dis précisément la commande et pourquoi**, puis attends que l'utilisateur l'exécute (`su -` / `sudo`, avec mot de passe). Ne tente jamais de contourner (clé root, `docker` pour monter `/`, etc.).
- **Droits évolutifs** : les droits de ce compte seront ajustés avec toi selon ce dont tu as besoin. Quand un droit te manque, demande-le en listant la commande exacte et l'usage ; ne détourne pas un autre accès.
- **Accès à HA** : directement par l'API native de HA, en REST (`http://localhost:8123/api/...`) ou WebSocket (`ws://localhost:8123/api/websocket`), avec un **jeton longue durée dédié** stocké dans **`~/.ha_token`** (`chmod 600`, jamais dans un dépôt, jamais affiché dans une réponse) — ce chemin remplace `./ha_token` cité plus haut. Pas de passage par dimotic-ha : il n'expose pas d'API pour un client tiers et son jeton n'est pas le tien.
- **Outil** : `~/automatismes/tools/ha_ws.py '<json>'` (client WebSocket, lit `~/.ha_token`, pour LIRE), ex. `ha_ws.py '{"type":"config/area_registry/list"}'`.
- **Dimotic-ha** : lecture seule. Pour les règles en langage naturel, utiliser le planificateur ou `ia` via leur interface, avec l'utilisateur.

### Déposer un automatisme dans HA (par les outils MCP de dimotic, jamais par les fichiers ni en direct)

Les fichiers de `/docker/homeassistant/config` appartiennent à root : **tu ne les modifies pas**. Le dépôt passe par le serveur MCP « dimotic »
(le jeton HA en écriture reste côté dimotic-ha ; le tien sert à LIRE) :
1. `lire_automatisations_ha` : inventaire de l'existant (évite les doublons) ; `sauvegardes: true` pour retrouver une version antérieure.
2. `deposer_automatisation(id, definition)` **sans** `confirme` : renvoie un APERÇU (rien n'est modifié) et des avertissements (anti-boucle, mode). Montre-le à l'utilisateur.
3. Après son accord explicite seulement : même appel avec `confirme: true`. dimotic sauvegarde l'existant, dépose, HA valide le schéma et recharge.
4. Rends compte : `id`, entity_id obtenu, comment tester, comment annuler (la réponse donne la sauvegarde à redéposer, ou `supprimer_automatisation`).
Un refus de HA (schéma) revient tel quel : corrige la définition, ne contourne pas.

### 3. Convention de nommage QUOI / OÙ (essentielle)

Tout appareil publié via dimotic-ha porte un nom `quoi---lieuprécis--lieu--étage--bâtiment`
(ex. `Lumière---Plan de Travail--Atelier`). Le système en déduit :
- le **QUOI** → nom affiché, et `entity_id` = `domaine.slug_du_quoi` (ex. `Sèche-serviette` → `switch.seche_serviette`) ; suffixe numérique en cas de collision ;
- le **LIEU** (pièce) → **Area HA** (créée si absente) ; étage/bâtiment → Areas/étages/étiquettes.

Conséquences pour les automatismes :
- **Règle `attributs_taxonomie` (prioritaire)** : pour identifier le QUOI et le lieu d'une entité, l'attribut d'état `attributs_taxonomie` (posé par dimotic-ha) prime sur l'Area HA et sur le nom/entity_id. Seulement s'il est absent, se rabattre sur : Area de l'entité, sinon Area du device, nom du device, entity_id.
  - Contenu : `{quoi, slug_quoi, lieu_precis/slug_precis, lieu_principal/slug_lieu, lieu_pere/slug_pere, lieu_grand_pere/slug_grand_pere}` (clés selon la profondeur du nom). Constaté le 2026-10-07 sur 290/768 états.
  - Pourquoi : le nom du device HA est souvent le lieu précis (« Bureau ») et l'entity_id ne suit pas toujours le QUOI (`event.bouton_bureau_salle_a_manger_action`) ; l'Area peut diverger.
  - Usage : filtrer `/api/states` sur `attributs_taxonomie.slug_quoi` + `slug_lieu` (template : `states | selectattr('attributes.attributs_taxonomie','defined')`). Si l'Area HA contredit la taxonomie, suivre la taxonomie et signaler l'écart.
- **Cibler par Area ou par étiquette** plutôt que lister des entity_id quand c'est possible ; chercher une entité par son QUOI + lieu (taxonomie d'abord, Area ensuite).
- **Ne jamais renommer à la main** une entité/Area gérée par ce système : le renommage est recalculé (les entity_id d'un plan peuvent devenir obsolètes — risque déjà constaté).
- Si une entité n'a pas d'Area : problème de nommage à signaler, pas à contourner par du code.

### 4. Applications dimotic-ha (fonctionnel)

Les applications tournent dans le conteneur `dimotic-ha` (UI web, une par menu). Specs : dépôt
`specs/current/fonctionnelles-<app>_specs_*.md` (sur la machine de dev, pas sur ha2).

### Intégration / entités
- **nommage** : normalise les noms MQTT (QUOI/OÙ) et crée Areas/étages dans HA. Écoute le MQTT du core.
- **arbreouquoi** : visualisation lecture seule de l'arbre Area → QUOI → entités ; sert à auditer.
- **rfxcom** : émetteur-récepteur RFXtrx433 (433 MHz) : lumières, prises, volets radio, télécommandes → récepteurs logiques, scènes. Un volet arrêté entre butées est publié « ouvert » avec un pourcentage. **Le RFXCOM est physiquement sur stfort** (pas ha2).
- **rpigpio** : paramétrage de broches GPIO via conteneur `mqtt-io` sur des Raspberry distants (relais, entrées) ; une broche = une entité HA.
- **arexx** : sondes température/humidité AREXX (lecture seule).
- **teleinfo** : 2 compteurs EDF (mode historique) lus via un RPi1 ; **compteurmodbus** : compteurs Modbus RTU (DDSU666-H, DDZY422-D2) pour la puissance réseau (alimente notamment l'intégration Omnibattery / batterie Marstek).
- **evoo7** : régulateur chauffage/PAC EVOO7 (Socket.IO → MQTT).
- **tasmota** : flotte d'appareils Tasmota (relais, volets, capteurs), nommage QUOI/OÙ, **thermostats** (relais + thermomètre, moteur Berry/règles), minuterie, programmation horaire.
- **espdisplay** / **haplan** : plans d'étage interactifs (web, carte Lovelace, écrans ESP32 tactiles). Les plans référencent des entity_id : à ne pas casser.

### Automatismes natifs dimotic-ha (à connaître avant de dupliquer)
- **ia** : fait croire à HA qu'il parle à un serveur Ollama ; comprend le français domotique (interpréteur déterministe puis Mistral) avec 3 outils : `lister_entites`, `obtenir_etat`, `executer_action` (verbe + quoi + lieux).
- **planificateur** : stocke et **exécute** les planifications/macros en langage naturel : déclencheurs `delay`, `time`, `date`, `recurrence`, `window` (action à `from`, inverse à `to`), `duration`, `sun` (lever/coucher, suncalc), et **réactifs à un changement d'état** ; conditions (soleil, numérique, état) ; actions résolues par QUOI/OÙ. Seul point d'exécution du système côté dimotic-ha.
- **scriptsha** : dépose/diffuse/retire des `script.*` HA natifs depuis un YAML ; peut provisionner des helpers (ex. un `timer` par lumière pour la minuterie). Scripts « indisponibles + piles » intégrés.
- **supervision** / **sauvegarde** / **outils** : supervision multi-machines, sauvegarde Nextcloud, scripts d'exploitation. Rien à automatiser ici.

**Où mettre un nouvel automatisme ?** (à trancher avec l'utilisateur si doute)
- Règle simple et durable, avec triggers/conditions HA → **automatisation HA native** (YAML ou UI), cibles par Area/étiquette.
- Séquence réutilisable appelée de plusieurs endroits → **script HA** (idéalement déposé via scriptsha pour rester suivi).
- Planification « dans 10 min / chaque soir au coucher du soleil / de 18h à 22h » exprimée en langage naturel → **planificateur** (via ia/l'UI), pas en doublon d'une automatisation HA.
- Ne pas créer deux mécanismes pour la même règle.

### 5. zigbee2mqtt

- Topic de base `zigbee2mqtt/<friendly_name>` ; découverte HA via MQTT. Interface web z2m : port **8085**.
- Un appareil peut exposer : état, `action` (boutons : `single`, `double`, `hold`…), `battery`, `linkquality`, `occupancy`, etc.
- Pour les **télécommandes/boutons**, préférer le déclencheur d'**appareil** HA ou l'entité `event`/`sensor.*_action` ; vérifier le payload réel dans MQTT avant d'écrire le trigger.
- Un appareil sans Area = non rangé : le signaler. Ne pas renommer/ré-appairer sans accord.
- Les groupes z2m existent peut-être : lister dans `configuration.yaml` de z2m avant de recréer.

### 6. Drivers et intégrations HA tierces

Matériel déjà en place (liste non exhaustive, **à vérifier** avec la liste des intégrations HA) :
- **huawei_solar** (onduleur/EMMA, batterie), **Solarman/Deye** (2 micro-onduleurs), Linky/EMMA dans le tableau Énergie ;
- **Tuya** (2 splits) et **midea_ac_lan / NetHome Plus** (1 split) ;
- **Omnibattery** + batterie Marstek Venus E (pilotée sur excédent solaire) — ne pas perturber sa logique ;
- thermostats virtuels, minuteries lumières (helpers `timer`), carte Lovelace HAPLAN.

Pour tout driver : avant d'écrire une automatisation, lire l'état réel (Outils de développement → États, ou REST) pour connaître **attributs, unités et valeurs possibles**.

### 7. Accès aux autres machines (SSH)

Site **Saint Fort** (même LAN 192.168.1.0/24) :

| Machine | IP | Rôle | Accès |
|---|---|---|---|
| ha2 | .51 | RPi4 2 Go : HA, z2m, mosquitto, dimotic-ha (là où tu es) | local |
| orangepi | .130 | 2e instance dimotic-ha | SSH (compte `claude`, clé dédiée, à créer pour ce Claude) |
| stfort | .53 | RFXCOM, GPIO relais (3) | SSH (accès à demander à l'utilisateur) |

Autres : RPi1 (teleinfo), machine Nextcloud, sniffer Modbus (.21). Le **site noisy** (noisy, noisy2) est un **autre site distant** (WireGuard) : **hors périmètre**, sauf demande explicite.

Règles SSH : une clé dédiée pour ce Claude (à fournir par l'utilisateur, pas à générer/copier sans demander) ; commandes **lecture seule par défaut** (`docker ps`, `docker logs --tail`, `cat`) ; pas de `docker compose down/restart`, pas d'édition de `cron.json`/`equipements.json` de l'ancien système sans arrêter son service (cf. `supervisor`), toujours vérifier un `scp` par MD5 vers stfort (SSH instable sous charge).

### 8. Méthode pour créer un automatisme

1. Reformuler la demande (déclencheur, conditions, actions, quand ça ne doit **pas** se déclencher).
2. Identifier les entités réelles (nom, Area, état courant) ; signaler ambiguïtés.
3. Choisir le mécanisme (§4), puis écrire en YAML clair avec `alias` + `description` explicites ; `mode` choisi consciemment.
4. Vérifier la validité (`ha core check` / Outils de développement → Vérifier la configuration) avant rechargement ; recharger les automatisations plutôt que redémarrer.
5. Tester à vide si possible (déclenchement manuel `automation.trigger` avec `skip_condition` seulement avec accord), suivre la trace et les logs.
6. Rapporter : entity_id créés, fichier modifié, sauvegarde faite, procédure d'annulation.

### 9. À vérifier au premier démarrage

- État de `docker ps`, version HA, liste d'automatisations/scripts existants (ne rien dupliquer).
- Ports réels (HA 8123, dimotic-ha ; z2m = 8085) et méthode d'accès à l'API HA (jeton longue durée à demander, ne pas le stocker en clair dans un dépôt).
- Où sont les étiquettes/Areas déjà définies.
- ha2 est un **Raspberry Pi 4 (2 Go de RAM)** : mémoire limitée, éviter les tâches lourdes (pas de build, pas d'ESPHome compile ; ces opérations se font sur une autre machine).
