/**
 * RpigpioService — orchestrateur de l'application RPIGPIO.
 *
 * Rôle strictement limité au paramétrage (demande utilisateur, 12/08/2026) : stocke les
 * définitions de pins (QUOI/OÙ, numéro de pin, inversion, direction), génère le config.yaml de
 * mqtt-io (generator.ts) et le déploie sur la machine cible (DeployService, SSH + systemctl).
 * Ne lit ni n'écrit jamais de GPIO directement, ne parle pas MQTT — c'est le rôle du process
 * mqtt-io lui-même, sur la machine cible, qui publiera sa découverte sur homeassist/ (repris par
 * le pipeline nommage, comme n'importe quelle source zigbee2mqtt).
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { rpigpioConfigSchema, type RpigpioConfig } from './config-schema';
import { pinsConfigSchema, DEFAULT_PINS_CONFIG, type PinDefinition, type PinsConfigFile } from './storage-schema';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { generateMqttIoConfig, generateComposeFile } from './generator';
import { DeployService } from './DeployService';
import { RPIGPIO_SOCKET_EVENTS, RPIGPIO_CLIENT_EVENTS } from './socket-events';

export interface RpigpioStatus {
  pinsCount: number;
  target: { host: string; containerName: string };
}

export interface IRpigpioService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type SavePinInput = Omit<PinDefinition, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export class RpigpioService implements IRpigpioService {
  private readonly config: RpigpioConfig;
  private readonly pinsManager: ConfigFileManager<PinsConfigFile>;
  private pins: PinDefinition[];
  private readonly deployService: DeployService;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<RpigpioConfig>
  ) {
    this.config = rpigpioConfigSchema.parse(configProvider.getAppConfig());

    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'rpigpio');
    this.pinsManager = new ConfigFileManager<PinsConfigFile>(
      path.join(dataDir, 'rpigpio-pins-v1.0.yaml'),
      pinsConfigSchema,
      DEFAULT_PINS_CONFIG,
      this.logger,
      'pins'
    );
    this.pins = this.pinsManager.load().pins;

    this.deployService = new DeployService(this.logger);

    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<RpigpioConfig>): RpigpioService {
    return new RpigpioService(eventBus, logger, configProvider);
  }

  private setupEventListeners(): void {
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.GET_PINS, () => this.emitPins());
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.SAVE_PIN, (data: unknown) => this.handleSavePin(data as SavePinInput));
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.DELETE_PIN, (data: unknown) => this.handleDeletePin(data as { id: string }));
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.DEPLOY, () => this.handleDeploy());
  }

  async start(): Promise<void> {
    this.logger.info('RpigpioService', 'Démarrage du service rpigpio...');
    this.emitStatus();
    this.emitPins();
    this.logger.info('RpigpioService', 'Service rpigpio démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('RpigpioService', 'Arrêt du service rpigpio');
  }

  // ==========================================================================
  // Pins — CRUD
  // ==========================================================================

  private generatePinId(quoi: string, lieu: string): string {
    const base = this.slugify(`${quoi}_${lieu}`);
    const existing = new Set(this.pins.map((p) => p.id));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private handleSavePin(input: SavePinInput): void {
    try {
      const now = new Date().toISOString();
      let saved: PinDefinition;

      if (input.id) {
        const index = this.pins.findIndex((p) => p.id === input.id);
        if (index === -1) {
          this.emitError(`Pin introuvable: ${input.id}`);
          return;
        }
        saved = { ...this.pins[index], ...input, id: input.id, updatedAt: now };
        this.pins[index] = saved;
      } else {
        saved = {
          ...input,
          id: this.generatePinId(input.quoi, input.lieu),
          createdAt: now,
          updatedAt: now
        };
        this.pins.push(saved);
      }

      const result = this.pinsManager.save({ pins: this.pins });
      if (!result.success) {
        this.emitError(`Échec de sauvegarde: ${result.error}`);
        return;
      }

      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.PIN_SAVED, saved);
      this.emitPins();
      this.emitStatus();
    } catch (error) {
      this.emitError(`Erreur de sauvegarde du pin: ${error instanceof Error ? error.message : error}`);
    }
  }

  private handleDeletePin(data: { id: string }): void {
    const before = this.pins.length;
    this.pins = this.pins.filter((p) => p.id !== data.id);
    if (this.pins.length === before) {
      this.emitError(`Pin introuvable: ${data.id}`);
      return;
    }

    const result = this.pinsManager.save({ pins: this.pins });
    if (!result.success) {
      this.emitError(`Échec de suppression: ${result.error}`);
      return;
    }

    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.PIN_DELETED, { id: data.id });
    this.emitPins();
    this.emitStatus();
  }

  // ==========================================================================
  // Déploiement
  // ==========================================================================

  private async handleDeploy(): Promise<void> {
    try {
      const mqttIoConfigYaml = generateMqttIoConfig(this.config, this.pins);
      const composeYaml = generateComposeFile(this.config);
      const result = await this.deployService.deploy(this.config.target, mqttIoConfigYaml, composeYaml);
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.DEPLOY_RESULT, result);
    } catch (error) {
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.DEPLOY_RESULT, {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // ==========================================================================
  // Émission des événements
  // ==========================================================================

  private emitPins(): void {
    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.PINS_LIST, this.pins);
  }

  private emitStatus(): void {
    const status: RpigpioStatus = {
      pinsCount: this.pins.length,
      target: { host: this.config.target.host, containerName: this.config.target.containerName }
    };
    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.STATUS, status);
  }

  private emitError(message: string): void {
    this.logger.error('RpigpioService', message);
    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.ERROR, { message });
  }
}
