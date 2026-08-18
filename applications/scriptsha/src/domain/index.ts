/**
 * Module principal de l'application scriptsha — scanné par AppService pour la détection
 * automatique. Doit exporter SCRIPTSHA_APP (ApplicationModule) et une factory de service
 * (createScriptshaService / createScriptshaServiceWithConfig).
 *
 * Gère des scripts Home Assistant (entité native `script.*`) déposés sous forme de fichier YAML —
 * titre, explication, statut diffusé/non diffusé, diffusion/retrait à la demande via l'API config
 * HA (voir HaRestBridge côté core, ScriptsHaService pour le détail).
 *
 * Process séparé (comme rfxcom/espdisplay/rpigpio) — voir standalone.ts. `bridgedEvents` ne liste
 * QUE le sens core→enfant (le sens enfant→core est automatique, voir SupervisorEventBridge) :
 * - `scriptsha:internal:upload` : relayé par la route générique POST /api/apps/:appId/upload.
 * - `scriptsha:ha:rest:result` : relayé par le pont générique HaRestBridge, réponse à une requête
 *   `ha:rest:request` émise par ce service (côté enfant, reçue automatiquement côté core).
 * - `scriptsha:ha:helper:result` / `scriptsha:ha:entities:list:result` : relayés par le pont
 *   générique HaHelperBridge (CRUD des helpers HA type `timer`, requête ponctuelle du référentiel
 *   d'entités par domaine) — voir ScriptsHaService::reconcileEntityHelpers.
 * - `ha:entity:updated` : événement générique déjà émis par le core (AppService) pour tout
 *   `entity_registry_updated` — utilisé ici pour détecter une nouvelle entité surveillée en continu
 *   (pour tout script diffusé portant un `provisioning`, voir storage-schema.ts).
 */

import {
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider
} from '../../../core/dist/exports';
import { SCRIPTSHA_SOCKET_EVENTS, SCRIPTSHA_ALL_EVENTS, SCRIPTSHA_PERSISTENT_EVENTS } from './socket-events';
import { ScriptsHaService, IScriptsHaService } from './ScriptsHaService';
import { DEFAULT_SCRIPTSHA_CONFIG, type ScriptshaConfig } from './config-schema';

// ============================================================================
// Métadonnées UI
// ============================================================================

export const SCRIPTSHA_UI_METADATA: ModuleUiMetadata = {
  title: 'Scripts HA',
  description: 'Dépôt et gestion de scripts Home Assistant (script.*) — titre, explication, diffusion/retrait à la demande.',
  icon: '📜',
  fields: []
};

// ============================================================================
// Déclaration du Module scriptsha
// ============================================================================

export const SCRIPTSHA_APP: ApplicationModule = {
  id: 'scriptsha',
  name: 'Scripts HA',
  description: 'Gestion de scripts Home Assistant déposés sous forme de fichier — diffusion/retrait à la demande.',
  icon: '📜',

  type: 'standalone',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'scriptsha',
  configUi: SCRIPTSHA_UI_METADATA,
  socketEvents: SCRIPTSHA_SOCKET_EVENTS,

  runsAsSeparateProcess: true,
  bridgedEvents: [
    'scriptsha:internal:upload',
    'scriptsha:ha:rest:result',
    'scriptsha:ha:helper:result',
    'scriptsha:ha:entities:list:result',
    // Événement générique existant (AppService.ts, émis pour tout entity_registry_updated), pas
    // préfixé scriptsha — utilisé pour détecter une nouvelle entité surveillée en continu, voir
    // ScriptsHaService::reconcileEntityHelpers.
    'ha:entity:updated'
  ]
};

// ============================================================================
// Factory du Service scriptsha
// ============================================================================

export function createScriptshaService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<ScriptshaConfig>
): IScriptsHaService {
  const service = ScriptsHaService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'scriptsha',
    socketEvents: SCRIPTSHA_ALL_EVENTS,
    persistentEvents: SCRIPTSHA_PERSISTENT_EVENTS
  });

  return service;
}

export function createScriptshaServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IScriptsHaService {
  const configProvider = new AppConfigProvider<ScriptshaConfig>('scriptsha' as any, configService);
  return createScriptshaService(eventBus, logger, configProvider);
}

// ============================================================================
// Ré-export
// ============================================================================

export * from './ScriptsHaService';
export * from './config-schema';
export * from './storage-schema';
export * from './socket-events';
export { DEFAULT_SCRIPTSHA_CONFIG };
