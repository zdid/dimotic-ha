// src/ha/integration/__tests__/IntegrationBridge.test.ts
// Tests unitaires pour IntegrationBridge
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegrationBridge } from '../IntegrationBridge';
import { EventBus } from '../../../application/EventBus';
import { Logger } from '../../../infrastructure/logger/index';
import type { ConfigService } from '../../../infrastructure/config/ConfigService';
import type { AppConfig } from '../../../infrastructure/config/schema';

// Mock du transport MQTT bas niveau : évite toute connexion réseau réelle.
// HaMqttIntegrationService (et donc IntegrationBridge) restent testés avec leur vrai code.
// vi.mock() est hoisté en haut du fichier : la classe doit donc être créée via vi.hoisted()
// pour être accessible depuis la factory (cf. https://vitest.dev/api/vi.html#vi-hoisted).
const { MockMqttTransport, mockTransportInstances } = vi.hoisted(() => {
  const mockTransportInstances: InstanceType<typeof MockMqttTransport>[] = [];

  class MockMqttTransport {
    connected = false;
    publishSpy = vi.fn();
    subscribeSpy = vi.fn();
    private connectCallbacks: Array<() => void> = [];
    private disconnectCallbacks: Array<(reason?: string) => void> = [];
    private messageCallbacks: Array<(msg: { topic: string; payload: string; qos: number; retain: boolean }) => void> = [];

    constructor(public config: { clientId: string; willTopic?: string }) {
      mockTransportInstances.push(this);
    }

    connect(): void {
      this.connected = true;
      this.connectCallbacks.forEach((cb) => cb());
    }

    disconnect(): void {
      this.connected = false;
      this.disconnectCallbacks.forEach((cb) => cb('test disconnect'));
    }

    publish(...args: unknown[]): void {
      this.publishSpy(...args);
    }

    subscribe(...args: unknown[]): void {
      this.subscribeSpy(...args);
    }

    /** Simule la réception d'un message MQTT (utilisé par les tests de routage de commandes). */
    simulateIncomingMessage(topic: string, payload: string): void {
      this.messageCallbacks.forEach((cb) => cb({ topic, payload, qos: 1, retain: false }));
    }

    onMessage(cb: (msg: { topic: string; payload: string; qos: number; retain: boolean }) => void): void {
      this.messageCallbacks.push(cb);
    }
    onConnect(cb: () => void): void {
      this.connectCallbacks.push(cb);
    }
    onDisconnect(cb: (reason?: string) => void): void {
      this.disconnectCallbacks.push(cb);
    }
    onError(): void {}
    getConnected(): boolean {
      return this.connected;
    }
    publishStatus(_online: boolean): void {}
  }

  return { MockMqttTransport, mockTransportInstances };
});

vi.mock('../../../infrastructure/transport/MqttTransport', () => ({
  MqttTransport: MockMqttTransport,
}));

// =============================================================================
// Fixtures
// =============================================================================

function createConfigService(mqttEnable: boolean): ConfigService {
  const config: Partial<AppConfig> = {
    ha: {
      ws_enable: false,
      mqtt_enable: mqttEnable,
      mqtt: {
        host: 'localhost',
        port: 1883,
        client_id: 'core',
        username: '',
        password: '',
        keepalive: 60,
        reconnect_delay: 5,
      },
      structure: { include_unassigned: false, unassigned_label: 'Non assigné' },
    },
    web: { port: 8080, host: '0.0.0.0' },
    logging: { level: 'debug', rotate: { max_size_mb: 1, max_files: 1 } },
  };

  return {
    getConfig: vi.fn().mockReturnValue(config),
    getMqttConfig: vi.fn().mockReturnValue(config.ha?.mqtt),
  } as unknown as ConfigService;
}

describe('IntegrationBridge', () => {
  let bridge: IntegrationBridge;
  let eventBus: EventBus;
  let logger: Logger;

  beforeEach(() => {
    mockTransportInstances.length = 0;
    eventBus = new EventBus();
    logger = new Logger({ level: 'debug', maxSizeMb: 1, maxFiles: 1, logDir: '/tmp/test-logs' });
  });

  // =========================================================================
  // Initialisation
  // =========================================================================

  describe('Initialisation', () => {
    it('lit ha.mqtt_enable depuis la config au démarrage', () => {
      const bridgeEnabled = new IntegrationBridge(eventBus, logger, createConfigService(true));
      const bridgeDisabled = new IntegrationBridge(eventBus, logger, createConfigService(false));

      expect(bridgeEnabled.isMqttEnabled()).toBe(true);
      expect(bridgeDisabled.isMqttEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // Enregistrement de bridge_instance
  // =========================================================================

  describe('Enregistrement de bridge', () => {
    it('connecte immédiatement un bridge enregistré quand MQTT est activé', () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });

      expect(mockTransportInstances).toHaveLength(1);
      expect(mockTransportInstances[0].connected).toBe(true);
      expect(bridge.isBridgeConnected('rfxcom', 'rfx_bridge_0001')).toBe(true);
    });

    it("n'ouvre pas de connexion quand MQTT est désactivé, mais garde le bridge enregistré", () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(false));
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });

      expect(mockTransportInstances).toHaveLength(0);
      expect(bridge.isBridgeConnected('rfxcom', 'rfx_bridge_0001')).toBe(false);
    });

    it('chaque bridge_instance obtient sa propre connexion MQTT (clientId distinct)', () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });
      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0002' });

      expect(mockTransportInstances).toHaveLength(2);
      expect(mockTransportInstances[0].config.clientId).toBe('rfxcom-rfx_bridge_0001');
      expect(mockTransportInstances[1].config.clientId).toBe('rfxcom-rfx_bridge_0002');
      expect(mockTransportInstances[0].config.willTopic).toBe('rfxcom/rfx_bridge_0001/status');
      expect(mockTransportInstances[1].config.willTopic).toBe('rfxcom/rfx_bridge_0002/status');
    });

    it('désenregistrer un bridge le déconnecte', () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });
      eventBus.emitGeneric('integration:bridge:unregister', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });

      expect(mockTransportInstances[0].connected).toBe(false);
      expect(bridge.isBridgeConnected('rfxcom', 'rfx_bridge_0001')).toBe(false);
    });
  });

  // =========================================================================
  // Toggle dynamique de ha.mqtt_enable
  // =========================================================================

  describe('Toggle dynamique via config:save:result', () => {
    it('connecte tous les bridges enregistrés quand mqtt_enable passe à true', () => {
      const configService = createConfigService(false);
      bridge = new IntegrationBridge(eventBus, logger, configService);
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });
      expect(mockTransportInstances).toHaveLength(0);

      // Simuler le changement de config
      (configService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ha: { mqtt_enable: true, mqtt: { host: 'localhost', port: 1883, client_id: 'core', username: '', password: '', keepalive: 60, reconnect_delay: 5 } },
      });
      eventBus.emitGeneric('config:save:result', { success: true });

      expect(bridge.isMqttEnabled()).toBe(true);
      expect(mockTransportInstances).toHaveLength(1);
      expect(mockTransportInstances[0].connected).toBe(true);
    });

    it('déconnecte tous les bridges quand mqtt_enable passe à false', () => {
      const configService = createConfigService(true);
      bridge = new IntegrationBridge(eventBus, logger, configService);
      bridge.initialize();

      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });
      expect(mockTransportInstances[0].connected).toBe(true);

      (configService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ha: { mqtt_enable: false, mqtt: { host: 'localhost', port: 1883, client_id: 'core', username: '', password: '', keepalive: 60, reconnect_delay: 5 } },
      });
      eventBus.emitGeneric('config:save:result', { success: true });

      expect(bridge.isMqttEnabled()).toBe(false);
      expect(mockTransportInstances[0].connected).toBe(false);
    });

    it('ignore un config:save:result en échec', () => {
      const configService = createConfigService(false);
      bridge = new IntegrationBridge(eventBus, logger, configService);
      bridge.initialize();

      eventBus.emitGeneric('config:save:result', { success: false, error: 'Validation failed' });

      expect(bridge.isMqttEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // Découverte / État / Passthrough
  // =========================================================================

  describe('Découverte, état et passthrough', () => {
    beforeEach(() => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();
      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });
    });

    it('publie une découverte normalisée à partir des données essentielles', () => {
      eventBus.emitGeneric('integration:rfxcom:discovery', {
        bridgeInstance: 'rfx_bridge_0001',
        component: 'sensor',
        objectId: 'rfxsensor_0xa5b3',
        deviceId: 'rfxsensor_ac__0xa5b3',
        essential: { name: 'Température Salon', deviceClass: 'temperature', unitOfMeasurement: '°C' },
      });

      // fonctionnelles-supervisor_specs v2.3 §9.3 : bridgeInstance en node_id du topic de découverte
      // — l'ancien topic (sans node_id) est nettoyé (payload vide) à chaque publication, pour ne
      // pas laisser de message retenu orphelin sur une instance déjà en production.
      expect(mockTransportInstances[0].publishSpy).toHaveBeenNthCalledWith(
        1,
        'homeassistant/sensor/rfxsensor_0xa5b3/config',
        '',
        1,
        true
      );
      expect(mockTransportInstances[0].publishSpy).toHaveBeenNthCalledWith(
        2,
        'homeassistant/sensor/rfx_bridge_0001/rfxsensor_0xa5b3/config',
        expect.stringContaining('"state_topic":"rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/state"'),
        1,
        true
      );
    });

    it('publie un changement d\'état sur le topic bridge_instance/deviceId', () => {
      eventBus.emitGeneric('integration:rfxcom:state', {
        bridgeInstance: 'rfx_bridge_0001',
        deviceId: 'rfxsensor_ac__0xa5b3',
        state: { state: '22.5' },
      });

      expect(mockTransportInstances[0].publishSpy).toHaveBeenCalledWith(
        'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/state',
        JSON.stringify({ state: '22.5' }),
        1,
        true
      );
    });

    it('passthrough découverte réécrit le préfixe du topic source', () => {
      eventBus.emitGeneric('integration:rfxcom:passthrough:discovery', {
        bridgeInstance: 'rfx_bridge_0001',
        sourceTopic: 'homeassist/sensor/temp_salon/config',
        payload: { name: 'Température Salon' },
      });

      expect(mockTransportInstances[0].publishSpy).toHaveBeenCalledWith(
        'homeassistant/sensor/temp_salon/config',
        JSON.stringify({ name: 'Température Salon' }),
        1,
        true
      );
    });

    it('passthrough complet publie topic et payload sans transformation', () => {
      eventBus.emitGeneric('integration:rfxcom:passthrough:publish', {
        bridgeInstance: 'rfx_bridge_0001',
        topic: 'rfxcom/custom/topic',
        payload: { raw: true },
        qos: 0,
        retain: false,
      });

      expect(mockTransportInstances[0].publishSpy).toHaveBeenCalledWith(
        'rfxcom/custom/topic',
        JSON.stringify({ raw: true }),
        0,
        false
      );
    });

    it("n'écrit rien si MQTT est désactivé au moment de l'événement", () => {
      // EventBus dédié : évite toute interférence avec le `bridge` du beforeEach
      // de ce describe, qui écoute déjà sur `eventBus` partagé.
      const localEventBus = new EventBus();
      const configService = createConfigService(true);
      const localBridge = new IntegrationBridge(localEventBus, logger, configService);
      localBridge.initialize();
      localEventBus.emitGeneric('integration:bridge:register', { moduleName: 'nommage', bridgeInstance: 'main' });

      (configService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ha: { mqtt_enable: false, mqtt: { host: 'localhost', port: 1883, client_id: 'core', username: '', password: '', keepalive: 60, reconnect_delay: 5 } },
      });
      localEventBus.emitGeneric('config:save:result', { success: true });

      const publishCallsBefore = mockTransportInstances.map((t) => t.publishSpy.mock.calls.length);
      localEventBus.emitGeneric('integration:nommage:state', {
        bridgeInstance: 'main',
        deviceId: 'x',
        state: { state: 'on' },
      });
      const publishCallsAfter = mockTransportInstances.map((t) => t.publishSpy.mock.calls.length);

      expect(publishCallsAfter).toEqual(publishCallsBefore);
    });
  });

  // =========================================================================
  // Commandes reçues
  // =========================================================================

  describe('Commandes reçues', () => {
    it('route une commande entrante vers integration:{module}:command', () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();
      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });

      const received: unknown[] = [];
      eventBus.onGeneric('integration:rfxcom:command', (data) => received.push(data));

      mockTransportInstances[0].simulateIncomingMessage(
        'rfxcom/rfx_bridge_0001/device1/set',
        JSON.stringify({ state: 'on' })
      );

      expect(received).toEqual([
        {
          moduleName: 'rfxcom',
          bridgeInstance: 'rfx_bridge_0001',
          deviceId: 'device1',
          command: { state: 'on' },
        },
      ]);
    });

    it('ignore un message sur un topic qui ne correspond pas au format de commande', () => {
      bridge = new IntegrationBridge(eventBus, logger, createConfigService(true));
      bridge.initialize();
      eventBus.emitGeneric('integration:bridge:register', { moduleName: 'rfxcom', bridgeInstance: 'rfx_bridge_0001' });

      const received: unknown[] = [];
      eventBus.onGeneric('integration:rfxcom:command', (data) => received.push(data));

      mockTransportInstances[0].simulateIncomingMessage('homeassistant/sensor/x/state', '{}');

      expect(received).toHaveLength(0);
    });
  });
});
