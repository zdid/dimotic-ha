import { describe, it, expect } from 'vitest';
import { HaStructureRegistry } from '../HaStructureRegistry';

// Registre rempli par injection directe (la structuration complète n'est pas l'objet ici) : on ne
// teste que la résolution quoi/lieux de getEntitiesByQuoiAndLieux (specs socle §8.3.2).
function buildRegistry(): HaStructureRegistry {
  const registry = new HaStructureRegistry({} as never, undefined, { debug() {}, info() {}, warn() {}, error() {} } as never);
  const ent = (id: string, name: string, tax: Record<string, string>) => ({
    entity_id: id, friendly_name: name, state: 'off', attributes: { attributs_taxonomie: tax }
  });
  const entities = [
    ent('light.plaf_chambre', 'Plafonnier chambre', { slug_quoi: 'lumiere', slug_precis: 'plafonnier', slug_lieu: 'chambre', slug_pere: 'etage' }),
    ent('light.plaf_enfant', 'Plafonnier chambre enfant', { slug_quoi: 'lumiere', slug_precis: 'plafonnier', slug_lieu: 'chambre_enfant', slug_pere: 'etage' }),
    ent('light.plaf_salon', 'Plafonnier salon', { slug_quoi: 'lumiere', slug_precis: 'plafonnier', slug_lieu: 'salon', slug_pere: 'rdc' }),
    ent('light.chevet_chambre', 'Chevet chambre', { slug_quoi: 'lumiere', slug_precis: 'chevet', slug_lieu: 'chambre', slug_pere: 'etage' }),
    ent('light.sans_taxo', 'Plafonnier bureau', {}),
    ent('sensor.t_chambre', 'Température chambre', { slug_quoi: 'temperature', slug_lieu: 'chambre', slug_pere: 'etage' })
  ];
  const r = registry as unknown as { areas: Map<string, unknown>; entityMap: Map<string, unknown> };
  r.areas = new Map();
  r.entityMap = new Map();
  const quoiMap = new Map<string, { entities: unknown[] }>();
  for (const e of entities) {
    r.entityMap.set(e.entity_id, e);
    const q = e.attributes.attributs_taxonomie.slug_quoi ?? 'lumiere';
    if (!quoiMap.has(q)) quoiMap.set(q, { entities: [] });
    quoiMap.get(q)!.entities.push(e);
  }
  r.areas.set('a', { area_id: 'a', name: 'a', quoiMap });
  return registry;
}

const ids = (r: HaStructureRegistry, quoi: string | undefined, lieux: string[]): string[] =>
  r.getEntitiesByQuoiAndLieux(quoi, lieux).map((e) => e.entity_id).sort();

describe('getEntitiesByQuoiAndLieux — résolution quoi/lieux', () => {
  const registry = buildRegistry();

  it('« plafonnier de la chambre » : le plafonnier de cette pièce seulement', () => {
    expect(ids(registry, 'lumiere', ['plafonnier de la chambre'])).toEqual(['light.plaf_chambre']);
    expect(ids(registry, undefined, ['plafonnier de la chambre'])).toEqual(['light.plaf_chambre']);
  });

  it('qualificatif + lieu en deux éléments : intersection, pas union', () => {
    expect(ids(registry, 'lumiere', ['plafonnier', 'chambre'])).toEqual(['light.plaf_chambre']);
    expect(ids(registry, 'lumiere', ['salon', 'plafonnier'])).toEqual(['light.plaf_salon']);
  });

  it('plusieurs lieux : toujours une union', () => {
    expect(ids(registry, 'lumiere', ['salon', 'chambre'])).toEqual(
      ['light.chevet_chambre', 'light.plaf_chambre', 'light.plaf_salon']
    );
  });

  it('un mot vide devant un terme seul est ignoré (« la chambre », « le plafonnier »)', () => {
    expect(ids(registry, 'lumiere', ['la chambre'])).toEqual(ids(registry, 'lumiere', ['chambre']));
    expect(ids(registry, 'lumiere', ['le plafonnier'])).toEqual(['light.plaf_chambre', 'light.plaf_enfant', 'light.plaf_salon']);
  });

  it('un lieu_precis donné comme quoi est accepté', () => {
    expect(ids(registry, 'plafonnier', ['chambre'])).toEqual(['light.plaf_chambre']);
  });

  it('repli sur le nom quand la taxonomie manque', () => {
    expect(ids(registry, 'lumiere', ['plafonnier', 'bureau'])).toEqual(['light.sans_taxo']);
  });

  it('le repli sur le nom ne sort jamais du quoi demandé', () => {
    // « Plafonnier salon » existe, mais n'est pas un volet : jamais renvoyé pour quoi=volet.
    expect(ids(registry, 'temperature', ['salon'])).toEqual([]);
  });

  it('lieu inconnu : rien', () => {
    expect(ids(registry, 'lumiere', ['cave'])).toEqual([]);
  });
});
