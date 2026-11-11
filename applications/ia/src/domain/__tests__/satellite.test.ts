import { describe, it, expect } from 'vitest';
import { lireSatellite, lieuDuSatellite } from '../satellite';
import type { OllamaMessage } from '../types';

const sys = (content: string): OllamaMessage => ({ role: 'system', content });
const u: OllamaMessage = { role: 'user', content: 'mets FIP' };
const sats = { hasat3: 'salon', 'hasat-cuisine': 'cuisine' };

describe('satellite (specs v1.39 §16.14)', () => {
  it('lit le repère', () => {
    expect(lireSatellite([sys('Tu es…\n[satellite: hasat-cuisine | pièce: Cuisine]\nsuite'), u])).toEqual({ nom: 'hasat-cuisine', piece: 'Cuisine' });
  });
  it('table des satellites prioritaire sur la pièce HA', () => {
    expect(lieuDuSatellite([sys('[satellite: hasat3 | pièce: Salle]'), u], sats)).toBe('salon');
  });
  it('satellite absent de la table → pièce HA en minuscules', () => {
    expect(lieuDuSatellite([sys('[satellite: hasat9 | pièce: Bureau]'), u], sats)).toBe('bureau');
  });
  it('casse du nom ignorée', () => {
    expect(lieuDuSatellite([sys('[satellite: HASAT-Cuisine | pièce: ]'), u], sats)).toBe('cuisine');
  });
  it('pas d appareil (demande tapée dans HA) → aucun lieu', () => {
    expect(lieuDuSatellite([sys('[satellite: aucun | pièce: ]'), u], sats)).toBeUndefined();
  });
  it('pas de repère → aucun lieu', () => {
    expect(lieuDuSatellite([sys('Tu es un assistant.'), u], sats)).toBeUndefined();
  });
});
