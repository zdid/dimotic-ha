import { describe, it, expect } from 'vitest';
import { expandHaAbbreviations } from './ha-abbreviations';

describe('expandHaAbbreviations', () => {
  it('développe `dev` et ses clés (ESPHome) : device.name devient lisible par NOMMAGE', () => {
    const p = expandHaAbbreviations({
      name: '', uniq_id: 'u1', stat_t: 'a/state',
      dev: { ids: '840d8ea9f97b', name: 'poêle---switch thermostat--salle--rez de chaussée--maison', mf: 'Espressif', mdl: 'd1_mini', sw: '2025.11.2' }
    });
    expect(p.device).toEqual({ identifiers: '840d8ea9f97b', name: 'poêle---switch thermostat--salle--rez de chaussée--maison', manufacturer: 'Espressif', model: 'd1_mini', sw_version: '2025.11.2' });
    expect(p.dev).toBeUndefined();
    expect(p.unique_id).toBe('u1');
    expect(p.stat_t).toBe('a/state'); // les autres clés abrégées restent comprises par HA
  });
  it('une clé longue déjà présente l\'emporte ; un message déjà en clés longues est inchangé', () => {
    const long = { name: 'x', device: { name: 'n', identifiers: ['a'] }, device_class: 'power', unique_id: 'u' };
    expect(expandHaAbbreviations(long)).toEqual(long);
    expect(expandHaAbbreviations({ device_class: 'a', dev_cla: 'b' }).device_class).toBe('a');
  });
  it('sans bloc appareil : rien à faire', () => {
    expect(expandHaAbbreviations({ name: 'x', obj_id: 'o' })).toEqual({ name: 'x', object_id: 'o' });
  });
});
