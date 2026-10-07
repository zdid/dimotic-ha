# Spécifications Fonctionnelles - Application SCREEN2HTTP

*Version 1.0 - 7 Octobre 2026*
*v1.0 : première version — portage de l'outil autonome https://github.com/zdid/screen2http (Express + ws + ssh2 + xterm.js, une seule session, configuration `config.yaml` locale) dans le socle : paramétrage dans Paramètres Techniques, affichage dans une page de l'application, plusieurs sessions possibles.*

## 1. Objet

Afficher dans le navigateur une session `screen` tournant sur une machine distante, et la piloter au clavier (terminal complet : couleurs, redimensionnement, touches de contrôle). Utile pour suivre/relancer à distance un programme laissé dans un `screen` (par ex. une application lancée à la main sur une carte).

## 2. Découpage

| Où | Rôle |
|---|---|
| **Paramètres Techniques > Console screen** | Formulaire généré depuis `SCREEN2HTTP_UI_METADATA` : liste des sessions screen (cibles) et délais de connexion. Rien d'autre n'est configurable. |
| **Page « Console »** (`/applications/screen2http/presentation/index.html`) | Affichage seul : sélecteur de session, Se connecter / Déconnecter, état, terminal xterm.js. Aucun réglage. |
| **Service** (`Screen2HttpService`, process séparé) | Une connexion SSH (`ssh2`) par session ouverte depuis un navigateur ; flux du terminal relayé en Socket.io. |

Menu : catégorie *Paramètres Techniques*, entrée « Console screen » (formulaire) et sous-page « Console » (terminal). Application `audience: 'configuration'`, `type: 'standalone'`, `runsAsSeparateProcess: true`, ni MQTT ni HA. Nouvelle application → arrive **désactivée** (activation dans Gestion des applications, à chaud).

## 3. Configuration (`data/screen2http/config.yaml`, section `screen2http`)

| Champ | Défaut | Rôle |
|---|---|---|
| `targets[]` | `[]` | Une entrée par session screen à rejoindre |
| `targets[].id` | — | Identifiant libre, **unique** |
| `targets[].label` | = id | Nom affiché dans le sélecteur |
| `targets[].host` | — | Hôte SSH (obligatoire pour se connecter) |
| `targets[].port` | 22 | Port SSH |
| `targets[].username` | `root` | Utilisateur SSH |
| `targets[].screenName` | vide | `screen -xS <nom>` ; vide → `screen -x` |
| `targets[].privateKeyPath` | vide | Clé privée spécifique ; vide → clé unique de l'installation |
| `keepaliveInterval` | 10000 ms | Keepalive SSH |
| `readyTimeout` | 20000 ms | Délai de connexion SSH |
| `sessionTimeoutSeconds` | 60 s (min 15) | Fermeture d'une session sans signe de vie du navigateur |

Authentification : clé privée uniquement. Par défaut la clé unique de l'installation (`data/core/machine_ssh/id_ed25519`, générée au démarrage si absente — `ensureGlobalSshKey`, comme les autres applications pilotant des machines) : sa clé publique doit être installée sur chaque machine cible. Pas de mot de passe, pas de phrase de passe (écart avec l'outil autonome, qui acceptait une `passphrase`).

Rechargement : sur `app:module:config:saved` (`configProvider.reload()` avant relecture). Les sessions ouvertes gardent leur connexion ; la nouvelle config vaut pour les suivantes.

## 4. Fonctionnement d'une session

1. La page génère un `sessionId` (`[A-Za-z0-9_-]{1,64}`) et émet `screen2http:session:open { sessionId, targetId, cols, rows }`.
2. Le service ouvre la connexion SSH, puis exécute `screen -xS <nom>` **directement** (`exec` avec pseudo-terminal `xterm-256color` aux dimensions reçues) — écart avec l'outil autonome qui tapait la commande dans un shell : quand screen est détaché (Ctrl-A d) ou se termine, la session se ferme proprement au lieu de laisser un shell nu.
3. Le nom de session est filtré (`[^a-zA-Z0-9_.:-]` supprimés) : jamais d'injection de commande.
4. Sortie du terminal (stdout + stderr) → `screen2http:output { sessionId, data }`. Frappes → `screen2http:input`. Redimensionnement de la page → `screen2http:resize`.
5. Fin : `screen2http:session:close` (bouton Déconnecter, fermeture de l'onglet) ; ou fin constatée côté serveur (screen terminé, erreur SSH) → `screen2http:session:state` `closed`/`error` avec message.
6. Garde-fous : entrée limitée à 64 Ko par message, dimensions 1–1000, une seule notification de fin par session.

La page envoie `screen2http:ping` toutes les 15 s ; un contrôle toutes les 5 s ferme toute session muette depuis plus de `sessionTimeoutSeconds` (onglet fermé brutalement, navigateur planté) — aucune connexion SSH orpheline.

Quitter la page de la console (autre entrée du menu) **ne coupe pas** la session : le terminal et son contenu sont conservés et rattachés au nouveau DOM au retour (le contenu des applications est injecté dans un Shadow DOM remplacé à chaque visite). Fermer l'onglet la coupe.

## 5. Protocole Socket.io

| Événement | Sens | Charge | Persistant |
|---|---|---|---|
| `screen2http:status:get` | client → serveur | — | |
| `screen2http:status` | serveur → client | `{ targets: [{ id, label, host, screenName }] }` | oui |
| `screen2http:session:open` | client → serveur | `{ sessionId, targetId, cols, rows }` | |
| `screen2http:session:state` | serveur → client | `{ sessionId, state: connecting\|connected\|closed\|error, message? }` | non |
| `screen2http:output` | serveur → client | `{ sessionId, data }` | non |
| `screen2http:input` | client → serveur | `{ sessionId, data }` | |
| `screen2http:resize` | client → serveur | `{ sessionId, cols, rows }` | |
| `screen2http:ping` / `screen2http:session:close` | client → serveur | `{ sessionId }` | |
| `screen2http:error` | serveur → client | `{ message }` | non |

Les événements d'une application sont diffusés à tous les clients connectés : chaque navigateur ne traite que ceux portant son `sessionId`. L'application est réservée à l'administration (`audience: 'configuration'`) ; **tout utilisateur de l'interface qui atteint cette page obtient un terminal sur les machines configurées** — ne pas exposer l'interface hors du réseau de confiance (voir l'accès externe).

## 6. Fichiers

```
applications/screen2http/
├── package.json            # ssh2, zod, @xterm/xterm, @xterm/addon-fit
├── scripts/copy-vendor.cjs # build:ui — copie xterm.js/css et addon-fit dans dist/presentation/vendor/
└── src/
    ├── standalone.ts
    ├── domain/{index,Screen2HttpService,config-schema,socket-events}.ts
    └── presentation/{index.html,tsconfig.ui.json,ts/{app,global.d}.ts}
```

xterm.js est servi par l'application elle-même (pas de CDN : le réseau local n'a pas forcément Internet).

## 7. Vérifié

- `npm run build` et `npm run build:ui` sans erreur.
- Service éprouvé contre un faux serveur SSH (ssh2 `Server`) : ouverture, pty aux bonnes dimensions, commande `screen -xS <nom filtré>`, sortie relayée, saisie renvoyée, redimensionnement transmis, fermeture.
- **Non vérifié** : affichage de la page dans le navigateur avec le core complet, et connexion à un vrai `screen`.
