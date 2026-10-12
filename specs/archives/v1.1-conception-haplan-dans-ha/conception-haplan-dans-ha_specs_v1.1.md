# Conception — HAPLAN directement dans Home Assistant

*Version 1.1 — 12 Octobre 2026 — **conception ; seul le squelette de l'intégration est écrit (v0.0.1).** Décisions du 12/10/2026 (v1.1) : dépôt **`zdid/dimotic-ha-plans`** (public), domaine HA **`dimotic_plans`** (figé), intitulé du menu **« Plans »** avec titre et icône réglables (*Configurer*), icône `mdi:floor-plan`, panneau réservé aux administrateurs ; HAPLAN de dimotic-ha reste en place jusqu'à la bascule (phase 5). Décisions de l'utilisateur du 12/10/2026 : (1) l'outil de création des plans de dimotic-ha est **remplacé** par un outil intégré à HA ; (2) les écrans ESP32 doivent continuer à être alimentés — **moyen à trouver** ; (3) les **plans existants et les positions d'objets** sont repris.*

## 1. Objet

Aujourd'hui la page de création des plans (application `haplan` de dimotic-ha, ~5 600 lignes de TypeScript côté navigateur) parle à HA **par le serveur de dimotic-ha** (Socket.io : `haplan:entities:state:bulk`, `haplan:entity:command`, `haplan:taxonomy:tree`…). Cible : une **intégration personnalisée de HA** (dépôt public, installable par HACS, sur le modèle de `zdid/dimotic-ha-screen-console`) qui fournit un panneau « Plans » dans le menu de HA, parlant **directement** à HA (objet `hass` du panneau), sans dimotic-ha. Les plans restent exposés à HA par ses propres cartes et alimentent toujours les écrans ESP32.

## 2. État actuel (relevé du 12/10/2026)

| Élément | Où | Détail |
|---|---|---|
| Plans + positions | `data/haplan/config-haplan-floorplans-v1.0.yaml` | `floorplans: { <id>: { filename, positions:[{entity_id, x, y}], texts:[{id,text,x,y,size,color}] } }` ; x/y **normalisés 0-1** |
| Images | `data/haplan/images/*.png` | un PNG par plan ; « page libre » = PNG vierge généré |
| Affichage dans HA | `haplan_lovelace.yaml` (fichier dans la configuration de HA) | généré par `lovelace-generator.ts` : cartes `picture-elements`, une vue par plan ; déposé par SSH + images dans `www/` (`HaplanLovelaceDeployService`) |
| Écrans ESP32 | outil Python `applications/haplan/tools/generate_esphome_floorplan.py` | lit le YAML + les images **sur disque**, produit images 800×480 + pages LVGL pour ESPHome ; déploiement par `espdisplay` (conteneur ESPHome sur falbala) |
| Éditeur | `applications/haplan/src/presentation/haplan/` | classes du plan (objets lumière/volet/radiateur/thermostat/VMC…), glisser-déposer ; accès aux données par `DataService.ts` (Socket.io) |

Points faibles connus : les positions sont liées à l'**`entity_id`**, qui change quand nommage renomme (33/33 positions obsolètes un jour) ; le dépôt dans HA passe par un fichier + SSH.

## 3. Architecture cible

**Intégration `haplan`** (dépôt `zdid/dimotic-ha-plans`, créé le 12/10/2026) :
- **Stockage** : `Store` de HA (`.storage/haplan.floorplans`) — mêmes données que le YAML actuel, plus un identifiant stable par position (voir §5). Images : fichiers dans `config/haplan/images/`, servis par la route statique de l'intégration (téléversement par une vue HTTP réservée aux administrateurs).
- **API WebSocket** (administrateurs) : `haplan/floorplans/list|save|delete`, `haplan/image/upload`, `haplan/export` (voir §4).
- **Panneau « Plans »** : éditeur repris de `src/presentation/haplan/` ; `DataService.ts` remplacé par un accès à `hass` : états (`hass.states`), commandes (`hass.callService`), pièces et appareils (registres de HA), taxonomie lue dans l'attribut `attributs_taxonomie` des entités (posé par nommage).
- **Affichage** : carte personnalisée `haplan-card` (ou génération de la vue `picture-elements` **directement** dans le stockage Lovelace de HA par `lovelace/config/save`), sans fichier ni SSH.

## 4. Alimenter les écrans ESP32 (point 2 à décider)

L'outil Python lit des fichiers. Trois voies :
- **A — export depuis HA (recommandé).** L'intégration expose `haplan/export` (WebSocket) / une route HTTP signée qui renvoie plans, positions, textes et images. `generate_esphome_floorplan.py` gagne l'option `--source ha` (URL + jeton) ; le reste du pipeline (ESPHome dans Docker sur falbala, `espdisplay`) ne change pas. dimotic-ha n'est plus nécessaire pour l'**édition**, seulement pour compiler et téléverser le firmware.
- **B — copie de fichiers.** L'intégration écrit aussi `data/haplan/…` (dossier partagé) : simple mais couple HA à la machine de compilation.
- **C — réécrire la génération ESP32 dans l'intégration** : trop lourd (images, polices, LVGL), à écarter.

## 5. Reprise des plans existants et des positions (point 3)

1. **Import** : lecture de `config-haplan-floorplans-v1.0.yaml` + `images/` → plans, positions, textes. Les plans actuels : `original` (8 positions), `Rez de chaussée` (2), `Premier` (2), et les « pages libres » éventuelles.
2. **Stabilité (amélioration)** : à l'import, chaque `entity_id` est associé à l'**identifiant du registre d'entités de HA** (stable, jamais modifié par un renommage). À l'affichage, l'`entity_id` courant est retrouvé par ce lien : les positions ne deviennent plus obsolètes quand nommage renomme. Les `entity_id` absents du registre sont signalés (« orphelins ») au lieu d'être perdus.
3. **Vérification** : comparer plans et nombre de positions avant/après ; conserver le YAML d'origine (sauvegarde) tant que la bascule n'est pas validée.

## 6. Phases proposées

1. **Dépôt + stockage** ✅ (v0.0.1 : squelette, panneau « Plans », stockage `.storage/dimotic_plans.floorplans`, commande `dimotic_plans/floorplans/list`), puis **import** (plans, images, positions) et affichage en lecture dans le panneau (positions fidèles).
2. **Commande des objets** dans le panneau (états, clics) — remplace l'accès par dimotic-ha.
3. **Éditeur** : déplacer, ajouter, supprimer des objets et des textes, créer/supprimer un plan, téléverser une image.
4. **Export + `--source ha`** pour les écrans ESP32 ; essai de bout en bout sur un écran.
5. **Bascule** : désactivation de l'application `haplan` de dimotic-ha (non supprimée tant que tout n'est pas validé).

## 7. Risques et points à trancher

- **Éditeur sur téléphone** : le glisser-déposer tactile est à vérifier (Android ; iOS non testable ici).
- **Taille** : les plans sont de petits PNG (35 à 130 ko) ; pas de limite gênante.
- **Écrans ESP32** : choix A/B/C ci-dessus ; l'outil Python reste sur falbala.
- **Où vit le code éditeur** : copié dans le nouveau dépôt (pas de dépendance à dimotic-ha) ; les évolutions futures de l'ancien éditeur ne seraient pas reportées automatiquement.
- **Aucune notification ni commande ne passe par dimotic-ha** une fois la bascule faite : en cas de panne de HA, plus de plan.
