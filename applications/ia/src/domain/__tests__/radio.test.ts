import { describe, it, expect } from 'vitest';
import { reconnaitreCommandeRadio, trouverStation, normaliser, DEFAULT_RADIO_CONFIG, radioSchema } from '../radio';

const cfg = { ...DEFAULT_RADIO_CONFIG, lecteurs: { salon: 'media_player.hasat3', cuisine: 'media_player.cuisine' } };

describe('reconnaitreCommandeRadio', () => {
  it.each([
    ['Mets France Inter.', 'France Inter'],
    ['joue FIP', 'FIP'],
    ['Lance RTL', 'RTL'],
    ['mets franceinfo', 'France Info'],
    ['Mets France Info', 'France Info'],
    ['Mets France Musique', 'France Musique'],
    ['Écoute Nostalgie', 'Nostalgie'],
    ['mets inter', 'France Inter']
  ])('« %s » → %s', (phrase, station) => {
    const c = reconnaitreCommandeRadio(phrase, cfg);
    expect(c?.action).toBe('jouer');
    expect(c?.station?.nom).toBe(station);
    expect(c?.lieu).toBeUndefined();
  });
  it('lieu de la table', () => {
    expect(reconnaitreCommandeRadio('Mets FIP dans la cuisine', cfg)).toMatchObject({ action: 'jouer', lieu: 'cuisine' });
  });
  it('lieu hors table : gardé tel quel (refus clair à l exécution)', () => {
    expect(reconnaitreCommandeRadio('mets FIP dans le garage', cfg)?.lieu).toBe('garage');
  });
  it.each(['Arrête la radio.', 'coupe la musique', 'stop', 'éteins la radio'])('« %s » → arrêt', (phrase) => {
    expect(reconnaitreCommandeRadio(phrase, cfg)?.action).toBe('arreter');
  });
  it.each(['Allume le salon', 'éteins la lumière du salon', 'mets la lumière à 50', 'quelle heure est-il', 'mets la radio'])('« %s » → pas une commande radio simple', (phrase) => {
    expect(reconnaitreCommandeRadio(phrase, cfg)).toBeUndefined();
  });
});

describe('trouverStation', () => {
  it('le nom le plus long l emporte (France Info plutôt que info seul)', () => {
    expect(trouverStation(normaliser('mets france info'), cfg.stations)?.nom).toBe('France Info');
  });
  it('mot entier seulement (inter ≠ interrupteur)', () => {
    expect(trouverStation(normaliser('allume l interrupteur'), cfg.stations)).toBeUndefined();
  });
});

describe('radioSchema', () => {
  it('valeurs par défaut : six stations, salon → hasat3', () => {
    const r = radioSchema.parse({});
    expect(r.stations).toHaveLength(6);
    expect(r.lecteurs).toEqual({ salon: 'media_player.hasat3' });
    expect(r.lieuDefaut).toBe('salon');
  });
});
