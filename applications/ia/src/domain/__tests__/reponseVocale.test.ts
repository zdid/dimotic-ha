import { describe, it, expect } from 'vitest';
import { phraseConfirmationAction, echangeLibre, annonceActionSansExecution, DEBUT_CONFIRMATION, texteParle } from '../reponseVocale';
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

import { corrigerTranscription } from '../reponseVocale';
describe('transcription corrigée (specs v1.42 §16.17)', () => {
  it('« Et tant. » → « Éteins. » (casse, ponctuation, accents ignorés)', () => {
    expect(corrigerTranscription('Et tant.')).toBe('Éteins.');
    expect(corrigerTranscription('  et  TANT ! ')).toBe('Éteins.');
  });
  it('phrase plus longue ou autre : pas de correction', () => {
    expect(corrigerTranscription('Et tant pis.')).toBeUndefined();
    expect(corrigerTranscription('Allume.')).toBeUndefined();
  });
});

describe('texteParle (§16.18)', () => {
  it('cas réel du 11/11 : code interne et gras retirés', () => {
    expect(texteParle('"quoi_introuvable" : aucun "salons" trouvé dans les lieux connus. Vérifie avec **salon** ?'))
      .toBe('Aucun "salons" trouvé dans les lieux connus. Vérifie avec salon ?');
  });
  it('erreur §0.4 au format JSON → phrase', () => {
    expect(texteParle('{"error": "quoi_introuvable", "quoi": "radiateur", "area": "garage", "phrase_originale": "allume le radiateur du garage"}'))
      .toBe("Je n'ai pas trouvé de radiateur dans garage.");
  });
  it('erreur §0.4 dans un bloc ```json', () => {
    expect(texteParle('```json\n{"error":"quoi_introuvable","quoi":"volet"}\n```')).toBe("Je n'ai pas trouvé de volet.");
  });
  it('Markdown : italique, code, titre, puces, lien', () => {
    expect(texteParle('# Réponse\n- il fait *20* degrés\n- voir `sensor.x` et [la doc](http://a)'))
      .toBe('Réponse\nil fait 20 degrés\nvoir sensor.x et la doc');
  });
  it('texte propre rendu à l’identique (même objet)', () => {
    const s = "C'est fait, j'ai allumé : lumière, salon.";
    expect(texteParle(s)).toBe(s);
  });
  it('multiplication et astérisque isolé conservés', () => {
    expect(texteParle('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});
