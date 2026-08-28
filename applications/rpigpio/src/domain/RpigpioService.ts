/**
 * RpigpioService — orchestrateur de l'application RPIGPIO.
 *
 * Rôle strictement limité au paramétrage (demande utilisateur, 12/08/2026) : stocke les
 * définitions de pins (QUOI/OÙ, numéro de pin, inversion, direction), génère le config.yaml de
 * mqtt-io (generator.ts) et le déploie sur la machine cible (DeployService, SSH + systemctl).
 * Ne lit ni n'écrit jamais de GPIO directement — c'est le rôle du process mqtt-io lui-même, sur la
 * machine cible, qui publie sa découverte sur homeassist/ (repris par le pipeline nommage, comme
 * n'importe quelle source zigbee2mqtt).
 *
 * ⭐ 16/08/2026 : seule connexion MQTT de ce service — en LECTURE SEULE, uniquement pour suivre la
 * présence de l'agent mqtt-io distant (son propre LWT natif, `<topic_prefix>/status`,
 * "running"/"dead" — voir generator.ts). Toujours pas d'écriture MQTT ni de logique métier via ce
 * canal, qui reste le rôle exclusif de mqtt-io lui-même.
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, RemoteAction } from '../../../core/dist/exports';
import { generateRandomBridgeInstance, MqttTransport, isRunningInDocker, ensureGlobalSshKey } from '../../../core/dist/exports';
import { rpigpioConfigSchema, type RpigpioConfig } from './config-schema';
import { pinsConfigSchema, DEFAULT_PINS_CONFIG, type PinDefinition, type PinsConfigFile } from './storage-schema';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { generateMqttIoConfig, generateComposeFile } from './generator';
import { DeployService } from './DeployService';
import { RPIGPIO_SOCKET_EVENTS, RPIGPIO_CLIENT_EVENTS } from './socket-events';

export interface RpigpioStatus {
  pinsCount: number;
  targets: { id: string; host: string; containerName: string }[];
  /** true si CETTE instance tourne dans un conteneur Docker — voir core/infrastructure/runtime/docker.ts.
   *  Affecte le texte de préparation SSH affiché par cible (TargetCards.js). */
  isRunningInDocker: boolean;
  /** Racine réelle du projet (process.env.PROJECT_ROOT) — utilisée pour le `cd` préalable à
   *  ssh-copy-id hors Docker sur la page Déploiement (TargetCards.js, ⭐ 24/08/2026). */
  projectRoot: string;
  /** Présence de l'agent mqtt-io distant — null tant qu'aucun message n'a encore été reçu du
   *  topic status (ni "running" ni "dead" retenu). */
  agentOnline: boolean | null;
  /** Horodatage ISO de la dernière fois qu'un message de présence a été reçu (quel que soit son
   *  contenu) — permet d'afficher "dernier contact" même si l'agent est actuellement hors ligne. */
  agentLastSeenAt: string | null;
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
  private agentTransport: MqttTransport | null = null;
  private agentOnline: boolean | null = null;
  private agentLastSeenAt: string | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<RpigpioConfig>
  ) {
    this.config = this.loadConfig();

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

  /**
   * ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : `bridgeInstance` absent de la config sur disque
   * → tirage aléatoire généré et persisté immédiatement (pas juste un défaut Zod en mémoire).
   * Contrairement à rfxcom/evoo7/arexx, rpigpio n'avait jusqu'ici AUCUN bridgeInstance — deux
   * instances non reconfigurées à la main partageaient réellement le même topicPrefix/
   * discoveryPrefix mqtt-io (voir generator.ts::generateMqttIoConfig).
   */
  private loadConfig(): RpigpioConfig {
    const raw = this.configProvider.getAppConfig() as Partial<RpigpioConfig>;
    if (!raw.bridgeInstance) {
      const parsed = rpigpioConfigSchema.parse({ ...raw, bridgeInstance: generateRandomBridgeInstance('rpigpio') });
      this.configProvider.savePartialConfig(parsed);
      this.logger.info('RpigpioService', `bridgeInstance généré et persisté au premier démarrage: ${parsed.bridgeInstance}`);
      return parsed;
    }
    return rpigpioConfigSchema.parse(raw);
  }

  private setupEventListeners(): void {
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.GET_PINS, () => this.emitPins());
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.SAVE_PIN, (data: unknown) => this.handleSavePin(data as SavePinInput));
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.DELETE_PIN, (data: unknown) => this.handleDeletePin(data as { id: string }));
    this.eventBus.on(RPIGPIO_CLIENT_EVENTS.REMOTE_OP, (data: unknown) => {
      const { targetId, action } = data as { targetId: string; action: RemoteAction };
      this.handleRemoteOp(targetId, action);
    });
  }

  async start(): Promise<void> {
    this.logger.info('RpigpioService', 'Démarrage du service rpigpio...');
    ensureGlobalSshKey();
    this.connectAgentPresence();
    this.emitStatus();
    this.emitPins();
    this.logger.info('RpigpioService', 'Service rpigpio démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('RpigpioService', 'Arrêt du service rpigpio');
    this.agentTransport?.disconnect();
    this.agentTransport = null;
  }

  // ==========================================================================
  // Présence de l'agent mqtt-io distant (LWT natif mqtt-io, lecture seule)
  // ==========================================================================

  private connectAgentPresence(): void {
    const statusTopic = `${this.config.mqtt.topicPrefix}/${this.config.bridgeInstance}/status`;
    this.agentTransport = new MqttTransport(
      {
        host: this.config.mqtt.host,
        port: this.config.mqtt.port,
        clientId: `rpigpio-presence-${this.config.bridgeInstance}`,
        username: this.config.mqtt.user || '',
        password: this.config.mqtt.password || '',
        keepalive: 60,
        reconnectDelay: 5
      },
      this.logger
    );
    this.agentTransport.onMessage((message) => {
      const payload = Buffer.isBuffer(message.payload) ? message.payload.toString() : message.payload;
      this.agentOnline = payload === 'running';
      this.agentLastSeenAt = new Date().toISOString();
      this.logger.debug('RpigpioService', `Présence agent mqtt-io: ${payload} (${statusTopic})`);
      this.emitStatus();
    });
    this.agentTransport.subscribe(statusTopic, 1);
    this.agentTransport.connect();
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

  /**
   * Point d'entrée unique pour toute intervention distante (protocole uniforme partagé avec
   * teleinfo/arexx, 22-23/08/2026) — une cible précise est toujours désignée par son `targetId`
   * (⭐ multi-cible 23/08/2026 : `rpigpio` ne dépasse jamais 1 cible en pratique, mais le schéma et
   * le protocole restent identiques aux autres apps).
   */
  private async handleRemoteOp(targetId: string, action: RemoteAction): Promise<void> {
    const target = this.config.targets.find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: `Cible introuvable: ${targetId}`
      });
      return;
    }

    // ⭐ 28/08/2026 : évite de rediffuser un config.yml avec un broker MQTT vide — bug réel
    // constaté sur ha2 (mqtt-io-rpigpio en boucle de redémarrage, "empty values not allowed"),
    // cause racine : aucune validation avant ce point ne bloquait un déploiement avec
    // `mqtt.host` resté à son défaut de schéma (chaîne vide).
    if (action === 'deploy' && !this.config.mqtt.host.trim()) {
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: 'Broker MQTT non configuré (mqtt.host vide) — renseigne-le avant de déployer.'
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.deployService.deploy(target, generateMqttIoConfig(this.config, this.pins), generateComposeFile(target))
        : action === 'start'
        ? this.deployService.start(target)
        : action === 'stop'
        ? this.deployService.stop(target)
        : action === 'restart'
        ? this.deployService.restart(target)
        : Promise.resolve({ success: false, error: `Action distante inconnue: ${action}` }));
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.REMOTE_OP_RESULT, { targetId, action, ...result });
    } catch (error) {
      this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
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
      targets: this.config.targets.map((t) => ({ id: t.id, host: t.host, containerName: t.containerName })),
      isRunningInDocker: isRunningInDocker(),
      projectRoot: process.env.PROJECT_ROOT || process.cwd(),
      agentOnline: this.agentOnline,
      agentLastSeenAt: this.agentLastSeenAt
    };
    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.STATUS, status);
  }

  private emitError(message: string): void {
    this.logger.error('RpigpioService', message);
    this.eventBus.emit(RPIGPIO_SOCKET_EVENTS.ERROR, { message });
  }
}
