import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { HaAutomationClient, HA_REST_REPLY_EVENT } from '../HaAutomationClient';

function banc(existant?: unknown) {
  const em = new EventEmitter();
  const demandes: Array<Record<string, unknown>> = [];
  const bus = {
    onGeneric: (e: string, l: (d: unknown) => void) => { em.on(e, l); },
    emitGeneric: (e: string, d: Record<string, unknown>) => {
      if (e !== 'ha:rest:request') return;
      demandes.push(d);
      setImmediate(() => {
        if (d.method === 'get') em.emit(HA_REST_REPLY_EVENT, existant ? { id: d.id, success: true, result: existant } : { id: d.id, success: false, error: 'HTTP 404' });
        else em.emit(HA_REST_REPLY_EVENT, { id: d.id, success: true });
      });
    }
  };
  const registre = { isAvailable: () => true, getAllEntities: () => [{ entity_id: 'script.notifier', state: 'off', friendly_name: 'Notifier', attributes: {} }, { entity_id: 'automation.x', state: 'on', attributes: { id: 'a' } }] };
  return { bus, demandes, registre };
}

describe('HaAutomationClient en mode script', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-')); });

  it('liste les scripts avec leur id de config (nom de l\'entité)', () => {
    const b = banc();
    const c = new HaAutomationClient(b.bus as never, b.registre as never, dir, 'script');
    expect(c.list()).toEqual([expect.objectContaining({ id: 'notifier', alias: 'Notifier', entity_id: 'script.notifier' })]);
  });

  it('exige alias et sequence (pas de déclencheur) ; aperçu sans confirme n\'écrit rien', async () => {
    const b = banc();
    const c = new HaAutomationClient(b.bus as never, b.registre as never, dir, 'script');
    const refus = (await c.deposit('notifier', { alias: 'N' }, true)) as { problemes: string[] };
    expect(refus.problemes.join(' ')).toContain('sequence obligatoire');
    expect(refus.problemes.join(' ')).toContain('description obligatoire');
    const sansDescription = (await c.deposit('notifier', { alias: 'N', sequence: [{ delay: 1 }] }, true)) as { problemes: string[] };
    expect(sansDescription.problemes).toEqual([expect.stringContaining('description obligatoire')]);
    const apercu = (await c.deposit('notifier', { alias: 'N', description: 'Sert à tester', sequence: [{ delay: 1 }] }, false)) as { effectue: boolean; action: string };
    expect(apercu).toMatchObject({ effectue: false, action: 'création' });
    expect(b.demandes.some((d) => d.method === 'set')).toBe(false);
  });

  it('dépôt confirmé sur le domaine script ; remplacement sauvegardé dans scripts-backups', async () => {
    const b = banc({ alias: 'Ancien', sequence: [] });
    const c = new HaAutomationClient(b.bus as never, b.registre as never, dir, 'script');
    const r = (await c.deposit('notifier', { alias: 'N', description: 'D', sequence: [{ delay: 1 }] }, true)) as { effectue: boolean; sauvegarde: string; scripts_recharges: boolean };
    expect(r).toMatchObject({ effectue: true, scripts_recharges: true });
    expect(b.demandes.find((d) => d.method === 'set')).toMatchObject({ domain: 'script', id: 'notifier' });
    expect(fs.existsSync(path.join(dir, 'scripts-backups', r.sauvegarde))).toBe(true);
  });
});
