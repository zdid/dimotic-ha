# Bibliothèque d'écrans ESPHome (espdisplay)

Un écran ESP (ESPHome + LVGL) s'assemble à partir d'**éléments** : une base matérielle, des éléments communs et des pages,
listés dans le fichier de l'écran (`screens/<écran>.yaml`, section `packages:`). ESPHome fusionne les éléments dans l'ordre :
les listes (`sensor:`, `text_sensor:`, `font:`, `image:`, `lvgl: pages:`) s'ajoutent, les pages s'affichent dans l'ordre
des `packages:`.

| Dossier | Contenu |
|---|---|
| `bases/` | une base par **modèle d'écran** : carte, écran, tactile, rétroéclairage, wifi, OTA, couche LVGL commune (veille, flèches de navigation) |
| `communs/` | éléments partagés par plusieurs pages d'un écran (polices surtout) |
| `pages/` | une page LVGL par fichier, avec les capteurs HA, images et polices qu'elle seule utilise |

## État (12/10/2026, phase 1)

Éléments **extraits fidèlement** de l'écran monolithique `haplan-display.yaml` de falbala (`/docker/esphome/config`,
4 273 lignes) par `tools/decouper-ecran.py` ; l'assemblage `screens/haplan-display.yaml` redonne **exactement** la même
configuration (`esphome config` comparé par `tools/comparer-config.py` : 0 différence, comparateur vérifié sur deux
modifications volontaires). L'écran réel n'a pas été recompilé ni flashé.

- `bases/sunton-8048s070c.yaml` — Sunton ESP32-8048S070C, 800×480, GT911.
- `pages/` : `original`, `rez-de-chauss-e`, `premier` (plans, générés par `applications/haplan/tools/generate_esphome_floorplan.py`),
  `energie-direct`, `ballons-chauffe`, `thermostats`, `clim-salle`, `clim-bureau`, `clim-ami` (écrites à la main le 06/10/2026).
- `communs/haplan-display-communs.yaml` — polices des plans, de la navigation et des pages thermostats/climatisation.

Les pages sont encore **propres au format 800×480** (positions en pixels) et à **cet écran** (entités en dur, préfixes d'id).

## Satellites vocaux (13/10/2026) — nouvelle organisation `materiels/` + `elements/` + `appareils/`

`hasat3`, `hasat4` et `hasat5` sont **le même fichier au nom près** (un modèle, plusieurs appareils). `hasat4.yaml` a été découpé
par `tools/decouper-par-plan.py` selon `tools/plans-decoupage/satellite-vocal.json` en :

- `materiels/waveshare-esp32-s3-audio/base.yaml` — la carte (ESP32-S3 16 Mo, PSRAM, codecs ES7210/ES8311, TCA9555, anneau de
  LED, I2S, micro, haut-parleur, OTA, journal) ; paramètres `device_name`, `friendly_name` ; **sans le wifi** ;
- **wifi, élément interchangeable** (fournit `wifi_id`) :
  - `elements/wifi-simple/element.yaml` — un seul réseau, connexion rapide : le comportement historique (extrait fidèlement) ;
  - `elements/wifi-multi-ap/element.yaml` — **plusieurs réseaux** (priorité, un par site, secrets `wifi_<site>_ssid/password`)
    et **point d'accès de secours** « `<appareil>` secours » avec **portail captif** (comme Tasmota) ; secret à créer :
    `wifi_secours_password`. ESPHome y ajoute de lui-même une mise à jour par la page web du portail (protégée par le
    mot de passe du point d'accès) ;
- `elements/assistant-vocal/element.yaml` — l'assistant (lecteur audio, assistant de HA, mot d'éveil, scripts de l'anneau,
  réglages exposés à HA, boutons) ; les automatismes de `esphome`, `wifi` et `api` (démarrage, connexion) sont dans
  l'élément, les réglages de ces sections dans la base ou l'élément wifi : ESPHome refusionne les deux ;
- `../appareils/hasat4.yaml`, `../appareils/hasat5.yaml` — nom, nom d'affichage, `packages:` (matériel, wifi, assistant).
  **Changer de wifi = changer une ligne** (`wifi-simple` ↔ `wifi-multi-ap`).

Contrôle : `esphome config` de chaque appareil assemblé comparé à celui de l'original par `tools/comparer-config.py` —
**0 différence** pour hasat4 et hasat5 avec `wifi-simple` (comparateur vérifié sur deux modifications volontaires, une dans la
base, une dans l'élément) ; la variante `wifi-multi-ap` est acceptée par ESPHome (`esphome config`, secrets factices dans un
dossier d'essai), avec les automatismes de connexion de l'assistant toujours branchés. Les satellites n'ont **pas de clé de chiffrement API**. Le composant externe `es8311` vient de
`github.com/sw3Dan/waveshare-s2-audio_esphome_voice` sur la branche `main` (**non figé** : à figer sur un commit).

Les dossiers `bases/`, `communs/`, `pages/` (phase 1, écran) et `screens/` seront reclassés dans cette organisation.

## Fichiers non suivis ici

Images de fond des plans (`floorplan_*_800x480.png`), police `fa-solid-900.ttf`, table de partitions `partitions-haplan.csv`
et `secrets.yaml` restent dans le dossier de configuration ESPHome (`/docker/esphome/config` sur falbala). Pour compiler,
le fichier de l'écran et le dossier `bibliotheque/` doivent être posés **dans ce même dossier** (chemins relatifs).

## Suite prévue

1. Pages paramétrables (`!include` avec `vars:`) : une seule page « climatisation » pour les trois, entités en paramètres.
2. Pages qui s'adaptent à la taille (pourcentages, mise en page LVGL flex/grid) et déclarent leurs formats compatibles.
3. Pages de plans lues depuis HA (intégration Plans, positions au coin inférieur gauche converties en centres).
4. Éléments externes (dépôts git, version figée).
5. Écran de composition dans espdisplay (choix des pages, ordre, paramètres → génération, compilation, envoi).
