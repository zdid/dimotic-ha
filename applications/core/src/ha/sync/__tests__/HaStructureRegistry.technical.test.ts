import { describe, it, expect } from 'vitest';
import { HaStructureRegistry } from '../HaStructureRegistry';

// Entités de réglage/diagnostic et désactivées (registre des entités HA) : écartées par défaut de la résolution
// quoi/lieux (vision de Mistral = ce qui s'exécute), incluses sur demande (outils MCP de Claude Code).
function buildRegistry(): HaStructureRegistry {
  const registry = new HaStructureRegistry({} as never, undefined, { debug() {}, info() {}, warn() {}, error() {} } as never);
  const tax = { slug_quoi: 'ballon', slug_lieu: 'cave', slug_pere: 'rdc' };
  const ent = (id: string, extra: Record<string, unknown> = {}) => ({ entity_id: id, friendly_name: id, state: 'off', attributes: { attributs_taxonomie: tax }, ...extra });
  const entities = [
    ent('switch.principal'),
    ent('number.seuil', { entity_category: 'config' }),
    ent('sensor.rssi', { entity_category: 'diagnostic' }),
    ent('switch.inactif', { disabled_by: 'integration' })
  ];
  const r = registry as unknown as { areas: Map<string, unknown>; entityMap: Map<string, unknown> };
  r.areas = new Map(); r.entityMap = new Map();
  const quoiMap = new Map<string, { entities: unknown[] }>([['ballon', { entities }]]);
  for (const e of entities) r.entityMap.set(e.entity_id, e);
  r.areas.set('a', { area_id: 'a', name: 'a', quoiMap });
  return registry;
}

describe('entités techniques — résolution quoi/lieux', () => {
  const registry = buildRegistry();
  const ids = (include?: boolean) => registry.getEntitiesByQuoiAndLieux('ballon', ['cave'], include).map((e) => e.entity_id).sort();

  it('par défaut : ni réglage, ni diagnostic, ni désactivée', () => {
    expect(ids()).toEqual(['switch.principal']);
  });

  it('includeTechnical : toutes', () => {
    expect(ids(true)).toEqual(['number.seuil', 'sensor.rssi', 'switch.inactif', 'switch.principal']);
  });

  it('isUserFacing', () => {
    expect(HaStructureRegistry.isUserFacing({})).toBe(true);
    expect(HaStructureRegistry.isUserFacing({ entity_category: null, disabled_by: null })).toBe(true);
    expect(HaStructureRegistry.isUserFacing({ entity_category: 'config' })).toBe(false);
    expect(HaStructureRegistry.isUserFacing({ disabled_by: 'user' })).toBe(false);
  });
});
