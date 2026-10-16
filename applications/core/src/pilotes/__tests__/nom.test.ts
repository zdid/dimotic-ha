import { describe, it, expect } from 'vitest';
import { composerNom, decomposerNom } from '../nom';

describe('nommage commun des pilotes', () => {
  it('compose les formes de la matrice positionnelle', () => {
    expect(composerNom({ quoi: 'Température', lieu: 'Salon' })).toBe('Température---Salon');
    expect(composerNom({ quoi: 'Température', lieu: 'Salon', lieuPrecis: 'Coin Canapé' })).toBe('Température---Coin Canapé--Salon');
    expect(composerNom({ quoi: 'Bouton', lieu: 'Cuisine', lieuPrecis: 'Fenêtre Sud', lieuPere: 'Rez-de-Chaussée' })).toBe('Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée');
    expect(composerNom({ quoi: 'Sèche-serviette', lieu: 'Salle de Bain', lieuPrecis: 'Détecteur Douche', lieuPere: 'Rez-de-Chaussée', lieuGrandPere: 'Maison' }))
      .toBe('Sèche-serviette---Détecteur Douche--Salle de Bain--Rez-de-Chaussée--Maison');
  });

  it('père sans lieu précis : le lieu est répété en tête (position respectée)', () => {
    expect(composerNom({ quoi: 'Frigo', lieu: 'Cuisine', lieuPere: 'Rez-de-Chaussée' })).toBe('Frigo---Cuisine--Cuisine--Rez-de-Chaussée');
    expect(composerNom({ quoi: 'Frigo', lieu: 'Cuisine', lieuPere: 'RDC', lieuGrandPere: 'Maison' })).toBe('Frigo---Cuisine--Cuisine--RDC--Maison');
  });

  it('refuse l\'incomplet et l\'ambigu', () => {
    expect(() => composerNom({ lieu: 'x' })).toThrow(/quoi/);
    expect(() => composerNom({ quoi: 'x' })).toThrow(/lieu/);
    expect(() => composerNom({ quoi: 'x', lieu: 'y', lieuGrandPere: 'Maison' })).toThrow(/exige/);
    expect(() => composerNom({ quoi: 'x', lieu: 'a--b' })).toThrow(/--/);
    expect(() => composerNom({ quoi: 'x---y', lieu: 'z' })).toThrow(/---/);
  });

  it('décompose selon la matrice (l\'inverse)', () => {
    expect(decomposerNom('Température---Salon')).toEqual({ quoi: 'Température', lieu: 'Salon' });
    expect(decomposerNom('Température---Coin Canapé--Salon')).toEqual({ quoi: 'Température', lieuPrecis: 'Coin Canapé', lieu: 'Salon' });
    expect(decomposerNom('Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée--Maison'))
      .toEqual({ quoi: 'Bouton', lieuPrecis: 'Fenêtre Sud', lieu: 'Cuisine', lieuPere: 'Rez-de-Chaussée', lieuGrandPere: 'Maison' });
    // précis == lieu : pas de précision distincte
    expect(decomposerNom('frigo---cuisine--cuisine')).toEqual({ quoi: 'frigo', lieu: 'cuisine' });
  });

  it('modifier : les parties non données reprennent le nom actuel, "" efface', () => {
    const d = decomposerNom('Bouton---Fenêtre Sud--Cuisine--Rez-de-Chaussée--Maison');
    expect(composerNom({ lieu: 'Salon' }, d)).toBe('Bouton---Fenêtre Sud--Salon--Rez-de-Chaussée--Maison');
    expect(composerNom({ lieuPrecis: '' }, d)).toBe('Bouton---Cuisine--Cuisine--Rez-de-Chaussée--Maison');
    expect(composerNom({ lieuPere: '', lieuGrandPere: '' }, d)).toBe('Bouton---Fenêtre Sud--Cuisine');
  });

  it('aller-retour compose ∘ décompose', () => {
    for (const nom of ['A---B', 'A---P--B', 'A---P--B--E', 'A---P--B--E--M', 'A---B--B--E']) {
      expect(composerNom({}, decomposerNom(nom))).toBe(nom);
    }
  });
});
