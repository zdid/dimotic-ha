import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HaTableauClient } from '../HaTableauClient';

function fausse(etat: { tableaux: Array<{ url_path: string; title: string }>; configs: Record<string, unknown> }) {
  const appels: Array<Record<string, unknown>> = [];
  return {
    appels,
    ha: {
      callWs: async (m: Record<string, unknown>) => {
        appels.push(m);
        switch (m.type) {
          case 'lovelace/dashboards/list': return etat.tableaux;
          case 'lovelace/config': {
            const c = etat.configs[String(m.url_path ?? '')];
            if (!c) throw new Error('config_not_found');
            return c;
          }
          default: return {};
        }
      }
    }
  };
}

const NOUVEAU = { views: [{ title: 'Énergie', path: 'energie', cards: [{ type: 'history-graph', entities: ['sensor.x'] }] }] };

describe('HaTableauClient', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-')); });

  it('sans confirme : aperçu, aucune écriture', async () => {
    const f = fausse({ tableaux: [{ url_path: 'energie-direct', title: 'Énergie' }], configs: { 'energie-direct': { views: [{ title: 'Ancien', cards: [] }] } } });
    const r = (await new HaTableauClient(f.ha, dir).deposer('energie-direct', NOUVEAU, undefined, false)) as Record<string, unknown>;
    expect(r.effectue).toBe(false);
    expect(r.action).toBe('remplacement');
    expect(f.appels.some((a) => String(a.type).includes('save') || String(a.type).includes('create'))).toBe(false);
  });

  it('remplacement confirmé : sauvegarde de l\'existant puis enregistrement', async () => {
    const f = fausse({ tableaux: [{ url_path: 'energie-direct', title: 'Énergie' }], configs: { 'energie-direct': { views: [{ title: 'Ancien', cards: [] }] } } });
    const r = (await new HaTableauClient(f.ha, dir).deposer('energie-direct', NOUVEAU, undefined, true)) as { sauvegarde: string };
    expect(fs.existsSync(path.join(dir, 'tableaux-backups', r.sauvegarde))).toBe(true);
    expect(f.appels.at(-1)).toMatchObject({ type: 'lovelace/config/save', url_path: 'energie-direct' });
  });

  it('tableau inconnu : refusé sans creer ; avec creer, créé puis enregistré', async () => {
    const f = fausse({ tableaux: [], configs: {} });
    const c = new HaTableauClient(f.ha, dir);
    await expect(c.deposer('mon-tableau', NOUVEAU, undefined, true)).rejects.toThrow('creer');
    await c.deposer('mon-tableau', NOUVEAU, { titre: 'Mon tableau' }, true);
    expect(f.appels.map((a) => a.type).slice(-2)).toEqual(['lovelace/dashboards/create', 'lovelace/config/save']);
  });

  it('refuse un url_path sans tiret et une config sans vues', async () => {
    const f = fausse({ tableaux: [], configs: {} });
    const c = new HaTableauClient(f.ha, dir);
    await expect(c.deposer('energie', NOUVEAU, { titre: 'x' }, true)).rejects.toThrow('url_path invalide');
    await expect(c.deposer('energie-x', { title: 'x' }, { titre: 'x' }, true)).rejects.toThrow('views');
  });

  it('énergie : clés non gérées refusées, aperçu sans écriture', async () => {
    const f = fausse({ tableaux: [], configs: {} });
    const c = new HaTableauClient(f.ha, dir);
    await expect(c.deposerEnergie({ autre: [] }, true)).rejects.toThrow('non gérées');
    const r = (await c.deposerEnergie({ device_consumption: [{ stat_consumption: 'sensor.x' }] }, false)) as Record<string, unknown>;
    expect(r.effectue).toBe(false);
    expect(f.appels.some((a) => a.type === 'energy/save_prefs')).toBe(false);
  });
});
