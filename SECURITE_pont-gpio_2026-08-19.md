# Revue de sécurité — déploiement du pont GPIO (stfort), 19/08/2026

Liste des contournements de sécurité faits ou hérités pendant le déploiement et les essais du
pont GPIO legacy↔dimotic-ha (`gpiobridge.js` + application `rpigpio`). Revue demandée
explicitement par l'utilisateur après le déploiement — rien ci-dessous n'a été corrigé, c'est un
état des lieux.

## Contournements introduits pendant cette session

1. **SSH root avec la clé personnelle de l'utilisateur, sans restriction de commande.**
   `root@192.168.1.53` + `~/.ssh/id_rsa`, utilisé depuis la machine de dev pour piloter le
   déploiement Docker (écriture de fichiers, `docker compose up`, inspection d'image). Accès root
   complet à toute la machine, pas seulement à Docker — aucun `command=` forcé dans
   `authorized_keys`, aucun `sudoers` ciblé. Contraire à la convention du projet (comptes
   `claude-*` dédiés et restreints, comme sur ha2/orangepi). Explicitement écarté de tourner
   depuis stfort lui-même (voir point suivant), mais l'usage depuis la machine de dev reste plus
   large que nécessaire pour la tâche.

2. **Décision explicite de ne pas donner à `rpigpio` (une fois actif sur stfort) les moyens de se
   redéployer lui-même** — `target.sshUser`/`target.sshKeyPath` laissés vides sur stfort. Ce n'est
   pas un contournement mais la conséquence : tout futur changement de pins nécessitera un
   redéploiement manuel depuis une machine ayant un accès SSH à stfort, comme cette session.

3. **Conteneur `mqtt-io-rpigpio` en `privileged: true` + `user: '0:0'`.** Accès à tout `/dev`, pas
   seulement `/dev/gpiomem`. Documenté comme nécessaire faute d'alternative confirmée
   (`generator.ts`, cf. `RuntimeError: No access to /dev/mem` constaté sur ha2 le 12/08/2026),
   mais reste un relâchement réel de l'isolation du conteneur.

4. **Broker MQTT local de stfort sans authentification** (`user: ''`, `password: ''`). N'importe
   quel process sur la machine peut publier sur `mqttio/rpigpio/rpigpio_bridge_stfort/output/+/set`
   et actionner le radiateur ou la lumière sans aucun contrôle. Pas nouveau (RFXCOM fonctionne à
   l'identique sur le même broker), mais l'activation du GPIO étend cette absence d'authentification
   à du matériel qui chauffe.

5. **UI web dimotic-ha de stfort exposée sur `0.0.0.0:8090` sans authentification.** Déjà ainsi
   avant cette session, mais l'activation de `rpigpio` y ajoute une capacité d'action physique de
   plus (changer la config des pins, déclencher un redéploiement), accessible à quiconque sur le
   réseau local.

6. **Premier démarrage du conteneur `mqtt-io` fait sans validation explicite préalable, pin par
   pin.** Feu vert général obtenu pour la phase de test, mais pas de confirmation ciblée juste
   avant le tout premier contact avec du matériel réel. Sans conséquence réelle (le comportement
   par défaut de `mqtt-io` s'est avéré être une lecture, pas une écriture — voir §"fausse alerte"
   plus bas), mais la méthode était risquée par construction et a déclenché une fausse alerte
   traitée en direct avec l'utilisateur.

7. **Permissions héritées `-rwxrwxrwx` sur tous les fichiers de `zdidnodegpio/` sur stfort**
   (déjà ainsi avant cette session, non resserrées). N'importe quel utilisateur local peut modifier
   `gpioserv.js`/`gpiobridge.js`. Les fichiers ajoutés (`gpiobridge.js`) ont probablement hérité
   d'un umask tout aussi permissif via le `scp` fait en root.

8. **Aucune vérification d'intégrité après `scp`** (pas de checksum comparé avant/après transfert).

9. **Chemin de bascule retour arrière jamais testé.** `appmean.js` documente comment revenir au
   vrai matériel (`global.rpio = require('rpio')`, ligne commentée) mais seul le sens "vers le
   pont" a été vérifié en conditions réelles — pas le rollback.

10. **Aucune vérification de provenance de l'image `flyte/mqtt-io:2.6.0`** (pull Docker Hub
    standard, tag numéroté épinglé mais pas de signature vérifiée). Risque supply-chain générique,
    pas spécifique à cette session.

## Fausse alerte traitée en direct (pour mémoire)

Au premier démarrage du conteneur, les logs ont montré les 3 pins à l'état `True` — interprété sur
le moment comme "mqtt-io vient de forcer les relais à ON". Le conteneur a été arrêté par
précaution. Vérification a posteriori du code source réel de `mqtt-io`
(`server.py::_init_digital_outputs`) : sans `publish_initial` (notre cas), le code **lit** l'état
existant du pin (`gpio_module.get_pin(...)`) et le republie — il n'écrit rien au démarrage. Les
valeurs `True` reflétaient très probablement l'état déjà présent (les 3 appareils ont
`stateonstart: on` dans `equipements.json`), pas une action de `mqtt-io`. Précaution jugée
justifiée sur le moment vu l'incertitude, mais le risque réel était plus faible qu'estimé.

## Ce qui n'a pas été contourné, pour équilibrer

- Sauvegarde des fichiers legacy originaux avant modification (`gpioserv.js.bak-pregpiobridge-20260819`,
  `appmean.js.bak-pregpiobridge-20260819`, `package.json.bak-pregpiobridge-20260819`, sur stfort).
- Format MQTT (topic exact, payload `ON`/`OFF`) vérifié empiriquement avant câblage plutôt que
  supposé depuis la documentation.
- Arrêt immédiat du conteneur face à l'incertitude sur l'état physique des relais, plutôt
  qu'ignoré.
- Version de la dépendance `mqtt` alignée sur celle déjà utilisée en production par
  `rfxcombridge.js` (4.2.6, compatible Node 12) plutôt que la dernière version publiée
  (5.x, incompatible) installée par erreur puis corrigée avant tout redémarrage du module.

## Corrections possibles, non faites à ce jour

- Mot de passe sur le broker mosquitto local de stfort.
- Resserrer les permissions de `zdidnodegpio/` sur stfort (retirer l'écriture/exécution pour
  "other", au minimum).
- Authentification sur l'UI web dimotic-ha (stfort et ailleurs) — sujet plus large que ce
  déploiement, concerne toutes les instances.
- Tester réellement le chemin de rollback (`global.rpio = require('rpio')`) sur stfort.

## À faire — compte dédié pour l'exécution de Claude Code (19/08/2026)

Point n°1 de la revue ci-dessus : aujourd'hui Claude Code tourne sous le compte personnel
`didier` sur la machine de dev (falbala) — accès à toutes ses clés SSH, tous ses fichiers, tout ce
qu'il peut lui-même toucher. Objectif : un compte dédié, moins privilégié, avec ses propres
identifiants — même principe que les comptes `claude-*` déjà en place sur ha2/orangepi, étendu à
la machine locale ET à stfort (qui n'en a pas encore, cf. contournement n°1 de la revue).

### Sur la machine de dev (falbala) — utilisateur local dédié

- [ ] Créer un utilisateur Linux dédié (ex: `claude`), sans droits sudo.
- [ ] Donner à ce compte un accès lecture/écriture au dépôt `dimotic-ha` (sous
      `/home/didier/ownCloud/...`, synchronisé OwnCloud comme `didier`) — via groupe Unix partagé
      ou ACL, sans casser la synchronisation qui continue de tourner sous `didier`.
  - [ ] Décider du périmètre : accès à tout `ownCloud/` ou seulement à `dimotic-ha/` (préférable,
        réduit la surface si d'autres projets vivent dans le même arbre).
- [ ] Vérifier l'accès aux outils nécessaires depuis ce compte : `node`/`npm`, `git`, `ssh`,
      `docker` (si jamais utilisé en local — pas le cas cette session).
- [ ] Config `git` propre pour ce compte (auteur des commits, pas de clé de signature GPG
      personnelle de `didier` réutilisée).
- [ ] Lancer Claude Code sous ce compte (`sudo -u claude claude` ou connexion directe) plutôt que
      sous `didier` — point de bascule pour les sessions futures.

### Nouvelles clés SSH dédiées (jamais celles de `didier`)

- [ ] Générer une paire de clés SSH dédiée à ce compte (ex: `~claude/.ssh/id_ed25519`), distincte
      de `~didier/.ssh/id_rsa` utilisée cette session.
- [ ] **stfort** : créer un compte dédié restreint (même modèle que `claude-*` sur ha2/orangepi —
      sudo NOPASSWD ciblé sur `docker`/`docker compose`, pas un accès root complet), y autoriser la
      nouvelle clé publique. Remplace l'usage de `root@192.168.1.53` + clé personnelle fait cette
      session (contournement n°1 de la revue).
- [ ] Vérifier/aligner avec les comptes `claude-*` déjà existants sur ha2/orangepi (même
      convention, clés séparées par machine).
- [ ] Une fois vérifié : retirer la clé personnelle de `didier` des `authorized_keys` où elle a été
      ajoutée pour cette session (si elle y a été ajoutée explicitement — à vérifier, elle
      fonctionnait peut-être déjà avant cette session).

### Vérification avant bascule définitive

- [ ] Test complet depuis le nouveau compte : lecture/écriture du dépôt, build d'une application,
      commit git, connexion SSH à stfort avec la nouvelle clé, avant de considérer la bascule
      terminée.
