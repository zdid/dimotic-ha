# Bibliothèque d'appareils ESPHome (espdisplay)

Un **appareil** ESP (ESPHome, avec ou sans écran) s'assemble à partir d'un **matériel** et d'**éléments**, listés dans son
fichier (`../appareils/<appareil>.yaml`, section `packages:`). ESPHome fusionne le tout : les listes (`sensor:`, `font:`,
`lvgl: pages:`…) s'ajoutent, les dictionnaires (`wifi:`, `api:`, `esphome:`…) se combinent, les pages s'affichent dans l'ordre
des `packages:`. Conception : `specs/current/conception-esphome-assembleur_specs_v1.4.md` ; état : `fonctionnelles-espdisplay_specs_v1.7.md` §10.

## Organisation (13/10/2026)

| Dossier | Contenu |
|---|---|
| `materiels/<modèle>/base.yaml` | une carte **avec ses périphériques câblés** (une fois par modèle) : plateforme, mémoire, écran/audio, réglages propres à la carte. **Sans le wifi.** |
| `elements/<élément>/element.yaml` | un morceau de configuration, éventuellement **paramétrable** (`!include { file, vars }`) |
| `../appareils/<appareil>.yaml` | un exemplaire : nom, nom d'affichage, clé API, `packages:` (matériel + wifi + éléments) |

### Matériels
- `sunton-8048s070c` — ESP32-S3 16 Mo, écran RVB 800x480, tactile GT911, rétroéclairage ; couche LVGL commune (veille, flèches de
  navigation + police `font_nav`).
- `waveshare-esp32-s3-audio` — ESP32-S3 16 Mo, PSRAM, codecs ES7210/ES8311, TCA9555, anneau de 7 LED, micro, haut-parleur ;
  réglages wifi propres (id `wifi_id`, sans économie d'énergie, redémarrage à 10 min).

- `cyd-esp32-2432s028` — « Cheap Yellow Display » : ESP32 classique (Arduino), écran SPI ILI9341 2,8" 240x320 portrait, tactile résistif XPT2046 (second bus SPI), rétroéclairage ledc, veille du rétroéclairage après 30 s.

### Éléments
- **Wifi, interchangeable** (changer de wifi = changer une ligne dans l'appareil) :
  - `wifi-simple` — un seul réseau (`wifi_ssid` / `wifi_password`) ;
  - `wifi-multi-ap` — **plusieurs réseaux** (priorité, un par site : `wifi_<site>_ssid/password`) et **point d'accès de secours**
    « `<appareil>` secours » avec **portail captif** (comme Tasmota) ; secret à créer : `wifi_secours_password`. ESPHome y ajoute de
    lui-même une mise à jour par la page web du portail (protégée par le mot de passe du point d'accès).
- **Écran** : `polices-plans`, `polices-climatisation`, `page-plan-original`, `page-plan-rez-de-chaussee`, `page-plan-premier`
  (pages de plans, aujourd'hui générées par `../tools/generate_esphome_floorplan.py`), `page-energie-direct`, `page-ballons-chauffe`,
  `page-thermostats`, et **`page-climatisation` paramétrable** (7 variables : `clim_id`, `clim_entite`, `clim_rang`, `clim_titre`,
  `clim_pas`, `clim_max`, `clim_mode_auto`) qui remplace les trois copies salle / bureau / chambre d'ami.
- **Chauffage (écran 240x320)** : `polices-poele` ; `panneau-chauffage-poele-evoo7` (thermostat du poêle, thermostat EVOO7 de la pompe à chaleur, humidité de la salle — entités et libellés encore en dur, à paramétrer).
- **Satellite** : `assistant-vocal` (lecteur audio, assistant de HA, mot d'éveil, scripts de l'anneau, réglages exposés à HA,
  boutons ; automatismes de démarrage et de connexion).

### Appareils
- `haplan-display` — Sunton + wifi-simple + polices + 6 pages + 3 instances de `page-climatisation`.
- `hasat4`, `hasat5` — Waveshare + wifi-simple + assistant-vocal (`hasat3` archivé : même fichier au nom près).
- `poele-display` — CYD 2,8" portrait : matériel `cyd-esp32-2432s028` + `wifi-simple` + `polices-poele` + `panneau-chauffage-poele-evoo7` (désassemblé le 14/10/2026, `esphome config` identique à l'original). Le fichier **en service** de la machine ESPHome n'a pas été touché.

## Contrôles (13/10/2026)

`esphome config` de chaque appareil assemblé comparé à celui du fichier d'origine par `../tools/comparer-config.py` (dictionnaires
et listes à `id` comparés, substitutions ignorées car déjà appliquées ; détecte bien les modifications volontaires) :
**0 différence** pour `haplan-display`, `hasat4`, `hasat5` et `poele-display` (avec `wifi-simple`) ; variantes `wifi-multi-ap` acceptées par ESPHome.
La page de climatisation paramétrable redonne, ré-instanciée, **chacune des trois pages d'origine à l'identique** (texte).
Essais faits dans un dossier temporaire avec un `secrets.yaml` factice (valeurs **distinctes**, sinon ESPHome affiche un mauvais nom
de secret) ; le dossier réel d'ESPHome n'est pas touché, rien n'a été compilé ni envoyé.

Constats : les satellites n'ont **pas de clé de chiffrement API** ; le composant externe `es8311` vient de
`github.com/sw3Dan/waveshare-s2-audio_esphome_voice` sur `main` (**non figé**).

## Outils (`../tools/`)

- `decouper-par-plan.py` + `plans-decoupage/*.json` — découpage fidèle d'un fichier ESPHome selon un plan (sections entières ou
  partagées par sous-clés) ; utilisé pour les satellites et pour `poele-display`.
- `reclasser-ecran-phase1.py` — reclassement de l'écran (phase 1 → matériel + éléments), avec contrôle de la page paramétrable.
- `comparer-config.py` — comparaison de deux `esphome config`.
- `decouper-ecran.py` — outil de la phase 1 (ancienne organisation `bases/` `communs/` `pages/`), conservé pour l'historique.

## Fichiers non suivis ici

Images de fond des plans (`floorplan_*_800x480.png`), police `fa-solid-900.ttf`, table de partitions `partitions-haplan.csv` et
`secrets.yaml` restent dans le dossier de configuration ESPHome (`/docker/esphome/config` sur falbala). Pour compiler, le fichier de
l'appareil et le dossier `bibliotheque/` sont posés **dans ce même dossier** (chemins relatifs `bibliotheque/…`).

## Suite prévue

Fiches (manifestes) des matériels et éléments ; pages adaptées à la taille ; pages de plans lues depuis HA ; désassemblage de
`poele-display` ; assemblage, paquets et envoi par l'application `esphome` (usine / poseur) — voir la conception.
