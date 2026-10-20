import { describe, it, expect } from 'vitest';
import { HaAppareilRenamer, problemesNom } from '../HaAppareilRenamer';

function faux() {
  const appels: Array<Record<string, unknown>> = [];
  const donnees: Record<string, unknown> = {
    'config/device_registry/list': [{ id: 'd1', name: 'Climatiseur' }, { id: 'd2', name: 'Court' }],
    'config/entity_registry/list': [{ entity_id: 'climate.clim', device_id: 'd1' }, { entity_id: 'light.court', device_id: 'd2' }],
    'get_states': [{ entity_id: 'light.court', attributes: { attributs_taxonomie: { quoi: 'lumière' } } }]
  };
  return { appels, ha: { callWs: async (m: Record<string, unknown>) => { appels.push(m); return donnees[String(m.type)] ?? {}; } } as never };
}

describe('HaAppareilRenamer', () => {
  it('contrôle le format du nom', () => {
    expect(problemesNom("climatiseur---chambre d'ami--étage--maison")).toEqual([]);
    expect(problemesNom('Climatiseur').length).toBeGreaterThan(0);
    expect(problemesNom('a---b--c--d--e--f').length).toBeGreaterThan(0);
    expect(problemesNom('a---b/c').length).toBeGreaterThan(0);
  });
  it('aperçu sans écriture, puis écriture avec confirme', async () => {
    const { appels, ha } = faux();
    const r = new HaAppareilRenamer(ha);
    const a = (await r.renommer('d1', 'climatiseur---chambre', false)) as { apercu?: boolean };
    expect(a.apercu).toBe(true);
    expect(appels.some((m) => m.type === 'config/device_registry/update')).toBe(false);
    await r.renommer('d1', 'climatiseur---chambre', true);
    expect(appels.find((m) => m.type === 'config/device_registry/update')).toMatchObject({ device_id: 'd1', name_by_user: 'climatiseur---chambre' });
  });
  it('refuse un appareil classé par NOMMAGE ou inconnu', async () => {
    const r = new HaAppareilRenamer(faux().ha);
    await expect(r.renommer('d2', 'lumière---salon', true)).rejects.toThrow(/NOMMAGE/);
    await expect(r.renommer('zz', 'lumière---salon', true)).rejects.toThrow(/inconnu/);
    await expect(r.renommer('d1', 'sans format', true)).rejects.toThrow(/refusé/);
  });
});
