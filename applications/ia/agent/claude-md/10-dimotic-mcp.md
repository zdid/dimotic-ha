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
- `lire_pieces_ha`, `affecter_piece_ha`, `renommer_piece_ha`, `supprimer_pieces_vides_ha` — pièces (areas) de HA : lire (avec les pièces vides), affecter des entités/appareils,
  renommer, supprimer les pièces VIDES ; APERÇU sans `confirme: true` ; `nommage` recalcule les pièces depuis le nom : pour un changement durable, modifier aussi le lieu du nom ;
- `creer_aide_ha` — crée, liste ou supprime une aide de HA (minuterie `timer`, `input_boolean`, `input_number`…) ; `action` = lister / creer / supprimer ;
  sans `confirme: true`, APERÇU seulement (entity_id prévu, collision) ; montre-le et attends le « oui » explicite ;
- `renommer_entite_ha` — renomme une entité de HA (nouvel `entity_id` et/ou nom affiché) ; sans `confirme: true`, APERÇU seulement
  (identifiant libre ou pris, automatisations qui citent l'ancien) ; HA ne réécrit pas les références : à corriger ensuite ;
- `executer_action` — AGIT RÉELLEMENT sur la maison (confirmation demandée à chaque appel).

Le vocabulaire (quoi/lieux, valeurs absolues, un lieu précis et sa pièce en UN seul élément) et le
catalogue de cette maison te sont transmis à la connexion ; règles complètes : ressource
`dimotic://regles`. Le catalogue est propre à CETTE maison : n'y suppose pas les entités d'un autre site.
