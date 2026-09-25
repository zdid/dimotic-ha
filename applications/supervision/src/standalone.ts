/**
 * Bootstrap autonome de SUPERVISION en process séparé — même patron que testcycle/standalone.ts.
 * Lancé par ProcessSupervisor, jamais directement par AppService.
 */

import * as path from 'node:path';
import { ConfigLoader, ConfigWriter, ConfigService, createLogger, IpcEventBus } from '../../core/dist/exports';
import { createSupervisionServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs')
  });

  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configService = new ConfigService(
    new ConfigLoader(configPath, undefined, dataRoot),
    new ConfigWriter(configPath, undefined, '.tmp', dataRoot),
    logger
  );

  const eventBus = new IpcEventBus();
  const service = createSupervisionServiceWithConfig(eventBus, logger, configService);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('supervision:standalone', `Signal ${signal} reçu — arrêt`);
    try {
      await service.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await service.start();
  logger.info('supervision:standalone', `supervision démarrée en process séparé (pid ${process.pid})`);
}

main().catch((error) => {
  console.error('[supervision:standalone] Échec du démarrage:', error);
  process.exit(1);
});
