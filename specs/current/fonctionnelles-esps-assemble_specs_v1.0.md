# Spécifications Fonctionnelles - Module ESPS-ASSEMBLE

*Version 1.0 - 14 Octobre 2026 — **remplace `fonctionnelles-espdisplay_specs` (v1.7, archivée)** : l'application `espdisplay` est renommée **`esps-assemble`** (assembleur de sources ESPHome, avec ou sans écran) ; l'ancien pipeline (SSH vers la machine ESPHome, script Python, déploiement HAPLAN) est retiré au profit de l'usine de l'application `esphome` (`fonctionnelles-esphome_specs`). Contient la bibliothèque d'éléments (§6, reprise de l'ancien §10), les fiches (§4), l'assemblage et le paquet (§5), la conversion des coordonnées des plans (§8).*

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

Fichiers : `src/domain/{index,AssembleurService,config-schema,socket-events}.ts`, `assembleur/{fiches,resolution,verification,paquet,zip-ecriture}.ts`, `plans/coordonnees.ts`, `presentation/{index.html,ts/app.ts}`. Bibliothèque : `bibliotheque/{materiels,elements,annexes}/`, appareils : `appareils/`. Outils de la phase de reclassement : `tools/`.

## 3. Configuration (`data/esps-assemble/config.yaml`)

| Champ | Défaut | Rôle |
|---|---|---|
| `site` | `stfort` | site de cette machine (sujets MQTT, sites étanches) |
| `adresseJoignable` | vide | adresse de cette instance **vue de l'usine** (ex. `192.168.1.51:8087`) ; vide = première adresse IPv4 locale + port web |
| `mqtt.{hote,port,utilisateur,motDePasse}` | 127.0.0.1:1883 | broker du site (mot de passe : champ masqué) |
| `revisionsGardees` | 5 | révisions de paquets gardées par appareil |

Formulaire « Paramètres Techniques → Assembleur ESP ». Rechargement à chaud sur `app:module:config:saved`.

## 4. Fiches (à côté des fichiers ESPHome, qui ne changent pas)

Fichiers YAML en **snake_case** (`brochesPrises` ⇐ `broches_prises`), validés (Zod) à la lecture ; une fiche invalide ou dont l'`id` ne correspond pas à son dossier est **refusée avec le champ fautif**.

### 4.1 Modèle de matériel — `bibliotheque/materiels/<id>/fiche.yaml` (+ `base.yaml`)
Une carte **avec ses périphériques câblés**, **une seule fois** par modèle : `id`, `nom`, `plateforme` (esp32 | esp8266), `puce` (esp32, esp32-s3, esp32-c3, esp8266 — comparée à la reconnaissance d'une carte), `cadre` (arduino | esp-idf), `carte`, `flash` (`16MB`), `memoire` (`emplacement_ota_octets`, `ram_interne_octets`, `psram`) — utilisée par le **contrôle des tailles** de l'usine —, `port_ota` (3232 par défaut ; 8266 sur ESP8266), `ecran` (`largeur`, `hauteur`, `tactile`), `audio`, `broches_prises`, `broches_libres` (relevées plus tard, à la demande d'un premier élément qui en a besoin).

### 4.2 Élément — `bibliotheque/elements/<id>/fiche.yaml` (+ `element.yaml`)
`id`, `nom`, `description`, `parametres` (liste `{nom, description, requis, defaut}` — variables du `!include { file, vars }`), `exigences` (`plateformes`, `ecran {largeur, hauteur}` exact, `audio`, `elements` exigés, `materiels` acceptés), `broches` (utilisées par l'élément).

### 4.3 Appareil — `appareils/<nom>.fiche.yaml` (+ `<nom>.yaml`, fichier ESPHome principal avec ses `packages:`)
`nom`, `nom_affichage` (`friendly_name` dans HA, **unique** entre appareils), `materiel`, `esp` (`adresse` — fixe ou **réservation DHCP**, vide = `<nom>.local` —, `port` API 6053, `port_ota`), `options` (`autoriser_appels_service` pour les appareils tactiles), `wifi` (sites dont le wifi figure dans l'appareil).

## 5. Assemblage

`assemblerPaquet(racine, appareil, révision)` :
1. **Résolution** (`resolution.ts`) : lit `appareils/<nom>.yaml`, suit les `packages:` (`!include` simple ou `{file, vars}`, y compris imbriqués), classe chaque inclusion (matériel `bibliotheque/materiels/<id>/base.yaml`, élément `…/elements/<id>/element.yaml`) avec ses variables, repère les **annexes** locales (clés `file`, `path`, `partitions` : images, polices, tables de partitions) cherchées dans `bibliotheque/annexes/` puis `appareils/` — celles qui manquent sont **signalées sans bloquer**. Inclusion circulaire, fichier absent ou chemin sortant de la racine : refus.
2. **Vérifications** (`verification.ts`) : matériel déclaré = matériel inclus ; plateforme, écran exact, audio, matériels acceptés, éléments exigés ; paramètres requis présents (variable inconnue = avertissement) ; **conflits de broches** (élément contre matériel, élément contre élément) ; nom d'affichage unique ; élément sans fiche. Chaque problème est une phrase lisible.
3. **Paquet** (`paquet.ts`) : zip **reproductible** (entrées triées, dates fixes) contenant `manifest.json` et les sources ; manifeste (v1) : `appareil`, `nomAffichage`, `revision`, `assemble`, `modele {id, puce, flash, cadre, memoire}`, `esp {adresse, port, portOta}`, `options`, `wifi`, `fichiers {chemin → sha256}` — **exactement** celui lu par l'usine (contrôle croisé en test).

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

Faite **à l'assemblage**, ni dans HA (qui ne connaît pas l'écran) ni sur l'ESP : 1. **ancrage** — l'intégration Plans donne le **coin inférieur gauche** de l'icône (fraction 0–1 de l'image), l'ancien générateur raisonnait en **centre** : décalage d'une demi-boîte (taille de l'icône SUR L'ÉCRAN, pas les 28 px du panneau) ; 2. **mise à l'échelle** « contain » avec bandes (`fit_and_pad`), puis boîte **bornée** à l'écran. Mêmes arrondis que le script Python d'origine (arrondi au pair de `round`, division entière). **Vérifié** : 1 000 positions aléatoires sur trois formats d'image et deux écrans, écart **0 pixel** avec l'ancienne formule ; cas limites (coins, centre, hors écran signalé). La **génération des pages de plans** elle-même (icônes, couleurs, capteurs, thermostats, images de fond) est le **port TypeScript** de l'ancien générateur : **à faire** (§11).

## 9. Interface (page « Assembleur ESP »)

Une carte par appareil : nom d'affichage, matériel, **prêt / refusé** avec les raisons et avertissements, dernière révision, demande en attente chez l'usine, dernier état publié (récupération, compilation, firmware prêt, envoi, terminé, échec + fin du journal), boutons **Assembler et envoyer à l'usine**, **Amorce (première carte)**, **Annuler la demande**. Événements : `esps-assemble:appareils(:get)`, `esps-assemble:assembler`, `esps-assemble:annuler`, `esps-assemble:assemblage:resultat`, `esps-assemble:error`.

## 10. Tests

35 tests (vitest) : conversion des coordonnées (13) ; résolution, fiches, vérifications, paquet — dont **contrôle croisé avec l'usine** (lecteur de zip et manifeste de l'application `esphome`) (13) ; service (9 : demande conservée, révisions et nettoyage, refus sans publication, annulation, liste publiée, état lu). **Vérifié en réel (14/10/2026)** : chaîne complète sur le broker de ha2 — assembleur (paquet de `poele-display`) → MQTT → usine (récupération HTTP, dépôt, suppression de la demande, compilation réelle dans le conteneur ESPHome, tailles) → message de pose (1 114 800 octets pour un emplacement de 1 835 008) ; aucun envoi à l'appareil en service.

## 11. Reste à faire

1. **Pages de plans générées** : port TypeScript du générateur (`generate_esphome_floorplan.py`) en élément « pages de plans » (images de fond, widgets par type, thermostats « act: »), lecture des plans depuis l'intégration Plans (commande d'export, méthode générique du cœur), bouton **Générer** dans le panneau Plans (publication de la demande par `mqtt.publish`).
2. Fiches de matériel supplémentaires (ESP8266, nouvelles cartes) et relevé des broches libres au premier besoin ; **création d'un modèle depuis la reconnaissance d'une carte inconnue**.
3. Paramétrer `panneau-chauffage-poele-evoo7` (entités et libellés encore en dur).
4. Annexes de `haplan-display` (images de fond) : fournies par la génération des plans.

## 12. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|------------|
| 1.0 | 2026-10-14 | Claude | Nouvelle spécification : application renommée `esps-assemble` (ex-`espdisplay`, spec v1.7 archivée) ; fiches, résolution, vérifications, paquet zip et manifeste, demande MQTT, page, conversion des coordonnées, `poele-display` désassemblé, chaîne vérifiée en réel. |
