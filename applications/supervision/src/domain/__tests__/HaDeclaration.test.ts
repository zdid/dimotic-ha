import { describe, it, expect } from 'vitest';
import { estCoeurDeDev, machineRetrait, machineDiscovery, hubDiscovery, latestVersion, lwtTopic, knownAppsTopic, HUB_LATEST_TOPIC } from '../HaDeclaration';

describe('HaDeclaration', () => {
  it('une machine = 3 entités : en ligne (LWT), version installée, mise à jour', () => {
    const msgs = machineDiscovery('ha2_811876');
    expect(msgs.map((m) => m.topic)).toEqual([
      'homeassistant/binary_sensor/dimotic_ha2_811876/online/config',
      'homeassistant/sensor/dimotic_ha2_811876/version/config',
      'homeassistant/update/dimotic_ha2_811876/maj/config'
    ]);
    const [online, version, maj] = msgs.map((m) => m.payload);
    expect(online).toMatchObject({ state_topic: lwtTopic('ha2_811876'), payload_on: 'online', payload_off: 'offline', device_class: 'connectivity' });
    expect(version).toMatchObject({ state_topic: knownAppsTopic('ha2_811876') });
    expect(String(version.value_template)).toContain('dimoticVersion');
    expect(maj).toMatchObject({ state_topic: knownAppsTopic('ha2_811876'), latest_version_topic: HUB_LATEST_TOPIC });
    // un seul appareil HA par machine
    expect(new Set(msgs.map((m) => JSON.stringify((m.payload.device as { identifiers: string[] }).identifiers))).size).toBe(1);
  });

  it('identifiant sûr même avec un nom de machine inattendu', () => {
    expect(machineDiscovery('Falbala 817/412')[0].topic).toBe('homeassistant/binary_sensor/dimotic_falbala_817_412/online/config');
  });

  it('Docker Hub : appareil séparé avec la dernière version', () => {
    const [m] = hubDiscovery('zdid2/dimotic-ha');
    expect(m.payload).toMatchObject({ state_topic: HUB_LATEST_TOPIC, unique_id: 'dimotic_hub_latest' });
  });

  it('latestVersion : plus haute X.Y.Z, ignore latest et les suffixes', () => {
    expect(latestVersion(['latest', '3.9.5', '3.10.0', '3.9.12', '4.0.0-rc1', '3.7.0'])).toBe('3.10.0');
    expect(latestVersion(['latest', 'dev'])).toBeNull();
    expect(latestVersion([])).toBeNull();
  });

  it('cœur de dev : exclu, et retrait des entités par payload vide', () => {
    expect(estCoeurDeDev('dev')).toBe(true);
    expect(estCoeurDeDev('3.9.6')).toBe(false);
    expect(estCoeurDeDev(undefined)).toBe(false);
    const retrait = machineRetrait('falbala_817412');
    expect(retrait).toHaveLength(3);
    expect(retrait.every((m) => m.payload === '' && m.topic.startsWith('homeassistant/'))).toBe(true);
  });
});
