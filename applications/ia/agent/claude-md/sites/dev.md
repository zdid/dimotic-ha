## Site « dev » (falbala) — essais de l'agent contre la maison réelle

Tu tournes sur la machine de DÉVELOPPEMENT (falbala), pas sur ha2. Le dimotic-ha local est branché sur le Home Assistant **réel** de ha2 :
tout ce que tu fais via les outils MCP agit sur la **production**, habitants à la maison. Cet espace sert à mettre au point la chaîne
(outils MCP de dépôt d'automatisations, règles du CLAUDE.md) avant de la déployer sur ha2.

- **Niveau d'autorisation : niveau 2 d'essai.** Pour tout test d'écriture, utilise un `id` commençant par **`test_dev_`**, une automatisation
  **inoffensive** (par exemple qui ne fait que `persistent_notification.create`, jamais lumière/volet/chauffage/poêle) **désactivée par défaut
  si possible**, et **supprime-la à la fin de l'essai**. Aperçu d'abord, `confirme: true` seulement après l'accord de l'utilisateur.
- **Fichiers de configuration de HA** : ils sont sur ha2, tu les lis par SSH, en lecture seule :
  `ssh -i ~/.ssh/ha2-claude/id_ed25519 claude@ha2.local 'cat /docker/homeassistant/config/automations.yaml'` (idem `scripts.yaml`,
  `scenes.yaml`, `configuration.yaml`). `secrets.yaml` et `.storage` sont interdits. Aucune écriture sur ha2 par SSH : le dépôt passe par les outils MCP.
- **Pas de jeton Home Assistant** ici : l'état se lit par les outils MCP (`obtenir_etat`, `obtenir_details`, `lire_automatisations_ha`).
- Le poêle est en production : ne pas y toucher. Ne pas relancer d'applications ni de services : dis à l'utilisateur ce qu'il faut faire.

### Pilotes (AREXX, RFXCOM, zigbee2mqtt) de la machine de développement
Les pilotes de falbala (dev) sont joignables par le canal MQTT du site de développement.
Tu gères les pilotes avec les outils MCP **`pilotes_ponts`**, **`pilotes_lire`** et **`pilotes_modifier`** (spec `conception-gestion-pilotes_specs_v1.5.md`). Ils passent par le cœur : tu n'as ni SSH ni accès aux fichiers.
Règles :
1. **Toujours `pilotes_ponts` d'abord.** Plusieurs ponts du même type (ex. deux bases AREXX) → demande **lequel**. Un pont `joignable: false` ne répond pas : dis-le.
2. Seuls les ordres listés dans les `capacites` du pont existent ; n'en essaie pas d'autres.
3. **Qualification complète avant d'adopter** : demande le **QUOI** (si le type ne le fixe pas), le **lieu** (obligatoire) et le **lieu précis**, et si l'appareil doit **apparaître dans HA** (`transmitToHa`). Un appareil détecté n'a pas d'entité HA tant qu'il n'est pas adopté.
4. **Aperçu puis accord** : `pilotes_modifier` sans `confirme` ne change rien et renvoie l'aperçu (ce qui sera fait, entités HA touchées). Montre-le en français simple, attends un « oui » **explicite**, puis renvoie les **mêmes paramètres** avec `confirme: true`. Après coup, vérifie dans HA (`obtenir_details`) que l'entité reçoit des valeurs.
5. **Remplacer** un capteur ou un émetteur : l'ancien est supprimé puis le neuf reprend **le même nom**, donc le même `entity_id` : les automatisations n'ont pas à changer. Le neuf doit être dans les découverts (demande de le déclencher / d'attendre son émission). **RFXCOM** : rappelle que l'**appairage physique** du module avec le nouvel émetteur se fait hors dimotic-ha et demande s'il est fait.
6. **Supprimer** retire aussi l'entité de HA : annonce-le. Un device encore utilisé par un récepteur est refusé : propose de le remplacer ou de modifier le récepteur.
7. **Production** : les pilotes RFXCOM et GPIO pilotent de vrais relais et volets. Préviens avant un `redemarrer` ou une suppression et attends l'accord.
8. Une erreur du pont (`etat_change`, `signature_requise`…) : explique-la simplement ; pour `etat_change`, refais l'aperçu. Ne cherche jamais à contourner un refus.
Ici, tu es en développement : si une entité est créée dans le vrai HA par un essai (`transmitToHa: true`), dis-le à l'utilisateur et propose de la supprimer ensuite.
