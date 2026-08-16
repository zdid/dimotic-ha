/**
 * Bootstrap autonome de rpigpio en process séparé — fonctionnelles-supervisor_specs v2.6 §5.2,
 * Phase 2 (deuxième application migrée, après espdisplay). Lancé par ProcessSupervisor
 * (applications/core/src/supervisor/), jamais directement par AppService.startApplicationService()
 * (voir le flag `runsAsSeparateProcess` sur RPIGPIO_APP).
 *
 * Se bootstrap intégralement lui-même — lit sa propre config, construit son propre IpcEventBus
 * (16/08/2026 : IPC via le canal `stdio: [...,'ipc']` que ProcessSupervisor établit au spawn,
 * remplace MqttEventBus — plus besoin de `ha.mqtt` pour ce canal, l'app reste sur cette machine).
 * `createRpigpioServiceWithConfig()` (domain/index.ts) reste inchangée : c'est ce contrat de
 * factory identique qui permet à ce fichier d'être le seul changement nécessaire pour la migration.
 */

import * as path from 'node:path';
import {
  ConfigLoader,
  ConfigWriter,
  ConfigService,
  createLogger,
  IpcEventBus
} from '../../core/dist/exports';
import { createRpigpioServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs')
  });

  // Même racine de config que core (data/core/config.yaml + data/{app}/config.yaml) — c'est ce qui
  // permet de lire à la fois core.machineId (juste informatif ici) et sa propre section `rpigpio`,
  // en cohérence avec ce que core lui-même voit.
  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configLoader = new ConfigLoader(configPath, undefined, dataRoot);
  const configWriter = new ConfigWriter(configPath, undefined, '.tmp', dataRoot);
  const configService = new ConfigService(configLoader, configWriter, logger);

  const machineId = configService.getConfig().core.machineId;
  const eventBus = new IpcEventBus();

  const service = createRpigpioServiceWithConfig(eventBus, logger, configService);

  await service.start();
  logger.info('rpigpio:standalone', `rpigpio démarré en process séparé (pid ${process.pid}, machine ${machineId})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('rpigpio:standalone', `Signal ${signal} reçu — arrêt`);
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
  console.error('[rpigpio:standalone] Échec du démarrage:', error);
  process.exit(1);
});
