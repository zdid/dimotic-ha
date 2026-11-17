import { describe, it, expect } from 'vitest';
import { HaReglageClient, controlerValeur } from '../HaReglageClient';

function faux() {
  const appels: Array<Record<string, unknown>> = [];
  const donnees: Record<string, unknown> = {
    'config/device_registry/list': [
      { id: 'd1', name: 'TS0202', name_by_user: 'détecteur---escalier--couloir--étage', model: 'TS0202' },
      { id: 'd2', name: 'Prise', name_by_user: 'prise---salon' }
    ],
    'config/entity_registry/list': [
      { entity_id: 'binary_sensor.escalier_occupancy', device_id: 'd1' },
      { entity_id: 'select.escalier_sensitivity', device_id: 'd1', entity_category: 'config' },
      { entity_id: 'number.escalier_keep_time', device_id: 'd1', entity_category: 'config' },
      { entity_id: 'button.escalier_identify', device_id: 'd1', entity_category: 'config' },
      { entity_id: 'switch.salon_led', device_id: 'd2', entity_category: 'config' },
      { entity_id: 'switch.salon', device_id: 'd2' }
    ],
    'get_states': [
      { entity_id: 'select.escalier_sensitivity', state: 'high', attributes: { options: ['low', 'medium', 'high'] } },
      { entity_id: 'number.escalier_keep_time', state: '30', attributes: { min: 10, max: 120, step: 10, unit_of_measurement: 's' } },
      { entity_id: 'switch.salon_led', state: 'on', attributes: {} }
    ]
  };
  return { appels, ha: { callWs: async (m: Record<string, unknown>) => { appels.push(m); return donnees[String(m.type)] ?? {}; } } as never };
}

describe('HaReglageClient', () => {
  it('lit les réglages d\'un appareil par nom partiel, entity_id ou device_id', async () => {
    const c = new HaReglageClient(faux().ha);
    for (const cible of ['escalier', 'binary_sensor.escalier_occupancy', 'd1']) {
      const r = (await c.lire(cible)) as { appareil: { device_id: string }; reglages: Array<{ entity_id: string; options?: string[] }>; non_modifiables?: string[] };
      expect(r.appareil.device_id).toBe('d1');
      expect(r.reglages.map((x) => x.entity_id)).toEqual(['select.escalier_sensitivity', 'number.escalier_keep_time']);
      expect(r.reglages[0].options).toEqual(['low', 'medium', 'high']);
      expect(r.non_modifiables).toEqual(['button.escalier_identify']);
    }
    await expect(c.lire('inconnu')).rejects.toThrow(/Aucun appareil/);
  });

  it('contrôle les valeurs', () => {
    const sel = { entity_id: 's', state: 'high', attributes: { options: ['low', 'medium', 'high'] } };
    expect(controlerValeur('select', sel, 'medium')).toBe('medium');
    expect(() => controlerValeur('select', sel, 'moyen')).toThrow(/option/);
    const num = { entity_id: 'n', state: '30', attributes: { min: 10, max: 120, step: 10 } };
    expect(controlerValeur('number', num, '60')).toBe(60);
    expect(() => controlerValeur('number', num, 5)).toThrow(/minimum/);
    expect(() => controlerValeur('number', num, 35)).toThrow(/pas/);
    expect(controlerValeur('switch', undefined, false)).toBe('off');
  });

  it('aperçu sans écriture, puis appel du bon service avec confirme', async () => {
    const { appels, ha } = faux();
    const c = new HaReglageClient(ha);
    const a = (await c.modifier('select.escalier_sensitivity', 'medium', false)) as { apercu?: boolean; avant: string; annuler: string };
    expect(a.apercu).toBe(true);
    expect(a.avant).toBe('high');
    expect(a.annuler).toContain('"high"');
    expect(appels.some((m) => m.type === 'call_service')).toBe(false);
    await c.modifier('select.escalier_sensitivity', 'medium', true);
    expect(appels.find((m) => m.type === 'call_service')).toMatchObject({ domain: 'select', service: 'select_option', service_data: { option: 'medium' }, target: { entity_id: 'select.escalier_sensitivity' } });
    await c.modifier('switch.salon_led', 'off', true);
    expect(appels.filter((m) => m.type === 'call_service').pop()).toMatchObject({ domain: 'switch', service: 'turn_off' });
  });

  it('refuse les entités principales et les types non pris en charge', async () => {
    const c = new HaReglageClient(faux().ha);
    await expect(c.modifier('switch.salon', 'off', true)).rejects.toThrow(/pas un réglage de configuration/);
    await expect(c.modifier('button.escalier_identify', 'x', true)).rejects.toThrow(/select, number et switch/);
    await expect(c.modifier('number.escalier_keep_time', 500, true)).rejects.toThrow(/maximum/);
  });
});
