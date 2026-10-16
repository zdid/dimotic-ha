import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { HaAideClient, HA_HELPER_REPLY_EVENT } from '../HaAideClient';

function faux(existantes: Array<{ id: string; name: string }>) {
  const em = new EventEmitter();
  const demandes: Array<Record<string, unknown>> = [];
  const bus = {
    onGeneric: (e: string, l: (d: unknown) => void) => { em.on(e, l); },
    emitGeneric: (e: string, d: Record<string, unknown>) => {
      if (e !== 'ha:helper:request') return;
      demandes.push(d);
      const base = { requestId: d.requestId, success: true };
      setImmediate(() => em.emit(HA_HELPER_REPLY_EVENT, d.method === 'list' ? { ...base, result: existantes } : d.method === 'create' ? { ...base, result: { id: 'x' } } : base));
    }
  };
  return { bus, demandes };
}

describe('HaAideClient', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aides-')); });

  it('creer sans confirme : aperçu, entity_id prévu, aucune création', async () => {
    const { bus, demandes } = faux([]);
    const r = (await new HaAideClient(bus as never, dir).creer('timer', 'Minuterie salle télé', { duration: '24:00:00' }, false)) as Record<string, unknown>;
    expect(r.effectue).toBe(false);
    expect(r.entityIdPrevu).toBe('timer.minuterie_salle_tele');
    expect(demandes.some((d) => d.method === 'create')).toBe(false);
  });

  it('creer avec confirme : crée ; refuse une aide déjà existante', async () => {
    const a = faux([]);
    await new HaAideClient(a.bus as never, dir).creer('timer', 'Minuterie x', {}, true);
    expect(a.demandes.at(-1)).toMatchObject({ method: 'create', domain: 'timer', data: { name: 'Minuterie x' } });
    const b = faux([{ id: 'minuterie_x', name: 'Minuterie x' }]);
    await expect(new HaAideClient(b.bus as never, dir).creer('timer', 'Minuterie x', {}, true)).rejects.toThrow('existe déjà');
  });

  it('supprimer : sauvegarde puis suppression ; domaine inconnu refusé', async () => {
    const { bus, demandes } = faux([{ id: 'minuterie_x', name: 'Minuterie x' }]);
    const c = new HaAideClient(bus as never, dir);
    const r = (await c.supprimer('timer', 'minuterie_x', true)) as { sauvegarde: string };
    expect(fs.existsSync(path.join(dir, 'aides-backups', r.sauvegarde))).toBe(true);
    expect(demandes.at(-1)).toMatchObject({ method: 'delete', id: 'minuterie_x' });
    await expect(c.lister('light')).rejects.toThrow('non géré');
  });
});
