/**
 * Module principal de l'application ESPDISPLAY
 *
 * Ce fichier est scanné par AppService pour la détection automatique. Il doit exporter :
 * - ESPDISPLAY_APP : ApplicationModule (métadonnées)
 * - createEspDisplayService : Factory de service
 *
 * ⚠️ Le nom du répertoire (espdisplay) DOIT correspondre à l'ID déclaré ici.
 *
 * Orchestration des écrans ESP (ESPHome/LVGL) : déclenché par un événement générique sur
 * l'EventBus partagé (ex: HAPLAN -> espdisplay:deploy-floorplan), exécute le pipeline Python de
 * génération/compilation. Pas encore de configuration UI ni de menu — squelette minimal
 * (13/08/2026), l'architecture inter-app ayant été validée avant toute UI (voir mémoire projet
 * project_haplan_esphome_s3_display).
 */

import type { ApplicationModule, IEventBus, Logger, IAppConfigProvider, ConfigService } from '../../../core/dist/exports';
import { AppConfigProvider } from '../../../core/dist/exports';
import { EspDisplayService, type IEspDisplayService } from './EspDisplayService';
import { type EspDisplayConfig } from './config-schema';

export const ESPDISPLAY_APP: ApplicationModule = {
  id: 'espdisplay',
  name: 'ESPDISPLAY',
  description: 'Orchestration des écrans ESP (ESPHome/LVGL) : reçoit une demande de déploiement (ex: depuis HAPLAN) et exécute le pipeline génération+compilation Python correspondant.',
  icon: '🖥️',

  type: 'standalone',
  audience: 'configuration',
  configurable: false,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'espdisplay'
};

export function createEspDisplayService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<EspDisplayConfig>
): IEspDisplayService {
  return EspDisplayService.create(eventBus, logger, configProvider);
}

export function createEspDisplayServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IEspDisplayService {
  const configProvider = new AppConfigProvider<EspDisplayConfig>('espdisplay' as any, configService);
  return createEspDisplayService(eventBus, logger, configProvider);
}

export * from './EspDisplayService';
export * from './config-schema';
