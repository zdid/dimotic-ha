import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigLoader, ConfigWriter, configSchema } from './index';

const testDir = path.join(os.tmpdir(), 'ha-config-test');
const configPath = path.join(testDir, 'config.yaml');

// Config complète valide
const validConfig = {
  ha: {
    ws: { host: '192.168.1.100', port: 8123, token: 'test-token', reconnect_delay: 5 },
    structure: { include_unassigned: false, unassigned_label: 'Non assigné' },
  },
  web: { port: 8080, host: '0.0.0.0' },
  logging: { level: 'info', rotate: { max_size_mb: 10, max_files: 5 } },
};

// Config minimale (seulement host et token requis)
const minimalConfig = {
  ha: {
    ws: { host: 'localhost', token: 'my-token' },
  },
};

beforeEach(() => {
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch {}
});

describe('ConfigLoader', () => {
  it('should load valid config', () => {
    fs.writeFileSync(configPath, yaml.dump(validConfig));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(result.ha.ws.host).toBe('192.168.1.100');
    expect(result.web.port).toBe(8080);
  });

  it('should apply defaults for minimal config', () => {
    fs.writeFileSync(configPath, yaml.dump(minimalConfig));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(result.ha.ws.port).toBe(8123);
    expect(result.ha.ws.reconnect_delay).toBe(5);
    expect(result.ha.structure.include_unassigned).toBe(false);
    expect(result.web.port).toBe(8080);
    expect(result.logging.level).toBe('info');
  });

  it('should create the file with defaults and load it, rather than throwing, when missing', () => {
    // Comportement volontaire (voir loader.ts::createDefaultConfigFile) : un fichier absent n'est
    // pas fatal, contrairement à un YAML invalide/une validation échouée — nécessaire pour un
    // premier démarrage sur une machine neuve (ex: déploiement Docker, data/ vide) sans planter.
    expect(fs.existsSync(configPath)).toBe(false);
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(fs.existsSync(configPath)).toBe(true);
    expect(result.web.port).toBe(8080);
    expect(result.ha.ws_enable).toBe(false);
    expect(result.ha.mqtt_enable).toBe(false);
  });

  it('should throw on invalid YAML', () => {
    fs.writeFileSync(configPath, 'invalid: yaml: [');
    const loader = new ConfigLoader(configPath);
    expect(() => loader.load()).toThrow(/Invalid YAML/);
  });

  it('should throw on missing required field (host)', () => {
    const invalid = { ha: { ws: { token: 'token' } } };
    fs.writeFileSync(configPath, yaml.dump(invalid));
    const loader = new ConfigLoader(configPath);
    expect(() => loader.load()).toThrow();
  });
});

describe('ConfigWriter', () => {
  it('should save valid config', () => {
    const writer = new ConfigWriter(configPath);
    const result = writer.save(validConfig);
    expect(result.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('should reject invalid config', () => {
    const invalid = { ha: { ws: { host: 'localhost' } } }; // token manquant
    const writer = new ConfigWriter(configPath);
    const result = writer.save(invalid as any);
    expect(result.success).toBe(false);
  });

  it('should do atomic write', () => {
    const tmpPath = `${configPath}.tmp`;
    const writer = new ConfigWriter(configPath);
    writer.save(validConfig);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

describe('Config Schema', () => {
  it('should validate complete config', () => {
    const result = configSchema.parse(validConfig);
    expect(result.ha.ws.host).toBe('192.168.1.100');
  });

  it('should reject missing host', () => {
    const invalid = { ha: { ws: { token: 't', port: 8123, reconnect_delay: 5 }, structure: { include_unassigned: false, unassigned_label: '' } }, web: { port: 8080, host: '0.0.0.0' }, logging: { level: 'info', rotate: { max_size_mb: 10, max_files: 5 } } };
    expect(() => configSchema.parse(invalid)).toThrow();
  });
});
