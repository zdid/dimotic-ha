// src/types/events.ts
// Types des événements Socket.io et EventBus
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §5 et specs-presentation-v2.0.md §7

import type { AppConfig, ConfigValidationResult, TechnicalConfig, ApplicationModule } from './config';
export type { ApplicationModule };

// ============================================================================
// ÉVÉNEMENTS SOCKET.IO (Communication UI ↔ Serveur)
// ============================================================================

/**
 * Catalogue complet des événements Socket.io
 * Server → Client : préfixe "server:"
 * Client → Server : préfixe "client:"
 */

// ------ Événements Server → Client ------

/** État global de l'application */
export interface AppStatus {
  mqtt: boolean;        // MQTT connecté
  haEntities: number;  // Nombre d'entités HA synchronisées
  uptime: number;      // Uptime en secondes
}

/** Ligne de log */
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  ts: string; // ISO8601
}

/** Résultat de sauvegarde de la config */
export interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

/**
 * Événements émis par le serveur vers le client
 * Tous les clients connectés reçoivent ces événements
 * NOTE: Les applications peuvent ajouter leurs propres événements via registerAppSocketEvents()
 */
export interface ServerToClientEvents {
  // Socle (toutes les applications)
  'app:status': (status: AppStatus) => void;
  'app:log': (log: LogEntry) => void;
  
  // HA
  'ha:entity:updated': (entity: unknown) => void; // HaEntity (à typer)
  'ha:sync:ready': (data: { entityCount: number }) => void;
  'ha:status': (data: { connected: boolean }) => void;
  
  // Configuration
  'config:current': (config: TechnicalConfig) => void;
  'config:validation:result': (result: ConfigValidationResult) => void;
  'config:saved': (result: ConfigSaveResult) => void;
  'config:save:result': (result: ConfigSaveResult) => void;
  
  // MQTT
  'mqtt:connected': () => void;
  'mqtt:disconnected': (data: { reason: string }) => void;
  
  // Modules (dynamique)
  'app:modules:list': (data: { modules: ApplicationModule[] }) => void;
  'app:modules:config': (data: { moduleId: string; config: Record<string, unknown> }) => void;
  'app:module:ui:register': (data: { moduleId: string; metadata: unknown }) => void;
  'app:module:config': (data: { moduleId: string; config: Record<string, unknown> }) => void;
  'app:module:config:saved': (data: { moduleId: string; success: boolean; error?: string }) => void;

  // Gestion des applications (NOUVEAU v4.4)
  'app:applications:list:result': (data: { activated: string[]; disabled: string[] }) => void;
  'app:applications:enable:result': (data: { appId: string; success: boolean; error?: string }) => void;
  'app:applications:disable:result': (data: { appId: string; success: boolean; error?: string }) => void;

  // Redémarrage manuel de l'application (Paramètres Techniques)
  'app:restart:result': (data: { success: boolean; error?: string }) => void;
}

// ------ Événements Client → Server ------

/** Paramètres pour la récupération des logs */
export interface LogsGetParams {
  lines: number; // Nombre de lignes à récupérer
}

/**
 * Événements reçus par le serveur depuis le client
 * Un client peut émettre ces événements
 * NOTE: Les applications peuvent ajouter leurs propres événements via registerAppSocketEvents()
 */
export interface ClientToServerEvents {
  // Socle
  'config:get': () => void;
  'config:save': (config: TechnicalConfig) => void;
  'config:validate': (config: Partial<TechnicalConfig>) => void;
  'logs:get': (params: LogsGetParams) => void;
  
  // HA
  'ha:structure:get': () => void;
  'ha:command:send': (command: unknown) => void; // HaCommand (à typer)
  
  // Modules
  'app:modules:config:get': (data: { moduleId: string }) => void;
  'app:modules:config:save': (data: { moduleId: string; config: Record<string, unknown> }) => void;
  'app:module:ui:register': () => void;

  // Gestion des applications (NOUVEAU v4.4)
  'app:applications:list': () => void;
  'app:applications:enable': (data: { appId: string }) => void;
  'app:applications:disable': (data: { appId: string }) => void;

  // Redémarrage manuel de l'application (Paramètres Techniques)
  'app:restart': () => void;
}

// ============================================================================
// ÉVÉNEMENTS EVENTBUS (Communication Inter-Couches Serveur)
// ============================================================================

// ApplicationModule est importé depuis config.ts

/**
 * Événements internes de l'application (EventBus)
 * Utilisés entre les couches Application, HA, Domain
 */
export interface AppEvents {
  // ------ Couche HA → Application ------
  'ha:ready': { entityCount: number; areaCount: number; deviceCount: number };
  'ha:connected': void;
  'ha:disconnected': void;
  'ha:reconnected': void;
  'ha:entity:state_changed': unknown; // HaStructuredEntity
  'ha:area:updated': unknown; // HaArea
  'ha:device:updated': unknown; // HaDevice
  'ha:entity:updated': unknown; // HaStructuredEntity
  'ha:command:result': unknown; // HaCommandResult
  
  // ------ Application → Couche HA ------
  'ha:command:send': unknown; // HaCommand
  
  // ------ Application → Présentation (via SocketBridge) ------
  'app:status:changed': { ha: boolean; haEntities: number; uptime: number };
  
  // ------ Présentation → Application ------
  'config:current': TechnicalConfig;
  'config:get': void;
  'config:save:requested': TechnicalConfig;
  'config:validate:requested': Partial<TechnicalConfig>;
  'config:saved': ConfigSaveResult;
  'config:validation:result': ConfigValidationResult;
  
  // ------ Application → Modules ------
  'app:modules:registered': { modules: ApplicationModule[] };
  'app:modules:config:get': { moduleId: string };
  'app:modules:config:save': { moduleId: string; config: Record<string, unknown> };

  // Gestion des applications (NOUVEAU v4.4)
  'app:applications:list': void;
  'app:applications:list:result': { activated: string[]; disabled: string[] };
  'app:applications:enable': { appId: string };
  'app:applications:enable:result': { appId: string; success: boolean; error?: string };
  'app:applications:disable': { appId: string };
  'app:applications:disable:result': { appId: string; success: boolean; error?: string };

  // Redémarrage manuel de l'application (Paramètres Techniques)
  'app:restart:requested': void;
  'app:restart:result': { success: boolean; error?: string };

  // ------ Extension libre par les applications ------
  // Les applications dérivées peuvent ajouter leurs propres événements
  [key: string]: unknown;
}

// ============================================================================
// TYPES SOCKET.IO POUR LE SERVEUR
// ============================================================================

import type { Server as HttpServer } from 'http';
import type { Server as SocketIOServer } from 'socket.io';

/** Type du serveur Socket.io */
// Types génériques Socket.IO

export interface InterServerEvents { [key: string]: (...args: unknown[]) => void; }

export interface SocketData { [key: string]: unknown; }

// Type SocketServer avec support des événements dynamiques des applications
export type SocketServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Type du socket client */
export type SocketClient = {
  emit: <K extends string>(event: K, ...args: unknown[]) => boolean;
  on: <K extends string>(event: K, listener: (...args: unknown[]) => void) => void;
};

// ============================================================================
// ÉVÉNEMENTS SOCKET.IO DU SOCLE (pour extension)
// ============================================================================

/**
 * Événements Socket.io du socle Server → Client (à étendre par les applications).
 *
 * Ne contient QUE les événements Server → Client : c'est cet objet, et lui seul, qui est
 * transmis à SocketBridge.registerAppSocketEvents('core', ...) — qui câble un socket.on(...)
 * client→serveur pour CHAQUE entrée reçue (SocketBridge.setupDynamicAppHandlers()). Les
 * événements Client → Server du socle (SOCLE_CLIENT_EVENTS ci-dessous) sont déjà câblés en dur
 * dans SocketBridge.setupSocketIOHandlers() ; les mélanger ici créait un double socket.on(...)
 * pour chacun (config:get/save, logs:get, ha:structure:get, ha:command:send,
 * app:modules:config:get/save), donc un traitement métier en double à chaque requête client.
 */
export const SOCLE_SOCKET_EVENTS = {
  APP_STATUS: 'app:status',
  APP_STARTED: 'app:started',
  APP_LOG: 'app:log',
  HA_ENTITY_UPDATED: 'ha:entity:updated',
  HA_SYNC_READY: 'ha:sync:ready',
  HA_STATUS: 'ha:status',
  CONFIG_CURRENT: 'config:current',
  CONFIG_VALIDATION_RESULT: 'config:validation:result',
  CONFIG_SAVED: 'config:saved',
  MQTT_CONNECTED: 'mqtt:connected',
  MQTT_DISCONNECTED: 'mqtt:disconnected',
  MODULES_LIST: 'app:modules:list',
  MODULES_CONFIG: 'app:modules:config',
} as const;

/**
 * Événements Socket.io du socle Client → Server — déjà câblés en dur dans
 * SocketBridge.setupSocketIOHandlers(). Gardés ici à titre de référence/typage uniquement :
 * ne JAMAIS les passer à registerAppSocketEvents('core', ...), voir commentaire ci-dessus.
 */
export const SOCLE_CLIENT_EVENTS = {
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_VALIDATE: 'config:validate',
  LOGS_GET: 'logs:get',
  HA_STRUCTURE_GET: 'ha:structure:get',
  HA_COMMAND_SEND: 'ha:command:send',
  MODULES_CONFIG_GET: 'app:modules:config:get',
  MODULES_CONFIG_SAVE: 'app:modules:config:save',
} as const;

// Type pour les événements socle
export type SocleSocketEvents = typeof SOCLE_SOCKET_EVENTS;
export type SocleClientEvents = typeof SOCLE_CLIENT_EVENTS;
