import { describe, it, expect, vi } from 'vitest';
import { HaQueryBridge } from '../HaQueryBridge';

// « Interroger HA » de façon générique depuis une application (conception-esphome-assembleur) : la requête
// ha:bridge:request {method: callWs|callRest} est relayée au client WebSocket du cœur, la réponse revient sur ha:bridge:reply.

function setup(client: Record<string, unknown>) {
  const handlers: Record<string, (d: unknown) => void> = {};
  const replies: unknown[] = [];
  const bus = {
    onGeneric: (e: string, l: (d: unknown) => void) => { handlers[e] = l; },
    emitGeneric: (e: string, d: unknown) => { if (e === 'ha:bridge:reply') replies.push(d); return true; },
  } as never;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  new HaQueryBridge(bus, logger, () => undefined, () => client as never).start();
  const ask = async (method: string, args: unknown[]) => {
    handlers['ha:bridge:request']({ correlation_id: 'c1', method, args });
    await new Promise((r) => setTimeout(r, 0));
    return replies.pop();
  };
  return ask;
}

describe('HaQueryBridge — appels génériques', () => {
  it('callWs relaie la commande au client WebSocket', async () => {
    const callWs = vi.fn(async () => ({ floorplans: [] }));
    const ask = setup({ callWs });
    expect(await ask('callWs', [{ type: 'dimotic_plans/floorplans/list' }])).toEqual({ correlation_id: 'c1', ok: true, result: { floorplans: [] } });
    expect(callWs).toHaveBeenCalledWith({ type: 'dimotic_plans/floorplans/list' });
  });

  it('callRest relaie méthode, chemin et corps', async () => {
    const callRest = vi.fn(async () => ({ status: 200, body: { flow_id: 'F' } }));
    const ask = setup({ callRest });
    const reply = await ask('callRest', ['POST', '/api/config/config_entries/flow', { handler: 'esphome' }]);
    expect(reply).toMatchObject({ ok: true, result: { status: 200, body: { flow_id: 'F' } } });
    expect(callRest).toHaveBeenCalledWith('POST', '/api/config/config_entries/flow', { handler: 'esphome' });
  });

  it('une erreur du client revient comme échec lisible', async () => {
    const ask = setup({ callWs: () => { throw new Error('message WebSocket : « type » invalide'); } });
    expect(await ask('callWs', [{}])).toEqual({ correlation_id: 'c1', ok: false, error: 'message WebSocket : « type » invalide' });
  });
});
