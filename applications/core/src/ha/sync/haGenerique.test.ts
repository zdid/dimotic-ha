import { describe, it, expect } from 'vitest';
import { validateWsMessage, validateRestCall } from './haGenerique';

describe('validateWsMessage', () => {
  it('accepte une commande avec type', () => {
    expect(validateWsMessage({ type: 'dimotic_plans/floorplans/get', plan_id: 'original' })).toBeNull();
    expect(validateWsMessage({ type: 'config_entries/get', domain: 'esphome' })).toBeNull();
  });
  it('refuse le reste', () => {
    for (const m of [null, 'x', [], {}, { type: '' }, { type: 'A B' }, { type: 'get_states', id: 3 }]) {
      expect(validateWsMessage(m), JSON.stringify(m)).not.toBeNull();
    }
  });
});

describe('validateRestCall', () => {
  it('accepte un chemin sous /api/', () => {
    expect(validateRestCall('POST', '/api/config/config_entries/flow')).toBeNull();
    expect(validateRestCall('GET', '/api/config/config_entries/entry?domain=esphome')).toBeNull();
    expect(validateRestCall('DELETE', '/api/config/config_entries/flow/abc123')).toBeNull();
  });
  it('refuse autre méthode, autre chemin, remontée, autre hôte', () => {
    expect(validateRestCall('PUT', '/api/x')).not.toBeNull();
    for (const p of ['/auth/token', 'api/x', '/api/../auth', '/api//x', 'http://autre/api/x', '/api/x y', 42]) {
      expect(validateRestCall('GET', p), String(p)).not.toBeNull();
    }
  });
});
