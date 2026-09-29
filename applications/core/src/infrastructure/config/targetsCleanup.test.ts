import { describe, it, expect } from 'vitest';
import { cleanupTargets, type CleanableTarget } from './targetsCleanup';

const t = (id: string, host: string, origin: 'local' | 'gossip' = 'local', remoteDir = '/docker/dimotic-ha'): CleanableTarget =>
  ({ id, host, remoteDir, origin });

describe('cleanupTargets', () => {
  it('une machine = une ligne, préfixes d’origine retirés, la ligne locale l’emporte', () => {
    const { targets, changed, merged } = cleanupTargets([
      t('stfort', '192.168.1.53'),
      t('falbala::stfort', '192.168.1.53', 'gossip'),
      t('falbala_374035::stfort', '192.168.1.53', 'gossip'),
      t('falbala::orangepi', '192.168.1.130', 'gossip'),
      t('falbala_181206::orangepi', '192.168.1.130', 'gossip')
    ]);
    expect(targets).toEqual([t('stfort', '192.168.1.53'), t('orangepi', '192.168.1.130')]);
    expect(merged).toBe(3);
    expect(changed).toBe(true);
  });

  it('même adresse mais dossier différent : deux lignes distinctes, identifiant rendu unique', () => {
    const { targets } = cleanupTargets([
      t('ha2', '192.168.1.51', 'local', '/docker'),
      t('x::ha2', '192.168.1.51', 'gossip', '/docker/dimotic-ha')
    ]);
    expect(targets.map((x) => x.id)).toEqual(['ha2', 'ha2-2']);
  });

  it('complète un champ vide de la ligne gardée', () => {
    const { targets } = cleanupTargets([
      { ...t('z', '192.168.1.51'), mqttHost: '' } as CleanableTarget & { mqttHost: string },
      { ...t('s::z', '192.168.1.51', 'gossip'), mqttHost: '192.168.1.51' } as CleanableTarget & { mqttHost: string }
    ]);
    expect((targets[0] as CleanableTarget & { mqttHost: string }).mqttHost).toBe('192.168.1.51');
  });

  it('liste déjà propre : rien ne change', () => {
    const list = [t('ha2', '192.168.1.51'), t('stfort', '192.168.1.53')];
    expect(cleanupTargets(list).changed).toBe(false);
  });
});
