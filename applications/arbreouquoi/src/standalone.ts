/**
 * Bootstrap autonome d'arbreouquoi en process séparé — fonctionnelles-supervisor_specs, migration
 * du 24/08/2026 (ia/planificateur/haplan/arbreouquoi, différée le 16/08/2026, reprise via
 * HaQueryBridge/HaBridgeClient — voir ces fichiers pour le découplage HaStructureRegistry).
 * Lancé par ProcessSupervisor, jamais directement par AppService.startApplicationService() (voir
 * le flag `runsAsSeparateProcess` sur ARBREOUQUOI_APP). Même squelette que
 * applications/rpigpio/src/standalone.ts, avec en plus la construction du HaBridgeClient (façade
 * générique vers le référentiel HA détenu par `core`, jamais transportée telle quelle).
 */

import * as path from 'node:path';
import {
  ConfigLoader,
  ConfigWriter,
  ConfigService,
  createLogger,
  IpcEventBus,
  HaBridgeClient
} from '../../core/dist/exports';
import { createArbreouquoiServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs')
  });

  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configLoader = new ConfigLoader(configPath, undefined, dataRoot);
  const configWriter = new ConfigWriter(configPath, undefined, '.tmp', dataRoot);
  const configService = new ConfigService(configLoader, configWriter, logger);

  const machineId = configService.getConfig().core.machineId;
  const eventBus = new IpcEventBus();
  const haBridgeClient = new HaBridgeClient(eventBus, logger);

  const service = createArbreouquoiServiceWithConfig(eventBus, logger, configService, haBridgeClient);

  await service.start();
  logger.info('arbreouquoi:standalone', `arbreouquoi démarré en process séparé (pid ${process.pid}, machine ${machineId})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('arbreouquoi:standalone', `Signal ${signal} reçu — arrêt`);
    try {
      await service.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[arbreouquoi:standalone] Échec du démarrage:', error);
  process.exit(1);
});
