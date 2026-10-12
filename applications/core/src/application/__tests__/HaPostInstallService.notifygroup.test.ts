import { describe, it, expect, vi, afterEach } from 'vitest';
import { HaPostInstallService } from '../HaPostInstallService';

const config = { getHaWsConfig: () => ({ host: 'ha.test', port: 8123, token: 'T' }) } as never;
const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

function mockFetch(existingTitles: string[], states: string[]) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (url.includes('/entry?domain=group')) return json(existingTitles.map((title) => ({ title })));
    if (url.endsWith('/api/states')) return json(states.map((entity_id) => ({ entity_id })));
    if (url.endsWith('/config_entries/flow')) return json({ flow_id: 'F1', type: 'menu' });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.next_step_id === 'notify') return json({ type: 'form', flow_id: 'F1' });
    return json({ type: 'create_entry', title: body.name });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('HaPostInstallService — groupe de notification', () => {
  it('crée le groupe avec tous les notify.* quand aucune entité n’est donnée', async () => {
    const calls = mockFetch([], ['sensor.x', 'notify.s24', 'notify.s10e']);
    const [r] = await new HaPostInstallService(config, logger).apply([{ kind: 'notifygroup' }]);
    expect(r.success).toBe(true);
    const last = calls[calls.length - 1].body as { name: string; entities: string[]; hide_members: boolean };
    expect(last).toEqual({ name: 'Administrateurs', entities: ['notify.s24', 'notify.s10e'], hide_members: false });
  });

  it('ne recrée pas un groupe de même nom (insensible à la casse)', async () => {
    const calls = mockFetch(['administrateurs'], ['notify.s24']);
    const [r] = await new HaPostInstallService(config, logger).apply([{ kind: 'notifygroup' }]);
    expect(r.success).toBe(true);
    expect(r.title).toContain('déjà présent');
    expect(calls.some((c) => c.url.endsWith('/config_entries/flow'))).toBe(false);
  });

  it('utilise les entités demandées, mais le nom reste « Administrateurs » même si un autre nom est envoyé', async () => {
    const calls = mockFetch([], ['notify.a', 'notify.b']);
    await new HaPostInstallService(config, logger).apply([{ kind: 'notifygroup', name: 'Parents', entities: ['notify.b'] } as never]);
    const last = calls[calls.length - 1].body as { name: string; entities: string[] };
    expect(last.entities).toEqual(['notify.b']);
    expect(last.name).toBe('Administrateurs');
  });

  it('échoue proprement quand HA n’a aucun notify.*', async () => {
    mockFetch([], ['sensor.x']);
    const [r] = await new HaPostInstallService(config, logger).apply([{ kind: 'notifygroup' }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain('notify');
  });
});
