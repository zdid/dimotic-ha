/**
 * Module principal de l'application SUPERVISION (fonctionnelles-supervision_specs v1.2) — machines
 * et applications du site (gossip des cores), sélection diffusée, état des sauvegardes. Pas de menu
 * ni de page propre : affichage sur la page d'accueil du core (fragment presentation/accueil.html +
 * presentation/ts/accueil.js, chargés par HomeView.ts). Activée d'office (package.json
 * `dimotic.enabledByDefault`, §7.1).
 */

import {
  ApplicationModule,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider
} from '../../../core/dist/exports';
import { SUPERVISION_SOCKET_EVENTS, SUPERVISION_ALL_EVENTS, SUPERVISION_PERSISTENT_EVENTS } from './socket-events';
import { SupervisionService, type ISupervisionService } from './SupervisionService';
import type { SupervisionConfig } from './config-schema';

export const SUPERVISION_APP: ApplicationModule = {
  id: 'supervision',
  name: 'Supervision',
  description: "Machines et applications du site, sélection de ce qui est supervisé, état des sauvegardes — sur la page d'accueil.",
  icon: '🩺',
  // 'integration' : connexion MQTT du socle (bridge 'main') pour le gossip, le LWT et la sélection.
  type: 'integration',
  audience: 'configuration',
  configurable: false,
  requiredMqtt: true,
  requiredHaWs: false,
  configSection: 'supervision',
  socketEvents: SUPERVISION_SOCKET_EVENTS,
  runsAsSeparateProcess: true,
  // Pas d'entrée de menu : affichage sur la page d'accueil seulement (§6.2).
  noMenu: true,
  // Réponse de l'application sauvegarde à la requête corrélée (spec §5).
  bridgedEvents: ['sauvegarde:supervision:status:reply']
};

export function createSupervisionService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<SupervisionConfig>,
  localMachineId: string,
  gossipIntervalSeconds: number
): ISupervisionService {
  const service = new SupervisionService(eventBus, logger, configProvider, localMachineId, gossipIntervalSeconds);
  eventBus.emit('app:socket-events:registered', {
    appId: 'supervision',
    socketEvents: SUPERVISION_ALL_EVENTS,
    persistentEvents: SUPERVISION_PERSISTENT_EVENTS
  });
  return service;
}

export function createSupervisionServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService): ISupervisionService {
  const configProvider = new AppConfigProvider<SupervisionConfig>('supervision', configService);
  const core = configService.getConfig().core as { machineId: string; appGossipIntervalSeconds?: number };
  return createSupervisionService(eventBus, logger, configProvider, core.machineId, core.appGossipIntervalSeconds ?? 300);
}

export * from './SupervisionService';
export * from './BackupEvaluation';
export * from './socket-events';
export * from './config-schema';
