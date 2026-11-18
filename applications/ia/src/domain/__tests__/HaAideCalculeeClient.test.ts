import { describe, it, expect } from 'vitest';
import { HaAideCalculeeClient } from '../HaAideCalculeeClient';

function faux(renduApres = 'ok') {
  const rest: Array<{ m: string; p: string; b?: unknown }> = [];
  const ws: Record<string, unknown> = {
    'config_entries/get': [{ entry_id: 'e1', domain: 'template', title: 'Autres appareils' }],
    'config/entity_registry/list': [{ entity_id: 'sensor.autres_appareils', config_entry_id: 'e1' }],
    'get_states': [{ entity_id: 'sensor.autres_appareils', state: '850', attributes: { unit_of_measurement: 'W', friendly_name: 'Autres appareils' } }]
  };
  const ha = {
    callWs: async (m: Record<string, unknown>) => ws[String(m.type)] ?? [],
    callRest: async (m: string, p: string, b?: unknown) => {
      rest.push({ m, p, b });
      if (p === '/api/config/config_entries/options/flow' && m === 'POST') {
        return { status: 200, body: { type: 'form', flow_id: 'f1', step_id: 'sensor', data_schema: [
          { name: 'state', required: true, description: { suggested_value: '{{ 1 }}' } },
          { name: 'unit_of_measurement', description: { suggested_value: 'W' } }] } };
      }
      if (p === '/api/template') return (b as { template: string }).template.includes('ERR') ? { status: 400, body: 'erreur' } : { status: 200, body: p && (b as { template: string }).template === '{{ 1 }}' ? '1' : renduApres };
      if (p.endsWith('/f1') && m === 'POST') return { status: 200, body: { type: 'create_entry' } };
      return { status: 200, body: {} };
    }
  };
  return { rest, ha: ha as never };
}

describe('HaAideCalculeeClient', () => {
  it('liste, puis lit la formule et abandonne le flux', async () => {
    const { rest, ha } = faux();
    const c = new HaAideCalculeeClient(ha);
    expect(((await c.lire()) as { aides_calculees: unknown[] }).aides_calculees).toHaveLength(1);
    const r = (await c.lire('autres')) as { formule: string; entity_id: string; autres_champs: Record<string, unknown> };
    expect(r.formule).toBe('{{ 1 }}');
    expect(r.entity_id).toBe('sensor.autres_appareils');
    expect(r.autres_champs).toEqual({ unit_of_measurement: 'W' });
    expect(rest.some((x) => x.m === 'DELETE' && x.p.endsWith('/f1'))).toBe(true);
  });

  it('aperçu sans écriture, puis écriture avec tous les champs', async () => {
    const { rest, ha } = faux();
    const c = new HaAideCalculeeClient(ha);
    const a = (await c.modifier('sensor.autres_appareils', '{{ 2 }}', false)) as { apercu?: boolean; annuler: string };
    expect(a.apercu).toBe(true);
    expect(a.annuler).toContain('{{ 1 }}');
    expect(rest.some((x) => x.m === 'POST' && x.p.endsWith('/f1'))).toBe(false);
    expect(rest.some((x) => x.m === 'DELETE')).toBe(true);
    await c.modifier('sensor.autres_appareils', '{{ 2 }}', true);
    expect(rest.find((x) => x.m === 'POST' && x.p.endsWith('/f1'))?.b).toEqual({ state: '{{ 2 }}', unit_of_measurement: 'W' });
  });

  it('refuse une formule dont le rendu échoue et une cible inconnue', async () => {
    const c = new HaAideCalculeeClient(faux().ha);
    await expect(c.modifier('autres', '{{ ERR }}', true)).rejects.toThrow(/rendu échoue/);
    await expect(c.lire('inconnue')).rejects.toThrow(/Aucune aide/);
  });
});
