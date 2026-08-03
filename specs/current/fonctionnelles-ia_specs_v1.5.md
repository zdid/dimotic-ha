# Spécifications Fonctionnelles — Application IA

**Version :** 1.5
**Date :** 3 Août 2026
**Statut :** Document de référence pour l'application `applications/ia`

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

## 9. Deux façons distinctes de traiter une requête domotique : action immédiate vs JSON structuré

Toute requête (une fois routée vers le domotique, §6) est d'abord classifiée par les règles
domotiques (prompt système) parmi 7 catégories. **Une seule d'entre elles — l'action immédiate
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

## 12. Configuration

`data/ia/config.yaml` (objet nu, ex-section `ia` de l'ancien fichier unique — voir
`techniques-socle-ha-mqtt_specs` §7) : `mistralApiKey`, `mistralBaseUrl` (défaut
`https://api.mistral.ai/v1`), `ollamaHttpPort` (défaut `11434`), `rulesFile` (chemin du fichier de
règles). Une entrée par fournisseur d'IA généraliste activé (§6) : clé d'API et base URL propres.

## 13. UI

Tableau de bord : joignabilité de l'API Mistral (et des fournisseurs généralistes activés), statut
du serveur Ollama émulé, derniers échanges (question/réponse, horodatés, fournisseur utilisé) à
titre de journal — pas d'onglet de configuration avancée en v1 au-delà de §12.

## 14. Limitations connues / décisions

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

## 15. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.5 | 03/08/2026 | Claude | **Prise en compte du déclencheur réactif `state_change`** (`fonctionnelles-planificateur_specs` v1.5) : §10 étendue à quatre situations de déclenchement (ajout du changement d'état d'entité), mention du nouveau champ de contexte `triggered_entity_id` enrichissant la réinterprétation pour ce cas. §9 précise que `trigger.type` admet cette nouvelle valeur sans changer la structure du JSON échangé. §5 mentionne que `regles_mistral.txt` couvre désormais ce déclencheur. Nouvelle limitation connue (§14) : ambiguïté récurrent/one-shot de "quand X, fais Y" non résolue, traité récurrent par défaut, sans clarification demandée à l'utilisateur. |
| 1.4 | 24/07/2026 | Claude | (Voir version archivée — pas de changement de contenu identifié entre 1.3 et 1.4 au moment de cette révision, seule la date d'en-tête diffère.) |
| 1.3 | 23/07/2026 | Claude | **Révision architecturale majeure**, issue d'une session de conception approfondie avec l'utilisateur : (1) nouvelle §6 "Routage multi-IA" — le concept "VoiceRouter" existait déjà comme document de conception séparé (`voice-router-spec.md`, jamais implémenté), intégré ici. (2) `ia` gagne un accès HA en lecture (`requiredHaWs: true`, était `false`) pour résoudre localement les outils de lecture. (3) Nouvelles §7/§8 : `ia` déclare lui-même un jeu d'outils fixe à Mistral (pas de délégation aux outils natifs de HA comme le disait la v1.2) et exécute une vraie boucle d'appel d'outils (résultats réinjectés, Mistral rappelé), pas un simple relais passif. (4) L'action immédiate, un appel d'outil résolu, devient une planification immédiate non répétitive traitée par le point d'exécution unique de `planificateur` — troisième voie vers le même mécanisme que le minuteur et la macro directe. (5) Nouveaux événements EventBus `ia:tool:execute`/`:reply`. Sections renumérotées en conséquence, toutes les références croisées internes et vers `fonctionnelles-planificateur_specs` corrigées. |
| 1.2 | 23/07/2026 | Claude | Nouvelle §4 "Difficultés protocolaires connues" : balises markdown autour du JSON, fragmentation des `tool_calls` en streaming, réconciliation des deux formats de requête Ollama, signal interne à ne pas laisser fuiter vers HA, en-tête anti-buffering, forme d'erreur Ollama en cas d'échec Mistral. |
| 1.1 | 23/07/2026 | Claude | Clarification : l'action immédiate ne produit jamais de JSON structuré — ne transite jamais par `planificateur` (précision alors correcte, la mécanique exacte a été révisée en v1.3 ci-dessus). |
| 1.0 | 23/07/2026 | Claude | Version initiale — spécification de l'application avant implémentation. |
