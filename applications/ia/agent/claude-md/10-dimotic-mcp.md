## dimotic-ha (serveur MCP « dimotic »)

Tu disposes des mêmes outils que l'assistant vocal Mistral, plus des outils de lecture :
- `lister_entites`, `obtenir_etat`, `obtenir_details` — entités, état, attributs réels, classement ;
- `lister_entites` renvoie la `categorie` HA de chaque entité (`principale`, `config` = réglage, `diagnostic`) ; filtre `categorie` pour
  écarter réglages et diagnostic. L'assistant vocal Mistral, lui, ne voit que les entités principales ;
- `diagnostiquer_resolution` — pourquoi un quoi/lieux ne ressort pas ;
- `tester_phrase` — simule une phrase SANS rien exécuter ;
- `lire_planificateur` — planifications, macros, actions reçues, commandes réellement envoyées à HA ;
- `lire_automatisations_ha` — automatisations de Home Assistant (liste, définition, sauvegardes) ;
- `deposer_automatisation`, `supprimer_automatisation` — AGISSENT sur Home Assistant : sans `confirme: true` ils renvoient un APERÇU
  sans rien modifier ; montre-le à l'utilisateur et n'envoie `confirme: true` qu'après son accord explicite ;
- `lire_tableaux_de_bord`, `deposer_tableau_de_bord`, `lire_energie`, `deposer_energie` — tableaux de bord (graphes, cartes) et tableau Énergie de HA ; dépôt = APERÇU sans `confirme: true`, sauvegarde avant remplacement ;
- `lire_scripts_ha`, `deposer_script`, `supprimer_script` — scripts de HA ; un script se dépose avec un NOM (`alias`) ET une DESCRIPTION (obligatoires), `fields` (paramètres, chacun avec `name` et
- `lire_etiquettes_ha`, `etiqueter_ha` — étiquettes (labels) de HA. **Chaque automatisation ou script que tu déposes doit être rangé** : avant de le déposer (ou juste après), appelle `lire_etiquettes_ha`, **PROPOSE à l'utilisateur la catégorie la plus probable parmi les étiquettes existantes (ou demande-lui)**, puis pose-la avec `etiqueter_ha` (aperçu puis `confirme: true`). Une étiquette nouvelle exige son accord (`creer: true`) et une carte à ajouter au tableau de bord « Automatisations » (`/liste-automatisations`). Sans étiquette, l'automatisation tombe dans « Autres ». Ne mets jamais de préfixe `[catégorie]` dans le nom.
  `description`) et `sequence` ; aperçu sans `confirme: true`, sauvegarde avant remplacement ;
- **Notifier les administrateurs** : appeler `script.notifier_administrateurs` (data : `message`, `title`, `data` = boutons de réponse `actions`, `tag`, `sticky`…). Il envoie à chaque
  téléphone du groupe `notify.administrateurs` ; ne JAMAIS écrire un `notify.mobile_app_*` à la main dans une automatisation ;
- `verifier_entity_ids` — LECTURE SEULE : parcourt automatisations, scripts, scènes, tableaux, Énergie et plans et liste ce qui est cité mais n'existe plus
  (entités, services, appareils `device_id`, pièces `area_id`), avec des suggestions à CONFIRMER avant de corriger ; à lancer après un renommage ;
- `lire_pieces_ha`, `affecter_piece_ha`, `renommer_piece_ha`, `supprimer_pieces_vides_ha` — pièces (areas) de HA : lire (avec les pièces vides), affecter des entités/appareils,
  renommer, supprimer les pièces VIDES ; APERÇU sans `confirme: true` ; `nommage` recalcule les pièces depuis le nom : pour un changement durable, modifier aussi le lieu du nom ;
- `creer_aide_ha` — crée, liste ou supprime une aide de HA (minuterie `timer`, `input_boolean`, `input_number`…) ; `action` = lister / creer / supprimer ;
  sans `confirme: true`, APERÇU seulement (entity_id prévu, collision) ; montre-le et attends le « oui » explicite ;
- `renommer_entite_ha` — renomme une entité de HA (nouvel `entity_id` et/ou nom affiché) ; sans `confirme: true`, APERÇU seulement
  (identifiant libre ou pris, automatisations qui citent l'ancien) ; HA ne réécrit pas les références : à corriger ensuite ;
- `auditer_noms_ha`, `renommer_appareil_ha` — contrôle des noms de HA. `auditer_noms_ha` (LECTURE SEULE) liste les appareils SANS taxonomie dont le nom ne suit pas
  `quoi---[précis--]lieu[--père[--grand-père]]` et les `entity_id` dont la pièce a changé. Marche guidée : (1) auditer ; (2) par lots d'une dizaine, PROPOSER un nom à l'utilisateur et
  attendre son accord (ne jamais inventer le QUOI ni le lieu) ; (3) `renommer_appareil_ha` (aperçu puis `confirme: true`) ; (4) pour un `entity_id` décalé, `verifier_entity_ids` PUIS
  `renommer_entite_ha` ; (5) relancer l'audit. Un appareil déjà classé par `nommage` est refusé (son nom vient de la source MQTT) ;
- `executer_action` — AGIT RÉELLEMENT sur la maison (confirmation demandée à chaque appel).

Le vocabulaire (quoi/lieux, valeurs absolues, un lieu précis et sa pièce en UN seul élément) et le
catalogue de cette maison te sont transmis à la connexion ; règles complètes : ressource
`dimotic://regles`. Le catalogue est propre à CETTE maison : n'y suppose pas les entités d'un autre site.
