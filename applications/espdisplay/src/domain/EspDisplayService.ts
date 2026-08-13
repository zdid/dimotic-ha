/**
 * EspDisplayService — orchestrateur des écrans ESP (ESPHome/LVGL).
 *
 * Écoute l'événement générique `espdisplay:deploy-floorplan` sur l'EventBus partagé (même pattern
 * que ArexxService/Evoo7Service -> IntegrationBridge, voir integration:bridge:register) et exécute
 * en sous-processus le pipeline Python qui génère les widgets, fusionne le YAML ESPHome et lance
 * la compilation dans le conteneur Docker `esphome` déjà en service sur cette machine.
 *
 * Volontairement minimal pour l'instant (13/08/2026) : pas encore de déclenchement depuis l'UI
 * HAPLAN, pas encore d'OTA automatique après compilation — juste le mécanisme de base (écoute,
 * exécution, remontée du résultat), sur lequel brancher la suite une fois validé.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { espDisplayConfigSchema, type EspDisplayConfig } from './config-schema';

export interface EspDisplayDeployRequest {
  /** Identifiant du plan HAPLAN à déployer (ex: "original"), ou omis pour --all. */
  floorplanId?: string;
}

export interface EspDisplayDeployResult {
  floorplanId?: string;
  ok: boolean;
  message: string;
  durationMs: number;
}

export interface IEspDisplayService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const ESPDISPLAY_EVENTS = {
  DEPLOY_FLOORPLAN: 'espdisplay:deploy-floorplan',
  DEPLOY_RESULT: 'espdisplay:deploy-result'
} as const;

export class EspDisplayService implements IEspDisplayService {
  private readonly config: EspDisplayConfig;
  private readonly pipelineScript: string;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<EspDisplayConfig>
  ) {
    this.config = espDisplayConfigSchema.parse(configProvider.getAppConfig());
    this.pipelineScript = this.resolvePipelineScript();
    this.setupEventListeners();
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<EspDisplayConfig>
  ): EspDisplayService {
    return new EspDisplayService(eventBus, logger, configProvider);
  }

  private resolvePipelineScript(): string {
    if (this.config.pipelineScriptPath) {
      return this.config.pipelineScriptPath;
    }
    const projectRoot = process.env.PROJECT_ROOT || process.cwd();
    return path.join(projectRoot, 'applications', 'haplan', 'tools', 'generate_esphome_floorplan.py');
  }

  private setupEventListeners(): void {
    this.eventBus.onGeneric<EspDisplayDeployRequest>(ESPDISPLAY_EVENTS.DEPLOY_FLOORPLAN, (payload) => {
      this.handleDeployFloorplan(payload ?? {}).catch((error) => {
        this.logger.error('EspDisplayService', `Échec du déploiement : ${error}`);
      });
    });
  }

  async start(): Promise<void> {
    this.logger.info('EspDisplayService', `Démarrage — pipeline: ${this.pipelineScript}, conteneur: ${this.config.esphomeContainer}`);
  }

  async stop(): Promise<void> {
    this.logger.info('EspDisplayService', 'Arrêt du service espdisplay');
  }

  private async handleDeployFloorplan(request: EspDisplayDeployRequest): Promise<void> {
    const start = Date.now();
    const label = request.floorplanId ?? 'tous les plans';
    this.logger.info('EspDisplayService', `Déploiement demandé : ${label}`);

    const args = [
      this.pipelineScript,
      ...(request.floorplanId ? [request.floorplanId] : ['--all']),
      '--compile',
      '--esphome-container', this.config.esphomeContainer,
      '--esphome-config-dir', this.config.esphomeConfigDir
    ];

    const result = await this.runPipeline(args);
    const durationMs = Date.now() - start;

    const deployResult: EspDisplayDeployResult = {
      floorplanId: request.floorplanId,
      ok: result.ok,
      message: result.message,
      durationMs
    };

    if (result.ok) {
      this.logger.info('EspDisplayService', `Déploiement réussi (${label}, ${durationMs}ms)`);
    } else {
      this.logger.error('EspDisplayService', `Échec du déploiement (${label}, ${durationMs}ms) : ${result.message}`);
    }

    this.eventBus.emitGeneric<EspDisplayDeployResult>(ESPDISPLAY_EVENTS.DEPLOY_RESULT, deployResult);
  }

  private runPipeline(args: string[]): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      proc.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      proc.on('error', (error) => {
        resolve({ ok: false, message: `Impossible de lancer ${this.config.pythonBin} : ${error.message}` });
      });

      proc.on('close', (code) => {
        const tail = output.trim().split('\n').slice(-20).join('\n');
        resolve({
          ok: code === 0,
          message: code === 0 ? tail : `Code de sortie ${code}\n${tail}`
        });
      });
    });
  }
}
