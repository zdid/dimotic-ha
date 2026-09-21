# Checklist — vérification du site de noisy après branchement physique de noisy2

À exécuter une fois le RPi4 "noisy2" physiquement branché sur le LAN du site de noisy (même
réseau que le RPi3 "noisy", `192.168.1.0/24`, passerelle `192.168.1.254`). Fait suite à la session
du 21/09/2026 où les adresses ont été préconfigurées à l'avance (IP fixe `192.168.1.201`, adresses
WireGuard fantômes remplacées par les vraies IP LAN) pendant que noisy2 était encore chez
l'utilisateur — donc non fonctionnel/non vérifiable jusqu'à ce branchement.

## 1. Réseau

- [ ] **Sur le routeur du site de noisy** : élargir la plage DHCP pour inclure `.201` (la plage
      actuelle s'arrête peut-être avant), PUIS positionner une **réservation DHCP** (bail fixe, par
      adresse MAC) sur `192.168.1.201` pour cette machine (noisy2) — plus robuste qu'une IP fixe
      configurée seulement côté noisy2 (NetworkManager) : évite qu'un autre appareil se voie
      attribuer `.201` par erreur, et rend l'attribution visible/documentée dans l'interface du
      routeur. MAC `eth0` de noisy2 : `dc:a6:32:34:2c:f5`.
- [ ] **Interfaces WiFi (relevées le 21/09/2026, non utilisées à ce jour — les deux machines sont
      en filaire)** : vérifier l'attribution d'adresse pour le WiFi de chaque machine sur le
      routeur du site de noisy, et les nommer `noisy-w`/`noisy2-w` (distinct des noms filaires
      `noisy`/`noisy2` déjà utilisés) pour éviter toute confusion si le WiFi est activé un jour.
      MAC `wlan0` noisy : `b8:27:eb:60:1f:49`. MAC `wlan0` noisy2 : `dc:a6:32:34:2c:f6`.
- [ ] Confirmer que noisy2 a bien démarré avec l'IP fixe `192.168.1.201` (`ip addr show eth0`,
      configurée via NetworkManager, connexion "Wired connection 1").
- [ ] Vérifier qu'aucun autre appareil du site de noisy n'utilise déjà `192.168.1.201` (collision).
- [ ] `ping 192.168.1.254` (passerelle du site) et `ping 8.8.8.8` (accès internet réel) depuis
      noisy2.
- [ ] SSH direct `ssh root@192.168.1.201` depuis une machine du même LAN (en plus de l'accès
      WireGuard existant `10.10.10.3`, qui doit continuer à fonctionner aussi).

## 2. Connectivité directe (adresses fixées par avance le 21/09/2026)

- [ ] `arexx/config.yaml` (noisy2) : `bs1000Address: 192.168.1.47` — vérifier que le BS-1000 répond
      réellement en direct (`curl http://192.168.1.47/` depuis noisy2) et que des lectures de
      température/humidité arrivent dans dimotic-ha.
- [ ] HA "Onduleur 2MPPT" (Solarman) : `inverter_host: 192.168.1.119` — vérifier que l'entité
      remonte des valeurs réelles (pas "indisponible").
- [ ] HA "Onduleur 4MPPT" (Solarman) : `inverter_host: 192.168.1.157` — idem.
- [ ] Si l'un des trois ne répond pas en direct : vérifier que l'IP LAN réelle du site n'a pas
      changé depuis la dernière fois (BS-1000/onduleurs pourraient avoir une IP DHCP différente
      aujourd'hui) — comparer avec `MIGRATION_noisy_2026-09-10.md` §5quater et remettre à jour si
      besoin.

## 3. Architecture MQTT — décision à prendre sur place (point soulevé le 21/09/2026)

Le pont mosquitto temporaire noisy2→noisy (via le tunnel WireGuard) a été retiré le 21/09/2026.
Le commentaire d'origine du pont disait explicitement *"une fois sur place, **lien direct sans
pont**"* — ce qui suggère que `core.mqtt.host` de noisy2 (actuellement `127.0.0.1`, son propre
broker local) devrait en réalité pointer vers l'adresse réelle du broker de noisy
(`192.168.1.62:1883`), et non vers un broker local à noisy2.

- [ ] Décider : noisy2 garde-t-il son propre broker mosquitto local (pour HA uniquement, ou pour
      rien du tout), ou dimotic-ha (et éventuellement HA) de noisy2 doivent-ils se connecter
      **directement** au broker de noisy (`192.168.1.62:1883`) ?
- [ ] Si connexion directe retenue : modifier `data/core/config.yaml` sur noisy2 —
      `ha.mqtt.host: 192.168.1.62` (au lieu de `127.0.0.1`) — puis redémarrer `dimotic-ha`.
- [ ] Vérifier ensuite que `nommage`/`rpigpio` sur noisy2 voient bien les entités publiées côté
      noisy (mêmes topics que ce que le pont temporaire rendait visible avant son retrait).
- [ ] Si le broker local de noisy2 devient inutile, décider s'il faut l'arrêter
      (`docker stop mosquitto` sur noisy2) ou le laisser tourner sans rôle.

## 4. Cibles gossip obsolètes (trouvé le 21/09/2026, pas encore corrigé)

`data/core/config.yaml` (`targets`/`haStackTargets`) référence encore l'ancienne IP DHCP de noisy2
(`192.168.1.19`, remplacée par `192.168.1.201`) sur les DEUX machines :

- [ ] noisy2 : `targets[noisy::noisy2].host` → doit devenir `192.168.1.201`.
- [ ] noisy : `targets[noisy2].host` et `haStackTargets[falbala_817412::noisy2].host` → doivent
      devenir `192.168.1.201`.
- [ ] Vérifier d'abord si un redémarrage/cycle de gossip après le branchement physique corrige ça
      tout seul (noisy2 se réannonçant avec sa vraie IP actuelle) — sinon corriger à la main comme
      fait pour les cibles `sauvegarde` le 21/09/2026.

## 5. Santé générale

- [ ] `docker inspect dimotic-ha --format '{{.State.Health.Status}}'` → `healthy` sur les deux
      machines.
- [ ] Aucune erreur `ZodError`/"Échec du démarrage" dans les logs des deux machines
      (`docker logs dimotic-ha`).
- [ ] `sauvegarde` démarre proprement sur les deux machines (targets nettoyées le 21/09/2026, mais
      à reconfirmer après le passage sur site).
- [ ] `nommage` sur noisy2 : `mqttConnected: true`, entités reçues (vérifier via
      `docker logs dimotic-ha | grep nommage:status`).

## 6. Nettoyage final (une fois tout confirmé fonctionnel)

- [ ] Si le broker local de noisy2 est abandonné (voir §3), envisager de retirer le conteneur
      mosquitto de noisy2 du `compose.yaml`/`docker-compose` local, ou le laisser en réserve.
- [ ] Mettre à jour `MIGRATION_noisy_2026-09-10.md` avec le statut final "noisy2 physiquement sur
      site, opérationnel" et le résultat de la décision MQTT prise au §3.
- [ ] Supprimer ce fichier de checklist une fois tous les points validés (ou le déplacer en note de
      clôture dans `MIGRATION_noisy_2026-09-10.md`).
