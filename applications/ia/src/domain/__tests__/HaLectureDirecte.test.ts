import { describe, it, expect, vi } from 'vitest';
import { HaLectureDirecte } from '../HaLectureDirecte';

const entite = (id: string, taxo?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  entity_id: id, friendly_name: id, domaine: id.split('.')[0], device_class: null, etat: 'on', attributs: taxo ? { attributs_taxonomie: taxo } : {},
  derniere_modification: '2026-10-21T12:00:00+00:00', device_id: null, appareil: null, area_id: null, piece: null, plateforme: null,
  entity_category: null, hidden_by: null, disabled_by: null, quoi_ids: ['lumiere'], ...extra
});

function pont(reponses: Record<string, unknown>) {
  const callWs = vi.fn(async (m: Record<string, unknown>) => {
    const r = reponses[m.type as string];
    if (r instanceof Error) throw r;
    return r;
  });
  return { callWs, callRest: vi.fn(), start: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined), isAvailable: () => true } as never;
}

const REPONSES = {
  'dimotic_taxonomie/entites': { entites: [
    entite('light.a', { slug_quoi: 'lumiere', lieu_principal: 'salon', lieu_precis: 'plafonnier' }),
    entite('sensor.b', { slug_quoi: 'tension', lieu_principal: 'garage', lieu_pere: 'extérieur' }),
    entite('sensor.c', { slug_quoi: 'tension', lieu_principal: 'cave' }, { entity_category: 'diagnostic' }),
    entite('light.d', { slug_quoi: 'lumiere', lieu_principal: '12345' })
  ] },
  'dimotic_taxonomie/catalogue_quoi': [{ quoi_id: 'lumiere', label: 'Lumière' }],
  'dimotic_taxonomie/chercher': { entites: [entite('light.a')] }
};

describe('HaLectureDirecte', () => {
  it('avant la première lecture : indisponible, catalogues vides', () => {
    const l = new HaLectureDirecte(pont(REPONSES));
    expect(l.isAvailable()).toBe(false);
    expect(l.getAllEntities()).toEqual([]);
    expect(l.getQuoiCatalog()).toEqual([]);
  });

  it('refresh : instantané lu dans HA, lectures synchrones', async () => {
    const l = new HaLectureDirecte(pont(REPONSES));
    await l.refresh();
    expect(l.isAvailable()).toBe(true);
    expect(l.getAllEntities()).toHaveLength(4);
    expect(l.getEntity('light.a')?.state).toBe('on');
    expect(l.getEntity('x.y')).toBeUndefined();
    expect(l.getQuoiCatalog()).toEqual([{ quoi_id: 'lumiere', label: 'Lumière' }]);
  });

  it('getLieuCatalog : valeurs distinctes, techniques et chiffres seuls écartés, quoi exclus respectés', async () => {
    const l = new HaLectureDirecte(pont(REPONSES));
    await l.refresh();
    expect(l.getLieuCatalog()).toEqual(['extérieur', 'garage', 'plafonnier', 'salon']);
    expect(l.getLieuCatalog(['tension'])).toEqual(['plafonnier', 'salon']);
  });

  it('la recherche passe par HA (commande chercher), sans instantané', async () => {
    const p = pont(REPONSES);
    const l = new HaLectureDirecte(p);
    const r = await l.getEntitiesByQuoiAndLieux('lumiere', ['salon'], true);
    expect(r.map((e) => e.entity_id)).toEqual(['light.a']);
    expect((p as unknown as { callWs: ReturnType<typeof vi.fn> }).callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/chercher', quoi: 'lumiere', lieux: ['salon'], inclure_techniques: true }, 30000);
  });

  it('pas de repli : HA en panne => la recherche échoue clairement, l\'instantané déjà lu reste servi', async () => {
    const reponses: Record<string, unknown> = { ...REPONSES };
    const l = new HaLectureDirecte(pont(reponses));
    await l.refresh();
    const panne = pont({ ...REPONSES, 'dimotic_taxonomie/chercher': new Error('unknown_command'), 'dimotic_taxonomie/entites': new Error('HA') });
    const l2 = new HaLectureDirecte(panne);
    await expect(l2.getEntitiesByQuoiAndLieux('x', [])).rejects.toThrow(/dimotic_taxonomie.*installée/);
    await expect(l2.refresh()).rejects.toThrow();
    expect(l2.isAvailable()).toBe(false);
    expect(l.getAllEntities()).toHaveLength(4);
  });

  it('fresh : relit HA si l\'instantané est absent ; refresh ne lance qu\'une lecture à la fois', async () => {
    const p = pont(REPONSES);
    const l = new HaLectureDirecte(p);
    await Promise.all([l.refresh(), l.refresh()]);
    const callWs = (p as unknown as { callWs: ReturnType<typeof vi.fn> }).callWs;
    expect(callWs.mock.calls.filter(([m]) => m.type === 'dimotic_taxonomie/entites')).toHaveLength(1);
    await l.fresh(); // instantané récent : pas de nouvelle lecture
    expect(callWs.mock.calls.filter(([m]) => m.type === 'dimotic_taxonomie/entites')).toHaveLength(1);
  });

  it('première lecture échouée : un accès synchrone relance une lecture (au plus toutes les 15 s)', async () => {
    vi.useFakeTimers();
    try {
      const reponses: Record<string, unknown> = { ...REPONSES, 'dimotic_taxonomie/entites': new Error('Timeout') };
      const p = pont(reponses);
      const l = new HaLectureDirecte(p);
      await expect(l.refresh()).rejects.toThrow();
      const nb = () => (p as unknown as { callWs: ReturnType<typeof vi.fn> }).callWs.mock.calls.filter(([m]) => m.type === 'dimotic_taxonomie/entites').length;
      expect(nb()).toBe(1);
      l.getAllEntities();            // moins de 15 s : pas de nouvelle lecture
      expect(nb()).toBe(1);
      reponses['dimotic_taxonomie/entites'] = REPONSES['dimotic_taxonomie/entites'];
      vi.advanceTimersByTime(16_000);
      l.getAllEntities();            // plus de 15 s : relecture lancée
      await vi.advanceTimersByTimeAsync(10);
      expect(nb()).toBe(2);
      expect(l.isAvailable()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
