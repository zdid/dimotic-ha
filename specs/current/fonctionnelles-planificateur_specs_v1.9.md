# Spécifications Fonctionnelles — Application PLANIFICATEUR

**Version :** 1.9
**Date :** 26 Août 2026
**Statut :** Document de référence pour l'application `applications/planificateur`

> **v1.9** : **Correctif §5.1 — un trigger récurrent manqué au-delà de la fenêtre de rattrapage
> n'était jamais reprogrammé.** Bug réel signalé par l'utilisateur : "éteindre toutes les
> lumières tous les jours à 2h30" exécutée le 17/08, plus jamais depuis (service arrêté à
> l'heure du déclenchement le 18/08). `resumeOrSchedule()` marquait bien `missed: true`, mais
> seul le cas non récurrent appelait la suite du cycle (`completed_at`) — un récurrent manqué
> restait active sans aucun minuteur, silencieusement, jusqu'au redémarrage suivant, qui retombait
> dans le même cas. Corrigé : un trigger récurrent manqué est maintenant reprogrammé pour sa
> prochaine occurrence (`next_fire_at` recalculé par rapport à l'heure courante, saute donc
> naturellement l'occurrence manquée), `missed` reste affiché jusqu'au prochain déclenchement
> réussi comme avant. Vérifié en conditions réelles sur la planification concernée.
>
> **v1.8** : Retrait de l'entrée "Macros" du sous-menu Paramètres Techniques (§11) — redondante
> avec le bouton "📋 Macros" déjà présent dans le tableau de bord, seul accès conservé. Corrige au
> passage une description périmée de `config.html` (annonçait encore "macros + planifications
> (mêmes actions)", alors que la page a été recentrée aux macros seules dès le 12/08/2026).
>
> **v1.7** : **Écran principal du tableau de bord refondu** en liste numérotée de planifications
> (§11) — indicateur actif/inactif, nom facultatif, phrase, prochaine exécution ; création par
> boîte de dialogue (phrase soumise à `ia` pour validation, aucune saisie structurée) ; journaux
> existants déplacés dans un onglet séparé plutôt que supprimés. **Identifiant numérique stable**
> (`PlanificationDefinition.id`, §2) permettant de désigner une planification par son numéro en
> plus de son nom ("désactive la planification 3", §4). **Résolution de `lieux` déléguée au
> nouveau graphe centralisé de `HaStructureRegistry`** (§7, voir `techniques-socle-ha-mqtt_specs`
> §8.3.2) — remplace et généralise le repli `lieu_precis` de la v1.6, couvre aussi les phrases
> composées ("plafonnier de la chambre") et les lieux qualifiés par étage/zone. Correctif de
> cohérence UI : une planification créée/gérée par conversation pousse désormais une mise à jour
> live aux dashboards déjà ouverts (auparavant seules les actions déclenchées depuis l'UI le
> faisaient). Toutes demandes utilisateur, session du 10-11/08/2026.

> Conforme à `techniques-socle-ha-mqtt_specs` (architecture 5 couches, EventBus,
> `HaStructureRegistry`), `nommage_specs` (taxonomie QUOI/OÙ), `guide-nouvelle-application_specs`.
> À lire avec `fonctionnelles-ia_specs`, l'application complémentaire avec laquelle `planificateur`
> communique.

## 1. Contexte

`applications/planificateur` stocke les macros et planifications domotiques exprimées en langage
naturel (reçues sous forme de JSON structuré, produit par `applications/ia` à partir des règles
domotiques appliquées à une conversation Mistral), calcule les échéances de déclenchement —
**temporelles ou réactives à un changement d'état d'entité** (§3) —, et — principe central du
système — **redemande systématiquement à `ia` d'interpréter la planification au moment précis de
son déclenchement**, plutôt que d'exécuter une version pré-compilée.

Rien n'est jamais figé en code exécutable. Le champ `phrase_originale` reste, à tout moment, la
seule source de vérité d'une planification ; le JSON qui l'accompagne n'en est qu'une dérivation
transitoire, régénérée à chaque exécution à partir du contexte réel du moment (état des appareils,
heure, macros connues).

`planificateur` est le **seul point d'exécution** du système — toute action réelle sur HA, quelle
que soit son origine (planification programmée, macro dite directement, appel d'outil résolu en
direct par `ia`, ou changement d'état d'une entité, voir §6), passe systématiquement par lui.

`type: 'standalone'`, `requiredMqtt: false` (aucune connexion MQTT propre), `requiredHaWs: true`
(utilise `HaStructureRegistry` pour l'état/la résolution des entités, `HaWsClient`/
`HaCommandService` pour l'exécution, et `HaWsClient.onStateChanged()` pour les triggers `state_change`, §3).

## 2. Modèle de données

Le JSON échangé avec `ia` est un arbre de nœuds s'imbriquant librement, sans limite de profondeur.
Chaque nœud porte un champ `type` discriminant :

| `type` | Rôle |
|--------|------|
| `action` | Un ordre unique (`order`, `verbe`, `quoi`, `lieux`) — **toujours un sous-nœud**, jamais une réponse de premier niveau (voir `fonctionnelles-ia_specs` §9). C'est aussi la forme exacte des paramètres de l'outil `executer_action` (`fonctionnelles-ia_specs` §7) |
| `wait` | Une attente, durée fixe ou plage aléatoire (bornes toujours exprimées) |
| `condition` | Logique conditionnelle (`if`/`then`/`else?`), `else` optionnel |
| `macro_ref` | Référence à une macro existante par son nom |
| `sequence` | Plusieurs nœuds au même niveau |
| `macro` | Définition nommée d'une séquence d'étapes, stockée telle quelle |
| `planification` | Une macro/action associée à un déclencheur (`trigger`, temporel ou réactif) |
| `gestion` | Opération sur une macro/planification existante (§4) |
| `execution` | Séquence plate produite par `ia`, à chaque déploiement (§6) — jamais stockée |

`ActionNode` et chaque étape d'une séquence d'exécution portent en plus un champ optionnel
`resolved_service_call` (`domain`/`service`/`entity_id`/`data`). **Ce n'est pas Mistral qui le
peuple** : c'est `planificateur` lui-même, par résolution déterministe (§7), à partir de l'intention
`verbe`/`quoi`/`lieux` — voir §8 pour son usage à l'exécution.

`PlanificationDefinition` porte, en plus de `name`/`active`/`phrase_originale`/`trigger`/`action`,
quatre champs gérés exclusivement par `planificateur` lui-même (jamais renseignés par `ia`/Mistral) :

| Champ | Rôle |
|-------|------|
| `id` | **⭐ v1.7** Identifiant numérique stable, attribué à la création (`CommandHandler.nextPlanificationId()` — max courant + 1, ou 1 si aucune planification). Jamais réattribué tant que la planification existe (préservé si elle est recréée sous le même nom), jamais réutilisé après suppression. Sert la liste numérotée du tableau de bord (§11) et permet de désigner une planification par son numéro plutôt que son nom dans une opération de gestion (§4) — utile en usage vocal, où le nom exact est parfois long ou mal mémorisé. Toute planification chargée sans `id` (fichier antérieur à la v1.7) en reçoit un au démarrage (`CommandHandler.load()`, ordre de rencontre dans le fichier). |
| `next_fire_at` | Heure cible absolue (ISO8601) du prochain déclenchement — triggers temporels uniquement, un seul minuteur par planification. |
| `pending` | Map `entity_id → heure cible absolue (ISO8601)` — triggers `state_change` uniquement ; plusieurs comptes à rebours indépendants possibles sous une même planification (règle par défaut sur tout un domaine, §3). |
| `missed` | Vrai si un déclenchement temporel a été abandonné au-delà de la fenêtre de rattrapage (§5) — effacé automatiquement à la prochaine exécution réussie. |

Le nom d'une macro ou d'une planification est conservé exactement tel que formulé par
l'utilisateur (pas de normalisation, casse et accents préservés) — c'est ce nom qui sert
d'identifiant pour les opérations de gestion (§4).

## 3. Déclencheurs (`trigger`)

### 3.1 Déclencheurs temporels

| Type | Exemple de formulation | Comportement |
|------|------------------------|---------------|
| `delay` | "dans 10 minutes" | Ponctuel, délai fixe ou plage aléatoire |
| `time` | "à 18h15" | Quotidien, heure fixe ou plage aléatoire |
| `date` | "le 15 juin" | Ponctuel, date précise |
| `recurrence` | "tous les jours à 18h", "sauf week-end" | Récurrent, jours inclus/exclus |
| `recurrence_complex` | "le dernier jour du mois", "premier lundi" | Récurrent, motif calculé |
| `window` | "de 18h à 22h" | Plage active |
| `duration` | "pendant 10 minutes" | Génère automatiquement une action de fin |

`{type:"delay", seconds:0}` sert aussi à représenter une **exécution immédiate et non répétitive** —
notamment celle d'un appel d'outil `executer_action` résolu en direct (§6) : aucun nouveau type de
déclencheur n'est nécessaire, `delay` n'étant déjà pas récurrent dans le scheduler.

Toute plage aléatoire (durée "entre X et Y", heure "entre X et Y") est résolue en une valeur fixe
**au moment du calcul du prochain délai**, jamais figée une fois pour toutes — un déclenchement
récurrent avec plage aléatoire tire une nouvelle valeur à chaque occurrence.

Cette résolution — transformer un `trigger` déjà structuré en délai exact (millisecondes,
prochaine date de calendrier) — est un calcul déterministe fait entièrement en code par
`planificateur` (motifs de date, résolution d'aléatoire compris). **Ce n'est jamais l'IA qui
calcule ce délai** : son rôle s'arrête à l'interprétation, une fois, de la phrase en `trigger`
structuré au moment de la création (§4) — recalculer une date/heure est une tâche déterministe hors
du périmètre du langage naturel, pour laquelle un calcul de code est strictement plus fiable, plus
rapide, et sans risque d'erreur arithmétique qu'une nouvelle interrogation de l'IA à chaque
occurrence.

### 3.2 Déclencheur réactif — `state_change`

Réagit à un changement d'état d'entité HA plutôt qu'à une échéance temporelle : "quand la lumière du
salon s'allume, éteins la cuisine", "minuterie de 24h par défaut sur toutes les lumières".

| Champ | Rôle |
|-------|------|
| `entity_id` | Cible une entité précise. |
| `domain` | Cible tout un domaine (ex: `"light"`) — règle par défaut, pas de liste fixe à déclarer. Exclusif avec `entity_id` en pratique, voir priorité ci-dessous. |
| `to_state` | État déclencheur (ex: `"on"`). |

**Priorité** : si une entité est à la fois couverte par une planification `entity_id` précise et par
une planification `domain` qui s'appliquerait aussi à elle, **la planification précise l'emporte**
pour cette entité — la règle de domaine ne s'applique qu'aux entités sans planification dédiée.

**Comportement "minuterie"** : l'action associée (typiquement une séquence `wait` puis `action`,
§2/§8 — mécanisme déjà existant, aucun changement nécessaire) démarre dès que le trigger se
déclenche. Si l'entité redéclenche l'état surveillé pendant qu'une exécution est déjà en cours pour
elle, cette exécution est **annulée** et une nouvelle repart de zéro — pas d'empilement. Le suivi
est fait **par couple (planification, entité)**, pas seulement par planification : une règle par
défaut sur tout un domaine gère plusieurs comptes à rebours indépendants en parallèle (une lumière
n'en réinitialise pas une autre).

**Ciblage implicite de l'entité déclenchante** : pour une règle de domaine, l'action n'a souvent
aucun lieu explicite ("éteins-la" plutôt que "éteins la cuisine") — l'entité réellement à l'origine
du déclenchement est alors transmise au contexte de déploiement (`triggered_entity_id`, §6) pour que
la réinterprétation par Mistral la cible correctement.

`state_change` est traité comme **récurrent par défaut** (il se redéclenche à chaque occurrence
future de l'événement, cas d'usage principal = minuterie) — voir §12 pour la limitation connue sur
ce point (ambiguïté non résolue entre récurrent et ponctuel selon la formulation).

## 4. Gestion des macros et planifications

Opérations disponibles (nœud `gestion`, champ `operation`) : `lister`, `activer`, `desactiver`,
`supprimer`, `modifier`. Cible (`cible`) : `planification`, `macro`, ou `tout` (uniquement pour
`lister`).

**Les opérations ne sont pas toutes valables pour les deux cibles** : `activer`/`desactiver`/
`modifier` ne s'appliquent qu'aux **planifications** — une macro n'a pas d'état actif/inactif,
c'est une définition disponible par son nom, jamais "programmée". Seuls `lister` et `supprimer`
s'appliquent aux macros. Une planification désactivée reste stockée mais n'a plus de minuteur
actif (ni de suivi d'état pour un trigger `state_change`) ; sa réactivation la reprogramme
immédiatement selon son `trigger`.

**⭐ v1.7 — Désignation par numéro** : pour une opération ciblant une planification (`name`),
`CommandHandler.resolvePlan()` accepte le nom exact **ou** l'identifiant numérique (§2 `id`) sous
forme de chaîne (ex: "désactive la planification 3" → `name: "3"`) — le nom reste toujours
prioritaire si une planification porte littéralement ce nom. Mistral transmet le numéro tel quel,
sans tenter de le résoudre lui-même (`regles_mistral.txt` §2.7) — c'est `planificateur` qui connaît
la correspondance numéro→nom.

## 5. Stockage

Deux fichiers YAML locaux, gitignorés comme tout `data/` — `data/planificateur/planificateur-macros-v1.0.yaml` et
`data/planificateur/planificateur-planifications-v1.0.yaml` — gérés par un `ConfigFileManager` sur le même
principe que RFXCOM/AREXX : validation Zod avant écriture, écriture atomique (fichier temporaire
puis renommage), copie de sauvegarde `.bak` du fichier précédent conservée à chaque sauvegarde.

`data/planificateur/config.yaml` (objet nu, ex-section `planificateur` de l'ancien fichier unique
— voir `techniques-socle-ha-mqtt_specs` §7) ne garde que les paramètres généraux — pas de
connexion MQTT propre à héberger, contrairement à EVOO7/Nommage.

### 5.1 Reprise après coupure et fenêtre de rattrapage

Toutes les planifications actives sont reprogrammées au démarrage du service, à partir du contenu
chargé depuis le fichier de planifications — mais pas par un simple recalcul complet depuis
l'instant présent :

- **Triggers temporels** : `next_fire_at` (§2), persisté à chaque programmation/réarmement, est
  comparé à l'heure courante au démarrage.
  - Si l'échéance est encore dans le futur, le minuteur reprend sur le **délai réellement
    restant** — un `delay`/`duration` en cours ne repart pas intégralement à zéro après un
    redémarrage.
  - Si l'échéance est dépassée mais dans la **fenêtre de rattrapage** configurée
    (`catchUpWindowSeconds`, §10), le déclenchement a lieu **immédiatement**, puis la planification
    reprend son cycle normal (recalculée si récurrente).
  - Si l'échéance est dépassée au-delà de cette fenêtre, le déclenchement lui-même est
    **abandonné** — logué explicitement et marqué `missed` (§2), visible dans l'UI (§11) jusqu'à
    la prochaine exécution réussie. **⭐ v1.9** : si le trigger est **récurrent**, la planification
    est immédiatement **reprogrammée pour sa prochaine occurrence** (`next_fire_at` recalculé par
    rapport à l'heure courante — saute donc naturellement l'occurrence manquée) ; sinon (`delay`/
    `date`/`duration`, non récurrent), elle est terminée (`completed_at`) comme avant. Corrige un
    bug réel où un trigger récurrent manqué au-delà de la fenêtre restait actif sans aucun
    minuteur, indéfiniment, jusqu'au redémarrage suivant (qui retombait dans le même cas).
- **Triggers `state_change`** : `pending` (§2) trace les entités pour lesquelles une exécution était
  en cours au moment de la coupure. Au redémarrage, chacune est **redéclenchée à neuf** (nouvelle
  interprétation Mistral, nouvelle attente complète) plutôt que reprise sur le temps restant — voir
  §12 pour la raison (la durée d'attente n'est jamais connue avant l'interrogation de Mistral, donc
  jamais persistable telle quelle). L'entité finit toujours par recevoir l'action attendue, mais
  potentiellement plus tard qu'en l'absence de redémarrage.

## 6. La boucle de déploiement — quatre déclencheurs, un seul mécanisme

C'est le comportement structurant de l'application, celui qui garantit qu'aucune planification ni
macro n'est jamais exécutée depuis une version figée. **Quatre situations distinctes y aboutissent,
toutes vers le même point d'exécution unique :**

- **Un déclencheur programmé arrive à échéance** (§3.1) — `planificateur`, via son minuteur, initie
  la boucle.
- **Une entité change d'état de la façon surveillée par un trigger `state_change`** (§3.2) —
  `planificateur`, via son suivi des changements d'état HA, initie la boucle ; le contexte de
  déploiement est alors enrichi de `triggered_entity_id` (l'entité réellement à l'origine de ce
  déclenchement précis), pour que Mistral puisse cibler correctement une action sans lieu explicite.
- **L'utilisateur prononce directement le nom d'une macro connue** ("je vais me coucher") — `ia`,
  ayant la liste des macros en contexte, reconnaît la correspondance et initie immédiatement le
  même déploiement.
- **Un appel d'outil `executer_action` est résolu** (`fonctionnelles-ia_specs` §7/§8) — traité comme
  une planification à un seul coup, immédiate et non répétitive (`trigger: {type:"delay",
  seconds:0}`, §3.1), envoyée au même point d'exécution.

Dans les quatre cas, le même mécanisme de déploiement s'applique et produit le même format de sortie
(`execution`) :

1. Construction d'un **contexte de déploiement** : la `phrase_originale` (de la planification
   déclenchée, de l'utterance qui a nommé la macro, ou de la phrase à l'origine de l'appel d'outil),
   le contenu intégral de toutes les macros connues, l'état courant des entités HA concernées
   (`HaStructureRegistry.getAllEntities()` du socle — jamais un client HA maison, l'entité renvoyée
   porte déjà un état vivant, mis à jour en temps réel), l'horodatage courant, et — uniquement pour
   un déclenchement `state_change` — `triggered_entity_id`.
2. Interrogation de Mistral (via `ia`) avec les mêmes règles domotiques que pour une conversation
   normale.
3. Réponse sous forme d'`ExecutionPayload` — une séquence **plate et linéaire** : toute `macro_ref`
   déjà déployée récursivement (plus aucune référence dans le résultat), toute `condition` déjà
   évaluée et résolue (le nœud disparaît, seule la branche retenue subsiste), tout aléatoire déjà
   résolu en valeur fixe.
4. `planificateur` exécute chaque étape de la séquence reçue, dans l'ordre (§7, §8) — quelle que
   soit l'origine du déclenchement, `planificateur` reste toujours le seul exécuteur final. Pour un
   déclenchement `state_change`, cette exécution peut être annulée en cours de route si la même
   entité redéclenche entre-temps (§3.2).

Une macro qui s'appelle elle-même directement ou indirectement (boucle infinie) est détectée côté
`ia` avant l'envoi du résultat, dans les quatre cas de figure — `planificateur` ne reçoit jamais de
séquence bouclée.

## 7. Résolution des actions vers un service HA

Une étape `action` porte une intention exprimée avec le vocabulaire QUOI/OÙ (`verbe`, `quoi`,
`lieux`, `valeur?`) — jamais directement un service HA nommé, Mistral ne connaissant pas la
nomenclature interne de HA. `planificateur` la résout en `resolved_service_call` (§2) selon deux
niveaux :

1. **Verbes sans valeur associée** (allumer, éteindre, basculer) → services **génériques** de HA
   (`homeassistant.turn_on`/`turn_off`/`toggle`), qui routent eux-mêmes vers le domaine réel de
   l'entité ciblée (`light`, `switch`, ...) — pas besoin de connaître ce domaine à l'avance.
2. **Verbes portant une valeur** (baisser/augmenter une luminosité, régler une température, ouvrir
   un volet à un pourcentage) → service spécifique au domaine concerné (`light.turn_on` avec
   `brightness_pct`, `climate.set_temperature`, `cover.set_cover_position`, ...) — HA n'a pas
   d'équivalent générique pour ces cas.

Cette table verbe→service **prolonge** la table verbe→quoi déjà définie dans les règles domotiques
(`regles_mistral.txt` §0.1) — même liste de verbes, une colonne supplémentaire côté code plutôt
qu'une nouvelle table indépendante à maintenir.

L'entité ciblée (`entity_id`) est résolue séparément, via `HaStructureRegistry`, à partir du couple
`quoi`/`lieux` — la même taxonomie que celle utilisée partout ailleurs dans le socle.

**⭐ v1.7 — Résolution déléguée au graphe de lieux centralisé** (`HaStructureRegistry.
getEntitiesByQuoiAndLieux()`, voir `techniques-socle-ha-mqtt_specs` §8.3.2 pour le mécanisme
complet) — remplace le repli à deux niveaux de la v1.6 (area HA puis `lieu_precis` seulement, qui
ne couvrait ni les phrases composées ni les lieux qualifiés par étage/zone) :
1. **Terme unique** (cas normal) : `lieu_precis` propre à l'entité, ou lieu/area dans le sous-arbre
   de containment (area, `lieu_pere`, `lieu_grand_pere`) du terme — corrige "éteins le salon"
   ciblant toute l'area "Salle" au lieu du seul "Salon" (bug initial v1.6), et généralise à
   "toilettes de l'étage"/"toilettes du rez-de-chaussée" (deux areas HA distinctes ne se
   distinguant que par leur `lieu_pere`).
2. **Phrase composée**, en repli si le terme unique ne matche aucune entité du `quoi` : découpée en
   mots (hors mots vides français), chacun doit matcher (ET) — "éteins le plafonnier de la
   chambre" (`lieu_precis` "plafonnier" partagé par plusieurs pièces + area qualifiante "chambre")
   sans élargir à tort à toutes les pièces ayant elles aussi un plafonnier.

Le contexte envoyé à `ia` pour la réinterprétation à l'exécution (§6, `entities_snapshot`) inclut
`lieu_precis` **et** `lieu_pere` par entité, en plus de `area_id` — sans `lieu_precis`, Mistral ne
voyait jamais "Salon" nulle part (seulement l'area "Salle", identique pour les 4 lumières de la
pièce) et normalisait par prudence vers l'area englobante ; sans `lieu_pere`, Mistral ne pouvait pas
distinguer deux areas de même `quoi` générique ne différant que par l'étage. `regles_mistral.txt`
instruit Mistral à résoudre lui-même un lieu qualifié par étage vers le nom d'area réel (ex:
"toilettes du haut"), et à ne jamais séparer un `lieu_precis` et son area qualifiante en deux
éléments de `lieux` (élargirait à tort) — toujours les combiner en une seule phrase, laissant le
repli phrase composée du graphe de lieux la résoudre.

Si le verbe n'est pas connu de cette table (ambigu, nouveau, non encore prévu), la résolution
échoue silencieusement et `resolved_service_call` reste absent — voir §8 pour le repli associé.

## 8. Exécution des actions

Étape `wait` : simple attente (durée déjà résolue en secondes par `ia`, §6).

Étape `action` :
- Si `resolved_service_call` a pu être calculé (§7) : exécution **directe** via
  `HaCommandService.sendCommand()`/`HaWsClient.sendCommand()` (déjà disponibles dans le socle, avec
  retry/timeout) — chemin principal, rapide, déterministe.
- Sinon (verbe non résolu) : **repli** sur l'agent de conversation natif de Home Assistant
  (`HaWsClient.processConversation(order, language)`, nouvelle méthode du socle) — le texte de
  l'ordre en langage naturel (`order`) est transmis tel quel, HA reste responsable de le traduire
  en commande réelle. Filet de sécurité pour les cas non couverts par la table du §7, pas le
  chemin principal.

**⭐ v1.6 — Deux journaux distincts sur le tableau de bord** (demandes utilisateur, la première
n'étant pas suffisante — l'ACK de `homeassistant.turn_on`/`turn_off` par HA confirme seulement la
diffusion du service, jamais l'exécution réelle par le device cible, Mistral pouvant confabuler un
succès sur cette seule base) :
- **Journal des actions reçues de `ia`** (`planificateur:actions:list`, 20 dernières) : chaque
  `ia:command`/`ia:tool:execute` reçu, avec la requête et la réponse complète (`CorrelatedReponse`).
- **Détail des commandes envoyées à HA** (`planificateur:ha-commands:list`, 20 dernières) : pour
  chaque étape `action` exécutée (§8, quel que soit le déclencheur — minuteur, macro dite, message
  `ia`), l'issue réelle (`resolved` service HA appelé / `fallback_conversation` / `ignored`),
  succès/échec, l'entité à l'origine pour un déclenchement `state_change`, et la prochaine
  date/heure d'exécution programmée pour un déclencheur temporel récurrent (`next_fire_at`, déjà
  réarmé par `SchedulerRuntime` au moment de la trace).

## 9. Communication interne (EventBus)

Voir `fonctionnelles-ia_specs` §11 pour la table complète des événements (`ia:command`/`:reply`,
`ia:tool:execute`/`:reply`, `planificateur:deploy`/`:reply`) — même helper de corrélation local des
deux côtés, pas de mécanisme partagé fourni par le socle.

Le suivi des triggers `state_change` (§3.2) ne passe pas par un nouvel événement EventBus : il
s'appuie directement sur `HaWsClient.onStateChanged()` (abonnement additif, déjà utilisé par le
socle lui-même pour alimenter `HaStructureRegistry`) — pas de nouveau canal à documenter ici.

## 10. Configuration

`data/planificateur/config.yaml` : noms/emplacement des fichiers de données (§5),
paramètres du délai d'attente pour les échanges avec `ia` (`deployTimeoutMs`), et la fenêtre de
rattrapage après coupure (`catchUpWindowSeconds`, §5.1 — défaut 300s).

## 11. UI

**⭐ v1.7 — Écran principal refondu** (demande utilisateur), injecté dans le Shadow DOM du
`ModuleContainer` du socle comme les autres tableaux de bord :

- **Résumé de statut** (nombre de macros, de planifications, de minuteurs actifs) au-dessus de deux
  onglets :
  - **Onglet "Planifications"** (par défaut) : **liste numérotée** des planifications
    (`planificateur:planifications:list`, triée par `id` croissant) — chaque ligne porte le
    numéro (`#id`), le nom (facultatif à l'affichage — une planification sans nom n'affiche que sa
    phrase), un badge actif/inactif (+ "manqué" si `missed`, §2/§5.1, disparaît automatiquement à
    la prochaine exécution réussie), la phrase d'origine entre guillemets, et la prochaine
    exécution (`next_fire_at` formaté, "Réactif (changement d'état)" pour un trigger
    `state_change`, "Non programmée" si absente et inactive). Boutons Activer/Désactiver/Supprimer
    par ligne (§4, socket events déjà existants).
  - **Onglet "Journal"** : les deux journaux déjà existants (§8) — actions reçues de `ia`, détail
    des commandes envoyées à HA — déplacés ici tels quels (déjà existants depuis la v1.6, pas de
    changement de contenu, seulement d'emplacement).
- **Boîte de dialogue de création** ("➕ Nouvelle planification") : un simple champ texte pour la
  phrase, **aucune saisie structurée** — soumise telle quelle à `ia` via `ia:test:send` (même
  mécanisme que le formulaire de test du tableau de bord `ia`, `fonctionnelles-ia_specs` §13),
  réponse affichée via `ia:test:reply` (succès/échec, distingué par `planificateurReply.success`
  plutôt que par le seul `reply.success` qui ne couvre que l'absence d'erreur technique côté `ia`,
  pas la validation métier — un simple échange conversationnel sans JSON structuré produit
  compterait sinon à tort comme un succès de création). Liste et statut rafraîchis automatiquement
  après une création réussie.

Page dédiée (`config.html`) : gestion des **macros seules** — recentrée le 12/08/2026 (commit
`cc62069`), ne montre plus les planifications en double avec le tableau de bord comme avant cette
date. Accessible via le bouton "📋 Macros" du tableau de bord (`index.html`) — **uniquement** depuis
là depuis le 15/08/2026 : l'entrée équivalente sous Paramètres Techniques (`PLANIFICATEUR_MENU_CONFIG.pages`,
page `gestion`) a été retirée à la demande de l'utilisateur, jugée redondante avec cet accès
applicatif. L'affichage du contenu JSON complet (étapes d'une macro, détail d'un déclencheur) y
reste à concevoir en détail, hors périmètre de cette version.

**⭐ v1.7 — Mise à jour live des dashboards déjà ouverts** : une planification créée ou gérée par
conversation (`ia:command` — voix, ou la boîte de dialogue de création qui emprunte le même canal)
pousse désormais `planifications:list`/`status` à tous les clients connectés, pas seulement à celui
qui a initié la requête (`PlanificateurService.wireEventBus()`, sur tout `ia:command` de type
`planification`/`gestion`/`macro`) — corrige un manque constaté en testant en direct la nouvelle
boîte de dialogue : seules les actions déclenchées depuis l'UI elle-même (`PLANIFICATION_ACTIVER`
etc.) réémettaient déjà la liste ; une planification créée par conversation restait invisible sur un
dashboard déjà ouvert jusqu'à un rafraîchissement manuel.

## 12. Limitations connues / décisions

- **Stockage en fichiers locaux**, pas via Home Assistant — décision alignée sur le reste du socle
  (RFXCOM, AREXX, EVOO7 stockent tous en local). Une synchronisation multi-machines des
  planifications via HA resterait à concevoir séparément si ce besoin devenait réel, hors périmètre
  de cette version.
- La table verbe→service (§7) ne couvre que les verbes déjà connus des règles domotiques — tout
  nouveau verbe nécessite une mise à jour synchronisée des deux côtés (prompt et table de
  résolution), sans quoi il retombe silencieusement sur le repli du §8.
- Le repli vers l'agent de conversation HA (§8) dépend de sa disponibilité au moment précis du
  déclenchement — pas de nouvelle tentative automatique ; à surveiller en usage réel.
- **Reprise après coupure imprécise pour `state_change`** (§5.1) : contrairement à un trigger
  temporel, un trigger `state_change` interrompu par un redémarrage ne reprend pas sur le temps
  d'attente exact restant — la durée n'est connue qu'après réinterprétation par Mistral, jamais
  persistée telle quelle. L'entité redéclenche à neuf plutôt que de rester bloquée.
- **Ambiguïté récurrent/one-shot non résolue** pour `state_change` (§3.2) : une phrase du type
  "quand X, fais Y" ne précise pas si la règle doit se répéter à chaque occurrence future ou ne
  s'appliquer qu'une fois — traité comme récurrent par défaut (cas d'usage principal = minuterie),
  sans demande de clarification à l'utilisateur. Un mécanisme de clarification reste à concevoir
  séparément.
- **`missed` non suivi par entité pour une règle `state_change` de domaine** : si une entité
  précise rate sa fenêtre de rattrapage sous une règle par défaut ("toutes les lumières"), c'est
  silencieusement rejoué au prochain déclenchement de cette entité, sans indicateur UI dédié —
  seul le niveau "planification" a un indicateur `missed` visible pour l'instant (temporel
  uniquement, voir §5.1).

## 13. Historique

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| 1.9 | 26/08/2026 | Claude | **Correctif §5.1** : un trigger récurrent manqué au-delà de la fenêtre de rattrapage (`catchUpWindowSeconds`) n'était jamais reprogrammé — `resumeOrSchedule()` marquait `missed: true` mais seul le cas non récurrent poursuivait le cycle (`completed_at`), un récurrent manqué restait actif sans minuteur indéfiniment. Corrigé : reprogrammation immédiate pour la prochaine occurrence dans ce cas (`schedulerRuntime.schedule()`, `next_fire_at` recalculé depuis maintenant). Bug réel signalé par l'utilisateur ("éteindre toutes les lumières tous les jours à 2h30", plus jamais déclenchée après un arrêt de service au moment précis du tir), vérifié corrigé en conditions réelles sur la planification concernée (`handler.ts:150-165`, commit `17a9069`). |
| 1.7 | 11/08/2026 | Claude | **Écran principal en liste numérotée** (§11) : indicateur actif/inactif, nom facultatif, phrase, prochaine exécution ; journaux existants déplacés en onglet séparé ; boîte de dialogue de création (phrase soumise à `ia` pour validation). **Identifiant numérique stable** `id` (§2), résolution par numéro en plus du nom pour les opérations de gestion (§4, `CommandHandler.resolvePlan()`). **Résolution de `lieux` déléguée au graphe de lieux centralisé** de `HaStructureRegistry` (§7, voir `techniques-socle-ha-mqtt_specs` §8.3.2) — généralise le repli `lieu_precis` v1.6 aux phrases composées et aux lieux qualifiés par étage, `entities_snapshot` enrichi de `lieu_pere` (§6/§7) en plus de `lieu_precis`. **Mise à jour live des dashboards** après une planification créée/gérée par conversation (§11), manque constaté en testant la nouvelle boîte de dialogue. Toutes demandes utilisateur, session du 10-11/08/2026. |
| 1.6 | 10/08/2026 | Claude | **Résolution de `lieux` sur le lieu précis en repli de l'area HA** (§7, corrige "éteins le salon" ciblant toute la salle), `entities_snapshot` enrichi de `lieu_precis` (§6). **Deux journaux sur le tableau de bord** (§8) : actions reçues de `ia`, détail des commandes envoyées à HA (issue réelle, entité déclenchante, prochaine exécution). Toutes demandes utilisateur, session du 10/08/2026. |
| 1.5 | 03/08/2026 | Claude | **Déclencheur réactif `state_change`** (nouvelle §3.2) : règles sur changement d'état d'entité (précise via `entity_id`, ou par défaut sur tout un domaine via `domain`), priorité entité>domaine, comportement "minuterie" (annulation/relance par couple planification/entité). §6 étendue à quatre situations de déclenchement (ajout du changement d'état), contexte de déploiement enrichi de `triggered_entity_id` pour le ciblage implicite. Nouvelle §5.1 : persistance d'une heure cible absolue (`next_fire_at`) et reprise sur le temps réellement restant après coupure pour les triggers temporels (corrige un comportement antérieur où `delay`/`duration` repartaient intégralement à zéro à chaque redémarrage, jamais documenté comme tel), fenêtre de rattrapage configurable (`catchUpWindowSeconds`, §10) au-delà de laquelle un déclenchement est abandonné et marqué `missed` (badge UI, §11). §2 étendue (`next_fire_at`/`pending`/`missed` sur `PlanificationDefinition`, champs de `Trigger` pour `state_change`). Limitations connues (§12) : reprise imprécise pour `state_change` (durée d'attente jamais persistée), ambiguïté récurrent/one-shot non résolue, `missed` non suivi par entité pour une règle de domaine. |
| 1.4 | 24/07/2026 | Claude | (Voir version archivée — pas de changement de contenu identifié entre 1.3 et 1.4 au moment de cette révision, seule la date d'en-tête diffère.) |
| 1.3 | 23/07/2026 | Claude | **Révision majeure**, en miroir de `fonctionnelles-ia_specs` v1.3 : `resolved_service_call` n'est plus un placeholder inactif — c'est le mécanisme d'exécution **principal**, peuplé par `planificateur` lui-même (nouvelle §7 "Résolution des actions vers un service HA", table verbe→service à deux niveaux, prolongeant la table verbe→quoi des règles domotiques). §6 réécrite : trois déclencheurs convergent désormais vers le point d'exécution unique (minuteur, macro directe, **appel d'outil résolu** — nouveau, traité comme planification immédiate via `{type:"delay",seconds:0}`). §8 (ancienne §7) réécrite : exécution directe via `resolved_service_call` en chemin principal, agent de conversation HA relégué en repli. Toutes les références vers `fonctionnelles-ia_specs` corrigées suite à sa renumérotation. |
| 1.2 | 23/07/2026 | Claude | Corrections de références croisées uniquement, suite à la renumérotation de `fonctionnelles-ia_specs` en v1.2. |
| 1.1 | 23/07/2026 | Claude | Clarification §4 : `activer`/`desactiver`/`modifier` ne s'appliquent qu'aux planifications. §6 réécrite : deux déclencheurs (minuteur, macro directe) convergent vers le même mécanisme. §3 : précision que la résolution trigger→délai est un calcul déterministe en code, jamais fait par l'IA. |
| 1.0 | 23/07/2026 | Claude | Version initiale — spécification de l'application avant implémentation. |
