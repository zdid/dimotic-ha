// src/types/errors.ts
// Types standardisés pour la gestion des erreurs
// Conforme à specs-erreurs-v1.0.md

// ============================================================================
// CODES D'ERREUR
// ============================================================================

/**
 * Codes d'erreur HA WebSocket (specs-erreurs-v1.0.md §3)
 */
export type HaWsErrorCode =
  | 'HA_CONNECTION_LOST'
  | 'HA_CONNECTION_TIMEOUT'
  | 'HA_CONNECTION_REFUSED'
  | 'HA_AUTH_FAILED'
  | 'HA_AUTH_REJECTED'
  | 'HA_TOKEN_MISSING'
  | 'HA_SYNC_FAILED'
  | 'HA_SYNC_PARTIAL'
  | 'HA_ENTITY_NOT_FOUND'
  | 'HA_SERVICE_NOT_AVAILABLE'
  | 'HA_SERVICE_INVALID'
  | 'HA_ENTITY_UNAUTHORIZED';

/**
 * Codes d'erreur MQTT (specs-erreurs-v1.0.md §4)
 */
export type MqttErrorCode =
  | 'MQTT_CONNECTION_LOST'
  | 'MQTT_CONNECTION_TIMEOUT'
  | 'MQTT_CONNECTION_REFUSED'
  | 'MQTT_AUTH_FAILED'
  | 'MQTT_PUBLISH_FAILED'
  | 'MQTT_RETAINED_ERROR'
  | 'MQTT_QOS_UNSUPPORTED'
  | 'MQTT_SUBSCRIBE_FAILED'
  | 'MQTT_UNSUBSCRIBE_FAILED';

/**
 * Codes d'erreur RFXCOM (implementation-rfxcom_specs_v1.2.md §10.1)
 */
export type RfxComErrorCode =
  | 'RFXCOM_CONNECTION_ERROR'
  | 'RFXCOM_TRANSCEIVER_NOT_INITIALIZED'
  | 'RFXCOM_TRANSCEIVER_NOT_CONNECTED'
  | 'RFXCOM_UNSUPPORTED_PROTOCOL'
  | 'RFXCOM_UNSUPPORTED_ACTION'
  | 'RFXCOM_COMMAND_FAILED'
  | 'RFXCOM_DEVICE_NOT_FOUND';

/**
 * Codes d'erreur EVOO7
 */
export type Evoo7ErrorCode =
  | 'EVOO7_CONNECTION_ERROR'
  | 'EVOO7_UNKNOWN_DATA'
  | 'EVOO7_NOT_UPDATABLE'
  | 'EVOO7_INVALID_VALUE'
  | 'EVOO7_COMMAND_FAILED'
  | 'EVOO7_SAVE_FAILED';

/**
 * Codes d'erreur HAPLAN
 */
export type HaplanErrorCode =
  | 'HAPLAN_HA_UNAVAILABLE'
  | 'HAPLAN_UNKNOWN_ENTITY'
  | 'HAPLAN_COMMAND_FAILED'
  | 'HAPLAN_SAVE_FAILED'
  | 'HAPLAN_DEPLOY_BUSY'
  | 'HAPLAN_DEPLOY_FAILED';

/**
 * Codes d'erreur génériques (specs-erreurs-v1.0.md §6)
 */
export type AppErrorCode =
  | HaWsErrorCode
  | MqttErrorCode
  | RfxComErrorCode
  | Evoo7ErrorCode
  | HaplanErrorCode
  | 'APP_CONFIG_INVALID'
  | 'APP_CONFIG_MISSING'
  | 'APP_CONFIG_REQUIRED_FIELD_MISSING'
  | 'APP_VALIDATION_FAILED'
  | 'APP_VALUE_OUT_OF_RANGE';

// ============================================================================
// NIVEAUX DE SÉVÉRITÉ
// ============================================================================

/** Niveau de sévérité d'une erreur */
export type ErrorSeverity = 'error' | 'warn' | 'info' | 'debug';

// ============================================================================
// STRUCTURES D'ERREUR
// ============================================================================

/**
 * Structure standardisée d'une erreur d'application.
 * Conforme à specs-erreurs-v1.0.md §9
 */
export interface AppError {
  code: AppErrorCode;          // Code d'erreur unique
  message: string;             // Message lisible
  severity: ErrorSeverity;     // Niveau de sévérité
  module: string;             // Module émetteur (ex: "ha:ws", "mqtt:client")
  timestamp: string;          // ISO8601
  details?: ErrorDetails;     // Contexte supplémentaire
  stack?: string;             // Stack trace (debug uniquement)
}

/**
 * Détails supplémentaires pour une erreur
 */
export interface ErrorDetails {
  entityId?: string;
  service?: string;
  topic?: string;
  reason?: string;
  retryCount?: number;
  port?: string;
  host?: string;
  field?: string;
  value?: unknown;
  min?: number;
  max?: number;
  [key: string]: unknown;
}

// ============================================================================
// ÉTATS DES COMMANDES
// ============================================================================

/**
 * États possibles pour une commande (specs-erreurs-v1.0.md §7)
 */
export type CommandStatus =
  | 'pending'
  | 'executing'
  | 'success'
  | 'error'
  | 'timeout'
  | 'cancelled';

// ============================================================================
// ÉTATS DE CONNEXION
// ============================================================================

/**
 * États de connexion HA WebSocket (specs-erreurs-v1.0.md §8.1)
 */
export type HaConnectionState =
  | 'ha_connected'
  | 'ha_disconnected'
  | 'ha_reconnecting'
  | 'ha_reconnected';

/**
 * États de connexion MQTT (specs-erreurs-v1.0.md §8.2)
 */
export type MqttConnectionState =
  | 'mqtt_connected'
  | 'mqtt_disconnected'
  | 'mqtt_reconnecting'
  | 'mqtt_reconnected';

// ============================================================================
// FONCTIONS UTILITAIRES
// ============================================================================

/**
 * Crée une nouvelle AppError standardisée
 */
export function createAppError(
  options: {
    code: AppErrorCode;
    message: string;
    severity?: ErrorSeverity;
    module?: string;
    details?: ErrorDetails;
    stack?: string;
  }
): AppError {
  return {
    code: options.code,
    message: options.message,
    severity: options.severity || 'error',
    module: options.module || 'app',
    timestamp: new Date().toISOString(),
    details: options.details,
    stack: options.stack,
  };
}

/**
 * Crée une erreur HA WebSocket
 */
export function createHaWsError(
  code: HaWsErrorCode,
  message: string,
  module?: string,
  details?: ErrorDetails
): AppError {
  return createAppError({ code, message, severity: 'error', module: module || 'ha:ws', details });
}

/**
 * Crée une erreur MQTT
 */
export function createMqttError(
  code: MqttErrorCode,
  message: string,
  module?: string,
  details?: ErrorDetails
): AppError {
  return createAppError({ code, message, severity: 'error', module: module || 'mqtt:client', details });
}

/**
 * Crée une erreur RFXCOM
 */
export function createRfxComError(
  code: RfxComErrorCode,
  message: string,
  module?: string,
  details?: ErrorDetails
): AppError {
  return createAppError({ code, message, severity: 'error', module: module || 'rfxcom', details });
}

/**
 * Crée une erreur EVOO7
 */
export function createEvoo7Error(
  code: Evoo7ErrorCode,
  message: string,
  module?: string,
  details?: ErrorDetails
): AppError {
  return createAppError({ code, message, severity: 'error', module: module || 'evoo7', details });
}

/**
 * Crée une erreur HAPLAN
 */
export function createHaplanError(
  code: HaplanErrorCode,
  message: string,
  module?: string,
  details?: ErrorDetails
): AppError {
  return createAppError({ code, message, severity: 'error', module: module || 'haplan', details });
}

/**
 * Crée une erreur de validation
 */
export function createValidationError(
  message: string,
  field?: string,
  value?: unknown,
  min?: number,
  max?: number
): AppError {
  return createAppError({
    code: 'APP_VALIDATION_FAILED',
    message,
    severity: 'error',
    module: 'app:validation',
    details: { field, value, min, max },
  });
}

/**
 * Vérifie si un code est une erreur critique (nécessite une action immédiate)
 */
export function isCriticalError(code: AppErrorCode): boolean {
  const criticalErrors: AppErrorCode[] = [
    'HA_CONNECTION_LOST',
    'HA_AUTH_FAILED',
    'HA_TOKEN_MISSING',
    'MQTT_CONNECTION_LOST',
    'MQTT_AUTH_FAILED',
    'APP_CONFIG_MISSING',
    'APP_CONFIG_INVALID',
  ];
  return criticalErrors.includes(code);
}

/**
 * Convertit une erreur standard en AppError
 */
export function toAppError(
  error: Error,
  options: {
    code: AppErrorCode;
    module?: string;
    severity?: ErrorSeverity;
    details?: ErrorDetails;
  }
): AppError {
  return createAppError({
    code: options.code,
    message: error.message,
    severity: options.severity || 'error',
    module: options.module || 'app',
    details: options.details,
    stack: error.stack,
  });
}
