# Conception — Module UPS HAT (E) : lecture de la batterie et alerte de coupure

*Version 1.0 — 20 octobre 2026 — première rédaction. Installé et validé sur **ha2** (Raspberry Pi 4) le 20/10/2026. Installation sur l'Orange Pi 4 Pro **à faire** (carte pas encore alimentée).*

## 1. Objet

Un module UPS alimente ha2 (Saint Fort) en cas de coupure de courant mais rien ne lisait son état. Ce document décrit la lecture du module (I2C), sa publication dans Home Assistant (MQTT) et l'alerte envoyée aux administrateurs.

## 2. Matériel

| | |
|---|---|
| Module | UPS HAT (E) pour Raspberry Pi 5 (clone du Waveshare UPS HAT (E), vendeur SHCHV, AliExpress 1005007575979264) : 4 piles 21700 (non fournies), sortie 5 V / 6 A conseillés (10 A max), USB-C 40 W |
| Liaison | quatre contacts à ressorts (pogo pins) sur le connecteur 40 broches **2, 3, 5 et 9** |
| Bus | I2C, adresse **0x2D** (puces BQ4050 et IP2368, vérifiées par le registre 0x03) |
| Lecture seule | **ne jamais écrire dans le registre 0x01 : écrire 0x55 éteint la carte** |

### 2.1 Brochage selon la carte

| Pin | Raspberry Pi 4 | Orange Pi 4 Pro (manuel v1.4, §3.15 et §3.17.4) | Module |
|---|---|---|---|
| 2 | 5 V | 5 V | alimentation |
| 3 | SDA (GPIO2) | TWI0_SDA (PB3, bus **I2C0**) | I2C données |
| 5 | SCL (GPIO3) | TWI0_SCK (PB2, bus **I2C0**) | I2C horloge |
| 9 | GND | GND | masse |

Tous les GPIO de l'Orange Pi sont en 3,3 V. **Orange Pi** : l'I2C est désactivé par défaut (`orangepi-config` → *System* → *Hardware* → *i2c0*, puis redémarrage). Alimentation par la pin 5 V autorisée par le constructeur (§2.11) mais l'USB-C 5 V / 5 A reste recommandé : ne pas brancher l'USB-C en même temps que le module.

## 3. Registres lus (adresse 0x2D, octet bas à l'adresse paire)

| Registre | Contenu | Unité |
|---|---|---|
| 0x00 | identifiant, vaut 0x0A | — |
| 0x02 | bit 7 en charge, bit 6 charge rapide, bit 5 **secteur présent (VBUS)**, bits 2-0 état (0 veille, 1 entretien, 2 courant constant, 3 tension constante, 4 attente, 5 pleine, 6 timeout) | — |
| 0x03 | bit 1 communication BQ4050 OK, bit 0 communication IP2368 OK | — |
| 0x10 / 0x12 / 0x14 | tension / courant / puissance du secteur (VBUS) | mV / mA / mW |
| 0x20 | tension batterie totale | mV |
| 0x22 | courant batterie, **signé** : positif = charge, négatif = décharge | mA |
| 0x24 / 0x26 | pourcentage / capacité restante | % / mAh |
| 0x28 / 0x2A | temps de décharge / de charge restant (65535 = non applicable) | min |
| 0x30 à 0x36 | tensions des cellules 1 à 4 | mV |
| 0x50 | version logicielle (0x14 = V2.0) | — |

**À ne pas toucher** : 0x01 (arrêt si on y écrit 0x55), 0x40 à 0x43 (watchdog, adresse I2C).

## 4. Service `ups-hat-e`

Script Python (`scripts/ups-hat-e/ups_hat_e.py`) lancé par systemd (`/opt/ups-hat-e/`, `ups-hat-e.service`), lecture toutes les **10 s**. Dépendances : `python3-smbus`, `python3-paho-mqtt`, `i2c-tools`.

- **Découverte** publiée sous `homeassist/…` (reprise par `nommage`, qui ajoute la taxonomie et la pièce) ; état sur `ups-hat-e/<id>/etat` (retenu) ; disponibilité sur `ups-hat-e/<id>/disponibilite` (testament « offline »). Après 3 lectures I2C ratées, l'appareil passe « offline ».
- **16 entités** : `batterie` (%), tension et courant de la batterie, capacité restante, autonomie restante, tension, courant et puissance du secteur, état de charge, quatre cellules, écart entre cellules (mV), et deux indicateurs « Secteur » et « En charge ».
- **Nom d'appareil** : `ups---ha2--infra` (variable `UPS_NOM_APPAREIL`) ; sur ha2 les entités sont `sensor.infra_ha2_batterie`, `binary_sensor.infra_ha2_secteur`, etc.

## 5. Alerte (décision du 20/10/2026 : alerte seulement, pas d'arrêt automatique de ha2)

Automatisation `ups_ha2_alertes` (ha2), via `script.notifier_administrateurs` (téléphones des administrateurs) :

| Événement | Message |
|---|---|
| secteur absent depuis **1 minute** | « Coupure de courant à Saint Fort » + niveau de batterie |
| secteur de retour | « Courant rétabli à Saint Fort » |
| batterie < **30 %** pendant une coupure | « Batterie du UPS faible » (permanent) |

Aucun arrêt propre n'est commandé : si la batterie s'épuise, ha2 s'éteint comme sans UPS. Un arrêt sur seuil bas pourra être ajouté plus tard (le module le permet, voir §7).

## 6. Valeurs relevées sur ha2 (20/10/2026)

Batterie 97 % (16,39 V, 4628 mAh), secteur présent (4,9 V, 1,0 à 1,3 A, environ 5 à 6 W), état de charge « tension constante », cellules 4,169 / 4,089 / **3,949** / 4,186 V. **Écart de 237 mV : la cellule 3 est déséquilibrée**, à suivre avec `Écart entre cellules` (si l'écart augmente, la cellule vieillit).

## 7. Réalisé / à faire

| Élément | État |
|---|---|
| I2C activé sur ha2 (à chaud + `config.txt`, sauvegarde `config.txt.bak-20261020-i2c`), module lu, service `ups-hat-e`, 16 capteurs, automatisation d'alerte | **réalisé le 20/10/2026** |
| Essai réel de l'alerte (coupure de courant) | **non fait** |
| Spec dans le dépôt + script versionné (`scripts/ups-hat-e/`) | **fait** |
| Installation sur l'Orange Pi 4 Pro (activer i2c0, `i2cdetect`, service avec `UPS_I2C_BUS` et un autre `UPS_ID`) | **à faire** (carte à alimenter) |
| Arrêt propre sur batterie basse (le module sait éteindre la carte par le registre 0x01 : à ne faire qu'avec une règle explicite) | **non retenu** |

## 8. Points ouverts

1. Le bus Linux de l'I2C0 sur l'Orange Pi (`/dev/i2c-?`) est à lire avec `i2cdetect -l` après activation.
2. Seuil de l'alerte « batterie faible » (30 %) à ajuster selon l'autonomie observée en coupure réelle.
3. Surveillance de la cellule 3 (alerte si l'écart dépasse un seuil à définir).
