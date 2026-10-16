import { describe, it, expect } from 'vitest';
import { HaEntiteRenamer } from '../HaEntiteRenamer';

function fausseHa(existants: Record<string, object>) {
  const appels: Array<Record<string, unknown>> = [];
  return {
    appels,
    ha: {
      callWs: async (m: Record<string, unknown>) => {
        appels.push(m);
        if (m.type === 'config/entity_registry/get') {
          const e = existants[String(m.entity_id)];
          if (!e) throw new Error('Entity not found');
          return e;
        }
        return { entity_entry: { entity_id: m.new_entity_id ?? m.entity_id, name: m.name ?? null } };
      }
    }
  };
}

describe('HaEntiteRenamer', () => {
  const base = { 'sensor.temp_salon': { entity_id: 'sensor.temp_salon', name: null, original_name: 'Température', platform: 'mqtt' } };

  it('sans confirme : aperçu seulement, aucune mise à jour', async () => {
    const { ha, appels } = fausseHa(base);
    const r = (await new HaEntiteRenamer(ha, async () => ['Chauffage (id ch1)']).renommer('sensor.temp_salon', 'sensor.temp_sejour', undefined, false)) as Record<string, unknown>;
    expect(r.apercu).toBe(true);
    expect(r.identifiantLibre).toBe(true);
    expect(r.automatisationsCitantAncienIdentifiant).toEqual(['Chauffage (id ch1)']);
    expect(appels.some((a) => a.type === 'config/entity_registry/update')).toBe(false);
  });

  it('avec confirme : met à jour le registre', async () => {
    const { ha, appels } = fausseHa(base);
    await new HaEntiteRenamer(ha).renommer('sensor.temp_salon', 'sensor.temp_sejour', 'Séjour', true);
    expect(appels.at(-1)).toMatchObject({ type: 'config/entity_registry/update', entity_id: 'sensor.temp_salon', new_entity_id: 'sensor.temp_sejour', name: 'Séjour' });
  });

  it('refuse un identifiant déjà pris, un autre domaine, une entité hors registre', async () => {
    const { ha } = fausseHa({ ...base, 'sensor.temp_sejour': { entity_id: 'sensor.temp_sejour' } });
    const r = new HaEntiteRenamer(ha);
    await expect(r.renommer('sensor.temp_salon', 'sensor.temp_sejour', undefined, true)).rejects.toThrow('existe déjà');
    await expect(r.renommer('sensor.temp_salon', 'light.temp_salon', undefined, true)).rejects.toThrow('domaine');
    await expect(r.renommer('sensor.inconnu', 'sensor.x', undefined, true)).rejects.toThrow('registre');
  });
});
