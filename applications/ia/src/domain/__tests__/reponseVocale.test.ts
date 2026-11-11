import { describe, it, expect } from 'vitest';
import { phraseConfirmationAction, echangeLibre, annonceActionSansExecution, DEBUT_CONFIRMATION } from '../reponseVocale';
import type { OllamaMessage } from '../types';

const u = (content: string): OllamaMessage => ({ role: 'user', content });
const a = (content: string): OllamaMessage => ({ role: 'assistant', content });

describe('phraseConfirmationAction', () => {
  it('formule une action simple', () => {
    expect(phraseConfirmationAction({ verbe: 'allumer', quoi: 'lumière', lieux: ['salon'] })).toBe("C'est fait, j'ai allumé : lumière, salon.");
  });
  it('verbe accentué, plusieurs lieux', () => {
    expect(phraseConfirmationAction({ verbe: 'éteindre', quoi: 'lumière', lieux: ['salon', 'cuisine'] })).toBe("C'est fait, j'ai éteint : lumière, salon, cuisine.");
  });
  it('avec valeur et sans lieu', () => {
    expect(phraseConfirmationAction({ verbe: 'régler', quoi: 'thermostat', valeur: 19 })).toBe("C'est fait, j'ai réglé : thermostat à 19.");
  });
  it('verbe inconnu gardé tel quel', () => {
    expect(phraseConfirmationAction({ verbe: 'zapper', quoi: 'télé' })).toBe("C'est fait, j'ai zapper : télé.");
  });
  it('ne contient jamais de nom technique', () => {
    expect(phraseConfirmationAction({ verbe: 'allumer', quoi: 'lumière', lieux: ['bibliothèque'] })).not.toMatch(/turn_on|light\./);
  });
});

describe('echangeLibre', () => {
  it('conversation neuve', () => {
    expect(echangeLibre([u('allume le salon')])).toBe(true);
  });
  it('après une action conclue (cas hasat3 du 11/11)', () => {
    expect(echangeLibre([u('allume le salon'), a("C'est fait, j'ai allumé : lumière, salon."), u('allume la bibliothèque')])).toBe(true);
  });
  it('après une demande de précision', () => {
    expect(echangeLibre([u('programme le chauffage'), a('Pour quelle heure ?'), u('7 heures')])).toBe(false);
  });
  it('« ? » suivi d espaces', () => {
    expect(echangeLibre([u('x'), a('Lequel ?  '), u('y')])).toBe(false);
  });
  it('dernier tour assistant = appel d outil sans texte : on regarde la dernière réponse écrite', () => {
    const tool: OllamaMessage = { role: 'assistant', content: '', tool_calls: [] };
    expect(echangeLibre([u('a'), a('Fait.'), u('b'), tool])).toBe(true);
  });
  it('seulement des tours assistant vides : prudence, pas libre', () => {
    expect(echangeLibre([u('a'), { role: 'assistant', content: '' }, u('b')])).toBe(false);
  });
});

describe('annonceActionSansExecution', () => {
  it('message technique imité, aucune action', () => {
    expect(annonceActionSansExecution('homeassistant.turn_on exécuté sur light.salle_bibliotheque.', undefined)).toBe(true);
  });
  it('confirmation imitée, action en échec', () => {
    expect(annonceActionSansExecution(`${DEBUT_CONFIRMATION}, j'ai allumé : lumière, salon.`, false)).toBe(true);
  });
  it('action réellement réussie : on laisse passer', () => {
    expect(annonceActionSansExecution(`${DEBUT_CONFIRMATION}, j'ai allumé : lumière, salon.`, true)).toBe(false);
  });
  it('réponse d état ordinaire : on laisse passer', () => {
    expect(annonceActionSansExecution('La lumière du salon est déjà allumée.', undefined)).toBe(false);
  });
});
