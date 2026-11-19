import { describe, it, expect } from 'vitest';
import { filtrerParSection } from '../AppService';

const err = (path: string) => ({ path, message: 'Requis', severity: 'error' as const, section: path.split('.')[0], required: true });
const invalide = { valid: false, errors: [err('ha.ws.token'), err('ha.mqtt.host'), err('core.site')], warnings: [], requiredMissing: [] };

describe('filtrerParSection (socle v4.53 §10.4ter)', () => {
  it('sans section : toutes les erreurs', () => {
    expect(filtrerParSection(invalide).errors).toHaveLength(3);
  });
  it('section machine : seulement core', () => {
    const r = filtrerParSection(invalide, 'machine');
    expect(r.errors.map((e) => e.path)).toEqual(['core.site']);
    expect(r.valid).toBe(false);
  });
  it('section web sans erreur propre : valide', () => {
    const r = filtrerParSection(invalide, 'web');
    expect(r.valid).toBe(true);
    expect(r.requiredMissing).toEqual([]);
  });
  it('section ha : ws seulement, pas mqtt', () => {
    expect(filtrerParSection(invalide, 'ha').errors.map((e) => e.path)).toEqual(['ha.ws.token']);
  });
});
