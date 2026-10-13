import { describe, it, expect } from 'vitest';
import { esphomeConfigSchema, DEFAULT_ESPHOME_CONFIG } from '../config-schema';

describe('configuration', () => {
  it('une configuration vide donne des valeurs par défaut sûres (rien d\'actif)', () => {
    expect(DEFAULT_ESPHOME_CONFIG.usine.actif).toBe(false);
    expect(DEFAULT_ESPHOME_CONFIG.poseur.actif).toBe(false);
    expect(DEFAULT_ESPHOME_CONFIG.usine.conservation.revisions).toBe(5);
    expect(DEFAULT_ESPHOME_CONFIG.usine.premierFlash.reconnaissance).toBe(true);
    expect(DEFAULT_ESPHOME_CONFIG.usine.esphome.image).toMatch(/^esphome\/esphome:\d/); // version figée, jamais latest
  });
  it('accepte l\'exemple de falbala (usine servant deux sites)', () => {
    const c = esphomeConfigSchema.parse({ site: 'stfort', usine: { actif: true, sites: [{ id: 'stfort', mqtt: { hote: '192.168.1.51' } }, { id: 'noisy', mqtt: { hote: '10.10.10.3' } }] } });
    expect(c.usine.sites.map((s) => s.id)).toEqual(['stfort', 'noisy']);
    expect(c.usine.sites[1].mqtt.port).toBe(1883);
  });
  it('refuse deux sites servis de même identifiant', () => {
    expect(() => esphomeConfigSchema.parse({ usine: { sites: [{ id: 'noisy' }, { id: 'noisy' }] } })).toThrow(/id unique/);
  });
  it('le poseur écoute par défaut le broker local', () => {
    expect(DEFAULT_ESPHOME_CONFIG.poseur.mqtt.hote).toBe('127.0.0.1');
  });
});
