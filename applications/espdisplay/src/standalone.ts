/**
 * Bootstrap autonome d'espdisplay en process séparé — fonctionnelles-supervisor_specs v2.4 §5.2,
 * Phase 1 (première application migrée). Lancé par ProcessSupervisor (applications/core/src/
 * supervisor/), jamais directement par AppService.startApplicationService() (voir le flag
 * `runsAsSeparateProcess` sur ESPDISPLAY_APP).
 *
 * Se bootstrap intégralement lui-même — lit sa propre config, construit son propre MqttEventBus —
 * exactement comme le fait core/src/index.ts pour l'app entière, mais scopé à cette seule
 * application. `createEspDisplayService()` (domain/index.ts) reste inchangée : c'est ce contrat de
 * factory identique qui permet à ce fichier d'être le seul changement nécessaire pour la migration.
 */

import * as path from 'node:path';
import {
  ConfigLoader,
  ConfigWriter,
  ConfigService,
  createLogger,
  MqttEventBus
} from '../../core/dist/exports';
import { createEspDisplayServiceWithConfig } from './domain';

async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    maxSizeMb: 10,
    maxFiles: 5,
    logDir: process.env.LOG_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'logs')
  });

  // Même racine de config que core (data/core/config.yaml + data/{app}/config.yaml) — c'est ce qui
  // permet de lire à la fois core.machineId/ha.mqtt (partagés) et sa propre section `espdisplay`,
  // en cohérence avec ce que core lui-même voit.
  const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
  const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
  const configLoader = new ConfigLoader(configPath, undefined, dataRoot);
  const configWriter = new ConfigWriter(configPath, undefined, '.tmp', dataRoot);
  const configService = new ConfigService(configLoader, configWriter, logger);

  const config = configService.getConfig();
  const machineId = config.core.machineId;
  const mqttConfig = config.ha?.mqtt;

  if (!mqttConfig) {
    logger.error('espdisplay:standalone', 'ha.mqtt non configuré — impossible de démarrer en process séparé (seul canal de communication), arrêt.');
    process.exit(1);
  }

  const eventBus = new MqttEventBus({
    appId: 'espdisplay',
    machineId,
    mqttConfig: {
      host: mqttConfig.host,
      port: mqttConfig.port,
      username: mqttConfig.username,
      password: mqttConfig.password,
      keepalive: mqttConfig.keepalive,
      reconnectDelay: mqttConfig.reconnect_delay
    },
    logger
  });

  const service = createEspDisplayServiceWithConfig(eventBus, logger, configService);

  await service.start();
  logger.info('espdisplay:standalone', `espdisplay démarré en process séparé (pid ${process.pid}, machine ${machineId})`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('espdisplay:standalone', `Signal ${signal} reçu — arrêt`);
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
  console.error('[espdisplay:standalone] Échec du démarrage:', error);
  process.exit(1);
});
