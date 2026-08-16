// =============================================================================
// CORE EXPORTS - Point d'entrée unique pour les applications
// =============================================================================
// Ce fichier centralise tous les exports du core pour faciliter les imports
// par les applications dérivées.
//
// Conforme à specs-techniques-socle-ha-mqtt-v4.6.md (architecture 5 couches)
// et guide-nouvelle-application_specs_v1.0.md
//
// Usage pour les applications :
//   import { EventBus, Logger, HaStructureRegistry, AppConfig } from './exports';
// ou
//   import * as Core from './exports';
// =============================================================================

// =============================================================================
// 1. TYPES PRINCIPAUX
// =============================================================================

// Types de configuration (sans ApplicationModule qui est aussi dans events.ts)
export type {
  AppConfig,
  ConfigField,
  ConfigFieldGroup,
  ModuleUiMetadata,
  ConfigSaveResult,
  ValidationStatus,
  ValidationError,
  ValidationWarning,
  ConfigValidationResult,
  HaWsConfig,
  HaStructureConfig,
  HaConfig,
  MqttConfig,
  WebConfig,
  LogRotateConfig,
  LoggingConfig,
} from './types/config';

// Schémas Zod
export {
  haWsSchema,
  haStructureSchema,
  haConfigSchema,
  mqttSchema,
  webSchema,
  loggingSchema,
} from './infrastructure/config/schema';

// Types d'événements (EventBus et Socket.io)
// Note: ApplicationModule est exporté ici et aussi dans config.ts - on prend celui de events.ts
export type {
  AppStatus,
  LogEntry,
  LogsGetParams,
  ConfigSaveResult as ConfigSaveResultFromEvents,
  ServerToClientEvents,
  ClientToServerEvents,
  AppEvents,
  SocleSocketEvents,
  SocketServer,
  SocketClient,
  InterServerEvents,
  SocketData,
  ApplicationModule,
} from './types/events';

// Constante des événements socle
export { SOCLE_SOCKET_EVENTS } from './types/events';

// Types d'erreurs
export * from './types/errors';

// =============================================================================
// 2. COUCHE APPLICATION
// =============================================================================

// EventBus - Canal de communication principal
export {
  EventBus,
  getGlobalEventBus,
  resetGlobalEventBus,
  ExtendedEventBus,
  createExtendedEventBus,
} from './application/EventBus';

// Interface EventBus
export type { IEventBus, DefaultAppEvents } from './application/IEventBus';

// MqttEventBus - Implémentation de IEventBus backée par MQTT (fonctionnelles-supervisor_specs v2.4 §6.3)
export { MqttEventBus } from './application/MqttEventBus';
export type { MqttEventBusConfig, MqttEventBusBrokerConfig } from './application/MqttEventBus';

// Superviseur multi-process (fonctionnelles-supervisor_specs v2.4 §3/§5/§6.3/§8.4)
export * from './supervisor';

// SocketBridge - Pont entre EventBus et Socket.io
export { SocketBridge } from './application/SocketBridge';

// RestartManager - Gestion du redémarrage propre
export { RestartManager } from './application/RestartManager';

// AppService - Service principal de coordination
export { AppService } from './application/AppService';

// ApplicationManager - Gestion dynamique des modules
export { ApplicationManager } from './application/ApplicationManager';

// =============================================================================
// 3. COUCHE INFRASTRUCTURE
// =============================================================================

// Configuration
export { ConfigLoader } from './infrastructure/config/loader';
export { ConfigWriter } from './infrastructure/config/writer';
export { ConfigService } from './infrastructure/config/ConfigService';
export { AppConfigProvider, createAppConfigProvider } from './infrastructure/config/AppConfigProvider';
export type { IAppConfigProvider } from './infrastructure/config/IAppConfigProvider';

// Logger
export {
  Logger,
  LoggerConfig,
  LogEntry as LoggerLogEntry,
  createLogger,
  getLogger,
  resetLogger,
} from './infrastructure/logger/index';

// Transport (bas niveau)
export * from './infrastructure/transport/MqttTransport';

// EventBus de l'infrastructure (alternative)
export * from './infrastructure/EventBus';

// =============================================================================
// 4. COUCHE HA (Home Assistant)
// =============================================================================

// Types HA
export type {
  HaRawEntity,
  HaEntityState,
  HaDeviceClass,
  HaArea,
  HaDevice,
  HaStructuredEntity,
  HaStructuredRegistry,
  HaQuoiDefinition,
} from './ha/types/index';

// Command types
export type {
  HaCommand,
  HaServiceCall,
  HaCommandResult,
} from './ha/types/ha-command';

// Synchronisation référentiel
export { HaWsClient } from './ha/sync/HaWsClient';
export { HaStateRegistry } from './ha/sync/HaStateRegistry';
export { HaStructureRegistry } from './ha/sync/HaStructureRegistry';
export { DefaultHaClassifier } from './ha/sync/DefaultHaClassifier';
export { TaxonomyHaClassifier } from './ha/sync/TaxonomyHaClassifier';
export { QUI_CATALOG as quiCatalog } from './ha/sync/quiCatalog';

// Commandes HA
export { HaCommandService } from './ha/command/index';

// Intégration MQTT (pour les applications de type integration)
export * from './ha/integration/index';

// =============================================================================
// Note : la couche présentation (UI navigateur, ex. SocketService) n'est PAS
// exportée ici. Ce fichier est le point d'entrée BACKEND (Node.js) du core ;
// tout code dépendant du navigateur (window, document, socket.io-client via
// balise <script>) casserait le build Node des applications qui importent
// exports.ts, et se retrouverait compilé à tort dans leur dist backend.
// Les applications ayant besoin de SocketService côté navigateur doivent
// l'importer depuis './ui-exports' (voir ce fichier).
// =============================================================================

