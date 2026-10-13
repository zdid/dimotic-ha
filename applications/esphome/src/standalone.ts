/**
 * Bootstrap autonome de l'application ESPHOME en process séparé (patron identique à rpigpio/outils) — lancé par
 * ProcessSupervisor, jamais directement par AppService (voir `runsAsSeparateProcess` sur ESPHOME_APP).
 */

import * as path from 'node:path';
import { ConfigLoader, ConfigWriter, ConfigService, createLogger, IpcEventBus } from '../../core/dist/exports';
import { createEsphomeServiceWithConfig } from './domain';

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

  const service = createEsphomeServiceWithConfig(new IpcEventBus(), logger, configService);
  await service.start();
  logger.info('esphome:standalone', `esphome démarré en process séparé (pid ${process.pid})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('esphome:standalone', `Signal ${signal} reçu — arrêt`);
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
  console.error('[esphome:standalone] Échec du démarrage:', error);
  process.exit(1);
});
