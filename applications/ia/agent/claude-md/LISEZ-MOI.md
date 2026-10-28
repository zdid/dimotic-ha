# Modèle du CLAUDE.md de l'agent Claude Code (machine Home Assistant)

Source unique du `CLAUDE.md` déposé sur la machine par le script « Installer l'IA sur une machine Home Assistant » de
l'application Outils (`applications/outils/reposcripts/wrappers/installer-ia.sh`). Specs : `conception-claude-code-automatisations`
(§2ter) et `fonctionnelles-outils` (§7.4).

- **Sections** (concaténées dans cet ordre) : `00-role.md`, `10-dimotic-mcp.md`, `20-ha-config.md` (si le dossier de configuration
  Home Assistant existe), `90-securite.md`. L'accès direct à Home Assistant par jeton (ancienne section `30-ha-direct`) est retiré
  depuis la v1.3.0 (décision du 28/10/2026) : l'agent passe uniquement par le serveur MCP de dimotic-ha.
- **Section « Site »** : si `site.md` existe à côté du `CLAUDE.md` sur la machine (copie de `sites/<fiche>.md`, choisie par le script),
  il est ajouté à la fin (connaissances propres au site, niveau d'autorisation). Il n'est jamais écrasé par une mise à jour du modèle.
- **Variables** : `{{TARGET_HOST}}` (nom, adresse et site de la machine), `{{HA_CONFIG_DIR}}`.
- **Version** : `VERSION` — à incrémenter à chaque modification du texte ; elle figure en tête du `CLAUDE.md`
  rendu, ce qui permet de voir si une machine est à jour.
- **Mettre à jour une machine** : régénérer le script dans l'application Outils, mode `mettre_a_jour_claude_md` — seul le
  `CLAUDE.md` est réécrit, puis la session est relancée.
