# Applications → Home Assistant directement — Spécifications (v1.1)

**Date :** 21/10/2026 — **Statut :** migration terminée pour les 6 applications concernées (essais réels sur ha2 le 21/10/2026) — **Suite de :** `conception-integration-taxonomie-ha` v1.2, `conception-structure-taxonomie-ha` v1.1

## 1. Objet
Faire lire la taxonomie « quoi / où » par les applications **directement dans Home Assistant** (intégration `dimotic_taxonomie`), au lieu du registre du cœur. Les applications sont migrées **une par une** ; le cœur n'est pas modifié (il garde son registre et son pont pour les applications non migrées). Étape vers le remplacement du cœur en 5.0.0.

## 2. Principe
- **Le jeton reste dans le cœur.** L'application appelle `HaBridgeClient.callWs({ type: 'dimotic_taxonomie/…' })` : le cœur relaie la commande vers HA (relais générique existant, `HaQueryBridge` `callWs`). Aucune application ne reçoit de secret.
- **Un client commun** : `HaTaxonomieClient` (`applications/core/src/application/HaTaxonomieClient.ts`, exporté par `core/dist/exports`) :
  `getEntity(id)`, `getAllEntities(domaine?)`, `getEntitiesByQuoiAndLieux(quoi, lieux, includeTechnical)`, `getQuoiCatalog()`, `getLieuCatalog(exclus?)` — **asynchrones**.
- **Conversion à la volée** (`versEntiteDuCoeur`) de l'entité de l'intégration vers `HaStructuredEntity` : les applications gardent leur code, seul un `await` s'ajoute.
- **Pas de repli** : si HA ou l'intégration ne répond pas, l'appel échoue avec un message qui l'indique (« l'intégration dimotic_taxonomie est-elle installée et HA joignable ? »).
- **Prérequis par machine** : l'intégration `dimotic_taxonomie` ≥ 0.1.2 installée dans le HA de la machine **avant** de déployer une application migrée.

## 3. Ce qu'ajoute l'intégration (0.1.2)
Chaque entité renvoyée porte maintenant `attributs` (attributs courants de l'état), `derniere_modification` (ISO) et `appareil` (nom de l'appareil). Le domaine `climate` donne le « quoi » **Thermostat** (au lieu de Température, qui est une mesure) — **écart volontaire avec le cœur**, que le banc de parité admet explicitement (copie du module avec l'ancienne ligne, test `test_parite`).

## 4. Validation
- `HaTaxonomieClient` : 8 tests unitaires (conversion, commandes envoyées, domaine, absence de repli).
- **Conversion** : 879 entités de ha2 comparées au registre du cœur (`tools/comparer_format.js`) : 0 écart (champs, quoi_ids, attributs, appareil, pièce, date).
- **Chaque application** : classe réelle compilée exécutée contre HA (essai réel de ha2) ou, pour ce qui dépend des attributs de la 0.1.2, contre la sortie de l'intégration sur les mêmes données.

## 5. État de la migration (21/10/2026)
| Application | Appels migrés | Résultat (essai réel sur le HA de ha2, intégration 0.1.2) |
|---|---|---|
| `testcycle` | `getEntity` | thermostat du poêle → `heat` ; entité absente → erreur claire |
| `scriptsha` | `getAllEntities('automation'\|'script')` (import) | 47 candidats, identique à l'ancien calcul |
| `tasmota` | `getAllEntities` + `getLieuCatalog`, **mis en cache** (≤ 1 relecture/min) | 108 « quoi », 103 lieux |
| `arbreouquoi` | instantané relu avant chaque émission (page ouverte, rafraîchissement, changement d'état limité à 1/5 s, `ha:ready`) ; constructions d'arbre inchangées et synchrones | 879 entités, 112 nœuds, 36 « quoi », détail d'une entité, rafraîchissement |
| `planificateur` | recherche (`resolution`, `conditions`) directe ; amorçage de `state-watcher` (avant l'abonnement, échec journalisé) | « poêle / salle à manger » → 1 entité ; condition poêle allumé → vrai ; HA injoignable → erreur claire |
| `ia` | adaptateur `HaLectureDirecte` (surface minimale de `HaBridgeClient`) : recherche par HA, lectures synchrones sur un instantané (relu au démarrage, à `ha:ready`, en arrière-plan au-delà de 30 s, `fresh()` pour un état courant) | 879 entités, 36 « quoi », recherche, validation de références (valide / « dragon » refusé), 47 automatisations, 6 tests dédiés |
| `nommage`, `rfxcom`, `evoo7`, `esps-assemble` | aucun appel concerné | — |

**Effet de bord connu** : `climate` = Thermostat. Une planification, une condition ou une phrase visant « température » ne trouve plus les thermostats ; aucune planification ni macro de ha2 n'est concernée (vérifié).

## 6. Points ouverts
- États en direct (`arbreouquoi`, `planificateur`, `ia`) : aujourd'hui le cache du pont est tenu à jour par les événements de changement d'état ; en lecture directe, relecture à la demande ou abonnement `dimotic_taxonomie/abonner` à décider application par application.
- Catalogue des lieux : les lieux « précis virtuels » (noms d'appareils, numéros de série) y figurent (106 contre 72 avant la classe effective) ; atténuation différée.
- Le relais `callWs` du cœur laisse passer toute commande WebSocket de HA, pas seulement `dimotic_taxonomie/*` (déjà vrai avant ce chantier) ; un filtre est possible plus tard.
