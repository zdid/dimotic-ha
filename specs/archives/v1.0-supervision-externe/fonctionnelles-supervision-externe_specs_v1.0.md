# Spécifications Fonctionnelles - Supervision Externe Indépendante + Alerte (SUPERVISION-EXTERNE)

**Version 1.0 — 16/09/2026 — Claude**

Statut : **conception, discussion seulement — aucun code écrit**. Première version de cette spec,
extraite d'une discussion avec l'utilisateur le 16/09/2026, jusqu'ici suivie uniquement dans
`TODO.md` ("🟡 Supervision multi-sites indépendante + alerte hors HA").

⚠️ **Ne pas confondre avec `fonctionnelles-supervisor_specs_v2.8.md`** ("SUPERVISOR") : cette dernière
couvre le registre de présence multi-machines **interne** à dimotic-ha (bus MQTT unifié, cycle de vie
des applications, agents minimaux) — elle est un **prérequis/une brique réutilisée** par la présente
spec, pas la même chose. "SUPERVISION-EXTERNE" couvre la couche **au-dessus**, volontairement
indépendante du chemin critique HA/dimotic-ha, dont le rôle est justement de survivre à leur panne.

---

## 1. Origine du besoin

Le registre de présence multi-machines existant (`fonctionnelles-supervisor_specs_v2.8.md` §6.4,
décentralisé, survit à la perte du broker/d'une machine grâce à une copie locale horodatée) ne sert à
rien pour **alerter** si **HA lui-même** est en panne — l'alerte normale (notification HA) dépend
justement de ce qui est en panne. Il faut un mécanisme d'observation et d'alerte **en dehors** du
chemin critique HA/dimotic-ha.

## 2. Conception retenue

Un ou plusieurs nœuds de supervision **indépendants** — abonnés **en lecture seule** au registre de
présence déjà existant (`dimotic/supervisor/+/status`/`.../apps`), qui alertent dans HA quand il est
joignable, sinon par un canal direct qui ne dépend pas de HA (§5).

### 2.1 Matériel

Recyclage de vieux **Raspberry Pi v1** — délibérément du matériel "sacrifiable" : si la surveillance
elle-même tombe en panne, c'est moins grave qu'une panne du système surveillé (principe explicite de
l'utilisateur).

**Deux RPi, un par site** (stfort + noisy), **chacun surveillant les deux sites** (redondance) —
appuyé sur `TargetGossipService` (déjà en place, pont WireGuard existant entre les sites) pour la
visibilité cross-site, sans rien construire de nouveau côté réseau.

**Différé, à chiffrer avant de trancher** : est-ce que les deux RPi de supervision se surveillent
aussi **mutuellement** (fermer la boucle) ou restent volontairement simples (chacun surveille les 2
sites, sans se soucier de l'état de l'autre RPi) — coût/complexité à évaluer avant de décider.

### 2.2 Pattern technique de référence

L'agent minimal RPi1 déjà construit et vérifié en conditions réelles pour `teleinfo`
(`fonctionnelles-supervisor_specs_v2.8.md` §11.5 — JS brut sans build, ARMv6/Node12, LWT + heartbeat
30s) — même classe de matériel, prouve la faisabilité de faire tourner quelque chose d'utile sur ce
matériel contraint.

**Rôle inversé** par rapport à ce pattern existant : là où l'agent `teleinfo` *se fait surveiller* (il
publie sa présence), le RPi de supervision *surveille les autres* — il écoute la présence publiée par
tout le monde au lieu de publier la sienne.

## 3. Périmètre à surveiller

- **Machines/applications dimotic-ha** — déjà dans le registre de présence existant, rien à ajouter
  côté publication.
- **zigbee2mqtt et "autres"** (non dimotic-ha) — ne publient pas dans ce registre aujourd'hui.
  **Mécanisme non tranché** : soit les faire publier dans le registre existant (format
  `dimotic/supervisor/...`), soit les sonder directement via leur propre LWT/API sans y toucher.
- **Sauvegardes** (⭐ 16/09/2026, ajouté à cette conception) — voir §4.

## 4. Surveillance des sauvegardes — ajouté (16/09/2026)

⭐ Décision explicite : la supervision des sauvegardes (`fonctionnelles-sauvegarde_specs_v1.0.md`) fait
partie du périmètre de cette spec dès sa conception initiale, pas un ajout ultérieur séparé.

Le point d'accroche existe déjà côté sauvegarde, pensé précisément pour ça : `fonctionnelles-sauvegarde_specs_v1.0.md`
§5ter — chaque script de sauvegarde écrit un **marqueur de statut local** (`dernière-sauvegarde.json` :
horodatage + succès/échec, par répertoire Docker couvert) à chaque exécution. Le RPi de supervision n'a
qu'à **lire ce fichier** (ou, si le mécanisme retenu en §3 s'y prête, une publication dérivée dans le
registre de présence) plutôt qu'un nouveau protocole de statut de sauvegarde à inventer — aucune
dépendance construite dans l'autre sens (le script de sauvegarde n'a besoin de rien de la supervision
pour fonctionner, voir `fonctionnelles-sauvegarde_specs_v1.0.md` §5ter).

**Alerte déclenchée** (même canal que §5) si : le marqueur indique un échec, **ou** s'il est absent/trop
ancien par rapport à la fréquence attendue (`fonctionnelles-sauvegarde_specs_v1.0.md` §5 — hebdomadaire
garanti au minimum) — une sauvegarde qui ne s'est simplement pas déclenchée doit être détectée au même
titre qu'un échec explicite.

**Non tranché** : comment le RPi de supervision accède au fichier de statut de chaque machine (lecture
distante via le même accès que le registre de présence ? republication du contenu du marqueur sur un
topic MQTT dédié, plus simple à observer à distance sans accès fichier ?).

## 5. Canal d'alerte

**Priorité 1 — HA**, quand joignable (notification native).

**Priorité 2 — canal direct, hors HA** : SMS/email — legacy `zdidnodesmsusb`/`zdidnodedomomail`
constatés actifs et fonctionnels sur noisy (dongle USB GSM + email) pendant la session du 16/09/2026,
réutilisables tels quels. **À vérifier si stfort a l'équivalent.**

## 6. Hors scope de cette version

- Mécanisme précis de sondage de zigbee2mqtt/"autres" (§3) — non tranché.
- Surveillance mutuelle des deux RPi de supervision entre eux (§2.1) — différé.
- `fonctionnelles-sauvegarde_specs_v1.0.md` elle-même (mécanisme de création/poussée des sauvegardes,
  application de restauration) — spec séparée, référencée ici uniquement pour la surveillance (§4).

## 7. Plan de mise en œuvre (à faire)

1. Vérifier la disponibilité d'un canal SMS/email équivalent sur stfort (§5).
2. Trancher le mécanisme de sondage zigbee2mqtt/"autres" (§3).
3. Trancher le mode d'accès du RPi de supervision au marqueur de statut des sauvegardes (§4).
4. Écrire l'agent RPi1 (pattern §2.2) : abonnement en lecture seule au registre de présence,
   détection d'absence/péremption, déclenchement d'alerte (§5).
5. Décider de la surveillance mutuelle des deux RPi (§2.1) une fois le reste en place, en évaluant le
   coût réel constaté.
6. Tester en conditions réelles : couper une machine/app volontairement, vérifier l'alerte HA puis,
   HA coupé, vérifier le repli SMS/email.
