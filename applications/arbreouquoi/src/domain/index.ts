import type { ApplicationModule } from '../../../core/dist/types/config';
import type { IEventBus } from '../../../core/dist/application/IEventBus';
import type { Logger } from '../../../core/dist/infrastructure/logger/index';
import type { ConfigService } from '../../../core/dist/infrastructure/config/ConfigService';
import type { HaBridgeClient } from '../../../core/dist/application/HaBridgeClient';
import { AppConfigProvider } from '../../../core/dist/infrastructure/config/AppConfigProvider';
import { ARBREOUQUOI_SOCKET_EVENTS } from './socket-events';
import { createArbreouquoiService, type ArbreouquoiService } from './ArbreouquoiService';
import type { ArbreouquoiConfig } from './config-schema';

// ⚠️ ARBREOUQUOI n'a aucun réglage persisté : filterByArea/filterByQuoi/showOnlyActive étaient
// déclarés ici comme configUi (donc affichés à tort sous "Paramètres Techniques"), alors que ce
// sont des filtres de vue transitoires. showOnlyActive est désormais un vrai contrôle dans la
// barre d'outils de la fenêtre ARBREOUQUOI elle-même (voir presentation/index.html + ts/app.ts),
// câblé sur l'événement arbreouquoi:filter:set déjà géré côté serveur. filterByArea/filterByQuoi
// n'ont pas d'équivalent backend réel (FilterOptions ne porte que showOnlyActive/sortBy/sortOrder)
// et ne sont donc pas repris — les construire serait une nouvelle fonctionnalité, pas un correctif.

// Déclaration du module
export const ARBREOUQUOI_APP: ApplicationModule = {
  id: 'arbreouquoi',
  name: 'Arbre Où Quoi',
  description: 'Application de visualisation du référentiel Home Assistant organisé par Area → QUOI → Entités',
  icon: '🌳',
  type: 'standalone',
  audience: 'inspection',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: true,
  // ⭐ 24/08/2026 — migration en process séparé (découplage HaStructureRegistry via
  // HaBridgeClient, voir ArbreouquoiService.ts) : résout le redémarrage complet de core à la
  // désactivation depuis Gestion des applications (superviseur Phase 2, voir
  // fonctionnelles-supervisor_specs).
  runsAsSeparateProcess: true,
  socketEvents: ARBREOUQUOI_SOCKET_EVENTS,
  configSection: 'arbreouquoi'
};

// Factories
export * from './ArbreouquoiService';
export * from './socket-events';
export * from './config-schema';
export * from './types';

/**
 * Bootstrap depuis standalone.ts (⭐ 24/08/2026, app en process séparé) — construit
 * l'IAppConfigProvider à partir du ConfigService brut (même patron que rpigpio/teleinfo/...
 * createXxxServiceWithConfig) et s'auto-annonce sur `app:socket-events:registered` pour que
 * SupervisorEventBridge.autoBridgeSocketEvents() ponte ses événements UI (§7.1, aucune déclaration
 * manuelle nécessaire côté core) — remplace ce que le chargement in-process faisait implicitement.
 */
export function createArbreouquoiServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haBridgeClient: HaBridgeClient
): ArbreouquoiService {
  const configProvider = new AppConfigProvider<ArbreouquoiConfig>('arbreouquoi' as any, configService);
  const service = createArbreouquoiService(eventBus, logger, configProvider, haBridgeClient);

  eventBus.emit('app:socket-events:registered', {
    appId: 'arbreouquoi',
    socketEvents: ARBREOUQUOI_SOCKET_EVENTS
  });

  return service;
}
