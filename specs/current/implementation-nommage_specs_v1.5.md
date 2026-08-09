# Spécifications d'Implémentation - Application NOMMAGE

**Version :** 1.5  
**Date :** 9 Août 2026  
**Auteur :** Mistral Vibe / Claude  
**Statut :** Document technique pour les développeurs  
**Document parent :** [fonctionnelles-nommage_specs_v1.5.md](./fonctionnelles-nommage_specs_v1.5.md)

> **v1.5** : **`TranslationsRepository`** (§3 arborescence, §4.2 exemple `emitPassthroughDiscovery`,
> §6.3 config YAML) — traduction de noms d'entité par pays, voir `fonctionnelles-nommage_specs`
> §3.7 pour le mécanisme complet.

> **v1.4** : **Reconnexion MQTT sur sauvegarde via le formulaire générique** (§4.2.2, nouveau) —
> `app:module:config:saved` écouté en plus de `nommage:config:save` (jamais déclenché par une UI
> réelle). Correction de la référence `ws-ha` → `dimotic-ha` (§7.1, projet renommé le 04/08/2026).

> **v1.1** : `NommageMqttIntegrationService` gère désormais **N connexions MQTT simultanées** (une
> par source, §4.1) au lieu d'une seule. La transmission vers HA passe par le **Passthrough MQTT**
> du socle (§5.3) et remplace l'ancien `nommage:transmit:to-core`. **Correction importante** : le
> flux ne met **jamais** à jour `HaStructureRegistry` (alimenté nativement par HA via WS
> uniquement, si `ha.ws_enable=true`) — NOMMAGE ne dépend que de `ha.mqtt_enable`.

> **v1.2** : Le code livré en v1.1 ne connectait et ne traitait en réalité que la **première**
> source (`couples[0]`), les exemples de code de cette section §4 n'avaient d'ailleurs jamais été
> alignés sur le Passthrough MQTT malgré le texte l'annonçant — les deux sont corrigés ci-dessous.
> **`bridgeInstance` obligatoire** (§5.3, absent de l'exemple v1.1) : NOMMAGE s'enregistre auprès du
> socle (`integration:bridge:register`) avec `bridgeInstance: 'main'` avant de pouvoir publier via
> le Passthrough MQTT. **Nouveau** (§4.2.1) : `NommageStatus` expose `sources[]` (statut par
> connexion) et `dailyCounts[]` (entrées traitées par jour, 5 jours glissants).

---

## 📚 Table des Matières

1. [Introduction](#1-introduction)
2. [Architecture Technique](#2-architecture-technique)
3. [Structure des Répertoires](#3-structure-des-répertoires)
4. [Détails d'Implémentation](#4-détails-dimplémentation)
5. [Intégration avec le Socle](#5-intégration-avec-le-socle)
6. [Configuration Technique](#6-configuration-technique)
7. [Tests et Validation](#7-tests-et-validation)
8. [Dépannage](#8-dépannage)

---

## 1. Introduction

Ce document détaille l'**implémentation technique** de l'application NOMMAGE, en complément des [spécifications fonctionnelles](./fonctionnelles-nommage_specs_v1.2.md).

**Public cible :**
- Développeurs souhaitant étendre ou maintenir l'application
- Intégrateurs souhaitant comprendre le code source
- Contributeurs au projet

---

## 2. Architecture Technique

### 2.1 Couches logicielles (5 couches)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PRÉSENTATION                                   │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  presentation/index.html                              │ │
│  │  presentation/ts/app.ts                               │ │
│  │  - Affichage du statut                              │ │
│  │  - Émission/réception Socket.io                      │ │
│  │  - Interface utilisateur (HTML/CSS/TypeScript)      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         APPLICATION                                    │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  AppService (core) - Cycle de vie                  │ │
│  │  - Détection automatique du module                  │ │
│  │  - Instanciation: createNommageService()            │ │
│  │  - Appel automatique: .start()                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         DOMAINE (MÉTIER)                              │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  domain/NommageService.ts                          │ │
│  │  - Parsing QUOI/OÙ                                 │ │
│  │  - Génération des structures taxonomiques         │ │
│  │  - Transmission au core                            │ │
│  │  ❌ NE CONNAÎT PAS: MQTT, HA, Socket.io, filesystem  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  domain/index.ts                                   │
│  - Déclaration du module (NOMMAGE_APP)               │
│  - Factory (createNommageService)                   │
│                                                                     │
│  domain/config-schema.ts                           │
│  - Schéma Zod de la configuration                   │
│                                                                     │
│  domain/socket-events.ts                           │
│  - Déclaration des événements Socket.io             │
│                                                                     │
│  domain/types.ts                                   │
│  - Types TypeScript spécifiques                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         COUCHE HA (INTÉGRATION)                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  ha/integration/nommage/NommageMqttIntegrationService.ts     │ │
│  │  - Client MQTT (mqtt@5.x)                           │ │
│  │  - Connexion/déconnexion automatique                │ │
│  │  - Abonnements aux topics de découverte             │ │
│  │  - Réception et forwarding des messages            │ │
│  │  ❌ NE MODIFIE PAS: Les messages (seulement écoute)│ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE                                  │
│  Utilisée depuis le core (applications/core/src/infrastructure/)       │
│  - ConfigService / ConfigLoader / ConfigWriter                       │
│  - Logger (Winston)                                                │
│  - IAppConfigProvider                                             │
│  - EventBus                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Flux de données interne

```
┌─────────────────────────┐     ┌─────────────────────────┐
│  NommageMqttIntegration  │────▶│      EventBus           │
│  Service                 │     │                         │
│  (ha/integration/nommage)│     │  Événement:              │
└─────────────────────────┘     │  nommage:discovery:raw   │
                                         │                         │
                                         ▼                         │
┌─────────────────────────┐     ┌─────────────────────────┐
│  NommageService         │◀────│  SocketBridge           │
│  (domain/NommageService) │     │  (core)                 │
│                         │     │  - Traduit EventBus →    │
│  - Parse QUOI/OÙ         │     │    Socket.io            │
│  - Génère structures     │     │  - Gère les clients     │
│  - Émet vers UI/core     │     └─────────────────────────┘
└─────────────────────────┘              │
                                          ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  UI (presentation/ts/app.ts)│◀────│  Socket.io             │
│  - Affiche le statut         │     │  (server.ts)           │
│  - Gère les interactions   │     └─────────────────────────┘
└─────────────────────────┘
```

### 2.3 Relations entre composants

```
┌─────────────────────────────────────────────────────────────────────┐
│  Composant                     │  Dépendances  │  Responsabilités     │
├─────────────────────────────────────────────────────────────────────┤
│  NommageMqttIntegrationService │ mqtt@5.x     │ Client MQTT         │
│  NommageService                │ EventBus     │ Parsing, logique    │
│  createNommageService          │ (factory)    │ Instanciation       │
│  NOMMAGE_APP                   │ -            │ Métadonnées module │
│  SocketService                 │ socket.io    │ Client Socket.io    │
│  AppService (core)             │ -            │ Cycle de vie        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Structure des Répertoires

```bash
applications/nommage/
├── package.json                    # Dépendances NPM (mqtt@5.x)
├── tsconfig.json                  # Configuration TypeScript
├── README.md                      # Documentation utilisateur
│
├── domain/                        # Couche Métier
│   ├── index.ts                   # ⭐ OBLIGATOIRE : Module + Factory
│   ├── NommageService.ts          # ⭐ OBLIGATOIRE : Service principal
│   ├── config-schema.ts           # Schéma Zod de configuration
│   ├── socket-events.ts           # Événements Socket.io
│   ├── types.ts                   # Types TypeScript
│   └── translations/              # ⭐ v1.5 — voir fonctionnelles-nommage_specs §3.7
│       └── TranslationsRepository.ts  # Chargement/génération des fichiers YAML de traduction
│
├── defaultconfig/                 # ⭐ v1.5 — Seeds versionnés (copiés dans dist/ au build)
│   ├── translate-france.yaml
│   └── translate-english.yaml
│
├── ha/                           # Couche HA (Intégration)
│   └── integration/
│       └── nommage/
│           └── NommageMqttIntegrationService.ts  # Client MQTT
│
└── presentation/                  # Couche Présentation
    ├── index.html                 # ⭐ OBLIGATOIRE : UI
    └── ts/
        └── app.ts                 # Logique frontend
```

**Fichiers obligatoires (selon [guide-nouvelle-application_specs_v1.6.md](./guide-nouvelle-application_specs_v1.6.md)) :**
- ✅ `domain/index.ts`
- ✅ `domain/NommageService.ts`
- ✅ `presentation/index.html`

---

## 4. Détails d'Implémentation

### 4.1 NommageMqttIntegrationService

> **⭐ v1.1** : Gère désormais **une connexion MQTT indépendante par source** (`config.sources[]`,
> voir `fonctionnelles-nommage_specs` §4.3), **toutes actives simultanément** — pas une seule
> connexion globale. Chaque source a son propre client `mqtt.MqttClient`, sa propre reconnexion,
> ses propres topics.

**Fichier :** `ha/integration/nommage/NommageMqttIntegrationService.ts`

**Rôle :** Gère **N clients MQTT** (un par source configurée) pour écouter les messages de
découverte en parallèle.

**Fonctionnalités :**
- Connexion/déconnexion **indépendante par source** (une source en échec n'affecte pas les autres)
- Abonnements aux topics de découverte propres à chaque source
- Réception et validation des messages, avec l'**identifiant de la source** d'origine
- Forwarding vers EventBus, `sourceId` inclus dans le payload

**Code clé :**
```typescript
// Une connexion MQTT par source, stockée dans une Map
private clients: Map<string, mqtt.MqttClient> = new Map();

private connectAllSources(): void {
  for (const source of this.config.sources) {
    this.connectSource(source);
  }
}

private connectSource(source: NommageSourceConfig): void {
  const options: mqtt.IClientOptions = {
    clientId: source.mqtt.clientId,
    keepalive: source.mqtt.keepalive,
    reconnectPeriod: source.mqtt.reconnectPeriod,
    clean: source.mqtt.cleanSession,
    username: source.mqtt.username,
    password: source.mqtt.password
  };

  const brokerUrl = `mqtt://${source.mqtt.host}:${source.mqtt.port}`;
  const client = mqtt.connect(brokerUrl, options);

  client.on('message', (topic, payload) => {
    if (this.isDiscoveryTopic(source, topic)) {
      this.processDiscoveryMessage(source.id, topic, payload);
    }
  });

  // Reconnexion gérée indépendamment par le client mqtt.js de cette source
  // (une source en erreur n'impacte pas les autres clients de la Map)

  this.clients.set(source.id, client);
}

// Validation du topic — relative à la source concernée
private isDiscoveryTopic(source: NommageSourceConfig, topic: string): boolean {
  const { topicPrefix, discoveryTopics } = source.mqtt;
  
  if (topicPrefix && !topic.startsWith(topicPrefix)) {
    return false;
  }
  
  return discoveryTopics.some(pattern => 
    this.topicMatchesPattern(topic, pattern)
  );
}

// Extraction du nom — le topic d'origine (préfixe non modifié) est conservé pour le passthrough
private processDiscoveryMessage(sourceId: string, topic: string, payload: Buffer): void {
  const message = JSON.parse(payload.toString());
  let rawName = message.name || message.raw_name || 
               message.device?.name || JSON.stringify(message);
  
  this.eventBus.emit('nommage:discovery:raw', {
    sourceId,        // ⭐ v1.1 — identifie la source d'origine
    rawName,
    topic,            // Topic source, préfixe non modifié (utilisé pour le passthrough, voir §5.3)
    payload: message,
    timestamp: new Date()
  });
}
```

**Dépendances :**
- `mqtt@5.x` (runtime)
- `@types/mqtt` (dev, optionnel)

### 4.2 NommageService

**Fichier :** `domain/NommageService.ts`

**Rôle :** Service métier - Parsing des noms et transmission au core.

**Fonctionnalités :**
- Écoute des messages bruts via EventBus
- Parsing selon QUOI---OÙ
- Génération des structures taxonomiques
- Transmission au core pour envoi à HA

**Code clé :**
```typescript
// Parsing QUOI/OÙ (basé sur nommage_specs_v1.0.md)
private parseDiscoveryName(rawName: string): ParsedTaxonomy | null {
  const separatorIndex = rawName.indexOf('---');
  
  const rawQuoi = separatorIndex === -1 
    ? rawName.trim() 
    : rawName.substring(0, separatorIndex).trim();
  
  const rawLieux = separatorIndex === -1 
    ? '' 
    : rawName.substring(separatorIndex + 3).trim();
  
  const slugQuoi = this.slugify(rawQuoi);
  const lieuxSegments = rawLieux ? rawLieux.split('--').map(s => s.trim()) : [];
  const N = lieuxSegments.length;
  
  // Distribution selon la matrice
  let nomPrecis, nomLieu, nomPere, nomGrandPere;
  
  if (N === 0) {
    nomLieu = undefined;
  } else if (N === 1) {
    nomLieu = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
  } else if (N === 2) {
    nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
    nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
  } else if (N === 3) {
    nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
    nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
    nomPere = { raw: lieuxSegments[2], slug: this.slugify(lieuxSegments[2]) };
  } else if (N >= 4) {
    nomPrecis = { raw: lieuxSegments[0], slug: this.slugify(lieuxSegments[0]) };
    nomLieu = { raw: lieuxSegments[1], slug: this.slugify(lieuxSegments[1]) };
    nomPere = { raw: lieuxSegments[2], slug: this.slugify(lieuxSegments[2]) };
    nomGrandPere = { raw: lieuxSegments[3], slug: this.slugify(lieuxSegments[3]) };
  }
  
  return {
    quoi: { raw: rawQuoi, slug: slugQuoi },
    ou: { precis: nomPrecis, lieu: nomLieu, pere: nomPere, grandPere: nomGrandPere },
    // ⭐ v1.2 — haAreaId/haAreaName/haEntityId sont purement informatifs (affichage UI) : HA crée
    // ses propres entity_id à partir du message source relayé tel quel (voir §5.3), NOMMAGE n'a
    // plus de "objectIdPrefix"/"defaultDomain" configurables depuis que le passthrough a remplacé
    // la reconstruction manuelle d'entité (v1.1).
    haAreaId: nomLieu?.slug,
    haAreaName: nomLieu?.raw,
    haEntityId: nomLieu
      ? `nommage_${slugQuoi}_${nomLieu.slug}`
      : `nommage_${slugQuoi}`,
    haAttributes: {
      attributs_taxonomie: {
        quoi: rawQuoi,
        slug_quoi: slugQuoi,
        lieu_precis: nomPrecis?.raw,
        slug_precis: nomPrecis?.slug,
        lieu_principal: nomLieu?.raw,
        slug_lieu: nomLieu?.slug,
        lieu_pere: nomPere?.raw,
        slug_pere: nomPere?.slug,
        lieu_grand_pere: nomGrandPere?.raw,
        slug_grand_pere: nomGrandPere?.slug
      }
    }
  };
}

// Normalisation slugify
private slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

// ⭐ v1.2 — Relais vers HA via le Passthrough MQTT du socle (§5.3). Remplace l'ancien
// transmitToCore/nommage:transmit:to-core : cet exemple de code n'avait jamais été mis à jour en
// v1.1 malgré le texte l'annonçant déjà obsolète — corrigé ici pour refléter le code réel.
// ⭐ v1.5 — Traduction du nom d'entité (TranslationsRepository, fonctionnelles-nommage_specs §3.7)
// AVANT le calcul de suggested_area, sur payload.name UNIQUEMENT si une correspondance existe
// (sinon payload n'est pas touché — un name absent côté source doit le rester).
private emitPassthroughDiscovery(discoveryMessage: DiscoveryMessage, parsed: ParsedTaxonomy): void {
  let payload: Record<string, unknown> = { ...discoveryMessage.payload };

  const objectId = discoveryMessage.topic.split('/').slice(-2, -1)[0];
  const translated = objectId ? this.entityNameTranslations[objectId] : undefined;
  if (translated !== undefined) {
    payload = { ...payload, name: translated };
  }

  // ... suggested_area (voir techniques-socle-ha-mqtt_specs §8.5.4), puis attributs_taxonomie
  // (topic dédié json_attributes_topic, pas fusionné dans payload — voir §8.5.4 v4.19) ...

  this.eventBus.emit('integration:nommage:passthrough:discovery', {
    bridgeInstance: 'main',        // ⭐ voir §5.3 — obligatoire, absent à tort de l'exemple v1.1
    sourceTopic: discoveryMessage.topic,
    payload
  });
}
```

**`entityNameTranslations`** (⭐ v1.5) : `Record<string, string>` chargé une fois au démarrage via
`TranslationsRepository.loadCountryTranslations(config.language.country)` (injecté au
constructeur, même principe que `mqttService` — `NommageService` reste sans accès filesystem
direct). Voir `fonctionnelles-nommage_specs` §3.7 pour le mécanisme complet (seeds versionnés,
copie runtime sans écrasement, génération à la volée pour un pays inconnu).

**Événements EventBus écoutés :**
- `nommage:discovery:raw` → Traitement des messages bruts
- `nommage:mqtt:status` → Mise à jour du statut MQTT
- `nommage:status:get` → Demande de statut depuis l'UI
- `nommage:taxonomy:get` → Demande de structure taxonomique
- `nommage:config:save` → Sauvegarde de la configuration (chemin historique, jamais déclenché par
  une UI réelle — voir §4.2.2)
- `app:module:config:saved` → ⭐ v1.4, voir §4.2.2 — chemin réellement emprunté par le formulaire
  générique "Paramètres du Module" du core

**Événements EventBus émis :**
- `nommage:discovery:parsed` → Message parsé avec succès (statut détaillé, voir §4.2.1)
- `nommage:taxonomy:structure` → Structure taxonomique complète
- `nommage:status` → Statut actuel (inclut désormais `sources[]`/`dailyCounts[]`, voir §4.2.1)
- `nommage:error` → Erreur interne
- `integration:bridge:register` / `:unregister` → Enregistrement du bridge auprès du socle (§5.3)
- `integration:nommage:passthrough:discovery` → Relais enrichi vers HA (remplace `nommage:transmit:to-core`, retiré en v1.1)

### 4.2.1 Statistiques du tableau de bord — ⭐ NOUVEAU v1.2

**Statut par connexion :** `NommageMqttIntegrationService.getSourceStatuses()` retourne, pour
chaque source configurée, `{ id, connected }` en croisant `config.sources` avec l'ensemble des
sourceId actuellement connectés. Appelé par `NommageService` à chaque émission de `nommage:status`.

**Entrées traitées par jour (5 jours glissants) :** `NommageService` maintient une
`Map<string, number>` (clé `"AAAA-MM-JJ"`, heure locale du serveur), incrémentée à chaque parsing
réussi (`recordProcessedEntry`). Une purge supprime les clés plus anciennes que la fenêtre à chaque
incrément (évite une croissance illimitée sur un processus longue durée). `getDailyCountsLastDays()`
reconstruit toujours exactement 5 entrées (0 pour les jours sans activité), du plus ancien au plus
récent :

```typescript
private getDailyCountsLastDays(): DailyCount[] {
  const result: DailyCount[] = [];
  const today = new Date();

  for (let i = DAILY_STATS_WINDOW_DAYS - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    const key = this.toIsoDate(day);
    result.push({ date: key, count: this.dailyCounts.get(key) || 0 });
  }

  return result;
}
```

> ⚠️ Comme `parsedMessagesCount` et `taxonomyStructures`, ces compteurs sont **en mémoire** : ils
> repartent à zéro à chaque redémarrage de l'application (pas de persistance sur disque).

### 4.2.2 ⭐ Reconnexion MQTT sur sauvegarde via le formulaire générique (v1.4)

**Constat** : NOMMAGE n'a pas de page de configuration dédiée (`config.html`/`config-app.ts`) — il
utilise le formulaire générique "Paramètres du Module" du core (§4.4). Ce formulaire sauvegarde via
`app:modules:config:save` → `AppService.handleModuleConfigSave()` → `ConfigService.saveModuleConfig()`,
qui **valide et écrit sur disque uniquement** — rien n'émettait jamais `nommage:config:save`, le
seul événement historiquement écouté par `saveConfig()` pour déclencher la reconnexion MQTT (§4.2,
liste des événements écoutés). Résultat : les connexions MQTT en cours continuaient de tourner avec
les anciens paramètres jusqu'au redémarrage complet de l'application.

**Correctif** : nouveau listener sur `app:module:config:saved` (déjà émis par
`AppService.handleModuleConfigSave`, jusque-là jamais consommé par NOMMAGE) — filtre sur
`moduleId === 'nommage' && success`, puis appelle `reloadConfigAndReconnectMqtt()`, une méthode
factorisée hors de `saveConfig()` (recharge la config depuis le provider, recalcule
`discoveryTopics`, déconnecte/reconnecte `mqttService`) — réutilisée par les deux chemins
(`nommage:config:save` historique et `app:module:config:saved` réel).

```typescript
this.eventBus.on('app:module:config:saved', (data: unknown) => {
  const result = data as { moduleId: string; success: boolean };
  if (result.moduleId !== 'nommage' || !result.success) return;
  this.reloadConfigAndReconnectMqtt().catch((error) => {
    this.logger.error('NommageService', `Erreur lors de la reconnexion après sauvegarde: ${error}`);
  });
});
```

**Piège apparenté découvert en vérifiant ce correctif en direct, sans rapport avec NOMMAGE
lui-même** : `AppService.registerCoreSocketEvents()` enregistrait ses événements client→serveur
(dont `app:modules:config:save`) en double auprès de `SocketBridge` — chaque sauvegarde déclenchait
donc deux fois cette reconnexion. Corrigé au niveau du socle, voir `techniques-socle-ha-mqtt_specs`
§5.4.3.

### 4.3 Déclaration du Module

**Fichier :** `domain/index.ts`

**Rôle :** Point d'entrée pour la détection automatique par AppService.

**Contenu obligatoire :**
```typescript
// 1. Déclaration du module
export const NOMMAGE_APP: ApplicationModule = {
  id: 'nommage',              // ⭐ Doit correspondre au nom du répertoire
  name: 'NOMMAGE',
  description: '...',
  icon: '🏷️',
  type: 'integration',        // ⭐ Application d'intégration
  configurable: true,
  requiredMqtt: true,        // ⭐ Nécessite MQTT
  requiredHaWs: false,
  configSection: 'nommage',
  socketEvents: NOMMAGE_SOCKET_EVENTS
};

// 2. Factory du service
export function createNommageService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<NommageConfig>
): INommageService {
  const mqttService = NommageMqttIntegrationService.create(
    eventBus, logger, configProvider
  );
  
  return NommageService.create(
    eventBus, logger, configProvider, mqttService
  );
}

// 3. Ré-export des composants
export * from './NommageService';
export * from './config-schema';
export * from './socket-events';
export * from './types';
export * from '../ha/integration/nommage/NommageMqttIntegrationService';
```

### 4.4 UI (Présentation)

**Fichier :** `presentation/index.html` et `presentation/ts/app.ts`

**Rôle :** Interface utilisateur minimale pour visualiser le statut.

**Fonctionnalités :**
- Connexion Socket.io au serveur
- Affichage du statut (Application + MQTT)
- ⭐ **v1.2** — Statut par connexion (`status.sources[]` — voir §4.2.1)
- ⭐ **v1.2** — Entrées traitées par jour, 5 jours glissants (`status.dailyCounts[]` — voir §4.2.1)
- Liste des topics de découverte
- Compteur des messages parsés
- Date du dernier parsing
- Boutons d'action (rafraîchir, tester)

**Code clé (app.ts) :**
```typescript
// Import depuis le point d'entrée UI navigateur du core (jamais exports.ts, voir
// techniques-socle-ha-mqtt_specs §4.2.1). SocketService n'est pas un singleton : new, pas getInstance().
import { SocketService } from '../../../../core/src/ui-exports';

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();
  setupEventListeners();
  requestInitialStatus();
  hideLoading();
}

// Événements Socket.io
socket.on('nommage:status', (status: NommageStatus) => {
  updateStatusDisplay(status);
  updateSourcesDisplay(status.sources);      // ⭐ v1.2
  updateDailyStatsDisplay(status.dailyCounts); // ⭐ v1.2
});
socket.on('nommage:discovery:parsed', (data) => {
  updateParsedMessagesCounter();
  updateLastParsedDisplay(data.timestamp);
});
socket.on('nommage:error', showError);
```

---

## 5. Intégration avec le Socle

### 5.1 Détection Automatique

**Processus (AppService dans le core) :**
1. Scan des répertoires `applications/` et `dist/applications/`
2. Détection de `applications/nommage/domain/index.ts`
3. Vérification de l'export `NOMMAGE_APP`
4. Vérification de l'export `createNommageService`
5. Instanciation via la factory
6. Appel automatique de `.start()`

**Condition pour être détectée :**
- ✅ Répertoire dans `applications/`
- ✅ Contient `domain/index.ts`
- ✅ Exporte `NOMMAGE_APP: ApplicationModule`
- ✅ Exporte `createNommageService` (factory)
- ✅ `id` correspond au nom du répertoire

### 5.2 Cycle de Vie

```
AppService.detectApplicationModules()
    │
    ▼
Module "nommage" détecté
    │
    ▼
Recherche factory: createNommageService
    │
    ▼
Instanciation: new NommageService(eventBus, logger, configProvider)
    │
    ▼
Connexion MQTT — **une par source configurée**, en parallèle (`NommageMqttIntegrationService`)
    │
    ▼
Abonnement aux topics de découverte de chaque source
    │
    ▼
Appel: .start()
    │
    ▼
✅ Service démarré - Prêt à écouter (toutes les sources actives)
```

### 5.3 Communication avec le Core — Passthrough MQTT

> **⭐ v1.1** : Remplace intégralement l'ancien mécanisme `nommage:transmit:to-core` (qui
> reconstruisait un message HA complet et appelait l'API WebSocket pour créer les Areas).
> NOMMAGE utilise désormais le **Passthrough MQTT** du socle
> ([`techniques-socle-ha-mqtt_specs` §8.5.6](techniques-socle-ha-mqtt_specs_v4.12.md#856-passthrough-mqtt)).

> **⚠️ v1.2** : `bridgeInstance` est **obligatoire** dans l'événement (absent à tort de l'exemple
> v1.1) — le socle route le passthrough par bridge_instance, pas seulement par module (voir
> `techniques-socle-ha-mqtt_specs` §8.5.1). NOMMAGE doit d'abord **s'enregistrer** auprès du socle
> avant de pouvoir publier :
> ```typescript
> // Au démarrage (NommageService.start())
> this.eventBus.emit('integration:bridge:register', { moduleName: 'nommage', bridgeInstance: 'main' });
> // À l'arrêt (NommageService.stop())
> this.eventBus.emit('integration:bridge:unregister', { moduleName: 'nommage', bridgeInstance: 'main' });
> ```
> NOMMAGE utilise un seul `bridgeInstance` fixe (`'main'`) pour sa connexion **sortante** vers le
> broker HA du socle — à ne pas confondre avec les N sources MQTT **entrantes** (§4.1), qui sont
> des connexions de lecture indépendantes gérées par `NommageMqttIntegrationService`.

**Événement émis par NOMMAGE (`integration:nommage:passthrough:discovery`) :**
```typescript
// Émis par NommageService après parsing + enrichissement
type PassthroughDiscoveryEvent = {
  bridgeInstance: string; // ⭐ v1.2 — obligatoire, ex: "main" (voir encadré ci-dessus)
  sourceTopic: string;    // Topic d'origine, préfixe non modifié (ex: "homeassist/sensor/x/config")
  payload: Record<string, unknown>;  // Payload source + attributs_taxonomie injectés
};

this.eventBus.emit('integration:nommage:passthrough:discovery', {
  bridgeInstance: 'main',
  sourceTopic: discoveryMessage.topic,
  payload: {
    ...discoveryMessage.payload,
    attributs_taxonomie: parsedTaxonomy.haAttributes.attributs_taxonomie
  }
} satisfies PassthroughDiscoveryEvent);
```

**Traitement dans le core** (`IntegrationBridge`/`HaMqttIntegrationService`, générique à toutes les
applications utilisant le passthrough — pas de code spécifique à NOMMAGE dans le core) :
```typescript
// IntegrationBridge : un seul abonnement dynamique par module enregistré, pas de nom d'appli en dur
this.eventBus.onGeneric<PassthroughDiscoveryRequestEvent>(
  `integration:${moduleName}:passthrough:discovery`,
  (data) => {
    if (!this.mqttEnabled) return;
    this.haMqttService.publishDiscoveryPassthrough(moduleName, data.bridgeInstance, data.sourceTopic, data.payload);
  }
);

// HaMqttIntegrationService.publishDiscoveryPassthrough : réécrit le préfixe puis publie
// sur la connexion MQTT du bridge_instance concerné (QoS 1, retain true)
publishDiscoveryPassthrough(moduleName: string, bridgeInstance: string, sourceTopic: string, payload: unknown): void {
  const transport = this.getTransport(moduleName, bridgeInstance);
  const targetTopic = rewriteToHomeAssistantPrefix(sourceTopic); // remplace le 1er segment par "homeassistant"
  transport.publish(targetTopic, JSON.stringify(payload), 1, true);
}
```

> ⚠️ **Ce que ce flux NE fait PAS** (erreur à ne pas reproduire) :
> - Il **n'appelle jamais** l'API WebSocket HA pour créer une Area — c'est HA lui-même qui crée
>   l'Area (via ses propres automatisations MQTT lisant `attributs_taxonomie`/`suggested_area`,
>   voir `nommage_specs` §6), pas le socle ni NOMMAGE.
> - Il **ne met jamais à jour `HaStructureRegistry`** — le référentiel structuré n'est alimenté
>   que par la connexion HA WebSocket native (Mode A), indépendamment de tout message MQTT. Voir
>   `fonctionnelles-nommage_specs` §6.2 pour le détail de cette indépendance : NOMMAGE ne
>   nécessite que `ha.mqtt_enable`, jamais `ha.ws_enable`, et fonctionne à l'identique que le
>   référentiel existe ou non.

### 5.4 Enregistrement des Événements Persistants

**À appeler lors du démarrage :**
```typescript
// Dans createNommageService
registerPersistentEvents(eventBus);

// Fonction d'enregistrement
export function registerPersistentEvents(eventBus: IEventBus): void {
  eventBus.emit('app:socket-events:registered', {
    appId: 'nommage',
    socketEvents: NOMMAGE_SOCKET_EVENTS,
    persistentEvents: NOMMAGE_PERSISTENT_EVENTS
  });
}
```

**Événements persistants (envoyés automatiquement aux nouveaux clients) :**
- `nommage:status` - Statut actuel de l'application
- `nommage:taxonomy:structure` - Structure taxonomique complète

---

## 6. Configuration Technique

### 6.1 package.json

```json
{
  "name": "nommage",
  "version": "1.0.0",
  "description": "Application de gestion des conventions de nommage...",
  "main": "dist/domain/index.js",
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w"
  },
  "dependencies": {
    "mqtt": "^5.0.0"
  },
  "devDependencies": {
    "@types/mqtt": "^2.0.0",
    "typescript": "^5.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 6.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "../../dist/applications/nommage",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "../../../../*": ["../../core/src/*"],
      "../../../../types/*": ["../../core/src/types/*"],
      "../../../../application/*": ["../../core/src/application/*"],
      "../../../../infrastructure/*": ["../../core/src/infrastructure/*"],
      "../../../../ha/*": ["../../core/src/ha/*"]
    },
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": [
    "domain/**/*",
    "ha/**/*",
    "presentation/ts/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

**Points clés :**
- `outDir` pointe vers `../../dist/applications/nommage` (structure du core)
- `paths` permet de résoudre les imports vers le core
- `strict: true` pour le typage fort

### 6.3 Configuration YAML

**Fichier :** `data/nommage/config.yaml` (objet nu, ex-section `nommage` de l'ancien fichier
unique — voir `techniques-socle-ha-mqtt_specs` §7)

```yaml
enabled: true

# ⭐ v1.1 — sources[] remplace mqtt (objet unique) : toutes connectées simultanément
sources:
  - id: "ha-broker"
    mqtt:
      host: "localhost"
      port: 1883
      clientId: "nommage-ha-broker"
      discoveryTopics:
        - "ha/+/+/config"
      topicPrefix: "ha/"
      qos: 1
      retain: true

  - id: "zigbee2mqtt"
    mqtt:
      host: "localhost"
      port: 1883
      clientId: "nommage-zigbee2mqtt"
      discoveryTopics:
        - "homeassist/+/+/config"
      topicPrefix: "homeassist/"
      qos: 1
      retain: true

ha:
  injectTaxonomyAttributes: true
  waitForHaWsBeforeDiscovery: true

logging:
  level: "info"
  showRawMessages: false
  showParsedMessages: false

# ⭐ v1.5 — voir fonctionnelles-nommage_specs §3.7
language:
  country: "France"
```

---

## 7. Tests et Validation

### 7.1 Validation du Code

```bash
# Vérifier la compilation TypeScript
cd /chemin/vers/dimotic-ha
npm run build

# Vérifier les erreurs TypeScript
npx tsc --noEmit --project applications/nommage/tsconfig.json

# Lancer en mode développement (watch)
cd applications/nommage
npm run watch
```

### 7.2 Tests Manuels

**Test 1 : Démarrage de l'application**
```bash
# Déplacer l'application vers activées
mv applications_desactivees/nommage applications/

# Redémarrer l'application
docker-compose restart

# Vérifier les logs
tail -f logs/app.log | grep -i nommage
```

**Attendu :**
```
[INFO] [AppService] Détection du module "nommage"
[INFO] [NommageMqttIntegrationService] Tentative de connexion MQTT...
[INFO] [NommageMqttIntegrationService] Connecté au broker MQTT
[INFO] [NommageService] Service démarré avec succès
[INFO] [NommageService] Topics de découverte: ha/+/+/config,homeassistant/+/+/config
```

**Test 2 : Parsing d'un message**
```bash
# Publier un message de test sur MQTT
mosquitto_pub -h localhost -t "ha/sensor/temperature/config" -m '{
  "name": "Température---Capteur Fenêtre--Salon--Rez-de-Chaussée",
  "unique_id": "test_temperature_001",
  "device_class": "temperature"
}'
```

**Attendu (dans les logs) :**
```
[DEBUG] [NommageMqttIntegrationService] Message MQTT reçu - Topic: ha/sensor/temperature/config
[INFO] [NommageService] Message parsed: QUOI="Température" | LIEU="Salon"
```

**Test 3 : Vérification de l'UI**
```bash
# Ouvrir l'UI dans un navigateur
firefox http://localhost:8080/applications/nommage/presentation/index.html
```

**Attendu :**
- Statut : Application = Connecté, MQTT = Connecté
- Topics de découverte affichés
- Compteur de messages parsés incrémenté

### 7.3 Checklist avant déploiement

- [ ] `npm run build` passe sans erreur
- [ ] Tous les fichiers obligatoires sont présents
- [ ] `NOMMAGE_APP.id === 'nommage'` (correspond au répertoire)
- [ ] Configuration MQTT valide dans `data/nommage/config.yaml`
- [ ] Le broker MQTT est accessible
- [ ] Le core écoute `nommage:transmit:to-core`
- [ ] Les dépendances (`mqtt@5.x`) sont installées
- [ ] L'UI est accessible via `/applications/nommage/presentation/index.html`

---

## 8. Dépannage

### 8.1 Erreurs Courantes

| Erreur | Cause | Solution |
|--------|-------|----------|
| `Module not found: mqtt` | Dépendance manquante | `pnpm add mqtt@5.x` |
| `Cannot find name 'mqtt'` | @types/mqtt manquant | `pnpm add -D @types/mqtt` |
| `No connection to MQTT broker` | Broker inaccessible | Vérifier host/port/firewall |
| `Invalid topic pattern` | Pattern MQTT invalide | Utiliser `+` ou `#` correctement |
| `Parsing failed: no '---'` | Format de nom invalide | Vérifier le format des messages |

### 8.2 Logs de Débogage

**Activer le mode debug :**
```yaml
nommage:
  logging:
    level: debug
    showRawMessages: true
    showParsedMessages: true
```

**Exemple de logs :**
```
[DEBUG] [NommageMqttIntegrationService] Message MQTT reçu - Topic: ha/sensor/temp/config
[DEBUG] [NommageMqttIntegrationService] Message de découverte brut: Température---Salon
[DEBUG] [NommageService] Message brut reçu: Température---Salon
[INFO] [NommageService] Message parsed: QUOI="Température" | LIEU="Salon"
[DEBUG] [NommageService] Parsed: {"quoi":{"raw":"Température","slug":"temperature"},"ou":{"lieu":{"raw":"Salon","slug":"salon"}}}
```

### 8.3 Vérification de la Connexion MQTT

```bash
# Vérifier que le client MQTT est connecté
mosquitto_sub -h localhost -t "#" -v

# Vérifier les abonnements
mosquitto_sub -h localhost -t "$SYS/broker/subscriptions" -v
```

---

## 📚 Références

- [fonctionnelles-nommage_specs_v1.2.md](./fonctionnelles-nommage_specs_v1.2.md) - Spécifications fonctionnelles
- [techniques-socle-ha-mqtt_specs_v4.12.md](./techniques-socle-ha-mqtt_specs_v4.12.md) - Socle technique
- [guide-nouvelle-application_specs_v1.6.md](./guide-nouvelle-application_specs_v1.6.md) - Guide de création
- [nommage_specs_v1.0.md](./nommage_specs_v1.0.md) - Protocole de nommage
- [PROMPT_PROJET.md](../PROMPT_PROJET.md) - Règles générales

---

## 📅 Historique des Versions

| Version | Date | Auteur | Changements |
|---------|------|--------|-------------|
| **1.4** | 04/08/2026 | Claude | **Reconnexion MQTT sur sauvegarde via le formulaire générique** (§4.2.2) — `app:module:config:saved` écouté en plus de `nommage:config:save`. Correction `ws-ha`→`dimotic-ha` (§7.1). Ancienne version v1.3 archivée. |
| **1.3** | 24/07/2026 | Claude | *(Historique non détaillé dans ce tableau au moment de la rédaction — voir `specs/archives/implementation-nommage_specs_v1.3.md` pour le contenu complet de cette version.)* |
| **1.2** | 21/07/2026 | Claude | **Correction** : le code v1.1 ne connectait/traitait en réalité que `couples[0]` malgré le texte — `NommageMqttIntegrationService` gère désormais réellement une `Map<sourceId, MqttClient>` (§4.1). Exemples de code §4.2/§5.3 réalignés sur le Passthrough MQTT réel (`bridgeInstance` obligatoire, absent à tort en v1.1). **Nouveau** : statut par connexion et entrées traitées par jour sur 5 jours glissants (§4.2.1, `NommageStatus.sources[]`/`.dailyCounts[]`). |
| **1.1** | 21/07/2026 | Claude | `NommageMqttIntegrationService` gère N connexions simultanées (une par source), transmission via Passthrough MQTT du socle (remplace `nommage:transmit:to-core`), correction : le référentiel HA n'est jamais mis à jour depuis MQTT, NOMMAGE ne dépend que de `ha.mqtt_enable` |
| **1.0** | 19/07/2026 | Mistral Vibe | Version initiale : Implémentation complète selon specs |

---

*Document généré par Mistral Vibe*
*Co-Authored-By: Mistral Vibe <vibe@mistral.ai>*


---

## 9. Communication Inter-Applications

> **⚠️ IMPORTANT :** Cette section documente les événements et capacités que cette application **expose** aux autres applications.
> 
> **Pour utiliser ces capacités :**
> - Import depuis le core : `import { InterAppClient } from '../../../core/src/exports'`
> - Utiliser `interAppClient.request()` pour les Request/Reply
> - Utiliser `interAppClient.on()` pour écouter les événements Fire & Forget
> - Voir [inter-app-communication_specs_v1.0.md](../inter-app-communication_specs_v1.0.md) pour les détails

### 9.1 Événements Fire & Forget (Écoute possible par d'autres applications)

| Événement | Description | Payload Type | Fréquence | Émetteur |
|-----------|-------------|--------------|-----------|----------|
| `nommage:mqtt:message:received` | Message MQTT reçu pour traitement | `NommageMqttMessageReceivedPayload` | Selon messages MQTT | nommage |
| `nommage:mqtt:message:processed` | Message MQTT traité avec succès | `NommageMqttMessageProcessedPayload` | Sur traitement | nommage |
| `nommage:mqtt:message:failed` | Échec de traitement d'un message MQTT | `NommageMqttMessageFailedPayload` | Sur échec | nommage |
| `nommage:rule:matched` | Une règle de nommage a été appliquée | `NommageRuleMatchedPayload` | Sur matching | nommage |
| `nommage:rule:applied` | Une règle a été appliquée à une entité | `NommageRuleAppliedPayload` | Sur application | nommage |
| `nommage:ha:discovery:published` | Publication de découverte HA | `NommageHaDiscoveryPublishedPayload` | Sur découverte | nommage |

**Types des payloads :**
```typescript
// NommageMqttMessageReceivedPayload
export interface NommageMqttMessageReceivedPayload {
  topic: string;
  message: string;
  qos: number;
  retain: boolean;
  timestamp: string;
}

// NommageMqttMessageProcessedPayload
export interface NommageMqttMessageProcessedPayload {
  topic: string;
  originalMessage: string;
  processedName: string;
  entityId: string;
  quoi: string;
  ou: string;
  timestamp: string;
}

// NommageMqttMessageFailedPayload
export interface NommageMqttMessageFailedPayload {
  topic: string;
  message: string;
  error: string;
  timestamp: string;
}

// NommageRuleMatchedPayload
export interface NommageRuleMatchedPayload {
  ruleName: string;
  ruleType: 'quoi' | 'ou' | 'format' | 'validation';
  input: string;
  matchResult: Record<string, string>;
  timestamp: string;
}

// NommageRuleAppliedPayload
export interface NommageRuleAppliedPayload {
  ruleName: string;
  entityId: string;
  originalName: string;
  transformedName: string;
  transformations: string[];
  timestamp: string;
}

// NommageHaDiscoveryPublishedPayload
export interface NommageHaDiscoveryPublishedPayload {
  entityId: string;
  name: string;
  domain: string;
  device?: {
    identifiers: string[];
    name: string;
    manufacturer: string;
    model: string;
  };
  timestamp: string;
}
```

**Exemple d'écoute depuis une autre application :**
```typescript
import { InterAppClient } from '../../../core/src/exports';

// Écouter les messages MQTT reçus
this.interAppClient.on('nommage:mqtt:message:received', (payload, fromApp) => {
  console.log(`Message MQTT reçu par ${fromApp}: ${payload.topic}`);
});

// Écouter les traitements réussis
this.interAppClient.on('nommage:mqtt:message:processed', (payload, fromApp) => {
  console.log(`Message traité: ${payload.originalMessage} → ${payload.processedName}`);
});

// Écouter les applications de règles
this.interAppClient.on('nommage:rule:applied', (payload, fromApp) => {
  console.log(`Règle "${payload.ruleName}" appliquée à ${payload.entityId}`);
});

// Écouter les publications de découverte HA
this.interAppClient.on('nommage:ha:discovery:published', (payload, fromApp) => {
  console.log(`Découverte HA publiée: ${payload.entityId} (${payload.name})`);
});
```

### 9.2 Capacités Request/Reply (Appel possible depuis d'autres applications)

| Capacité | Description | Request Type | Reply Type | Timeout conseillé |
|----------|-------------|--------------|------------|-------------------|
| `nommage:mqtt:process` | Traiter un message MQTT | `NommageMqttProcessRequest` | `NommageMqttProcessReply` | 2000ms |
| `nommage:rule:test` | Tester une règle sur un nom | `NommageRuleTestRequest` | `NommageRuleTestReply` | 1000ms |
| `nommage:rule:list` | Lister les règles de nommage chargées | `NommageRuleListRequest` | `NommageRuleListReply` | 500ms |
| `nommage:rule:reload` | Recharger les règles de nommage | `NommageRuleReloadRequest` | `NommageRuleReloadReply` | 2000ms |
| `nommage:ha:publish` | Publier une entité vers HA | `NommageHaPublishRequest` | `NommageHaPublishReply` | 3000ms |
| `nommage:ha:remove` | Supprimer une entité de HA | `NommageHaRemoveRequest` | `NommageHaRemoveReply` | 2000ms |

**Types :**
```typescript
// Request/Reply pour mqtt:process
interface NommageMqttProcessRequest {
  topic: string;
  payload: string | Record<string, unknown>;
  qos?: number;
  retain?: boolean;
}

interface NommageMqttProcessReply {
  success: boolean;
  entityId: string;
  normalizedName: string;
  quoi: string;
  ou: string;
  haDiscoveryPublished?: boolean;
  error?: string;
}

// Request/Reply pour rule:test
interface NommageRuleTestRequest {
  ruleName: string;
  input: string;
}

interface NommageRuleTestReply {
  matched: boolean;
  result: Record<string, string>;
  transformations?: string[];
  error?: string;
}

// Request/Reply pour rule:list
interface NommageRuleListRequest {}

interface NommageRuleListReply {
  rules: {
    name: string;
    type: 'quoi' | 'ou' | 'format' | 'validation';
    pattern: string;
    description: string;
    enabled: boolean;
    priority: number;
  }[];
}

// Request/Reply pour rule:reload
interface NommageRuleReloadRequest {
  ruleNames?: string[]; // Optionnel: recharger seulement certaines règles
}

interface NommageRuleReloadReply {
  success: boolean;
  reloadedRules: string[];
  errors: { ruleName: string; error: string }[];
}

// Request/Reply pour ha:publish
interface NommageHaPublishRequest {
  entityId: string;
  name: string;
  domain: string;
  deviceInfo?: {
    identifiers: string[];
    name: string;
    manufacturer: string;
    model: string;
  };
  overrideName?: string; // Forcer un nom spécifique
}

interface NommageHaPublishReply {
  success: boolean;
  entityId: string;
  publishedName: string;
  discoveryTopic?: string;
  error?: string;
}

// Request/Reply pour ha:remove
interface NommageHaRemoveRequest {
  entityId: string;
  force?: boolean; // Forcer la suppression même si des dépendances existent
}

interface NommageHaRemoveReply {
  success: boolean;
  entityId: string;
  removedFromHa: boolean;
  removedFromRegistry: boolean;
  error?: string;
}
```

**Exemple d'appel depuis une autre application :**
```typescript
import { InterAppClient } from '../../../core/src/exports';
import type {
  NommageMqttProcessRequest,
  NommageMqttProcessReply,
  NommageRuleTestRequest,
  NommageRuleTestReply,
  NommageRuleListRequest,
  NommageRuleListReply,
  NommageHaPublishRequest,
  NommageHaPublishReply
} from '../nommage/specs';

// Traiter un message MQTT
const processReply = await interAppClient.request<
  NommageMqttProcessRequest,
  NommageMqttProcessReply
>(
  'nommage:mqtt:process',
  {
    topic: 'zigbee2mqtt/sensor_temperature_salon',
    payload: JSON.stringify({ temperature: 22.5 })
  },
  2000
);

if (processReply.status === 'success') {
  console.log(`Message traité: entité ${processReply.result.entityId} créée`);
  console.log(`  Nom normalisé: ${processReply.result.normalizedName}`);
}

// Tester une règle
const testReply = await interAppClient.request<
  NommageRuleTestRequest,
  NommageRuleTestReply
>(
  'nommage:rule:test',
  { ruleName: 'température_rule', input: 'température--salon' },
  1000
);

if (testReply.status === 'success') {
  console.log(`Règle correspond: ${testReply.result.matched}`);
  console.log(`Résultat:`, testReply.result.result);
}

// Lister les règles
const listReply = await interAppClient.request<
  NommageRuleListRequest,
  NommageRuleListReply
>(
  'nommage:rule:list',
  {},
  500
);

if (listReply.status === 'success') {
  console.log(`Règles chargées (${listReply.result.rules.length}):`);
  listReply.result.rules.forEach(r => console.log(`  - ${r.name} (${r.type})`));
}

// Publier une entité vers HA
const publishReply = await interAppClient.request<
  NommageHaPublishRequest,
  NommageHaPublishReply
>(
  'nommage:ha:publish',
  {
    entityId: 'sensor_temperature_salon',
    name: 'température--salon--maison',
    domain: 'sensor',
    deviceInfo: {
      identifiers: ['zigbee2mqtt_sensor_temperature_salon'],
      name: 'Capteur Température Salon',
      manufacturer: 'Aqara',
      model: 'WSDCGQ11LM'
    }
  },
  3000
);

if (publishReply.status === 'success') {
  console.log(`Entité publiée: ${publishReply.result.publishedName}`);
}
```

**Handler côté récepteur (dans l'application NOMMAGE) :**
```typescript
import { InterAppClient } from '../../../core/src/exports';

// Exemple: handler pour nommage:mqtt:process
this.interAppClient.onRequest('nommage:mqtt:process', async (request, reply) => {
  try {
    const result = await processMqttMessage(request.payload);
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'error',
      error: {
        code: 'NOMMAGE_MQTT_PROCESS_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Exemple: handler pour nommage:rule:test
this.interAppClient.onRequest('nommage:rule:test', async (request, reply) => {
  try {
    const result = await testRule(request.payload);
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'error',
      error: {
        code: 'NOMMAGE_RULE_TEST_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Exemple: handler pour nommage:rule:list
this.interAppClient.onRequest('nommage:rule:list', async (request, reply) => {
  try {
    const rules = await getAllRules();
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'success',
      result: { rules },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'error',
      error: {
        code: 'NOMMAGE_RULE_LIST_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Exemple: handler pour nommage:ha:publish
this.interAppClient.onRequest('nommage:ha:publish', async (request, reply) => {
  try {
    const result = await publishToHa(request.payload);
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'success',
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    reply({
      requestId: request.requestId,
      inReplyTo: request.requestId,
      fromApp: 'nommage',
      status: 'error',
      error: {
        code: 'NOMMAGE_HA_PUBLISH_ERROR',
        message: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});
```

*Document généré par Mistral Vibe*  
*Co-Authored-By: Mistral Vibe <vibe@mistral.ai>*
