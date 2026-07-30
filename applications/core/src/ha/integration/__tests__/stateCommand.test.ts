// src/ha/integration/__tests__/stateCommand.test.ts
// Tests unitaires pour stateCommand.ts (fonctions pures)
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.4

import { describe, it, expect, vi } from 'vitest';
import { publishState, subscribeCommands, parseIncomingCommand } from '../stateCommand';
import type { MqttTransport, MqttMessage } from '../../../infrastructure/transport/MqttTransport';

describe('publishState', () => {
  it('publie sur le topic /{moduleName}/{bridgeInstance}/{deviceId}/state en QoS1/retain par défaut', () => {
    const publishSpy = vi.fn();
    const transport = { publish: publishSpy } as unknown as MqttTransport;

    publishState(transport, 'rfxcom', 'rfx_bridge_0001', 'rfxsensor_ac__0xa5b3', { state: '22.5' });

    expect(publishSpy).toHaveBeenCalledWith(
      'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/state',
      JSON.stringify({ state: '22.5' }),
      1,
      true
    );
  });
});

describe('subscribeCommands', () => {
  it("s'abonne au topic /{moduleName}/{bridgeInstance}/{deviceId}/set", () => {
    const subscribeSpy = vi.fn();
    const transport = { subscribe: subscribeSpy } as unknown as MqttTransport;

    subscribeCommands(transport, 'rfxcom', 'rfx_bridge_0001', 'rfxsensor_ac__0xa5b3');

    expect(subscribeSpy).toHaveBeenCalledWith('rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/set', 1);
  });
});

describe('parseIncomingCommand', () => {
  it('parse un topic de commande valide (payload string)', () => {
    const message: MqttMessage = {
      topic: 'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/set',
      payload: JSON.stringify({ state: 'on' }),
      qos: 1,
      retain: false,
    };

    expect(parseIncomingCommand(message)).toEqual({
      moduleName: 'rfxcom',
      bridgeInstance: 'rfx_bridge_0001',
      deviceId: 'rfxsensor_ac__0xa5b3',
      command: { state: 'on' },
    });
  });

  it('parse un topic de commande valide (payload Buffer)', () => {
    const message: MqttMessage = {
      topic: 'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/set',
      payload: Buffer.from(JSON.stringify({ state: 'off' })),
      qos: 1,
      retain: false,
    };

    expect(parseIncomingCommand(message)).toEqual({
      moduleName: 'rfxcom',
      bridgeInstance: 'rfx_bridge_0001',
      deviceId: 'rfxsensor_ac__0xa5b3',
      command: { state: 'off' },
    });
  });

  it("retourne null si le topic n'a pas 4 segments", () => {
    const message: MqttMessage = {
      topic: 'rfxcom/rfx_bridge_0001/set',
      payload: '{}',
      qos: 1,
      retain: false,
    };

    expect(parseIncomingCommand(message)).toBeNull();
  });

  it("retourne null si le dernier segment n'est pas 'set'", () => {
    const message: MqttMessage = {
      topic: 'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/state',
      payload: '{}',
      qos: 1,
      retain: false,
    };

    expect(parseIncomingCommand(message)).toBeNull();
  });

  it('retourne null si le payload JSON est invalide', () => {
    const message: MqttMessage = {
      topic: 'rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/set',
      payload: 'not json',
      qos: 1,
      retain: false,
    };

    expect(parseIncomingCommand(message)).toBeNull();
  });
});
