import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HaPieceClient, majuscule } from '../HaPieceClient';

function fausse() {
  const appels: Array<Record<string, unknown>> = [];
  const etat = {
    pieces: [
      { area_id: 'salon', name: 'Salon' }, { area_id: 'cave', name: 'Cave' }, { area_id: 'ancien_bureau', name: 'Ancien bureau' }
    ],
    appareils: [{ id: 'd1', name: 'Thermostat', area_id: 'salon' }],
    entites: [{ entity_id: 'sensor.temp', area_id: null, device_id: 'd1' }, { entity_id: 'light.x', area_id: 'salon' }]
  };
  return {
    appels,
    ha: {
      callWs: async (m: Record<string, unknown>) => {
        appels.push(m);
        switch (m.type) {
          case 'config/area_registry/list': return etat.pieces;
          case 'config/device_registry/list': return etat.appareils;
          case 'config/entity_registry/list': return etat.entites;
          case 'config/area_registry/create': return { area_id: String(m.name).toLowerCase(), name: m.name };
          default: return {};
        }
      }
    }
  };
}

describe('HaPieceClient', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pieces-')); });

  it('majuscule : première lettre seulement', () => {
    expect(majuscule(' cave à vin')).toBe('Cave à vin');
    expect(majuscule('éTAGE')).toBe('ÉTAGE');
  });

  it('lire : compte appareils et entités, repère les pièces vides', async () => {
    const f = fausse();
    const r = (await new HaPieceClient(f.ha, dir).lire()) as { total: number; vides: number; pieces: Array<{ area_id: string; vide: boolean; appareils: number; entites_affectees: number }> };
    expect(r.total).toBe(3);
    expect(r.vides).toBe(2);
    expect(r.pieces.find((p) => p.area_id === 'salon')).toMatchObject({ appareils: 1, entites_affectees: 1, vide: false });
  });

  it('affecter : aperçu sans écriture ; confirmé avec pièce nouvelle = créée en majuscule', async () => {
    const f = fausse();
    const c = new HaPieceClient(f.ha, dir);
    const a = (await c.affecter(['sensor.temp'], [], 'garage', false)) as Record<string, unknown>;
    expect(a.effectue).toBe(false);
    expect(a.creation_de_la_piece).toBe('Garage');
    expect(f.appels.some((x) => String(x.type).endsWith('/create') || String(x.type).endsWith('/update'))).toBe(false);
    await c.affecter(['sensor.temp'], ['d1'], 'garage', true);
    expect(f.appels.find((x) => x.type === 'config/area_registry/create')).toMatchObject({ name: 'Garage' });
    expect(f.appels.find((x) => x.type === 'config/entity_registry/update')).toMatchObject({ entity_id: 'sensor.temp', area_id: 'garage' });
    expect(f.appels.find((x) => x.type === 'config/device_registry/update')).toMatchObject({ device_id: 'd1', area_id: 'garage' });
  });

  it('affecter : entité inconnue refusée ; piece vide = retirer', async () => {
    const f = fausse();
    const c = new HaPieceClient(f.ha, dir);
    await expect(c.affecter(['sensor.inconnu'], [], 'salon', true)).rejects.toThrow('absente');
    await c.affecter(['light.x'], [], '', true);
    expect(f.appels.find((x) => x.type === 'config/entity_registry/update')).toMatchObject({ entity_id: 'light.x', area_id: null });
  });

  it('renommer : majuscule, area_id inchangé, doublon refusé', async () => {
    const f = fausse();
    const c = new HaPieceClient(f.ha, dir);
    await c.renommer('ancien bureau', 'atelier', true);
    expect(f.appels.find((x) => x.type === 'config/area_registry/update')).toMatchObject({ area_id: 'ancien_bureau', name: 'Atelier' });
    await expect(c.renommer('cave', 'salon', true)).rejects.toThrow('existe déjà');
  });

  it('supprimer les vides : aperçu, puis suppression avec sauvegarde ; pièce non vide refusée', async () => {
    const f = fausse();
    const c = new HaPieceClient(f.ha, dir);
    const a = (await c.supprimerVides(undefined, false)) as { a_supprimer: Array<{ area_id: string }> };
    expect(a.a_supprimer.map((x) => x.area_id).sort()).toEqual(['ancien_bureau', 'cave']);
    expect(f.appels.some((x) => x.type === 'config/area_registry/delete')).toBe(false);
    const r = (await c.supprimerVides(undefined, true)) as { sauvegarde: string };
    expect(fs.existsSync(path.join(dir, 'pieces-backups', r.sauvegarde))).toBe(true);
    expect(f.appels.filter((x) => x.type === 'config/area_registry/delete')).toHaveLength(2);
    await expect(c.supprimerVides(['salon'], true)).rejects.toThrow('pas vide');
  });
});
