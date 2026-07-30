// src/ha/integration/__tests__/discovery.test.ts
// Tests unitaires pour discovery.ts (fonctions pures)
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5.0

import { describe, it, expect, vi } from 'vitest';
import { buildDiscoveryPayload, publishDiscovery, type DiscoveryContext } from '../discovery';
import type { MqttTransport } from '../../../infrastructure/transport/MqttTransport';

function createContext(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    moduleName: 'rfxcom',
    bridgeInstance: 'rfx_bridge_0001',
    deviceId: 'rfxsensor_ac__0xa5b3',
    component: 'sensor',
    objectId: 'rfxsensor_0xa5b3',
    ...overrides,
  };
}

describe('buildDiscoveryPayload', () => {
  it('complète les topics état/commande à partir des données essentielles', () => {
    const entity = buildDiscoveryPayload(
      { name: 'Température Salon', deviceClass: 'temperature', unitOfMeasurement: '°C' },
      createContext()
    );

    expect(entity.name).toBe('Température Salon');
    expect(entity.unique_id).toBe('rfxsensor_0xa5b3');
    expect(entity.state_topic).toBe('rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/state');
    expect(entity.device_class).toBe('temperature');
    expect(entity.unit_of_measurement).toBe('°C');
    expect(entity.command_topic).toBeUndefined();
    expect(entity.retain).toBe(true);
    expect(entity.qos).toBe(1);
  });

  it('ajoute command_topic uniquement si commandEnabled est vrai', () => {
    const entity = buildDiscoveryPayload({ name: 'Prise Salon', commandEnabled: true }, createContext());

    expect(entity.command_topic).toBe('rfxcom/rfx_bridge_0001/rfxsensor_ac__0xa5b3/set');
  });
});

describe('publishDiscovery', () => {
  it('publie sur le topic de découverte standard HA en QoS1/retain par défaut', () => {
    const publishSpy = vi.fn();
    const transport = { publish: publishSpy } as unknown as MqttTransport;

    const entity = buildDiscoveryPayload({ name: 'Température Salon' }, createContext());
    publishDiscovery(transport, 'sensor', 'rfxsensor_0xa5b3', entity);

    expect(publishSpy).toHaveBeenCalledWith(
      'homeassistant/sensor/rfxsensor_0xa5b3/config',
      JSON.stringify(entity),
      1,
      true
    );
  });
});
