import { describe, it, expect } from 'vitest';
import { DeviceAreaAssigner } from '../DeviceAreaAssigner';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function fausse(appareils: unknown[], pieces: unknown[]) {
  const appels: Array<Record<string, unknown>> = [];
  return {
    appels,
    ha: {
      callWs: async (m: Record<string, unknown>) => {
        appels.push(m);
        if (m.type === 'config/device_registry/list') return appareils;
        if (m.type === 'config/area_registry/list') return pieces;
        return {};
      }
    }
  };
}

const PIECES = [{ area_id: 'infra', name: 'Infra' }, { area_id: 'a_identifier', name: 'A-identifier' }];
const SPA = { id: 'dev1', name: 'SPA', area_id: 'a_identifier', identifiers: [['mqtt', 'teleinfo_20828398450']] };

describe('DeviceAreaAssigner', () => {
  it('corrige la pièce d\'un appareil déjà créé ailleurs', async () => {
    const f = fausse([SPA], PIECES);
    const a = new DeviceAreaAssigner(f.ha as never, logger, () => 0, -1);
    a.request(['teleinfo_20828398450'], 'Infra');
    await a.traiter();
    expect(f.appels.at(-1)).toEqual({ type: 'config/device_registry/update', device_id: 'dev1', area_id: 'infra' });
  });

  it('ne fait rien si l\'appareil est déjà dans la bonne pièce, ou si la pièce attendue n\'existe pas', async () => {
    const f = fausse([{ ...SPA, area_id: 'infra' }], PIECES);
    const a = new DeviceAreaAssigner(f.ha as never, logger, () => 0, -1);
    a.request(['teleinfo_20828398450'], 'Infra');
    await a.traiter();
    expect(f.appels.some((x) => x.type === 'config/device_registry/update')).toBe(false);
    const g = fausse([SPA], PIECES);
    const b = new DeviceAreaAssigner(g.ha as never, logger, () => 0, -1);
    b.request(['teleinfo_20828398450'], 'Cave');
    await b.traiter();
    expect(g.appels.some((x) => x.type === 'config/device_registry/update')).toBe(false);
  });

  it('appareil inconnu de HA : aucune écriture (retentée plus tard)', async () => {
    const f = fausse([], PIECES);
    const a = new DeviceAreaAssigner(f.ha as never, logger, () => 0, -1);
    a.request(['x'], 'Infra');
    await a.traiter();
    expect(f.appels.some((x) => x.type === 'config/device_registry/update')).toBe(false);
  });

  it('demande identique non revérifiée avant 10 minutes', async () => {
    let t = 0;
    const f = fausse([{ ...SPA, area_id: 'infra' }], PIECES);
    const a = new DeviceAreaAssigner(f.ha as never, logger, () => t, -1);
    a.request(['teleinfo_20828398450'], 'Infra');
    await a.traiter();
    expect(f.appels).toHaveLength(2);
    f.appels.length = 0;
    a.request(['teleinfo_20828398450'], 'Infra'); // trop tôt
    await a.traiter();
    expect(f.appels).toHaveLength(0);
    t = 11 * 60 * 1000;
    a.request(['teleinfo_20828398450'], 'Infra'); // assez tard
    await a.traiter();
    expect(f.appels).toHaveLength(2);
  });

  it('plusieurs appareils d\'un même lot : un seul chargement des registres ; la pièce est trouvée sans tenir compte de la casse', async () => {
    const f = fausse([SPA, { id: 'dev2', name: 'PAC', area_id: null, identifiers: [['mqtt', 'teleinfo_30222651434']] }], PIECES);
    const a = new DeviceAreaAssigner(f.ha as never, logger, () => 0, -1);
    a.request(['teleinfo_20828398450'], 'infra');
    a.request(['teleinfo_30222651434'], 'INFRA');
    await a.traiter();
    expect(f.appels.filter((x) => x.type === 'config/device_registry/list')).toHaveLength(1);
    expect(f.appels.filter((x) => x.type === 'config/device_registry/update')).toHaveLength(2);
  });
});
