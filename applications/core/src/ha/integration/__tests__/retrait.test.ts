// retrait.test.ts — un retrait d'entité doit laisser le broker PROPRE : message VIDE retenu (QoS 1) sur la découverte,
// sur les attributs de taxonomie et, si le deviceId est fourni, sur l'état (15/10/2026).

import { describe, it, expect } from 'vitest';
import { unpublishDiscovery, unpublishEntityData } from '../discovery';
import type { MqttTransport } from '../../../infrastructure/transport/MqttTransport';

function faux() {
  const publies: Array<{ topic: string; payload: string | Buffer; qos: number; retain: boolean }> = [];
  const transport = { publish: (topic: string, payload: string | Buffer, qos: number, retain: boolean) => publies.push({ topic, payload, qos, retain }) } as unknown as MqttTransport;
  return { transport, publies };
}

describe('retrait d\'une entité', () => {
  it('vide (message vide, retenu, QoS 1) la découverte, les attributs et l\'état', () => {
    const { transport, publies } = faux();
    unpublishDiscovery(transport, 'sensor', 'arexx_8962', 1, 'arexx_bridge_noisy');
    unpublishEntityData(transport, 'arexx', 'arexx_bridge_noisy', 'sensor', 'arexx_8962', 'arexx_8962');

    expect(publies.map((p) => p.topic)).toEqual([
      expect.stringMatching(/^homeassistant\/sensor\/.*arexx_8962\/config$/),
      'homeassistant/sensor/arexx_8962/attributs',
      'arexx/arexx_bridge_noisy/arexx_8962/state'
    ]);
    for (const p of publies) {
      expect(p.payload).toBe('');
      expect(p.retain).toBe(true);
      expect(p.qos).toBe(1);
    }
  });

  it('sans deviceId : seuls les attributs sont vidés en plus de la découverte (l\'état n\'est pas deviné)', () => {
    const { transport, publies } = faux();
    unpublishEntityData(transport, 'arexx', 'arexx_bridge_noisy', 'sensor', 'arexx_8962');
    expect(publies.map((p) => p.topic)).toEqual(['homeassistant/sensor/arexx_8962/attributs']);
  });
});
