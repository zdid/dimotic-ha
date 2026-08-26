# Spécifications Fonctionnelles — Application IA

**Version :** 1.10
**Date :** 26 Août 2026
**Statut :** Document de référence pour l'application `applications/ia`

> **v1.10** : **Interpréteur déterministe français** (§16, nouveau, conception validée en session,
> implémentation en cours) — reprend la logique de l'ancien moteur `zdidnodedomotext`
> (`interpretetext.js`/`modelesv2.js`, prédécesseur pré-dimotic-ha), réécrite en TypeScript, débarrassée
> de son défaut connu de découpage de phrases, et convergeant vers les structures déjà produites par
> Mistral (`ExecuterActionParams`, `PlanificationDefinition`/trigger, `MacroDefinition`/`macro_ref`) —
> pas un nouveau format. S'exécute en pré-filtre avant tout appel Mistral dans `handleChat()` (§9) :
> si la phrase est reconnue avec confiance, exécution directe sans aller-retour Mistral (gain de
> latence/coût sur les tournures courantes — "allume le salon"), sinon repli intégral et inchangé sur
> le chemin Mistral existant. Vocabulaire et gabarits externalisés dans des fichiers YAML éditables à
> chaud (même convention que `regles_mistral.txt`, §5), pas de code en dur. Nouveau gabarit
> événementiel `si_alors` (absent du legacy) ciblant directement `trigger.type: 'state_change'`
> (`fonctionnelles-planificateur_specs`, `StateWatcher.ts`), déjà en production côté `planificateur`.

> **v1.9** : **Comparatif multi-modèles** (§14, nouveau) — `ia` peut désormais interroger jusqu'à 4
> modèles (Mistral Small/Medium, Claude Haiku/Sonnet via la couche de compatibilité OpenAI
> d'Anthropic, §14.2) sur la même phrase, en parallèle, **toujours en dry-run strict** (§14.3,
> jamais de transmission à `planificateur`, quel que soit le fournisseur actif) — outil
> d'observation, jamais une action. **Vérification post-décision des références quoi/lieux/
> entity_id** (§8.2/§14.4, nouveau module `referenceValidator.ts`) : tout JSON structuré (et pas
> seulement l'action immédiate du §8.1) est désormais vérifié contre le référentiel HA réel avant
> transmission à `planificateur` — "d'où qu'il vienne" (`IaService` et `DeployResponder`, §10) ;
> une référence invalide déclenche une relance forcée, puis un refus explicite avec demande de
> correction si le problème persiste, plutôt qu'une planification silencieusement inopérante.
> **Étude comparative du 12/08/2026 sur 30 cas** (§14.6) : Mistral Small confirmé comme fournisseur
> actif (§12) — meilleur rapport latence/coût/fiabilité pour l'usage domotique réel.

> **v1.8** : **Deux correctifs anti-hallucination** contre les faux refus "quoi_introuvable"
> constatés en direct ("allume la salle", une area réelle à 4 lumières, refusée à tort). (1)
> **Catalogue quoi/lieux statique injecté dans le prompt système** (§5, nouveau) — `RulesProvider`
> ajoute désormais à la suite de `regles_mistral.txt` une liste stable des `quoi`/lieux connus
> (`HaStructureRegistry.getQuoiCatalog()`/`getLieuCatalog()`, voir `techniques-socle-ha-mqtt_specs`
> §8.3.3), pour que Mistral dispose d'une vérité de terrain sans aller-retour d'outil. (2) **Relance
> forcée `tool_choice=any`** (§8, nouveau) — filet de sécurité résiduel : si Mistral répond malgré
> tout "quoi_introuvable" sans avoir appelé le moindre outil, `IaService` relance une seule fois ce
> round en forçant l'usage d'un outil. Les deux mécanismes sont complémentaires et se sont avérés
> nécessaires en pratique (voir §5/§8 pour le détail et les résultats mesurés en direct).

> **v1.7** : `lister_entites`/`obtenir_etat` délèguent désormais leur résolution `quoi`/`lieux` au
> graphe de lieux centralisé de `HaStructureRegistry` (§7, voir `techniques-socle-ha-mqtt_specs`
> §8.3.2) plutôt qu'une résolution propre à `ToolExecutor.ts` limitée aux seules areas HA, sans
> repli. `regles_mistral.txt` enrichi (`lieu_pere` par entité en plus de `lieu_precis`, résolution
> numéro→planification pour la gestion) — voir `fonctionnelles-planificateur_specs` v1.7 pour le
> détail côté résolution d'action.

> Conforme à `techniques-socle-ha-mqtt_specs` (architecture 5 couches, EventBus),
> `nommage_specs` (taxonomie QUOI/OÙ), `guide-nouvelle-application_specs`. À lire avec
> `fonctionnelles-planificateur_specs`, l'application complémentaire avec laquelle `ia` communique.

## 1. Contexte

`applications/ia` émule le protocole HTTP d'**Ollama** (serveur d'inférence local pour grands
modèles de langage) afin que l'intégration Ollama native de Home Assistant puisse s'y adresser
sans rien savoir de plus — HA pense parler à un modèle local. Selon la phrase reçue, la
conversation est soit routée vers un fournisseur d'IA généraliste (§6), soit traitée par le
domaine domotique : relayée vers l'API cloud de **Mistral**, avec accès à un jeu d'outils
(§7) que `ia` déclare lui-même et dont il exécute la partie lecture directement, la partie action
via `applications/planificateur` (le seul point d'exécution du système, voir
`fonctionnelles-planificateur_specs` §6).

`type: 'standalone'`, `requiredMqtt: false`, **`requiredHaWs: true`** — `ia` a un accès **en
lecture seule** à `HaStructureRegistry` (le référentiel HA du socle, injecté et partagé entre
applications, déjà utilisé simultanément par plusieurs autres apps comme ArbreOùQuoi/Nommage) —
pour résoudre localement les outils de lecture (§7) sans aller-retour vers `planificateur`. Toute
**action réelle** sur HA, en revanche, reste exclusivement du ressort de `planificateur` (principe
du point d'exécution unique, voir `fonctionnelles-planificateur_specs` §6).

## 2. Le protocole Ollama émulé

Serveur HTTP dédié (port configurable, défaut `11434` — le port standard d'Ollama), indépendant du
port web du socle (`8080`) : même contrainte technique que le serveur HTTP dédié d'AREXX (mode
push), un module métier peut gérer son propre serveur HTTP en plus de celui du socle.

| Méthode | Route | Rôle |
|---------|-------|------|
| GET | `/`, `/api/version` | Handshake — identification de version |
| GET | `/api/tags` | Liste des modèles exposés (voir §3) |
| POST | `/api/show` | Détails d'un modèle |
| POST | `/api/chat` | **Route principale** — conversation, streaming NDJSON |
| POST | `/api/generate` | Ancien format Ollama, délégué à `/api/chat` (voir §4) |
| POST | `/api/embeddings` | Stub (non exploité par ce projet) |
| GET | `/api/ps` | Modèles "en mémoire" (toujours vide — pas de notion de chargement ici) |
| DELETE | `/api/delete` | No-op (répond succès) |
| POST | `/api/pull` | No-op (répond succès, pas de téléchargement réel) |

## 3. Le client Mistral

Chaque modèle "Ollama" exposé (`/api/tags`) correspond à un modèle Mistral réel via une table de
correspondance configurable (ex: `mistral` → `mistral-small-latest`). Le modèle par défaut est
utilisé si le nom demandé par HA n'a pas de correspondance connue.

Les options de génération transmises par HA au format Ollama (`temperature`, `top_p`, `num_predict`,
`seed`) sont traduites vers leur équivalent Mistral (`temperature`, `top_p`, `max_tokens`,
`random_seed`).

La réponse de Mistral (streaming SSE, `data: {...}` par ligne) est retranscrite en flux NDJSON au
format Ollama attendu par HA — chunks de contenu partiel (`done: false`) puis chunk final
(`done: true`, compteurs de tokens). Les appels d'outils (`tool_calls`) présentent des difficultés
d'assemblage spécifiques (§4) et suivent leur propre boucle de traitement complète (§8) — ils ne
sont **jamais** un simple relais passif vers HA (voir §9 pour la distinction avec l'action
immédiate historiquement décrite comme telle).

**⭐ v1.6 — Débit du plan Mistral (`RateLimiter.ts`, module générique réutilisable pour un autre
fournisseur/modèle à l'avenir)** : chaque modèle Mistral a ses propres limites de débit sur un même
compte (constaté par l'utilisateur : `mistral-small-latest` 1,67 req/s / 100k tokens/min,
`mistral-large-latest` 0,25 req/s / 400k tokens/min) — `MistralClient` maintient un `RateLimiter`
par modèle (config `mistralRateLimits`, un record non exposé dans l'UI générique, comme
`modelMap` — éditable dans `data/ia/config.yaml`) :
- **Throttling préventif** : espace les requêtes sortantes selon la limite de requêtes/seconde du
  modèle, et retarde une requête si le budget de tokens glissant sur 60s (déjà consommé par les
  requêtes précédentes) est épuisé — ne peut être qu'à moitié préventif : le coût réel d'une
  requête n'est connu qu'après réception de la réponse (`recordTokenUsage()`, appelé par
  `IaService`/`DeployResponder` une fois le flux entièrement consommé), jamais avant l'envoi.
- **Backoff réactif sur 429** : si le rate limit est quand même atteint, `MistralClient` retente
  automatiquement avec un délai exponentiel (1s, 2s, 4s, 8s, 16s, 32s, plafonné à 60s), jusqu'à 6
  nouvelles tentatives avant d'abandonner avec un message clair destiné à l'utilisateur ("Mistral a
  atteint sa limite de requêtes... Réessaie dans quelques instants.") plutôt que le message
  technique brut de l'API.
- Un modèle non présent dans `mistralRateLimits` retombe sur le profil le plus restrictif connu,
  par prudence.
- **Tokens consommés affichés par appel** (demande utilisateur) : `promptTokens`/`completionTokens`
  cumulés sur tous les rounds Mistral d'un même échange (une boucle d'appels d'outils enchaîne
  plusieurs appels, §8) — affichés sur le journal des échanges et le résultat du test manuel (§13).

**⭐ v1.9 — Cache de prompt Mistral** : le préfixe du message système (`regles_mistral.txt` + le
catalogue quoi/lieux du §5) est identique d'un appel à l'autre tant que le matériel HA ne change
pas — `MISTRAL_PROMPT_CACHE_KEY` (constante stable, `'dimotic-ha-ia'`) est transmise à chaque appel
Mistral (`IaService.runChatRounds()` et `DeployResponder`, §10) via le paramètre `prompt_cache_key`
de l'API. Vérifié en direct contre l'API réelle : premier appel avec cette clé → `cached_tokens: 0`
; second appel, même contenu, même clé → ~99% du prompt système servi depuis le cache (11232/11263
tokens constatés), facturé à 10% du tarif normal ; sans la clé, même contenu strictement identique
→ aucun cache (confirmé, pas un effet automatique de l'API). `cachedTokens` remonté de bout en bout
(`MistralClient` → journal des échanges, §13).

**⭐ v1.9 — Généralisation à un second fournisseur (Claude, comparatif §14)** : `MistralClient`
accepte désormais un `providerOverride` optionnel sur `resolveModel()`/`streamChat()`, indépendant
du fournisseur actif en config (§12) — permet d'interroger un fournisseur précis pour un appel
donné (utilisé par le comparatif, §14, jamais par le flux domotique normal qui suit toujours le
fournisseur actif). Repose sur la couche de compatibilité OpenAI d'Anthropic (§14.2) : même client
HTTP, seuls `base_url`/clé/modèle changent selon le fournisseur. `prompt_cache_key` n'est **jamais**
transmis en mode Anthropic — le mécanisme de cache de Claude est différent et son exposition via
cette couche de compatibilité n'est pas confirmée.

## 4. Difficultés protocolaires connues

Points de vigilance identifiés lors de la mise au point d'un premier émulateur Ollama→Mistral,
à ne pas redécouvrir par erreur lors de l'implémentation :

- **Mistral entoure parfois son JSON de balises markdown** (```` ```json ... ``` ````) même quand le
  prompt système demande explicitement de ne renvoyer que du JSON brut. La détection de JSON
  structuré (§9) doit défensivement retirer ces balises avant toute tentative de parsing — sinon un
  JSON par ailleurs valide est silencieusement traité comme une réponse conversationnelle libre.

- **Les appels d'outils (`tool_calls`) arrivent fragmentés sur plusieurs chunks du flux streamé** —
  Mistral transmet les arguments d'un appel d'outil par petits fragments successifs (pas un JSON
  complet en un seul chunk). Il faut accumuler ces fragments par index tout au long du flux et ne
  tenter le parsing JSON qu'une fois le flux entièrement reçu — un parsing fragment par fragment
  échoue systématiquement, le JSON n'étant valide qu'une fois complètement reconstitué.

- **Deux formats de requête à réconcilier** : l'ancien `/api/generate` d'Ollama envoie `system` et
  `prompt` comme deux champs séparés au niveau racine, le `/api/chat` actuel envoie un tableau
  `messages`. La construction des messages envoyés à Mistral doit gérer les deux formes sans
  dupliquer ni perdre le message système — injecter un `system` manquant sans écraser celui déjà
  présent si `messages` en contient déjà un.

- **Un signal interne au flux de traitement ne doit jamais fuiter vers HA** : si l'implémentation
  utilise un mécanisme de signal de fin interne (texte complet assemblé + tool_calls, pour décider
  du routage vers `planificateur`) transitant par le même canal que les chunks NDJSON réels, ce
  signal doit être filtré avant l'envoi effectif à HA — sinon le flux NDJSON reçu par HA est
  corrompu par une ligne qu'il ne sait pas interpréter.

- **En-tête anti-buffering nécessaire sur la réponse streamée** — sans un en-tête empêchant
  explicitement la mise en tampon (équivalent de `X-Accel-Buffering: no`), un serveur/proxy
  intermédiaire peut retenir tout le flux au lieu de le laisser passer token par token, annulant
  l'effet temps réel attendu par HA pendant la synthèse vocale progressive.

- **En cas d'erreur de l'API Mistral (statut HTTP ≠ 200)** : lire le corps d'erreur complet plutôt
  que d'essayer de le streamer, et fabriquer un chunk d'erreur au format Ollama attendu par HA —
  ne jamais propager la forme brute de l'erreur Mistral telle quelle, HA ne saurait pas
  l'interpréter dans le flux NDJSON attendu.

## 5. Les règles domotiques (prompt système)

Un fichier local à l'application (`applications/ia/rules/regles_mistral.txt`) est injecté en fin de
prompt système à chaque appel à Mistral — s'il existe déjà un message `system` dans la conversation,
les règles y sont ajoutées ; sinon un message `system` dédié est créé.

Le fichier est **rechargé à chaud** (surveillance du fichier) plutôt que lu une seule fois au
démarrage — permet d'itérer sur son contenu sans redémarrer le service. Le contenu exact du prompt
(résolution du QUOI/OÙ par défaut, classification des requêtes, format JSON attendu, règles de
déploiement à l'exécution — y compris, depuis le 03/08/2026, la description du déclencheur réactif
`state_change`, voir `fonctionnelles-planificateur_specs` §3.2) est un sujet à part entière, non
couvert par cette spec, qui évolue indépendamment de l'architecture technique décrite ici.

**⭐ v1.8 — Catalogue quoi/lieux statique injecté à la suite des règles** : contrairement au texte
de `regles_mistral.txt` ci-dessus, ce mécanisme **relève bien du code** (`RulesProvider.inject()`,
`applications/ia/src/domain/rules.ts`) et est donc couvert par cette spec. Idée utilisateur : les
catalogues `quoi` (types d'appareils) et `lieux` (tous niveaux — `lieu_precis`/`lieu`/`lieu_pere`/
`lieu_grand_pere`) sont quasi statiques, ne changeant qu'à l'ajout/modification/suppression de
matériel — contrairement à `entities_snapshot` (état vivant, reconstruit à chaque appel, §7). Rien
n'empêchait de les transmettre une bonne fois pour toutes à Mistral plutôt que de compter sur lui
pour deviner ce qui existe.

`RulesProvider` accepte désormais un `HaStructureRegistry` optionnel en 3ème paramètre de
constructeur (câblé dans `IaService` : `new RulesProvider(this.resolveRulesPath(), this.logger,
this.haStructureRegistry)`) ; sans lui, le catalogue n'est simplement pas injecté (comportement
antérieur inchangé). Quand présent, `inject()` construit un bloc de texte
(`getQuoiCatalog()`/`getLieuCatalog()`, voir `techniques-socle-ha-mqtt_specs` §8.3.1/§8.3.3) et
l'ajoute à la suite du contenu de `regles_mistral.txt` dans le message system, **à chaque appel** —
contenu identique tant que le matériel ne change pas, donc même bénéfice de cache de prompt côté
Mistral que le reste du message system.

**Effet mesuré en direct** : "allume la salle" (précédemment refusé à tort par un
`quoi_introuvable` halluciné, §8) se résout désormais correctement dès le premier round, sans avoir
besoin de la relance forcée décrite en §8. Les deux mécanismes restent complémentaires : le
catalogue évite l'essentiel des faux refus, la relance forcée reste un filet de sécurité résiduel
pour les cas où Mistral n'en tiendrait quand même pas compte.

## 6. Routage multi-IA

Avant même d'atteindre le domaine domotique, chaque phrase transcrite par le pipeline Assist de HA
passe par une étape de routage pur (pas de logique métier d'interprétation à ce niveau) :

1. **Extraction du premier mot de la phrase.**
2. **Mot-clé IA généraliste reconnu en première position** (`claude`, `gemini`, `chatgpt` — table
   extensible) → route vers le fournisseur correspondant, ouvre ou poursuit une session dédiée à ce
   fournisseur. La conversation devient alors une **conversation libre**, hors du domaine
   domotique — les outils décrits en §7 ne sont **jamais** transmis à un fournisseur autre que
   Mistral, seul celui-ci reste sollicité pour le domotique.
3. **Mot-clé domotique reconnu** (`domotique`/`dimotic`) **ou aucun mot-clé reconnu** → route vers
   Mistral et le traitement domotique (§7 à §10).
   - Si Mistral/le traitement domotique signale une commande "non comprise" : si une IA
     généraliste était déjà active dans la session → reroute la phrase vers cette IA ; sinon →
     renvoie telle quelle la réponse fournie (jamais de repli implicite vers une IA par défaut).
4. **Mot-clé "au revoir"** détecté → clôture la session active, retour à l'état neutre (la phrase
   suivante est de nouveau évaluée selon les règles 2/3 ci-dessus).

Une **session** associe un fournisseur actif (ou aucun) à une conversation, garde un historique
d'échanges pour la continuité de contexte, et une clé d'identification stable par device/satellite
Assist. **Point non résolu à ce stade** : la source exacte de cette clé — vérifier si l'agent de
conversation Ollama de HA transmet un identifiant stable et distinct par satellite (`conversation_id`,
`device_id` ou équivalent) ; ces vérifications n'ont pour l'instant été faites qu'en conditions
réelles avec du matériel vocal (pas seulement l'interface web HA). Solution de repli envisagée si
aucun identifiant fiable n'est disponible côté intégration Ollama de HA : un point d'entrée dédié
remplaçant cette intégration native — non retenue à ce stade, gardée en réserve.

Chaque fournisseur d'IA généraliste nécessite sa propre clé d'API, transmise dans un en-tête propre
à son API (`x-api-key` pour Claude, `x-goog-api-key` pour Gemini, `Authorization: Bearer` pour
Mistral et ChatGPT — quatre conventions différentes, aucune n'étant une signature cryptographique,
simplement une clé statique par service).

**⭐ v1.9 — À ne pas confondre avec le comparatif (§14)** : ce routage multi-IA reste non
implémenté (points ouverts ci-dessus). Le comparatif multi-modèles introduit en §14 est un
mécanisme **différent et plus simple**, déjà implémenté : un seul fournisseur/modèle actif à la
fois pour tout le domaine domotique (§12), pas de session par device ni de conversation libre hors
domotique — juste un outil de test qui interroge plusieurs modèles en parallèle, en dry-run, pour
comparer leurs décisions sans jamais les rendre actifs.

## 7. Outils mis à disposition de Mistral

Seul Mistral (traitement domotique) reçoit des outils — jamais les fournisseurs d'IA généraliste
du §6 (conversation libre, hors domotique). Plutôt qu'un outil par service HA (qui exploserait en
nombre), un petit jeu **fixe et générique**, paramétré avec le même vocabulaire QUOI/OÙ que le
reste du système :

| Outil | Paramètres | Rôle |
|-------|-----------|------|
| `lister_entites` | `quoi?`, `lieux?` (les deux optionnels) | Liste les entités connues correspondant au filtre |
| `obtenir_etat` | `quoi`, `lieux` | État actuel d'une ou plusieurs entités correspondant au filtre |
| `executer_action` | `verbe`, `quoi`, `lieux`, `valeur?` | Action domotique immédiate — mêmes champs que `ActionNode` (`fonctionnelles-planificateur_specs` §2), aucun nouveau format |

La liste des outils (schéma JSON complet par outil, format attendu par l'API de function-calling de
Mistral) est stockée en code TypeScript (ex: `applications/ia/src/domain/tools.ts`), **pas** dans
`regles_mistral.txt` : c'est un contrat structurel strict — un schéma malformé ferait rejeter la
requête par l'API Mistral, contrairement au texte des règles qui tolère l'imprécision. La liste
reste petite et fixe puisque les outils sont génériques : pas besoin de la régénérer à chaque
nouvelle entité HA.

**⭐ v1.7** — `lister_entites`/`obtenir_etat` résolvent leur filtre `quoi`/`lieux` via
`HaStructureRegistry.getEntitiesByQuoiAndLieux()` (`ToolExecutor.ts`, voir
`techniques-socle-ha-mqtt_specs` §8.3.2 pour le mécanisme complet) — même graphe de lieux que
`executer_action` côté `planificateur` (§7, `fonctionnelles-planificateur_specs` §7), pour un
comportement de résolution identique quel que soit l'outil appelé. Remplace une résolution propre à
`ToolExecutor.ts` qui ne comparait qu'aux areas HA, sans aucun repli — plus limitée que celle de
`planificateur` avant même la v1.6 de ce dernier, jamais documentée comme telle.

## 8. Boucle d'exécution des outils

Contrairement à un simple relais, un appel d'outil déclenche un aller-retour complet avec Mistral
avant de produire la réponse finale envoyée à HA :

1. Mistral (dans sa réponse streamée) appelle un ou plusieurs outils du §7.
2. `ia` exécute chaque appel :
   - **`lister_entites`/`obtenir_etat`** (lecture) : résolus **localement**, directement depuis
     `HaStructureRegistry` (§1) — pas de sollicitation de `planificateur`.
   - **`executer_action`** (action) : transmis à `planificateur` via une requête interne
     (`ia:tool:execute`, voir §11) — c'est `planificateur` qui résout l'intention (`verbe`/`quoi`/
     `lieux`) vers un appel de service HA réel et l'exécute (voir `fonctionnelles-planificateur_specs`
     §7).
3. Le résultat de chaque outil est réinjecté dans la conversation comme un nouveau message (rôle
   `tool`, associé à l'identifiant de l'appel).
4. Mistral est rappelé avec ces résultats pour produire sa réponse finale — ou, le cas échéant,
   enchaîner d'autres appels d'outils (la boucle 1-4 peut se répéter).
5. Seule la réponse finale (texte) est streamée vers HA — les échanges intermédiaires (appels
   d'outils, résultats) restent internes à `ia`/`planificateur`, jamais visibles de HA.

### 8.1 ⭐ Relance forcée anti-hallucination — `tool_choice=any` (nouveau v1.8)

Filet de sécurité résiduel contre un motif d'hallucination précis, constaté en conditions réelles :
"allume la salle" (une area HA réelle, 4 lumières) refusé à tort par Mistral avec un JSON
`{"error":"quoi_introuvable",...}` — la règle §0.4 de `regles_mistral.txt` impose explicitement de
vérifier via `lister_entites`/`obtenir_etat` avant de conclure à cette erreur ("jamais par simple
supposition"), mais les logs serveur confirmaient qu'aucun outil n'avait été appelé dans l'échange
concerné. Le catalogue quoi/lieux du §5 (v1.8 également) réduit fortement la fréquence de ce motif,
mais ce filet reste utile en repli.

**Mécanisme** : `MistralClient.streamChat()` accepte désormais un 5ème paramètre optionnel,
`toolChoice?: 'any'`, transmis à l'API Mistral comme `tool_choice` (force l'usage d'un des outils
déclarés plutôt qu'une réponse texte directe). **Jamais la valeur par défaut sur tous les rounds** :
forcer un outil systématiquement empêcherait Mistral d'atteindre le round final texte/JSON dont
planification/gestion/macro ont besoin (§9) — aucun de ces cas n'appelant jamais d'outil, ils
échoueraient avec "trop d'appels d'outils enchaînés" une fois `MAX_TOOL_ROUNDS` atteint.

`IaService.runChatRounds()` détecte le motif précis via une fonction dédiée,
`isUnverifiedQuoiIntrouvable()` : la réponse assemblée du round contient
`"error":"quoi_introuvable"` (peu importe qu'elle soit enrobée de balises markdown ou de texte libre
autour) **alors qu'aucun outil n'a été appelé dans tout l'échange**, pas seulement ce round. Si le
motif est détecté, `IaService` relance **une seule fois** ce round avec `tool_choice="any"` forcé
(drapeau **`verificationRetried`** — renommé depuis `quoiIntrouvableRetried` en v1.9, ce même
drapeau étant désormais partagé avec la vérification du §8.2 ci-dessous ; jamais deux fois de suite
pour ce même échange — pas de boucle possible si Mistral persiste malgré tout).

**Testé en direct (3/3)** : Mistral vérifie désormais réellement avant de conclure — soit il exécute
l'action après levée d'ambiguïté, soit il demande une clarification légitime (plusieurs lumières
trouvées), mais ne refuse plus jamais sans avoir vérifié. Aucune régression constatée sur l'action
directe ni sur la création de planification (aucun outil forcé sur ces flux, vérifié).

**⭐ v1.9 — `tool_choice` traduit selon le fournisseur** : `'any'` est le nom Mistral pour "force un
outil" — la vraie norme OpenAI (que la couche de compatibilité d'Anthropic applique strictement)
attend `'required'`, pas `'any'`. Mistral accepte `'any'` en pratique (vérifié en direct), mais
Claude rejetait la requête entière avec un 400 (`"Input should be 'auto', 'required' or 'none'"`) —
bug réel constaté dès la première fois que la relance forcée s'est déclenchée côté Claude (via le
comparatif, §14). `MistralClient.streamChat()` traduit désormais automatiquement selon le
fournisseur effectif de l'appel.

### 8.2 ⭐ Vérification post-décision des références quoi/lieux/entity_id (nouveau v1.9)

Le filet de sécurité du §8.1 ne couvre qu'un motif textuel précis (`"quoi_introuvable"` non
vérifié) sur le chemin de l'action immédiate. Rien ne vérifiait, jusqu'ici, qu'un couple `quoi`/
`lieux` ou qu'un `entity_id` de déclencheur `state_change` **à l'intérieur d'un JSON structuré**
(planification/macro/condition/sequence/execution, §9) corresponde réellement à une entité HA —
constaté en conditions réelles (comparatif §14) : sur une planification à déclencheur d'état
("quand la porte d'entrée s'ouvre...", "si la température dépasse..."), Mistral pouvait produire un
`entity_id` plausible mais inexistant (ex: `sensor.salon_temperature`) sans jamais appeler
`lister_entites`/`obtenir_etat` pour vérifier — la planification créée ne se déclenchait alors
jamais, en silence.

**Mécanisme** (`applications/ia/src/domain/referenceValidator.ts`, `validateReferences(data,
registry)`) : parcourt récursivement tout JSON structuré à la recherche de couples `{quoi, lieux}`
et de `trigger.entity_id` (quand `trigger.type === 'state_change'`), et vérifie chacun contre
`HaStructureRegistry` (même mécanisme de résolution que le §7 pour `quoi`/`lieux` ; `getEntity()`
pour un `entity_id`). Une référence invalide déclenche la **même relance forcée** que le §8.1
(drapeau `verificationRetried` partagé — un seul essai de rattrapage par échange, tous motifs
confondus). Si le problème persiste après cet essai, `IaService` **ne transmet pas** le JSON à
`planificateur` : elle répond directement avec un message invitant à préciser/reformuler
(`buildCorrectionRequestMessage()`), plutôt que de créer une planification silencieusement
inopérante.

**Appliqué "d'où qu'il vienne"** (demande utilisateur explicite) : la même vérification s'applique
à `DeployResponder` (§10, réinterprétation à l'exécution) — sans boucle de relance possible ici
(aller-retour unique, pas une boucle d'outils comme `runChatRounds()`) : une référence invalide y
fait simplement échouer la réponse (`success: false`) avec le même message de correction, plutôt
que de transmettre une étape sur une entité inventée.

**Gap trouvé et corrigé le 12/08/2026** : cette vérification ne couvrait initialement que le JSON
structuré final, pas l'appel d'outil `executer_action` lui-même (§7/§8) — en dry-run (§14.3),
`ToolExecutor` répondait toujours "succès" sans jamais vérifier si `quoi`/`lieux` résolvaient
réellement. Constaté concrètement lors de l'étude du §14.6 (phrase "baisse le volet de la cuisine"
— aucun volet roulant en cuisine — deux modèles sur quatre répondaient "action réussie" sans avoir
vérifié, contre un troisième qui avait correctement interrogé `lister_entites` et refusé).
`ToolExecutor.execute()` en dry-run résout désormais `quoi`/`lieux` via le même mécanisme que
`lister_entites`/`obtenir_etat` avant de répondre — succès uniquement si au moins une entité
correspond.

**Traçabilité dans le comparatif** (§14) : chaque résultat porte un indicateur `corrected` (issu de
`verificationRetried`) — distingue une décision juste "du premier coup" d'une décision qui n'est
correcte *que* parce que la relance forcée est intervenue. Un verdict "toutes les décisions
identiques" où au moins un modèle a été corrigé est signalé distinctement, jamais confondu avec un
vrai accord spontané.

## 9. Deux façons distinctes de traiter une requête domotique : action immédiate vs JSON structuré

**⭐ v1.10** — avant même d'atteindre ce qui suit, un interpréteur déterministe (§16) tente de
reconnaître la phrase localement, sans aucun appel Mistral ; s'il y parvient avec confiance,
l'exécution se fait directement et rien de ce qui suit dans cette section ne s'applique à cet
échange. Sinon (cas non reconnu), le comportement décrit ci-dessous reste inchangé.

Toute requête (une fois routée vers le domotique, §6, et non déjà traitée par le §16) est d'abord
classifiée par les règles domotiques (prompt système) parmi 7 catégories. **Une seule d'entre elles — l'action immédiate
("allume le salon", "éteins tout") — passe par le mécanisme d'outils du §7/§8**, jamais par le
JSON structuré ci-dessous.

**Toutes les autres catégories** (macro, planification, condition, gestion, assistance guidée, et
l'exécution différée) produisent un JSON structuré, reconnaissable à un champ `type` appartenant à
l'ensemble `{planification, macro, macro_ref, condition, sequence, gestion, execution}`. Après
réception complète de la réponse de Mistral, le texte assemblé est examiné : s'il parse comme un
tel JSON (après nettoyage des éventuelles balises markdown, §4), `ia` émet une requête interne vers
`planificateur` (voir §11) avec un identifiant de corrélation et un délai d'attente (~2 secondes).
Si `planificateur` répond, sa confirmation textuelle est renvoyée à HA à la place du JSON brut. Si
`planificateur` ne répond pas dans le délai (absent, indisponible), l'échange bascule en **mode
dégradé** : le texte brut produit par Mistral est relayé tel quel à HA, sans routage.

Le champ `trigger` d'une planification (`type`) admet, depuis le 03/08/2026, une valeur
supplémentaire `state_change` en plus des sept types temporels déjà couverts — voir
`fonctionnelles-planificateur_specs` §3.2. Cet ajout ne change rien à la structure décrite ici : un
`trigger` reste un sous-champ d'un nœud `planification`, jamais un `type` de premier niveau.

**Important** : le nœud `{"type":"action", "order":..., ...}` documenté dans le schéma JSON de
`fonctionnelles-planificateur_specs` §2 n'est **jamais** une réponse de premier niveau — il n'existe
que comme sous-nœud à l'intérieur d'une macro, d'une planification, d'une séquence, ou d'une
exécution déployée (y compris une exécution immédiate issue d'un appel d'outil, voir §10 et
`fonctionnelles-planificateur_specs` §6).

## 10. La boucle de réinterprétation à l'exécution

Principe central du système (voir `fonctionnelles-planificateur_specs` §6 pour le détail côté
appelant) : une planification enregistrée n'est **jamais exécutée depuis une version pré-compilée**.
Quatre situations distinctes y aboutissent, convergeant vers le même mécanisme et le même point
d'exécution unique (`planificateur`) :

- un déclencheur temporel programmé arrive à échéance,
- **une entité HA change d'état de la façon surveillée par un trigger `state_change`** (depuis le
  03/08/2026 — voir `fonctionnelles-planificateur_specs` §3.2/§6) — le contexte de déploiement
  envoyé à `ia` pour cette réinterprétation est alors enrichi d'un champ `triggered_entity_id`,
  l'entité réellement à l'origine de ce déclenchement précis, pour que Mistral sache cibler
  correctement une action sans lieu explicite ("éteins-la"),
- une macro connue est prononcée directement dans la conversation,
- **ou** un outil `executer_action` (§7/§8) est résolu, traité comme une planification immédiate et
  non répétitive (voir `fonctionnelles-planificateur_specs` §3.1, §6).

`ia` expose la capacité de réinterprétation uniquement en interne (EventBus, jamais en HTTP) : c'est
toujours `planificateur` qui initie cet échange pour les déclenchements programmés/macros, `ia` ne
déclenche jamais lui-même une exécution planifiée de sa propre initiative.

## 11. Communication interne (EventBus)

Aucun mécanisme de requête/réponse générique n'existe dans le socle pour l'inter-applications (pas
de client tout fait) — `ia` et `planificateur` implémentent chacun un petit helper local
(identifiant de corrélation + `Promise` + timeout) au-dessus de `EventBus.emitGeneric`/`onGeneric`.

| Événement | Direction | Rôle |
|-----------|-----------|------|
| `ia:command` | ia → planificateur | JSON structuré détecté (§9) |
| `ia:command:reply` | planificateur → ia | Réponse corrélée (confirmation ou erreur) |
| `ia:tool:execute` | ia → planificateur | Résolution/exécution d'un appel d'outil `executer_action` (§8) |
| `ia:tool:execute:reply` | planificateur → ia | Résultat corrélé de l'appel d'outil |
| `planificateur:deploy` | planificateur → ia | Demande de réinterprétation au déclenchement (§10) |
| `planificateur:deploy:reply` | ia → planificateur | Séquence d'exécution plate corrélée |
| `planificateur:macros:list` | planificateur → ia | ⭐ v1.10 — relais (déjà émis par `planificateur` pour son UI, désormais aussi vers `ia` via `bridgedEvents`) : cache local des macros pour `interpreter/macros.ts` (§16.5) |

## 12. Configuration

`data/ia/config.yaml` (objet nu, ex-section `ia` de l'ancien fichier unique — voir
`techniques-socle-ha-mqtt_specs` §7) : `mistralApiKey`, `mistralBaseUrl` (défaut
`https://api.mistral.ai/v1`), `ollamaHttpPort` (défaut `11434`), `rulesFile` (chemin du fichier de
règles). Une entrée par fournisseur d'IA généraliste activé (§6) : clé d'API et base URL propres.

**⭐ v1.9 — Fournisseur actif unique, indépendant du comparatif (§14)** : `provider`
(`'mistral' | 'anthropic'`, défaut `'mistral'`) détermine lequel des deux traite réellement le
domaine domotique (§7-§10) — jamais plus d'un à la fois, jamais de bascule dynamique par phrase
(voir §6 pour la distinction avec le routage multi-IA conceptuel, non implémenté). `defaultMistralModel`/
`defaultAnthropicModel` (défauts `mistral-small-latest`/`claude-haiku-4-5-20251001`) fixent le
modèle du fournisseur choisi ; `anthropicApiKey`/`anthropicBaseUrl` (défaut
`https://api.anthropic.com/v1`) miroir des champs Mistral pour ce second fournisseur. Exposé dans
l'UI générique de configuration du module (section "Comparatif Claude").

**⭐ v1.9 — `compareModels`** (comparatif, §14) : liste de `{provider, model, label?}`, 4 par défaut
— Mistral Small (`mistral-small-latest`), Mistral Medium (`mistral-medium-latest`), Claude Haiku
(`claude-haiku-4-5-20251001`), Claude Sonnet (`claude-sonnet-5`). Mêmes clés API que ci-dessus, pas
de clé dédiée par modèle comparé. Non exposé dans l'UI générique (même précédent que `modelMap`/
`mistralRateLimits`/`excludedQuoiIds`, un type de champ "liste d'objets" n'y étant pas praticable) —
éditable directement dans `data/ia/config.yaml`.

## 13. UI

Tableau de bord : joignabilité de l'API Mistral (et des fournisseurs généralistes activés), statut
du serveur Ollama émulé, derniers échanges (question/réponse, horodatés, fournisseur utilisé) à
titre de journal — pas d'onglet de configuration avancée en v1 au-delà de §12.

**⭐ v1.6** : chaque échange affiche désormais aussi (demandes utilisateur) — la réponse brute
complète de `planificateur` au JSON structuré envoyé (`planificateurReply`, `success`/`message`
inclus, pas seulement le message de confirmation déjà utilisé comme réponse conversationnelle) ;
le nombre de tokens consommés (§3). Le champ de test manuel propose un historique des 20 dernières
commandes testées (`<datalist>`, `localStorage`, propre au navigateur) — une commande n'y est
ajoutée que si elle diffère de la précédente (pas de doublons en répétant la même commande).

**⭐ v1.9** : le statut affiche désormais le **fournisseur/modèle réellement actif**
(`provider`/`activeModel`, `IaService.emitStatus()`, réémis aussi au rechargement à chaud de la
config — pas seulement au démarrage) plutôt qu'un badge toujours étiqueté "Mistral" ; le texte
d'attente du formulaire de test est devenu générique. Nouveau bouton **"🧪 Comparer"** à côté de
"Envoyer" : envoie la même phrase à tous les modèles de `compareModels` (§12/§14), affiche la
décision structurée et la latence de chacun, indique si un modèle a eu besoin d'être **corrigé**
(§8.2) avant d'y arriver — jamais exécuté, résultat détaillé dans `data/ia/comparatif.log` (une
ligne par comparaison, pensé pour `tail -f`).

## 14. Comparatif multi-modèles (nouveau v1.9)

### 14.1 Objectif et principe

Un seul fournisseur/modèle actif à la fois (§12) traite réellement les commandes domotiques
quotidiennes. Le comparatif sert à évaluer d'autres modèles **sans jamais les rendre actifs** ni
affecter le système réel — objectif explicite de l'utilisateur : pouvoir comparer objectivement
(décision structurée + temps de réponse, pas juste une impression sur le texte produit) avant de
décider lequel garder comme fournisseur de production.

### 14.2 Réutilisation du client Mistral pour Claude

Anthropic propose une couche de compatibilité OpenAI (`base_url`
`https://api.anthropic.com/v1`, documentée officiellement comme faite pour tester/comparer des
modèles, pas pour de la production long terme — cohérent avec cet usage précis) acceptant le même
format de requête/réponse que Mistral (`chat/completions`, streaming SSE, tool calling).
`MistralClient` est donc réutilisé tel quel pour les deux fournisseurs plutôt que dupliqué — voir
§3 pour `providerOverride` et les différences de traitement (`tool_choice`, cache de prompt).

### 14.3 Dry-run garanti — jamais de transmission à `planificateur`

Choix explicite de l'utilisateur (12/08/2026) : le comparatif ne doit **jamais** agir sur la
maison ni créer quoi que ce soit pour de vrai, y compris pour le modèle qui correspond par ailleurs
au fournisseur actif — aucune asymétrie "celui-ci exécute réellement, les autres non" (design
initial du 11/08/2026, abandonné après ce retour explicite).

- `ToolExecutor.execute(call, dryRun)` : les outils de lecture (`lister_entites`/`obtenir_etat`,
  §7) s'exécutent normalement, sans effet de bord — la comparaison reste fidèle au comportement
  réel du modèle. Seul `executer_action` est intercepté : jamais transmis à `planificateur`
  (`ia:tool:execute`, §11).
- `IaService.runChatRounds(..., runOpts)` : `structuredRouter.route()` (§9, dispatch du JSON
  structuré) n'est jamais appelé si `dryRun`.
- `IaService.handleCompareCommand()` appelle **systématiquement** `dryRun: true` sur tous les
  candidats de `compareModels` (§12), sans exception.

### 14.4 Vérification post-décision des références — voir §8.2

Le comparatif est ce qui a révélé le besoin de cette vérification (deux motifs réels
d'hallucination constatés en le faisant tourner, détaillés en §8.2) — description complète du
mécanisme là-bas plutôt que dupliquée ici. Chaque résultat de comparaison porte un indicateur
`corrected` : un verdict "décisions identiques" où au moins un modèle a eu besoin d'être corrigé
est signalé distinctement (`MATCH (mais X corrigé après vérification)`), jamais confondu avec un
vrai accord spontané — demande utilisateur explicite : "le prendre vraiment en compte dans la
comparaison des résultats", pas juste le noter en aparté.

### 14.5 Journalisation

Une ligne par comparaison ajoutée à `data/ia/comparatif.log` (pensé pour `tail -f`, demande
utilisateur) : horodatage, phrase, pour chaque candidat son libellé/modèle/latence/indicateur
`corrected`/décision structurée complète, puis un verdict (`MATCH` ou `DIFF(...)` listant les
champs qui diffèrent réellement).

### 14.6 Étude du 12/08/2026 — 30 cas testés, choix du fournisseur actif

Objectif : décider objectivement du fournisseur/modèle à garder actif (§12) en confrontant les 4
candidats de `compareModels` (§12) sur un jeu de commandes couvrant les cas réels du domaine
(action immédiate, planification différée/récurrente, condition sur état/seuil, gestion, lecture),
plutôt que sur une impression ponctuelle. Résultat brut complet : `data/ia/comparatif.log`.

**Les 30 commandes testées :**

| # | Catégorie | Commande | Verdict | Corrigé | En erreur |
|---|-----------|----------|---------|---------|-----------|
| 1 | Action immédiate | allume le salon | identique | — | — |
| 2 | Action immédiate | éteins la lumière du bureau | identique | — | — |
| 3 | Action immédiate | baisse le volet de la cuisine | divergent | — | Mistral Medium |
| 4 | Planification différée | dans 10 minutes éteins le salon | divergent | — | — |
| 5 | Planification différée | allume le bureau dans 5 minutes | identique | — | — |
| 6 | Planification récurrente | tous les jours à 22h30 éteins toutes les lumières | divergent | — | — |
| 7 | Planification récurrente | chaque lundi à 7h allume la cuisine | divergent | — | — |
| 8 | Planification récurrente | tous les soirs à 23h éteins le bureau | identique | — | — |
| 9 | Condition (état) | quand la porte d'entrée s'ouvre, allume le salon | divergent | — | Mistral Small, Mistral Medium |
| 10 | Condition (seuil) | si la température du salon dépasse 25 degrés, ouvre le volet du salon | divergent | — | Mistral Small |
| 11 | Action immédiate | ferme le volet de la chambre | divergent | — | Mistral Medium |
| 12 | Action immédiate | augmente le chauffage du bureau | divergent | — | Mistral Medium, Claude Sonnet |
| 13 | Action immédiate | éteins tout | divergent | — | — |
| 14 | Action immédiate | allume la lumière de la salle de bain | divergent | — | — |
| 15 | Action immédiate | allume le garage | divergent | — | — |
| 16 | Planification différée | dans 30 minutes ferme le volet du salon | divergent | Claude Haiku | Mistral Medium |
| 17 | Planification différée | éteins la cuisine dans 2 heures | identique | — | — |
| 18 | Planification différée | dans 1 heure allume le bureau | identique | — | — |
| 19 | Planification récurrente | tous les matins à 6h30 ouvre le volet de la chambre | divergent | Mistral Small | Mistral Medium, Claude Haiku |
| 20 | Planification récurrente | le vendredi à 18h éteins le bureau | divergent | — | — |
| 21 | Planification récurrente | chaque week-end à 9h allume la cuisine | identique | — | — |
| 22 | Condition (état) | quand le mouvement est détecté dans le salon, allume le salon | divergent | Mistral Small, Claude Haiku | Mistral Medium |
| 23 | Condition (état) | si la porte du garage reste ouverte, envoie une alerte | identique | Mistral Small | — |
| 24 | Condition (état) | quand la lumière du bureau s'éteint, ferme le volet du bureau | divergent | Mistral Small, Claude Haiku | Claude Sonnet |
| 25 | Condition (seuil) | si l'humidité de la salle de bain dépasse 70 pourcent, ouvre la fenêtre | identique | Mistral Small | — |
| 26 | Condition (état) | quand quelqu'un sonne à la porte, allume le salon | divergent | Claude Haiku | Mistral Medium |
| 27 | Condition (seuil) | si la température extérieure descend sous 5 degrés, allume le chauffage | divergent | Mistral Small, Claude Haiku | Claude Sonnet |
| 28 | Gestion | désactive la planification allumer bureau | identique | — | — |
| 29 | Lecture/conversation | montre-moi l'état de la lumière du salon | identique | — | — |
| 30 | Action immédiate | allume la télé du salon | divergent | Mistral Small | Mistral Medium |

*(Tests 28-30 : le solde de crédit API Anthropic s'est épuisé pendant le test 28 — les résultats
Claude de ces 3 tests sont invalides pour ces raisons, exclus des statistiques ci-dessous, pas
recomptés comme "erreur" de raisonnement.)*

**Résultats agrégés** (27 tests valides pour Claude, 30 pour Mistral) :

| Modèle | Erreurs | Action | Planification | Texte | Corrigé | Latence moyenne |
|--------|---------|--------|----------------|-------|---------|------------------|
| Mistral Small | 2 | 13 | 11 | 3 | 7 | 4,6 s |
| Mistral Medium | 9 | 4 | 9 | 7 | 0 | 16,8 s |
| Claude Haiku | 1 | 8 | 13 | 5 | 5 | 9,0 s |
| Claude Sonnet | 3 | 4 | 10 | 10 | 0 | 12,4 s |

**Conclusions et décision** :

- **Latence** : Mistral Small (~4,6 s) environ deux fois plus rapide que Claude Haiku (~9,0 s),
  trois fois plus que Claude Sonnet (~12,4 s). Mistral Medium le plus lent (~16,8 s), pénalisé par
  des boucles d'appels d'outils fréquentes (9 échecs "trop d'appels d'outils enchaînés" sur 30, le
  plus haut taux des quatre — voir aussi §8.2, un des deux motifs de boucle identifiés au passage,
  déjà corrigé).
- **Fiabilité "du premier coup"** : taux d'erreur brut proche entre Mistral Small (2/30) et Claude
  Haiku (1/27) ; Haiku légèrement meilleur avant correction (5 corrections sur 27, contre 7 sur 30
  pour Small), mais l'écart reste modeste. Mistral Medium et Claude Sonnet n'ont jamais été
  "corrigés" au sens du §8.2, mais pas pour la même raison ni un signe de supériorité : Medium
  échoue généralement *avant* d'atteindre une décision vérifiable (boucle), Sonnet évite le
  problème *en amont* en répondant par du texte (question, refus) plutôt qu'en committant une
  décision à corriger — le plus haut taux de réponses "texte" des quatre (10/27).
- **Coût observé** (facturation réelle utilisateur, ~3 jours d'usage incluant cette étude) :
  Mistral ≈ 0,97 €, Claude ≈ 6 $ — rapport d'environ 1 à 6-7, en partie dû à l'absence de cache de
  prompt côté Claude (§3).
- **Décision** : **Mistral Small reste le fournisseur actif** (§12, `provider: mistral`,
  `defaultMistralModel: mistral-small-latest`) — meilleur rapport latence/coût/fiabilité pour
  l'usage domotique quotidien réel. Claude (Haiku et Sonnet) reste disponible via `compareModels`
  (§14.1) pour des vérifications ponctuelles, jamais comme fournisseur de production.
- **Motifs de divergence réels identifiés** (au-delà des différences cosmétiques de nom de
  planification, non comptées comme divergence de fond) :
  - Classification "délai" encore inconsistante sur Mistral Small (test 4 : "dans 10 minutes
    éteins le salon" traité comme action immédiate au lieu de planification différée) — limitation
    déjà documentée en §15, non résolue par cette étude.
  - Représentation de récurrence hebdomadaire divergente entre modèles (test 7 : `trigger.every:
    "1 semaine"` côté Mistral vs `"1 jour"` + filtre `days` côté Claude) — les deux plausibles côté
    `planificateur`, jamais harmonisés côté prompt, non résolu par cette étude.

## 16. Interpréteur déterministe (pré-filtre avant Mistral, nouveau v1.10)

### 16.1 Contexte et objectif

L'ancien système pré-dimotic-ha (`zdidnodedomotext`, legacy Node.js) comprenait un interpréteur
français d'ordres domotiques par grammaire déclarative (`interpretetext.js` + `modelesv2.js` + un
parseur date/heure/durée dédié, `num_convert_date_duration_time.js`), sans aucun LLM, avec une
résolution quasi instantanée. Aujourd'hui, toute phrase — même une tournure simple et fréquente
comme "allume le salon" — passe systématiquement par un aller-retour Mistral (§7-§9) : plus lent,
plus coûteux, et le travail de fiabilisation de la partie IA (§14) n'est pas encore complètement
abouti. Objectif : reprendre la logique de cet ancien moteur pour court-circuiter Mistral sur les
tournures reconnues avec confiance, tout en gardant le chemin Mistral existant comme repli intact et
inchangé pour tout le reste — jamais de régression sur ce que l'ancien système ne couvre pas.

### 16.2 Insertion dans le flux existant

`interpretDeterministic(text, context)` s'exécute dans `IaService.handleChat()`, immédiatement après
`extractQuestion(messages)` et avant `runChatRounds()` (§8). Deux issues :
- **Reconnaissance confiante** : exécution directe, sans jamais solliciter Mistral — soit via
  `ToolExecutor.executeDirect(params: ExecuterActionParams)` (nouvelle méthode publique, extraite du
  chemin `executer_action` non-dryRun déjà existant en §8, réutilisée par les deux chemins) pour un
  ordre immédiat, soit via `StructuredRouter.route(structured)` (§9, inchangé) pour un JSON structuré
  `planification`/`macro_ref`/`gestion`.
- **Aucune reconnaissance** (`undefined`) : `runChatRounds()` s'exécute exactement comme aujourd'hui,
  comportement byte-identique à avant l'ajout de ce mécanisme — même contrat que
  `resolveAction`/`executeImmediateAction` côté `planificateur` (jamais de résultat approximatif
  renvoyé comme s'il était sûr).

### 16.3 Vocabulaire et gabarits — fichiers YAML éditables à chaud

Même convention que `regles_mistral.txt` (§5, `RulesProvider`) : un fichier vivant sous `data/ia/`
(gitignored, éditable sans reconstruire, rechargé à chaud par surveillance de fichier), seedé au
premier démarrage depuis un modèle versionné dans le dépôt. Deux fichiers distincts :
- **`vocabulaire_interpreteur.yaml`** (modèle : `applications/ia/interpreter/vocabulaire.yaml`) :
  synonymes de verbes (mirror volontaire, pas un import croisé, des clés de
  `fonctionnelles-planificateur_specs::resolution.ts::ON_OFF_TOGGLE_VERBS`/`VALUE_VERBS`), tables
  `<enum:...>` (valeurs fixes capturées par branche, ex. lever/coucher du soleil), mots ignorés
  (articles + "et"), séparateurs de phrase.
- **`gabarits_interpreteur.yaml`** (modèle : `applications/ia/interpreter/gabarits.yaml`) : tous les
  gabarits de phrase portés de `modelesv2.js` (§16.4).

Les lieux/quois eux-mêmes ne sont **jamais** figés dans ces fichiers — dérivés en direct du
référentiel HA à chaque appel (§16.5), donnée vivante.

### 16.4 Gabarits — notation, composition, ce qui est porté

**Notation (DSL)**, compilée au chargement vers l'arbre de matching interne :
`<lieu>`/`<quoi>`/`<valeur>`/`<duree>`/`<heure>`/`<date>`/`<datetime>` (catégories terminales,
résolues dynamiquement) ; `<categorie#nomcapture>` (renomme une capture dupliquée dans un même
gabarit) ; `<enum:table>`/`<verbe:table>` (table nommée du vocabulaire, valeur capturée fixe par
branche, scalaire ou liste) ; `<gabarit:nom>` (référence à un autre gabarit entier, composition —
mécanisme déjà présent dans le legacy sous le nom `type:"model"`) ; `(a|b|c)` alternative, `?`
facultatif, `*` répétable, applicables à un jeton seul ou à un groupe. `strict` (mode de comparaison,
mots ignorés sautés automatiquement seulement hors mode strict) et `defaults` (§16.6) restent des
attributs YAML séparés du motif, pas encodés dedans.

**Ce qui est porté** — vérifié contre les gabarits réels de `modelesv2.js`, pas supposé : la plupart
ne sont pas des phrases complètes indépendantes mais des **fragments de clause temporelle
composables** (`attendre`, `dans`, `jusqua`, `a`, `de`, `le`, `pendant`, `touslesjours`,
`touslesjourssemaine`, `leweekend`, `levercouchersoleil1`/`levercouchersoleil`, `entre`,
`delayrepeat`), enchaînés par la boucle de phrase du moteur avant une clause terminale unique :
`allume` (ordre générique on/off), `regle` (ordre avec valeur), `active`/`desactive`, `donne`
(interrogation), `sauf_lieux` (exclusion de lieux — trouvé dans un fichier de conflit ownCloud non
fusionné du legacy, absent du fichier réel mais cohérent pour être repris), et le nouveau gabarit
`si_alors` (§16.8). Sortie selon la clause terminale : `ExecuterActionParams`, JSON `DomoticNode`
`planification` (fragments temporels, via le port de `num_convert_date_duration_time.js`), résolution
d'entités déjà existante côté `ia` (interrogation — voir §16.9 pour ce qui reste hors périmètre), ou
`trigger.type: 'state_change'`.

### 16.5 Résolution lieux/quois/macros

- **Lieux** : `HaStructureRegistry.getLieuCatalog(excludedQuoiIds?)` (déjà utilisé en §5 pour le
  catalogue Mistral) réutilisé tel quel comme source des candidats simples — tous niveaux de
  taxonomie confondus (`lieu_precis`/`lieu_principal`/`lieu_pere`/`lieu_grand_pere`), déjà
  dédupliqués. **Candidats composés** (ex. "chevet gauche de la chambre") dérivés en plus,
  directement depuis `attributs_taxonomie` de chaque entité (avant l'aplatissement de
  `getLieuCatalog()`), sous forme de paires `(lieu_precis, lieu_principal)` — matchées via un motif à
  connecteur souple (`<lieu_precis> (de|du|de la|de l'|des)? <lieu>`, jamais un article deviné).
- **Tri par longueur décroissante** (pas un tri alphabétique inversé comme le legacy, qui ne
  fonctionnait que par coïncidence sur les cas de préfixe strict) appliqué uniformément aux candidats
  lieux/quois/macros avant matching — essaie le candidat le plus spécifique/long en premier.
- **Normalisation** (minuscules, accents supprimés lettre par lettre, apostrophe/tiret → espace)
  appliquée aux deux côtés (phrase ET candidats) — point propre au nouveau moteur : `getLieuCatalog()`
  renvoie des valeurs "affichage" (accentuées), contrairement au vocabulaire legacy écrit sans accent
  à la main.
- **Macros** : `planificateur:macros:list` (déjà émis, §11) désormais relayé vers `ia`
  (`bridgedEvents`), mis en cache localement, reconnu en tête de phrase selon le même tri par
  longueur.

### 16.6 Défauts : `quoi` et lieu d'origine

- **`quoi: "lumière"` par défaut** sur les gabarits on/off bruts (`allume`/`eteins`/`active`/
  `desactive`) sans quoi explicite — nécessaire, pas cosmétique : `getEntitiesByQuoiAndLieux(undefined,
  lieux)` renvoie toutes les entités du lieu tous domaines confondus, et `executeImmediateAction`
  exige un `quoi` non vide. Sans ce défaut, "allume le salon" (formulation la plus probable) ne
  passerait jamais par ce chemin rapide.
- **`context.lieuOrigine` (optionnel)** : si la phrase ne capture aucun lieu, `lieux` défaute à
  `[context.lieuOrigine]` — objectif "allume" tout seul, dit près d'un micro situé dans une pièce,
  cible cette pièce. Crochet prêt à l'emploi mais **pas garanti bout en bout à ce stade** : aucune
  info d'origine (device_id du satellite déclencheur) ne remonte aujourd'hui jusqu'à `ia`
  (`OllamaChatRequestBody` n'a rien de tel) ; `HaStructureRegistry` connaît déjà l'association
  `device_id`→aire, la brique manquante est le pipeline Assist HA lui-même (hors périmètre de cette
  spec, à examiner séparément). Tant que non branché, `context.lieuOrigine` reste `undefined`, repli
  Mistral inchangé.

### 16.7 Découpage de phrases

**Bug corrigé** : le découpage legacy (`.replace(/(\D)\.(\D)/g, ...)`) exige un caractère
non-numérique des deux côtés du point pour couper une phrase — toute phrase se terminant par un
nombre entier ("Chauffe à 20. Allume...") n'est jamais coupée de la suivante. Corrigé en protégeant
d'abord les vrais décimaux (chiffre-point-chiffre) via un remplacement temporaire, puis en coupant
librement sur tout point restant.

**Séparateurs étendus** (`vocabulaire_interpreteur.yaml`, §16.3) : `.` (corrigé), `puis` (corrigé en
limite de mot — le legacy matchait aussi dans "depuis"), `;`, `ensuite`, `et puis`, `et ensuite`,
retour à la ligne explicite. `et` seul explicitement exclu (ambigu : "allume le salon et la cuisine"
est un seul ordre à deux lieux, pas deux ordres).

**Détection sans séparateur** (ex. "allume le salon éteins la cuisine") : les verbes formant un
vocabulaire fermé disjoint des quoi/lieux, une fois un ordre complet refermé avec succès, un verbe
reconnu immédiatement après démarre un nouvel ordre implicite — déclenché uniquement après fermeture
réussie d'un ordre, jamais en cours de matching.

### 16.8 Nouveau gabarit événementiel `si_alors`

Absent du legacy (constaté par l'utilisateur) — "si la lumière de la vitrine s'allume alors allume le
plan de travail". Ne demande aucune nouvelle mécanique d'exécution : `StateWatcher.ts`
(`fonctionnelles-planificateur_specs`) gère déjà des déclencheurs `trigger.type === 'state_change'`
complets. Motif : `si <clause déclencheur> (alors|,) <clause action>` — la clause déclencheur résout
lieu/quoi comme le reste (§16.5) plus un vocabulaire verbe-d'état → `to_state` limité en v1 à on/off
(allumé/éteint/ouvert/fermé, états à valeur différés) ; la clause action réutilise tel quel les
gabarits `ordre` déjà portés (§16.4), aucun nouveau parsing.

### 16.9 Hors périmètre

- **Réponse aux interrogations** ("donne-moi...") : la reconnaissance du gabarit `donne` est portée
  (§16.4), mais routée vers la résolution d'entités déjà existante côté `ia` (§7) — pas vers un
  portage du formatage de réponse du legacy (`donnemoi.js`), qui reconstruirait une couche de mise en
  forme contre une source de données (réplication RethinkDB) qui n'existe plus.
- **CRUD/stockage de macros legacy** (`macros.js`) : non repris comme infrastructure —
  `planificateur` a déjà un système plus riche (`MacroDefinition`/`macro_ref`/`GestionNode`). Seule la
  lecture de cette liste existante est nécessaire côté `ia` (§16.5).
- **Bus MQTT/bootstrap legacy** (`mqttdimotic.js`/`appli.js`/réplication RethinkDB) : aucune brique à
  porter, déjà intégralement remplacés par `EventBus`/`HaBridgeClient`/`ApplicationManager`.

### 16.10 Statut à cette version

Conception validée en session (voir plan de mise en œuvre pour le détail complet des vérifications
effectuées) — implémentation en cours au moment de cette version de la spec. Une future version
documentera les résultats de vérification réels (§ "Vérification" du plan de mise en œuvre) une fois
le moteur testé en conditions réelles.

## 17. Limitations connues / décisions

- Le routage multi-IA (§6) a deux points non résolus avant implémentation réelle : la source fiable
  d'une clé de session par device (jamais testée avec du matériel vocal réel), et le format exact du
  signal "non compris" émis par le traitement domotique.
- Pas de mécanisme de diffusion des règles à d'autres processus (contrairement à une architecture
  multi-process) — un seul fichier local, une seule application qui le lit.
- Le port HTTP d'émulation Ollama est un serveur distinct du port web du socle — même application,
  deux serveurs HTTP actifs simultanément.
- **Ambiguïté récurrent/one-shot non résolue pour un trigger `state_change`** (depuis le
  03/08/2026) : une phrase du type "quand X, fais Y" ne précise pas si la règle doit se redéclencher
  à chaque occurrence future de l'événement ou ne s'appliquer qu'une seule fois — contrairement aux
  déclencheurs temporels, où le type (`delay` vs `recurrence`) découle naturellement de la
  formulation. `ia` ne pose actuellement aucune question de clarification : la règle produite est
  systématiquement traitée comme récurrente par `planificateur` (voir
  `fonctionnelles-planificateur_specs` §3.2, §12). Un mécanisme de clarification (nouvelle catégorie
  de réponse, ou repli avec confirmation implicite) reste à concevoir séparément.

## 18. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.10 | 26/08/2026 | Claude | **Interpréteur déterministe français** (§16, nouveau) : reprise de la logique de l'ancien moteur `zdidnodedomotext` (`interpretetext.js`/`modelesv2.js`/`num_convert_date_duration_time.js`), réécrite en TypeScript, corrigée du bug de découpage de phrases (`.replace(/(\D)\.(\D)/g,...)`, coupait mal les phrases se terminant par un nombre entier — vérifié empiriquement), et convergeant vers les structures déjà produites par Mistral (`ExecuterActionParams`/`PlanificationDefinition`/`MacroDefinition`) plutôt qu'un nouveau format. Pré-filtre dans `IaService.handleChat()` avant `runChatRounds()` : reconnaissance confiante → exécution directe (`ToolExecutor.executeDirect()`, nouveau) sans aller-retour Mistral ; sinon repli intégral inchangé. Vocabulaire/gabarits en YAML éditables à chaud (`data/ia/vocabulaire_interpreteur.yaml`/`gabarits_interpreteur.yaml`, même convention que `regles_mistral.txt`). Nouveau gabarit événementiel `si_alors` (absent du legacy, cible `trigger.type: 'state_change'` déjà géré par `planificateur`). Toutes demandes/décisions utilisateur, session du 26/08/2026 — voir le plan de mise en œuvre associé pour le détail complet des vérifications (bug de découpage confirmé en direct via `node`, `getLieuCatalog()`/`getEntitiesByQuoiAndLieux()` relus pour fonder les défauts §16.6, etc.). |
| 1.9 | 12/08/2026 | Claude | **Comparatif multi-modèles** (§14, nouveau) : jusqu'à 4 modèles (Mistral Small/Medium, Claude Haiku/Sonnet via la couche de compatibilité OpenAI d'Anthropic, §14.2/§3) interrogés en parallèle sur la même phrase, toujours en dry-run strict (§14.3) — jamais de transmission à `planificateur`, quel que soit le fournisseur actif. **Vérification post-décision des références quoi/lieux/entity_id** (§8.2, nouveau `referenceValidator.ts`) : tout JSON structuré (planification/macro/condition/sequence/execution), plus les étapes produites par `DeployResponder` (§10) — "d'où qu'il vienne", demande utilisateur explicite — est désormais vérifié contre `HaStructureRegistry` avant transmission ; référence invalide → relance forcée (une seule fois, drapeau `verificationRetried`, renommé depuis `quoiIntrouvableRetried`) puis refus explicite avec demande de correction si le problème persiste. Gap corrigé en cours de route : la vérification ne couvrait initialement pas `executer_action` en dry-run (`ToolExecutor` répondait toujours "succès" sans vérifier) — trouvé en dépouillant l'étude ci-dessous. Bug annexe corrigé : `tool_choice="any"` (convention Mistral) traduit en `'required'` pour Anthropic, qui rejetait la valeur Mistral avec un 400. **Étude comparative du 12/08/2026 sur 30 cas** (§14.6, commandes et résultats détaillés) : Mistral Small confirmé comme fournisseur actif (§12) — meilleur rapport latence (~4,6s vs ~9-16s)/coût (0,97€ vs 6$ sur ~3 jours)/fiabilité pour l'usage domotique réel ; Claude conservé comme outil de vérification ponctuelle via le comparatif. Toutes demandes utilisateur, session du 11-12/08/2026. |
| 1.8 | 11/08/2026 | Claude | **Deux correctifs anti-hallucination contre les faux refus "quoi_introuvable"** constatés en direct ("allume la salle" refusé à tort). **Catalogue quoi/lieux statique injecté dans le prompt système** (§5, `RulesProvider` accepte un `HaStructureRegistry` optionnel, `getQuoiCatalog()`/`getLieuCatalog()` ajoutés à la suite de `regles_mistral.txt` à chaque appel — voir `techniques-socle-ha-mqtt_specs` §8.3.3) : effet mesuré, "allume la salle" se résout dès le premier round sans relance forcée. **Relance forcée `tool_choice=any`** (§8.1, nouveau) : filet de sécurité résiduel — `MistralClient.streamChat()` accepte un `toolChoice` optionnel, jamais par défaut sur tous les rounds ; `IaService` détecte `"quoi_introuvable"` sans qu'aucun outil n'ait été appelé dans l'échange et relance une seule fois ce round en forçant un outil (`isUnverifiedQuoiIntrouvable()`, drapeau `quoiIntrouvableRetried`). Testé en direct 3/3, aucune régression sur action directe/planification. Toutes demandes utilisateur, session du 11/08/2026. |
| 1.7 | 11/08/2026 | Claude | **`lister_entites`/`obtenir_etat` délégués au graphe de lieux centralisé** (§7, `HaStructureRegistry.getEntitiesByQuoiAndLieux()`, voir `techniques-socle-ha-mqtt_specs` §8.3.2) — remplace une résolution propre à `ToolExecutor.ts` limitée aux areas HA, sans repli, jamais documentée comme telle. `regles_mistral.txt` enrichi : `lieu_pere` exposé en plus de `lieu_precis`, résolution numéro→planification pour la gestion (voir `fonctionnelles-planificateur_specs` v1.7 §4/§7). Toutes demandes utilisateur, session du 10-11/08/2026. |
| 1.6 | 10/08/2026 | Claude | **Throttling préventif + backoff réactif sur rate limit Mistral** (§3, nouveau module `RateLimiter.ts` par modèle), **tokens consommés affichés par appel** (§3/§13), **trace complète de la réponse planificateur** dans le journal des échanges (§13), **historique des commandes de test** (`<datalist>`, §13). Toutes demandes utilisateur, session du 10/08/2026 (rate limit constaté en direct pendant les tests). |
| 1.5 | 03/08/2026 | Claude | **Prise en compte du déclencheur réactif `state_change`** (`fonctionnelles-planificateur_specs` v1.5) : §10 étendue à quatre situations de déclenchement (ajout du changement d'état d'entité), mention du nouveau champ de contexte `triggered_entity_id` enrichissant la réinterprétation pour ce cas. §9 précise que `trigger.type` admet cette nouvelle valeur sans changer la structure du JSON échangé. §5 mentionne que `regles_mistral.txt` couvre désormais ce déclencheur. Nouvelle limitation connue (§14) : ambiguïté récurrent/one-shot de "quand X, fais Y" non résolue, traité récurrent par défaut, sans clarification demandée à l'utilisateur. |
| 1.4 | 24/07/2026 | Claude | (Voir version archivée — pas de changement de contenu identifié entre 1.3 et 1.4 au moment de cette révision, seule la date d'en-tête diffère.) |
| 1.3 | 23/07/2026 | Claude | **Révision architecturale majeure**, issue d'une session de conception approfondie avec l'utilisateur : (1) nouvelle §6 "Routage multi-IA" — le concept "VoiceRouter" existait déjà comme document de conception séparé (`voice-router-spec.md`, jamais implémenté), intégré ici. (2) `ia` gagne un accès HA en lecture (`requiredHaWs: true`, était `false`) pour résoudre localement les outils de lecture. (3) Nouvelles §7/§8 : `ia` déclare lui-même un jeu d'outils fixe à Mistral (pas de délégation aux outils natifs de HA comme le disait la v1.2) et exécute une vraie boucle d'appel d'outils (résultats réinjectés, Mistral rappelé), pas un simple relais passif. (4) L'action immédiate, un appel d'outil résolu, devient une planification immédiate non répétitive traitée par le point d'exécution unique de `planificateur` — troisième voie vers le même mécanisme que le minuteur et la macro directe. (5) Nouveaux événements EventBus `ia:tool:execute`/`:reply`. Sections renumérotées en conséquence, toutes les références croisées internes et vers `fonctionnelles-planificateur_specs` corrigées. |
| 1.2 | 23/07/2026 | Claude | Nouvelle §4 "Difficultés protocolaires connues" : balises markdown autour du JSON, fragmentation des `tool_calls` en streaming, réconciliation des deux formats de requête Ollama, signal interne à ne pas laisser fuiter vers HA, en-tête anti-buffering, forme d'erreur Ollama en cas d'échec Mistral. |
| 1.1 | 23/07/2026 | Claude | Clarification : l'action immédiate ne produit jamais de JSON structuré — ne transite jamais par `planificateur` (précision alors correcte, la mécanique exacte a été révisée en v1.3 ci-dessus). |
| 1.0 | 23/07/2026 | Claude | Version initiale — spécification de l'application avant implémentation. |
