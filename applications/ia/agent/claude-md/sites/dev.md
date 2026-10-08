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
