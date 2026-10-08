import { describe, it, expect } from 'vitest';
import { TaxonomyHaClassifier, quoiFromDeviceClass } from '../TaxonomyHaClassifier';
import { HaStructureRegistry } from '../HaStructureRegistry';
import type { HaStructuredEntity } from '../../types/ha-entity';

const ent = (over: Partial<HaStructuredEntity>): HaStructuredEntity => ({
  entity_id: 'sensor.x', friendly_name: 'X', domain: 'sensor', state: '1', attributes: {}, quoi_ids: [], last_updated: new Date(), ...over
});

describe('quoi_appareil — repli du classifieur (appareils non gérés)', () => {
  it("prend le nom de l'appareil nettoyé, sans le nom propre de l'entité", () => {
    const c = new TaxonomyHaClassifier();
    const e = ent({ device_class: 'power' as never, device: { name: '-HP LaserJet' }, friendly_name: '-HP LaserJet Power' });
    c.classify(e);
    const t = e.attributes.attributs_taxonomie as Record<string, unknown>;
    expect(t.quoi).toBe('Puissance');
    expect(t.quoi_appareil).toBe('HP LaserJet');
    expect(t.slug_quoi_appareil).toBe('hp_laserjet');
    expect(t.virtuel).toBe(true);
  });

  it('absent sans appareil ou sans nom', () => {
    const c = new TaxonomyHaClassifier();
    const e = ent({ device_class: 'power' as never });
    c.classify(e);
    expect((e.attributes.attributs_taxonomie as Record<string, unknown>).quoi_appareil).toBeNull();
  });

  it("le catalogue de QUOI ne s'alimente pas des réglages, du diagnostic ni des entités désactivées", () => {
    const c = new TaxonomyHaClassifier();
    c.classify(ent({ attributes: { attributs_taxonomie: { quoi: 'Disjoncteur puissance', slug_quoi: 'disjoncteur_puissance' } }, entity_category: 'config' }));
    c.classify(ent({ attributes: { attributs_taxonomie: { quoi: 'Fantôme', slug_quoi: 'fantome' } }, disabled_by: 'integration' }));
    c.classify(ent({ attributes: { attributs_taxonomie: { quoi: 'Puissance', slug_quoi: 'puissance' } } }));
    expect(c.getQuoiCatalog().map((q) => q.quoi_id)).toEqual(['puissance']);
  });

  it("le libellé d'une entité secondaire n'entre pas au catalogue, une grandeur connue oui", () => {
    const c = new TaxonomyHaClassifier();
    const tx = (quoi: string, slug: string) => ({ attributs_taxonomie: { quoi, slug_quoi: slug, quoi_appareil: 'gros ballon', slug_quoi_appareil: 'gros_ballon' } });
    c.classify(ent({ attributes: tx('Disjoncteur puissance', 'disjoncteur_puissance') }));
    c.classify(ent({ attributes: tx('Puissance', 'puissance') }));
    c.classify(ent({ attributes: tx('gros ballon', 'gros_ballon') }));
    expect(c.getQuoiCatalog().map((q) => q.quoi_id).sort()).toEqual(['gros_ballon', 'puissance']);
  });

  it('quoiFromDeviceClass partage la table du repli', () => {
    expect(quoiFromDeviceClass('voltage')).toEqual({ quoi_id: 'tension', label: 'Tension' });
    expect(quoiFromDeviceClass('atmospheric_pressure')).toEqual({ quoi_id: 'pression', label: 'Pression' });
    expect(quoiFromDeviceClass('inconnu')).toBeUndefined();
  });
});

describe('quoi_appareil — qualificatif de résolution', () => {
  function registry(): HaStructureRegistry {
    const r = new HaStructureRegistry({} as never, undefined, { debug() {}, info() {}, warn() {}, error() {} } as never);
    const tax = (quoi: string, qa: string) => ({ quoi, slug_quoi: quoi.toLowerCase().replace(/ /g, '_'), quoi_appareil: qa, slug_quoi_appareil: qa, slug_lieu: 'maison' });
    const mk = (id: string, t: Record<string, unknown>) => ({ entity_id: id, friendly_name: id, state: 'off', attributes: { attributs_taxonomie: t } });
    const entities = [
      mk('switch.four', tax('four', 'four')),
      mk('select.four_mode_indicateur', tax('mode indicateur', 'four')),
      mk('select.frigo_mode_indicateur', tax('mode indicateur', 'frigo'))
    ];
    const rr = r as unknown as { areas: Map<string, unknown>; entityMap: Map<string, unknown> };
    rr.areas = new Map(); rr.entityMap = new Map();
    const quoiMap = new Map<string, { entities: unknown[] }>();
    for (const e of entities) {
      rr.entityMap.set(e.entity_id, e);
      const q = (e.attributes.attributs_taxonomie as { slug_quoi: string }).slug_quoi;
      if (!quoiMap.has(q)) quoiMap.set(q, { entities: [] });
      quoiMap.get(q)!.entities.push(e);
    }
    rr.areas.set('a', { area_id: 'a', name: 'a', quoiMap });
    return r;
  }

  it('« mode indicateur du four » : le QUOI de l\'appareil désigne la bonne entité', () => {
    const ids = registry().getEntitiesByQuoiAndLieux('mode_indicateur', ['four'], true).map((e) => e.entity_id);
    expect(ids).toEqual(['select.four_mode_indicateur']);
  });

  it('sans qualificatif : tous les « mode indicateur »', () => {
    expect(registry().getEntitiesByQuoiAndLieux('mode_indicateur', [], true)).toHaveLength(2);
  });

  it('« éteins le four » (quoi four) ne retrouve que l\'entité principale', () => {
    expect(registry().getEntitiesByQuoiAndLieux('four', [], true).map((e) => e.entity_id)).toEqual(['switch.four']);
  });
});
