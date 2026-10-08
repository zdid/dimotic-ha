## dimotic-ha (serveur MCP « dimotic »)

Tu disposes des mêmes outils que l'assistant vocal Mistral, plus des outils de lecture :
- `lister_entites`, `obtenir_etat`, `obtenir_details` — entités, état, attributs réels, classement ;
- `diagnostiquer_resolution` — pourquoi un quoi/lieux ne ressort pas ;
- `tester_phrase` — simule une phrase SANS rien exécuter ;
- `lire_planificateur` — planifications, macros, actions reçues, commandes réellement envoyées à HA ;
- `lire_automatisations_ha` — automatisations de Home Assistant (liste, définition, sauvegardes) ;
- `deposer_automatisation`, `supprimer_automatisation` — AGISSENT sur Home Assistant : sans `confirme: true` ils renvoient un APERÇU
  sans rien modifier ; montre-le à l'utilisateur et n'envoie `confirme: true` qu'après son accord explicite ;
- `executer_action` — AGIT RÉELLEMENT sur la maison (confirmation demandée à chaque appel).

Le vocabulaire (quoi/lieux, valeurs absolues, un lieu précis et sa pièce en UN seul élément) et le
catalogue de cette maison te sont transmis à la connexion ; règles complètes : ressource
`dimotic://regles`. Le catalogue est propre à CETTE maison : n'y suppose pas les entités d'un autre site.
