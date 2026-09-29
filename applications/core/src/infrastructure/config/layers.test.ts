import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { readLayered, writeLayered, migrateLayered, mergeLayers, CORE_DECLARATION } from './layers';
import { ConfigLoader, ConfigWriter, configSchema } from './index';

// Trois fichiers de configuration (techniques-diffusion-data_specs §8.1-§8.2, temps 1).

let root: string;
const read = (file: string): any => yaml.load(fs.readFileSync(file, 'utf-8'));
const write = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(data));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Configuration du core « à plat » telle qu'elle existe avant la migration (forme réelle de falbala). */
const OLD_CORE = {
  core: { machineId: 'falbala_817412', site: 'stfort', appGossipIntervalSeconds: 300 },
  ha: {
    ws_enable: true,
    mqtt_enable: true,
    ws: { host: '192.168.1.51', port: 8123, token: 'jeton-secret', reconnect_delay: 15 },
    mqtt: { host: '192.168.1.51', port: 1883, client_id: 'ha-app-local-test', username: '', password: 'mdp', keepalive: 60, reconnect_delay: 10 },
    structure: { include_unassigned: false, unassigned_label: 'Non assigné' }
  },
  web: { port: 8087, host: '0.0.0.0' },
  logging: { level: 'debug', rotate: { max_size_mb: 10, max_files: 5 } },
  disabledApps: ['rfxcom', 'tasmota'],
  knownApps: ['rfxcom', 'tasmota', 'outils'],
  targets: [{ id: 'ha2', host: '192.168.1.51', origin: 'local', remoteDir: '/docker/dimotic-ha' }],
  haStackTargets: [],
  zigbee2mqttTargets: [],
  externalSites: []
};

describe('mergeLayers', () => {
  it('fusionne les objets clé par clé et remplace valeurs simples et listes', () => {
    expect(mergeLayers({ a: { x: 1, y: 2 }, l: [1, 2] }, { a: { y: 3 }, l: [9] }, { b: true }))
      .toEqual({ a: { x: 1, y: 3 }, l: [9], b: true });
  });
});

describe('migrateLayered (core)', () => {
  it('sort les réglages machine et secrets de config.yaml, sauvegarde l’ancien, et la vue fusionnée est inchangée', () => {
    const dir = path.join(root, 'core');
    write(path.join(dir, 'config.yaml'), OLD_CORE);
    const history = path.join(root, 'hist');

    const moved = migrateLayered(dir, CORE_DECLARATION, history);

    expect(moved).toEqual(expect.arrayContaining(['ha.ws.token', 'ha.mqtt.password', 'core.machineId', 'core.site', 'web', 'logging', 'disabledApps', 'knownApps']));
    const common = read(path.join(dir, 'config.yaml'));
    const machine = read(path.join(dir, 'machine_config.yaml'));
    const secrets = read(path.join(dir, 'secrets_config.yaml'));
    expect(secrets).toEqual({ ha: { ws: { token: 'jeton-secret' }, mqtt: { password: 'mdp' } } });
    expect(machine.core).toEqual({ machineId: 'falbala_817412', site: 'stfort' });
    expect(machine.web).toEqual(OLD_CORE.web);
    expect(machine.disabledApps).toEqual(OLD_CORE.disabledApps);
    expect(common.core).toEqual({ appGossipIntervalSeconds: 300 });
    expect(common.ha.ws.token).toBeUndefined();
    expect(common.ha.mqtt.client_id).toBe('ha-app-local-test'); // commun (inutilisé par les connexions)
    expect(common.targets).toEqual(OLD_CORE.targets);
    expect(common.web).toBeUndefined();
    expect(fs.readdirSync(history)).toHaveLength(1);

    expect(readLayered(dir).merged).toEqual(OLD_CORE);
  });

  it('est idempotente (deuxième passage : rien ne bouge, pas de nouvelle sauvegarde)', () => {
    const dir = path.join(root, 'core');
    write(path.join(dir, 'config.yaml'), OLD_CORE);
    const history = path.join(root, 'hist');
    migrateLayered(dir, CORE_DECLARATION, history);
    expect(migrateLayered(dir, CORE_DECLARATION, history)).toEqual([]);
    expect(fs.readdirSync(history)).toHaveLength(1);
  });

  it('une valeur réécrite à plat dans config.yaml (outil ancien) l’emporte et repart dans son fichier', () => {
    const dir = path.join(root, 'core');
    write(path.join(dir, 'config.yaml'), OLD_CORE);
    migrateLayered(dir, CORE_DECLARATION);
    const common = read(path.join(dir, 'config.yaml'));
    common.ha.ws.token = 'nouveau-jeton';
    write(path.join(dir, 'config.yaml'), common);
    expect(migrateLayered(dir, CORE_DECLARATION)).toEqual(['ha.ws.token']);
    expect(read(path.join(dir, 'secrets_config.yaml')).ha.ws.token).toBe('nouveau-jeton');
    expect(read(path.join(dir, 'config.yaml')).ha.ws.token).toBeUndefined();
  });
});

describe('writeLayered', () => {
  it('réécrit chaque réglage là où il se trouve déjà, un réglage nouveau dans config.yaml', () => {
    const dir = path.join(root, 'app');
    write(path.join(dir, 'config.yaml'), { a: 1 });
    write(path.join(dir, 'machine_config.yaml'), { port: '/dev/ttyUSB0', deep: { x: 1 } });
    write(path.join(dir, 'secrets_config.yaml'), { box: { password: 'p' } });

    writeLayered(dir, { a: 2, port: '/dev/ttyUSB1', deep: { x: 1, y: 2 }, box: { password: 'q', user: 'u' }, nouveau: true });

    // Un réglage existant reste où il est ; un voisin NOUVEAU (deep.y, box.user) va dans config.yaml
    // faute de déclaration — un sous-objet partiellement machine/secret n'attire pas ses voisins.
    expect(read(path.join(dir, 'config.yaml'))).toEqual({ a: 2, deep: { y: 2 }, box: { user: 'u' }, nouveau: true });
    expect(read(path.join(dir, 'machine_config.yaml'))).toEqual({ port: '/dev/ttyUSB1', deep: { x: 1 } });
    expect(read(path.join(dir, 'secrets_config.yaml'))).toEqual({ box: { password: 'q' } });
    expect(readLayered(dir).merged).toEqual({ a: 2, port: '/dev/ttyUSB1', deep: { x: 1, y: 2 }, box: { password: 'q', user: 'u' }, nouveau: true });
  });

  it('range un réglage nouveau selon la déclaration (storage), sinon config.yaml', () => {
    const dir = path.join(root, 'app');
    writeLayered(dir, { wifi: { ssid: 'zdid2', password: 'x' }, port: 'p' }, { secrets: ['wifi.password'], machine: ['port'] });
    expect(read(path.join(dir, 'config.yaml'))).toEqual({ wifi: { ssid: 'zdid2' } });
    expect(read(path.join(dir, 'secrets_config.yaml'))).toEqual({ wifi: { password: 'x' } });
    expect(read(path.join(dir, 'machine_config.yaml'))).toEqual({ port: 'p' });
  });

  it('supprime un fichier machine/secrets devenu vide', () => {
    const dir = path.join(root, 'app');
    write(path.join(dir, 'config.yaml'), {});
    write(path.join(dir, 'machine_config.yaml'), { port: 'p' });
    writeLayered(dir, { a: 1 });
    expect(fs.existsSync(path.join(dir, 'machine_config.yaml'))).toBe(false);
  });
});

describe('ConfigLoader / ConfigWriter en trois fichiers', () => {
  it('migre, recharge la même configuration, renomme ssh/ et ha-structure-*, et le writer garde la répartition', () => {
    const dataRoot = path.join(root, 'data');
    const coreDir = path.join(dataRoot, 'core');
    const configPath = path.join(coreDir, 'config.yaml');
    write(configPath, OLD_CORE);
    write(path.join(coreDir, 'ssh', 'id_ed25519.pub'), 'cle');
    write(path.join(coreDir, 'ha-structure-debug.yaml'), {});
    write(path.join(dataRoot, 'tasmota', 'config.yaml'), { wifi: { ssid: 'zdid2' } });
    write(path.join(dataRoot, 'tasmota', 'secrets_config.yaml'), { wifi: { password: 'w' } });

    const loader = new ConfigLoader(configPath, configSchema, dataRoot);
    const report = loader.migrate();
    expect(report.join('\n')).toMatch(/ssh → core\/machine_ssh/);
    expect(fs.existsSync(path.join(coreDir, 'machine_ssh', 'id_ed25519.pub'))).toBe(true);
    expect(fs.existsSync(path.join(coreDir, 'machine_ha-structure-debug.yaml'))).toBe(true);

    const config = loader.load() as any;
    expect(config.core.machineId).toBe('falbala_817412');
    expect(config.ha.ws.token).toBe('jeton-secret');
    expect(config.disabledApps).toEqual(['rfxcom', 'tasmota']);
    expect(config.tasmota).toEqual({ wifi: { ssid: 'zdid2', password: 'w' } });

    const writer = new ConfigWriter(configPath, configSchema, '.tmp', dataRoot);
    expect(writer.save({ ...config, disabledApps: ['rfxcom'] }).success).toBe(true);
    expect(read(path.join(coreDir, 'machine_config.yaml')).disabledApps).toEqual(['rfxcom']);
    expect(read(configPath).disabledApps).toBeUndefined();
    expect(read(path.join(coreDir, 'secrets_config.yaml')).ha.ws.token).toBe('jeton-secret');

    expect(writer.saveModuleFile('tasmota', { wifi: { ssid: 'autre', password: 'w2' } }).success).toBe(true);
    expect(read(path.join(dataRoot, 'tasmota', 'config.yaml'))).toEqual({ wifi: { ssid: 'autre' } });
    expect(read(path.join(dataRoot, 'tasmota', 'secrets_config.yaml'))).toEqual({ wifi: { password: 'w2' } });
  });

  it('installation neuve : machineId écrit dans machine_config.yaml, jamais dans config.yaml', () => {
    const coreDir = path.join(root, 'data', 'core');
    const loader = new ConfigLoader(path.join(coreDir, 'config.yaml'), configSchema, path.join(root, 'data'));
    const config = loader.load();
    expect(loader.wasCreatedByThisProcess()).toBe(true);
    expect(read(path.join(coreDir, 'machine_config.yaml')).core.machineId).toBe(config.core.machineId);
    expect(read(path.join(coreDir, 'config.yaml')).core?.machineId).toBeUndefined();
    // Redémarrage : même identité.
    expect(new ConfigLoader(path.join(coreDir, 'config.yaml'), configSchema, path.join(root, 'data')).load().core.machineId)
      .toBe(config.core.machineId);
  });
});
