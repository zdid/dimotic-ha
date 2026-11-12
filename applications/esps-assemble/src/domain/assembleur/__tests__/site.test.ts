import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { assemblerPaquet } from '../paquet';
import { genererSite, CHEMIN_SITE } from '../site';
import { lireZip } from '../../../../../esphome/dist/domain/factory/zip';

// Bibliothèque et fiches RÉELLES du dépôt (conception-esphome-assembleur v1.8 : broker du site généré, plus dans les fiches).
const RACINE = path.resolve(__dirname, '..', '..', '..', '..');
const SITE = { id: 'stfort', broker: { hote: '192.168.178.51', port: 1883 } };

describe('broker du site généré (v1.8)', () => {
  it('generes/site.yaml contient broker et port', () => {
    expect(genererSite('stfort', SITE.broker)).toContain('broker: "192.168.178.51"');
    expect(genererSite('stfort', SITE.broker)).toContain('port_broker: "1883"');
  });
  it('poêle : paquet avec generes/site.yaml, aucune adresse de broker dans la fiche', () => {
    const r = assemblerPaquet(RACINE, 'poele-thermostat-sam', 1, () => new Date('2026-11-12T18:00:00Z'), new Map(), SITE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fichiers = new Map(lireZip(r.zip).map((e) => [e.chemin, e.contenu] as const));
    expect(fichiers.get(CHEMIN_SITE)?.toString()).toContain('192.168.178.51');
    expect(fichiers.get('poele-thermostat-sam.yaml')?.toString()).not.toMatch(/broker/);
    expect(fichiers.get('bibliotheque/elements/transport-mqtt/element.yaml')?.toString()).toContain('generes/site.yaml');
  });
  it('broker du site inconnu : refus explicite', () => {
    const r = assemblerPaquet(RACINE, 'poele-thermostat-sam', 1, undefined, new Map(), { id: 'stfort', broker: { hote: '', port: 1883 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erreurs.join(' ')).toMatch(/broker MQTT du site inconnu/);
  });
});
