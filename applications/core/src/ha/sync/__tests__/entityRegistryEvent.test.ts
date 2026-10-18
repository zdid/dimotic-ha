import { describe, it, expect } from 'vitest';
import { metaDepuisEvenementRegistre } from '../entityRegistryEvent';

const base = { id: 1, type: 'entity_registry_updated' as const };

describe('metaDepuisEvenementRegistre', () => {
  it("renommage d'entity_id : l'ancien identifiant est transmis", () => {
    const m = metaDepuisEvenementRegistre({ ...base, data: { action: 'update', entity_id: 'light.x_etage', old_entity_id: 'light.x_1er_etage', entity: { name: 'X', domain: 'light' } } } as never);
    expect(m).toMatchObject({ entity_id: 'light.x_etage', old_entity_id: 'light.x_1er_etage', action: 'update', domain: 'light' });
  });

  it('mise à jour ordinaire : pas de old_entity_id', () => {
    const m = metaDepuisEvenementRegistre({ ...base, data: { action: 'update', entity_id: 'light.x', entity: { name: 'X', domain: 'light', area_id: 'salon' } } } as never);
    expect('old_entity_id' in m).toBe(false);
    expect(m.area_id).toBe('salon');
  });

  it('old_entity_id identique au nouveau : ignoré', () => {
    const m = metaDepuisEvenementRegistre({ ...base, data: { action: 'update', entity_id: 'light.x', old_entity_id: 'light.x' } } as never);
    expect('old_entity_id' in m).toBe(false);
  });
});
