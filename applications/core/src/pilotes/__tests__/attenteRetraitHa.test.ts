import { describe, it, expect } from 'vitest';
import { entiteCorrespond } from '../attenteRetraitHa';

describe('entiteCorrespond', () => {
  it('reconnaît un nom de pilote dans le nom d\'entité de HA (casse, accents, ponctuation)', () => {
    expect(entiteCorrespond('Température---salle de bain', 'Température salle de bain')).toBe(true);
    expect(entiteCorrespond('Temperature---Salon--canapé', 'temperature salon canape')).toBe(true);
  });
  it('refuse un autre lieu ou un nom vide', () => {
    expect(entiteCorrespond('Température---cuisine', 'Température salon')).toBe(false);
    expect(entiteCorrespond('', 'Température salon')).toBe(false);
    expect(entiteCorrespond('Température---salon', undefined)).toBe(false);
  });
});

import { slugHa, entiteDeCeNom } from '../attenteRetraitHa';

describe('renommage d\'entity_id', () => {
  it('slugHa suit la règle de HA', () => {
    expect(slugHa('Température salle de bain')).toBe('temperature_salle_de_bain');
    expect(slugHa(' Humidité — Salon (canapé) ')).toBe('humidite_salon_canape');
  });
  it('entiteDeCeNom : nom affiché (quoi, précis, lieu) ou son début ; pas un autre lieu', () => {
    expect(entiteDeCeNom('Température---canapé--salon--étage', 'Température Canapé Salon')).toBe(true);
    expect(entiteDeCeNom('Température---salon--salon', 'Température Salon')).toBe(true);
    expect(entiteDeCeNom('Température---salon--salon', 'Température Salon batterie')).toBe(true);
    expect(entiteDeCeNom('Température---salon', 'Température Cuisine')).toBe(false);
  });
});
