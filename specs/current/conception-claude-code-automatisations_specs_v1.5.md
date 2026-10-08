# Conception — Claude Code, accès au système et génération d'automatisations

*Version 1.5 - 8 Octobre 2026*
*v1.5 : **mise à jour de l'état d'avancement (§0, §5, §10)** d'après les commits du Claude Code de développement (`3e9780f`, `ac9f07b`, `27d3233` : outils MCP de dépôt d'automatisations, CLAUDE.md v1.2.x avec sections de site, script de lancement sur la machine de dév) ; v1.4 archivée.*
*Version 1.4 - 8 Octobre 2026*
*v1.4 : **le `CLAUDE.md` de l'agent devient un modèle versionné du dépôt** (§2quater) — mis au point dans le Claude Code de développement, embarqué avec dimotic-ha, redéposé sur la machine Home Assistant à chaque évolution ; v1.3 archivée.*
*Version 1.3 - 8 Octobre 2026*
*v1.3 : **§0 État d'avancement** ajouté — ce qui est fait, éprouvé ou non, et ce qui n'est que spécifié ; à mettre à jour à chaque étape. v1.2 archivée.*
*Version 1.2 - 8 Octobre 2026*
*v1.2 : **diffusion et mise en place de Claude Code** (§2ter) — état réel (script Outils, écran Déploiement non réalisé), script aligné sur ces décisions, jeton Home Assistant **conservé** en option pour la mise au point ; v1.1 archivée.*
*Version 1.1 - 8 Octobre 2026*
*v1.1 : accès distant au Claude Code par **Remote Control** (§2bis, §10) à la place d'un VPN vers l'interface du site ; v1.0 archivée.*
*Spécification de **conception** (aucun code nouveau — sauf ce qui est déjà livré, §3). Consigne les décisions de
l'utilisateur du 08/10/2026 : un Claude Code par site, avec la même vision de la maison que l'assistant Mistral, des
autorisations ouvertes au fur et à mesure du besoin, et le choix entre le planificateur et Home Assistant pour exécuter
une automatisation. Les specs des applications concernées (`ia`, `planificateur`, socle) seront versionnées au moment de
la mise en œuvre (§9).*

---

## 📌 Table des Matières

0. État d'avancement
1. Objet et décisions
2. Les sites et leur organisation
3. Ce qui existe déjà (livré)
4. Où exécuter une automatisation : planificateur ou Home Assistant
5. Échelle d'autorisations
6. Lecture seule : ce qui est lu, ce qui est interdit
7. Rédiger une automatisation Home Assistant
8. Le planificateur, banc d'essai
9. Specs et code impactés
10. Points ouverts
11. Plan de mise en œuvre
12. Historique

---

## 0. État d'avancement (au 08/10/2026)

**Légende** — 🟢 utilisé en réel · 🟡 livré dans le code, **jamais éprouvé sur la vraie maison** (testé en simulation seulement) ·
⚪ spécifié seulement, **aucun code**. Tenir ce tableau à jour à chaque étape ; en cas de doute, il prime sur le reste du
document pour savoir « où on en est ».

| Élément | État | Où c'est décrit |
|---|---|---|
| Console web d'un `screen` (`screen2http`) | 🟢 | `fonctionnelles-screen2http` v1.2 |
| Serveur MCP de `ia` : outils de Mistral + vision (instructions, ressources) | 🟢 — utilisé sur la machine de développement, branchée au Home Assistant réel de ha2 (`fonctionnelles-ia` §19.10 « éprouvé sur le HA réel », `sites/dev.md`) | `fonctionnelles-ia` §19 |
| Outils de lecture `lister_entites` (avec `categorie`), `obtenir_details` (avec `quoi_appareil`) | 🟢 — éprouvés sur le HA réel | `fonctionnelles-ia` §19.7, §19.10, §19.11 |
| Outils de lecture `diagnostiquer_resolution`, `tester_phrase` | 🟡 | `fonctionnelles-ia` §19.7 |
| Lecture du planificateur (`lire_planificateur`) | 🟡 — le pont réel entre `ia` et `planificateur` jamais vérifié | `fonctionnelles-ia` §19.8 |
| Résolution quoi/lieux (« plafonnier de la chambre », repli par le nom borné au quoi) | 🟡 | `techniques-socle-ha-mqtt` §8.3.2 (v4.38) |
| Fichiers éditables à deux niveaux (`modele_integre/`, `personnalise/`) | 🟡 | `fonctionnelles-ia` §12bis |
| Règles Mistral révisées + noms de macros dans le catalogue | 🟡 | `fonctionnelles-ia` §5 ; fichier `regles_mistral.txt` |
| Script « Agent Claude Code » (compte dédié, MCP, permissions, `claude` cherché dans le compte) | 🟡 — jamais lancé sur une vraie machine | `fonctionnelles-outils` §7.4 |
| Modèle versionné du `CLAUDE.md` de l'agent (v1.2.1) + mode « mettre à jour le CLAUDE.md » | 🟡 | §2quater ; `fonctionnelles-outils` §7.4 |
| Section « Site » du `CLAUDE.md` (`sites/ha2.md`, `sites/dev.md`, `site.md` sur la machine, jamais écrasé) | 🟡 — rédigée d'après les specs, « à vérifier » signalé dans le texte | `applications/ia/agent/claude-md/LISEZ-MOI.md` |
| Lancement de Claude Code sur la machine de développement (`claude-screen-dev.sh`, `screen`, `.mcp.json`, CLAUDE.md + section « dev ») | 🟡 | `applications/ia/agent/claude-screen-dev.sh` |
| Pilotage à distance par Remote Control | 🟡 — repris par le script ; mode de connexion et reprise après redémarrage à vérifier | §2bis |
| Un Claude Code par site, MCP local en `127.0.0.1` | 🟡 ici (selon l'essai) · ⚪ site distant | §2 |
| Échelle d'autorisations : niveau 0 (lecture, propose) | 🟢 | §5 |
| Niveau 2 : dépôt d'automatisations dans Home Assistant (`lire_automatisations_ha`, `deposer_automatisation`, `supprimer_automatisation` ; aperçu puis confirmation, sauvegarde, anti-boucle) | 🟡 — éprouvé avec un faux bus ; pont réel `ia` ↔ `core` ↔ HA et appel depuis Claude Code à vérifier ; ouvert sur ha2 (niveau 2) et sur « dev » (niveau 2 d'essai, ids `test_dev_`) | `fonctionnelles-ia` §19.9 |
| Niveau 1 (dossier de propositions) | ⚪ — sauté : le niveau 2 encadré par aperçu et sauvegarde le remplace | §5 |
| Niveau 3 (cible « Home Assistant » portée par une planification) | ⚪ | §5 |
| Écran Déploiement « Agents des applications » (Claude Code déclaré par `ia`) | ⚪ | `conception-agents-distants-reglages` v1.1 |
| Démarrage automatique de la session après redémarrage de la machine | ⚪ | §2ter, §10 |
| Diffusion de propositions entre sites | ⚪ (idée, hors décision) | §7 |

**Prochaine étape** : l'essai réel du dépôt d'automatisations (ids `test_dev_`, automatisations inoffensives, sur la machine de dév) puis sur ha2 ; noter ce qui manque. Remarque : le dimotic-ha de la machine de développement est branché sur le Home Assistant **réel** de ha2 — tout ce qui s'y fait agit sur la production.

*(Statuts de cette version établis d'après les specs et les commits du Claude Code de développement ; à corriger par l'utilisateur s'ils ne reflètent pas l'usage réel.)*

---

## 1. Objet et décisions

Décisions de l'utilisateur (08/10/2026), dans l'ordre où elles ont été prises :

1. **Un Claude Code par site**, tournant sur la même machine que Home Assistant (§2).
2. Claude Code doit avoir **la même vision du système que Mistral — et davantage** (§3).
3. **Les autorisations sont ouvertes au fur et à mesure des besoins** — jamais d'avance (§5).
4. Une automatisation peut s'exécuter **soit dans le planificateur, soit dans Home Assistant, au choix** (§4).
5. Accès de Claude Code à Home Assistant : **lecture seule** pour l'instant (§6).
6. **Par défaut : Home Assistant**, sur les deux sites. Exception ici : **les planifications basiques dans le
   planificateur**, qui sert de banc d'essai pour le valider (§8).
7. Le Claude Code du site distant **n'existe pas encore** : même modèle, installé plus tard.

## 2. Les sites et leur organisation

Deux sites, distants d'environ 500 km : celui de l'utilisateur (« ici ») et celui de sa fille. **Sur chaque site, une
machine porte Home Assistant, un dimotic-ha et un Claude Code** (dans un `screen`, affiché dans le navigateur par
l'application `screen2http`). Aujourd'hui seul le site « ici » a son Claude Code.

Conséquences :
- **Chaque Claude Code parle à son propre dimotic-ha, en local.** Le serveur MCP (`ia`, spec `fonctionnelles-ia` §19) reste à
  l'écoute sur `127.0.0.1`, avec **son propre jeton** — aucun port ouvert sur le réseau, aucun VPN nécessaire pour cela.
- **Aucun déploiement à travers les 500 km** : chaque Claude Code agit sur sa propre machine. Une erreur reste locale, et
  l'échelle d'autorisations (§5) s'applique site par site.
- **Propre à chaque site** : catalogue quoi/lieux (les entités), planifications, jeton, niveau d'autorisation.
  **Commun** : code de dimotic-ha, règles embarquées, méthode de travail (mises à jour par `git pull` puis build).
- **Piloter un Claude Code à distance** (depuis le téléphone ou la tablette, ou pour celui du site de la fille) : voir §2bis
  — Remote Control, sans accès réseau à l'interface du site.

## 2bis. Piloter Claude Code à distance — Remote Control

**Décision de l'utilisateur (08/10/2026)** : piloter les Claude Code à distance, depuis le téléphone ou la tablette, par
**Remote Control**, plutôt que par un accès réseau (VPN) à l'interface de chaque site.

- **Principe** : la session Claude Code **continue de tourner sur la machine de Home Assistant** ; l'application Claude Code
  (téléphone, tablette, web) la pilote. Lancement, dans un terminal et dans le dossier de travail : `claude remote-control`
  (la forme `/remote…` depuis une session n'a pas été confirmée — seule cette commande figure dans la documentation).
- **Ce qui ne change pas** : Claude Code étant local, le serveur MCP de `ia` reste en `127.0.0.1` ; les permissions, le
  jeton et l'échelle d'autorisations (§5) restent ceux de la machine. La session peut rester dans un `screen`.
- **`screen2http`** reste un second accès (console web dans dimotic-ha), utile en secours ; il n'est plus nécessaire pour
  atteindre le site distant.
- **Limites** : la session s'arrête si la machine est éteinte ou le processus tué ; sur le site distant, un redémarrage
  demande de relancer la commande, sauf démarrage automatique (à prévoir).
- **Sécurité** : quiconque accède au compte Claude de l'utilisateur peut piloter ce Claude Code, donc atteindre les outils
  MCP, `executer_action` compris. Les outils agissants restent en « demander à chaque fois » (§5), **surtout sur le site
  distant** ; les règles de refus des secrets (§6) s'appliquent de la même façon.
- **À vérifier avant de s'y fier** : comment la connexion s'établit entre la machine et l'application (la documentation
  consultée ne le précise pas) — en particulier qu'aucun port n'a à être ouvert sur le site ; la reprise après un
  redémarrage de la machine.

## 2ter. Diffusion et mise en place de Claude Code (⭐ v1.2)

**Décision de l'utilisateur (08/10/2026)** : la mise en place de Claude Code sur une machine relève de dimotic-ha
(écran Déploiement) ; le **jeton Home Assistant direct est conservé** en option, pour les phases de mise au point complexes
où l'on demande à Claude Code de contrôler des résultats directement dans Home Assistant.

**État réel** :
- *Aujourd'hui* : le script « Agent Claude Code » de l'application Outils (`fonctionnelles-outils` §7.4) — dépose,
  installe, lance `claude remote-control` dans un `screen`. Aligné en v1.7 d'Outils sur ces décisions : compte Linux
  dédié sans sudo (refus d'un compte sudo), liaison avec le serveur MCP de dimotic-ha de la machine, permissions posées
  (lecture limitée aux quatre fichiers de configuration, secrets et `.storage` refusés, aucune écriture, confirmation
  d'`executer_action`), jeton Home Assistant et dossier de configuration **facultatifs**.
- *Écran Déploiement « Agents des applications »* (`conception-agents-distants-reglages` §5) : **conçu, pas réalisé**.
  Claude Code y est ajouté (v1.1 de cette conception) comme agent de l'application `ia`.

**Diffusion sur les deux sites** : le même script sert pour chaque machine, avec son **propre** jeton MCP et ses propres
chemins. Rien n'est partagé entre sites sauf le code de dimotic-ha (mises à jour par `git pull` puis build) et le script
lui-même ; les jetons, le catalogue et les permissions sont propres à la machine. Le site distant : même script, plus tard.

**À prévoir quand l'écran Déploiement existera** : déclarer l'agent (machine, version de Claude Code installée, état du
`screen`, niveau d'autorisation), relayer les actions communes par l'application `ia`, et reprendre dans cet écran la
logique du script (qui restera utilisable seul). La session ne redémarre pas toute seule avec la machine : démarrage
automatique à décider.

## 2quater. Le `CLAUDE.md` de l'agent : source unique, versionnée, redéposable (⭐ v1.4)

**Décision de l'utilisateur (08/10/2026)** : le `CLAUDE.md` qui guide le Claude Code de la machine Home Assistant est **mis au point dans
le Claude Code de développement**, **déposé dans le dépôt dimotic-ha pour être embarqué**, et **redéposé sur la machine Home Assistant au fur
et à mesure de sa mise au point**.

- **Source unique** : `applications/ia/agent/claude-md/` — sections `00-role`, `10-dimotic-mcp`, `20-ha-config`, `30-ha-direct`,
  `90-securite`, fichier `VERSION`, `LISEZ-MOI.md`. Avant : texte en dur dans le script Outils, sans version ni spec.
- **Embarqué** : le dossier fait partie du dépôt et de l'image ; le script « Agent Claude Code » le déclare (`@outils:bundle`) et le dépose
  sur la machine.
- **Version visible** : `VERSION` (à incrémenter à chaque modification du texte) figure en première ligne du `CLAUDE.md` rendu — on voit d'un coup
  d'œil si une machine est à jour.
- **Cycle de mise au point** : (1) modifier les sections dans le Claude Code de développement, incrémenter `VERSION`, `git pull`/commit sur
  `main` ; (2) sur la machine d'où l'on pilote, `git pull origin main` ; (3) application Outils → script « Agent Claude Code », mode
  **`mettre_a_jour_claude_md`** → seul le `CLAUDE.md` est réécrit (ni jeton à ressaisir, ni session touchée) ; (4) le prochain démarrage de la
  session Claude Code le prend en compte.
- **Un modèle, des machines** : les sections sont communes aux deux sites ; seuls les valeurs (adresse, dossier de configuration) et le choix
  des sections (MCP relié ? jeton Home Assistant ?) sont propres à la machine, mémorisés dans `agent.conf` (sans secret).
- **À prévoir avec l'écran Déploiement** : comparer la version du modèle à celle lue sur la machine, proposer « Mettre à jour ».
- **Distinct du `CLAUDE.md` de la racine du dépôt**, qui règle le **développement** de dimotic-ha (specs immuables, sauvegardes, build).

## 3. Ce qui existe déjà (livré le 08/10/2026)

Serveur MCP de l'application `ia` (spec `fonctionnelles-ia` v1.20, §19), désactivé par défaut, jeton Bearer obligatoire :

| Capacité | Contenu |
|---|---|
| Mêmes outils que Mistral | `lister_entites`, `obtenir_etat`, `executer_action` (seul outil qui agit) |
| Même vision à la connexion | catalogue quoi/lieux/macros dans les instructions ; ressources `dimotic://catalogue` et `dimotic://regles` |
| Lecture élargie | `obtenir_details` (attributs réels, classement), `diagnostiquer_resolution`, `tester_phrase` (simulation sans exécution) |
| Lecture du planificateur | `lire_planificateur` (statut, planifications, macros, actions reçues, commandes réellement envoyées à HA, YAML) |

Aucun de ces outils n'écrit dans Home Assistant ni ne crée de planification. `executer_action` est le seul qui agit sur la
maison, exactement comme pour Mistral.

## 4. Où exécuter une automatisation : planificateur ou Home Assistant

| | Planificateur | Home Assistant |
|---|---|---|
| Cibles | résolues **dynamiquement** (quoi/lieux) : suit un renommage ou un déplacement d'entité | `entity_id` **figés** à la rédaction : à refaire si les entités changent |
| Robustesse | dépend de dimotic-ha | **autonome** : continue si dimotic-ha ou la connexion tombe |
| Visibilité | interface du planificateur (liste numérotée) | interface Home Assistant et ses outils |
| Macros, aléatoire, condition en texte libre | natifs | à traduire (scripts, templates), parfois imparfaitement |

**Règle par défaut** : Home Assistant — a fortiori sur le site distant, où l'on ne peut pas intervenir : la maison doit
continuer à fonctionner seule. **Exception** : les planifications basiques ici (§8).

Deux lectures possibles de « au choix » :
1. **Deux chemins séparés** : Claude Code rédige pour Home Assistant, ou crée une planification via le planificateur.
   C'est le point de départ retenu.
2. **Une description, deux cibles** : la structure du planificateur (déclencheur, conditions, actions, macros) reste la
   source, et une « cible d'exécution » par planification (`planificateur` par défaut, ou `home_assistant`) fait générer
   l'automatisation Home Assistant. **Non retenu à ce stade** ; à n'envisager que si le besoin se confirme. Garde-fous à
   prévoir alors : une seule cible active à la fois (jamais deux copies), marque « géré par dimotic » dans Home
   Assistant, régénération quand les entités changent, détection d'une modification manuelle dans Home Assistant plutôt
   qu'un écrasement.

## 5. Échelle d'autorisations

Chaque niveau est ouvert **sur décision de l'utilisateur, site par site**, jamais par défaut :

| Niveau | Claude Code peut… | Statut |
|---|---|---|
| 0 | lire Home Assistant et dimotic-ha ; proposer des automatisations en texte | **en place** |
| 1 | déposer ses propositions dans un dossier réservé côté dimotic (jamais dans Home Assistant) | **sauté** (v1.5) — remplacé par le niveau 2 encadré |
| 2 | déployer dans Home Assistant par un outil de dimotic : sauvegarde préalable, validation de la configuration, confirmation de l'utilisateur, rechargement | **outils livrés** (`fonctionnelles-ia` §19.9) ; ouvert site par site : ha2 = niveau 2, dev = niveau 2 d'essai |
| 3 | cible « Home Assistant » portée directement par une planification (§4, lecture 2) | à n'envisager que si nécessaire |

Les autorisations se règlent à deux endroits : côté **Claude Code** (permissions de fichiers et d'outils MCP) et côté
**dimotic** (jeton, outils exposés). Les outils agissants (niveau 2 et suivants) devront demander confirmation.

## 6. Lecture seule : ce qui est lu, ce qui est interdit

Claude Code est sur la même machine que Home Assistant : il peut lire les fichiers de configuration. **Lecture seule ne
veut pas dire inoffensif** — le dossier de configuration contient des secrets.

- **Autorisé en lecture** : `automations.yaml`, `scripts.yaml`, `scenes.yaml`, `configuration.yaml`.
- **Interdit, y compris en lecture** : `secrets.yaml` et le dossier `.storage` (jetons d'accès, authentification).
- À régler dans les permissions de Claude Code **sur chaque machine** (règles de refus explicites).
- Variante sans aucun accès fichiers : un outil `lire_automatisations_ha` côté dimotic, qui interroge Home Assistant par
  son interface (à vérifier : les droits de la connexion actuelle de dimotic-ha à Home Assistant). Confort plutôt que
  nécessité, puisque Claude Code est local sur chaque site.

## 7. Rédiger une automatisation Home Assistant

Flux retenu au niveau 0 : l'utilisateur décrit le besoin ; Claude Code
1. lit l'existant (automatisations Home Assistant, `lire_planificateur`) pour éviter les doublons ;
2. identifie les **vrais** `entity_id` (`obtenir_details`, `diagnostiquer_resolution`) ;
3. rédige l'automatisation en YAML et la **propose** à l'utilisateur ;
4. l'utilisateur relit et l'applique lui-même.

Une automatisation destinée à l'autre site est rédigée avec le catalogue **de ce site** : ses entités diffèrent. Idée pour
plus tard (hors décision) : faire voyager une proposition comme fichier entre les deux dimotic-ha par le mécanisme de
diffusion des données entre machines (`techniques-diffusion-data_specs`), relue puis appliquée par le Claude Code local.

## 8. Le planificateur, banc d'essai

Ici, **les planifications basiques** (heure fixe, récurrence simple, délai) restent dans le planificateur : leur usage
réel valide le planificateur avant de lui confier davantage. À observer, avec `lire_planificateur` : déclenchement à
l'heure, commandes réellement envoyées (`commandes_ha`), anomalies, reprise après redémarrage. Critère de confiance à
fixer par l'utilisateur (§10) avant d'élargir son périmètre.

## 9. Specs et code impactés

Rien d'impacté tant que l'on reste au niveau 0. Selon les niveaux ouverts : `fonctionnelles-ia` (nouveaux outils MCP,
§19), `fonctionnelles-planificateur` (si cible Home Assistant), `techniques-socle-ha-mqtt` (si lecture/écriture
Home Assistant par le socle), `PROMPT_PROJET` §11 (table de correspondance, à étendre à cette spec).

## 10. Points ouverts

1. **Remote Control** (§2bis) : vérifier le mode de connexion réel (aucun port à ouvrir ?) et la reprise après redémarrage de
   la machine ; décider si `executer_action` doit rester en confirmation systématique sur tout accès à distance.
2. *(traité en v1.5 : le dépôt passe par le pont REST du core, `HaRestBridge` — `fonctionnelles-ia` §19.9 ; l'agent n'a pas besoin d'un jeton en écriture ; à vérifier en réel)* **Droits de la connexion dimotic-ha → Home Assistant** : suffisent-ils pour lire (et plus tard écrire) des
   automatisations ?
3. **Critère de validation du planificateur** : combien de temps / quels cas avant d'élargir son rôle ?
4. **Niveau 1** (dossier de propositions) : emplacement, format, revue.
5. **Sauvegarde et retour arrière** avant tout écriture dans Home Assistant (niveau 2).
6. **Diffusion de propositions entre sites** : utile ou superflu ?

## 11. Plan de mise en œuvre

1. *(fait)* Serveur MCP et outils de lecture (spec `ia` §19).
2. Règles de permissions de Claude Code (lecture limitée aux fichiers utiles, refus des secrets), sur chaque machine.
3. Usage réel au niveau 0 ; noter les manques constatés.
4. Selon ces manques : outil `lire_automatisations_ha`, puis niveau 1, puis niveau 2.
5. *(fait, non éprouvé sur machine)* Script « Agent Claude Code » aligné (§2ter). Installation du Claude Code du site
   distant avec ce script, jeton et permissions propres, lancé en Remote Control (§2bis) ; essai réel du script ici d'abord.
6. Déclarer Claude Code comme agent de `ia` dans l'écran Déploiement quand celui-ci existera ; démarrage automatique de la session.

## 12. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.5 | 08/10/2026 | Claude | **État d'avancement mis à jour** (§0, §5, §10) d'après les commits du Claude Code de développement : outils MCP de dépôt d'automatisations (niveau 2), CLAUDE.md v1.2.1 + sections de site, `claude-screen-dev.sh`, MCP et lecture éprouvés en réel. v1.4 archivée. |
| 1.4 | 08/10/2026 | Claude | **Le `CLAUDE.md` de l'agent = modèle versionné du dépôt** (§2quater) : source unique, embarqué, version visible, mode de mise à jour sans réinstallation. v1.3 archivée. |
| 1.3 | 08/10/2026 | Claude | **§0 État d'avancement** (fait / éprouvé / seulement spécifié). v1.2 archivée. |
| 1.2 | 08/10/2026 | Claude | **Diffusion et mise en place** (§2ter) : script Outils aligné (compte dédié, MCP, permissions, jeton Home Assistant facultatif **conservé**), écran Déploiement toujours à réaliser, Claude Code ajouté aux agents. v1.1 archivée. |
| 1.1 | 08/10/2026 | Claude | **Remote Control** (§2bis) : pilotage à distance des Claude Code depuis téléphone/tablette, à la place d'un VPN vers l'interface de chaque site ; vérifications à faire (§10) ; v1.0 archivée. |
| 1.0 | 08/10/2026 | Claude | Version initiale — conception issue des échanges du 08/10/2026 (aucun code nouveau). |
