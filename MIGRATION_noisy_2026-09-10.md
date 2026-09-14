# Migration noisy — site distant : nouvelle clé USB 64 bits pour le RPi3 + RPi4 pour Home Assistant

**Rédigé le 10/09/2026, consolidé le 10/09/2026 (pivot en cours de session).** Conception établie en
conversation, **aucune action exécutée** sauf une (`wireguard-tools` installé sur `noisy`, voir §1).
Document opérationnel (comme `RUNBOOK.md`) — volontairement **hors du processus `specs/`** :
WireGuard / infra réseau déjà classé "hors du dépôt de code" dans
`specs/current/fonctionnelles-supervisor_specs_v2.8.md` §14bis.

---

## 0. Résumé de la cible

Deux machines sur le site distant `noisy` (500 km) :

| Machine | Rôle | Comment on la prépare |
|---|---|---|
| **RPi3 existant** (reste sur place) | Garde le transceiver **RFXCOM** (USB) et les **GPIO** (relais de puissance). Fait tourner : l'ancienne domotique — RFXCOM/GPIO réduits à un **shim MQTT**, **module Arexx inchangé** (continue de lire le BS-1000) — + **dimotic-ha** (`rfxcom`/`rpigpio` actifs) + un **mosquitto local**. | **Nouvelle clé USB 64 bits** construite ICI (chroot QEMU sur le PC de dev), envoyée pour **remplacer le SSD** actuel. Le SSD est renvoyé à l'utilisateur (rollback). |
| **RPi4 neuf** (à recevoir) | Héberge **Home Assistant** (Docker, comme `ha2`) — le "cerveau". Intègre les **3 loggers Solarman (onduleurs Deye)** (Modbus TCP via Solarman), une **prise Tuya** (batterie), et fait tourner l'app **`arexx` de dimotic-ha** (lecture du BS-1000 de noisy). Ne touche pas au GPIO/RFXCOM. | Instance complète (HA + mosquitto + dimotic-ha) montée et testée sur le **PC de dev** (amd64), puis transférée au RPi4 (arm64) par **sauvegarde HA → restauration**. |

Lien entre les deux : **MQTT**. Une fois les deux sur place, réseau local direct. Un tunnel
**WireGuard** sert (a) au montage/test du RPi4 à distance avant expédition, (b) à l'accès admin
distant pérenne — voir §3 (partie non résolue, l'utilisateur y réfléchit).

**Pourquoi ce pivot (10/09/2026)** : la piste initiale "chirurgie à distance sur le RPi3 existant"
a buté sur une accumulation de blocages — voir la recon §1 (buster EOL + apt cassé, Docker masqué,
RAM saturée, pas de mot de passe admin Bbox). Repartir d'une base 64 bits propre, préparée et testée
au banc, est plus simple et plus sûr.

---

## 1. Contexte & recon

- **Accès SSH `noisy`** : `root@dimoticnoisy.duckdns.org` (DuckDNS ; commande locale `noisy` =
  `ssh -X root@dimoticnoisy.duckdns.org`, lien `/home/didier/bin/noisy`).

### 1.1 Recon système du RPi3 existant (10/09/2026, vérifié en SSH)

| | |
|---|---|
| Matériel | Raspberry Pi 3 Model B Rev 1.2 (ARMv8 — **le 64 bits est donc possible**) |
| OS actuel | Raspbian 10 (**buster**), Debian 10.13, `armv7l` **32 bits**, noyau 5.10.103-v7+ |
| Python | **3.7.3** — insuffisant pour Solarman/Deye (≥ 3.8), d'où le RPi4 pour cette partie |
| Docker | 24.0.2 **installé hors apt** (`docker-ce` inconnu d'apt), **`docker.service` masqué** (`systemctl mask`, quasi sûrement pour la RAM), `containerd` actif. Dépôt Docker `download.docker.com/linux/raspbian buster` **encore en ligne** (candidat 26.1.4). |
| ⚠️ apt / EOL | **buster EOL, apt en grande partie cassé** : `raspbian.raspberrypi.org/raspbian buster` → 404, `buster-backports` retiré. Répondent encore : `archive.raspberrypi.org/debian buster` + dépôt Docker. → une des raisons du pivot vers une base neuve. |
| WireGuard | ✅ **`wireguard-tools 1.0.20200827` installé le 10/09/2026** (venait d'`archive.raspberrypi.org`, pas de DKMS, module noyau déjà présent). `wg`/`wg-quick` OK, `modprobe wireguard` OK. *(Sera de toute façon réinstallé proprement sur la nouvelle base 64 bits.)* |
| Disque | SSD 118 Go, 14 % utilisés |
| RAM | ⚠️ 923 Mio total, **~36 Mio libres, swap 99/99 plein** — ancienne domotique + mosquitto local saturent la machine. Contrainte réelle : faire tourner dimotic-ha (Docker) en plus est serré, comme sur stfort. |
| RFXCOM | `/dev/ttyUSB0` (`/dev/ttyUSBRFXCOM`), modèle **RFXtrx433** (`usb-RFXCOM_RFXtrx433_A1YKN7SN`) — plus ancien que le 433XL de stfort. |
| Réseau local | routeur = **Bbox** `192.168.1.254` ; RPi3 = `192.168.1.62` (**DHCP dynamique**, à fixer). Redirection port `22` TCP déjà en place. **Pas de mot de passe admin Bbox** (bloque la config manuelle de redirection de port). |

### 1.2 Recon de l'ancienne domotique (`/home/domotique/node_applications/`)

- **Superviseur** : `zdidnodesupervisor/app` (systemd `nodesupervisor.service`), spawne ~10 sous-modules
  (`vrfx`, `vdatadomo`, `vcron`, `vsurvey`…). Config : `zdiddefaults.properties` + surcharge
  `domo.properties` ; données du site sous `/home/datadomonoisy/`.
- **`node_modules` partagé** (`/home/domotique/node_applications/node_modules`, ~50 modules servis) —
  pas de `node_modules` par module. Modules natifs présents (armv7) : **`rpio`**, **`serialport`/@serialport**.
  Pas de `rfxcom` au top (vendorisé), pas de `onoff`/`pigpio`.
- **GPIO** = `zdidnodegpio` → dépend de **`rpio`**, `require('rpio')` en direct. Migration = modèle
  stfort (`gpioserv.js` inchangé sauf 1 ligne `require('rpio')` → `global.rpio` ; `gpiobridge.js`).
- **RFXCOM** = 3 couches :
  1. `zdidnoderfxcom433e` — logique, **déjà en MQTT** (`app.js` ligne 5 :
     `require('../zdidnodedomoutil/mqttdimotic')`), aucune dép native.
  2. `zdidnodefork4rfxcom` — **`serialport`** + `queue`, process fork qui possède le port série.
  3. `zdidnodefork4rfxcom2` — la lib npm **`rfxcom` 2.4.0** (`node-rfxcom`) vendorisée.
  Archi fork **différente de stfort** — reste à lire `zdidnoderfxcom433e/app.js` + le fork en
  entier pour savoir exactement quoi remplacer (le fork série ? `rfxcom433e` ?). **Non fait, c'est
  le gros morceau restant.**
- **Arexx** = `zdidnodearexx` → deps `pause-queue`/`async`/`ping`, **pas de serialport** — lecture
  **réseau HTTP** du BS-1000. **Reste inchangé et actif sur le RPi3** (décision utilisateur du
  10/09/2026, revient sur un choix antérieur). En parallèle, l'app `arexx` de dimotic-ha tournera
  **sur le RPi4** et lira aussi le BS-1000 — deux consommateurs du même endpoint HTTP (à confirmer :
  mode poll des deux côtés = coexistence OK ; si le BS-1000 est en mode *push* vers une seule
  adresse, à revoir).

### 1.3 Modèles côté stfort (à adapter)

- `zdidnodegpio/gpiobridge.js` (6,3 ko, 28/08/2026) : expose une interface `rpio`-compatible
  (init/open/close/write) parlant MQTT au pilote `rpigpio` de dimotic-ha. Broker lu depuis
  `global.properties` (`mqtt.server.addressport`), pas codé en dur.
- `rfxcombridge.js` : classe `ShimRfxCom` (même interface publique que `rfxcom.RfxCom` : EventEmitter
  + `initialise()` + `sendRaw()`) parlant MQTT au pilote `rfxcom`, réexporte le reste de la lib tel
  quel. `rfxcomserv.js` inchangé (`global.rfxcom` posé dans `appmean.js`).
- Sur stfort : `zdidnoderfxcom433e` + `-ha` (variante migrée) + `-old` (sauvegarde) coexistent.

### 1.3bis Inventaire des équipements (`/home/datadomo/equipements.json`, 56 matériels, modifié le 13/11/2024) — récupéré le 11/09/2026

> ⚠️ Récupéré d'abord par erreur depuis `/home/datadomonoisy/` (copie périmée de 2021, avec du X10
> qui n'existe plus). Le **vrai** répertoire de données est **`/home/datadomo/`** (`zdiddefaults.properties`
> → `context.path.data=/home/datadomo`). Chiffres ci-dessous = ceux de `/home/datadomo/`.

| protocole (ancien système) | nb | Nature | Migration |
|---|---|---|---|
| `ac` | **25** | RFXCOM Lighting2 AC (`num` = `0x........./N`) — volets/lumières | ✅ **rfxcom** |
| `gpio` | **12** | Sorties relais — pins `phys7,11,12,13,15,16,18,22,29,31,33,37`. **10 radiateurs** (salle, sdb, chambre, cuisine, ch. drystan, ch. evan, salle, toilettes) + garage : `journuit` (phys16, inversé, init ON), `ballon` (phys12), `ballon` (phys7, non inversé, init ON), `chauffage` (phys33). | ✅ **rpigpio** — 12 pins à mapper dans `data/rpigpio/` |
| `arexx` | 8 | Capteurs température Arexx via BS-1000 | ancien module RPi3 + app `arexx` RPi4 |
| `virtualther` | 8 | Thermostats virtuels | ❌ hors périmètre |
| `elec3` | 1 | Compteur d'énergie RFXCOM (`0x8c02`, garage) | ✅ rfxcom (réception) |
| `temp2` | 1 | Capteur température RFXCOM (`0xde01`, toilettes) | ✅ rfxcom (réception) |
| `zigbee` | 1 | Capteur Aqara temp/humidité `0x00158d00...`, lieu `essaizigbee` — **device de TEST**, pas un vrai déploiement | ❌ hors périmètre (rien à porter) |

**Pas de X10 dans la config réelle** → pas de `mochad` ni de `zdidnodex10` à prévoir sur la clé.

**Config MQTT de l'ancien système** (`/home/datadomo/domo.properties`) :
`mqtt.server.addressport=192.168.1.62:1883` (= **le RPi3 lui-même**, mosquitto local),
`mqtt.prefix.topic=dimotic`, user/passwd vides. → sur la clé, `127.0.0.1:1883` (équivalent direct).

**⭐ BS-1000 AREXX = `192.168.1.47:80`** (`arexx.temp.address`/`port`, interval 50) — résout un point
ouvert. Le "logXX" (hostname) reste à relever mais l'IP suffit.

**Autres** : Web UI ancienne sur port `8081`. `gps=48.83,2.57` (région parisienne) dans
`domo.properties` = valeur de gabarit non corrigée — `sms.others.servers.addressport` pointe vers
`dimoticlessables.duckdns.org` (Les Sables-d'Olonne, ~cohérent avec "500 km").
`/home/domotique/` contient aussi `mochad-0.1.16/`, `openzwave-1.6.1052/`, `bin/`, `udevrules/` —
récupérés (`~/noisy-migration/noisy-src/domotique/`, 176 Mo sans node_modules/tarballs).

### 1.3ter Templates de migration récupérés de stfort (11/09/2026)

Copiés dans `~/noisy-migration/stfort-templates/` (hors dépôt) :

- **`zdidnoderfxcom433e-ha/`** complet — la variante migrée de stfort. Diff `-old` → `-ha` (à
  rejouer sur noisy, en tenant compte que noisy fait `require('../zdidnodefork4rfxcom2')` là où
  stfort fait `require('rfxcom')`) :
  - `rfxcomserv.js` : **1 ligne** — `rfxcom = require('rfxcom')` → `rfxcom = global.rfxcom`.
  - `appmean.js` : ajout en tête `global.rfxcom = require('./rfxcombridge')` (+ ligne commentée
    `require('rfxcom')` pour revenir au matériel) ; suppression du `require('fs')`, de la constante
    `RFXCOMDEVICE`, de `startDevice()`/`fs.existsSync()` et de la boucle `setInterval` de
    surveillance 60 s ; remplacé par `rfxcomserver = new rfxcomserv.Rfxcomserv('dimotic-ha-bridge')`
    (device factice, ignoré par `ShimRfxCom`).
  - **`rfxcombridge.js`** (~18 ko) : classe `ShimRfxCom` (EventEmitter + `initialise()` +
    `nextMessageSequenceNumber()` + `queueMessage()`), réexporte le reste de `rfxcom`. Constantes en
    tête : `BRIDGE_INSTANCE` (= `bridgeInstance` du `data/rfxcom/config.yaml` de la clé),
    `MQTT_URL` (`mqtt://127.0.0.1:1883`). Décodage `queueMessage` : `packetNumber` 0x10=lighting1,
    0x11=lighting2, 0x1a=rfy → publie `rfxcom/{BRIDGE_INSTANCE}/{deviceId}/set` (format double
    underscore). Réception : abonnement `.../+/state` → événements `lighting1`/`lighting2`/`elec23`/`th`.
  - Bugs déjà corrigés dans ce template (à conserver) : client MQTT fantôme au redémarrage
    (`global.__rfxcombridgeActiveClient`), format de topic double underscore, `queueMessage` vs
    `sendRaw`.
- **`zdidnodegpio/`** complet — sur stfort c'est **déjà la version migrée** (`gpioserv.js` ligne 5 =
  `const rpio = global.rpio;`), avec les `.bak-pregpiobridge-20260819` = originaux d'avant. Diff :
  - `gpioserv.js` : 1 ligne (`require('rpio')` → `global.rpio`).
  - `appmean.js` : `global.rpio = require('./gpiobridge')` avant le `require('./gpioserv')`.
  - **`gpiobridge.js`** (~6,3 ko) : objet interface `rpio` (init/open/close/write ; read/poll non
    implémentés — aucun GPIO en entrée). URL broker lue de `global.properties`
    (`mqtt.server.addressport`), pas codée en dur (`resolveMqttUrl()`). Convention : id de pin
    mqtt-io = position physique du connecteur (`phys<N>` → `<N>`), pas de table BCM à maintenir.

### 1.4 Autres éléments du site

- **3 loggers Solarman (onduleurs Deye)**, installés physiquement sur `noisy` — voir §3 pour les
  adresses réelles retrouvées le 13/09 (l'ancienne `192.168.1.146` n'existe plus).
  Protocole **Solarman** (encapsulation Modbus TCP ; lib probable `pysolarmanv5`, **Python ≥ 3.8**).
  Connectivité Modbus TCP déjà confirmée (via tunnel SSH improvisé), tests complémentaires à faire —
  ils tourneront **sur le RPi4** (HA), pas sur le RPi3.
- **Prise Tuya** pour piloter une batterie → intégration **Tuya Local** sur le HA du RPi4.
- **Station AREXX BS-1000**, sur le LAN de `noisy`, nom réseau `logXX` (numéro à relever), interface
  HTTP. Lue par **deux** consommateurs : (a) l'ancien module `zdidnodearexx` sur le RPi3 (inchangé,
  local), (b) l'app `arexx` de dimotic-ha **sur le RPi4** — pendant le montage du RPi4 à distance,
  via l'adresse fantôme `10.10.10.<octet>` (voir §3) ; une fois le RPi4 sur site, en direct sur le
  LAN local.
- **Pas de Zigbee** prévu dans un premier temps.

**Point non tranché** : jamais confirmé si "noisy" = le site "chez la fille" évoqué le 08/09/2026
(descriptions très proches). Sans impact sur le plan.

---

## 2. Contenu de la clé USB (RPi3)

1. **Raspberry Pi OS Lite 64 bits** (Bookworm), headless, SSH + user pré-configurés dans `bootfs`.
2. **Ancienne domotique** : `/home/domotique/node_applications/` copié depuis `noisy`, **`npm install`
   en arm64** (natifs recompilés : `rpio`, `serialport`). Configs du site récupérées :
   `zdiddefaults.properties` / `domo.properties`, `equipements.json`, `/home/datadomonoisy/`.
3. **Ancienne domotique modifiée** : `global.rpio` / `global.rfxcom` (dans `appmean.js`) +
   `gpiobridge.js` / `rfxcombridge.js` adaptés (bridge instance, IDs devices de `noisy`). Le module
   `zdidnodearexx` **reste actif, non modifié** (décision utilisateur 10/09 — l'app `arexx` de
   dimotic-ha tournera sur le RPi4, pas sur le RPi3).
4. **mosquitto local**, `global.properties` → `127.0.0.1`. La clé est ainsi **autonome et testable**
   sans dépendre de WireGuard.
5. **dimotic-ha** (Docker, image `zdid2/dimotic-ha` arm64) : `disabledApps` = tout **sauf**
   `rfxcom` / `rpigpio` (pas `arexx` sur le RPi3) ; `ha.mqtt.host: 127.0.0.1` ; configs
   devices/pins de `noisy`.
6. **WireGuard** (`wireguard-tools` + config) — posé sur la clé mais **bring-up du tunnel séparé**
   (dépend de la redirection de port Bbox, voir §3).
7. Docker propre depuis le dépôt Docker officiel (`docker-ce` + `docker-compose-plugin`), pas
   l'install manuelle héritée.

### 2.1 Construction via chroot QEMU (sur le PC de dev)

Objectif : produire le rootfs installé **plus vite** que sur le Pi3, sans y toucher avant samedi.

1. Récupérer l'image RPi OS Lite 64 bits, l'agrandir en **fichier `.img` loopback**.
2. `binfmt` + `qemu-aarch64-static`, **`chroot`** dans l'`.img`.
3. Dans le chroot : tous les `apt install` (Docker CE, mosquitto, wireguard-tools, node, git…),
   copie de `node_applications/` + `npm install`, dépôt des configs (dimotic-ha `compose` + `data/`,
   mosquitto, wireguard, units systemd, scripts de pont), `disabledApps` réglé (tout sauf
   `rfxcom`/`rpigpio`).
4. Sortir du chroot → **image maître `.img`** (à garder comme référence/sauvegarde).
5. **`dd`** l'`.img` sur la clé USB.

**Fidélité QEMU** : pour ce qu'on *produit* (paquets, binaires natifs arm64, configs) = identique au
Pi3. **PAS** un substitut au test réel : le chroot tourne sur le noyau de l'hôte, `systemd`/Docker
n'y tournent pas vraiment, aucun `/dev` matériel, rares écarts d'émulation. Détail : les images
Docker se pré-tirent mal en chroot → laisser le Pi3 les tirer au premier boot (~416 Mo) ou
`docker save`/`load` une image arm64.

### 2.2 Test partiel sur le Pi3 nu (samedi)

Le Pi3 de test est **nu** (pas de RFXCOM, pas de GPIO câblé, pas de BS-1000 joignable).

- ✅ **Validable** : boot 64 bits, `npm install` OK, services qui démarrent, mosquitto, dimotic-ha
  qui tourne, apps `rfxcom`/`rpigpio` qui chargent leur config, ancien `zdidnodearexx` qui tourne,
  scripts de pont qui se connectent au MQTT, circulation de messages (trames device publiées **à la
  main**).
- ❌ **Non validable ici** : trames RFXCOM réelles, bascule GPIO réelle, lecture BS-1000 réelle —
  seulement une fois la clé dans le vrai RPi3 de `noisy`.
- Itérer : souci → corriger dans le `.img` (re-chroot), re-`dd`, re-tester. Satisfait → expédier la
  clé, garder le `.img`.

### 2.3 ⚠️ Vérifié le 14/09/2026 : copier `docker` + `/home/domotique` + `/home/datadomo` ne suffit PAS

Question posée par l'utilisateur : est-ce que copier ces 3 arborescences suffit ? Réponse vérifiée
**en direct sur le noisy réel** (pas juste d'après ce document) : **non**. Éléments manquants ou
pièges trouvés :

**Manquants, hors des 3 arborescences :**
1. **`/etc/udev/rules.d/70-nodesupervisor.rules`** — crée `/dev/ttyUSBRFXCOM` (règle par
   `ATTRS{product}=="RFXtrx433"`/`"RFXtrx433XL"`, indépendante de l'ordre d'énumération USB — gère
   aussi `ttyUSBZWAVE`/`ttyUSBPHONE`/`ttyUSBZIGBEE`, non utilisés ici). **Sans ce fichier,
   `/dev/ttyUSBRFXCOM` n'existe jamais** → la config rfxcom (`port: /dev/ttyUSBRFXCOM`) échoue
   silencieusement au démarrage. Le piège le plus critique et le plus facile à oublier — à copier
   vers `/etc/udev/rules.d/` de l'image pendant le chroot (§2.1 étape 3, pas une simple copie
   d'arborescence home).
2. **Activation systemd de `nodesupervisor.service`** — le fichier source vit sous
   `/home/domotique/node_applications/zdidscripts/domotique/bin/nodesupervisor/nodesupervisor.service`
   (donc copié avec `/home/domotique/`), mais son **enregistrement** (`systemctl enable`, qui pose
   un lien dans `/etc/systemd/system/multi-user.target.wants/`) est une commande à rejouer dans le
   chroot, pas un fichier à copier.
3. **Crontab root + `/root/duckdns/`** — `*/2 * * * * /root/duckdns/duckv2.sh` maintient
   `dimoticnoisy.duckdns.org` à jour (dont dépend l'accès SSH/WireGuard). Ni le crontab (`crontab -l
   -u root`) ni `/root/duckdns/` (script + `duckparam.sh`, contient le token) ne sont sous les 3
   arborescences citées — à copier/recréer explicitement.

**Pièges côté contenu (le fichier existe dans l'arborescence citée, mais copier tel quel casse ou perd quelque chose) :**
4. **`node_modules` inutilisables tels quels** — vérifié : `rpio.node` compilé = `ELF 32-bit LSB ...
   ARM` (armv7, cohérent avec l'OS 32 bits actuel de noisy). La clé cible est **arm64 64 bits** —
   copier `node_modules` planterait tout. Exclure `node_modules` de la copie, refaire `npm install`
   sur la cible (déjà anticipé §2 point 2 — juste confirmé indispensable, pas à sauter).
5. **Node.js v12.21.0** tourne actuellement sur noisy (très ancien) — pas vérifié que les modules
   natifs (`rpio`, `serialport`) se recompilent proprement contre la version de Node de l'image 64
   bits (pas forcément identique). Risque non nul, pas testé.
6. **`/home/datadomo/` en direct sur noisy ≠ la bonne version** — les corrections du 11/09 (swap
   Evan↔Drystan, `cron.json`, voir §5ter) n'ont été faites QUE dans la copie de travail
   `~/noisy-migration/noisy-src/datadomo/`, jamais appliquées sur noisy lui-même (demande explicite
   de l'utilisateur de ne rien toucher en direct). Un `scp` frais depuis noisy aujourd'hui **perdrait
   ces corrections** — partir de la copie de travail corrigée, pas d'une copie fraîche de noisy.
7. **`/home/domotique/` en direct sur noisy = partiellement à jour** — le correctif GPIO
   (`gpiobridge.js` : `BRIDGE_INSTANCE`, `retain:true`) a été déployé EN VRAI sur noisy le 13/09/2026
   (une copie fraîche l'inclurait). Le correctif RFXCOM (`zdidnoderfxcom433e-ha/`, voir §5bis)
   **n'a PAS encore été déployé sur le noisy réel** (rfxcom toujours désactivé côté dimotic-ha à ce
   jour) — il n'existe que dans `~/noisy-migration/noisy-stick/` sur le PC de dev. Une copie brute
   depuis noisy aujourd'hui manquerait donc la variante RFXCOM adaptée ; utiliser
   `~/noisy-migration/noisy-stick/` pour ce module, pas noisy en direct.

**Volontairement hors périmètre (pas un oubli, déjà tranché §3/§2)** : `/etc/wireguard/` — clés
neuves régénérées sur l'image 64 bits plutôt que copiées. `docker-ce`/`mosquitto`/`wireguard-tools`
= paquets à installer via apt (§2 point 7), pas des répertoires à copier — confirmé au passage que
le chemin réel de dimotic-ha sur noisy est bien `/docker/dimotic-ha/` (data+logs montés depuis là,
`docker inspect dimotic-ha`), cohérent avec la convention des autres machines. Réservation DHCP
Bbox : pas un souci ici, même matériel physique (seul le support de stockage change) → même MAC
`eth0`, déjà fixée en réservation.

---

## 3. Réseau — WireGuard ✅ RÉSOLU et OPÉRATIONNEL (13/09/2026)

Les deux LAN (ici et `noisy`) sont **tous les deux en `192.168.1.0/24`** → pas routables
directement. Solution : un **réseau overlay WireGuard `10.10.10.0/24`**.

**Débloqué le 13/09** : accès à la Bbox obtenu via récupération du compte Bouygues de la ligne de
noisy (mot de passe local de la box jamais retrouvé, pas nécessaire finalement). Redirection **UDP
51820** posée sur la Bbox → `192.168.1.62` (RPi3).

**Rôles** : **serveur sur `noisy`** (RPi3, `10.10.10.1`, `/etc/wireguard/wg0.conf`, `wg-quick@wg0`
activé au boot) ; **client sur le PC de dev** (`10.10.10.2`, migrera sur le RPi4 à la bascule,
`Endpoint = dimoticnoisy.duckdns.org:51820`, `PersistentKeepalive = 25`). Clés générées séparément
de chaque côté, seules les publiques échangées (jamais les privées) :
- noisy : `/etc/wireguard/noisy_{private,public}.key`
- PC de dev : `~/noisy-migration/wireguard/dev-client_{private,public}.key` (config complète dans
  `wg0-devpc.conf`, installée en `/etc/wireguard/wg0.conf` par l'utilisateur avec `sudo`)

**Adresses fantômes** (Deye/BS-1000, joignables depuis ici pendant le montage du RPi4 à distance) :
NAT posé via `PostUp`/`PostDown` dans `wg0.conf` de `noisy` (`iptables` DNAT en `PREROUTING` +
`MASQUERADE` en `POSTROUTING`, `ip_forward=1` persisté dans
`/etc/sysctl.d/99-wireguard-forward.conf`) — réappliqué automatiquement à chaque démarrage du
tunnel, donc persistant au reboot :
- `10.10.10.47` → `192.168.1.47` (BS-1000, `log02.lan`)
- `10.10.10.157` → `192.168.1.157` (logger Solarman/Deye 1, `3874527257.lan`)
- `10.10.10.7` → `192.168.1.7` (logger Solarman/Deye 2, `2618005808.lan`)
- `10.10.10.119` → `192.168.1.119` (logger Solarman/Deye 3, `3868562958.lan`)

**⭐ `192.168.1.146` (ancienne adresse notée pour les Deye) n'existe plus** — retrouvés le
13/09/2026 par scan `nmap` depuis noisy (signature logger Solarman : port **8899** ouvert, même
préfixe MAC `d4:27:87`) : **3 loggers** (pas 2 comme noté avant — confirmé "les 3 Deye" par
l'utilisateur), plus le BS-1000 dont le nom réel est **`log02`** (résout l'ancien point ouvert
"logXX"). **Toutes les adresses (RPi3 compris) fixées en réservation DHCP sur la Bbox** — stables
désormais.

**Test de bout en bout réussi pour les 4 appareils** : BS-1000 → `curl http://10.10.10.47/` →
**HTTP 200** ; les 3 loggers → ping + port **8899** ouvert, à travers tout le chemin (tunnel + NAT +
réseau local de noisy). **Chaîne WireGuard entièrement validée, plus aucun point ouvert réseau.**

**Découplage toujours valable** : la clé USB du RPi3 reste **autonome** (mosquitto local) — le
tunnel n'est pas nécessaire pour la faire fonctionner une fois sur site. Le lien RPi3 ↔ RPi4 en
production sera du **MQTT sur le LAN local** de `noisy` (les deux machines y seront) ; le tunnel
sert pour le montage/test du RPi4 à distance et pour l'accès admin pérenne ensuite.

---

## 4. Track RPi4 / Home Assistant

**⭐ Révisé le 11/09/2026** : construit **par la même méthode que la clé RPi3** (§2.1 — image `.img`
loopback + chroot QEMU sur le PC de dev, `dd` sur le support final), plutôt que la première idée de
piles Docker "live" sur le PC de dev migrées ensuite par sauvegarde/restauration HA.

**✅ Carte tranchée le 14/09/2026 : RPi4** (pas Orange Pi 4 Pro). Un Orange Pi 4 Pro avait été
envisagé un temps, mais recherche faite le 14/09 sur son support logiciel :
- Support Armbian = **"Community"** seulement, et un mainteneur Armbian a déclaré en janvier 2026
  **"We don't have intention to support this board without funding"** — pas de garantie de
  maintenance dans la durée.
- **Driver NVMe absent** (confirmé forum Armbian), WiFi/NPU signalés indisponibles.
- Image **officielle** Orange Pi elle-même pas plus rassurante (review indépendante Boiling Steam) :
  kernel 5.15 (EOL décembre 2026), Debian qualifiée "fairly old".
- Carte trop récente (sortie fin 2025) pour un site à 500 km sans accès physique facile — risque de
  fiabilité jugé trop élevé pour ce rôle précis.

**Décision utilisateur** : garder l'idée d'un Orange Pi 4 Pro pour un usage **local** (ici, accès
physique possible en cas de souci) plutôt que pour noisy, et utiliser un **RPi4 de rechange
disponible** (machine libre, sans SD/USB, boîtier vissé — pas identifiable visuellement) à la place.
⚠️ Piste explorée puis écartée en cours de route : ce n'est PAS le Pi4 de l'incident carte SD du
04/08/2026 ([[project_pi4_sdcard_incident]], qui servait de broker MQTT partagé avec l'OrangePi) —
confusion initiale non confirmée par l'utilisateur, à ne pas répéter. C'est une troisième machine,
distincte, jusque-là non référencée dans ce projet.

**✅ Identifiée et provisionnée le 14/09/2026** : flashée via `scripts/flash-sd-card.js` (profil
`scripts/sd-card-profiles/noisy2.yaml`, hors git) avec Raspberry Pi OS Lite 64 bits (Bookworm) sur
clé USB SanDisk (`/dev/sdc` au moment du flashage), hostname **`noisy2`**. Confirmé par SSH
(`/sys/firmware/devicetree/base/model`) : **Raspberry Pi 4 Model B Rev 1.2**, `aarch64`, Bookworm.
⚠️ Bug rencontré : l'injection automatique de la clé SSH personnelle par `prepare-sd-card.sh` a
échoué silencieusement (accès uniquement par mot de passe au premier boot) — même classe de bug
déjà documentée et censée être corrigée dans ce script (résolution de `$HOME` sous `sudo`). Débloqué
manuellement (`ssh-copy-id`) ; **cause exacte de la récidive pas encore investiguée**, à reprendre
sur `scripts/flash-sd-card.js`/`prepare-sd-card.sh`.

**✅ Stack Docker installée et opérationnelle le 14/09/2026** : Docker CE 29.8.0 + Compose v5.5.1
(dépôt officiel Docker, `apt`). Trois conteneurs `/docker/*` (même convention que ha2/stfort/orangepi) :
- `mosquitto` (`eclipse-mosquitto:2`, config identique à celle de la clé RPi3 noisy — `listener 1883`,
  `allow_anonymous true`, MQTT5).
- `homeassistant` (`homeassistant/home-assistant:latest`, `network_mode: host`, même compose que
  ha2) — **conteneur up, mais pas encore onboardé** (compte admin à créer, étape manuelle
  utilisateur, jamais automatisée par Claude — voir règles de sécurité).
- `dimotic-ha` (`zdid2/dimotic-ha:latest`) — **`healthy`**, `data/core/config.yaml` : `machineId:
  noisy2`, `mqtt_enable: true` (→ mosquitto local), **`ws_enable: false`** temporairement (pas de
  token HA tant que l'onboarding n'est pas fait — voir piège ci-dessous), `disabledApps: [evoo7,
  rfxcom, rpigpio, teleinfo]`. `data/arexx/` déjà déployé (config §4bis) — avertissement attendu en
  logs (`EHOSTUNREACH 192.168.1.47`, le BS-1000 n'est pas joignable depuis le LAN du PC de dev, pas
  encore basculé sur l'adresse fantôme WireGuard `10.10.10.47`).

⚠️ **Piège de validation rencontré** : `ws_enable: false` seul NE SUFFIT PAS à éviter le crash
`ha.ws.token: Long-Lived Access Token is required` — `applications/core/src/infrastructure/config/
loader.ts::omitDisabledHaSections()` n'omet la section `ws` de la validation stricte que si elle est
**intégralement vide** (`host` ET `token` tous deux absents/vides) ; un `host` renseigné sans
`token` reste validé strictement quel que soit `ws_enable`. Correctif : ne PAS écrire de bloc `ws:`
du tout tant que le token n'est pas disponible (pas juste `ws_enable: false`).

⚠️ **Bug daemon Docker rencontré à deux reprises** : un `docker compose up -d` interrompu en
plein pull (timeout SSH) laisse un conteneur fantôme — `docker ps -a` ne le liste pas, `docker
inspect`/`docker rm` disent "no such object", mais `docker compose up` continue de refuser avec
`Conflict... already in use by container <id>`. Log dockerd : `failed to cleanup "extract-..." :
snapshot ... does not exist`. **Correctif qui a marché les deux fois** : `sudo systemctl restart
docker` — au redémarrage, le conteneur fantôme s'avère en fait avoir été créé avec succès et
redémarre proprement tout seul (`restart: unless-stopped`). Levier utile si ça se reproduit : lancer
les `docker compose up -d` longs (premier pull d'image) en tâche de fond plutôt qu'avec un timeout
court, pour éviter de déclencher ce bug.

**Reste à faire** :
1. ~~Onboarding HA (compte admin)~~ ✅ **Fait le 14/09/2026** (utilisateur).
2. ~~Générer un Long-Lived Access Token HA~~ ✅ **Fait le 14/09/2026** — `ws_enable: true`,
   connexion confirmée en logs : `[ha:ws] Connexion WebSocket établie et authentifiée`,
   `Référentiel chargé: 22 entités, 3 areas, 9 devices`.
3. ~~Basculer `data/arexx/config.yaml` sur l'adresse fantôme WireGuard~~ ✅ **Fait et validé en
   conditions réelles le 14/09/2026** — `noisy2` fait maintenant lui-même un pair WireGuard à part
   entière (`10.10.10.3/24`, clé dans `/etc/wireguard/noisy2_{private,public}.key` sur noisy2, ajouté
   côté serveur `noisy` dans `/etc/wireguard/wg0.conf` — backup
   `wg0.conf.bak-pre-noisy2-peer-20260914` — via `wg syncconf` à chaud, sans couper le pair PC de
   dev). C'est en avance sur le plan §3 ("le rôle client migrera sur le RPi4 à la bascule") — fait
   dès maintenant plutôt qu'au moment de l'expédition, ça ne coûte rien de l'avoir tôt. Handshake
   confirmé, `ping`/`curl` OK vers `10.10.10.1` et `10.10.10.47`. `bs1000Address` du profil arexx
   basculé sur `10.10.10.47` (au lieu de `192.168.1.47`) : **lectures réelles confirmées** en logs
   dimotic-ha — ex. `chambre de drystan`: 24.7°C, `chambre`: 24.6°C, données authentiques remontées
   depuis le BS-1000 physique de noisy à travers tout le chemin.
4. ~~`scriptsha`, `nommage`~~ ✅ **Faites le 14/09/2026** (à la demande explicite utilisateur —
   PAS `ia`/`planificateur` pour l'instant). `scriptsha` : aucun fichier de config nécessaire
   (comme sur ha2, tourne avec les défauts — vérifié `ScriptsHaService démarré`, 3 scripts intégrés
   détectés). `nommage` : `data/nommage/config.yaml` déployé, **⚠️ piège évité** — le préfixe de
   topic à utiliser est `homeassistant/` (celui de dimotic-ha lui-même,
   `core/ha-mqtt.ts::getDiscoveryTopic`, vérifié en direct via `mosquitto_sub`), PAS `homeassist/`
   qui est la convention ha2/zigbee2mqtt copiée par erreur au premier brouillon (sans objet ici,
   aucune source zigbee2mqtt sur noisy2). `mqtt.host: 192.168.1.19` (IP LAN actuelle de noisy2, à
   mettre à jour si l'IP change une fois sur site). Vérifié connecté + parsing des découvertes
   `arexx` en direct (logs `NommageMqttIntegrationService`/`nommage:discovery:parsed`).
   Reste : `haplan` (vraie migration, pas juste une config), `data/ia/config.yaml` — **différées**,
   pas demandées pour l'instant (ni `ia` ni `planificateur`).
5. Intégrations HA natives Modbus/Solarman (Deye) + Tuya Local (batterie) — une fois HA onboardé.

RPi4 = arm64, même image Docker dimotic-ha (multi-arch) que les autres machines du projet ; base OS
= **Raspberry Pi OS** (support officiel, mature — le choix qui motive ce pivot).

Dans l'image : Docker + **Home Assistant** (conteneur, comme `ha2`) + **dimotic-ha** (décision
utilisateur 11/09, en deux temps) — activées : **`arexx`, `ia`, `planificateur`, `arbreouquoi`,
`scriptsha`, `haplan`, `nommage`, `espdisplay`**. **`disabledApps` du RPi4 = seulement `evoo7`,
`rfxcom`, `rpigpio`, `teleinfo`** — les apps propres à un matériel qui reste ailleurs (rfxcom/rpigpio
→ la clé RPi3 "noisy" ; evoo7/teleinfo → pas de boîtier EVOO7 ni de compteur téléinfo sur ce site).
En clair : le RPi4 fait tourner **la quasi-totalité de la suite dimotic-ha**, pas juste `arexx`.
Client WireGuard permanent (`10.10.10.2`, voir §3).

**⚠️ `ia` = clé API Mistral, sécurité** : `ia` a besoin de `data/ia/config.yaml` (contient
`mistralApiKey`/`anthropicApiKey` en clair). Le RPi4 doit avoir **les mêmes paramètres que ceux
actuellement utilisés sur le PC de dev pour stfort** (demande explicite) — donc copier ce fichier
lors de la construction de l'image. **Jamais faire transiter la valeur de la clé par ce document ni
par un commit git** — copie directe fichier-à-fichier pendant l'étape chroot (§2.1), comme pour
`equipements.json`/`domo.properties`. Les fichiers annexes non secrets d'`ia`
(`gabarits_interpreteur.yaml`, `regles_mistral.txt`, `vocabulaire_interpreteur.yaml`) sont eux de
simples règles/gabarits, à copier tels quels sans précaution particulière.

### 4bis. Config AREXX générée le 11/09/2026

Dans `~/noisy-migration/rpi4-stick/dimotic-ha/data/arexx/` (à partir de `equipements.json` corrigé) :

| Fichier | Contenu |
|---|---|
| `config.yaml` | `acquisitionMode: poll`, `bs1000Address: 192.168.1.47`, `bs1000Port: 80`, `pollIntervalSeconds: 50` (repris de `arexx.temp.*` de l'ancien `domo.properties`), `bridgeInstance: arexx_bridge` (préfixe seul, `computeBridgeInstance()` ajoute le machineId). **Pendant le montage à distance** : pointer `bs1000Address` sur l'adresse fantôme WireGuard (`10.10.10.47`) plutôt que l'IP LAN directe — à remettre en LAN direct (ou laisser, ça continue de marcher) une fois sur site. |
| `arexx-sensors-v1.0.yaml` | **8 capteurs température** (`arexx_<rawId>`, ex. `arexx_138460` → chambre de evan, `arexx_9609` → chambre de drystan — noms corrigés), tous `transmitToHa: true`. |

Reste à générer pour la clé RPi4 :
- `data/core/config.yaml` (disabledApps ci-dessus, HA WS activé cette fois — pointé sur le HA local
  du même conteneur).
- Config propre à chaque app nouvellement activée : `scriptsha` (scripts), **`haplan` — une vraie
  migration à prévoir** (décision utilisateur 11/09, pas juste une config vide). **⭐ Trouvé le
  11/09** : `noisy` a un **vrai plan image**, `/home/datadomo/plan-original.png` (620×750 PNG,
  vérifié visuellement — plan filaire propre, plusieurs pièces distinctes, exploitable tel quel
  comme fond de plan HAPLAN, récupéré dans `~/noisy-migration/noisy-src/datadomo/`). Variantes
  portrait/paysage déjà rendues dans `node_applications/zdidnodedimoweb/www/` (`planportrait.png`
  620×750, `planpaysage.png` 752×622). Combiné aux coordonnées déjà en base
  (`equipements.json` : `surfaceslieux`/`surfacesLieux` pour les contours de pièces,
  `coordonnees`/`newcoordonnees` par matériel pour la position de chaque icône) → matière de départ
  complète pour reconstituer le plan HAPLAN de ce site, pas juste une esquisse. Détail de cette
  migration pas encore fait (à reprendre séparément, plus tard). `nommage` (source(s) MQTT — a
  priori juste le HA local du RPi4 lui-même, à confirmer).
- **`espdisplay`** : pas d'ESP32 sur `noisy` aujourd'hui, mais **des écrans seront installés
  prochainement** (confirmé 11/09) — l'app reste active dès la préparation du RPi4 (prête à
  l'emploi quand le matériel arrivera), pas de config d'écran à préparer maintenant.
- Les intégrations HA natives (Modbus/Solarman pour les 3 loggers Deye, Tuya Local pour la prise batterie —
  pas des fichiers dimotic-ha).

**Position GPS du site** (`domo.properties`, `gps=48.830241,2.574263`) : **latitude `48.830241`,
longitude `2.574263`** — à saisir lors de l'onboarding HA du RPi4 (`homeassistant.latitude`/
`longitude`, nécessaire pour le lever/coucher du soleil, la météo, etc.).

### Étapes

1. Construire l'image (même méthode §2.1) : OS de base **Raspberry Pi OS** (RPi4, tranché
   14/09/2026) + Docker + Home Assistant + dimotic-ha (`core`+`arexx`) + WireGuard.
2. Intégration **Modbus TCP / Solarman** pour les 3 loggers Deye (finalise les tests bloqués par
   Python 3.7 sur stfort) — via les adresses fantômes `10.10.10.157`/`.7`/`.119` pendant le montage
   à distance.
3. Intégration **Tuya Local** pour la prise batterie.
4. Tests de bout en bout (encore sur le PC de dev, avant expédition).
5. Expédition vers `noisy`. Sur place : brancher — aucune reconfiguration réseau (adresses overlay
   stables, ou LAN local direct pour BS-1000/Deye une fois sur site).

---

## 5. Points ouverts

- ~~RFXCOM fork sur `noisy`~~ ✅ **résolu (11/09)** : archi = pattern stfort exactement.
  `zdidnoderfxcom433e` = `app.js`→`appmean.js`→`rfxcomserv.js` ; `rfxcomserv.js` fait
  `require('../zdidnodefork4rfxcom2')` (= lib `rfxcom` 2.4.0 vendorisée). `appmean.js` :
  `RFXCOMDEVICE='/dev/ttyUSBRFXCOM'`, `new rfxcomserv.Rfxcomserv(device)`, commandes entrantes via
  MQTT (`mqttdimotic`, `command/<proto>/#`). → migration = rejouer le diff `-old`→`-ha` de stfort
  (§1.3ter).
- ~~Récupérer les configs de `noisy`~~ ✅ **fait (11/09)**, **vrai répertoire = `/home/datadomo/`**
  (pas `datadomonoisy` qui est une copie de 2021) : `~/noisy-migration/noisy-src/` =
  `node_applications/` (83 Mo) + `domotique/` (176 Mo, avec bin/mochad/openzwave/udevrules) +
  `datadomo/` (27 Mo). Répertoires à mettre sur la clé : `/home/domotique/` + `/home/datadomo/`
  (sans `node_modules`).
- ~~IP du BS-1000~~ ✅ **`192.168.1.47:80`**. Reste le hostname `logXX` (pas bloquant).
- ~~`192.168.1.96`~~ ✅ **c'était la copie périmée** — le vrai broker est `192.168.1.62:1883` (le
  RPi3 lui-même). Sur la clé → `127.0.0.1:1883`.
- ~~X10 / mochad~~ ✅ **plus de X10 dans la config réelle** — rien à prévoir.
- **Deux consommateurs du BS-1000** : ancien `zdidnodearexx` (RPi3) + app `arexx` (RPi4) sur le même
  endpoint HTTP. À confirmer que ça coexiste (poll des deux côtés = OK).
- `gps` de `noisy` = région parisienne dans `domo.properties`, incohérent avec "500 km" — valeur de
  gabarit ? à corriger le cas échéant.
- **`sudo` sur le PC de dev** pour la construction de l'image (chroot/loopback/binfmt) — l'utilisateur
  doit soit ouvrir sudo, soit lancer un script préparé avec `!`.
- **WireGuard / redirection de port Bbox** — voir §3, l'utilisateur y réfléchit (topologie serveur
  sur `noisy` vs pivot externe).
- Confirmer si "noisy" = le site "chez la fille".
- Modèle exact des Deye (connu : Deye + Solarman) — utile pour l'intégration HA précise.
- Détail des apps dimotic-ha à activer sur le RPi4 au-delà de `core`.
- Réservation DHCP de l'IP du RPi3 sur la Bbox (aujourd'hui `192.168.1.62` dynamique).

---

## 5bis. Config dimotic-ha de la clé — brouillon fait le 11/09/2026

Générée dans `~/noisy-migration/noisy-stick/dimotic-ha/` à partir de `equipements.json` **corrigé**
(swap Evan↔Drystan + normalisation orthographe fait le 11/09, voir §5ter) :

| Fichier | Contenu | À revoir |
|---|---|---|
| `compose.yaml` | copie de `compose.deploy.yaml` du dépôt (standard) | TZ Europe/Paris OK |
| `data/core/config.yaml` | autonome : `ha.ws_enable: false`, `mqtt` → `127.0.0.1:1883`, `machineId: noisy`, `web.port: 8087`, `disabledApps` = tout sauf `rfxcom`/`rpigpio` | vérifier au test que `core` démarre bien en mqtt-seul (ws off) |
| `data/rfxcom/config.yaml` | `bridgeInstance: rfx_bridge_noisy`, `port: /dev/ttyUSBRFXCOM`, `autoDiscovery: true`, `waitForHaWsBeforeDiscovery: false` | `enabledHardwareProtocols` = superset ARC/AC/OREGON/RUBICSON/ATI |
| `data/rfxcom/config-rfxcom-devices-v1.0.yaml` | **35 devices** (33 Lighting2/AC + 1 RFXMeter elec3 `0x8c02` + 1 RFXSensor temp2 `0xde01`) + **20 receivers** (14 `light` + 5 `cover` + 1 `switch`). **⭐ TOUS les devices Lighting2/AC = `defaultQuoi: Bouton`** (émetteurs — décision utilisateur 11/09 : « tous les acxxxx sont des boutons »). Les entités pilotables sont dans `rfxcom_receivers` : 1 par lumière/volet/radiateur, `primaryEmitter` = adresse du champ `num`, `emitters` associés = adresses du champ `equivalences` (`;`-séparé), `action: toggle`. Les 8 adresses secondaires des `equivalences` sont aussi des devices `Bouton`. | (1) **`coverType: Blind1`** des 5 volets — ✅ vérifié le 11/09 : `ReceiverCover.ts` gère nativement le pilotage Lighting2/AC (open→`on`, close→`off`, stop→fige la position, via `primaryEmitterProtocol==='lighting2'`), `coverType` est purement cosmétique (libellé HA, n'affecte pas la trame RF). **Reste un vrai gap** (TODO.md, priorité moyenne) : aucune valeur d'enum ne représente "piloté en AC" (`Blind1` mis en pratique = libellé trompeur), et la limite connue "pas de STOP auto à la position cible" n'a jamais été testée en conditions réelles — à vérifier de près avant de compter dessus pour les 5 volets de noisy. (2) types elec3/temp2 = best-guess, `autoDiscovery` corrigera sur site. |
| `data/rpigpio/config.yaml` | `bridgeInstance: rpigpio_bridge_noisy`, `target.host: 127.0.0.1` (déploie mqtt-io sur la clé elle-même) | l'accès SSH root→localhost doit être en place sur la clé |
| `data/rpigpio/rpigpio-pins-v1.0.yaml` | **12 pins** : `phys<N>` → BCM, `quoi`/`lieu` depuis `equipements.json` corrigé (phys15 → **chambre de drystan**, phys29 → **chambre de evan**), `inverted` = présence de `:inv:` | ✅ **croisement `equipements.json` ↔ yaml vérifié le 13/09/2026** (script Python, 12/12 pins : quoi/lieu/inverted identiques des deux côtés, rien de manquant). Seul phys7 (`ballon` garage) est NON inversé — phys16 (`journuit` garage) EST inversé (correction : cette ligne disait par erreur les deux "non inversés", voir la ligne juste au-dessus §1.2 qui avait la bonne info). ⚠️ **Vrai gap trouvé** : `equipements.json` encode un état initial au démarrage (`phys7`/`phys16` = `init ON`, les 10 autres `init OFF`) que `pinDefinitionSchema`/`generator.ts` (rpigpio) ne portent PAS du tout aujourd'hui — rien ne garantit que `mqtt-io` démarre ces deux relais allumés comme l'ancien système ; à vérifier (option `initial` éventuelle côté mqtt-io digital_outputs) avant mise en prod. |

**Reste à faire pour la clé** (au-delà de cette config) :
- ~~Adapter `rfxcombridge.js`/`gpiobridge.js` + rejouer les diffs stfort~~ ✅ **fait le 13/09/2026**,
  livré dans `~/noisy-migration/noisy-stick/` (non commité, comme le reste de ce chantier) :
  - `zdidnoderfxcom433e-ha/` : `rfxcombridge.js` adapté (`BRIDGE_INSTANCE = rfx_bridge_noisy`,
    `realRfxcom = require('../zdidnodefork4rfxcom2')` au lieu du paquet npm `rfxcom` utilisé par
    stfort — le fork a la même forme d'export, vérifié par lecture le 13/09 — `MQTT_URL` local
    127.0.0.1, commentaires réécrits pour l'archi mono-machine de noisy, pas de multi-hop comme
    stfort/ha2/falbala). `appmean.js` et **`rfxcomserv.js` copiés VERBATIM depuis stfort** :
    lecture complète du diff noisy↔stfort le 13/09 a montré que `rfxcomserv.js` de stfort a déjà
    la ligne fork commentée (`//, rfxcom = require('../zdidnodefork4rfxcom2')` suivie de
    `, rfxcom = global.rfxcom`) — stfort partage la même lignée que noisy sur ce fichier, aucune
    adaptation supplémentaire nécessaire au-delà des fixes déjà présents (elec23, logs, split
    `:::` des commandes). `app.js` adapté : PAS de copie `overriderfxcom/lib/lighting2.js` (inutile
    ici — le fork `zdidnodefork4rfxcom2` a déjà les mêmes validations assouplies en dur, vérifié
    par lecture directe le 13/09), sinon même refactor `appli()`+`setImmediate` que stfort.
  - `zdidnodegpio/` : `gpiobridge.js` adapté (bridge instance `rpigpio_bridge_noisy`, commentaires
    réécrits pour noisy). `app.js`/`appmean.js`/`gpioserv.js`/`package.json` **copiés VERBATIM
    depuis stfort** : diff noisy↔stfort-current montre que ces fichiers sont déjà exactement
    noisy-original + les 2 diffs génériques (pont `global.rpio` + fix split `:::` de `execute()`),
    aucun contenu spécifique à stfort dedans.
  - Tous les fichiers non touchés par la migration (`forcegpio.js`, `rechnumgpio.js`,
    `nouvelappareil.js`, `depannage.js`, `noname.js`, `README.md`, `.eslintrc.json`,
    `.tern-project`, `package.json` rfxcom — sans dép npm `rfxcom`, correct puisque noisy utilise
    le fork local) copiés tels quels depuis les originaux noisy.
  - `node --check` OK sur les 4 fichiers adaptés/copiés (JS pur, pas d'install `node_modules`
    nécessaire pour ce contrôle).
- ✅ `domo.properties` (copie de travail `~/noisy-migration/noisy-src/datadomo/`, `.orig` gardé) :
  `mqtt.server.addressport` → `127.0.0.1:1883` (était `192.168.1.62:1883`, l'IP LAN du RPi3
  lui-même — devenu inutile, une seule machine dans cette boucle désormais).
- Construire l'image (chroot QEMU) — bloqué sur `sudo` PC de dev.
- Reste non couvert par ce chantier : copier `~/noisy-migration/noisy-stick/zdidnodegpio/` et
  `zdidnoderfxcom433e-ha/` dans l'arborescence `/home/domotique/node_applications/` de l'image
  construite (remplaçant les répertoires `zdidnodegpio`/`zdidnoderfxcom433e` d'origine — les
  originaux noisy restent intacts dans `noisy-src/`, donc pas de perte), et vérifier que
  `package.json` de `zdidnodegpio` a bien `npm install` fait pour la dépendance `mqtt` ajoutée
  (absente de l'original noisy).

## 5ter. Corrections `equipements.json` / `cron.json` faites le 11/09 (copie de travail uniquement)

Dans `~/noisy-migration/noisy-src/datadomo/` (original en `.orig`), **rien touché sur `noisy` en direct** (demande utilisateur).

- **Swap Evan ↔ Drystan** dans `equipements.json` : les enfants ont échangé de chambre. 20 changements
  (`lieu`, `sarahname`, `num` des virtualther, clés `surfaceslieux`/`surfacesLieux`). Orthographe
  normalisée en `chambre de evan` / `chambre de drystan` (fini `chambre d evan`, `chambre des vannes`).
  Les thermostats restent cohérents (thermostat + thermomètre + radiateur renommés ensemble, appariés
  par nom de pièce).
- **`cron.json`** : "bureau" (pièce sans plus aucun matériel — ex-lumière X10 `h4` disparue) remplacé :
  j172/j24/j149 → "chambre de Evan" ; j162/j45 (qui listaient déjà "chambre d'Evan" **et** "bureau")
  → "et du bureau" devient "et de la chambre de Drystan" (ajoute la couverture de la chambre de
  Drystan). Caches `__commands`/`__sensors` de j162/j45 figés — re-parsés au boot du superviseur.

## 5quater. Portage du plan HAPLAN de noisy — fait le 14/09/2026

Matière de départ (§4bis) : `/home/datadomo/plan-original.png` (620×750 PNG, portrait) +
`equipements.json` corrigé (§5ter, swap Evan↔Drystan déjà appliqué) — `coordonnees`/`newcoordonnees`
par matériel/type (portrait, pixels) → converties en fractions 0-1 (`px/620`, `py/750`) pour le
schéma HAPLAN (`positions: [{entity_id, x, y}]`, `x`/`y` nullable si non placé).

Mapping matériel → entity_id HA (noisy2) fait par croisement `lieu`/`sarahname`/`num` avec :
- `arexx-sensors-v1.0.yaml` déployé sur noisy (rawId → nom de pièce, source d'autorité)
- `rpigpio` : 12 pins phys7/11/12/13/15/16/18/22/29/31/33/37 → switches (déjà croisés le 13/09)
- Les entités RFXCOM (`light.*`/`cover.*`) : désambiguïsation des doublons par pièce via `sarahname`
  (ex. `sarahname="chevet"` → `light.chevet_chambre_de_evan`, `sarahname="entrée"` sur `lieu="salle"`
  → `switch.entree_salle`, `/11` vs `/12` sur la même adresse RFXCOM → salon vs salle à manger)

**50 entités placées** (8 climate, 8 arexx, 13 switch [12 gpio + 1 rfxcom], 16 light, 4 cover,
1 sensor.toilettes_temperature) sur 56 matériels legacy — **5 laissées non placées** (`x`/`y`
`null`, à positionner manuellement via "Ajouter une entité") faute de coordonnées dans l'original
(`sensor.couloir_arexx_temperature_temperature`, `switch.garage_journuit_16`,
`switch.garage_ballon_12`, `switch.garage_ballon_7`, `sensor.garage_puissance`) — **6 matériels
exclus volontairement** (télécommandes/boutons RFXCOM `binary_sensor.*`, pas pertinents sur un plan ;
`essaizigbee`, device de test). Tous les 50 `entity_id` vérifiés existants dans l'état HA réel de
noisy2 avant déploiement (aucun typo).

Déployé sur noisy2 (`/docker/dimotic-ha/data/haplan/`) : image copiée dans `images/`, config
générée écrite (ancienne config vide sauvegardée en `.bak-vide-20260914`), conteneur `dimotic-ha`
redémarré — `HaplanService` démarré sans erreur, plan affiché et validé visuellement dans l'éditeur
web (icônes correctement positionnées dans les pièces correspondantes).
- Les 4 crons qui nomment explicitement Evan/Drystan (j162/j45/j194/j242) ne sont **pas** swappés :
  ils visent la chambre de l'enfant nommé, pas la pièce physique (décision utilisateur).

## 6. Fait à ce jour

- `wireguard-tools` installé sur `noisy` (10/09/2026) — sera de toute façon refait sur la base 64
  bits.
- Recon complète (10-11/09) : système `noisy`, archi ancienne domotique (= pattern stfort),
  inventaire équipements (§1.3bis), templates de ponts stfort (§1.3ter).
- **Sources récupérées dans `~/noisy-migration/`** (hors dépôt) :
  - `noisy-src/node_applications/` — ancienne domotique de noisy (sans `node_modules`, 83 Mo).
  - `noisy-src/datadomonoisy/` — données/config du site (23 Mo).
  - `stfort-templates/zdidnoderfxcom433e-ha/` + `zdidnodegpio/` — modèles de migration.
- Rien d'autre — aucune modification de l'ancienne domotique sur noisy, aucune clé créée, aucun
  tunnel monté, aucune image construite.
