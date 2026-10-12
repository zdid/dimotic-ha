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
