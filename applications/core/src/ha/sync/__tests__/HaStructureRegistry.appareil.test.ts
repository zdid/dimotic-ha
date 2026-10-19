import { describe, it, expect } from 'vitest';
import { HaStructureRegistry } from '../HaStructureRegistry';

// Un appareil change de pièce : ses entités suivent (cache du cœur), sauf celles qui ont leur propre pièce.
function registre() {
  const registry = new HaStructureRegistry({ getQuoiCatalog: () => [{ quoi_id: 'bouton', label: 'Bouton' }] } as never, undefined, { debug() {}, info() {}, warn() {}, error() {} } as never);
  const r = registry as unknown as { areas: Map<string, unknown>; devices: Map<string, unknown>; entityMap: Map<string, unknown> };
  const mk = (id: string, area?: string) => ({ entity_id: id, friendly_name: id, state: 'off', attributes: {}, device_id: 'd1', area_id: area, quoi_ids: ['bouton'] });
  const e1 = mk('binary_sensor.b1', 'salon');
  const e2 = mk('sensor.b1_batterie', 'cuisine'); // pièce propre : ne doit pas bouger
  const area = (id: string, name: string, ents: unknown[]) => ({ area_id: id, name, quoiMap: new Map(ents.length ? [['bouton', { quoi_id: 'bouton', label: 'Bouton', entities: ents }]] : []) });
  r.areas = new Map([['salon', area('salon', 'Salon', [e1])], ['salle', area('salle', 'Salle', [])], ['cuisine', area('cuisine', 'Cuisine', [e2])]]);
  r.devices = new Map([['d1', { device_id: 'd1', name: 'Bouton', area_id: 'salon', entities: [e1, e2] }]]);
  r.entityMap = new Map([[e1.entity_id, e1], [e2.entity_id, e2]]);
  return { registry, e1, e2 };
}

describe('reaffecterAppareil', () => {
  it('déplace l\'entité de l\'appareil vers la nouvelle pièce, laisse celle qui a sa propre pièce', () => {
    const { registry, e1, e2 } = registre();
    const n = registry.reaffecterAppareil('d1', 'salle', new Map([[e2.entity_id, 'cuisine']]));
    expect(n).toBe(1);
    expect(e1.area_id).toBe('salle');
    expect(e2.area_id).toBe('cuisine');
    expect(registry.getEntitiesByArea('salle').map((e) => e.entity_id)).toEqual(['binary_sensor.b1']);
    expect(registry.getEntitiesByArea('salon')).toEqual([]);
    expect(registry.getDevice('d1')?.entities).toHaveLength(2);
  });
  it('appareil inconnu : rien', () => {
    expect(registre().registry.reaffecterAppareil('zzz', 'salle', new Map())).toBe(0);
  });
});
