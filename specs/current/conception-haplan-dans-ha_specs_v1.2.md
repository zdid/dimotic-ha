# Conception — HAPLAN directement dans Home Assistant

*Version 1.2 — 12 Octobre 2026 — **phases 1 à 3 faites et validées par l'utilisateur sur ha2** (intégration `dimotic_plans` v0.1.6) ; restent l'export vers les écrans ESP32 (phase 4) et la bascule (phase 5). Décisions du 12/10/2026 (v1.1) : dépôt **`zdid/dimotic-ha-plans`** (public), domaine HA **`dimotic_plans`** (figé), intitulé du menu **« Plans »** avec titre et icône réglables (*Configurer*), icône `mdi:floor-plan` ; HAPLAN de dimotic-ha reste en place jusqu'à la bascule. Décisions de l'utilisateur du 12/10/2026 : (1) l'outil de création des plans de dimotic-ha est **remplacé** par un outil intégré à HA ; (2) les écrans ESP32 doivent continuer à être alimentés — **moyen à trouver** ; (3) les **plans existants et les positions d'objets** sont repris. Décisions ajoutées en v1.2 : panneau **visible par tous les utilisateurs** (import et éditeur réservés aux administrateurs) ; **point d'ancrage = coin inférieur gauche** de l'icône d'un objet ou d'un texte (pour les alignements) ; **icône seule** (sans rond), colorée par type et état ; objets choisis par la **taxonomie QUOI/OÙ** de nommage.*

## 1. Objet

Aujourd'hui la page de création des plans (application `haplan` de dimotic-ha, ~5 600 lignes de TypeScript côté navigateur) parle à HA **par le serveur de dimotic-ha** (Socket.io : `haplan:entities:state:bulk`, `haplan:entity:command`, `haplan:taxonomy:tree`…). Cible : une **intégration personnalisée de HA** (dépôt public, installable par HACS, sur le modèle de `zdid/dimotic-ha-screen-console`) qui fournit un panneau « Plans » dans le menu de HA, parlant **directement** à HA (objet `hass` du panneau), sans dimotic-ha. Les plans alimentent toujours les écrans ESP32.

## 2. État de départ (relevé du 12/10/2026)

| Élément | Où | Détail |
|---|---|---|
| Plans + positions | `data/haplan/config-haplan-floorplans-v1.0.yaml` | `floorplans: { <id>: { filename, positions:[{entity_id, x, y}], texts:[{id,text,x,y,size,color}] } }` ; x/y **normalisés 0-1**, **centre** de l'objet |
| Images | `data/haplan/images/*.png` | un PNG par plan ; « page libre » = PNG vierge généré |
| Affichage dans HA | `haplan_lovelace.yaml` (fichier dans la configuration de HA) | généré par `lovelace-generator.ts` : cartes `picture-elements`, une vue par plan ; déposé par SSH + images dans `www/` |
| Écrans ESP32 | outil Python `applications/haplan/tools/generate_esphome_floorplan.py` | lit le YAML + les images **sur disque** (positions = centres), produit images 800×480 + pages LVGL pour ESPHome ; déploiement par `espdisplay` |
| Éditeur | `applications/haplan/src/presentation/haplan/` | accès aux données par `DataService.ts` (Socket.io) |

Points faibles connus : les positions sont liées à l'**`entity_id`**, qui change quand nommage renomme (33/33 positions obsolètes un jour) ; le dépôt dans HA passe par un fichier + SSH.

## 3. Architecture réalisée (`dimotic_plans` v0.1.6)

- **Stockage** : `Store` de HA `.storage/dimotic_plans.floorplans` — `{floorplans: {<nom>: {filename, positions:[{entity_id, registry_id, x, y}], texts:[{id, text, x, y, size, color}]}}}`. x/y en fraction de l'image (0-1), **coin inférieur gauche** de l'icône (objet) ou du texte. Images : `config/dimotic_plans/images/`, servies par `GET /api/dimotic_plans/image/<fichier>` (authentification HA, chemin signé `auth/sign_path` pour `<img>` ; SVG servis avec `Content-Security-Policy: sandbox`). Un nouveau fichier d'image porte toujours un nom neuf (pas de vieille image en cache).
- **API WebSocket** : lecture pour tous — `dimotic_plans/floorplans/list`, `dimotic_plans/floorplans/get {plan_id}` (renvoie l'`entity_id` **actuel** retrouvé par `registry_id`, et `orphan`) ; administrateurs — `…/import {floorplans, images, overwrite}`, `…/save {plan_id, positions, texts}`, `…/create {plan_id, image?}` (sans image : page blanche SVG), `…/rename {plan_id, new_id}`, `…/delete {plan_id}`, `…/set_image {plan_id, image}`. Paramètre **`plan_id`** et non `id` (conflit avec l'identifiant de message de HA).
- **Panneau « Plans »** (`panel_custom`, web component, écrit pour l'intégration — l'ancien éditeur n'a pas été copié) : un onglet par plan, plan dimensionné à la fenêtre ; objets = icône d'état de HA (`ha-state-icon`) colorée par type et état, valeur des capteurs / température des thermostats / position des volets à droite, mise à jour en direct ; **clic** = bascule des lumières, prises, ventilateurs, booléens (fiche de l'entité pour les autres), **appui long ou clic droit** = fiche.
- **Éditeur** (administrateurs, bouton « Modifier », rien n'est écrit avant « Enregistrer ») : glisser (souris, tactile), flèches du clavier, magnétisme sur les autres éléments puis sur une **grille** (0,5 / 1 / 2 % de l'image, invisible sauf « Afficher ») ; ajout d'objet par la **taxonomie** (`attributs_taxonomie` posé par nommage : listes QUOI et lieu, recherche ; entités sans taxonomie et secondaires — diagnostic, configuration, masquées, ex. boutons RFXCOM — cachées par défaut) ; textes (taille, couleur) ; créer / renommer / supprimer un plan, changer son image.
- **Affichage dans les tableaux de bord de HA** (carte `picture-elements` ou carte personnalisée) : non fait, le panneau suffit pour l'instant.

## 4. Alimenter les écrans ESP32 (phase 4, à faire)

L'outil Python lit des fichiers. Trois voies :
- **A — export depuis HA (recommandé).** L'intégration expose `dimotic_plans/export` (WebSocket) / une route HTTP signée qui renvoie plans, positions, textes et images. `generate_esphome_floorplan.py` gagne l'option `--source ha` (URL + jeton) ; le reste du pipeline (ESPHome dans Docker sur falbala, `espdisplay`) ne change pas. **L'outil attend des centres** : l'export (ou l'outil) convertit le coin inférieur gauche en centre (icône de 28 px à la taille d'affichage de référence, voir §5).
- **B — copie de fichiers.** L'intégration écrit aussi `data/haplan/…` (dossier partagé) : simple mais couple HA à la machine de compilation.
- **C — réécrire la génération ESP32 dans l'intégration** : trop lourd (images, polices, LVGL), à écarter.

## 5. Reprise des plans existants et des positions (fait le 12/10/2026)

1. **Import** (`…/import`) : 3 plans (`original` 33 objets, `Rez de chaussée` 17, `Premier` 16), images converties en **traits noirs sur fond transparent** (« original » renforcé : image superposée décalée de 1 px vers le bas et la droite, opacité doublée), 0 orphelin.
2. **Stabilité** : chaque position garde l'**identifiant du registre d'entités** ; l'`entity_id` actuel est retrouvé à chaque lecture (renommages par nommage suivis).
3. **Passage au coin inférieur gauche** : les 66 positions importées (centres HAPLAN) ont été converties sans bouger à l'écran, `x − 14 px / largeur`, `y + 14 px / hauteur`, à la taille d'affichage relevée sur l'écran de l'utilisateur (`original` 603×785, `Rez de chaussée` et `Premier` 1181×785). Sauvegarde : `backups/ha2/dimotic_plans_floorplans_backup_2026-10-12_avant-ancrage-coin.json`. Un import HAPLAN ultérieur devrait faire la même conversion.
4. Le YAML d'origine de HAPLAN reste en place tant que la bascule n'est pas validée.

## 6. Phases

1. **Dépôt + stockage + import + affichage** ✅ (v0.0.1 → v0.0.5).
2. **Commande des objets** ✅ (v0.0.6).
3. **Éditeur** ✅ (v0.1.0 → v0.1.6 : ancrage coin inférieur gauche, grille, taxonomie, couleurs).
4. **Export + `--source ha`** pour les écrans ESP32 ; essai de bout en bout sur un écran.
5. **Bascule** : désactivation de l'application `haplan` de dimotic-ha (non supprimée tant que tout n'est pas validé).

## 7. Risques et points ouverts

- **Éditeur sur téléphone** : glisser-déposer tactile prévu (événements pointeur) mais pas encore essayé sur Android ; iOS non testable ici.
- **Taille des icônes fixe (28 px)** : l'alignement reste juste à toutes les tailles (même coin), mais un objet couvre plus ou moins de plan selon l'écran.
- **Mise à jour** : un changement Python de l'intégration demande un redémarrage de HA ; un changement du seul panneau, un rechargement de la page.
- **Aucune commande ne passe par dimotic-ha** une fois la bascule faite : en cas de panne de HA, plus de plan.
