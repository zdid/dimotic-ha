import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { estCommandeGroupe } from '../classification';
import { RfxComTransceiver } from '../transceiver/RfxComTransceiver';
import type { RfxComRawMessage } from '../types';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function banc() {
  const recus: RfxComRawMessage[] = [];
  const t = new RfxComTransceiver(logger);
  t.onMessage((m) => recus.push(m));
  const fausse = new EventEmitter();
  (t as unknown as { setupProtocolListeners(d: EventEmitter): void }).setupProtocolListeners(fausse);
  return { recus, emettre: (evt: Record<string, unknown>) => fausse.emit('lighting2', { subtype: 0, seqnbr: 1, rssi: 5, level: 15, ...evt }) };
}

describe('estCommandeGroupe', () => {
  it('reconnaît les commandes de groupe de la bibliothèque, pas les autres', () => {
    for (const c of ['Group On', 'Group off', 'Set Group Level']) expect(estCommandeGroupe(c)).toBe(true);
    for (const c of ['On', 'Off', 'Set Level', undefined, 4]) expect(estCommandeGroupe(c)).toBe(false);
  });
});

describe('réception Lighting2 : commande de groupe', () => {
  it("efface le numéro de bouton (reçu à 1) et ne le transmet pas ; commande « id/0 » (groupe)", () => {
    const { recus, emettre } = banc();
    emettre({ id: '0x02780002', unitCode: 1, command: 'Group On' });
    emettre({ id: '0x02780002', unitCode: 1, command: 'Group off' });
    expect(recus).toHaveLength(2);
    for (const m of recus) {
      expect(m.unitCode).toBeUndefined();
      expect(m.commandDeviceId).toBe('0x02780002/0');
      expect(m.sensorId).toBe('0x02780002');
    }
  });

  it('un bouton ordinaire garde son numéro et sa commande « id/numéro »', () => {
    const { recus, emettre } = banc();
    emettre({ id: '0x02780002', unitCode: 1, command: 'On' });
    emettre({ id: '0x02780002', unitCode: 13, command: 'Off' });
    expect(recus.map((m) => m.unitCode)).toEqual([1, 13]);
    expect(recus.map((m) => m.commandDeviceId)).toEqual(['0x02780002/1', '0x02780002/13']);
  });
});

import { estEmetteurRadio } from '../classification';

describe('estEmetteurRadio (pas de rejeu d\'état au démarrage)', () => {
  it('télécommandes et boutons (Lighting*) : oui ; capteurs et compteurs : non', () => {
    for (const t of ['Lighting1', 'Lighting2', 'Lighting4', 'Lighting5', 'Lighting6']) expect(estEmetteurRadio(t)).toBe(true);
    for (const t of ['RFXSensor', 'RFXMeter', 'Blinds1', 'Temp', '']) expect(estEmetteurRadio(t)).toBe(false);
  });
});
