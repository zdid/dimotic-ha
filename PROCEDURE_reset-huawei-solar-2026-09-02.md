# Procédure de remise à zéro du système solaire Huawei (SUN2000 + LUNA2000 + SmartGuard/EMMA)

<!-- Derniere modification: 2026-09-02 - Premier jet, rédigé avec l'utilisateur -->

Contexte (02/09/2026) : depuis l'installation du SmartGuard (qui embarque un EMMA), l'app
FusionSolar ne remonte plus d'information. L'utilisateur (qui est son propre installateur) a déjà
supprimé l'installation dans l'app et réinitialisé le SUN2000 et le LUNA2000, mais pas l'EMMA/
SmartGuard. Objectif final : repartir sur une base propre, puis activer le Modbus TCP sur l'EMMA
pour pouvoir déclarer le système dans Home Assistant (voir `TODO.md`, entrée "Inventaire mesures
électriques" — mémoire de session `project_electrical_measurement_inventory`).

⚠️ **Statut de chaque étape ci-dessous, à lire avant d'agir** : certaines sont confirmées par la
documentation officielle Huawei (source citée), d'autres sont des recommandations raisonnées mais
**non confirmées** par une source Huawei directe — clairement marquées comme telles. Ne pas traiter
les étapes non confirmées comme aussi fiables que les confirmées.

## Étape 1 — Supprimer les matériels fantômes dans FusionSolar

**⚠️ Non confirmé précisément pour ce cas** : Huawei a une FAQ officielle intitulée *"How can I
delete the offline legacy devices in the FusionSolar/SmartPVMS after I use a new SmartGuard"*
(justement le cas présent), mais la page est **expirée côté Huawei**
(`support.huawei.com/enterprise/en/doc/EDOC1100096889/8bafef7b/...`) — impossible d'en récupérer le
contenu exact. Une recherche sur le portail Knowledge Base Huawei n'a rien donné de pertinent : ce
portail (`support.huawei.com/enterprise`) couvre les produits réseau/datacenter, pas le solaire
résidentiel (qui vit sur `solar.huawei.com`, dont la recherche interne n'a pas pu être interrogée
avec les outils disponibles).

**Ce qui EST confirmé** (manuel utilisateur FusionSolar App) — mécanisme général de suppression
d'un appareil, applicable en attendant mieux :
1. Ouvrir l'app FusionSolar, sélectionner le site concerné sur l'écran d'accueil.
2. Aller sur l'écran "Device" (Appareils).
3. Sur la carte de l'appareil fantôme, choisir "Delete Device" (coin supérieur droit).
4. Deux choix possibles :
   - **"Unbind Device"** (détacher) : les données de fonctionnement restent en base **6 mois** — si
     l'appareil est rerattaché dans ce délai, il retrouve son historique.
   - **"Delete Device"** (supprimer) : efface immédiatement les données, pas de délai de grâce.
   - Pour un vrai nettoyage de fantômes qu'on ne compte pas réutiliser tels quels : **Delete Device**.

**À faire concrètement** : puisque l'installation entière a déjà été supprimée côté app, vérifier
d'abord si des appareils fantômes existent encore quelque part (site orphelin, appareil non
rattaché) avant de chercher à en supprimer un précisément — il est possible qu'il n'y ait plus rien
à nettoyer à ce niveau, et que le vrai blocage restant soit uniquement l'EMMA (étape 2).

## Étape 2 — Réinitialiser l'EMMA (embarqué dans le SmartGuard)

**Confirmé** (manuel utilisateur EMMA-A01/A02, Huawei) — l'EMMA embarqué dans le SmartGuard est le
même module logiciel que l'EMMA-A02 autonome (même description technique : connexion réseau FE/
WLAN, mêmes comptes installateur/utilisateur) :

1. Trouver le trou "RST" sur le boîtier SmartGuard (généralement près des connecteurs réseau).
2. Avec une pointe fine (trombone), appuyer fermement **entre 10 et 60 secondes**.
   - Cette plage réinitialise les mots de passe de connexion (compte installateur local, compte
     utilisateur) et détache le rattachement à l'ancienne installation.
   - ⚠️ **Ne pas dépasser 60 secondes** sans le vouloir : au-delà, c'est une réinitialisation
     d'usine complète (tout sauf les paramètres réseau/historique/alarmes) — plus destructeur que
     nécessaire pour ce cas.
3. **Non confirmé pour la version embarquée dans le SmartGuard précisément** — cette procédure est
   documentée pour l'EMMA-A02 autonome ; elle est *probablement* identique pour la version
   embarquée (même logiciel), mais aucune source Huawei ne le confirme explicitement pour ce
   boîtier. Vérifier d'abord la présence d'un trou RST au même endroit type ; sinon chercher
   l'étiquette/guide rapide fourni physiquement avec le SmartGuard.

**Alternative à tenter en premier, plus simple si elle fonctionne** : avant le reset physique,
essayer de recommissionner directement via l'app :
- Se connecter à FusionSolar avec un compte **"Solar Installer"** (type de compte différent d'un
  compte propriétaire normal).
- "Commission Device" → scanner le QR code du SmartGuard/EMMA.
- **Mot de passe initial documenté pour un scan QR en tant qu'installateur : `00000a`** (confirmé,
  doc EMMA/SmartGuard) — si cette recommission passe directement, le reset physique de l'étape 2
  devient inutile.

## Étape 3 — Recommissionner l'ensemble

Une fois l'EMMA réinitialisé (ou recommissionné directement, voir alternative ci-dessus) :
1. App FusionSolar → compte Solar Installer → "Commission Device".
2. Se connecter au point d'accès WiFi que l'EMMA diffuse lui-même une fois réinitialisé.
3. Suivre l'assistant de mise en service pour rattacher SUN2000 + LUNA2000 + SmartGuard sous la
   nouvelle installation.

## Étape 4 — Activer le Modbus TCP sur l'EMMA (préalable à l'intégration HA)

**Confirmé** (discussion GitHub `wlcrs/huawei_solar` + doc EMMA-A02) :
- Le Modbus TCP (port 502) n'est pas actif par défaut — il faut l'activer explicitement via les
  réglages **installateur** de l'EMMA (accessible une fois recommissionné en tant qu'installateur,
  étape 3).
- **Slave ID à utiliser côté client Modbus (ex. `huawei_solar`) : `0`** pour une connexion via
  l'EMMA — pas `1`, qui est réservé à une connexion directe à l'onduleur sans EMMA (piège
  documenté, source d'échec de connexion classique).

## Étape 5 (hors de cette procédure, déjà traitée séparément) — Déclarer `huawei_solar` dans HA

Une fois le Modbus TCP actif sur l'EMMA : intégration `huawei_solar` déjà installable via HACS
(à faire, pas encore fait). Voir mémoire de session `project_electrical_measurement_inventory`
pour le contexte plus large (tableau de bord énergie HA : production solaire + consommation +
charge/décharge batterie superposées).

## Sources

- Manuel utilisateur EMMA-(A01, A02) — https://solar.huawei.com/download?p=%2F-%2Fmedia%2FSolarV4%2Fsolar-version2%2Fcommon%2Fprofessionals%2Fall-products%2Fproduct%2FEMMA%2Fsupport%2Fpdf%2FEMMA-User-Manual.pdf
- Tutoriel SUN2000+EMMA+HA — https://raspberry.tips/en/raspberrypi-tutorials/huawei-sun2000-home-assistant-emma-a02
- Discussion support EMMA-A01/A02 — https://github.com/wlcrs/huawei_solar/discussions/457
- Manuel utilisateur FusionSolar App (unbind/delete devices, comptes owner/installer) — https://support.huawei.com/enterprise/en/doc/EDOC1100165054/57977a9d/unbinding-or-deleting-devices
- FAQ "offline legacy devices after SmartGuard" (page expirée au 02/09/2026, non consultable) — https://support.huawei.com/enterprise/en/doc/EDOC1100096889/8bafef7b/how-can-i-delete-the-offline-legacy-devices-in-the-fusionsolar-smartpvms-after-i-use-a-new-smartguard
