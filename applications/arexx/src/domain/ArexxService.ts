/**
 * ArexxService
 *
 * Orchestrateur unique de l'application AREXX : démarre le backend d'acquisition sélectionné
 * (push/poll/usb), gère l'auto-découverte des capteurs, publie la découverte/état HA via les
 * événements EventBus génériques du socle (integration:arexx:discovery/state), relayés par
 * IntegrationBridge — même mécanisme que RFXCOM, pas de client MQTT propre à l'application.
 *
 * Contrairement à RfxComService (~1800 lignes, plusieurs sous-managers), AREXX n'a pas de
 * récepteurs/scènes/commandes : un seul service avec un SensorRegistry suffit.
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, EssentialEntityData } from '../../../core/dist/exports';
import { generateRandomBridgeInstance } from '../../../core/dist/exports';
import { arexxConfigSchema, type ArexxConfig } from './config-schema';
import type { ArexxSensorsConfigFile } from './devices-config-schema';
import type { ArexxRawReading, ArexxSensorInfo, ArexxStatus } from './types';
import { SensorRegistry } from './SensorRegistry';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { extractTaxonomy, buildAttributsTaxonomie } from './taxonomy';
import { PushReceiver } from './acquisition/PushReceiver';
import { PollClient } from './acquisition/PollClient';
import { UsbBridge } from './acquisition/UsbBridge';
import { ensureDriversBundle } from './DriversBundle';

const MODULE_NAME = 'arexx';

export interface IArexxService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ArexxStatus;
}

export class ArexxService implements IArexxService {
  /** Au-delà de cet âge, une dernière valeur persistée n'est plus republiée au démarrage (§ voir publishSensorStateAtStartup). */
  private static readonly LAST_VALUE_MAX_AGE_MS = 30 * 60 * 1000;

  private config: ArexxConfig;
  private sensorsConfig: ArexxSensorsConfigFile;
  private configFileManager: ConfigFileManager;
  private sensorRegistry: SensorRegistry;

  private pushReceiver?: PushReceiver;
  private pollClient?: PollClient;
  private usbBridge?: UsbBridge;

  private running = false;
  private lastReadingAt: string | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<ArexxConfig>
  ) {
    this.config = this.loadConfig();
    this.configFileManager = new ConfigFileManager(this.resolveSensorsConfigPath(), this.logger);
    this.sensorsConfig = { arexx_sensors: {} };
    this.sensorRegistry = new SensorRegistry(this.logger);
  }

  /**
   * ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : `bridgeInstance` absent de la config sur disque
   * → tirage aléatoire généré et persisté immédiatement (pas juste un défaut Zod en mémoire).
   * N'affecte pas une instance déjà en production (valeur déjà écrite en dur, jamais régénérée).
   */
  private loadConfig(): ArexxConfig {
    const raw = this.configProvider.getAppConfig() as Partial<ArexxConfig>;
    if (!raw.bridgeInstance) {
      const parsed = arexxConfigSchema.parse({ ...raw, bridgeInstance: generateRandomBridgeInstance('arexx') });
      this.configProvider.savePartialConfig(parsed);
      this.logger.info('ArexxService', `bridgeInstance généré et persisté au premier démarrage: ${parsed.bridgeInstance}`);
      return parsed;
    }
    return arexxConfigSchema.parse(raw);
  }

  private resolveSensorsConfigPath(): string {
    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'arexx');
    return path.join(dataDir, this.config.sensorsConfigFile);
  }

  async start(): Promise<void> {
    this.logger.info('ArexxService', 'Démarrage du service AREXX...');

    this.sensorsConfig = this.configFileManager.load();
    this.sensorRegistry.loadConfigured(this.sensorsConfig.arexx_sensors as Record<string, ArexxSensorInfo>);

    ensureDriversBundle(this.config, this.logger);

    this.setupSocketEventListeners();

    this.eventBus.emitGeneric('integration:bridge:register', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });

    await this.startAcquisition();

    this.publishInitialDiscoveries();
    this.emitStatus();
    this.emitSensorsList();

    this.logger.info('ArexxService', 'Service AREXX démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('ArexxService', 'Arrêt du service AREXX...');
    this.running = false;
    this.pushReceiver?.stop();
    this.pollClient?.stop();
    this.usbBridge?.stop();
    this.eventBus.emitGeneric('integration:bridge:unregister', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });
    this.logger.info('ArexxService', 'Service AREXX arrêté');
  }

  // ==========================================================================
  // Backends d'acquisition (push/poll/usb) — un seul actif à la fois
  // ==========================================================================

  private async startAcquisition(): Promise<void> {
    const onReading = (reading: ArexxRawReading) => this.handleReading(reading);

    switch (this.config.acquisitionMode) {
      case 'usb':
        this.logger.info('ArexxService', 'Mode acquisition: usb (BS500 local)');
        this.pushReceiver = new PushReceiver(this.config, this.logger, onReading);
        this.pushReceiver.start();
        this.usbBridge = new UsbBridge(this.config, this.logger);
        this.usbBridge.start();
        break;
      case 'poll':
        this.logger.info('ArexxService', `Mode acquisition: poll (BS1000 ${this.config.bs1000Address})`);
        this.pollClient = new PollClient(this.config, this.logger, onReading);
        await this.pollClient.start();
        break;
      case 'push':
      default:
        this.logger.info('ArexxService', 'Mode acquisition: push (serveur HTTP local)');
        this.pushReceiver = new PushReceiver(this.config, this.logger, onReading);
        this.pushReceiver.start();
        break;
    }
    this.running = true;
  }

  private handleReading(reading: ArexxRawReading): void {
    this.lastReadingAt = reading.timestamp.toISOString();
    const { uniqueId, isNew } = this.sensorRegistry.handleReading(reading);

    if (isNew) {
      this.eventBus.emitGeneric('arexx:sensor:detected', { uniqueId, kind: reading.kind });
    }

    const sensor = this.sensorRegistry.getSensor(uniqueId);
    if (sensor && sensor.transmitToHa) {
      this.publishSensorState(sensor, reading);
    }
    this.emitSensorsList();
  }

  // ==========================================================================
  // Découverte / état HA (via IntegrationBridge, comme RFXCOM)
  // ==========================================================================

  private publishInitialDiscoveries(): void {
    for (const sensor of this.sensorRegistry.getConfiguredSensors()) {
      if (sensor.transmitToHa) {
        this.publishSensorDiscovery(sensor);
        this.publishSensorStateAtStartup(sensor);
      }
    }
  }

  /**
   * Republie la dernière valeur connue (persistée, `SensorRegistry`) au démarrage/reconnexion,
   * sans attendre une nouvelle lecture. Si cette valeur date de plus de 30 minutes (ou est
   * absente), ne publie rien plutôt qu'un état "unknown" factice — l'entité reste dans l'état
   * "unknown" natif de HA (discovery+attributs déjà publiés) jusqu'à la prochaine lecture réelle.
   */
  private publishSensorStateAtStartup(sensor: ArexxSensorInfo): void {
    const ageMs = sensor.lastSeen ? Date.now() - new Date(sensor.lastSeen).getTime() : Infinity;
    const isFresh = sensor.lastValue !== undefined && ageMs <= ArexxService.LAST_VALUE_MAX_AGE_MS;
    if (!isFresh) return;

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: sensor.uniqueId,
      state: { state: sensor.lastValue as number }
    });
  }

  private publishSensorDiscovery(sensor: ArexxSensorInfo): void {
    const taxonomy = extractTaxonomy(sensor.name);
    const { deviceClass, unit } = this.getComponentForKind(sensor.kind);

    const essential: EssentialEntityData = {
      name: taxonomy.rawQuoi,
      deviceClass,
      unitOfMeasurement: unit,
      // Sans ça, HA compare l'état au JSON complet du topic d'état au lieu d'en extraire `state`
      // — même correctif que RfxComService.publishDeviceDiscovery, bug identique constaté sur HA
      // réel pour les capteurs bruts RFXCOM (erreur "non-numeric value").
      valueTemplate: '{{ value_json.state }}',
      attributsTaxonomie: buildAttributsTaxonomie(taxonomy),
      device: {
        identifiers: [sensor.uniqueId],
        name: `AREXX ${sensor.kind}`,
        manufacturer: 'AREXX',
        model: 'BS1000/BS500',
        suggested_area: taxonomy.nomLieu ?? undefined
      }
    };

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: this.config.bridgeInstance,
      component: 'sensor',
      objectId: sensor.uniqueId,
      deviceId: sensor.uniqueId,
      essential
    });
  }

  private publishSensorState(sensor: ArexxSensorInfo, reading: ArexxRawReading): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: sensor.uniqueId,
      state: {
        state: reading.value,
        attributes: { signal_dbm: reading.signalDbm }
      }
    });
  }

  private getComponentForKind(kind: 'temperature' | 'humidity'): { deviceClass: string; unit: string } {
    return kind === 'humidity'
      ? { deviceClass: 'humidity', unit: '%' }
      : { deviceClass: 'temperature', unit: '°C' };
  }

  // ==========================================================================
  // Statut / événements persistants
  // ==========================================================================

  getStatus(): ArexxStatus {
    return {
      acquisitionMode: this.config.acquisitionMode,
      running: this.running,
      sensorsCount: this.sensorRegistry.getConfiguredSensors().length,
      lastReadingAt: this.lastReadingAt,
      httpservPort: this.config.httpservPort
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('arexx:status', this.getStatus());
  }

  private emitSensorsList(): void {
    this.eventBus.emitGeneric('arexx:sensors:list', {
      configured: this.sensorRegistry.getConfiguredSensors(),
      discovered: this.sensorRegistry.getDiscoveredSensors()
    });
  }

  // ==========================================================================
  // Socket.io (via SocketBridge, EventBus générique)
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('arexx:status:get', () => this.emitStatus());
    this.eventBus.onGeneric('arexx:sensors:list:get', () => this.emitSensorsList());

    this.eventBus.onGeneric<{ uniqueId: string; name: string }>('arexx:sensor:set_name', (data) => {
      const sensor = this.sensorRegistry.setSensorName(data.uniqueId, data.name);
      this.persistSensors();
      this.emitSensorsList();
      if (sensor.transmitToHa) {
        this.publishSensorDiscovery(sensor);
      }
    });

    this.eventBus.onGeneric<{ uniqueId: string; transmitToHa: boolean }>('arexx:sensor:set_transmit', (data) => {
      const sensor = this.sensorRegistry.setTransmitToHa(data.uniqueId, data.transmitToHa);
      this.persistSensors();
      this.emitSensorsList();
      if (sensor && sensor.transmitToHa) {
        this.publishSensorDiscovery(sensor);
      }
    });

    this.eventBus.onGeneric<{ uniqueId: string }>('arexx:sensor:delete', (data) => {
      this.sensorRegistry.deleteSensor(data.uniqueId);
      this.persistSensors();
      this.emitSensorsList();
    });
  }

  private persistSensors(): void {
    const config: ArexxSensorsConfigFile = {
      arexx_sensors: this.sensorRegistry.getConfiguredSensorsRecord()
    };
    const result = this.configFileManager.save(config);
    if (!result.success) {
      this.logger.error('ArexxService', `Échec de sauvegarde de la configuration AREXX: ${result.error}`);
    }
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<ArexxConfig>
  ): ArexxService {
    return new ArexxService(eventBus, logger, configProvider);
  }
}
