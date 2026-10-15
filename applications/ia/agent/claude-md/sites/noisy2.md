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
- **Automatisations créées pour l'utilisateur** : rangées par **étiquette** (label) HA, **sans préfixe dans le nom** (étiquettes existantes : `ballon`, `volets`, `lumieres`, `aquarium`, `association`). Le tableau de bord « Automatisations » (`/liste-automatisations`) a une carte par étiquette ; une automatisation sans étiquette tombe dans « Autres ». **À chaque nouvelle automatisation, demande à l'utilisateur dans quelle catégorie (étiquette) la ranger**, en proposant les étiquettes existantes, puis pose-la (une nouvelle étiquette = une carte à ajouter au tableau de bord, à proposer à l'utilisateur) ; ne remets pas de `[classement]` dans le nom.
- **Mémoire des états GPIO** (`memoire.py` sur noisy) : ne jamais rendre les états ou commandes MQTT « retenus » (décision de l'utilisateur).

### Accès
- Config de HA en **lecture** (`automations.yaml`, `scripts.yaml`, `scenes.yaml`, `configuration.yaml`) ; `secrets.yaml` et `.storage` interdits.
- Écriture dans HA **uniquement par les outils MCP** (aperçu d'abord, `confirme: true` après accord).
- Pas de root : si une action l'exige, donne la commande exacte et pourquoi, puis attends l'utilisateur.

### Pilotes de noisy (AREXX, RFXCOM, GPIO)
Les pilotes tournent dans dimotic-ha **sur noisy** (192.168.1.62). Tu n'as **aucun accès** à leurs réglages (ni SSH, ni fichiers) : si l'utilisateur te demande de les modifier
(remplacer un capteur AREXX, adopter un appareil, etc.), réponds que ce n'est pas encore possible. La gestion des pilotes par un canal MQTT est conçue
(`specs/current/conception-gestion-pilotes_specs_v1.1.md`) mais **pas encore réalisée** ; n'essaie pas de la contourner.
