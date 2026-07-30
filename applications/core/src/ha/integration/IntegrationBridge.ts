// =============================================================================
// IntegrationBridge — Orchestrateur EventBus ↔ HaMqttIntegrationService
//
// Écoute les événements des modules d'intégration (découverte, état, commandes,
// passthrough) et pilote HaMqttIntegrationService en conséquence. Gère
// l'activation/désactivation dynamique via `ha.mqtt_enable`.
//
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5 et integrationbridge-mqtt-auto_specs.
// =============================================================================

import type { IEventBus } from '../../application/IEventBus';
import type { Logger } from '../../infrastructure/logger/index';
import type { ConfigService } from '../../infrastructure/config/ConfigService';
import { HaMqttIntegrationService, type HaMqttBrokerConfig } from './HaMqttIntegrationService';
import type { EssentialEntityData } from './discovery';
import type { HaMqttStateMessage } from './types/ha-mqtt';
import type { AreaEnsureService } from '../sync/AreaEnsureService';

// =============================================================================
// Types des événements EventBus (voir techniques-socle-ha-mqtt_specs §8.5.5)
// =============================================================================

export interface BridgeRegisterEvent {
  moduleName: string;
  bridgeInstance: string;
}

export interface DiscoveryRequestEvent {
  bridgeInstance: string;
  component: string;
  objectId: string;
  deviceId: string;
  essential: EssentialEntityData;
}

export interface DiscoveryRemoveRequestEvent {
  bridgeInstance: string;
  component: string;
  objectId: string;
}

export interface StateRequestEvent {
  bridgeInstance: string;
  deviceId: string;
  state: HaMqttStateMessage;
}

export interface PassthroughDiscoveryRequestEvent {
  bridgeInstance: string;
  sourceTopic: string;
  payload: unknown;
}

export interface PassthroughPublishRequestEvent {
  bridgeInstance: string;
  topic: string;
  payload: unknown;
  qos?: 0 | 1;
  retain?: boolean;
}

interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// IntegrationBridge
// =============================================================================

export class IntegrationBridge {
  private readonly eventBus: IEventBus;
  private readonly logger: Logger;
  private readonly configService: ConfigService;
  private readonly haMqttService: HaMqttIntegrationService;
  private mqttEnabled: boolean;
  /** Optionnel : absent si ha.ws_enable est désactivé (Mode A/B indépendants) — voir attachAreaEnsureService. */
  private areaEnsureService?: AreaEnsureService;

  /** Bridges enregistrés par les modules, indépendamment de l'état connecté/déconnecté. */
  private registeredBridges: Map<string, BridgeRegisterEvent> = new Map();

  constructor(eventBus: IEventBus, logger: Logger, configService: ConfigService) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.configService = configService;
    this.haMqttService = new HaMqttIntegrationService(logger);
    this.mqttEnabled = this.configService.getConfig().ha?.mqtt_enable === true;

    this.logger.info('bridge', this.mqttEnabled ? 'MQTT est ACTIF (ha.mqtt_enable: true)' : 'MQTT est DESACTIVE (ha.mqtt_enable: false)');
  }

  /**
   * Attache le service de garantie d'area HA — optionnel, absent si ha.ws_enable est désactivé
   * (Mode A, indépendant du Mode B/MQTT ici). Sans lui, device.suggested_area en découverte reste
   * sans effet (comportement inchangé). Doit être appelé après la création du HaWsClient/
   * HaStructureRegistry, avant toute découverte.
   */
  attachAreaEnsureService(areaEnsureService: AreaEnsureService): void {
    this.areaEnsureService = areaEnsureService;
    this.logger.info('bridge', 'AreaEnsureService attaché');
  }

  /**
   * Configure les listeners EventBus. À appeler une fois au démarrage.
   */
  initialize(): void {
    this.eventBus.onGeneric<BridgeRegisterEvent>('integration:bridge:register', (data) => this.handleBridgeRegister(data));
    this.eventBus.onGeneric<BridgeRegisterEvent>('integration:bridge:unregister', (data) => this.handleBridgeUnregister(data));
    this.eventBus.onGeneric<ConfigSaveResult>('config:save:result', (result) => this.handleConfigSaveResult(result));

    this.haMqttService.onCommand((command) => {
      this.eventBus.emitGeneric(`integration:${command.moduleName}:command`, command);
    });

    this.haMqttService.onConnectionChange((moduleName, bridgeInstance, connected) => {
      this.eventBus.emitGeneric(`integration:${moduleName}:bridge:connection`, { bridgeInstance, connected });
    });

    this.logger.info('bridge', 'IntegrationBridge initialisé');
  }

  /**
   * Enregistre un bridge_instance pour un module et écoute ses événements de
   * découverte/état/passthrough. Connecte immédiatement si MQTT est activé.
   */
  private handleBridgeRegister(data: BridgeRegisterEvent): void {
    const key = `${data.moduleName}:${data.bridgeInstance}`;
    if (this.registeredBridges.has(key)) {
      this.logger.debug('bridge', `Bridge déjà enregistré: ${key}`);
      return;
    }

    this.registeredBridges.set(key, data);
    this.subscribeModuleEvents(data.moduleName);

    if (this.mqttEnabled) {
      this.connectBridge(data);
    } else {
      this.logger.debug('bridge', `Bridge enregistré mais MQTT désactivé: ${key}`);
    }
  }

  private handleBridgeUnregister(data: BridgeRegisterEvent): void {
    const key = `${data.moduleName}:${data.bridgeInstance}`;
    this.registeredBridges.delete(key);
    this.haMqttService.disconnectBridge(data.moduleName, data.bridgeInstance);
  }

  /**
   * S'abonne, pour un module donné, à ses événements de découverte/état/passthrough.
   */
  private subscribeModuleEvents(moduleName: string): void {
    this.eventBus.onGeneric<DiscoveryRequestEvent>(`integration:${moduleName}:discovery`, (data) => {
      if (!this.mqttEnabled) return;
      void this.publishDiscoveryWithArea(moduleName, data);
    });

    this.eventBus.onGeneric<DiscoveryRemoveRequestEvent>(`integration:${moduleName}:discovery:remove`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.removeDiscoveryFor(moduleName, data.bridgeInstance, data.component, data.objectId);
    });

    this.eventBus.onGeneric<StateRequestEvent>(`integration:${moduleName}:state`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.publishState(moduleName, data.bridgeInstance, data.deviceId, data.state);
    });

    this.eventBus.onGeneric<PassthroughDiscoveryRequestEvent>(`integration:${moduleName}:passthrough:discovery`, (data) => {
      if (!this.mqttEnabled) return;
      void this.publishDiscoveryPassthroughWithArea(moduleName, data);
    });

    this.eventBus.onGeneric<PassthroughPublishRequestEvent>(`integration:${moduleName}:passthrough:publish`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.publishPassthrough(moduleName, data.bridgeInstance, data.topic, data.payload, data.qos, data.retain);
    });
  }

  /**
   * Garantit l'area suggérée (best-effort, voir AreaEnsureService) avant de publier la
   * découverte — jamais bloquant : un échec/dépassement n'empêche jamais la publication.
   */
  private async publishDiscoveryWithArea(moduleName: string, data: DiscoveryRequestEvent): Promise<void> {
    if (this.areaEnsureService) {
      const suggestedArea = data.essential.device?.suggested_area;
      if (suggestedArea) {
        await this.areaEnsureService.ensureArea(suggestedArea);
      }
    }
    this.haMqttService.publishDiscoveryFor(moduleName, data.bridgeInstance, data.component, data.objectId, data.deviceId, data.essential);
  }

  /** Même garantie d'area que publishDiscoveryWithArea, pour le chemin passthrough (NOMMAGE). */
  private async publishDiscoveryPassthroughWithArea(moduleName: string, data: PassthroughDiscoveryRequestEvent): Promise<void> {
    if (this.areaEnsureService) {
      const payload = data.payload as { device?: { suggested_area?: string } } | undefined;
      const suggestedArea = payload?.device?.suggested_area;
      if (suggestedArea) {
        await this.areaEnsureService.ensureArea(suggestedArea);
      }
    }
    this.haMqttService.publishDiscoveryPassthrough(moduleName, data.bridgeInstance, data.sourceTopic, data.payload);
  }

  /**
   * Gère un changement de configuration : détecte un changement de `ha.mqtt_enable`.
   */
  private handleConfigSaveResult(result: ConfigSaveResult): void {
    if (!result.success) {
      this.logger.warn('bridge', `Sauvegarde config échouée: ${result.error}`);
      return;
    }

    const newMqttEnable = this.configService.getConfig().ha?.mqtt_enable === true;
    if (newMqttEnable !== this.mqttEnabled) {
      this.logger.info('bridge', `ha.mqtt_enable a changé: ${this.mqttEnabled} -> ${newMqttEnable}`);
      this.toggleMqtt(newMqttEnable);
    }
  }

  /**
   * Active ou désactive MQTT dynamiquement pour tous les bridges enregistrés.
   */
  private toggleMqtt(enable: boolean): void {
    this.mqttEnabled = enable;

    if (enable) {
      this.logger.info('bridge', `Activation de MQTT — connexion de ${this.registeredBridges.size} bridge(s) enregistré(s)`);
      for (const registration of this.registeredBridges.values()) {
        this.connectBridge(registration);
      }
    } else {
      this.logger.info('bridge', 'Désactivation de MQTT — déconnexion de tous les bridges');
      for (const registration of this.registeredBridges.values()) {
        this.haMqttService.disconnectBridge(registration.moduleName, registration.bridgeInstance);
      }
    }
  }

  private connectBridge(registration: BridgeRegisterEvent): void {
    const broker = this.getBrokerConfig();
    if (!broker) {
      this.logger.warn('bridge', 'Impossible de connecter le bridge : configuration ha.mqtt absente');
      return;
    }

    this.haMqttService
      .connectBridge(registration.moduleName, registration.bridgeInstance, broker)
      .catch((error) => {
        this.logger.error('bridge', `Échec de connexion du bridge ${registration.moduleName}:${registration.bridgeInstance}: ${error}`);
      });
  }

  private getBrokerConfig(): HaMqttBrokerConfig | undefined {
    const mqttConfig = this.configService.getMqttConfig();
    if (!mqttConfig) return undefined;

    return {
      host: mqttConfig.host,
      port: mqttConfig.port,
      username: mqttConfig.username || undefined,
      password: mqttConfig.password || undefined,
      keepalive: mqttConfig.keepalive,
      reconnectDelay: mqttConfig.reconnect_delay,
    };
  }

  // ===========================================================================
  // Getters publics
  // ===========================================================================

  isMqttEnabled(): boolean {
    return this.mqttEnabled;
  }

  isBridgeConnected(moduleName: string, bridgeInstance: string): boolean {
    return this.haMqttService.isBridgeConnected(moduleName, bridgeInstance);
  }

  getHaMqttService(): HaMqttIntegrationService {
    return this.haMqttService;
  }
}
