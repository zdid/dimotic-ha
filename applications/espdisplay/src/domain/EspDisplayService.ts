/**
 * EspDisplayService — orchestrateur des écrans ESP (ESPHome/LVGL).
 *
 * Écoute l'événement générique `espdisplay:deploy-floorplan` sur l'EventBus partagé (même pattern
 * que ArexxService/Evoo7Service -> IntegrationBridge, voir integration:bridge:register) et exécute
 * le pipeline Python qui génère les widgets, fusionne le YAML ESPHome et lance la compilation dans
 * le conteneur Docker `esphome` — localement si ce service tourne sur la machine qui héberge ce
 * conteneur (falbala), ou via SSH (clé dédiée, commande forcée côté cible) sinon — voir
 * `config.remote` et §6.2 de fonctionnelles-espdisplay_specs. Cas découvert le 14/08/2026 : le
 * bouton HAPLAN "Déployer sur l'écran" échouait depuis ha2 (ENOENT sur python3) — ha2 n'a
 * volontairement ni Python ni le conteneur esphome (Pi4, RAM insuffisante pour ESP-IDF).
 *
 * Pas encore d'OTA automatique après compilation — le flash reste manuel.
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
    const mode = this.config.remote.host
      ? `distant via SSH vers ${this.config.remote.sshUser}@${this.config.remote.host}`
      : `local (pipeline: ${this.pipelineScript})`;
    this.logger.info('EspDisplayService', `Démarrage — exécution ${mode}, conteneur: ${this.config.esphomeContainer}`);
  }

  async stop(): Promise<void> {
    this.logger.info('EspDisplayService', 'Arrêt du service espdisplay');
  }

  private async handleDeployFloorplan(request: EspDisplayDeployRequest): Promise<void> {
    const start = Date.now();
    const label = request.floorplanId ?? 'tous les plans';
    const planArg = request.floorplanId ?? '--all';
    this.logger.info('EspDisplayService', `Déploiement demandé : ${label}`);

    const result = this.config.remote.host
      ? await this.runPipelineRemote(planArg)
      : await this.runPipelineLocal(planArg);
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

  private runPipelineLocal(planArg: string): Promise<{ ok: boolean; message: string }> {
    const args = [
      this.pipelineScript,
      planArg,
      '--compile',
      '--esphome-container', this.config.esphomeContainer,
      '--esphome-config-dir', this.config.esphomeConfigDir
    ];
    return this.runProcess(this.config.pythonBin, args);
  }

  /**
   * Exécution à distance (SSH, clé dédiée) — nécessaire quand ce service tourne sur une machine
   * sans conteneur esphome ni python3 (ex: ha2, voir config-schema.ts). Un seul argument envoyé
   * (l'identifiant de plan, ou "--all") : la cible fait tourner une COMMANDE FORCÉE
   * (~/bin/espdisplay-agent-run.sh, voir en-tête du fichier) qui reconstruit elle-même l'appel
   * complet du pipeline — cette clé ne permet donc rien d'autre que ce pipeline précis.
   *
   * `UserKnownHostsFile` pointé vers data/espdisplay/ (volume persisté, voir compose.yaml) plutôt
   * que le défaut ($HOME, jamais persisté sur ce conteneur — voir Dockerfile "pas de volume nommé
   * sur /app") : sans ça, la clé hôte de la cible ne serait jamais mémorisée d'un redémarrage de
   * conteneur à l'autre. `accept-new` = confiance au premier contact (TOFU), mais rejette bien un
   * changement ultérieur de clé hôte (utile si jamais compromis) — pas un simple désactivation de
   * la vérification. Découvert en testant en conditions réelles le 14/08/2026 ("Host key
   * verification failed" depuis le conteneur ha2 vers falbala).
   */
  private runPipelineRemote(planArg: string): Promise<{ ok: boolean; message: string }> {
    const target = this.config.remote;
    const knownHostsPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'espdisplay', 'known_hosts');
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHostsPath}`
    ];
    if (target.sshKeyPath) args.push('-i', target.sshKeyPath);
    args.push(`${target.sshUser}@${target.host}`, planArg);
    return this.runProcess('ssh', args);
  }

  private runProcess(command: string, args: string[]): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      proc.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      proc.on('error', (error) => {
        resolve({ ok: false, message: `Impossible de lancer ${command} : ${error.message}` });
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
