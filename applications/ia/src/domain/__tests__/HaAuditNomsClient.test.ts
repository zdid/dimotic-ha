import { describe, it, expect } from 'vitest';
import { HaAuditNomsClient, slug, suitLaConvention } from '../HaAuditNomsClient';

function fausse() {
  const donnees: Record<string, unknown> = {
    'config/area_registry/list': [{ area_id: 'salle', name: 'Salle' }, { area_id: 'salle_a_manger', name: 'Salle à manger' }, { area_id: 'garage', name: 'Garage' }, { area_id: 'cuisine', name: 'Cuisine' }],
    'config/device_registry/list': [
      { id: 'd1', name: 'Poêle', area_id: 'salle', manufacturer: 'MCZ', model: 'Maestro' },
      { id: 'd2', name: 'poêle---switch thermostat--salle--rez de chaussée--maison', area_id: 'salle' },
      { id: 'd3', name: 'Four', name_by_user: 'four---cuisine', area_id: 'cuisine' },
      { id: 'd4', name: 'Soleil', entry_type: 'service' },
      { id: 'd5', name: 'Banc', area_id: 'garage' },
      { id: 'd7', name: 'Lampe', area_id: 'salle_a_manger' },
      { id: 'd8', name: 'Bibliothèque', area_id: 'salle' },
      { id: 'd6', name: 'Éteint', area_id: 'cuisine', disabled_by: 'user' }
    ],
    'config/entity_registry/list': [
      { entity_id: 'climate.salle_poele', device_id: 'd1', platform: 'maestro_mcz' },
      { entity_id: 'sensor.salle_poele_temp', device_id: 'd1', platform: 'maestro_mcz' },
      { entity_id: 'switch.salle_switch_thermostat_switch', device_id: 'd2', platform: 'mqtt' },
      { entity_id: 'switch.cuisine_four', device_id: 'd3', platform: 'mqtt' },
      { entity_id: 'sensor.soleil_prochain', device_id: 'd4', platform: 'sun' },
      { entity_id: 'switch.infra_banc_switch', device_id: 'd5', platform: 'mqtt' },
      { entity_id: 'light.salle_bibliotheque', device_id: 'd8', platform: 'mqtt' },
      { entity_id: 'switch.salle_a_manger_lampe', device_id: 'd7', area_id: 'salle_a_manger' },
      { entity_id: 'light.salle_a_manger_lampe_2', device_id: 'd7', area_id: 'salle_a_manger' },
      { entity_id: 'automation.salle_a_manger_bouton' },
      { entity_id: 'switch.cuisine_eteint', device_id: 'd6', platform: 'mqtt', disabled_by: 'user' }
    ],
    'get_states': [{ entity_id: 'light.salle_bibliotheque', attributes: { attributs_taxonomie: { quoi: 'bibliothèque' } } }]
  };
  return { callWs: async (m: Record<string, unknown>) => donnees[String(m.type)] ?? [] } as never;
}

describe('HaAuditNomsClient', () => {
  it('slug et convention', () => {
    expect(slug('Salle à manger')).toBe('salle_a_manger');
    expect(suitLaConvention('four---cuisine')).toBe(true);
    expect(suitLaConvention('Poêle')).toBe(false);
    expect(suitLaConvention('x---')).toBe(false);
  });

  it('repère les appareils hors convention (services, désactivés et conformes écartés) avec pièce et suggestion', async () => {
    const r = (await new HaAuditNomsClient(fausse()).auditer('appareils')) as { resume: Record<string, number>; horsConvention: Array<{ nom: string; piece: string | null; plateformes: string[]; suggestion: string | null }>; identifiantsDecales?: unknown };
    // « Bibliothèque » (nom court) porte la taxonomie de NOMMAGE : conforme ; « Lampe » (d7) n'en a pas : hors convention
    expect(r.resume.horsConvention).toBe(3);
    expect(r.horsConvention.map((h) => h.nom)).toEqual(['Banc', 'Lampe', 'Poêle']);
    expect(r.horsConvention.find((h) => h.nom === 'Poêle')).toMatchObject({ piece: 'Salle', plateformes: ['maestro_mcz'], suggestion: 'Poêle---salle' });
    expect(r.identifiantsDecales).toBeUndefined();
  });

  it('aucun faux positif : identifiants cohérents avec leur pièce (plus long préfixe « salle_a_manger », suffixe _2, automatisation sans appareil ignorée)', async () => {
    const r = (await new HaAuditNomsClient(fausse()).auditer('identifiants')) as { identifiantsDecales: unknown[]; resume: Record<string, number> };
    expect(r.identifiantsDecales).toEqual([]);
    expect(r.resume.identifiantsDecales).toBe(0);
  });

  it('un identifiant préfixé par une AUTRE pièce que l\'actuelle est signalé ; le plus long préfixe l\'emporte ; limite respectée', async () => {
    const ha = {
      callWs: async (m: Record<string, unknown>) => ({
        'config/area_registry/list': [{ area_id: 'salle', name: 'Salle' }, { area_id: 'garage', name: 'Garage' }],
        'config/device_registry/list': [{ id: 'd', name: 'x---garage', area_id: 'garage' }],
        'config/entity_registry/list': [
          { entity_id: 'switch.salle_banc_switch', device_id: 'd' },
          { entity_id: 'switch.garage_ok', device_id: 'd' },
          { entity_id: 'switch.salle_banc_deux', device_id: 'd' },
          { entity_id: 'switch.garage_banc_switch', device_id: 'd2' }
        ]
      } as Record<string, unknown>)[String(m.type)] ?? []
    } as never;
    const r = (await new HaAuditNomsClient(ha).auditer('identifiants', 1)) as { identifiantsDecales: Array<{ entity_id: string; attendu: string; attendu_deja_pris: boolean }>; resume: Record<string, number>; tronque?: string };
    expect(r.resume.identifiantsDecales).toBe(3);
    expect(r.identifiantsDecales).toHaveLength(1);
    expect(r.tronque).toMatch(/limitées/);
    const tout = (await new HaAuditNomsClient(ha).auditer('identifiants', 50)) as { identifiantsDecales: Array<{ entity_id: string; attendu: string; attendu_deja_pris: boolean }> };
    expect(tout.identifiantsDecales.find((x) => x.entity_id === 'switch.salle_banc_switch')).toMatchObject({ attendu: 'switch.garage_banc_switch', attendu_deja_pris: true });
  });
});
