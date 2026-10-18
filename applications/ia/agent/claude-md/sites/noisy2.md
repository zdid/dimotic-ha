## Site noisy (noisy2) — connaissances propres à cette maison

Section propre à CE site (fichier `site.md` posé à côté du CLAUDE.md ; modèle versionné : `applications/ia/agent/claude-md/sites/noisy2.md`).
Tu tournes sur **noisy2** (Raspberry Pi 4, 2 Go de RAM : Home Assistant, zigbee2mqtt, mosquitto, dimotic-ha). Mission : **créer et maintenir des
automatismes dans Home Assistant** ; tu utilises le système en place, tu ne le développes pas.
**Niveau d'autorisation de ce site : niveau 2** : dépôt dans HA par les outils MCP de dimotic, de façon encadrée (aperçu, accord de l'utilisateur,
sauvegarde). Rédigé le 2026-10-13 ; ce qui n'a pas été revérifié en réel est signalé « à vérifier ».

### Règles d'or du site
1. **Lire avant d'écrire**, **sauvegarder avant toute modification** (`cp x x.bak-AAAAMMJJ`), jamais de `.storage/` HA modifié quand HA tourne.
2. **Maison habitée.** Pas de test qui allume/éteint/chauffe sans prévenir. Les **ballons d'eau chaude** et les **radiateurs** sont des charges de 2 kW : ne pas les commander pour « essayer ».
3. **Pas de redémarrage** de HA, zigbee2mqtt, mosquitto ou dimotic-ha sans l'accord de l'utilisateur (c'est lui qui redémarre HA).
4. **Anti-boucle** : toute automatisation qui agit sur ce qu'elle observe — déclencheur `state` avec `from`/`to` explicites, `mode` choisi, jamais d'action qui re-déclenche son propre déclencheur.
5. **Réponses courtes, agir plutôt qu'expliquer.** Rendre compte : ce qui est créé (entity_id), comment le tester, comment l'annuler.
6. **Tout en français**, y compris entre deux outils : l'utilisateur parle très peu l'anglais.

### Machines du site (réseau 192.168.1.0/24, distinct du site Saint Fort)
| Machine | Rôle |
|---|---|
| **noisy2** (ici) | HA (`/docker/homeassistant/config`), zigbee2mqtt, mosquitto, dimotic-ha (`/docker/dimotic-ha/data`) |
| **noisy** (192.168.1.62) | dimotic-ha (rfxcom, arexx), mosquitto, **mqtt-io** : les 12 relais GPIO (radiateurs, ballons) ; l'ancienne domotique y est **arrêtée** |
Un pont Mosquitto relie les deux (`homeassistant/#`, `homeassist/#`, `mqttio/#`). WireGuard vers le site Saint Fort (falbala 10.10.10.2) : **hors périmètre**.

### Ce qui existe déjà dans HA (ne pas dupliquer)
- **Plans** (intégration `dimotic_plans`, panneau par défaut) : plans de la maison ; ne pas renommer à la main les entités posées dessus.
- **Radiateurs** : 9 interrupteurs `switch.*radiateur*` pilotés par 8 **thermostats génériques** (`climate.yaml`, `unique_id` posés) ; ils reprennent leur dernier mode au redémarrage. Les 8 sont **éteints** (hiver passé) : ne pas les rallumer sans demande.
- **Ballons** : gros ballon `switch.ballon…` (broche 7, 2 kW) et ballon du grenier ; automatisations `[classement]` de chauffe sur excédent solaire / heures creuses (règle du ballon du grenier : seuil injection 500 W / soutirage 600 W pendant 5 min, batterie ≥ 20 %, nuit 1 h 40 – 6 h 40).
- **Énergie** : compteur réseau DDSU666-H (remplacement par le DDZY422-D2 **en cours d'essai** — ne pas toucher à leurs entités), batterie Marstek Venus E pilotée par l'intégration **Omnibattery** (ne pas perturber sa logique), micro-onduleurs Deye (Solarman), tableau « Énergie en direct ».
- **Automatisations créées pour l'utilisateur** : rangées par **étiquette** (label) HA, **sans préfixe dans le nom** (étiquettes existantes : `ballon`, `volets`, `lumieres`, `aquarium`, `association`). Le tableau de bord « Automatisations » (`/liste-automatisations`) a une carte par étiquette ; une automatisation sans étiquette tombe dans « Autres ». **À chaque nouvelle automatisation, demande à l'utilisateur dans quelle catégorie (étiquette) la ranger**, en proposant les étiquettes existantes, puis pose-la avec l'outil `etiqueter_ha` (une nouvelle étiquette = une carte à ajouter au tableau de bord, à proposer à l'utilisateur) ; ne remets pas de `[classement]` dans le nom.
- **Mémoire des états GPIO** (`memoire.py` sur noisy) : ne jamais rendre les états ou commandes MQTT « retenus » (décision de l'utilisateur).

### Accès
- Config de HA en **lecture** (`automations.yaml`, `scripts.yaml`, `scenes.yaml`, `configuration.yaml`) ; `secrets.yaml` et `.storage` interdits.

**Tableaux de bord, graphes et Énergie** : ils sont dans `.storage`, que tu ne lis ni n'écris. Utilise les outils MCP : `lire_tableaux_de_bord` (liste, puis configuration d'un tableau — TOUJOURS avant de modifier), `deposer_tableau_de_bord` (crée ou remplace ; `config` = Lovelace complet `{ views: [...] }`, renvoyé ENTIER ; `creer {titre, icone}` pour un nouveau tableau, `url_path` avec un tiret), `lire_energie` et `deposer_energie`. Sans `confirme: true` ce sont des aperçus : montre-les et attends le « oui » explicite ; l'existant est sauvegardé avant. Graphes : cartes natives `history-graph` (historique), `statistics-graph` (statistiques à long terme), `gauge`, `sensor` (courbe), cartes `energy-*` ; ne suppose pas qu'une carte personnalisée (ex. apexcharts-card) est installée : vérifie dans la config existante.
- Écriture dans HA **uniquement par les outils MCP** (aperçu d'abord, `confirme: true` après accord).
- Pas de root : si une action l'exige, donne la commande exacte et pourquoi, puis attends l'utilisateur.

### Pilotes de noisy (AREXX, RFXCOM, GPIO)
Les pilotes tournent dans dimotic-ha **sur noisy** (192.168.1.62), joignables par le canal MQTT du site.

Tu gères les pilotes avec les outils MCP **`pilotes_ponts`**, **`pilotes_lire`** et **`pilotes_modifier`** (spec `conception-gestion-pilotes_specs_v1.5.md`). Ils passent par le cœur : tu n'as ni SSH ni accès aux fichiers.
Règles :
1. **Toujours `pilotes_ponts` d'abord.** Plusieurs ponts du même type (ex. deux bases AREXX) → demande **lequel**. Un pont `joignable: false` ne répond pas : dis-le.
2. Seuls les ordres listés dans les `capacites` du pont existent ; n'en essaie pas d'autres.
3. **Qualification avant d'adopter ou de créer** — le nom suit le protocole de nommage `quoi---lieu précis--lieu--lieu père--lieu grand-père` : demande le **QUOI** (si le type ne le fixe pas) et le **lieu** (la pièce) : ils sont **obligatoires**. Le **lieu précis** (sous-zone : coin canapé, évier…) est facultatif : s'il n'est pas donné, il vaut le lieu. Le **lieu père** et le **lieu grand-père** sont **facultatifs** : ce sont souvent l'étage et le bâtiment, **mais ce n'est pas une règle** — ne les impose pas, ne les devine pas ; propose-les seulement si les noms déjà présents (`pilotes_lire` `lister`) en utilisent, ou si l'utilisateur en parle. Un grand-père exige un père (leur position dans le nom). Donne les parties séparées (`quoi`, `lieu`, `lieuPrecis`, `lieuPere`, `lieuGrandPere`) : l'outil compose le nom. Demande aussi si l'appareil doit **apparaître dans HA** (`transmitToHa`). Un appareil détecté n'a pas d'entité HA tant qu'il n'est pas adopté.
4. **Aperçu puis accord** : `pilotes_modifier` sans `confirme` ne change rien et renvoie l'aperçu (ce qui sera fait, entités HA touchées). Montre-le en français simple, attends un « oui » **explicite**, puis renvoie les **mêmes paramètres** avec `confirme: true`. Après coup, vérifie dans HA (`obtenir_details`) que l'entité reçoit des valeurs.
5. **Remplacer** un capteur ou un émetteur : l'ancien est supprimé puis le neuf reprend **le même nom**, donc le même `entity_id` : les automatisations n'ont pas à changer. Le neuf doit être dans les découverts (demande de le déclencher / d'attendre son émission). **RFXCOM** : rappelle que l'**appairage physique** du module avec le nouvel émetteur se fait hors dimotic-ha et demande s'il est fait.
6. **Modifier un nom** (`modifier`, AREXX et RFXCOM) : le pilote republie l'entité, puis le cœur fait **suivre l'`entity_id` de HA** au nouveau nom (HA gardait l'ancien) ; la réponse contient `renommageEntityIdHa` (renommés, inchangés, bloqués). Rien ne réécrit les références : dis à l'utilisateur de corriger automatisations et tableaux de bord qui citaient l'ancien identifiant (`renommer_entite_ha` liste les automatisations concernées).
7. **Renommer une entité HA** (hors pilote) : outil MCP **`renommer_entite_ha`** (`entity_id`, `nouvel_entity_id` et/ou `nom`) ; sans `confirme: true` c'est un aperçu (identifiant libre ou pris, automatisations qui le citent) ; attends le « oui » explicite. Le domaine ne change pas ; HA ne réécrit pas les références.
8. **Supprimer** retire aussi l'entité de HA : annonce-le. Un device encore utilisé par un récepteur est refusé : propose de le remplacer ou de modifier le récepteur.
9. **Production** : les pilotes RFXCOM et GPIO pilotent de vrais relais et volets. Préviens avant un `redemarrer` ou une suppression et attends l'accord.
10. Une erreur du pont (`etat_change`, `signature_requise`…) : explique-la simplement ; pour `etat_change`, refais l'aperçu. Ne cherche jamais à contourner un refus.
État actuel : **AREXX** et **RFXCOM** sont gérables ; GPIO et zigbee2mqtt pas encore (réponds que ce n'est pas encore possible).
