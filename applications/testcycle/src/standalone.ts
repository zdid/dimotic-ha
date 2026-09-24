/**
 * Bootstrap autonome de l'application de test du cycle de vie en process séparé — même patron que
 * arexx/haplan (standalone.ts). Lancé par ProcessSupervisor, jamais directement par AppService.
 *
 * Mode de panne `ignoreSigterm` : SIGTERM est ignoré (aucun arrêt propre, aucun
 * `integration:bridge:unregister`) — ProcessSupervisor doit alors recourir au SIGKILL de secours.
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
import { createTestcycleServiceWithConfig } from './domain';

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

  const service = createTestcycleServiceWithConfig(eventBus, logger, configService, haBridgeClient);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (signal === 'SIGTERM' && service.ignoresSigterm()) {
      logger.warn('testcycle:standalone', 'SIGTERM reçu et IGNORÉ (mode de panne « ignoreSigterm ») — attente du SIGKILL');
      return;
    }
    if (stopping) return;
    stopping = true;
    logger.info('testcycle:standalone', `Signal ${signal} reçu — arrêt`);
    try {
      await service.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await service.start();
  logger.info('testcycle:standalone', `testcycle démarré en process séparé (pid ${process.pid}, machine ${machineId})`);
}

main().catch((error) => {
  console.error('[testcycle:standalone] Échec du démarrage:', error);
  process.exit(1);
});
