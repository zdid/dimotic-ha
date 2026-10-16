/**
 * Bootstrap autonome du pilote zigbee2mqtt en process séparé — même patron que applications/arexx/src/standalone.ts
 * (fonctionnelles-supervisor_specs v2.6 §5.2). Lancé par ProcessSupervisor, jamais directement par AppService.
 */

import * as path from 'node:path';
import {
  ConfigLoader,
  ConfigWriter,
  ConfigService,
  createLogger,
  IpcEventBus
} from '../../core/dist/exports';
import { createZigbee2mqttServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs')
  });

  // Même racine de config que core (data/core/config.yaml + data/{app}/config.yaml) — c'est ce qui
  // permet de lire à la fois core.machineId (juste informatif ici) et sa propre section `zigbee2mqtt`,
  // en cohérence avec ce que core lui-même voit.
  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configLoader = new ConfigLoader(configPath, undefined, dataRoot);
  const configWriter = new ConfigWriter(configPath, undefined, '.tmp', dataRoot);
  const configService = new ConfigService(configLoader, configWriter, logger);

  const machineId = configService.getConfig().core.machineId;
  const eventBus = new IpcEventBus();

  const service = createZigbee2mqttServiceWithConfig(eventBus, logger, configService);

  await service.start();
  logger.info('zigbee2mqtt:standalone', `zigbee2mqtt démarré en process séparé (pid ${process.pid}, machine ${machineId})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('zigbee2mqtt:standalone', `Signal ${signal} reçu — arrêt`);
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
  console.error('[zigbee2mqtt:standalone] Échec du démarrage:', error);
  process.exit(1);
});
