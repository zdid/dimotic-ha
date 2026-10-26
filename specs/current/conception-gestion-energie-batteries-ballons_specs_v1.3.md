# Conception — Gestion de l'énergie : batteries et ballons d'eau chaude (ECS)

*Version 1.3 — 22 octobre 2026 — **deux paliers de puissance du petit ballon documentés** (§5.2bis, observés sur 9 jours : ~2 050 W puis ~820 W selon la chaleur de l'eau, pas selon la durée). *Version 1.2 — 22 octobre 2026 — **forçage de 16 h supprimé** (§5.6) ; **deux ballons de nuit en parallèle avec 5 minutes de décalage** (§5.3) ; **second ballon en journée** quand le solaire le permet (§5.7) ; **puissance par ballon** : gros 1 800 W, petit 2 050 W (§5.2). *Version 1.1 — 20 octobre 2026 — **règle des ballons appliquée sur ha2** (§5.6, §6) ; **nuit corrigée** (§5.3) : plus de verrou de la batterie, plancher de 20 % comme pour la batterie. *Version 1.0 — 20 octobre 2026 — première rédaction, issue de la discussion du 20/10/2026 avec l'utilisateur. Ce document décrit les **contraintes de chaque site**, les **règles** retenues pour les batteries et pour les ballons, des **exemples chiffrés**, et ce qui est **réalisé** ou **à faire**.*

## 1. Objet

Décider, pour chaque site, **quand** une batterie peut se décharger et **quand** un ballon d'eau chaude peut chauffer sur le surplus solaire, en tenant compte :
- de l'écart de prix entre heures pleines et heures creuses ;
- de la réserve à garder pour une coupure de courant ;
- du fait qu'une batterie ne doit **jamais être rechargée depuis EDF** par un réglage mal calé.

Les règles sont **les mêmes** pour tous les sites ; seuls changent les contraintes (§2) et les commandes de chaque batterie (§4.4).

## 2. Les sites et leurs contraintes

| | **Saint Fort** (ha2) | **noisy** (noisy2) |
|---|---|---|
| Batterie | Huawei LUNA, 6,9 kWh (via EMMA), un seul bloc | Marstek Venus E (via Omnibattery), 5,12 kWh |
| Puissance max charge / décharge | 3500 W / 3500 W | 2000 W (réglable 800 à 2500 W) |
| Plancher matériel de décharge | 15 % (« fin de décharge », réglable 0 à 20 %) | 12 % (« discharging cutoff », réglable 12 à 50 %) |
| Heures creuses | **la nuit seulement**, environ 21:21 → 05:20 (bascule lue sur la Linky : `sensor.compteur_linky_compteur_current_price`) | **deux plages** : 01:37 → 07:37 et 12:37 → 14:37, **saisies à la main** (les compteurs ne les donnent pas) |
| Capteur « heures creuses » | celui de la Linky | `binary_sensor.heures_creuses`, `sensor.periode_tarifaire`, `sensor.prochain_changement_tarifaire` (calculés depuis 4 réglages `input_datetime.heures_creuses_*`) |
| Ballons ECS | oui, 2 ballons en série (petit et gros) | oui |
| Tarifs | jour 0,2142 €/kWh, nuit 0,1589 €/kWh | à renseigner |

**Tarifs et écart** : l'écart de prix entre pleines et creuses vaut 1 − 0,1589 / 0,2142 = **25,8 %**.

## 3. Principe : la valeur du kWh

| Où va un kWh solaire | Ce qu'il évite | Valeur |
|---|---|---|
| dans la batterie | un achat en heures pleines plus tard | 0,2142 € |
| dans le ballon | une chauffe au tarif creux | 0,1589 € |
| vers le réseau | rien (revente éventuelle) | — |

→ **la batterie passe avant le ballon** ; l'énergie de la batterie vaut plus que le courant du réseau en heures creuses, donc la batterie ne se vide pas dans un ballon pendant une plage creuse sauf nécessité.

## 4. Règles des batteries

### 4.1 Le niveau de secours
Le niveau de secours (`soc_de_la_batterie_de_secours` sur Huawei) est le **plancher** sous lequel la batterie ne se décharge pas. **S'il est réglé au-dessus du niveau réel, la batterie se recharge depuis le réseau** : c'est ce qu'il faut éviter.

### 4.2 Formule

> **secours = le plus petit de (plancher effectif, niveau de la batterie + 1)**, recalculé **toutes les 5 minutes**

avec **plancher effectif = le plus grand de (plancher du moment, plancher absolu)**.

### 4.3 Les planchers (réglables dans HA)

| Moment | Plancher | Valeur de départ |
|---|---|---|
| **Nuit** (heures creuses) | `input_number.plancher_batterie_nuit` | 20 % (réserve en cas de coupure) |
| **Matin** (de la fin de la creuse jusqu'à l'heure de fin de fenêtre) | `input_number.plancher_batterie_matin` | 10 % |
| **Journée** (de la fin de fenêtre jusqu'à la nuit) | `input_number.plancher_batterie_journee` | 20 % |
| **Plancher absolu** (aucun plancher ne descend plus bas) | `input_number.plancher_batterie_absolu` | 15 % (le plancher matériel) |
| **Heure de fin de fenêtre du matin** | `input_datetime.fin_fenetre_matin_batterie` | 10:00 |

Pour une batterie qui ne doit pas descendre sous 15 %, on met le plancher absolu à 15 (c'est la valeur de départ).

### 4.4 Commandes selon la batterie

| Besoin | Huawei LUNA (ha2) | Marstek (noisy2) |
|---|---|---|
| Bloquer la décharge | secours = niveau + 1 | interrupteur `batterie_marstek_battery_allow_discharge` à arrêt |
| Régler le plancher | secours (0 à 100 %) | `discharging_cutoff_capacity` (12 à 50 %) **sans jamais le monter au-dessus du niveau actuel** |
| Plancher absolu | 15 % | 12 % |
| Risque de recharge par EDF | écarté par le « +1 » | **constaté** quand le plancher de coupure dépasse le niveau : on bloque donc par l'interrupteur, pas par le plancher |

### 4.5 Exemples (ha2, planchers de départ)

| Phase | Batterie | Plancher effectif | Secours réglé | Effet |
|---|---|---|---|---|
| Nuit | 70 % | 20 | 20 | la batterie alimente la maison jusqu'à 20 % |
| Nuit | 18 % | 20 | 19 | bloquée à son niveau, **aucune recharge EDF** |
| Matin (avant 10 h) | 50 % | max(10, 15) = 15 | 15 | descend jusqu'à 15 % (plancher absolu) |
| Matin (avant 10 h) | 12 % | 15 | 13 | bloquée (sous le plancher absolu) |
| 10 h, batterie à 12 % | 12 % | 20 | 13 | bloquée à 13 %, puis le secours **suit la charge** : 14, 15… jusqu'à 20 % |
| Journée | 87 % | 20 | 20 | la batterie alimente la maison jusqu'à 20 % |

## 5. Règles des ballons ECS

### 5.1 Surplus disponible

> surplus = charge de la batterie (négative si elle se décharge) + injection Linky − soutirage Linky + puissance des ballons déjà en marche

La puissance des ballons en marche est **ajoutée** pour que le ballon ne se coupe pas lui-même en consommant le surplus.

### 5.2 Seuil de surplus

> seuil = (1 − tarif creux / tarif du moment) × puissance **du ballon concerné**

Puissances (22/10/2026) : **gros ballon 1 800 W**, **petit ballon 2 050 W** (`input_number.puissance_gros_ballon`, `input_number.puissance_petit_ballon`). Le seuil du **premier** ballon (celui que l'excédent démarre) est `sensor.seuil_injection_ballons` ; celui du **second** est `sensor.seuil_injection_second_ballon`.

| Période | Gros ballon (1 800 W) | Petit ballon (2 050 W) |
|---|---|---|
| Heures pleines | (1 − 0,1589 / 0,2142) × 1800 = **465 W** | (1 − 0,1589 / 0,2142) × 2050 = **529 W** |
| Heures creuses | **0 W** | **0 W** |

*(Les exemples du §5.4 gardent l'ancienne valeur de 2 000 W, qui donnait 516 W.)*

### 5.2bis Deux paliers de puissance (observé le 22/10/2026)

Les moyennes sur 5 minutes de `sensor.petit_ballon_…_power` (9 jours) montrent que le **petit ballon a deux paliers** : environ **2 050 W** puis environ **820 W** (2 050 − 820 = 1 230 W : deux résistances, dont la plus grosse se coupe par thermostat quand l'eau est assez chaude). Le passage dépend de la **chaleur déjà stockée**, pas du temps :

| Cycle du petit ballon | Palier haut (~2 050 W) | Palier bas (~820 W) |
|---|---|---|
| départ à froid (14/10, 16/10, 19/10, 21/10) | 95, 90, 55, 50 min (3,3 à 1,7 kWh) | 75, 85, 35, 40 min |
| ballon déjà chauffé peu avant (15/10) | 10 min | 40 min |
| ballon déjà chaud (18/10) | aucun | 95 min dès le départ |

Le **gros ballon** reste à 1 700–1 800 W, sans second palier. Conséquences : les règles qui lisent la **puissance mesurée** (coupure sur manque de surplus, arrêt du second seul, fin sous 30 W pendant 30 min) s'adaptent d'elles-mêmes ; le seuil de **départ** utilise la puissance **haute** (2 050 W), prudente mais trop exigeante quand le ballon est déjà chaud (212 W suffiraient avec 820 W). Réglage informatif : `input_number.puissance_petit_ballon_palier_bas` (820 W, non utilisé par les règles).

### 5.3 Règle selon la période

| Période | Départ du ballon | Batterie |
|---|---|---|
| **Heures pleines** | batterie > 65 % ET surplus ≥ 516 W. Une fois en marche : continue tant que la batterie reste > 55 % ; à 55 % arrêt immédiat ; il faut **remonter au-dessus de 65 %** pour repartir ; si le surplus passe sous 516 W pendant 7 minutes, arrêt | peut compléter le surplus (jusqu'à 55 %) |
| **Heures pleines, second ballon** | le premier tourne depuis au moins 5 min, **surplus restant ≥ seuil du second ballon pendant 3 min**, batterie > 65 %, pas « un seul ballon » (§5.7) | idem |
| **Heures creuses avec soleil** (midi à noisy) | batterie > 65 % ET surplus > 0 W : le soleil charge la batterie d'abord, le ballon prend le reste | le complément vient du réseau, au tarif creux ; la batterie ne doit pas se vider dans le ballon (**à réaliser sur noisy2**, voir §4.4) |
| **Heures creuses de nuit** | dès qu'un ballon n'est pas terminé, sans condition de batterie (chauffe depuis le réseau) ; **les deux ballons chauffent en parallèle** : le premier au début de la plage, le second **5 minutes plus tard** (évite la pointe de démarrage) | plancher de nuit (20 %, §4) : elle peut alimenter la maison et le ballon jusqu'à 20 %, jamais en dessous ; pas de verrou, car la consommation d'EDF reste la même quelle que soit la vitesse de décharge |

« Avec soleil » : production solaire supérieure à environ 300 W.

### 5.4 Exemples (ha2, ballon de 2000 W)

| Batterie | Charge batt. | Injection | Soutirage | Ballons | Surplus | Période | Décision |
|---|---|---|---|---|---|---|---|
| 70 % | +1000 W | 200 W | 0 | 0 | 1200 W | pleines | **démarre** : prend 2000 W dont 800 W tirés de la batterie |
| 70 % | +300 W | 100 W | 0 | 0 | 400 W | pleines | attend (< 516 W) |
| 62 % | +1000 W | 0 | 0 | 0 | 1000 W | pleines | attend (la batterie doit dépasser 65 %) |
| 60 % | −800 W | 0 | 0 | 2000 W | 1200 W | pleines | continue (entre 55 et 65 %, en marche) |
| 55 % | peu importe | | | | | pleines | s'arrête tout de suite |
| 60 % | +2000 W | 0 | 0 | 0 | 2000 W | pleines, après arrêt | attend : doit remonter au-dessus de 65 % |
| 70 % | +300 W | 0 | 0 | 0 | 300 W | creuse de midi (noisy) | démarre (seuil 0 W) ; le réseau fournit le reste |
| 40 % | quelconque | | | | | creuse de nuit | chauffe depuis le réseau, batterie verrouillée |

### 5.5 Réalisation sur ha2 (20/10/2026)

L'indicateur `input_boolean.excedent_solaire` est piloté par `excedent_solaire_detection`, évaluée **chaque minute** (déclenchement par niveau, donc sûr après un redémarrage) :

| Événement | Condition | Action |
|---|---|---|
| Départ | indicateur éteint, heures **pleines**, batterie > `seuil_haut_batterie_ballons` (65 %), surplus ≥ `sensor.seuil_injection_ballons` | allumer |
| Arrêt immédiat | indicateur allumé, batterie ≤ `seuil_bas_batterie_ballons` (55 %) | éteindre |
| Arrêt par manque de surplus | surplus < seuil pendant 7 minutes consécutives | éteindre |
| Arrêt en creuse | début d'une plage creuse | éteindre |

Après un arrêt, le départ n'est possible que si la batterie est **repassée au-dessus de 65 %** (la condition de départ l'exige). `sensor.seuil_injection_ballons` vaut 516 W en heures pleines et 0 W en heures creuses (tarifs et puissance du ballon dans `input_number`). `chauffe_ballons_ecs_solaire` réagit à l'indicateur sans changement (premier ballon, second, forçages de 16 h et de nuit inchangés).

### 5.6 Forçage de fin de journée — supprimé (22/10/2026)

Le forçage du premier ballon **à 16 h**, en heures pleines, est **supprimé** : il chauffait au tarif plein (0,2142 €/kWh) alors que la plage creuse coûte 26 % de moins. À la place : au **début des heures creuses de nuit**, le **premier** ballon démarre s'il n'est pas terminé et, **5 minutes plus tard**, le second (§5.3). Quand un ballon finit (consommation < 30 W pendant 30 min, ou 3 h d'allumage), il se coupe et se marque « terminé » sans attendre l'autre. La coupure sur perte d'excédent n'agit plus qu'en **heures pleines** (elle ne coupe donc pas les ballons forcés en creuse). Conséquence : un jour sans soleil, l'eau chaude de la soirée n'est pas assurée avant la plage creuse (environ 21 h 20) ; elle se lance à la main si besoin.

### 5.7 Second ballon en journée (22/10/2026)

`sensor.surplus_restant_ballons` = charge de la batterie + injection − soutirage, **sans** ajouter la puissance des ballons (contrairement à `sensor.surplus_disponible_ballons`) : ce qui reste quand les ballons tournent.

| Événement | Condition | Action |
|---|---|---|
| Démarrage du second | excédent solaire allumé, heures pleines, premier ballon allumé depuis ≥ **5 min**, surplus restant ≥ `sensor.seuil_injection_second_ballon` pendant **3 min**, batterie > 65 %, second pas terminé et éteint, pas « un seul ballon » | allumer le second |
| Arrêt du seul second | excédent allumé, heures pleines, second allumé, **surplus restant + puissance du second < seuil du second × 0,5** pendant **5 min** | éteindre le second (le premier continue ; le seuil bas évite un va-et-vient juste après le démarrage) |
| Coupure générale | l'excédent solaire disparaît en heures pleines (surplus insuffisant 7 min, ou batterie à 55 %) | éteindre les deux (§5.5) |

Valeurs de départ (5 min, 3 min, 5 min, facteur 0,5) : **à régler** en observant une journée de soleil.

## 6. Réalisé / à faire

| Élément | Site | État |
|---|---|---|
| Planchers de batterie réglables + automatisation `batterie_reserve_nuit_attente_emma` (planchers nuit/matin/journée, formule §4.2) | ha2 | **réalisé le 20/10/2026** (l'ancienne version est sauvegardée) |
| Règle complète de détection d'excédent (§5.5) : surplus disponible, plage 55/65 %, seuil 516 W en pleines / 0 W en creuses ; anciens réglages (60 %, marge) supprimés | ha2 | **réalisée le 20/10/2026** |
| Capteurs et réglages : tarifs, puissance du ballon, seuils haut/bas, `sensor.seuil_injection_ballons`, `sensor.surplus_disponible_ballons`, `sensor.puissance_chaine_1/2` | ha2 | **créés** |
| Heures creuses saisies à la main + capteurs `heures_creuses`, `periode_tarifaire`, `prochain_changement_tarifaire` | noisy2 | **réalisés** |
| Règles de batterie et de ballons (dont verrou de décharge en creuse avec soleil) | noisy2 | **à faire** (commandes de la Marstek : §4.4) |
| Forçage de 16 h supprimé ; deux ballons en parallèle en creuse de nuit (décalage 5 min) ; second ballon en journée ; puissances par ballon (1 800 / 2 050 W) ; capteurs `surplus_restant_ballons`, `seuil_injection_second_ballon` ; automatisation `chauffe_ballons_ecs_solaire` (sauvegarde : `backups/ballons-2026-10-22/`) | ha2 | **réalisé le 22/10/2026**, à observer en conditions réelles |
| Forçage de fin de journée, deux ballons en creuse, second en journée | noisy2 | **à faire** |

## 7. Points ouverts

00. **Seuil de départ selon l'état du ballon** : l'affiner (820 W si le ballon est probablement déjà chaud, par exemple « terminé aujourd'hui » ou palier bas récent) ; une **sonde de température dans l'eau** serait la vraie solution (chauffer jusqu'à une température cible).
0. **Valeurs du second ballon en journée** (5 min, 3 min, 5 min, facteur 0,5) et **puissance réelle** des ballons : à confirmer par une journée de soleil ; `input_number.puissance_ballon_ecs` (2 000 W) n'est plus utilisé.
1. La limite haute de la fenêtre du matin (10 h) et l'ordre du plancher du matin (10 %) dépendent du niveau de fin de décharge matériel : tant qu'il reste à 15 %, le plancher du matin est en pratique de 15 %.
2. Le blocage par l'interrupteur de la Marstek n'a pas été essayé en réel.
3. La production solaire minimale pour parler de « creuse avec soleil » (300 W) est à valider.
4. Les tarifs de noisy sont à renseigner.
