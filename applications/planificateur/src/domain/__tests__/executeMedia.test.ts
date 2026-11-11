import { describe, it, expect, vi } from 'vitest';
import { ExecutionEngine } from '../execution';

function moteur(sendCommand = vi.fn().mockResolvedValue(undefined)) {
  const eventBus = { onGeneric: vi.fn(), emitGeneric: vi.fn(), offGeneric: vi.fn() } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const registry = { sendCommand } as never;
  return { engine: new ExecutionEngine(eventBus, logger, registry, 1000, () => undefined, (() => undefined) as never), sendCommand };
}

describe('ExecutionEngine.executeMedia (specs v1.13 §8bis)', () => {
  it('jouer → media_player.play_media avec le flux', async () => {
    const { engine, sendCommand } = moteur();
    const r = await engine.executeMedia({ entity_id: 'media_player.hasat3', action: 'jouer', media_url: 'http://x/flux.mp3', titre: 'FIP' });
    expect(r.success).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith('media_player', 'play_media', { entity_id: 'media_player.hasat3' }, { media_content_id: 'http://x/flux.mp3', media_content_type: 'music' });
  });
  it('arreter → media_player.media_stop', async () => {
    const { engine, sendCommand } = moteur();
    const r = await engine.executeMedia({ entity_id: 'media_player.hasat3', action: 'arreter' });
    expect(r.success).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith('media_player', 'media_stop', { entity_id: 'media_player.hasat3' }, undefined);
  });
  it('refuse une entité qui n est pas un lecteur', async () => {
    const { engine, sendCommand } = moteur();
    const r = await engine.executeMedia({ entity_id: 'light.salon', action: 'arreter' });
    expect(r.success).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it('refuse jouer sans flux', async () => {
    const { engine } = moteur();
    expect((await engine.executeMedia({ entity_id: 'media_player.hasat3', action: 'jouer' })).success).toBe(false);
  });
  it('erreur de HA → échec avec la raison', async () => {
    const { engine } = moteur(vi.fn().mockRejectedValue(new Error('HA injoignable')));
    const r = await engine.executeMedia({ entity_id: 'media_player.hasat3', action: 'arreter' });
    expect(r).toEqual({ success: false, message: 'Commande non exécutée — HA injoignable' });
  });
});
