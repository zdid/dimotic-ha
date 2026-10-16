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
