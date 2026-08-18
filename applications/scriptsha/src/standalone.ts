/**
 * Bootstrap autonome de scriptsha en process séparé — même patron que rpigpio/espdisplay (Phase 2,
 * fonctionnelles-supervisor_specs v2.6 §5.2). Lancé par ProcessSupervisor (applications/core/src/
 * supervisor/), jamais directement par AppService.startApplicationService() (voir le flag
 * `runsAsSeparateProcess` sur SCRIPTSHA_APP).
 *
 * Se bootstrap intégralement lui-même — lit sa propre config, construit son propre IpcEventBus (le
 * canal `stdio: [...,'ipc']` que ProcessSupervisor établit au spawn). `createScriptshaServiceWithConfig()`
 * (domain/index.ts) reste le seul contrat de factory nécessaire.
 */

import * as path from 'node:path';
import {
  ConfigLoader,
  ConfigWriter,
  ConfigService,
  createLogger,
  IpcEventBus
} from '../../core/dist/exports';
import { createScriptshaServiceWithConfig } from './domain';

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

  const service = createScriptshaServiceWithConfig(eventBus, logger, configService);

  await service.start();
  logger.info('scriptsha:standalone', `scriptsha démarré en process séparé (pid ${process.pid}, machine ${machineId})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('scriptsha:standalone', `Signal ${signal} reçu — arrêt`);
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
  console.error('[scriptsha:standalone] Échec du démarrage:', error);
  process.exit(1);
});
