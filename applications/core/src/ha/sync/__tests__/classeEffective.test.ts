import { describe, it, expect } from 'vitest';
import { HaStructureRegistry } from '../HaStructureRegistry';
import { TaxonomyHaClassifier } from '../TaxonomyHaClassifier';

const muet = { debug() {}, info() {}, warn() {}, error() {} } as never;
const brut = (entity_id: string, attributes: Record<string, unknown> = {}) =>
  ({ entity_id, state: '1', attributes: { friendly_name: entity_id, ...attributes }, last_changed: '', last_updated: '2026-10-21T10:00:00Z', context: { id: '', parent_id: null, user_id: null } }) as never;

describe('classe effective d\'une entité (21/10/2026)', () => {
  it('priorité : classe imposée par l\'utilisateur, puis classe de l\'intégration, puis attribut de l\'état', () => {
    expect(HaStructureRegistry.classeEffective({ device_class: 'power', original_device_class: 'energy' }, { device_class: 'voltage' })).toBe('power');
    expect(HaStructureRegistry.classeEffective({ device_class: null, original_device_class: 'energy' }, { device_class: 'voltage' })).toBe('energy');
    expect(HaStructureRegistry.classeEffective({}, { device_class: 'voltage' })).toBe('voltage');
    expect(HaStructureRegistry.classeEffective(undefined, {})).toBeUndefined();
    expect(HaStructureRegistry.classeEffective({ device_class: '' }, { device_class: 12 as never })).toBeUndefined();
  });

  it('un capteur non MQTT classé par l\'attribut de son état est trouvé par son « quoi » (avant : jamais classé)', () => {
    const reg = new HaStructureRegistry(new TaxonomyHaClassifier(), { includeUnassigned: false, unassignedLabel: 'Non assigné' }, muet);
    reg.initialize(
      [brut('sensor.onduleur_puissance', { device_class: 'power' }), brut('sensor.sans_classe'), brut('sensor.reglage', { device_class: 'power' })],
      [{ area_id: 'infra', name: 'Infra' }], [],
      [{ entity_id: 'sensor.onduleur_puissance', domain: 'sensor', area_id: 'infra' }, { entity_id: 'sensor.sans_classe', domain: 'sensor', area_id: 'infra' },
       { entity_id: 'sensor.reglage', domain: 'sensor', area_id: 'infra', entity_category: 'diagnostic' }]
    );
    expect(reg.getEntity('sensor.onduleur_puissance')!.quoi_ids).toEqual(['puissance']);
    expect(reg.getEntity('sensor.sans_classe')!.quoi_ids).toEqual([]);
    expect(reg.getEntitiesByQuoiAndLieux('puissance', []).map((e) => e.entity_id)).toEqual(['sensor.onduleur_puissance']);   // le diagnostic est écarté
    expect(reg.getQuoiCatalog().map((q) => q.quoi_id)).toContain('puissance');
  });

  it('la classe de l\'intégration (original_device_class du registre) est prise avant l\'attribut', () => {
    const reg = new HaStructureRegistry(new TaxonomyHaClassifier(), { includeUnassigned: false, unassignedLabel: 'Non assigné' }, muet);
    reg.initialize([brut('sensor.t', { device_class: 'voltage' })], [{ area_id: 'a', name: 'A' }], [],
      [{ entity_id: 'sensor.t', domain: 'sensor', area_id: 'a', original_device_class: 'temperature' } as never]);
    expect(reg.getEntity('sensor.t')!.quoi_ids).toEqual(['temperature']);
  });

  it('une classe apparue dans l\'état après coup est prise en compte (changement d\'état sans registre)', () => {
    const reg = new HaStructureRegistry(new TaxonomyHaClassifier(), { includeUnassigned: false, unassignedLabel: 'Non assigné' }, muet);
    reg.initialize([brut('sensor.x')], [{ area_id: 'a', name: 'A' }], [], [{ entity_id: 'sensor.x', domain: 'sensor', area_id: 'a' }]);
    expect(reg.getEntity('sensor.x')!.quoi_ids).toEqual([]);
    reg.updateEntity(brut('sensor.x', { device_class: 'battery' }));
    expect(reg.getEntity('sensor.x')!.quoi_ids).toEqual(['batterie']);
  });
});
