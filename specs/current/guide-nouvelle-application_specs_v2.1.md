# Guide Rapide — Création d'une Nouvelle Application

**Version :** 2.1
**Date :** 24 Septembre 2026 (v2.1 : §9 mis à jour — cycle de vie à chaud, application nouvelle désactivée, racine externe `data/applications/`, `testcycle` ; voir `fonctionnelles-supervisor_specs_v2.10.md` §8)
**Version précédente :** 2.0 — 19 Septembre 2026
**Statut :** Réécriture complète — v1.11 était marquée obsolète depuis le 08/09/2026 (décrivait une
architecture abandonnée avant d'être terminée) et n'a jamais été corrigée. Ce document repart des
applications réelles du dépôt (arexx, teleinfo, rpigpio, sauvegarde, outils) plutôt que d'un patron
théorique — chaque affirmation ci-dessous est vérifiable dans une app existante.
**Public cible :** Développeurs créant une nouvelle application sans modifier le socle

> **Ce qui a disparu par rapport à v1.11 (jamais implémenté, confirmé par grep sur tout le dépôt le
> 19/09/2026 : zéro résultat)** : `domain/capabilities.ts`, `ApplicationCapabilities`,
> `InterAppClient`, le pattern Request/Reply décrit en §11 de v1.11 (déclaration de capacités,
> `handledRequests`, format `AppRequest`/`AppReply`). Un vrai mécanisme de corrélation Request/Reply
> existe bien, mais différent et plus simple : **`CorrelatedRequester`** — voir §3.2bis, corrigé le
> 19/09/2026 après une première version de ce document qui affirmait à tort qu'aucun n'existait.
> Également retiré : l'import direct de `SocketService` côté client (§3.9 de v1.11, jamais le cas en
> pratique — voir §3.6 ci-dessous, `window.app.socketService`).

---

## 📌 Table des Matières

1. [Prérequis](#1-prérequis)
2. [Structure Réelle d'une Application](#2-structure-réelle-dune-application)
3. [Étapes de Création](#3-étapes-de-création)
4. [Process séparé vs in-process](#4-process-séparé-vs-in-process)
5. [Accès à Home Assistant](#5-accès-à-home-assistant)
6. [Déploiement vers du matériel distant](#6-déploiement-vers-du-matériel-distant)
7. [Convention systemd/cron auto-descriptive](#7-convention-systemdcron-auto-descriptive)
8. [Routes HTTP génériques (upload/download)](#8-routes-http-génériques-uploaddownload)
9. [Détection automatique + cycle de vie](#9-détection-automatique--cycle-de-vie)
10. [Checklist avant déploiement](#10-checklist-avant-déploiement)

---

## 1. Prérequis

- Node.js 20+, TypeScript 5.x (mode strict)
- pnpm (workspace du dépôt) — chaque application a néanmoins son propre `package.json`/
  `node_modules` (voir `docker/build-apps.sh`, qui fait un `npm install` par app pour le build Docker,
  indépendant du workspace pnpm de dev)
- Lire `techniques-socle-ha-mqtt_specs` (dernière version) pour l'architecture générale (EventBus,
  cycle de vie, arborescence `applications/`)
- Convention de nommage : `nommage_specs_v1.0.md`

---

## 2. Structure Réelle d'une Application

Exemple vérifié (`applications/outils/`, livré 18/09/2026) :

```
applications/{nom-app}/
├── package.json              # dépendances propres à cette app (express/zod/js-yaml...)
├── tsconfig.json
├── src/
│   ├── standalone.ts         # SEULEMENT si runsAsSeparateProcess: true — voir §4
│   ├── domain/
│   │   ├── index.ts          # OBLIGATOIRE — module + factories, voir §3.1
│   │   ├── {NomApp}Service.ts
│   │   ├── socket-events.ts
│   │   ├── config-schema.ts  # Zod, voir §3.4
│   │   └── types.ts
│   └── presentation/
│       ├── index.html
│       ├── tsconfig.ui.json  # SEULEMENT si l'app a sa propre UI TypeScript compilée à part
│       └── ts/
│           ├── app.ts
│           └── global.d.ts   # déclare `window.app`/`window.outilsApp` etc.
```

**Fichiers obligatoires** : `domain/index.ts` (exporte `{NOM_APP}_APP` + factory), `{NomApp}Service.ts`
(`start()` obligatoire, `stop()` recommandé), `presentation/index.html`.

---

## 3. Étapes de Création

### 3.1 `domain/index.ts` — déclaration réelle du module

Type `ApplicationModule` (voir `applications/core/src/types/config.ts` — c'est la seule source de
vérité, pas ce document) :

```typescript
export interface ApplicationModule {
  id: string;
  name: string;
  description: string;
  icon: string;
  type: 'core' | 'integration' | 'standalone';
  audience?: 'inspection' | 'configuration' | 'end-user'; // voir commentaire du type
  configurable: boolean;
  socketEvents?: Record<string, string>;
  requiredMqtt?: boolean;
  requiredHaWs?: boolean;
  configUi?: ModuleUiMetadata;
  configSection?: string;         // défaut = id
  runsAsSeparateProcess?: boolean; // voir §4
  bridgedEvents?: string[];        // voir §4
}
```

Exemple réel complet (`applications/outils/src/domain/index.ts`, simplifié) :

```typescript
import { OUTILS_SOCKET_EVENTS, OUTILS_ALL_EVENTS, OUTILS_PERSISTENT_EVENTS } from './socket-events';
import { OutilsService, type IOutilsService } from './OutilsService';
import type { OutilsConfig } from './config-schema';

export const OUTILS_UI_METADATA: ModuleUiMetadata = {
  title: 'Outils', description: '...', icon: '🧰', category: 'Outils',
  menuLabel: 'Outils', menuIcon: '🧰', menuOrder: 40, menuPath: '/outils',
  fields: [] // vide = pas de formulaire générique, UI 100% custom sur sa propre page
};

export const OUTILS_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Applications', section: 'Outils',
  entry: { label: 'Outils', icon: '🧰', path: '/outils', order: 40 },
  pages: [{ id: 'dashboard', label: 'Bibliothèque de scripts', icon: '🧰',
            path: '/applications/outils/presentation/index.html', order: 1 }]
};

export const OUTILS_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'outils', name: 'Outils', description: '...', icon: '🧰',
  menu: OUTILS_MENU_CONFIG,
  type: 'standalone', audience: 'configuration', configurable: true,
  requiredMqtt: false, requiredHaWs: false,
  configSection: 'outils', configUi: OUTILS_UI_METADATA, socketEvents: OUTILS_SOCKET_EVENTS,
  runsAsSeparateProcess: true,
  bridgedEvents: ['outils:internal:upload'] // voir §8
};

export function createOutilsService(eventBus: IEventBus, logger: Logger,
                                     configProvider: IAppConfigProvider<OutilsConfig>): IOutilsService {
  const service = OutilsService.create(eventBus, logger, configProvider);
  eventBus.emit('app:socket-events:registered', { appId: 'outils', socketEvents: OUTILS_ALL_EVENTS, persistentEvents: OUTILS_PERSISTENT_EVENTS });
  eventBus.emit('app:menu:register', { appId: 'outils', menuConfig: OUTILS_MENU_CONFIG });
  return service;
}

// Factory alternative, construit son propre IAppConfigProvider — utilisée par standalone.ts (§4)
export function createOutilsServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService): IOutilsService {
  return createOutilsService(eventBus, logger, new AppConfigProvider<OutilsConfig>('outils', configService));
}

export * from './OutilsService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
```

**Import du core** : `import { ... } from '../../../core/dist/exports'` (le `dist/` compilé, pas
`src/` — chaque app importe le core déjà buildé, jamais ses sources TS directement, contrairement à
ce que suggérait v1.11 §3.9).

### 3.2 `{NomApp}Service.ts` — service métier

Constructeur `(eventBus, logger, configProvider)`, méthode `start()` async obligatoire. Recharge de
config sur `app:module:config:saved` (⚠️ point réel corrigé plusieurs fois en conditions réelles —
appeler `configProvider.reload()` **avant** de relire `getAppConfig()`, sinon l'ancienne valeur en
cache est relue) :

```typescript
export class {NomApp}Service {
  private config: {NomApp}Config;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<{NomApp}Config>
  ) {
    this.config = this.loadConfig();
  }

  private loadConfig(): {NomApp}Config {
    return {nomApp}ConfigSchema.parse(this.configProvider.getAppConfig());
  }

  async start(): Promise<void> {
    this.setupSocketEventListeners();
    this.emitStatus();
  }

  async stop(): Promise<void> { /* libérer les ressources si besoin */ }

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('{nom-app}:status:get', () => this.emitStatus());
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== '{nom-app}' || !event.success) return;
      this.configProvider.reload(); // ⚠️ AVANT de relire — bug réel si oublié
      this.config = this.loadConfig();
      this.emitStatus();
    });
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('{nom-app}:status', { /* ... */ });
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<{NomApp}Config>): {NomApp}Service {
    return new {NomApp}Service(eventBus, logger, configProvider);
  }
}
```

`eventBus.emitGeneric()`/`onGeneric()` (pas `emit()`/`on()` typés) est le pattern générique utilisé
partout pour les événements propres à l'app, en Fire & Forget (aucune réponse attendue).

### 3.2bis Communication inter-app avec réponse attendue

Le **mécanisme** lui-même (ce que fait `IEventBus`/`IpcEventBus`/`CorrelatedRequester` en interne)
est décrit dans `techniques-socle-ha-mqtt_specs` §9bis — c'est le core qui le possède, pas ce guide.
Ici : **ce qu'il faut écrire concrètement dans chacun des deux process** quand votre app doit
demander quelque chose à une autre (ou répondre à une autre qui lui demande).

Deux process séparés (chacun son `standalone.ts`, §4), qui ne se voient jamais directement — tout
passe par le core, qui relaie via `IpcEventBus` (si l'un des deux, ou les deux, tournent en process
séparé — même code si les deux sont in-process). Exemple réel : `planificateur` (déclenche une
réinterprétation) → `ia` (répond) — fichiers `applications/planificateur/src/domain/execution.ts` et
`applications/ia/src/domain/DeployResponder.ts`.

**Process A — celui qui demande** (ex: `planificateur`) : construit un `CorrelatedRequester` pointant
sur le couple d'événements requête/réponse, appelle `.request()`, attend la Promise :

```typescript
// applications/planificateur/src/domain/execution.ts (extrait réel, simplifié)
import { CorrelatedRequester, type IEventBus } from '../../../core/dist/exports';
import type { DeployRequest, DeployReply } from '../../ia/src/domain/types'; // types partagés par convention, pas d'import de code

export class ExecutionEngine {
  private readonly deployRequester: CorrelatedRequester<DeployRequest, DeployReply>;

  constructor(private readonly eventBus: IEventBus) {
    this.deployRequester = new CorrelatedRequester<DeployRequest, DeployReply>(
      eventBus,
      'planificateur:deploy',       // événement de requête
      'planificateur:deploy:reply'  // événement de réponse
    );
  }

  private async askIaToReinterpret(req: DeployRequest): Promise<DeployReply> {
    // Lève une erreur si aucune réponse avec le bon correlation_id n'arrive dans le délai.
    return this.deployRequester.request(req, 15000 /* ms */);
  }
}
```

**Process B — celui qui répond** (ex: `ia`) : écoute l'événement de requête avec `onGeneric`, traite,
répond sur l'événement de réponse en renvoyant EXACTEMENT le même `correlation_id` reçu (c'est lui,
pas le nom de l'événement, qui permet à `CorrelatedRequester` de savoir quelle Promise résoudre) :

```typescript
// applications/ia/src/domain/DeployResponder.ts (extrait réel, simplifié)
export class DeployResponder {
  constructor(private readonly eventBus: IEventBus, /* ... */) {}

  wire(): void {
    this.eventBus.onGeneric<DeployRequest>('planificateur:deploy', (req) => {
      this.handle(req).catch((error) => this.logger.error('DeployResponder', String(error)));
    });
  }

  private async handle(req: DeployRequest): Promise<void> {
    // req.correlation_id : présent dans le type DeployRequest lui-même (convention du dépôt —
    // inclure correlation_id directement dans le type de requête, ajouté par
    // CorrelatedRequester.request() côté demandeur, voir plus haut).
    const result = await this.reinterpret(req); // logique métier propre à l'app
    const reply: DeployReply = { correlation_id: req.correlation_id, success: true, /* ... */ };
    this.eventBus.emitGeneric('planificateur:deploy:reply', reply);
  }
}
```

**Ce qu'il faut retenir en écrivant les deux côtés** :
- Le nom d'événement de requête et celui de réponse sont **deux constantes partagées** (par
  convention `<action>`/`<action>:reply`) — les deux apps doivent utiliser EXACTEMENT les mêmes
  chaînes, sinon rien ne se connecte (aucune erreur explicite, juste un timeout côté demandeur).
- `correlation_id` est ajouté automatiquement au payload par `CorrelatedRequester.request()` côté
  demandeur — le répondeur n'a rien à générer, juste à le relire dans la requête reçue et le
  renvoyer tel quel dans sa réponse.
- Le répondeur (`wire()` ci-dessus) doit être appelé au démarrage du service (dans `start()`,
  §3.2) — sinon la requête part mais personne n'écoute, timeout côté demandeur.
- Types de requête/réponse : pas de mécanisme de déclaration centralisé (contrairement à l'ancien
  `capabilities.ts`, jamais implémenté) — un simple fichier `types.ts` exporté par l'app répondeuse,
  importé par l'app demandeuse, suffit (voir l'exemple `DeployRequest`/`DeployReply` ci-dessus).

### 3.3 `socket-events.ts`

```typescript
export const {NOM_APP}_SOCKET_EVENTS = {
  STATUS: '{nom-app}:status',
  ERROR: '{nom-app}:error',
} as const;

export const {NOM_APP}_CLIENT_EVENTS = {
  GET_STATUS: '{nom-app}:status:get',
} as const;

export const {NOM_APP}_ALL_EVENTS = { ...{NOM_APP}_SOCKET_EVENTS, ...{NOM_APP}_CLIENT_EVENTS } as const;

// Rejoués automatiquement à la connexion d'un client
export const {NOM_APP}_PERSISTENT_EVENTS: string[] = [{NOM_APP}_SOCKET_EVENTS.STATUS];
```

### 3.4 `config-schema.ts` (Zod)

```typescript
import { z } from 'zod';

export const {nomApp}ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollInterval: z.number().min(1000).max(300000).default(60000),
}).refine(/* invariants inter-champs si besoin, ex: unicité d'id dans un tableau */);

export type {NomApp}Config = z.infer<typeof {nomApp}ConfigSchema>;
```

### 3.5 Menu et page dédiée

Si l'application a sa propre page (au lieu du seul formulaire générique Paramètres Techniques),
déclarer `menu`/`ApplicationMenuConfig` comme dans l'exemple §3.1 et émettre
`app:menu:register` dans la factory. `configUi.fields: []` (vide) = pas de formulaire générique,
toute l'UI vit sur la page dédiée.

### 3.6 Client Socket.io — `presentation/ts/app.ts`

**Pas d'import de `SocketService`.** Le socket est déjà connecté par la page hôte, exposé globalement :

```typescript
declare global {
  interface Window {
    app: { socketService: { getSocket(): any } };
  }
}

let socket: any = null;

function init(): void {
  socket = window.app.socketService.getSocket();
  socket.on('{nom-app}:status', (status) => { /* ... */ });
  socket.emit('{nom-app}:status:get');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

Chemins statiques : `/applications/{nom-app}/presentation/...` — le segment `presentation/` fait
partie de l'URL servie, jamais omis.

---

## 4. Process séparé vs in-process

Deux mécanismes distincts avec le même mot `standalone` — ne pas confondre :
- `type: 'standalone'` (dans `ApplicationModule`) = "a sa propre page", sans rapport avec le process.
- `runsAsSeparateProcess: true` = tourne comme un vrai process OS séparé (`ProcessSupervisor`,
  spawn/kill), communication avec le core via `IpcEventBus` (`process.send`/`process.on('message')`)
  plutôt qu'in-process. La grande majorité des apps récentes (arexx, teleinfo, rpigpio, sauvegarde,
  outils) l'utilisent.

Si `runsAsSeparateProcess: true`, ajouter `src/standalone.ts` (patron identique dans toutes les apps
qui l'utilisent, copier `applications/outils/src/standalone.ts` ou `applications/arexx/src/
standalone.ts`) :

```typescript
import { ConfigLoader, ConfigWriter, ConfigService, createLogger, IpcEventBus } from '../../core/dist/exports';
import { create{NomApp}ServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({ level: (process.env.LOG_LEVEL as any) ?? 'info', maxSizeMb: 10, maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs') });

  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configService = new ConfigService(
    new ConfigLoader(configPath, undefined, dataRoot),
    new ConfigWriter(configPath, undefined, '.tmp', dataRoot),
    logger
  );

  const eventBus = new IpcEventBus();
  const service = create{NomApp}ServiceWithConfig(eventBus, logger, configService);
  await service.start();

  process.on('SIGTERM', () => { void service.stop().finally(() => process.exit(0)); });
  process.on('SIGINT', () => { void service.stop().finally(() => process.exit(0)); });
}

main().catch((error) => { console.error(error); process.exit(1); });
```

`bridgedEvents` sur `ApplicationModule` liste les événements génériques additionnels à ponter
core↔process séparé (au-delà de `app:menu:register`, toujours ponté) — ex: `'outils:internal:upload'`
pour la route d'upload générique (§8).

---

## 5. Accès à Home Assistant

Pour une app **en process séparé** ayant besoin du référentiel HA : `HaBridgeClient`
(`applications/core/src/application/HaBridgeClient.ts`) — remplace l'accès direct à
`HaStructureRegistry`/`HaWsClient`, qui ne sont pas traversables par IPC. Voir son fichier source
pour l'API exacte (non détaillée ici pour ne pas dupliquer une source qui peut évoluer).

---

## 6. Déploiement vers du matériel distant

Pattern réel (arexx, teleinfo, rpigpio, sauvegarde) : un `DeployService.ts` par app, utilisant le
socle partagé `core/infrastructure/remote/` (`runSsh`, `runSshStreaming`, `runScp`, `shellQuote`,
`ensureGlobalSshKey`, `SystemdUnitController` ou `DockerContainerController`) :

```typescript
import { runSsh, shellQuote, ensureGlobalSshKey, DockerContainerController, type Logger, type RemoteOpResult } from '../../../core/dist/exports';

function resolveTarget(target: MyTargetConfig) {
  return { ...target, sshKeyPath: ensureGlobalSshKey() }; // clé SSH unique de l'installation, générée si absente
}

const unitController = new DockerContainerController(); // ou SystemdUnitController pour un agent non-Docker

export class DeployService {
  start(target) { return unitController.start(resolveTarget(target), target.containerName); }
  stop(target)  { return unitController.stop(resolveTarget(target), target.containerName); }
  restart(target) { return unitController.restart(resolveTarget(target), target.containerName); }
}
```

Connexion **root direct**, jamais `sudo` (voir le commentaire d'en-tête de `SshClient.ts` pour le
raisonnement). Config de la cible : tableau `targets[]` dans le schéma Zod de l'app, une entrée
`{id, site, machine, host, ...}` par machine couverte.

**Convention d'emplacement sur la cible** (vérifiée en conditions réelles, ha2/stfort/noisy) :
- `/docker/<app>/` pour tout ce qui est Docker (compose.yaml + volumes).
- `/dimotic-ha-addons/<app>/` pour un agent non-Docker (ex: teleinfo sur RPi1 — Node officiel n'a
  plus de build ARMv6, pas de Docker viable).

**Visibilité inter-machines** : `TargetGossipService`/`AppGossipService` (registre gossip) pour
qu'une instance dimotic-ha connaisse les apps tournant sur d'autres machines du parc — voir leur
code source pour l'intégration, non détaillée ici.

---

## 7. Convention systemd/cron auto-descriptive

Pour une app non-Docker déployée sous `/dimotic-ha-addons/<nom>/` : le fichier d'activation vit
**dans le répertoire de déploiement lui-même**, jamais écrit directement dans `/etc/` — installé par
lien symbolique :

- **Service systemd** : `<REMOTE_DIR>/<nom>.service`, lié par
  `ln -sf <REMOTE_DIR>/<nom>.service /etc/systemd/system/<nom>.service`.
- **Cron** : `<REMOTE_DIR>/<nom>.cron` (format crontab(5) **système**, avec colonne utilisateur —
  ex. `* * * * * root /chemin/script`), lié vers `/etc/cron.d/<nom>`. ⚠️ Le nom du **lien** ne doit
  contenir aucun point — Debian ignore silencieusement un fichier pointé dans `/etc/cron.d/` sinon.
  Le fichier source, lui, peut s'appeler `<nom>.cron` sans problème.

**But** : une seule source de vérité par app, sauvegardée avec le reste du répertoire de déploiement
(voir `fonctionnelles-sauvegarde_specs`, dernière version, §6ter) — aucun nom de service à deviner ou
saisir séparément à la restauration. Exemples réels : `applications/teleinfo/src/domain/
DeployService.ts::writeAndRestartService()`, `applications/arexx/scripts/deploy-sender.sh`.

---

## 8. Routes HTTP génériques (upload/download)

Socket.io reste l'unique canal UI↔serveur pour tout le reste (config, commandes, statut) — deux
routes HTTP génériques couvrent le cas des transferts binaires, que Socket.io ne vise pas :

- **`POST /api/apps/:appId/upload`** — multipart (`multer`, mémoire, 10 Mo max). Relaye tel quel via
  l'événement `<appId>:internal:upload` `{buffer, filename, mimetype, fields}` (déclarer cet
  événement dans `bridgedEvents` si l'app est en process séparé, §4). Réponse HTTP = accusé de
  réception ; le résultat réel est émis séparément par l'app via Socket.io.
- **`GET /api/apps/:appId/download/:token`** — symétrique, pour le sens inverse : une app génère un
  fichier volumineux/binaire (ex: une archive), l'écrit dans `data/<appId>/tmp/downloads/<token>`
  (+ `<token>.meta.json` pour le nom de fichier proposé), notifie le client via Socket.io avec ce
  token ; le navigateur récupère les octets ici en synchrone, fichier supprimé après téléchargement.

Voir `applications/core/src/presentation/server/index.ts` (commentaire d'en-tête de
`PresentationServer`, liste des exceptions volontaires à "tout par Socket.io") pour le détail exact.

---

## 9. Détection automatique + cycle de vie

⭐ **Mis à jour le 24/09/2026** — détail complet : `fonctionnelles-supervisor_specs_v2.10.md` §8.

`AppService` cherche les applications dans **deux racines** : `applications/` (livrée avec l'image) et
`data/applications/` (externe, sur le volume `data/` — pour déposer une application à tester sans
reconstruire l'image ; elle masque une interne de même nom). Conditions de détection :
`domain/index.ts` (ou `dist/domain/index.js`) exporte `{NOM_APP}_APP: ApplicationModule` (dont l'`id`
doit être le nom du dossier) + une factory de service. Noms réservés : `core`, `applications`.

**Une application nouvelle arrive DÉSACTIVÉE** (repère « Nouvelle » dans Gestion des applications) —
y compris sur une installation neuve. On l'active depuis *Paramètres Techniques > Gestion des
applications* : démarrage **à chaud**, jamais de redémarrage du core. Désactiver l'arrête à chaud et
libère tout ce que le core tenait pour elle (menu, états persistants, bridges MQTT — ses entités HA
passent `unavailable`). `disabledApps` + `knownApps` dans `data/core/config.yaml` ; le champ `enabled`
d'un schéma de config d'app n'est lu nulle part (piège découvert le 06/09/2026).

Application externe : ses propres `node_modules` embarqués (zod, js-yaml…), code dans
`data/applications/<app>/`, données dans `data/<app>/` ; elle tourne avec le core de l'image en place.

Crash : relance automatique (1, 2, 4, 8, 16 s), puis état « Plantée — arrêtée » visible + bouton
Relancer. Pour éprouver ces mécanismes : l'application de test `testcycle` (modes de panne).

---

## 10. Checklist avant déploiement

- [ ] `domain/index.ts` exporte `{NOM_APP}_APP` (type `ApplicationModule` réel, §3.1)
- [ ] Factory `create{NomApp}Service`/`create{NomApp}ServiceWithConfig` exportée
- [ ] Config typée Zod, rechargement correct sur `app:module:config:saved`
      (`configProvider.reload()` **avant** de relire)
- [ ] Si `runsAsSeparateProcess: true` : `standalone.ts` présent, `bridgedEvents` complet
- [ ] UI : pas d'import `SocketService`, `window.app.socketService.getSocket()` uniquement
- [ ] Chemins statiques avec le segment `presentation/`
- [ ] `npm run build` (tsc) sans erreur dans le répertoire de l'app
- [ ] Si déploiement vers du matériel distant : `targets[]`, connexion root direct (jamais sudo),
      convention `/docker/<app>/` ou `/dimotic-ha-addons/<app>/`, unité systemd/cron auto-descriptive
      si non-Docker (§7)
- [ ] Test réel (pas seulement compilation) avant de considérer la tâche terminée
