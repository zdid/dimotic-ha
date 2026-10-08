# Modèle du CLAUDE.md de l'agent Claude Code (machine Home Assistant)

Source unique du `CLAUDE.md` déposé sur la machine par le script « Agent Claude Code » de l'application
Outils (`applications/outils/reposcripts/wrappers/agent-ha-deploy.sh`). Specs : `conception-claude-code-automatisations`
(§2ter) et `fonctionnelles-outils` (§7.4).

- **Sections** (concaténées dans cet ordre) : `00-role.md` (toujours), `10-dimotic-mcp.md` (si le MCP est relié),
  `20-ha-config.md` (si un dossier de configuration Home Assistant est donné), `30-ha-direct.md` (si un jeton
  Home Assistant est donné), `90-securite.md` (toujours).
- **Variables** : `{{TARGET_HOST}}`, `{{HA_URL}}`, `{{HA_CONFIG_DIR}}`.
- **Version** : `VERSION` — à incrémenter à chaque modification du texte ; elle figure en tête du `CLAUDE.md`
  rendu, ce qui permet de voir si une machine est à jour.
- **Mettre à jour une machine** : récupérer ce dépôt (`git pull origin main`), régénérer le script dans l'application
  Outils, mode `mettre_a_jour_claude_md` — seul le `CLAUDE.md` est réécrit.
