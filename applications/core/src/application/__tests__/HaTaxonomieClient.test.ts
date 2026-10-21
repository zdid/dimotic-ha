import { describe, it, expect, vi } from 'vitest';
import { HaTaxonomieClient, versEntiteDuCoeur, type EntiteTaxonomie } from '../HaTaxonomieClient';

const entite: EntiteTaxonomie = {
  entity_id: 'light.chevets', friendly_name: 'Chevets', domaine: 'light', device_class: null, etat: 'on',
  attributs: { brightness: 120 }, derniere_modification: '2026-10-21T12:00:00+00:00',
  device_id: 'd1', appareil: 'Lampe', area_id: 'a1', piece: 'Chambre de Jo',
  plateforme: 'mqtt', entity_category: null, hidden_by: null, disabled_by: null, quoi_ids: ['lumiere']
};

describe('versEntiteDuCoeur', () => {
  it('renomme les champs au format du cœur et reconstruit la date, le device et l\'area', () => {
    const e = versEntiteDuCoeur(entite);
    expect(e).toMatchObject({
      entity_id: 'light.chevets', domain: 'light', state: 'on', attributes: { brightness: 120 },
      platform: 'mqtt', quoi_ids: ['lumiere'], device_id: 'd1', area_id: 'a1',
      device: { device_id: 'd1', name: 'Lampe' }, area: { area_id: 'a1', name: 'Chambre de Jo' }
    });
    expect(e.last_updated).toEqual(new Date('2026-10-21T12:00:00+00:00'));
    expect(e.device_class).toBeUndefined();
  });

  it('sans appareil ni pièce : pas de références', () => {
    const e = versEntiteDuCoeur({ ...entite, device_id: null, area_id: null, attributs: undefined });
    expect(e.device).toBeUndefined();
    expect(e.area).toBeUndefined();
    expect(e.attributes).toEqual({});
  });
});

describe('HaTaxonomieClient', () => {
  const client = (reponse: unknown) => {
    const callWs = vi.fn().mockResolvedValue(reponse);
    return { callWs, c: new HaTaxonomieClient({ callWs }) };
  };

  it('getEntity : commande entite, undefined si absente', async () => {
    const a = client(entite);
    expect((await a.c.getEntity('light.chevets'))?.entity_id).toBe('light.chevets');
    expect(a.callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/entite', entity_id: 'light.chevets' });
    expect(await client(null).c.getEntity('x.y')).toBeUndefined();
  });

  it('getAllEntities : demande aussi les entités techniques', async () => {
    const a = client({ nombre: 1, entites: [entite] });
    expect(await a.c.getAllEntities()).toHaveLength(1);
    expect(a.callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/entites', inclure_techniques: true });
  });

  it('getAllEntities(domaine) : transmet le filtre de domaine', async () => {
    const a = client({ nombre: 0, entites: [] });
    await a.c.getAllEntities('automation');
    expect(a.callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/entites', inclure_techniques: true, domaine: 'automation' });
  });

  it('getEntitiesByQuoiAndLieux : commande chercher, quoi omis si absent', async () => {
    const a = client({ entites: [entite] });
    await a.c.getEntitiesByQuoiAndLieux(undefined, ['chambre'], true);
    expect(a.callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/chercher', lieux: ['chambre'], inclure_techniques: true });
    await a.c.getEntitiesByQuoiAndLieux('lumiere', []);
    expect(a.callWs).toHaveBeenLastCalledWith({ type: 'dimotic_taxonomie/chercher', quoi: 'lumiere', lieux: [], inclure_techniques: false });
  });

  it('catalogues', async () => {
    const q = client([{ quoi_id: 'lumiere', label: 'Lumière' }]);
    expect(await q.c.getQuoiCatalog()).toEqual([{ quoi_id: 'lumiere', label: 'Lumière' }]);
    const l = client(['salon']);
    expect(await l.c.getLieuCatalog(new Set(['x']))).toEqual(['salon']);
    expect(l.callWs).toHaveBeenCalledWith({ type: 'dimotic_taxonomie/catalogue_lieux', quoi_exclus: ['x'] });
  });

  it('pas de repli : l\'échec de HA est dit clairement', async () => {
    const callWs = vi.fn().mockRejectedValue(new Error('unknown_command'));
    await expect(new HaTaxonomieClient({ callWs }).getQuoiCatalog()).rejects.toThrow(/dimotic_taxonomie.*installée/);
  });
});
