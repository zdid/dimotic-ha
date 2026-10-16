// ArexxPilote.test.ts — gestion des capteurs AREXX par l'agent IA (conception-gestion-pilotes_specs v1.2).
import { describe, it, expect, beforeEach } from 'vitest';
import { ArexxPilote, numeroBrut, type ArexxPiloteHote } from '../ArexxPilote';
import { SensorRegistry } from '../SensorRegistry';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const t0 = new Date('2026-10-15T20:00:00Z');

function lecture(rawId: string, kind: 'temperature' | 'humidity' = 'temperature', value = 20) {
  return { rawId, kind, value, signalDbm: -70, timestamp: t0 };
}

describe('ArexxPilote', () => {
  let registry: SensorRegistry;
  let appels: string[];
  let pilote: ArexxPilote;
  let sauvegardes: number;

  beforeEach(() => {
    registry = new SensorRegistry(logger);
    appels = [];
    sauvegardes = 0;
    // Un capteur déjà configuré et transmis (température + humidité), deux capteurs neufs découverts.
    registry.loadConfigured({
      arexx_8962: { uniqueId: 'arexx_8962', kind: 'temperature', name: 'Température---salle de bain', transmitToHa: true },
      arexx_8962_rh: { uniqueId: 'arexx_8962_rh', kind: 'humidity', name: 'Humidité---salle de bain', transmitToHa: true },
      arexx_5000: { uniqueId: 'arexx_5000', kind: 'temperature', name: 'Température---cuisine', transmitToHa: false }
    });
    registry.handleReading(lecture('7777'));
    registry.handleReading(lecture('7777', 'humidity', 55));
    registry.handleReading(lecture('9999'));
    const hote: ArexxPiloteHote = {
      registry,
      sauvegarder: () => { sauvegardes++; return '/data/arexx-sensors.yaml.bak-X'; },
      persister: () => { appels.push('persister'); },
      publierDecouverte: (c) => { appels.push(`publier:${c.uniqueId}`); },
      retirerDecouverte: (id) => { appels.push(`retirer:${id}`); },
      rafraichir: () => {},
      attendreRetraitHa: async (noms) => { appels.push(`attendre:${noms.join('|')}`); return { absent: true, attenteMs: 1, restantes: [] }; },
      relire: () => { appels.push('relire'); return 3; }
    };
    pilote = new ArexxPilote(hote);
  });

  it('numeroBrut accepte « 8962 », « arexx_8962 » et « arexx_8962_rh »', () => {
    expect(numeroBrut('8962')).toBe('8962');
    expect(numeroBrut('arexx_8962')).toBe('8962');
    expect(numeroBrut('arexx_8962_rh')).toBe('8962');
  });

  it('lister / decouverts : valeur, signal et type', async () => {
    const l = (await pilote.lire('lister')) as { capteurs: Array<{ id: string }> };
    expect(l.capteurs.map((c) => c.id)).toEqual(['arexx_8962', 'arexx_8962_rh', 'arexx_5000']);
    const d = (await pilote.lire('decouverts')) as { decouverts: Array<{ id: string; derniereValeur: number; signalDbm: number }> };
    expect(d.decouverts.map((x) => x.id).sort()).toEqual(['arexx_7777', 'arexx_7777_rh', 'arexx_9999']);
    expect(d.decouverts.find((x) => x.id === 'arexx_7777_rh')).toMatchObject({ derniereValeur: 55, signalDbm: -70 });
  });

  describe('remplacer', () => {
    it('température ET humidité suivent ; suppression (retrait HA) AVANT l\'ajout au même nommage', async () => {
      const prep = await pilote.preparer('remplacer', { ancien: '8962', nouveau: '7777' });
      expect((prep.apercu as { capteurs: unknown[] }).capteurs).toHaveLength(2);
      await pilote.appliquer('remplacer', { ancien: '8962', nouveau: '7777' });

      // retraits HA en premier, puis écriture, puis publications des neufs
      expect(appels.slice(0, 3)).toEqual(['retirer:arexx_8962', 'retirer:arexx_8962_rh', 'attendre:Température---salle de bain|Humidité---salle de bain']);
      expect(appels.indexOf('persister')).toBeGreaterThan(appels.indexOf('retirer:arexx_8962_rh'));
      expect(appels.slice(appels.indexOf('persister') + 1).sort()).toEqual(['publier:arexx_7777', 'publier:arexx_7777_rh']);

      expect(registry.getSensor('arexx_8962')).toBeUndefined();
      expect(registry.getSensor('arexx_7777')).toMatchObject({ name: 'Température---salle de bain', transmitToHa: true, kind: 'temperature' });
      expect(registry.getSensor('arexx_7777_rh')).toMatchObject({ name: 'Humidité---salle de bain', transmitToHa: true, kind: 'humidity' });
      expect(registry.getDiscovered('arexx_7777')).toBeUndefined(); // sorti des découverts
      expect(sauvegardes).toBe(1);
    });

    it('capteur non transmis : aucun retrait HA, aucune publication', async () => {
      registry.handleReading(lecture('4444'));
      await pilote.appliquer('remplacer', { ancien: '5000', nouveau: '4444' });
      expect(appels).toEqual(['persister']);
      expect(registry.getSensor('arexx_4444')).toMatchObject({ name: 'Température---cuisine', transmitToHa: false });
    });

    it('refuse si le neuf n\'est pas (encore) dans les découverts, sans rien modifier', async () => {
      await expect(pilote.preparer('remplacer', { ancien: '5000', nouveau: '1234' })).rejects.toThrow(/découverts/);
      expect(registry.getSensor('arexx_5000')).toBeDefined();
    });

    it('refuse si le neuf ne remonte que la température alors que l\'ancien avait aussi l\'humidité', async () => {
      await expect(pilote.preparer('remplacer', { ancien: '8962', nouveau: '9999' })).rejects.toThrow(/arexx_9999_rh/);
    });

    it('refuse un ancien inconnu ou un neuf déjà configuré', async () => {
      await expect(pilote.preparer('remplacer', { ancien: '1', nouveau: '7777' })).rejects.toThrow(/Aucun capteur configuré/);
      await expect(pilote.preparer('remplacer', { ancien: '8962', nouveau: '5000' })).rejects.toThrow();
    });
  });

  describe('adopter', () => {
    it('refuse une qualification incomplète', async () => {
      await expect(pilote.preparer('adopter', { id: 'arexx_9999', quoi: 'Température' })).rejects.toThrow(/lieu/);
    });
    it('compose le nom quoi---lieuPrécis--lieu, transmitToHa faux par défaut', async () => {
      await pilote.appliquer('adopter', { id: 'arexx_9999', quoi: 'Température', lieu: 'salon', lieuPrecis: 'canapé' });
      expect(registry.getSensor('arexx_9999')).toMatchObject({ name: 'Température---canapé--salon', transmitToHa: false });
      expect(appels).toEqual(['persister']); // pas de publication : aucune entité HA
    });
    it('transmitToHa vrai : publie la découverte', async () => {
      await pilote.appliquer('adopter', { id: 'arexx_9999', quoi: 'Température', lieu: 'salon', transmitToHa: true });
      expect(registry.getSensor('arexx_9999')?.name).toBe('Température---salon');
      expect(appels).toEqual(['persister', 'publier:arexx_9999']);
    });
    it('refuse un séparateur de nommage dans un champ, et un capteur déjà adopté ou inconnu', async () => {
      await expect(pilote.preparer('adopter', { id: 'arexx_9999', quoi: 'a--b', lieu: 'x' })).rejects.toThrow(/--/);
      await expect(pilote.preparer('adopter', { id: 'arexx_5000', quoi: 'T', lieu: 'x' })).rejects.toThrow();
      await expect(pilote.preparer('adopter', { id: 'arexx_0', quoi: 'T', lieu: 'x' })).rejects.toThrow(/découverts/);
    });
  });

  describe('supprimer', () => {
    it('capteur transmis : retrait HA puis suppression', async () => {
      await pilote.appliquer('supprimer', { id: 'arexx_8962' });
      expect(appels).toEqual(['retirer:arexx_8962', 'persister']);
      expect(registry.getSensor('arexx_8962')).toBeUndefined();
    });
    it('capteur non transmis : pas de retrait HA', async () => {
      await pilote.appliquer('supprimer', { id: 'arexx_5000' });
      expect(appels).toEqual(['persister']);
    });
  });

  describe('modifier', () => {
    it('retire de HA puis redéclare au nouveau nom (une modification = suppression puis ajout)', async () => {
      await pilote.appliquer('modifier', { id: 'arexx_8962', lieu: 'sdb étage' });
      expect(appels).toEqual(['retirer:arexx_8962', 'attendre:Température---salle de bain', 'persister', 'publier:arexx_8962']);
      expect(registry.getSensor('arexx_8962')?.name).toBe('Température---sdb étage');
    });
  });

  describe('effacer / ignorer', () => {
    it('effacer : mémoire seulement — aucune sauvegarde, aucune écriture, HA non touché', async () => {
      await pilote.appliquer('effacer', { id: 'arexx_9999' });
      expect(registry.getDiscovered('arexx_9999')).toBeUndefined();
      expect(appels).toEqual([]);
      expect(sauvegardes).toBe(0);
    });
    it('effacer tout vide les découverts', async () => {
      await pilote.appliquer('effacer', { tout: true });
      expect(registry.getDiscoveredSensors()).toHaveLength(0);
    });
    it('un effacé réapparaît à sa prochaine émission', async () => {
      await pilote.appliquer('effacer', { id: 'arexx_9999' });
      registry.handleReading(lecture('9999'));
      expect(registry.getDiscovered('arexx_9999')).toBeDefined();
    });
    it('ignorer : persisté dans la liste d\'exclusion, plus jamais reproposé', async () => {
      await pilote.appliquer('ignorer', { id: 'arexx_9999' });
      expect(registry.getIgnored()).toEqual(['arexx_9999']);
      expect(appels).toEqual(['persister']);
      registry.handleReading(lecture('9999'));
      expect(registry.getDiscovered('arexx_9999')).toBeUndefined();
    });
  });

  it('redemarrer : relit le fichier, sans sauvegarde ni écriture', async () => {
    const r = await pilote.appliquer('redemarrer', {});
    expect(appels).toEqual(['relire']);
    expect(sauvegardes).toBe(0);
    expect((r.resultat as { relus: number }).relus).toBe(3);
  });

  it('le jeton change si l\'état change entre l\'aperçu et l\'application (empreinte d\'état)', async () => {
    const a = await pilote.preparer('supprimer', { id: 'arexx_5000' });
    registry.setTransmitToHa('arexx_5000', true);
    const b = await pilote.preparer('supprimer', { id: 'arexx_5000' });
    expect(JSON.stringify(a.etat)).not.toBe(JSON.stringify(b.etat));
  });

  it('adopter : lieu père (étage) et grand-père (bâtiment) font partie du nom', async () => {
    const { apercu } = await pilote.preparer('adopter', { id: 'arexx_7777', quoi: 'Température', lieu: 'Chambre', lieuPrecis: 'Lit', lieuPere: 'Étage', lieuGrandPere: 'Maison' });
    expect(JSON.stringify(apercu)).toContain('Température---Lit--Chambre--Étage--Maison');
    await expect(pilote.preparer('adopter', { id: 'arexx_7777', quoi: 'T', lieu: 'C', lieuGrandPere: 'Maison' })).rejects.toThrow(/lieuPere/);
  });
});
