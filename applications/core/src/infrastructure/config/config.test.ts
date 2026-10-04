import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigLoader, ConfigWriter, ConfigService, configSchema } from './index';

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
  // ⭐ 29/09/2026 — fichiers voisins de la configuration en trois fichiers (layers.ts).
  for (const f of ['machine_config.yaml', 'secrets_config.yaml']) {
    try { fs.rmSync(path.join(testDir, f), { force: true }); } catch {}
  }
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
    expect(result.web.port).toBe(8087);
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
    expect(result.web.port).toBe(8087);
    expect(result.ha.ws_enable).toBe(false);
    expect(result.ha.mqtt_enable).toBe(false);
  });

  it('should throw on invalid YAML', () => {
    fs.writeFileSync(configPath, 'invalid: yaml: [');
    const loader = new ConfigLoader(configPath);
    expect(() => loader.load()).toThrow(/Invalid YAML/);
  });

  it('should boot (tolerant start) when ha.ws has a token but no host: ws disabled, values kept, issue reported', () => {
    // ⭐ 01/10/2026 — avant : plantage du core entier (« ha.ws.host: Host is required ») ; maintenant : démarrage,
    // connexion WS désactivée, valeurs gardées pour correction dans l'IHM (voyant rouge).
    const invalid = { ha: { ws_enable: true, ws: { token: 'token' } } };
    fs.writeFileSync(configPath, yaml.dump(invalid));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(result.ha.ws_enable).toBe(false);
    expect((result.ha.ws as any).token).toBe('token');
    const issues = loader.getLoadIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].section).toBe('ha.ws');
    expect(issues[0].messages.join(' ')).toMatch(/Host is required/);
  });

  it('should treat a null field (hand-edited YAML, e.g. "token:" left blank) as unset, not as a type error', () => {
    // Un YAML `token:` sans valeur est parsé en `null` (pas ""), ex: config.yaml pré-rempli à la
    // main avant le premier démarrage. deepMerge doit retomber sur le défaut ('') plutôt que de
    // laisser passer `null` jusqu'à Zod (qui rejetterait avec "Expected string, received null" au
    // lieu du message "required" habituel) — voir loader.ts::deepMerge.
    const withNullToken = { ha: { ws_enable: true, ws: { host: '192.168.1.50', token: null } } };
    fs.writeFileSync(configPath, yaml.dump(withNullToken));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();                              // démarrage tolérant (01/10/2026) : plus d'exception
    expect(result.ha.ws_enable).toBe(false);
    expect(loader.getLoadIssues()[0].messages.join(' ')).toMatch(/Long-Lived Access Token is required/);
  });

  it('should boot when ha.mqtt is invalid: mqtt disabled, ws untouched, issue reported', () => {
    const cfg = {
      ha: { ws_enable: true, mqtt_enable: true, ws: { host: 'localhost', token: 'ok' }, mqtt: { host: '', client_id: 'x' } },
    };
    fs.writeFileSync(configPath, yaml.dump(cfg));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(result.ha.mqtt_enable).toBe(false);
    expect(result.ha.ws_enable).toBe(true);
    expect(loader.getLoadIssues().map((i) => i.section)).toEqual(['ha.mqtt']);
  });

  it('should report no issue for a valid configuration', () => {
    fs.writeFileSync(configPath, yaml.dump(validConfig));
    const loader = new ConfigLoader(configPath);
    loader.load();
    expect(loader.getLoadIssues()).toEqual([]);
  });

  it('should still throw when the error is outside ha.ws / ha.mqtt (e.g. an invalid web port), even alongside a HA problem', () => {
    const cfg = { ha: { ws_enable: true, ws: { token: 'token' } }, web: { port: 99999, host: '0.0.0.0' } };
    fs.writeFileSync(configPath, yaml.dump(cfg));
    const loader = new ConfigLoader(configPath);
    expect(() => loader.load()).toThrow(/web\.port/);
  });

  it('should treat an entirely-null, disabled ws section as unconfigured and boot successfully', () => {
    const allNull = { ha: { ws_enable: false, ws: { host: null, token: null } } };
    fs.writeFileSync(configPath, yaml.dump(allNull));
    const loader = new ConfigLoader(configPath);
    const result = loader.load();
    expect(result.ha.ws_enable).toBe(false);
    expect(result.ha.ws).toBeUndefined();
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

describe('ConfigService — démarrage tolérant (01/10/2026)', () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
  const brokenWs = { ha: { ws_enable: true, mqtt_enable: false, ws: { host: '192.168.1.201', port: 8123, reconnect_delay: 15 } } };

  it('keeps writing the rest of the config while ha.ws is invalid, and does not turn ws_enable off in the file', () => {
    fs.writeFileSync(configPath, yaml.dump(brokenWs));
    const service = new ConfigService(new ConfigLoader(configPath), new ConfigWriter(configPath), logger);
    expect(service.getConfig().ha.ws_enable).toBe(false);          // désactivée en mémoire seulement
    expect(service.getLoadIssues()).toHaveLength(1);

    const result = service.setAppLists(['rfxcom'], ['rfxcom', 'arexx']);
    expect(result.success).toBe(true);                             // avant : « Validation failed: ha.ws.token »

    const onDisk = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    expect(onDisk.ha.ws_enable).toBe(true);                        // l'intention de l'utilisateur est conservée
    expect(onDisk.ha.ws.host).toBe('192.168.1.201');
  });

  it('validates ha strictly when the UI saves it: an invalid ws is still refused', () => {
    fs.writeFileSync(configPath, yaml.dump(brokenWs));
    const service = new ConfigService(new ConfigLoader(configPath), new ConfigWriter(configPath), logger);
    const result = service.saveConfig({ ha: { ...service.getConfig().ha, ws_enable: true } } as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Long-Lived Access Token is required/);
  });

  it('accepts the correction made from the UI, then loads without any issue', () => {
    fs.writeFileSync(configPath, yaml.dump(brokenWs));
    const service = new ConfigService(new ConfigLoader(configPath), new ConfigWriter(configPath), logger);
    const fixedHa = { ...service.getConfig().ha, ws_enable: true, ws: { host: '192.168.1.201', port: 8123, token: 'nouveau-jeton', reconnect_delay: 15 } };
    expect(service.saveConfig({ ...service.getConfig(), ha: fixedHa } as any).success).toBe(true);
    service.reload();
    expect(service.getLoadIssues()).toEqual([]);
    expect(service.getConfig().ha.ws_enable).toBe(true);
  });
});
