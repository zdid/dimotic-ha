# Migration noisy — mise en place d'un site distant (RFXCOM+GPIO sur place, HA sur un RPi4 monté ici)

**Premier jet, 10/09/2026.** Conception établie en conversation avec l'utilisateur, aucune action
exécutée à ce stade. Document opérationnel (comme `RUNBOOK.md`) — volontairement **hors du processus
`specs/`** : WireGuard/infra réseau a déjà été explicitement classé "hors du dépôt de code" dans
`specs/current/fonctionnelles-supervisor_specs_v2.8.md` §14bis, ce chantier relève de la même
catégorie (infra/déploiement, pas comportement applicatif dimotic-ha).

---

## 1. Contexte

- **Site "noisy"** — nom de la machine ET du site, à **500 km**. RPi3, Raspbian ancien. Héberge
  aujourd'hui l'ancienne domotique (legacy, comme `stfort` avant sa propre bascule — voir
  [[project_rfxcom_bridge_legacy]]/`SECURITE_pont-gpio_2026-08-19.md` pour le précédent). RFXCOM
  (transceiver USB 433MHz) et GPIO (pilotage de relais de puissance) y sont branchés physiquement et
  **restent sur place** — pas de matériel à déplacer.
- **Ancienne domotique sur noisy** : accède **encore directement** au GPIO et au RFXCOM aujourd'hui —
  la migration à faire est identique à celle déjà réalisée sur `stfort` (retirer l'accès matériel
  direct, dimotic-ha prend possession du matériel, pont MQTT côté ancienne domotique vers les
  nouveaux drivers — cf. `rfxcombridge.js`/`gpiobridge.js`).
- **2 micro-onduleurs Deye**, déjà installés physiquement sur noisy, adresse `192.168.1.146` sur son
  réseau local, protocole **Solarman** (encapsulation Modbus TCP, bibliothèque probable
  `pysolarmanv5`, **Python 3.8 minimum**). Connectivité déjà confirmée fonctionnelle (tests faits
  via un tunnel SSH improvisé), tests complémentaires nécessaires mais bloqués jusqu'ici par le
  Python 3.7 de `stfort` — seront finalisés sur le RPi4.
- **Une prise Tuya** à prévoir pour piloter une batterie (probablement Tuya Local, comme les
  climatiseurs déjà en place chez l'utilisateur).
- **Station de base AREXX BS-1000**, installée sur noisy, sur son réseau local. Apparaît sur un
  balayage réseau sous un nom de type `logXX` (`XX` = numéro, à relever). Expose une interface HTTP.
  L'application `arexx` de dimotic-ha doit être **activée sur le RPi4** et lire **directement le HTTP
  du BS-1000** (mode poll : RPi4 → lit → BS-1000, voir `bs1000Port` / `acquisitionMode` du schéma
  arexx). Donc le BS-1000 est un appareil du LAN de noisy à **router aussi** à travers le tunnel
  (même mécanisme "adresse fantôme + NAT sur noisy" que les Deye).
- **Pas de Zigbee** prévu sur noisy dans un premier temps.
- **Nouveau RPi4** : sera envoyé sur le site noisy une fois prêt et testé. Héberge **Home Assistant
  lui-même** (Docker, même pattern que `ha2` — pas HAOS), devient le "cerveau" du site distant. Ne
  reprend PAS le rôle GPIO/RFXCOM. **Stratégie de montage** : toute l'instance "noisy" (HA + son
  mosquitto + dimotic-ha) est d'abord construite et testée **sur le PC de développement** (16 Go
  RAM, `amd64`), dans une pile Docker dédiée et isolée, puis transférée sur le RPi4 (`arm64`) par
  sauvegarde HA → restauration quand le RPi4 arrive. Le transplant amd64→arm64 est sans risque pour
  HA (config/`.storage`/SQLite indépendants de l'archi, image HA et image dimotic-ha multi-arch) et
  reste propre car toute la config matériel pointe vers les adresses overlay `10.10.10.x` stables.
  Écarté : monter sur `ha2` (RAM trop juste), monter directement sur le RPi4 (pas encore
  disponible).
- **Stockage** : le RPi3 (noisy) garde son SSD actuel tel quel — pas de transplantation. Le RPi4 aura
  sa propre clé USB, indépendante.
- **Accès actuel à noisy** : SSH déjà possible depuis ici.

**Point non tranché** : jamais confirmé explicitement si "noisy" est le même site que "chez la fille
de l'utilisateur" évoqué le 08/09/2026 (RPi3 + RFXCOM + GPIO relais de puissance — descriptions très
proches). Sans impact sur le plan ci-dessous, mais à vérifier pour ne pas dupliquer une mémoire.

---

## 2. Architecture réseau — 3 réseaux

Problème de départ : le réseau d'ici et le réseau de noisy utilisent **tous les deux**
`192.168.1.0/24` — deux sous-réseaux identiques ne peuvent pas être routés simplement l'un vers
l'autre.

| Réseau | Plage | Nature | Qui y est |
|---|---|---|---|
| Ici | `192.168.1.0/24` | Physique | Tout le parc actuel (ha2, stfort, orangepi...) |
| noisy | `192.168.1.0/24` | Physique | Le RPi3 noisy + les Deye (`.146`) + le BS-1000 AREXX (`logXX`) + tout le reste sur place |
| **WireGuard (overlay)** | `10.10.10.0/24` | Virtuel | Uniquement les machines qui installent WireGuard |

**Rôles** :
- **Serveur WireGuard sur `noisy`** (le RPi3) — pas sur le RPi4, qui change de lieu physique en
  cours de projet. `noisy` est déjà stable, déjà sur place en permanence, déjà accessible en SSH.
  Adresse overlay : `10.10.10.1`.
- **RPi4 = client WireGuard permanent** — adresse overlay fixe `10.10.10.2`, utilisée aussi bien
  pendant le montage ici que plus tard une fois branché à noisy (aucune reconfiguration réseau le
  jour de l'expédition — c'est tout l'intérêt).

**Appareils du LAN de noisy non-WireGuard, joignables depuis ici** (les 2 Deye `.146`, le BS-1000
AREXX `logXX`, tout autre à venir) : adresse "fantôme" dans le réseau overlay, même dernier octet
que leur vraie adresse locale (ex. `10.10.10.146` → `192.168.1.146` sur le réseau LOCAL de noisy ;
`10.10.10.<octet BS-1000>` → `192.168.1.<octet BS-1000>`). Cette correspondance est portée
**uniquement par `noisy`** (pas le RPi4, pas de config globale), via deux mécanismes à poser dessus,
une entrée par appareil :
1. Une **route** annoncée côté serveur WireGuard (`noisy` sait qu'il doit relayer `10.10.10.x`).
2. Une règle **NAT** (`iptables`/`nftables`) qui traduit dans les deux sens entre le tunnel et son
   réseau local.

**Conséquence sur la config dimotic-ha de noisy** : `ha.mqtt.host` pointe vers l'IP overlay du RPi4
(`10.10.10.2`), **jamais** vers une IP `192.168.1.x` — stable avant et après l'expédition du RPi4.

**Bonus** : ce même tunnel donne à l'utilisateur un accès admin pérenne et sécurisé à tout le site
noisy depuis chez lui, pas seulement pendant la phase de montage.

---

## 3. Plan d'actions

### Phase 1 — Réseau (WireGuard)
1. Générer une paire de clés WireGuard pour `noisy` et une pour le client "instance noisy" (`10.10.10.2`).
   Cette identité client vit d'abord sur le **PC de dev** (Phase 3), puis migre sur le **RPi4** à la
   bascule (Phase 5) — même clé/même adresse, seul l'emplacement change.
2. Installer WireGuard sur `noisy`, config serveur : interface `10.10.10.1/24`, peer client autorisé
   (`10.10.10.2`).
3. Poser les règles NAT sur `noisy`, une par appareil à joindre depuis le tunnel : `10.10.10.146` ↔
   `192.168.1.146` (Deye), `10.10.10.<octet>` ↔ `192.168.1.<octet>` (BS-1000 AREXX `logXX`), dans
   les deux sens.
4. Monter le client WireGuard sur l'hôte du PC de dev (config client : interface `10.10.10.2/24`,
   serveur = `noisy`).
5. Vérifier : ping `10.10.10.1` ↔ `10.10.10.2` depuis les deux côtés, puis test Modbus TCP réel vers
   `10.10.10.146` (les Deye) depuis le PC de dev.

### Phase 2 — Migration de l'ancienne domotique sur noisy
6. Auditer le code de l'ancienne domotique sur noisy : où accède-t-elle directement au GPIO et au
   RFXCOM aujourd'hui (fichiers/modules concernés, équivalent de `gpioserv.js`/`rfxcombridge.js`
   côté stfort).
7. Sauvegarde complète avant modification (CLAUDE.md règle 5).
8. Installer dimotic-ha sur noisy (Docker), seuls `rfxcom` + `rpigpio` activés, config pointant
   `ha.mqtt.host` vers `10.10.10.2` (le RPi4, via le tunnel).
9. Adapter l'ancienne domotique : retirer l'accès matériel direct, ajouter le pont MQTT vers les
   nouveaux drivers (sur le modèle `rfxcombridge.js`/`gpiobridge.js`).
10. Vérifier en conditions réelles sur noisy (comme fait sur stfort en son temps) : commande réelle
    → pont → MQTT → driver → matériel, et retour.

### Phase 3 — Construction de l'instance "noisy" sur le PC de dev (avant réception du RPi4)

**Stratégie retenue (10/09/2026)** : monter et configurer toute l'instance "noisy" **sur le PC de
développement** (16 Go RAM, Docker déjà en place, sur le réseau `192.168.1.0/24` d'ici), dans une
pile Docker **dédiée et isolée**, puis la transférer sur le RPi4 par sauvegarde HA → restauration
quand le RPi4 arrive. Permet de commencer le travail de config tout de suite. Pas sur `ha2` (RAM
trop juste), pas directement sur le RPi4 (pas encore disponible).

11. Sur le PC de dev, créer la pile Docker dédiée "noisy", isolée du reste :
    - `homeassistant-noisy` — dossier de config dédié, port distinct (ex. `8124:8123`).
    - `mosquitto-noisy` — broker séparé (ex. `1884:1883`), aucun partage avec un autre broker (sinon
      découverte MQTT croisée entre instances HA).
    - `dimotic-ha-noisy` — image `zdid2/dimotic-ha` (déjà multi-arch), `core` + apps du site
      (`arexx` activé), pointé sur `mosquitto-noisy`.
12. Installer un **client WireGuard sur l'hôte du PC de dev** (le plus simple — toute la pile route
    vers `10.10.10.x` via la table de routage de l'hôte). Migrera sur le RPi4 à la bascule.
13. Configurer l'intégration Modbus TCP/Solarman pour les 2 Deye (via `10.10.10.146`, finalise les
    tests bloqués sur `stfort` par Python 3.7).
14. Configurer l'intégration Tuya Local pour la prise de pilotage de la batterie.
15. Configurer l'application `arexx` de `dimotic-ha-noisy` : lecture HTTP directe du BS-1000 (mode
    poll, `bs1000Port`), pointée sur l'adresse fantôme du BS-1000 (`10.10.10.<octet>`).

### Phase 4 — Tests de bout en bout sur le PC de dev (avant réception du RPi4)
16. Vérifier tout le chemin complet en conditions quasi réelles : ancienne domotique (noisy) → pont
    MQTT → dimotic-ha (noisy) → tunnel WireGuard → `dimotic-ha-noisy` + `homeassistant-noisy` (PC de
    dev) → automatisations/dashboard.
17. Vérifier RFXCOM et rpigpio (relais) commandables depuis HA à travers tout le chemin.
18. Vérifier les données Modbus (Deye), la prise Tuya (batterie) et les capteurs AREXX (BS-1000)
    remontent bien dans HA.

### Phase 5 — Bascule sur le RPi4 puis sur site
19. **À réception du RPi4** : flasher une image récente 64 bits (Python 3.8+, Docker-ready) sur sa
    clé USB, installer Docker.
20. **Sauvegarde HA** de l'instance `homeassistant-noisy` (`Paramètres > Système > Sauvegardes`,
    `.tar`) + copie de la config `data/` de `dimotic-ha-noisy` + config `mosquitto-noisy`.
21. **Restauration sur le RPi4** : HA vierge → restauration de la sauvegarde ; remettre les ports
    standards (`8123`, `1883`), retirer le suffixe `-noisy` des noms de conteneurs ; déplacer le
    client WireGuard du PC de dev vers le RPi4. Rien à reconfigurer côté intégrations (adresses
    overlay `10.10.10.x` stables).
22. Vérification complète sur le RPi4 encore ici (mêmes tests que Phase 4).
23. Expédier le RPi4 vers noisy.
24. Sur place : brancher alimentation + réseau — aucune reconfiguration réseau attendue.
25. Vérification finale à distance (via WireGuard) une fois branché.

---

## 4. Points ouverts

- Confirmer explicitement si "noisy" = le site "chez la fille" de l'utilisateur (voir §1).
- Marque/modèle exact de l'onduleur Solarman/Deye (déjà su : Deye + Solarman ; modèle précis pas
  demandé).
- IP fixe à réserver pour le RPi4 sur le réseau LOCAL de noisy une fois sur place — moins critique
  maintenant que la config pointe vers l'IP overlay WireGuard plutôt que l'IP LAN, mais reste à
  choisir pour l'accès HA lui-même depuis le LAN local de noisy.
- Détail des apps dimotic-ha à activer sur le RPi4 au-delà de `core` — connu à ce jour : `arexx`
  (lecture HTTP directe du BS-1000). Le reste selon les besoins réels du site, pas encore discuté.
- Adresse locale exacte du BS-1000 AREXX sur le réseau de noisy + son nom `logXX` (numéro à relever,
  via un balayage réseau une fois le tunnel en place, ou connu de l'utilisateur) — nécessaire pour
  poser sa route + règle NAT et configurer l'app `arexx` sur le RPi4.
