# Guide Rapide — Création d'une Nouvelle Application

**Version :** 1.9  
**Date :** 4 Août 2026  
**Statut :** Document pratique pour les développeurs  
**Public cible :** Développeurs créant une nouvelle application sans modifier le socle  

> **NOUVEAU v1.9 :** Correction de la référence `ws-ha` → `dimotic-ha` (§3.1, projet renommé le
> 04/08/2026), sans changement fonctionnel.

> **⚠️ IMPORTANT :** Ce guide suppose que vous avez lu et compris :
> - [techniques-socle-ha-mqtt_specs_v4.14.md](techniques-socle-ha-mqtt_specs_v4.14.md) (architecture 5 couches, EventBus, cycle de vie, nouvelle arborescence applications/, §4.2.1 exports.ts vs ui-exports.ts)
> - **[inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md) (NOUVEAU : Communication inter-applications)**

> **NOUVEAU v1.7 :** Alpine.js est réintroduit dans la couche Présentation (voir
> [alpinejs-implementation_specs_v1.0.md](alpinejs-implementation_specs_v1.0.md), qui fait autorité sur
> son cycle de vie) — la note v1.1 ci-dessous, qui le présentait comme abandonné, ne s'applique plus.
> §1.2 mis à jour en conséquence.

> **Note v1.1 (obsolète depuis v1.7 — voir ci-dessus)** : Migration vers **TypeScript pur + Web Components natifs** (remplace Alpine.js comme indiqué dans [presentation_specs_v3.2.md](presentation_specs_v3.2.md) §v3.0).

> **NOUVEAU v1.4 :** **Système de communication inter-applications** avec pattern Request/Reply asynchrone et corrélation. Toutes les applications (sauf core) DOIVENT déclarer leurs capacités via `ApplicationCapabilities` et utiliser `InterAppClient` pour les communications inter-applications.

> **NOUVEAU v1.5 :** Correction de la §3.9 (import de `SocketService`) : l'exemple pointait vers un
> chemin qui n'a jamais existé (`core/src/presentation/services/SocketService`) et suggérait un
> singleton `getInstance()` que la classe réelle n'a jamais eu. Le bon point d'entrée est
> **`core/src/ui-exports.ts`** (jamais `exports.ts`, qui est réservé au backend — voir
> `techniques-socle-ha-mqtt_specs` §4.2.1), avec `new SocketService()`.

> **NOUVEAU v1.6 :** Correction des exemples §3.8 (chemins statiques `<link>`/`<script>`) : le
> segment `presentation/` fait partie intégrante de l'URL servie
> (`/applications/{nom-app}/presentation/...`), il ne doit jamais être omis — erreur constatée en
> pratique sur `nommage` et `arbreouquoi` (scripts/styles introuvables au chargement de leur page).
> Correction §5.1 : `AppService` ne scanne que `applications/`, pas de `dist/applications/` partagé
> à la racine (chaque application a son propre `dist/`, voir `techniques-socle-ha-mqtt_specs` §4.2).

---

## 📌 Table des Matières

1. [Prérequis](#1-prérequis)
2. [Structure Minimale d'une Application](#2-structure-minimale-dune-application)
3. [Étapes Clés de Création](#3-étapes-clés-de-création)
4. [Accès au Référentiel Home Assistant](#4-accès-au-référentiel-home-assistant)
5. [Intégration Automatique avec le Socle](#5-intégration-automatique-avec-le-socle)
6. [Configuration d'une Application](#6-configuration-dune-application)
7. [Gestion des Événements Socket.io](#7-gestion-des-événements-socketio)
8. [Tests et Validation](#8-tests-et-validation)
9. [Checklist Avant Déploiement](#9-checklist-avant-déploiement)
10. [Exemple Complet](#10-exemple-complet)
11. **[NOUVEAU] Communication Inter-Applications](#11-nouveau-communication-inter-applications)

---

## 1. Prérequis

### 1.1 Environnement
- Node.js 20+ (LTS)
- TypeScript 5.x (mode strict)
- pnpm (recommandé)
- Comprendre l'[architecture 5 couches](techniques-socle-ha-mqtt_specs_v4.14.md#3-architecture-en-couches)

### 1.2 Connaissances requises
- EventBus Typé (voir §9 techniques-socle-ha-mqtt_specs_v4.14.md)
- Socket.io (unique canal UI ↔ Serveur)
- TypeScript pur + Web Components natifs (pour la couche Présentation), avec Alpine.js autorisé en complément selon [alpinejs-implementation_specs_v1.0.md](alpinejs-implementation_specs_v1.0.md)
- Convention de nommage ([nommage_specs_v1.0.md](nommage_specs_v1.0.md))
- **NOUVEAU : Pattern Request/Reply asynchrone** (voir [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md))

### 1.3 Outils
- Un éditeur avec support TypeScript (VSCode recommandé)
- Docker (pour les tests d'intégration)

---

## 2. Structure Minimale d'une Application

```bash
applications/
└── {nom-app}/                    # ⚠️ Nom en minuscules, sans espaces
    ├── domain/
    │   ├── index.ts               # ⭐ OBLIGATOIRE : Module + Factory + Capacités
    │   ├── {NomApp}Service.ts     # ⭐ OBLIGATOIRE : Service métier
    │   ├── socket-events.ts        # Événements Socket.io spécifiques
    │   ├── config-schema.ts       # Schema de configuration (Zod)
    │   ├── types.ts               # Types spécifiques
    │   └── capabilities.ts        # ⭐ NOUVEAU : Déclaration des capacités inter-app
    │
    └── presentation/
        ├── index.html             # ⭐ OBLIGATOIRE : UI de l'application
        ├── styles/
        │   └── {nom-app}.css       # Styles spécifiques
        └── ts/
            └── app.ts              # Logique frontend (TypeScript)
```

**Fichiers obligatoires** :
- `domain/index.ts` — Déclaration du module et export des capacités
- `domain/{NomApp}Service.ts` — Service avec méthodes `start()` et optionnellement `stop()`
- `domain/capabilities.ts` — **NOUVEAU** : Déclaration des `ApplicationCapabilities`
- `presentation/index.html` — Interface utilisateur

---

## 3. Étapes Clés de Création

### 3.1 Créer le répertoire de l'application

```bash
cd /chemin/vers/dimotic-ha
mkdir -p applications/{nom-app}/domain
mkdir -p applications/{nom-app}/presentation/styles
mkdir -p applications/{nom-app}/presentation/ts
```

### 3.2 Définir le module

**Fichier : `applications/{nom-app}/domain/index.ts`**

> **⚠️ NOUVEAU :** Utilisez les imports depuis `../../core/src/exports` pour une meilleure maintenabilité.

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { ApplicationModule, ModuleUiMetadata } from '../../../core/src/types/config';
import { EventBus, IEventBus, Logger, createLogger } from '../../../core/src/exports';
import { ApplicationCapabilities } from '../../../core/src/types/interapp';

import { {NOM_APP}_SOCKET_EVENTS } from './socket-events';
import { {NOM_APP}_CAPABILITIES } from './capabilities';
import { {NomApp}Service } from './{NomApp}Service';

// Métadonnées UI (optionnel, pour la génération automatique)
export const {NOM_APP}_UI_METADATA: ModuleUiMetadata = {
  title: 'Configuration {Nom App}',
  description: 'Description de l\'application',
  icon: '🎯',
  fields: [
    // Définir les champs de configuration ici
  ]
};

// Déclaration du module
export const {NOM_APP}_APP: ApplicationModule = {
  id: '{nom-app}',           // ⚠️ Doit correspondre au nom du répertoire
  name: '{Nom App}',
  description: 'Description de l\'application',
  icon: '🎯',
  type: 'integration',       // 'integration' | 'standalone' | 'core'
  configurable: true,        // Peut être configuré via UI
  requiredMqtt: true,       // true si MQTT nécessaire
  requiredHaWs: false,      // true si HA WebSocket nécessaire
  socketEvents: {NOM_APP}_SOCKET_EVENTS,
  configUi: {NOM_APP}_UI_METADATA,
  configSection: '{nom-app}' // Nom de la section dans config.yaml
};

// ⭐ NOUVEAU : Exporter les capacités inter-applications
export { {NOM_APP}_CAPABILITIES } from './capabilities';

// Exporter les composants
export * from './{NomApp}Service';
export * from './socket-events';
export * from './config-schema';
export * from './types';
```

### 3.3 Implémenter le service métier

**Fichier : `applications/{nom-app}/domain/{NomApp}Service.ts`**

> **⚠️ NOUVEAU :** Utilisez `InterAppClient` pour la communication inter-applications.

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { IEventBus } from '../../../core/src/application/IEventBus';
import { EventBus, Logger, InterAppClient } from '../../../core/src/exports';
import type { IAppConfigProvider } from '../../../core/src/infrastructure/config/IAppConfigProvider';
import type { {NomApp}Config } from './config-schema';

import { {NOM_APP}_CAPABILITIES } from './capabilities';

export class {NomApp}Service {
  private interAppClient: InterAppClient;

  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configService: IAppConfigProvider<{NomApp}Config>
  ) {
    // ⭐ NOUVEAU : Initialiser le client inter-app
    this.interAppClient = new InterAppClient(eventBus, logger, '{nom-app}');
    
    this.setupEventListeners();
    this.setupInterAppHandlers();
  }

  // ⭐ OBLIGATOIRE : Méthode start() asynchrone
  async start(): Promise<void> {
    this.logger.info('{NomApp}Service', 'Démarrage du service...');
    
    // Charger la configuration
    const config = this.configService.getAppConfig();
    
    // Initialiser votre logique métier ici
    
    this.logger.info('{NomApp}Service', 'Service démarré avec succès');
  }

  // OPTIONNEL : Méthode stop() pour un arrêt propre
  async stop(): Promise<void> {
    this.logger.info('{NomApp}Service', 'Arrêt du service...');
    // Libérer les ressources
    this.interAppClient.cleanupExpired();
    this.logger.info('{NomApp}Service', 'Service arrêté');
  }

  private setupEventListeners(): void {
    // Écouter les événements spécifiques
    this.eventBus.onGeneric('{nom-app}:action', (data) => {
      this.handleAction(data);
    });
  }

  // ⭐ NOUVEAU : Configurer les handlers inter-app
  private setupInterAppHandlers(): void {
    // Pour chaque capacité déclarée, configurer le handler
    for (const [capabilityName] of Object.keys({NOM_APP}_CAPABILITIES.handledRequests)) {
      this.interAppClient.onRequest(
        capabilityName,
        {NOM_APP}_CAPABILITIES.handledRequests[capabilityName].handler
      );
    }
  }

  private handleAction(data: unknown): void {
    // Logique de traitement
  }
}
```

### 3.4 Définir les événements Socket.io

**Fichier : `applications/{nom-app}/domain/socket-events.ts`**

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { SocketEventsMap } from '../../../core/src/types/config';

export const {NOM_APP}_SOCKET_EVENTS = {
  // Server → Client
  DATA_LIST: '{nom-app}:data:list',
  DATA_UPDATED: '{nom-app}:data:updated',
  STATUS: '{nom-app}:status',
  ERROR: '{nom-app}:error',
  
  // Client → Server
  DATA_GET: '{nom-app}:data:get',
  DATA_SAVE: '{nom-app}:data:save',
  ACTION_REQUEST: '{nom-app}:action:request',
} as const;

export type {NomApp}SocketEvents = typeof {NOM_APP}_SOCKET_EVENTS;
```

### 3.5 Définir le schema de configuration

**Fichier : `applications/{nom-app}/domain/config-schema.ts`**

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import { z } from 'zod';

export const {nomApp}ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Ajouter vos champs de configuration ici
  apiKey: z.string().optional(),
  pollInterval: z.number().min(1000).max(300000).default(60000),
});

export type {NomApp}Config = z.infer<typeof {nomApp}ConfigSchema>;
```

### 3.6 **NOUVEAU : Déclarer les capacités inter-applications**

**Fichier : `applications/{nom-app}/domain/capabilities.ts`**

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { AppRequest, AppReply, ApplicationCapabilities, RequestHandler } from '../../../core/src/types/interapp';
import { {NomApp}Service } from './{NomApp}Service';

// Définir les types pour vos capacités
export interface MyAppRequestPayload {
  // Définir les propriétés de la requête
  action: string;
  data?: Record<string, unknown>;
}

export interface MyAppReplyResult {
  // Définir les propriétés de la réponse
  success: boolean;
  result?: unknown;
  message?: string;
}

// Handlers pour chaque capacité
const handleMyCapability: RequestHandler<
  AppRequest<MyAppRequestPayload>,
  MyAppReplyResult
> = async (request, reply) => {
  try {
    // Traiter la requête
    const result = await processRequest(request.payload);
    
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: '{nom-app}',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: '{nom-app}',
      status: 'error',
      error: {
        code: 'MYAPP_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? undefined : error
      },
      timestamp: new Date().toISOString()
    });
  }
};

// Déclaration des capacités de l'application
export const {NOM_APP}_CAPABILITIES: ApplicationCapabilities = {
  id: '{nom-app}',
  name: '{Nom App}',
  description: 'Description des capacités de cette application',
  version: '1.0',

  // Capacités gérées (Request/Reply)
  handledRequests: {
    '{nom-app}:my-capability': {
      description: 'Description de cette capacité',
      requestType: 'AppRequest<MyAppRequestPayload>',
      responseType: 'AppReply<MyAppReplyResult>',
      handler: handleMyCapability,
      maxTimeout: 5000 // Timeout maximum en ms
    }
    // Ajouter d'autres capacités ici
  },

  // Événements émettables (Fire & Forget)
  emittedEvents: {
    '{nom-app}:event': {
      description: 'Description de l\'événement',
      payloadType: 'MyAppEventPayload'
    }
  }
};

// Exporter les types pour utilisation externe
export type { MyAppRequestPayload, MyAppReplyResult };
```

### 3.7 Créer la factory de service

**À ajouter dans `applications/{nom-app}/domain/index.ts`**

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { IEventBus } from '../../../core/src/application/IEventBus';
import { EventBus, Logger, createLogger } from '../../../core/src/exports';
import type { IAppConfigProvider } from '../../../core/src/infrastructure/config/IAppConfigProvider';
import type { ConfigService } from '../../../core/src/infrastructure/config/ConfigService';

import { {NomApp}Service } from './{NomApp}Service';
import { {NomApp}Config } from './config-schema';
import { AppConfigProvider } from '../../../core/src/infrastructure/config/AppConfigProvider';

/**
 * Factory recommandée : utilise IAppConfigProvider
 * Conforme à l'architecture 5 couches (injection d'interfaces)
 */
export function create{NomApp}Service(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<{NomApp}Config>
): {NomApp}Service {
  return new {NomApp}Service(eventBus, logger, configProvider);
}

/**
 * Factory alternative : crée automatiquement le provider
 * Utile si votre service attend ConfigService directement
 */
export function create{NomApp}ServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): {NomApp}Service {
  const configProvider = new AppConfigProvider<{NomApp}Config>('{nom-app}', configService);
  return create{NomApp}Service(eventBus, logger, configProvider);
}
```

> **⚠️ Note** : `AppService` essaiera d'abord avec `configProvider`, puis basculera sur `configService` si nécessaire.

### 3.8 Créer l'interface utilisateur

**Fichier : `applications/{nom-app}/presentation/index.html`**

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{Nom App} - HA App</title>
  <link rel="stylesheet" href="/styles/main.css">
  <link rel="stylesheet" href="/applications/{nom-app}/presentation/styles/{nom-app}.css">
</head>
<body>
  <div class="app-container">
    <h1>{Nom App}</h1>
    <div id="app-container">
      <div id="loading" class="status">Chargement en cours...</div>
      <div id="data-container" class="data-container" style="display: none;"></div>
      <div id="error" class="error" style="display: none;"></div>
    </div>
  </div>
  <script src="/applications/{nom-app}/presentation/ts/app.js"></script>
</body>
</html>
```

> **⚠️ v1.6** : Le segment `presentation/` fait partie intégrante de l'URL (pas seulement du chemin
> disque) — `/applications/{nom-app}/presentation/...` correspond à
> `applications/{nom-app}/{dist,src}/presentation/...`. C'est la convention réellement utilisée par
> `ModuleContainer.ts` du core et `presentation_specs` §4.3 ; un chemin qui omettrait `presentation/`
> (ex: `/applications/{nom-app}/ts/app.js`) ne résout vers rien.

### 3.9 Initialiser le client Socket.io

**Fichier : `applications/{nom-app}/presentation/ts/app.ts`**

> **⚠️ v1.5 :** `SocketService` s'importe depuis **`core/src/ui-exports.ts`**, jamais depuis
> `core/src/exports.ts` (réservé au backend Node.js — voir `techniques-socle-ha-mqtt_specs` §4.2.1).
> `SocketService` n'est **pas** un singleton (pas de `getInstance()`) : instanciez-le avec `new`.
>
> Le chemin d'import dépend du `rootDir` TypeScript de votre application (voir §2 pour le
> `tsconfig.json` recommandé) :
> - `rootDir` englobant `applications/` (ex: `nommage`, `rootDir: ".."`) : importer directement la
>   source — `import { SocketService } from '../../../../core/src/ui-exports';`
> - `rootDir` restreint à `./src` (ex: `arbreouquoi`) : TypeScript refuse de compiler une source hors
>   `rootDir` (erreur `TS6059`). Importer alors le **dist UI déjà buildé** du core (nécessite d'avoir
>   lancé `npm run build:ui` côté core au préalable) —
>   `import { SocketService } from '../../../../core/dist/presentation/ui/js/ts/services/SocketService';`

```typescript
// Cas rootDir englobant applications/ (voir note ci-dessus pour l'alternative dist)
import { SocketService } from '../../../../core/src/ui-exports';

const socket = new SocketService();
socket.connect();

// Émettre des événements vers le serveur
function loadData() {
  socket.emit('{nom-app}:data:get');
}

// Écouter les événements du serveur
socket.on('{nom-app}:data:list', (data: unknown) => {
  console.log('Données reçues:', data);
});

socket.on('{nom-app}:status', (status: unknown) => {
  console.log('Statut:', status);
});

// Exporter pour TypeScript si nécessaire
declare global {
  interface Window {
    {nomApp}App: {
      loadData: () => void;
    };
  }
}

window.{nomApp}App = { loadData };
```

---

## 4. Accès au Référentiel Home Assistant

> **🎯 Cette section est cruciale pour les applications qui interagissent avec les entités HA**

Le socle fournit un **référentiel structuré** des entités Home Assistant organisé par :
**Area (Lieu/Pièce) → QUOI (Type) → Entités**

### 4.1 Concepts clés

| Concept | Description | Exemple |
|---------|-------------|---------|
| **Area** | Pièce ou zone dans HA | `Salon`, `Cuisine`, `Chambre` |
| **QUOI** | Classification fonctionnelle | `température`, `lumière`, `interrupteur` |
| **Device** | Appareil physique ou logique | `RFXtrx433E`, `Zigbee Coordinator` |
| **Entity** | Composant contrôlable/mesurable | `sensor.temperature_salon`, `light.lampe_salon` |

---

## 5. Intégration Automatique avec le Socle

Le socle **détecte et démarre automatiquement** votre application.

### 5.1 Convention de détection

`AppService` scanne automatiquement le répertoire `applications/` à la racine du projet (chaque
application y possède son propre `dist/` et `src/` — il n'existe pas de `dist/applications/`
partagé à la racine, contrairement à ce qu'indiquait cette section avant v1.6).

**Conditions pour être détectée** :
1. Répertoire doit contenir `domain/index.ts`
2. Ce fichier doit exporter une constante `{NOM_APP}_APP` de type `ApplicationModule`
3. **NOUVEAU** : Ce fichier doit aussi exporter `{NOM_APP}_CAPABILITIES` de type `ApplicationCapabilities` (pour les applications autres que core)
4. Une factory de service doit être exportée (`create{NomApp}Service` ou `{NomApp}ServiceFACTORY`)

### 5.2 Cycle de vie automatique

```
Démarrage AppService
    │
    ▼
Détection des modules (detectApplicationModules)
    │
    ▼
Module "{nom-app}" détecté
    │
    ▼
Recherche factory: create{NomApp}Service
    │
    ▼
Instanciation: new {NomApp}Service(eventBus, logger, configProvider)
    │
    ▼
Initialisation complète
    │
    ▼
Appel automatique: .start()
    │
    ▼
✅ Service démarré
```

### 5.3 Gestion des erreurs

Si le démarrage échoue (mauvaise config, matériel absent) :
- Un **warning** est loggé (pas une erreur)
- L'application **continue de fonctionner**
- Le service peut être redémarré automatiquement plus tard

### 5.4 Redémarrage automatique

Le service est **automatiquement redémarré** quand :
- La configuration de l'application est sauvegardée (`app:module:config:saved`)
- L'application est réactivée (déplacement depuis `applications_desactivees/`)

---

## 6. Configuration d'une Application

### 6.1 Définir le schema

**Fichier : `config-schema.ts`**

```typescript
import { z } from 'zod';

export const myAppConfigSchema = z.object({
  // Champs obligatoires
  enabled: z.boolean().default(true),
  apiEndpoint: z.string().url(),
  
  // Champs optionnels
  pollInterval: z.number().min(1000).max(300000).default(60000),
  maxRetries: z.number().min(0).max(10).default(3),
  
  // Tableaux
  monitoredEntities: z.array(z.string()).default([]),
  
  // Objets imbriqués
  auth: z.object({
    token: z.string().min(32),
    expiresIn: z.number().optional()
  }).optional()
});

export type MyAppConfig = z.infer<typeof myAppConfigSchema>;
```

### 6.2 Utiliser IAppConfigProvider

**Dans votre service** :

```typescript
// ⭐ Import depuis le point d'entrée unique du core
import type { IAppConfigProvider } from '../../../core/src/infrastructure/config/IAppConfigProvider';
import type { MyAppConfig } from './config-schema';

export class MyAppService {
  private config: MyAppConfig;
  
  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configService: IAppConfigProvider<MyAppConfig>
  ) {
    this.config = this.configService.getAppConfig();
  }
  
  getConfig(): MyAppConfig {
    return this.configService.getAppConfig();
  }
  
  reloadConfig(): void {
    this.config = this.configService.getAppConfig();
    this.logger.info('MyAppService', 'Configuration rechargée');
  }
}
```

---

## 7. Gestion des Événements Socket.io

### 7.1 Événements Socle disponibles

**Serveur → Client** :

| Événement | Payload | Description |
|-----------|---------|-------------|
| `app:status` | `{ mqtt: boolean, haEntities: number, uptime: number }` | Statut global |
| `app:log` | `{ level, module, message, ts }` | Ligne de log |
| `ha:sync:ready` | `{ entityCount: number }` | Référentiel HA initialisé |
| `ha:status` | `{ connected: boolean }` | Statut connexion WS HA |
| `ha:entity:updated` | `HaStructuredEntity` | Entité mise à jour |
| `ha:structure` | `HaStructuredRegistry` | **Référentiel complet** |
| `ha:structure:rebuilt` | `HaStructuredRegistry` | Référentiel reconstruit |
| `ha:area:updated` | `HaArea` | Area mise à jour |
| `ha:command:result` | `HaCommandResult` | Résultat d'une commande |
| `mqtt:connected` | `void` | MQTT connecté |
| `mqtt:disconnected` | `{ reason: string }` | MQTT déconnecté |

**Client → Serveur** :

| Événement | Payload | Description |
|-----------|---------|-------------|
| `config:get` | `void` | Demander la config |
| `config:save` | `TechnicalConfig` | Sauvegarder la config |
| `config:validate` | `Partial<TechnicalConfig>` | Valider la config |
| `ha:structure:get` | `void` | **Demander le référentiel HA** |
| `ha:command:send` | `HaCommand` | Envoyer une commande à HA |
| `app:modules:config:get` | `{ moduleId: string }` | Demander config d'un module |
| `app:modules:config:save` | `{ moduleId, config }` | Sauvegarder config d'un module |

### 7.2 Événements persistant — Reçu automatiquement à la connexion

> **✅ NOUVEAU v1.2** : Certains événements du socle et des applications sont **persistants** et envoyés automatiquement aux nouveaux clients Socket.io.

**Événements persistants du socle (core) :**
- `app:status` — Statut global de l'application
- `config:current` — Configuration actuelle complète
- `mqtt:connected` — Statut de connexion MQTT
- `mqtt:disconnected` — Statut de déconnexion MQTT
- `app:modules:list` — Liste des modules disponibles
- `ha:status` — Statut de connexion HA

---

## 8. Tests et Validation

### 8.1 Vérifications de base

```bash
# Vérifier que le build passe
npm run build

# Vérifier qu'il n'y a pas d'erreurs TypeScript
npx tsc --noEmit

# Lancer en développement
npm run dev
```

### 8.2 Checklist de validation

- [ ] Le module apparaît dans la liste des modules détectés (logs au démarrage)
- [ ] Le service démarre sans erreur (vérifier les logs `AppService`)
- [ ] Le service émet bien ses événements Socket.io
- [ ] L'UI de l'application est accessible via `/applications/{nom-app}/presentation/index.html`
- [ ] La configuration du module est visible dans les paramètres techniques
- [ ] Les modifications de configuration déclenchent bien un redémarrage du service
- [ ] **NOUVEAU** : Les capacités inter-app sont bien enregistrées (vérifier logs `AppService`)
- [ ] **NOUVEAU** : Les Request/Reply fonctionnent correctement avec corrélation

---

## 9. Checklist Avant Déploiement

- [ ] Structure du répertoire conforme
- [ ] `domain/index.ts` exporte `{NOM_APP}_APP`
- [ ] Service implémente `start()` et optionnellement `stop()`
- [ ] Factory de service exportée (`create{NomApp}Service`)
- [ ] Configuration typée avec Zod
- [ ] Événements Socket.io déclarés
- [ ] UI minimale fonctionnelle
- [ ] Tests de build réussis
- [ ] **NOUVEAU** : Capacités inter-app déclarées
- [ ] **NOUVEAU** : Handlers Request/Reply implémentés
- [ ] **NOUVEAU** : Utilisation de `InterAppClient` pour les communications sortantes

---

## 10. Exemple Complet

Voir un exemple complet dans [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md) §7.

---

## 11. Communication Inter-Applications

> **⚠️ IMPORTANT :** Cette section est **obligatoire** pour toutes les applications (sauf core).
> Lisez aussi [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md) pour les détails complets.

### 11.1 Principe

**Approche décentralisée :** Chaque application documente ses propres capacités dans sa spécification (section 9).

Toutes les applications (sauf le core) **DOIVENT** :
1. **Documenter** leurs capacités dans leur spec (section 9)
2. **Écouter** et **répondre** aux Request ciblant leurs capacités via `interAppClient.onRequest()`
3. Utiliser **`InterAppClient`** pour émettre des Request vers d'autres applications
4. Gérer la **corrélation** via `requestId` pour les Request/Reply

### 11.2 Deux patterns de communication

#### Pattern 1 : Fire & Forget (Événements simples)

Pour les notifications où **aucune réponse n'est attendue**.

#### Pattern 2 : Request/Reply (Question/Réponse)

Pour les interactions où **une réponse est attendue** de manière **asynchrone**.

### 11.3 Bonnes pratiques

1. **Toujours typer** vos requêtes et réponses avec TypeScript
2. **Utiliser des noms de capacités clairs** : `{domain}:{action}` (ex: `scheduler:schedule`)
3. **Gérer les erreurs** : Toujours répondre avec `status: 'error'` en cas d'échec
4. **Respecter les timeouts** : Les timeouts sont gérés par l'émetteur, pas par le récepteur
5. **Ne pas bloquer** : Les handlers DOIVENT être asynchrones et non-bloquants
6. **Logger** : Utiliser le logger avec le tag de l'application pour le débogage
7. **Documenter** : Ajouter une description claire pour chaque capacité dans la section 9 de la spec

> **⚠️ IMPORTANT :** Cette section est **obligatoire** pour toutes les applications (sauf core).
> Lisez aussi [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md) pour les détails complets.

### 11.1 Principe

Toutes les applications (sauf le core) **DOIVENT** :
1. **Déclarer** leurs capacités via `ApplicationCapabilities`
2. **Écouter** et **répondre** aux Request ciblant leurs capacités
3. Utiliser **`InterAppClient`** pour émettre des Request vers d'autres applications
4. Gérer la **corrélation** via `requestId` pour les Request/Reply

### 11.2 Deux patterns de communication

#### Pattern 1 : Fire & Forget (Événements simples)

Pour les notifications où **aucune réponse n'est attendue**.

```typescript
// Dans votre service
import { InterAppClient } from '../../../core/src/application/InterAppClient';

class MyAppService {
  private interApp: InterAppClient;

  constructor(eventBus: IEventBus, logger: Logger) {
    this.interApp = new InterAppClient(eventBus, logger, '{nom-app}');
  }

  notifyDeviceDetected(device: DeviceInfo) {
    // Émettre un événement Fire & Forget
    this.interApp.emit('{nom-app}:device:detected', device);
    
    // Aucune réponse n'est attendue
    // L'émetteur continue immédiatement
  }
}

// Dans une autre application qui écoute
class OtherAppService {
  constructor(eventBus: IEventBus, logger: Logger) {
    // Écouter l'événement
    this.interApp.on('{nom-app}:device:detected', (device, fromApp) => {
      console.log(`Device détecté par ${fromApp}:`, device);
      // Traiter la détection...
    });
  }
}
```

#### Pattern 2 : Request/Reply (Question/Réponse)

Pour les interactions où **une réponse est attendue** de manière **asynchrone**.

```typescript
// Dans votre service (application appelante)
class CallingAppService {
  private interApp: InterAppClient;

  constructor(eventBus: IEventBus, logger: Logger) {
    this.interApp = new InterAppClient(eventBus, logger, '{nom-app}');
  }

  async scheduleAction(action: string, delay: number): Promise<ScheduleReplyResult> {
    try {
      // ⭐ Pose une question à l'application Scheduler
      // La réponse arrivera de manière ASYNCHRONE
      const reply = await this.interApp.request<
        ScheduleRequestPayload,
        ScheduleReplyResult
      >(
        'scheduler:schedule',  // Capacité ciblée
        { action, at: `+${delay}m` },  // Payload
        5000  // Timeout : 5 secondes
      );

      if (reply.status === 'success') {
        console.log('Planification créée:', reply.result.scheduleId);
        return reply.result;
      } else {
        throw new Error(reply.error?.message || 'Erreur inconnue');
      }
    } catch (error) {
      if (error instanceof InterAppTimeoutError) {
        console.error('Timeout:', error.message);
      } else if (error instanceof InterAppReplyError) {
        console.error('Erreur réponse:', error.errorMessage);
      }
      throw error;
    }
  }
}

// Dans l'application Scheduler (application réceptrice)
class SchedulerService {
  constructor(eventBus: IEventBus, logger: Logger) {
    this.interApp = new InterAppClient(eventBus, logger, 'scheduler');
    
    // ⭐ Configurer le handler pour la capacité 'scheduler:schedule'
    this.interApp.onRequest(
      'scheduler:schedule',
      SCHEDULER_CAPABILITIES.handledRequests['scheduler:schedule'].handler
    );
  }
}
```

### 11.3 Déclaration des capacités

**Toute application DOIT exporter** ses capacités dans `domain/capabilities.ts` :

```typescript
import type { AppRequest, AppReply, ApplicationCapabilities, RequestHandler } from '../../../core/src/types/interapp';

// 1. Définir les types pour vos requêtes et réponses
export interface MyScheduleRequest {
  action: string;
  at: string;
  entity: string;
}

export interface MyScheduleReply {
  scheduleId: string;
  status: string;
}

// 2. Créer le handler
export interface MyAppRequestPayload {
  // ...
}

export interface MyAppReplyResult {
  // ...
}

const handleMyCapability: RequestHandler<
  AppRequest<MyAppRequestPayload>,
  MyAppReplyResult
> = async (request, reply) => {
  try {
    // Traiter la requête de manière ASYNCHRONE
    const result = await processRequest(request.payload);
    
    // ⭐ TOUJOURS inclure requestId et inReplyTo
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'myapp',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'myapp',
      status: 'error',
      error: {
        code: 'MYAPP_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      timestamp: new Date().toISOString()
    });
  }
};

// 3. Exporter les capacités
export const MYAPP_CAPABILITIES: ApplicationCapabilities = {
  id: 'myapp',
  name: 'Mon Application',
  description: 'Description de mon application',
  version: '1.0',

  handledRequests: {
    'myapp:my-capability': {
      description: 'Ma capacité',
      requestType: 'AppRequest<MyAppRequestPayload>',
      responseType: 'AppReply<MyAppReplyResult>',
      handler: handleMyCapability
    }
  },

  emittedEvents: {
    'myapp:event': {
      description: 'Mon événement',
      payloadType: 'MyAppEventPayload'
    }
  }
};
```

### 11.4 Bonnes pratiques

1. **Toujours typer** vos requêtes et réponses avec TypeScript
2. **Utiliser des noms de capacités clairs** : `{domain}:{action}` (ex: `scheduler:schedule`)
3. **Gérer les erreurs** : Toujours répondre avec `status: 'error'` en cas d'échec
4. **Respecter les timeouts** : Les timeouts sont gérés par l'émetteur, pas par le récepteur
5. **Ne pas bloquer** : Les handlers DOIVENT être asynchrones et non-bloquants
6. **Logger** : Utiliser le logger avec le tag de l'application pour le débogage
7. **Documenter** : Ajouter une description claire pour chaque capacité

### 11.5 Gestion des erreurs

```typescript
// Dans un handler
export const handleMyCapability: RequestHandler = async (request, reply) => {
  try {
    const result = await someAsyncOperation(request.payload);
    
    if (!result) {
      // Erreur métier
      reply({
        requestId: request.requestId,
        inReplyTo: request.requestId,
        fromApp: 'myapp',
        status: 'error',
        error: {
          code: 'INVALID_DATA',
          message: 'Les données fournies sont invalides',
          details: { reason: 'data is empty' }
        },
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'myapp',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    // Erreur inattendue
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'myapp',
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Erreur interne',
        details: process.env.NODE_ENV === 'development' ? error : undefined
      },
      timestamp: new Date().toISOString()
    });
  }
};
```

### 11.6 Exemple complet : IA → Scheduler

**Application IA (appelante) :**

```typescript
// applications/ia/domain/capabilities.ts
import type { RequestHandler, ApplicationCapabilities } from '../../../core/src/types/interapp';

// Types pour les requêtes de planification
import type { ScheduleRequestPayload, ScheduleReplyResult } from '../../scheduler/domain/capabilities';

const handleAiAnalysis: RequestHandler = async (request, reply) => {
  // L'IA analyse et décide d'une action
  const action = analyzeAndDecide(request.payload);
  
  if (action.type === 'schedule') {
    // Utiliser le client inter-app pour planifier
    const schedulerReply = await this.interApp.request<
      ScheduleRequestPayload,
      ScheduleReplyResult
    >(
      'scheduler:schedule',
      {
        action: action.command,
        at: action.at,
        target: action.target
      },
      10000 // 10 secondes de timeout
    );
    
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'ia',
      status: 'success',
      result: { scheduled: true, scheduleId: schedulerReply.result?.scheduleId },
      timestamp: new Date().toISOString()
    });
  }
};

export const IA_CAPABILITIES: ApplicationCapabilities = {
  id: 'ia',
  name: 'Intelligence Artificielle',
  description: 'Analyse et prise de décision autonome',
  version: '1.0',

  handledRequests: {
    'ia:analyze': {
      description: 'Analyser une situation et proposer des actions',
      requestType: 'AppRequest<IaAnalysisRequest>',
      responseType: 'AppReply<IaAnalysisReply>',
      handler: handleAiAnalysis
    }
  },

  emittedEvents: {
    'ia:decision': {
      description: 'Une décision a été prise par l IA',
      payloadType: 'IaDecisionPayload'
    }
  }
};
```

**Application Scheduler (réceptrice) :**

```typescript
// applications/scheduler/domain/capabilities.ts
import type { RequestHandler, ApplicationCapabilities } from '../../../core/src/types/interapp';

export interface ScheduleRequestPayload {
  action: string;
  at: string;
  target?: string;
  options?: {
    repeat?: string;
    retryCount?: number;
  };
}

export interface ScheduleReplyResult {
  scheduleId: string;
  scheduledAt: string;
  status: 'scheduled' | 'already-exists' | 'invalid';
  message?: string;
}

const handleScheduleRequest: RequestHandler<
  AppRequest<ScheduleRequestPayload>,
  ScheduleReplyResult
> = async (request, reply) => {
  try {
    // Validation
    if (!request.payload.action) {
      reply({
        requestId: request.requestId,
        inReplyTo: request.requestId,
        fromApp: 'scheduler',
        status: 'error',
        error: {
          code: 'INVALID_REQUEST',
          message: 'Le champ "action" est obligatoire'
        },
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Création de la planification (opération asynchrone)
    const scheduleId = await SchedulerEngine.create(request.payload);
    
    const result: ScheduleReplyResult = {
      scheduleId,
      scheduledAt: request.payload.at,
      status: 'scheduled',
      message: 'Planification créée avec succès'
    };

    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'scheduler',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'scheduler',
      status: 'error',
      error: {
        code: 'SCHEDULE_ERROR',
        message: error instanceof Error ? error.message : 'Erreur de planification'
      },
      timestamp: new Date().toISOString()
    });
  }
};

export const SCHEDULER_CAPABILITIES: ApplicationCapabilities = {
  id: 'scheduler',
  name: 'Planificateur',
  description: 'Gère la planification d actions futures',
  version: '1.0',

  handledRequests: {
    'scheduler:schedule': {
      description: 'Planifier une nouvelle action',
      requestType: 'AppRequest<ScheduleRequestPayload>',
      responseType: 'AppReply<ScheduleReplyResult>',
      handler: handleScheduleRequest,
      maxTimeout: 10000
    },
    'scheduler:cancel': {
      description: 'Annuler une planification existante',
      requestType: 'AppRequest<{scheduleId: string}>',
      responseType: 'AppReply<{success: boolean}>',
      handler: handleCancelRequest
    }
  },

  emittedEvents: {
    'scheduler:executed': {
      description: 'Une planification a été exécutée',
      payloadType: 'ScheduleExecutedPayload'
    },
    'scheduler:missed': {
      description: 'Une planification a été manquée',
      payloadType: 'ScheduleMissedPayload'
    }
  }
};
```

---

*Ce document doit être lu avant de créer une nouvelle application.*
*Pour plus de détails sur la communication inter-applications, voir [inter-app-communication_specs_v1.0.md](inter-app-communication_specs_v1.0.md).
