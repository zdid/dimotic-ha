# Spécifications Fonctionnelles - Module ESPS-ASSEMBLE

*Version 1.2 - 15 Octobre 2026 — **wifi multiples par site** (§4.4 : fichiers `bibliotheque/wifi/<site>.yaml`, liste générée, point d'accès de secours par site, secrets référencés listés dans le manifeste), **tailles des pages de plans** (`tailles_plans`), **plans à fond transparent inversés** (traits blancs sur fond noir), essai réel sur l'écran du mur (envoi OTA depuis HA, repli en point d'accès). Version 1.1 : **pages de plans générées depuis HA** (port TypeScript du générateur, export de l'intégration Plans, bouton « Générer », fiche `plans`), **vérifié en réel** de HA à la compilation ; installation par la racine externe, pièges rencontrés (§12bis). Version 1.0 : **remplace `fonctionnelles-espdisplay_specs` (v1.7, archivée)** : l'application `espdisplay` est renommée **`esps-assemble`** (assembleur de sources ESPHome, avec ou sans écran) ; l'ancien pipeline (SSH vers la machine ESPHome, script Python, déploiement HAPLAN) est retiré au profit de l'usine de l'application `esphome` (`fonctionnelles-esphome_specs`). Contient la bibliothèque d'éléments (§6, reprise de l'ancien §10), les fiches (§4), l'assemblage et le paquet (§5), la conversion des coordonnées des plans (§8).*

---

## 1. Objet

`applications/esps-assemble` **assemble** les sources des appareils ESP (ESP32 et ESP8266, **avec ou sans écran**) à partir d'un **modèle de matériel** et d'**éléments** de bibliothèque, les **vérifie**, en fait un **paquet zip** et **demande à l'usine** (application `esphome`, falbala) de le compiler, par un message MQTT conservé. Elle **ne compile rien**, ne connaît ni la machine ESPHome ni les clés de chiffrement (`!secret …` dans le YAML ; les valeurs restent dans le `secrets.yaml` de l'usine).

Décisions de l'utilisateur du 13/10/2026 et 14/10/2026 : trois rôles identiques sur chaque site (assembleur, poseur, usine), flux à deux messages MQTT conservés (`jobs`, `pose`), livraison « je demande, j'obtiens » (pas de diffusion), nom `esps-assemble`.

## 2. Architecture

| Élément | Rôle |
|---|---|
| Application `esps-assemble` (process séparé, **désactivée à l'arrivée**) | fiches, vérifications, paquets, demande MQTT, page « Assembleur ESP » |
| Application `esphome` (usine / poseur) | compile, envoie à l'ESP, déclare dans HA (voir sa spec) |
| Broker MQTT du site | messages conservés `dimotic/esphome/<site>/jobs/<appareil>` (demande), `…/status/<appareil>` (état, lu), `dimotic/esps-assemble/<site>/appareils` (liste publiée) |
| Cœur | route de lecture `GET /api/apps/esps-assemble/partage/<chemin>` → `data/esps-assemble/machine_partage/<chemin>` |

Fichiers : `src/domain/{index,AssembleurService,config-schema,socket-events}.ts`, `assembleur/{fiches,resolution,verification,paquet,wifi,zip-ecriture}.ts`, `plans/{coordonnees,generation,image,generer-fichiers,source-ha}.ts`, `presentation/{index.html,ts/app.ts}`. Bibliothèque : `bibliotheque/{materiels,elements,annexes}/`, appareils : `appareils/`. Outils de la phase de reclassement : `tools/`.

## 3. Configuration (`data/esps-assemble/config.yaml`)

| Champ | Défaut | Rôle |
|---|---|---|
| `site` | `stfort` | site de cette machine (sujets MQTT, sites étanches) |
| `adresseJoignable` | vide | adresse de cette instance **vue de l'usine**, forme `hôte:port` (ex. `192.168.1.51:8087`, **deux-points**, pas de point) ; vide = première adresse IPv4 locale + port web |
| `mqtt.{hote,port,utilisateur,motDePasse}` | 127.0.0.1:1883 | broker du site (mot de passe : champ masqué) — **le même que celui de l'intégration MQTT de HA** : le bouton « Générer » du panneau Plans lit et publie par celui-là |
| `revisionsGardees` | 5 | révisions de paquets gardées par appareil |

Formulaire « Paramètres Techniques → Assembleur ESP ». Rechargement à chaud sur `app:module:config:saved`.

## 4. Fiches (à côté des fichiers ESPHome, qui ne changent pas)

Fichiers YAML en **snake_case** (`brochesPrises` ⇐ `broches_prises`), validés (Zod) à la lecture ; une fiche invalide ou dont l'`id` ne correspond pas à son dossier est **refusée avec le champ fautif**.

### 4.1 Modèle de matériel — `bibliotheque/materiels/<id>/fiche.yaml` (+ `base.yaml`)
Une carte **avec ses périphériques câblés**, **une seule fois** par modèle : `id`, `nom`, `plateforme` (esp32 | esp8266), `puce` (esp32, esp32-s3, esp32-c3, esp8266 — comparée à la reconnaissance d'une carte), `cadre` (arduino | esp-idf), `carte`, `flash` (`16MB`), `memoire` (`emplacement_ota_octets`, `ram_interne_octets`, `psram`) — utilisée par le **contrôle des tailles** de l'usine —, `port_ota` (3232 par défaut ; 8266 sur ESP8266), `ecran` (`largeur`, `hauteur`, `tactile`), `audio`, `broches_prises`, `broches_libres` (relevées plus tard, à la demande d'un premier élément qui en a besoin).

### 4.2 Élément — `bibliotheque/elements/<id>/fiche.yaml` (+ `element.yaml`)
`id`, `nom`, `description`, `parametres` (liste `{nom, description, requis, defaut}` — variables du `!include { file, vars }`), `exigences` (`plateformes`, `ecran {largeur, hauteur}` exact, `audio`, `elements` exigés, `materiels` acceptés), `broches` (utilisées par l'élément).

### 4.3 Appareil — `appareils/<nom>.fiche.yaml` (+ `<nom>.yaml`, fichier ESPHome principal avec ses `packages:`)
`nom`, `nom_affichage` (`friendly_name` dans HA, **unique** entre appareils), `materiel`, `esp` (`adresse` — fixe ou **réservation DHCP**, vide = `<nom>.local` —, `port` API 6053, `port_ota`), `options` (`autoriser_appels_service` pour les appareils tactiles), `wifi` (sites dont le wifi figure dans l'appareil), **`tailles_plans`** (`texte`, `valeur`, `icone` en px : tous les textes libres des pages de plans — absente : petit/moyen/grand du plan, 14/20/28 —, valeurs des capteurs et icônes — 20 par défaut ; écrites à l'assemblage dans `generes/tailles-plans.yaml`, à inclure après `polices-plans` ; clés lues en `camelCase`), **`plans`** (liste des plans de l'intégration Plans dont les pages sont **générées à l'assemblage**, par leur **nom dans HA** — ex. `[Maison, "Rez de chaussée", Premier]` ; renommer un plan dans HA oblige à corriger la fiche et le nom `generes/page-plan-<nom>.yaml` du fichier principal ; vide = pas de page générée ; exige l'élément de polices des plans et un écran).

### 4.4 Wifi d'un site — `bibliotheque/wifi/<site>.yaml`

Les réseaux d'un site (**plusieurs possibles**, ordre = préférence) avec les **noms** des secrets, jamais un mot de passe :
```yaml
site: stfort
reseaux:
  - id: principal
    ssid_secret: wifi_ssid          # facultatif : défaut wifi_<site>_<réseau>_ssid
    password_secret: wifi_password  # facultatif : défaut wifi_<site>_<réseau>_password
secours_password_secret: wifi_stfort_secours_password   # facultatif : défaut wifi_<site>_secours_password
```
La fiche de l'appareil liste ses sites (`wifi: [noisy, stfort]`) : **le premier est celui où l'appareil sera installé**. L'assembleur écrit `generes/wifi.yaml` (inclus par le fichier de l'appareil à la place de `wifi-simple`) : tous les réseaux de tous les sites, priorités décroissantes (100, 99, … — premier site, premier réseau en tête), puis un **point d'accès de secours** « `<appareil> secours` » avec portail captif (`ap_timeout: 1min`), dont le mot de passe est celui **du premier site**. Un site inconnu donne une erreur claire (« wifi du site … »). **Vérifié en réel le 15/10/2026** : avec un réseau inexistant, l'écran ouvre son point d'accès après environ une minute ; le portail (`http://192.168.4.1`) permet de saisir le vrai wifi, enregistré dans la flash de l'ESP. Astuce : un téléphone quitte le portail tout seul (réseau sans internet) ; faire la saisie depuis un ordinateur connecté au point d'accès.

## 5. Assemblage

`assemblerPaquet(racine, appareil, révision)` :
1. **Résolution** (`resolution.ts`) : lit `appareils/<nom>.yaml`, suit les `packages:` (`!include` simple ou `{file, vars}`, y compris imbriqués), classe chaque inclusion (matériel `bibliotheque/materiels/<id>/base.yaml`, élément `…/elements/<id>/element.yaml`) avec ses variables, repère les **annexes** locales (clés `file`, `path`, `partitions` : images, polices, tables de partitions) cherchées dans `bibliotheque/annexes/` puis `appareils/` — celles qui manquent sont **signalées sans bloquer**. Inclusion circulaire, fichier absent ou chemin sortant de la racine : refus.
2. **Vérifications** (`verification.ts`) : matériel déclaré = matériel inclus ; plateforme, écran exact, audio, matériels acceptés, éléments exigés ; paramètres requis présents (variable inconnue = avertissement) ; **conflits de broches** (élément contre matériel, élément contre élément) ; nom d'affichage unique ; élément sans fiche. Chaque problème est une phrase lisible.
3. **Paquet** (`paquet.ts`) : zip **reproductible** (entrées triées, dates fixes) contenant `manifest.json` et les sources ; manifeste (v1) : `appareil`, `nomAffichage`, `revision`, `assemble`, `modele {id, puce, flash, cadre, memoire}`, `esp {adresse, port, portOta}`, `options`, `wifi`, `secrets` (noms des secrets `!secret` référencés par les sources, hors clé API de l'appareil, **contrôlés par l'usine avant tout dépôt**), `fichiers {chemin → sha256}` — **exactement** celui lu par l'usine (contrôle croisé en test).

## 6. Bibliothèque d'éléments d'écran

### Organisation
| Dossier | Contenu |
|---|---|
| `materiels/<modèle>/{base.yaml,fiche.yaml}` | une carte avec ses périphériques câblés (plateforme, écran/audio, réglages de la carte). **Sans le wifi.** |
| `elements/<élément>/{element.yaml,fiche.yaml}` | un morceau de configuration, éventuellement **paramétrable** (`!include { file, vars }`) |
| `annexes/` | fichiers annexes embarqués dans les paquets (`partitions-haplan.csv`, `fa-solid-900.ttf`) |
| `../appareils/<appareil>.yaml` + `.fiche.yaml` | un exemplaire : nom, clé API (`!secret`), `packages:` |

### Matériels
`sunton-8048s070c` (ESP32-S3, écran RVB 800x480, tactile GT911) ; `waveshare-esp32-s3-audio` (satellite vocal) ; `cyd-esp32-2432s028` (« Cheap Yellow Display », ESP32 Arduino, écran SPI 240x320 portrait, tactile résistif, veille du rétroéclairage à 30 s).

### Éléments
Wifi **interchangeable** : `wifi-simple` (un réseau), `wifi-multi-ap` (plusieurs réseaux par site + point d'accès de secours avec portail captif). Écran 800x480 : `polices-plans`, `polices-climatisation`, `page-plan-original`, `page-plan-rez-de-chaussee`, `page-plan-premier`, `page-energie-direct`, `page-ballons-chauffe`, `page-thermostats`, **`page-climatisation` paramétrable** (7 variables). Écran 240x320 : `polices-poele`, `panneau-chauffage-poele-evoo7`. Satellite : `assistant-vocal`.

### Appareils
`haplan-display`, `hasat4`, `hasat5`, `poele-display` (désassemblé le 14/10/2026). **Contrôle** : `esphome config` de l'appareil assemblé comparé à celui du fichier d'origine par `tools/comparer-config.py` (dictionnaires et listes à `id` comparés ; détecte une modification volontaire) : **0 différence** pour les quatre ; et **le paquet extrait** de `poele-display` et de `hasat4` redonne 0 différence. Essais faits avec un `secrets.yaml` factice (clé API base64 de 32 octets, mot de passe wifi ≥ 8 caractères, valeurs distinctes) ; rien n'est envoyé aux appareils en service.

### Outils (`tools/`)
`decouper-par-plan.py` + `plans-decoupage/*.json` (découpage fidèle selon un plan : satellites, `poele-display`), `reclasser-ecran-phase1.py`, `comparer-config.py`, `decouper-ecran.py` (historique), `generate_esphome_floorplan.py` (**ancien générateur des pages de plans, référence du port TypeScript à venir**, §8).

## 7. Demande à l'usine (MQTT)

`demander({ appareil, action })` (`firmware` par défaut, `amorce` pour une première carte) : révision = dernière + 1 (`data/esps-assemble/revisions.json`) ; vérifications ; paquet écrit de façon atomique dans `machine_partage/paquets/<appareil>/r<révision>.zip` ; **message conservé** `dimotic/esphome/<site>/jobs/<appareil>` = `{ v:1, site, appareil, revision, at, action, origine (adresse joignable), paquet (URL du zip), sha256 }` ; garde des N dernières révisions. **Refus sans rien publier ni déposer** si les vérifications échouent, si le nom est invalide ou si le broker n'est pas joint. `annuler(appareil)` : message vide conservé. À la connexion, publication de la **liste des appareils** (`dimotic/esps-assemble/<site>/appareils`, conservée) pour le bouton « Générer » de HA (conception §11.6). L'état de l'usine et du poseur (`status/+`) et la demande en attente (`jobs/+`) sont lus et affichés.

## 8. Conversion des coordonnées des plans (`plans/coordonnees.ts`)

Faite **à l'assemblage**, ni dans HA (qui ne connaît pas l'écran) ni sur l'ESP : 1. **ancrage** — l'intégration Plans donne le **coin inférieur gauche** de l'icône (fraction 0–1 de l'image), l'ancien générateur raisonnait en **centre** : décalage d'une demi-boîte (taille de l'icône SUR L'ÉCRAN, pas les 28 px du panneau) ; 2. **mise à l'échelle** « contain » avec bandes (`fit_and_pad`), puis boîte **bornée** à l'écran. Mêmes arrondis que le script Python d'origine (arrondi au pair de `round`, division entière). **Vérifié** : 1 000 positions aléatoires sur trois formats d'image et deux écrans, écart **0 pixel** avec l'ancienne formule ; cas limites (coins, centre, hors écran signalé). La génération des pages elle-même est décrite en §8bis.

## 8bis. Pages de plans générées (`plans/`)

Port TypeScript de l'ancien générateur Python (`tools/generate_esphome_floorplan.py`, gardé comme référence). Pour un appareil dont la fiche a `plans`, **à chaque assemblage** :
1. **Un seul appel** à HA (`dimotic_plans/floorplans/export`, `plan_ids`) par la **liaison HA du cœur** (`callWs`, aucun jeton ici) : positions (coin inférieur gauche), textes libres et image de chaque plan. Intégration Plans **≥ 0.1.8** ; un plan inconnu de HA donne un refus lisible (« plan inconnu : … ») et rien n'est publié.
2. **Génération** (`generation.ts`) : une page LVGL par plan — icône selon le type d'entité (lumière, interrupteur, volet, VMC, ballon, radiateur, thermostat « act: » avec température, capteurs), polices par plan, textes libres ; conversion des coordonnées (§8) ; **sortie identique ligne pour ligne** à celle du script Python sur les trois plans HAPLAN (fixtures de test).
3. **Image de fond** (`image.ts`) : ramenée à l'écran (« contain » + bandes, Lanczos, `pngjs`) ; écart moyen 0,02/255 avec Pillow.
4. **Image de fond inversée si besoin** : un plan à fond transparent (au moins un cinquième de pixels transparents, dessin au trait sombre) est inversé comme le filtre CSS `invert(1) hue-rotate(180deg)` du mode sombre du panneau Plans — **traits blancs sur fond noir** ; un plan opaque n'est jamais inversé en automatique (forçage possible par `inverser`).
5. **Fichiers générés** `generes/page-plan-<nom>.yaml` et `floorplan_<nom>_<L>x<H>.png`, **embarqués dans le paquet** (le fichier principal de l'appareil les inclut par `!include generes/page-plan-<nom>.yaml`). Pour la simple **vérification de fiche** (liste des appareils), des fichiers factices les remplacent : générer ne demande HA qu'à l'assemblage.

**Bouton « Générer »** (panneau Plans de HA, section « Écrans ESP », administrateur seulement) : lit la liste des appareils à pages de plans (`dimotic/esps-assemble/<site>/appareils`, conservée) et l'état (`dimotic/esphome/<site>/status/+`), publie la demande `dimotic/esps-assemble/<site>/generer` (non conservée, `{appareil, action}`) que l'assembleur écoute. L'option « site » de l'intégration Plans doit être **identique, en minuscules**, à celle de l'assembleur (les sujets MQTT distinguent les majuscules ; le panneau, depuis 0.1.9, met en minuscules).

## 9. Interface (page « Assembleur ESP »)

Une carte par appareil : nom d'affichage, matériel, **prêt / refusé** avec les raisons et avertissements, dernière révision, demande en attente chez l'usine, dernier état publié (récupération, compilation, firmware prêt, envoi, terminé, échec + fin du journal), boutons **Assembler et envoyer à l'usine**, **Amorce (première carte)**, **Annuler la demande**. Événements : `esps-assemble:appareils(:get)`, `esps-assemble:assembler`, `esps-assemble:annuler`, `esps-assemble:assemblage:resultat`, `esps-assemble:error`.

## 10. Tests

69 tests (vitest) dont l'inversion des plans, les tailles de la fiche et le wifi généré ; les 35 premiers (version 1.0) ; les 35 premiers : : conversion des coordonnées (13) ; résolution, fiches, vérifications, paquet — dont **contrôle croisé avec l'usine** (lecteur de zip et manifeste de l'application `esphome`) (13) ; service (9 : demande conservée, révisions et nettoyage, refus sans publication, annulation, liste publiée, état lu). **Vérifié en réel (14/10/2026)** : chaîne complète sur le broker de ha2 — assembleur (paquet de `poele-display`) → MQTT → usine (récupération HTTP, dépôt, suppression de la demande, compilation réelle dans le conteneur ESPHome, tailles) → message de pose (1 114 800 octets pour un emplacement de 1 835 008) ; aucun envoi à l'appareil en service. **Vérifié en réel (15/10/2026) sur l'écran du mur** (`haplan-display`, ESP32-S3) : bouton « Générer » de HA → assembleur → usine → poseur → mise à jour OTA → vérification dans HA (durée totale environ 1 min 10) ; pages de plans affichées, tailles 14 px réglées dans la fiche ; wifi multiple et repli en point d'accès (§4.4). **Vérifié en réel (14/10/2026), pages de plans** : export réel des 3 plans de ha2 (Maison 34 objets, Rez de chaussée 18, Premier 16, 0 orphelin) ; configuration ESPHome complète de l'appareil d'essai `haplan-test` valide (`esphome config`, 5 544 lignes) ; chaîne **HA (bouton « Générer ») → assembleur sur ha2 → broker de ha2 → usine de falbala → compilation réelle** : firmware prêt, 3,4 Mo sur 6 Mo de flash, 42 Ko de RAM sur 320 Ko ; écran de production non touché.

## 11. Reste à faire

1. Déclarer les **autres réseaux** du site stfort dans `bibliotheque/wifi/stfort.yaml` (une ligne par réseau + ses deux secrets).
2. Fiches de matériel supplémentaires (ESP8266, nouvelles cartes) et relevé des broches libres au premier besoin ; **création d'un modèle depuis la reconnaissance d'une carte inconnue**.
3. Paramétrer `panneau-chauffage-poele-evoo7` (entités et libellés encore en dur).
4. **Thème de l'écran** : aujourd'hui noir, avec images inversées ; un thème clair par appareil reste à faire. **Taille du texte réglable sur l'écran** (plusieurs polices compilées, choix mémorisé) : à voir à l'usage.
5. Mise à jour de la liste des appareils sans relancer l'application (aujourd'hui : désactiver/réactiver après ajout d'une fiche).
6. Écriture de l'usine : elle dépose ses fichiers **à la racine** du dossier d'ESPHome (§12bis) ; acceptable tant qu'aucun appareil n'est géré à la main sous le même nom.

## 12bis. Installation et pièges (essai du 14/10/2026)

- **Installation sur une machine** (ex. ha2) : par la **racine externe** `data/applications/esps-assemble/` (JavaScript compilé, `node_modules` de production, `src/`, `tsconfig.json`, bibliothèque et appareils, repères `.dimotic-install` et `.dimotic-build`) — procédure `PROCEDURE_deploiement-application-externe`. **Cœur requis ≥ 3.7.1** (`callWs`/`callRest` et route de fichiers partagés) : un cœur plus ancien donne `callWs is not a function`.
- **Page** : compilée par `npm run build:ui` en **modules ES** ; le `tsconfig.json` principal exclut `src/presentation/ts/**` (sinon CommonJS : `exports is not defined`, page figée sur « Chargement… »).
- **Usine sur une autre machine** (falbala) : son conteneur doit voir le dossier d'ESPHome (`/docker/esphome/config:/esphome-config`) et le socket Docker (`/var/run/docker.sock`, `group_add` du groupe `docker`) ; sinon « dépôt des sources impossible : EACCES » ; **recréer le conteneur interrompt une compilation en cours** (la demande est déjà supprimée du broker : recliquer sur « Générer »).
- **Adresse de l'ESP** : renseigner l'**adresse IP** dans la fiche (`esp.adresse`, **réservation DHCP**) ; vide = `<nom>.local`, que le poseur (dans un conteneur Docker) **ne sait pas résoudre** (« ENOTFOUND »).
- **Alimentation de l'écran** : un port USB d'ordinateur ne suffit pas (l'adaptateur série se déconnecte toutes les 3 s : boucle de redémarrage) ; utiliser l'alimentation habituelle ou un hub alimenté.
- **Restauration** : un firmware qui plante met l'ESP en **mode sans échec** (API fermée, mise à jour par le réseau encore possible) ; le renvoi de l'ancien firmware sauvegardé par `espota2` (dans le conteneur ESPHome, mot de passe lu dans `secrets.yaml`) rétablit l'appareil. **Sauvegarder le firmware en service avant la première pose** (`firmware.ota.bin` + `.factory.bin`).
- **Broker** : l'assembleur, le panneau Plans et l'usine doivent parler au **même broker de site** (celui de HA) ; l'usine y accède par `usine.sites[].mqtt` (pas par `poseur.mqtt`).

## 12. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.2 | 2026-10-15 | Claude | Wifi multiples par site (§4.4, secrets du manifeste), tailles des pages de plans (`tailles_plans`), plans à fond transparent inversés, essai réel de bout en bout sur l'écran du mur et repli en point d'accès, pièges (adresse IP, alimentation, mode sans échec). v1.1 archivée. |
| 1.1 | 2026-10-14 | Claude | Pages de plans générées depuis HA (§8bis : export, port TypeScript, image, fiche `plans`, bouton « Générer »), configuration précisée (§3), installation et pièges (§12bis), vérifié en réel de HA à la compilation ; reste à faire mis à jour. v1.0 archivée. |
| 1.0 | 2026-10-14 | Claude | Nouvelle spécification : application renommée `esps-assemble` (ex-`espdisplay`, spec v1.7 archivée) ; fiches, résolution, vérifications, paquet zip et manifeste, demande MQTT, page, conversion des coordonnées, `poele-display` désassemblé, chaîne vérifiée en réel. |
