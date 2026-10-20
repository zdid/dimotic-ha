# Conception — Gestion de l'énergie : batteries et ballons d'eau chaude (ECS)

*Version 1.0 — 20 octobre 2026 — première rédaction, issue de la discussion du 20/10/2026 avec l'utilisateur. Ce document décrit les **contraintes de chaque site**, les **règles** retenues pour les batteries et pour les ballons, des **exemples chiffrés**, et ce qui est **réalisé** ou **à faire**.*

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

> seuil = (1 − tarif creux / tarif du moment) × puissance d'un ballon

| Période | Seuil (ballon de 2000 W) |
|---|---|
| Heures pleines | (1 − 0,1589 / 0,2142) × 2000 = **516 W** |
| Heures creuses | (1 − 0,1589 / 0,1589) × 2000 = **0 W** |

### 5.3 Règle selon la période

| Période | Départ du ballon | Batterie |
|---|---|---|
| **Heures pleines** | batterie > 65 % ET surplus ≥ 516 W. Une fois en marche : continue tant que la batterie reste > 55 % ; à 55 % arrêt immédiat ; il faut **remonter au-dessus de 65 %** pour repartir ; si le surplus passe sous 516 W pendant 7 minutes, arrêt | peut compléter le surplus (jusqu'à 55 %) |
| **Heures creuses avec soleil** (midi à noisy) | batterie > 65 % ET surplus > 0 W : le soleil charge la batterie d'abord, le ballon prend le reste | **verrouillée en décharge** : le complément vient du réseau, au tarif creux |
| **Heures creuses de nuit** | dès qu'un ballon n'est pas terminé, sans condition de batterie | verrouillée en décharge |

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

### 5.5 Forçage de fin de journée

Aujourd'hui : le premier ballon est forcé à **16 h** (en heures pleines), le second au début de la creuse de nuit. Il serait plus économique de forcer le premier au **début de la prochaine plage creuse** : à décider.

## 6. Réalisé / à faire

| Élément | Site | État |
|---|---|---|
| Planchers de batterie réglables + automatisation `batterie_reserve_nuit_attente_emma` (planchers nuit/matin/journée, formule §4.2) | ha2 | **réalisé le 20/10/2026** (l'ancienne version est sauvegardée) |
| Règle actuelle de détection d'excédent (`excedent_solaire_detection`) : batterie > `seuil_batterie_ballons` (60 %) ET injection > `seuil_injection_ballons` (516 W) | ha2 | **réalisée** (étape intermédiaire) |
| Capteurs et réglages tarifaires : tarifs, puissance du ballon, `sensor.seuil_injection_ballons`, `sensor.surplus_disponible_ballons` | ha2 | **créés** ; le surplus n'est pas encore utilisé |
| Règle complète des ballons (§5 : surplus, plage 55/65 %, heures creuses, seuil variable) | ha2 | **à faire** |
| Heures creuses saisies à la main + capteurs `heures_creuses`, `periode_tarifaire`, `prochain_changement_tarifaire` | noisy2 | **réalisés** |
| Règles de batterie et de ballons | noisy2 | **à faire** (commandes de la Marstek : §4.4) |
| Forçage de fin de journée déplacé vers la creuse | ha2 / noisy2 | **à décider** |

## 7. Points ouverts

1. La limite haute de la fenêtre du matin (10 h) et l'ordre du plancher du matin (10 %) dépendent du niveau de fin de décharge matériel : tant qu'il reste à 15 %, le plancher du matin est en pratique de 15 %.
2. Le blocage par l'interrupteur de la Marstek n'a pas été essayé en réel.
3. La production solaire minimale pour parler de « creuse avec soleil » (300 W) est à valider.
4. Les tarifs de noisy sont à renseigner.
