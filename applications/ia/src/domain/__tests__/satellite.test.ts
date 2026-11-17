import { describe, it, expect } from 'vitest';
import { lireSatellite, lieuDuSatellite } from '../satellite';
import type { OllamaMessage } from '../types';

const sys = (content: string): OllamaMessage => ({ role: 'system', content });
const u: OllamaMessage = { role: 'user', content: 'mets FIP' };

describe('satellite (specs v1.42 §16.14)', () => {
  it('lit le repère', () => {
    expect(lireSatellite([sys('Tu es…\n[satellite: hasat-cuisine | pièce: Cuisine]\nsuite'), u])).toEqual({ nom: 'hasat-cuisine', piece: 'Cuisine' });
  });
  it('lieu = pièce HA transmise, en minuscules (plus de table)', () => {
    expect(lieuDuSatellite([sys('[satellite: hasat3 | pièce: Salle]'), u])).toBe('salle');
    expect(lieuDuSatellite([sys('[satellite: hasat-respeaker | pièce: Chambre du bas]'), u])).toBe('chambre du bas');
  });
  it('appareil sans pièce → aucun lieu', () => {
    expect(lieuDuSatellite([sys('[satellite: hasat-cuisine | pièce: ]'), u])).toBeUndefined();
  });
  it('pas d appareil (demande tapée dans HA) → aucun lieu', () => {
    expect(lieuDuSatellite([sys('[satellite: aucun | pièce: ]'), u])).toBeUndefined();
  });
  it('pas de repère → aucun lieu', () => {
    expect(lieuDuSatellite([sys('Tu es un assistant.'), u])).toBeUndefined();
  });
});
