import { describe, it, expect } from 'vitest';
import { extraireEntityIds, extraireCitations, suggerer, HaReferencesClient } from '../HaReferencesClient';

describe('extraireEntityIds', () => {
  it('trouve les entités dans cibles, déclencheurs et modèles ; ignore services et faux amis', () => {
    const auto = {
      triggers: [{ platform: 'state', entity_id: ['light.salon', 'binary_sensor.bouton'] }],
      actions: [{ action: 'light.turn_on', target: { entity_id: 'light.cuisine' } },
        { condition: 'template', value_template: "{{ states('sensor.temperature') > 3 and is_state('switch.x','on') }} {{ trigger.to_state.state }} {{ states.climate.salon.state }}" }]
    };
    expect(extraireEntityIds(auto, new Set(['light.turn_on']))).toEqual(
      ['binary_sensor.bouton', 'climate.salon', 'light.cuisine', 'light.salon', 'sensor.temperature', 'switch.x']
    );
  });

  it('un domaine inconnu ou un attribut (trigger.entity_id, hass.states) n\'est pas une entité', () => {
    expect(extraireEntityIds({ a: 'trigger.entity_id', b: 'this.attributes.x', c: 'config.yaml', d: 'sensor' })).toEqual([]);
  });
});

describe('suggerer', () => {
  it('propose l\'entité existante la plus proche du même domaine', () => {
    const ex = ['light.lumiere_plafonnier_toilettes_du_haut_etage', 'light.salon', 'sensor.lumiere_plafonnier_toilettes_du_haut_etage'];
    expect(suggerer('light.lumiere_plafonnier_toilettes_du_haut_1er_etage', ex)[0]).toBe('light.lumiere_plafonnier_toilettes_du_haut_etage');
    expect(suggerer('light.tout_autre_chose_sans_rapport_du_tout', ex)).toEqual([]);
  });
});

describe('HaReferencesClient', () => {
  const ha = {
    getAllEntities: () => [{ entity_id: 'light.salon', attributes: {}, friendly_name: 'Salon' }, { entity_id: 'script.s1', attributes: {}, friendly_name: 'S1' }],
    callWs: async (m: Record<string, unknown>) => {
      if (m.type === 'config/entity_registry/list') return [{ entity_id: 'sensor.desactive', disabled_by: 'user' }, { entity_id: 'light.orpheline' }];
      if (m.type === 'get_services') return { light: { turn_on: {} } };
      throw new Error('inconnu');
    },
    callRest: async () => ({ status: 200, body: { sequence: [{ action: 'light.turn_on', target: { entity_id: 'light.fantome' } }] } })
  };
  const automations = {
    list: () => [{ id: 'a1', alias: 'Mon auto', etat: 'on', entity_id: 'automation.a1' }],
    get: async () => ({ ok: true as const, config: { triggers: [{ entity_id: 'light.salon' }, { entity_id: 'sensor.desactive' }, { entity_id: 'light.salin' }, { entity_id: 'light.orpheline' }] } })
  };
  const tableaux = {
    lire: async (u?: string | null) => (u === undefined ? { tableaux: [{ url_path: 'plan-x', title: 'Plan' }] } : { existe: true, config: { views: [{ cards: [{ entity: 'light.disparu' }] }] } }),
    lireEnergie: async () => ({ energy_sources: [] })
  };

  it('rapporte seulement les entités absentes (une entité désactivée existe), avec suggestion', async () => {
    const r = (await new HaReferencesClient(ha as never, automations as never, tableaux as never).verifier()) as {
      references_manquantes: number; rapports: Array<{ source: string; manquants: Array<{ entity_id: string; suggestions: string[] }> }>;
    };
    expect(r.rapports.map((x) => x.source).sort()).toEqual(['automatisation a1', 'script s1', 'tableau plan-x']);
    const auto = r.rapports.find((x) => x.source === 'automatisation a1')!;
    expect(auto.manquants).toEqual([
      { type: 'entité', id: 'light.salin', suggestions: ['light.salon'] },
      { type: 'entité orpheline', id: 'light.orpheline', suggestions: [] }
    ]);
    expect(r.references_manquantes).toBe(4);
  });

  it('portée limitée : seules les sources demandées sont lues', async () => {
    const r = (await new HaReferencesClient(ha as never, automations as never, tableaux as never).verifier(['automatisations'])) as { sources_examinees: number };
    expect(r.sources_examinees).toBe(1);
  });
});


describe('extraireCitations', () => {
  it("services (clés action/service), appareils (device_id) et pièces (area_id) sont distingués des entités", () => {
    const c = extraireCitations({
      actions: [{ action: 'notify.mobile_app_sm_g970f', data: { message: 'x' } },
        { action: 'light.turn_on', target: { area_id: 'salon', device_id: 'a'.repeat(32), entity_id: 'light.salon' } },
        { service: 'timer.start', data: { entity_id: 'timer.minuterie_' } }],
      triggers: [{ platform: 'event', event_type: 'timer.finished' }, { platform: 'state', entity_id: ['sensor.x'], device_id: ['b'.repeat(32)] }]
    });
    expect(c.services).toEqual(['light.turn_on', 'notify.mobile_app_sm_g970f', 'timer.start']);
    expect(c.entites).toEqual(['light.salon', 'sensor.x']);   // ni timer.finished (événement) ni timer.minuterie_ (début de nom)
    expect(c.pieces).toEqual(['salon']);
    expect(c.appareils).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });
});

describe('HaReferencesClient : services, appareils, pièces', () => {
  const ha = {
    getAllEntities: () => [],
    callWs: async (m: Record<string, unknown>) => {
      if (m.type === 'get_services') return { light: { turn_on: {} } };
      if (m.type === 'config/device_registry/list') return [{ id: 'a'.repeat(32) }];
      if (m.type === 'config/area_registry/list') return [{ area_id: 'salon' }];
      return [];
    },
    callRest: async () => ({ status: 200, body: {} })
  };
  it('signale un service, un appareil et une pièce inexistants', async () => {
    const auto = { ok: true as const, config: { actions: [{ action: 'notify.vieux', target: { area_id: 'cave', device_id: 'c'.repeat(32) } }, { action: 'light.turn_on', target: { area_id: 'salon', device_id: 'a'.repeat(32) } }] } };
    const r = (await new HaReferencesClient(ha as never, { list: () => [{ id: 'x', alias: 'X' }], get: async () => auto } as never, { lire: async () => ({ tableaux: [] }), lireEnergie: async () => ({}) } as never).verifier(['automatisations'])) as { rapports: Array<{ manquants: Array<{ type: string; id: string }> }> };
    expect(r.rapports[0].manquants.map((m) => `${m.type}:${m.id}`).sort()).toEqual(['appareil:' + 'c'.repeat(32), 'pièce:cave', 'service:notify.vieux']);
  });
});
