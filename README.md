# dimotic-ha

**« Allume le salon », « éteins tout dans dix minutes », « si la lumière de la vitrine s'allume, allume le plan de travail » — dit en français, tout court, et exécuté chez moi pour de vrai.**

dimotic-ha pilote une maison réelle au-dessus de Home Assistant : matériel radio des années 2010 (RFXCOM 433 MHz), capteurs propriétaires, chauffe-eau connecté au protocole reverse-engineeré, compteur EDF, relais GPIO, écrans tactiles muraux faits maison — le tout derrière une seule couche de commande en langage naturel, comprise sans notion de syntaxe ni de nom d'entité à retenir.

La compréhension du langage ne repose pas sur un seul mécanisme : un **interpréteur déterministe** reconnaît d'abord les formulations courantes par grammaire (résolution en ~20-30 ms, zéro appel réseau), un **cache** des cent dernières phrases court-circuite même cet interpréteur pour une commande déjà vue, et seule une formulation réellement nouvelle sollicite un modèle de langage (Mistral, ou Claude en comparatif) — qui reste indispensable pour tout ce que la grammaire ne couvre pas : formuler une planification complexe, clarifier une ambiguïté, discuter.

## Ce que ça fait, au quotidien

- **Ordres immédiats** : *"éteins la lumière du salon"*, *"règle le thermostat du salon à 20.5"*, *"ferme le volet de la chambre"* — n'importe quelle formulation raisonnable, résolue sur le lieu et l'appareil réels, pas sur un identifiant technique.
- **Planifications dites, pas configurées** : *"tous les jours à 2h30 éteins toutes les lumières"*, *"dans dix minutes allume la cuisine"* — la phrase originale est reprise à *chaque* déclenchement, jamais figée une fois pour toutes : modifier la règle change le comportement sans reconstruire l'automatisation.
- **Réactions à un événement** : *"si la lumière de la vitrine s'allume, allume le plan de travail"* — déclenché sur un vrai changement d'état HA, pas un minuteur.
- **Séquences avec attente** : *"allume le salon. attendre trois heures. éteins le salon."* — utile pour les macros, exécuté comme une seule commande ordonnée.
- **Reprise fiable après coupure** : une planification récurrente manquée pendant un arrêt de service (redémarrage, maintenance) n'est pas perdue — elle se reprogramme automatiquement sur sa prochaine occurrence, avec un indicateur "manqué" visible tant qu'elle n'a pas rejoué avec succès.
- **Des plans de maison tactiles** (HAPLAN) : des écrans ESP32-S3 muraux affichant le plan réel de chaque étage, icônes tap-to-toggle, plusieurs plans embarqués, mise à jour par-dessus le réseau — pas une tablette générique, un vrai plan de la maison qu'on touche.

## Le matériel piloté

| Domaine | Ce que ça couvre |
|---|---|
| RF433 (RFXCOM) | Interrupteurs, capteurs, volets radio historiques |
| Zigbee2MQTT / GPIO | Relais et capteurs Zigbee ou câblés (via mqtt-io) |
| AREXX BS1000/BS500 | Capteurs température/humidité (push, poll ou USB) |
| EVOO7 | Chauffe-eau connecté — protocole natif reverse-engineeré (plus de traducteur MQTT tiers) |
| Téléinformation EDF | Lecture de compteurs en mode historique sur bascule GPIO |
| ESP32-S3 (HAPLAN) | Plans de maison tactiles muraux |
| Satellite vocal ESPHome | Pipeline Whisper/Piper/openWakeWord pour l'assistant vocal HA |

Chaque intégration est une application indépendante — en ajouter une nouvelle ne touche jamais au socle ni aux autres.

## Comment ça marche

```
Phrase (voix HA Assist, ou texte)
        │
        ▼
   Cache (100 dernières phrases) ──── déjà vue ──▶ exécution directe
        │ inconnue
        ▼
   Interpréteur déterministe ──── grammaire reconnue ──▶ exécution directe
        │ non reconnue
        ▼
   Mistral / Claude (outils + JSON structuré) ──▶ exécution
```

Le **socle** (`applications/core`) porte la connexion WebSocket Home Assistant et MQTT, un `EventBus` interne, et la supervision des applications — il ne peut pas être désactivé et ne connaît le métier d'aucune application spécifique. Chaque **application** tourne en process séparé, autonome (son propre `package.json`), et communique via le socle plutôt que directement entre elles.

| Application | Rôle |
|---|---|
| `core` | Socle technique — WebSocket HA, MQTT, supervision |
| `ia` | Compréhension du langage — interpréteur déterministe, cache, routage Mistral/Claude |
| `planificateur` | Le seul point d'exécution réel des commandes — planifications, macros, séquences |
| `nommage` / `arbreouquoi` | Taxonomie QUOI/OÙ — noms et hiérarchie de lieux déduits, pas saisis à la main |
| `scriptsha` | Dépôt et diffusion de scripts/automatisations HA, synchronisés entre instances |
| `rfxcom` / `arexx` / `evoo7` / `teleinfo` / `rpigpio` | Intégrations matérielles |
| `haplan` / `espdisplay` | Écrans tactiles muraux et orchestration des périphériques ESP |

Plusieurs instances de dimotic-ha tournent en parallèle sur des machines différentes de la maison (un Raspberry Pi par zone, plus une machine plus ancienne) — un service partagé (macros, scripts) se propage automatiquement entre elles.

## Origines

dimotic-ha reprend et modernise un système domotique personnel développé sur près de dix ans (le projet "dimotic"/`zdidnode*`) : certaines logiques — comme l'interpréteur de langage déterministe — sont directement reprises de ce prédécesseur, réécrites et débarrassées de leurs défauts connus plutôt que réinventées à partir de rien.

C'est un projet personnel, en développement actif, qui pilote une vraie maison au quotidien — pas une démo.

## Licence

MIT — voir [`LICENSE`](LICENSE).

---

*Développé en grande partie en binôme avec Claude Code — les spécifications techniques versionnées (`specs/`) et l'historique de développement en gardent la trace complète.*
