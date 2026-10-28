# MEMO — Mise en place de l'IA (Claude Code dans `screen`) sur la machine Home Assistant + dimotic-ha

Rédigé le 28/10/2026 depuis la session projets-DC, après une mise en place **à la main** sur opi4pro (192.168.1.51).
À reprendre dans une session dimotic-ha : revoir le processus (`outils` : script carte SD §7.2 et « Agent Claude Code »
§7.4 ; intégration `dimotic-ha-screen-console` ; application `ia` §19).

## 1. Exigence de l'utilisateur

Sur une machine qui porte Home Assistant et dimotic-ha, l'IA doit fonctionner **du premier coup** : on ouvre le panneau
« IA » de Home Assistant (intégration `screen_console`), la session `screen` de Claude Code est là, branchée sur le MCP de
dimotic-ha. **Aucune commande SSH ni manipulation sur la machine.** Seule étape manuelle admise : la **connexion au compte
Claude par le web**, demandée par Claude Code au premier lancement.

## 2. Ce qui a manqué sur opi4pro le 28/10/2026 (constaté)

| # | Constat | Conséquence | Fait à la main le 28/10 |
|---|---|---|---|
| 1 | Intégration `screen_console` installée et configurée (panneau « IA », compte `claude`), mais **script de contrôle `/home/claude/bin/screen-console-gate` absent** et **ligne de clé `ha-screen-console` absente** de `/home/claude/.ssh/authorized_keys` | Panneau vide (SSH refusé). L'assistant de l'intégration *affiche* la ligne à ajouter : étape manuelle en SSH | Script copié depuis `dimotic-ha-screen-console/host/`, ligne ajoutée par l'utilisateur (le classifieur de Claude refuse d'ajouter une clé SSH) |
| 2 | **Claude Code non installé** (aucun compte) | Rien à lancer | Installé par l'utilisateur sous `claude` (installeur natif ; le classifieur refuse `curl … \| bash` sur la production) |
| 3 | **Aucune session `screen`**, rien au démarrage | Panneau vide, et à chaque redémarrage | Service `/etc/systemd/system/claude-screen.service` (User=claude, `screen -DmS claude zsh -lc "cd … && ~/.local/bin/claude"`, Restart=on-failure) |
| 4 | **Répertoire de travail sans `CLAUDE.md`** (Claude lancé dans `/home/claude`) | Claude sans consignes | `/home/claude/automatismes/CLAUDE.md` = copie de `MEMO_claude-automatismes-ha2_2026-10-07.md` (provisoire ; le modèle `applications/ia/agent/claude-md/` et `/dimotic-ha-addons/agent-ha` de §7.4 ne sont pas utilisés) |
| 5 | **MCP non branché** pour le compte `claude` (`claude mcp list` : rien de dimotic) | Claude sans accès à la maison ; un jeton HA a été copié à tort puis retiré | Rien (en attente) |
| 6 | **Serveur MCP de `ia` arrêté** depuis le redémarrage de HA du 26/10 : `ia` demande la taxonomie **avant** que `dimotic_taxonomie` soit chargée (`unknown_command`), puis attend un `ha:ready` qui ne revient pas ; le MCP ne démarre qu'avec le référentiel | MCP muet jusqu'au redémarrage de `ia` | Rien (correctif de code à faire : réessayer après quelques secondes) |
| 7 | Questions du premier lancement : thème, connexion, **confiance du dossier (« No, exit » sélectionné par défaut)**, approbation du serveur MCP du projet | Un Entrée de trop ferme Claude ; la session disparaît (Restart=on-failure ne relance pas une sortie normale) | Prévenir l'utilisateur |
| 8 | Si l'utilisateur quitte Claude (`/exit`), la session disparaît et le panneau ne peut pas la relancer (le script de contrôle ne sait que `list` / `attach`) | Retour en SSH obligatoire | — |

## 3. Processus cible (proposition)

Tout est fait par le **provisionnement** (script carte SD, ou un mode « installer l'IA » d'`outils` exécuté depuis l'interface),
jamais à la main :

1. Compte `claude` (pas dans `sudo`, conforme à §7.4 — à concilier avec §7.2 qui le met « sudo sans mot de passe »), paquet `screen`.
2. **Claude Code installé dans le compte** (installeur natif, au premier démarrage avec réseau), chemin vérifié.
3. **Paire de clés de `screen_console` créée par le provisionnement** : clé privée déposée là où l'intégration la lit
   (`/config/.storage/screen_console_ed25519`, `ensure_key` la réutilise si elle existe), clé publique ajoutée à
   `authorized_keys` avec `from="127.0.0.1,::1",command="…/screen-console-gate",no-…` ; script de contrôle installé.
   Idéal : entrée de configuration de l'intégration créée aussi, pour qu'il n'y ait même pas d'assistant à valider.
4. **Répertoire de travail unique** : celui de §7.4 (`/dimotic-ha-addons/agent-ha`) avec `CLAUDE.md` rendu depuis
   `applications/ia/agent/claude-md/` (+ `sites/<machine>.md`) ; abandonner la copie du mémo de l'étape 4 ci-dessus.
5. **MCP** : `mcpEnabled: true`, `mcpToken` généré au provisionnement (secrets de `ia`), `.mcp.json` du projet avec ce jeton,
   et **pré-approbation** du serveur (`enableAllProjectMcpServers` ou `enabledMcpjsonServers: ["dimotic"]` dans le
   `.claude/settings.json` du projet — à vérifier sur la version de Claude Code).
6. **Questions du premier lancement pré-répondues** dans `~/.claude.json` du compte : fin de l'accueil, thème, et
   **confiance du dossier de travail** acceptée (clé par projet `hasTrustDialogAccepted` — à vérifier). Il ne reste que la connexion web.
7. **Service systemd** (comme celui posé le 28/10) mais qui relance aussi après une sortie normale (`Restart=always`,
   `RestartSec=5`), pour que le panneau retrouve toujours une session ; ou bien un mode `start` du script de contrôle.
8. **Correctif `ia`** (constat 6) : réessai du chargement de la taxonomie (délai, quelques tentatives) au lieu d'attendre le
   prochain `ha:ready`, pour que le MCP démarre seul après tout redémarrage de HA.

**Test de réception** : machine neuve → premier démarrage → panneau « IA » : la session `claude` est listée → on s'y attache →
seule la connexion web est demandée → `/mcp` montre `dimotic` connecté → redémarrage de la machine → la session revient seule.

## 4. Points à trancher

- ~~Remote Control ou panneau `screen_console`~~ → **décidé le 28/10/2026 : les deux.** La même session Claude Code est
  dans le `screen` (panneau « IA » de HA) **et** joignable par **Remote Control**. Elle doit porter un **nom qui désigne le
  site**, pour ne pas confondre dans la liste du Remote Control les automatisations de St Fort et de Noisy :
  **« stfort automatisation HA »**, **« noisy automatisation HA »** (forme `<site> automatisation HA`). Le site est déjà
  connu de la machine : `core.site` dans `data/core/machine_config.yaml` (`stfort` sur opi4pro) → nom calculé par le
  provisionnement, sans saisie. Option de nommage de Claude Code à vérifier sur la version installée (nom de session
  au lancement, ou `/rename` au premier démarrage) ; le nom du `screen` reste court (`claude`).
- ~~Jeton HA direct~~ → **décidé le 28/10/2026 : on l'enlève.** L'IA passe **uniquement par le MCP** de dimotic-ha :
  retirer `HA_URL` / `HA_TOKEN`, la section `30-ha-direct` du modèle de `CLAUDE.md` et le fichier `ha_token` de §7.4
  (`MCP_TOKEN` devient obligatoire).
- **Droits du compte `claude`** → **décidé le 28/10/2026 : on laisse** en l'état (§7.2 : sudo sans mot de passe, docker).
  Mettre §7.4 en cohérence (il refuse aujourd'hui un compte dans `sudo`).
- Nom des machines : `ha2` dans les docs = **opi4pro** (Orange Pi 4 Pro, Debian 12 arm64, 4 Go), pas un Raspberry Pi 4 2 Go comme
  l'indique `MEMO_claude-automatismes-ha2` §fin.

## 5. État laissé sur opi4pro (28/10/2026)

- `claude-screen.service` actif et activé (sauvegarde `.bak-20261028`), répertoire `/home/claude/automatismes`.
- `/home/claude/bin/screen-console-gate` + ligne `ha-screen-console` dans `authorized_keys` (sauvegarde `.avant-screen-console`) :
  panneau « IA » fonctionnel.
- Claude Code 2.1.312 dans `/home/claude/.local/bin`.
- Pas de MCP branché ; aucun jeton HA dans le compte `claude`.
- Applications externes dans `/docker/dimotic-ha/data/applications` (plus récentes que l'image 4.1.0) : à retirer après
  déploiement de l'image **4.2.0** (construite le 28/10).

## 6. Suite à reprendre dans une session dimotic-ha (état au 28/10/2026, fin de session projets-DC)

- **Fait** : commits poussés ; tag **`v4.2.0`** sur `39a06d4` (correctif `outils` : tests exclus du `tsconfig`, le build
  Docker échouait faute de `vitest`) ; image **`zdid2/dimotic-ha:4.2.0`** + `:latest` publiée (amd64, arm64, arm/v7).
- **Fait le 28/10 (session dimotic-ha, étapes 1 à 3)** : opi4pro en **4.2.0** (`.env` sauvegardé en `.env.avant-4.2.0-20261028`), conteneur sain, MCP de `ia` relancé seul sur 8765 après chaque redémarrage ; applications externes sauvegardées dans `/root/applications-externes-opi4pro-avant-4.2.0-20261028.tar.gz` puis retirées (et le lien `core`) : les 17 modules se chargent depuis l'image (`/app/applications`).
- **Prochaines étapes**, sur la production avec l'accord de l'utilisateur :
  1. déployer la 4.2.0 sur opi4pro (`DIMOTIC_TAG=4.2.0` dans `/docker/dimotic-ha/.env`, pull, up -d) ;
  2. vérifier les applications et le **serveur MCP** de `ia` (127.0.0.1:8765) — le redémarrage doit le relancer (constat 6) ;
  3. sauvegarder puis retirer les **applications externes** de `/docker/dimotic-ha/data/applications` (`arbreouquoi`,
     `esps-assemble`, `ia`, `planificateur`, `scriptsha`, `tasmota`, lien `core`) : elles étaient plus récentes que la 4.1.0
     (builds du 21/10 15:56 et du 22/10), la 4.2.0 les contient désormais ;
  4. brancher le MCP pour le compte `claude` (`.mcp.json` du projet, jeton `mcpToken`) ;
  5. traiter le processus cible (§3) et les décisions (§4).
- **Fait le 28/10 (session dimotic-ha, suite)** : étape 4 et processus cible (§3) réalisés par le script Outils **« Installer l'IA »**
  (`installer-ia`, spec `fonctionnelles-outils` v1.14 §7.4 ; remplace `agent-ha-deploy`) ; correctif `ia` du constat 6 (spec v1.36, **pas encore
  déployé** : prochaine image ou racine externe) ; carte SD : option `claude-code` = installateur + minuteur de premier démarrage. Essai réel sur
  opi4pro réussi : session dans `/dimotic-ha-addons/agent-ha`, aucune question, Remote Control « stfort automatisation HA », MCP `dimotic`
  connecté sur `192.168.1.51:8765` (`mcpHost` passé de 127.0.0.1 à l'IP, décision de l'utilisateur). Ancien dossier `/home/claude/automatismes`
  laissé en place (plus utilisé).
