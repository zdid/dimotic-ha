# Conception — Assembleur de sources ESPHome et agent `esphome`

*Version 1.3 — 13 Octobre 2026 — **plusieurs sites, mêmes modules partout** : trois rôles (assembleur, poseur, usine), flux à deux messages (§4), amorce, wifi multiples et point d'accès de secours (§3.8–3.9), vérification et déclaration dans HA (§3.10), liaison entre sites (§8) ; **conception seule, rien n'est encore codé** (sauf la phase 1 de la bibliothèque d'éléments, voir `fonctionnelles-espdisplay_specs_v1.5.md` §10, et le port 8088 forcé du dev, §6). Décisions de l'utilisateur du 13/10/2026, prises en discussion.*

## 1. Objet

Fabriquer et déployer les firmwares des appareils ESP (ESP32, ESP8266 — **avec ou sans écran**) depuis dimotic-ha, sans outil séparé à lancer à la main : une application d'**assemblage de sources** (`espdisplay`, nom provisoire — il devient trompeur puisque tous les appareils n'ont pas d'écran), une application **agent** (`esphome`) sur la machine qui héberge ESPHome, et ESPHome lui-même, **indépendant** (gros consommateur de ressources, falbala ne tourne pas en continu). **Principe (décision du 13/10/2026) : tous les sites fonctionnent de la même manière et chaque module a les mêmes fonctions partout** ; seule la configuration change (site, rôles activés, broker, HA du site).

## 2. Acteurs et rôles

Trois rôles, **les mêmes sur chaque site** ; seule la machine qui les porte change.

| Rôle | Application | Où | Ce qu'il fait |
|---|---|---|---|
| **Assembleur** | `espdisplay` | chaque site, machine toujours allumée (ha2 chez toi, noisy2 chez noisy) | assemble les sources d'un appareil (base + éléments + paramètres) en un **paquet zip** ; génère les plans ; **publie la demande** ; ne compile rien |
| **Poseur** | `esphome`, option `poseur` | chaque site, machine toujours allumée (ha2, noisy2) | **récupère le firmware**, l'envoie à l'ESP **sur le réseau local du site**, **déclare l'appareil au HA du site**, vérifie, rend compte |
| **Usine** | `esphome`, option `usine` | **la machine qui héberge ESPHome** (falbala, instance réelle Docker, port 8087) ; elle sert plusieurs sites | **récupère les sources, compile**, crée les clés API, tient `secrets.yaml`, produit le firmware |

Autres acteurs : **HA, intégration Plans** (`zdid/dimotic-ha-plans`, garde les plans, les fournit par une commande d'export) ; **dimotic-ha, cœur** (liaison authentifiée avec HA, à étendre d'une méthode générique « interroger HA » pour les applications ; route REST de lecture seule pour servir des paquets) ; **ESPHome** (conteneur sur falbala, inchangé, indépendant) ; **MQTT à messages conservés** (broker toujours allumé **de chaque site**) ; **l'ESP**, qui une fois flashé parle directement à HA.

C'est **une seule application `esphome`** avec deux options (`usine`, `poseur`), activables séparément par machine. Chez toi : ha2 = poseur, falbala = usine ; chez noisy : noisy2 = poseur ; l'usine de falbala sert les deux sites.

## 3. Modèle de l'assembleur (décisions des 13/10/2026)

### 3.1 Vocabulaire

| Notion | Définition |
|---|---|
| **Matériel** (ou **modèle de matériel**) | une **carte avec ses périphériques câblés**, comme le Sunton 8048S070C (carte + écran + tactile + rétroéclairage). Une **fiche** dans la bibliothèque, **une seule fois** par modèle. |
| **Appareil** | **un exemplaire physique**, connu de HA distinctement : « écran salon », « écran chambre ». Deux Sunton identiques = **un modèle, deux appareils**. |
| **Élément** | un morceau de configuration paramétrable, avec ses exigences (§3.3). |
| **Élément généré** | un élément fabriqué à partir de données de HA : les **pages de plans**. |

### 3.2 Fiche d'un matériel

Dossier `bibliotheque/materiels/<modèle>/` : la **base YAML** ESPHome et une **fiche** (manifeste) lisible par l'assembleur :

```yaml
id: sunton-8048s070c
nom: Sunton ESP32-8048S070C
plateforme: esp32
carte: esp32-s3-devkitc-1
cadre: esp-idf
flash: 16MB
ecran: { largeur: 800, hauteur: 480, tactile: gt911, retroeclairage: gpio2 }
bus: { i2c: { sda: 19, scl: 20 } }                      # utilisé par le tactile
broches_prises: [1,3,4,5,6,7,8,9,14,15,16,21,39,40,41,42,45,46,47,48]   # écran
broches_libres: []                                       # sur les connecteurs : à relever plus tard
```

La fiche sert à : (1) **vérifier la compatibilité** (plateforme, écran, audio…) **avant** de générer ; (2) **détecter les conflits de broches** (deux éléments sur la même broche, ou une broche prise par l'écran) au lieu de laisser ESPHome échouer à la compilation ; (3) **déduire** la taille d'écran pour la mise à l'échelle des plans (§7), sans la ressaisir.

**Broches libres : renseignées plus tard** (décision utilisateur) — à relever sur le câblage réel quand le premier appareil sans écran (le thermostat) en aura besoin ; jusqu'alors la fiche ne déclare que ce que la carte utilise déjà.

### 3.3 Élément

Un **petit dossier** de la bibliothèque (`bibliotheque/elements/<élément>/`) avec :
- sa **fiche** : nom, **paramètres demandés** (type, valeur par défaut), **exigences** (plateformes compatibles ; écran et format ; audio ; nombre de broches libres) ;
- son **YAML ESPHome avec des variables** à remplacer (`${broche}`, `${entité}`, `${titre}`) — le principe des `packages:` d'ESPHome avec variables, déjà éprouvé sur la bibliothèque (phase 1).

Un appareil incompatible est signalé **avant** la génération (pas de page LVGL sur ESP8266, pas de page de plan sans écran). Les éléments existants (9 pages, polices, communs) deviennent des éléments à fiche ; les trois pages de climatisation et les thermostats se réduisent à un élément paramétrable (cf. `fonctionnelles-espdisplay_specs_v1.5.md` §10.4).

### 3.4 Appareil

Un appareil est défini par : un **nom unique** (hostname ESPHome et identité dans HA ; l'assembleur refuse deux appareils de même nom), son **matériel**, ses **éléments** et leurs **paramètres** (par exemple ses propres plans). Les appareils existants (haplan-display, poele-display, hasat4, hasat5) deviennent des appareils définis dans l'assembleur. Aucun secret n'est stocké dans la définition ni dans les paquets : le YAML référence `!secret …`, dont les valeurs restent dans le `secrets.yaml` de la machine ESPHome.

### 3.5 Clé API d'un nouvel appareil (décision du 13/10/2026)

**L'agent `esphome` crée la clé** : au premier envoi d'un appareil inconnu, il génère une clé aléatoire, l'écrit dans le `secrets.yaml` local d'ESPHome sous `api_<appareil>`, et la rend visible **une seule fois** dans l'état publié (message d'aide : « apparier `<appareil>` dans HA avec cette clé » — intégration ESPHome, et « Autoriser les appels de service » coché pour le tactile). Le secret ne quitte jamais la machine ESPHome ; l'assembleur ne le voit jamais.

### 3.6 Satellites vocaux

Ils **passent par l'assembleur** (décision utilisateur), quitte à **désassembler l'existant** : `hasat4.yaml` et `hasat5.yaml` (1 274 lignes chacun, ESP32-S3 16 Mo, esp-idf, **identiques sauf `device_name` et `friendly_name`** — c'est exactement « un modèle, deux appareils ») seront découpés en base matérielle + éléments (audio I2S et codec, boutons/expandeur, anneau de LED, assistant vocal, mot d'éveil, scripts, sélecteurs…), comme la phase 1 l'a fait pour haplan-display, avec contrôle par comparaison de `esphome config`. L'intérêt : pouvoir leur **ajouter un écran, des boutons**, etc., en ajoutant des éléments.

### 3.7 Existant relevé

| Appareil | Carte | Cadre | Particularités |
|---|---|---|---|
| haplan-display | ESP32-S3 (devkitc-1), flash 16 Mo | esp-idf | écran 800×480 tactile, LVGL, 2 emplacements OTA de 6 Mo, images de fond embarquées |
| poele-display | ESP32 (esp32dev) | arduino | CYD 2,8" portrait, thermostat du poêle, LVGL |
| hasat4, hasat5 | ESP32-S3 (devkitc-1), flash 16 Mo | esp-idf | satellites vocaux (Waveshare ESP32-S3-Audio) : micro, haut-parleur, I2S, LED, assistant vocal, sans écran |

Bibliothèque : `applications/espdisplay/bibliotheque/` (phase 1 faite : base Sunton + 1 commun + 9 pages ; à reclasser en `materiels/` + `elements/`).

### 3.8 Wifi : plusieurs réseaux et point d'accès de secours (décision du 13/10/2026)

Les ESP sont assemblés à un endroit et peuvent être installés ailleurs. Le YAML déclare **une liste de réseaux avec priorité** (`wifi: networks:` — l'ESP se connecte au meilleur réseau connu qu'il voit) **et** un **point d'accès de secours avec portail captif** (`wifi: ap:` + `captive_portal:`, comme le WiFiManager de Tasmota : si aucun réseau connu n'est joignable, l'ESP ouvre son wifi et on saisit celui du nouvel endroit depuis un téléphone).

- Un **appareil connaît ses sites** (site de destination, éventuellement site d'assemblage) ; l'assembleur écrit la liste dans cet ordre (destination d'abord).
- Les identifiants wifi sont **par site** dans le `secrets.yaml` de la machine ESPHome : `wifi_<site>_ssid`, `wifi_<site>_password`. **Ils ne quittent pas cette machine.**
- Le portail captif est **toujours présent**, dans l'amorce comme dans le vrai firmware.
- Attention : un appareil qui part ailleurs **contient les mots de passe des réseaux déclarés** ; choisir quels sites y figurent. À l'autre site, il doit être **adopté par le HA de là-bas** (même clé API).

### 3.9 Amorce : le premier flash (décision du 13/10/2026)

Une carte neuve n'a aucun firmware, donc le **tout premier flash se fait par USB**. Pour qu'il soit rapide et sans risque, on flashe une **amorce** minimale : nom de l'appareil, clé API, wifi (§3.8), mise à jour par le réseau, portail captif. Ensuite **tout passe par le réseau**, comme n'importe quelle mise à jour (le nom et la clé ne changent pas : HA ne voit rien).

- **L'usine compile l'amorce de l'appareil** (elle seule a les secrets) ; elle peut être flashée depuis falbala (carte branchée dessus) ou avec un flasheur web.
- **L'amorce a le même découpage de la mémoire flash que le firmware final** : la mise à jour par le réseau ne sait pas redécouper (haplan-display : 16 Mo, 2 emplacements de 6 Mo). L'amorce est donc fabriquée **par modèle de matériel**, d'après sa fiche (flash, partitions). ESP8266 à 1 Mo : amorce minimale.

### 3.10 Vérifier et déclarer un appareil dans HA

- **Vérification d'existence** (WebSocket) : `config_entries/get` (domaine `esphome` : entrées et état `loaded`, `setup_error`…) et `config/device_registry/list` (nom d'affichage, **adresse MAC**, **version du firmware**). Le nom dans HA est le **nom d'affichage** (`friendly_name`, ex. « Plan HAPLAN »), pas le nom réseau (`haplan-display`) : l'assembleur exige un **nom d'affichage unique** par appareil et mémorise la **MAC** une fois l'appareil vu. La version du firmware contient la **date de compilation** (ex. « 2025.11.2 (Oct 6 2026, 20:12:36) ») : après un envoi, un changement de date **confirme que le nouveau firmware tourne**.
- **Déclaration d'un nouvel appareil** : API REST de HA (`/api/config/config_entries/flow`, jeton administrateur), flux `esphome` : étape `user` (adresse `host`, port 6053 par défaut), puis la **clé** pour un appareil chiffré, puis une étape d'options pour « Autoriser les appels de service » (appareils tactiles). Fait par le **poseur du site**, avec la liaison HA de son instance.
- **Constat du 13/10/2026** dans le HA de ha2 : 3 entrées ESPHome (Plan HAPLAN, Thermostat Poêle, une entrée « hasat3 » qui contient en fait le satellite hasat5) ; **hasat4 n'existe pas dans HA**.

## 4. Flux de bout en bout (décisions de l'utilisateur du 13/10/2026)

Rien n'est déclenché automatiquement par une modification des plans : **aucun événement « plans modifiés »**. Tout part d'une demande volontaire. Le **site** figure dans chaque sujet MQTT et chaque message reste **sur le broker de son site** (sites étanches).

1. **Bouton « Générer » dans HA** (panneau Plans), pour un écran : il publie une **demande** par MQTT à l'assembleur de son site.
2. **L'assembleur génère les plans**, à la demande, pour les appareils qui ont le composant **« pages de plans »** : il lit HA (via le cœur), applique les conversions de coordonnées (§7) et **garde le résultat** (éléments générés : YAML + images). Distinct de l'assemblage : elle seule a besoin de HA.
3. **L'assembleur assemble**, à la demande, pour un **matériel donné** : il produit le **paquet zip** (manifeste + sommes de contrôle + révision ; 5 dernières révisions gardées) et **publie un message conservé** `dimotic/esphome/<site>/jobs/<appareil>` = `{ révision, action (amorce | firmware), origine (assembleur qui a le paquet), adresse du paquet, somme de contrôle }`. Il dit **quoi faire et où le trouver**, il ne transporte pas les fichiers.
4. **L'usine** (connectée aux brokers des sites qu'elle sert) reçoit la demande, **va chercher le paquet** à l'adresse indiquée (« je demande, j'obtiens », route REST de lecture seule du cœur), vérifie la somme de contrôle, dépose les sources dans le dossier d'ESPHome et **compile**. Pour un nouvel appareil, elle **crée la clé API** (§3.5). Elle **supprime la demande** (message vide conservé) **une fois le paquet récupéré avec succès et confié à ESPHome** — pas à la réception, pour qu'une panne laisse la demande en attente — puis publie un **second message conservé** `dimotic/esphome/<site>/pose/<appareil>` = « firmware prêt : où le prendre, somme de contrôle, adresse de l'ESP, clé ».
5. **Le poseur du site** reçoit ce message, **va chercher le firmware** chez l'usine (par le VPN pour un autre site), l'**envoie à l'ESP** sur le réseau local, **déclare l'appareil au HA du site** (§3.10), vérifie (date de compilation du firmware dans HA), supprime le message de pose et publie l'**état conservé** `dimotic/esphome/<site>/status/<appareil>` (récupération, compilation, envoi, terminé / échec + fin du journal) que l'assembleur et HA affichent.

Même mécanisme aux deux étapes : **un message conservé qui dit quoi prendre et où**, que le destinataire supprime après prise en charge ; une machine éteinte (falbala qui dort, poseur arrêté) **n'empêche rien** : le message attend. Le zip reste **téléchargeable à la main** depuis l'interface (déposer sur un autre ESPHome sans usine). Pour un appareil neuf : l'étape 4 compile l'**amorce** (§3.9), flashée une fois par USB, puis le firmware complet suit par le réseau.

**Livraison par « je demande, j'obtiens »** (décision utilisateur) : la **diffusion entre instances n'est pas utilisée** — c'est un dispositif de sécurité et de reprise, pas un mécanisme de livraison. Côté cœur : une **route REST en lecture seule**, généralisée, qui permet à une application de servir un dossier réservé (même esprit que la route générique d'envoi de fichiers déjà présente).

## 4bis. Deux temps

- **Premier temps :** les étapes 2 et 3 sont déclenchées **à la main depuis l'interface d'espdisplay** (un bouton « Générer les plans », un bouton « Assembler / envoyer »). Le bouton « Générer » de HA (étape 1) arrive avec ce temps ou juste après ; il publie la demande, espdisplay la traite.
- **Second temps :** **automatiser l'enchaînement** à partir du message venu de HA — un seul clic sur « Générer » dans HA lance la génération des plans, puis l'assemblage, puis l'envoi. On n'y ajoute **que de l'automatisme** des étapes déjà existantes, pas de nouveau mécanisme. Un déclenchement automatique sur modification des plans (« plans modifiés ») n'est **pas prévu** ; on verra plus tard si l'automatisme de « Générer » suffit.

## 5. Garde-fou « un seul agent actif » (décision du 13/10/2026)

Chaque **usine** publie sa **présence** sur un message conservé (avec testament MQTT) `dimotic/esphome/agent/<machine ESPHome>` (instance, port, heure) ; de même chaque **poseur** par site (`dimotic/esphome/<site>/poseur`). Au démarrage, une usine qui trouve **une autre usine en ligne pour la même machine ESPHome** (ou un poseur qui trouve un autre poseur du même site) ne traite **aucune demande** et l'indique clairement (« un autre agent est déjà actif : instance X, port Y »). Ce n'est pas de la sécurité : c'est une protection contre l'oubli. **Réutilisable par d'autres applications — à étudier plus tard** ; pour l'instant, uniquement sur `esphome`.

**Pas de canal dev/prod dans les sujets, pas de signature** (décision utilisateur : « je n'ai pas 36 écrans »). Seule la somme de contrôle du zip subsiste (intégrité, pas sécurité). Les demandes en attente sont communes : celui qui active l'agent prend les demandes conservées (vider les demandes d'essai avant de réactiver l'agent réel).

## 6. Instance réelle et instance de dev sur falbala

- Falbala héberge **deux instances de dimotic-ha** : l'instance **réelle** (Docker, `/docker/dimotic-ha`, port **8087**, identité propre créée à l'installation) qui porte l'agent `esphome`, et l'instance de **dev** (depuis le dépôt) avec l'identité `falbala_817412`, en « Recevoir sans Diffuser ».
- **Le dev écoute sur 8088, forcé au lancement** : les scripts `dev` et `dev:local` du cœur positionnent `DIMOTIC_WEB_PORT=8088`, et cette variable est **prioritaire sur `web.port`** de la configuration (aucun fichier ni écran ne peut le changer). L'instance réelle n'a pas la variable (8087).
- **Les essais vont jusqu'à l'écran.** Pour tester, on **désactive** l'agent `esphome` réel (8087) et on **active** celui du dev (8088) ; puis on inverse. Un seul agent actif à la fois (le garde-fou §5 l'impose).

## 7. Conversion des coordonnées des plans

Elle se fait **dans l'élément généré « pages de plans », à l'assemblage, dans espdisplay** — ni dans HA (qui ne connaît pas l'écran), ni sur l'ESP (qui reçoit des pixels). Elle comprend **deux** étapes, dans cet ordre :

1. **Ancrage** : HA donne le **coin inférieur gauche** de l'icône (fraction de l'image, 0–1) ; le générateur historique attend un **centre**. On décale d'une demi-icône (vers la droite et vers le haut), la taille de l'icône étant celle de l'icône **sur l'écran** (déclarée par l'élément), pas celle du panneau (28 px).
2. **Mise à l'échelle** (déjà dans le script historique) : image ramenée à la taille de l'écran en gardant ses proportions, centrée (bandes noires), puis `px = décalage_x + x × largeur_image × échelle`, `py = décalage_y + y × hauteur_image × échelle`, puis **borné** pour que l'icône reste entièrement dans l'écran.

Testée à part (quelques cas à la main, par exemple « un objet au coin inférieur gauche du plan tombe au pixel attendu »).

## 8. Liaison entre sites (décisions du 13/10/2026)

- **Sites étanches** : chaque site garde son broker, son HA, ses messages. Seul **WireGuard** relie des **machines** (falbala 10.10.10.2, noisy2 10.10.10.3), pas des réseaux entiers.
- **Les deux sites utilisent 192.168.1.0/24** : falbala ne peut pas adresser directement un ESP de noisy (la même adresse existe chez toi). **Le routage de réseaux entiers est donc écarté** (il imposerait de renuméroter noisy — mot de passe de la Bbox inconnu — ou une traduction d'adresses fragile). D'où le **poseur local** sur chaque site (§2) : le VPN ne sert qu'**entre machines**.
- **L'usine se connecte aux brokers des sites qu'elle sert** (celui de noisy par le VPN, `10.10.10.3`), au lieu de relier les brokers par un pont : elle ne traite que les sites de sa liste, lit les demandes du site, publie ses messages de pose et ses états **sur le broker du site concerné** ; l'interface de chaque site ne voit que ses propres demandes.
- **Récupération des fichiers par le VPN**, dans les deux sens : l'usine va chercher les sources chez l'assembleur du site, le poseur va chercher le firmware chez l'usine.
- **Adresses des ESP** : la découverte par nom (`.local`) ne traverse pas un VPN et n'est utile que sur le réseau local du poseur ; l'adresse de l'ESP est déclarée dans le message de pose (adresse fixe ou réservation DHCP).
- **La déclaration dans HA** est faite par le **poseur du site**, avec la liaison HA de son instance (aucun jeton d'un HA sur une machine d'un autre site). **La clé API** arrive au poseur dans le message de pose (visible une seule fois), via le VPN.
- **Envoi à l'ESP** : le poseur n'a **pas besoin d'ESPHome** : le **protocole de mise à jour d'ESPHome** est implémenté dans l'application (TypeScript, sans Python ni gros paquet sur noisy2 / ha2). À vérifier à l'implémentation.

## 9. Étapes prévues

1. Fixer le port du dev (8088 forcé, §6 — **fait**, socle v4.44) ; installer l'instance réelle de falbala.
2. Application `esphome` : **usine** (demandes conservées, récupération du zip, compilation, clés API, amorce, message de pose) et **poseur** (récupération du firmware, envoi à l'ESP, déclaration dans HA, vérification), garde-fous, états et présence ; **site dans les sujets** ; connexion de l'usine aux brokers des sites servis.
3. Assembleur : modèle matériel / appareil / élément (§3), paquets zip, route REST de lecture. **Désassembler les satellites hasat4/hasat5** (découpage fidèle + comparaison, comme la phase 1) et reclasser la bibliothèque en `materiels/` + `elements/` ; premier cas réel sans écran : le thermostat.
4. Éléments générés : pages de plans lues dans HA (commande d'export dans l'intégration Plans, méthode générique du cœur, conversion §7), bouton « Générer » du panneau Plans (demande MQTT), essai de bout en bout sur un écran ; **puis** (second temps §4bis) enchaînement automatique génération → assemblage → envoi à partir de la demande de HA.
5. Second site (noisy) : poseur sur noisy2, usine de falbala connectée au broker de noisy par le VPN, essai de bout en bout.
6. Retrait de `data/haplan/` comme source des plans pour les écrans.

## 10. Points ouverts

- Génération des éléments générés en **TypeScript** dans espdisplay (recommandé : ha2 n'a ni Python ni ESPHome) **ou** script Python appelé par l'assembleur — à trancher.
- Vérifier que l'instance réelle de falbala peut se connecter au broker MQTT de ha2, et que le broker de noisy est joignable par le VPN (écoute sur l'interface VPN).
- Nom définitif de l'application d'assemblage (aujourd'hui `espdisplay`).
- Réveil de falbala par le réseau (facultatif : la demande conservée attend).
- Format exact des fiches (matériel, élément) et du manifeste du paquet zip.
- Faisabilité du protocole de mise à jour d'ESPHome en TypeScript (poseur) ; adresses fixes ou réservations pour les ESP de noisy.
- Premier flash : depuis falbala (carte branchée) ou flasheur web ; choix des sites dont les wifi figurent dans un appareil donné.
