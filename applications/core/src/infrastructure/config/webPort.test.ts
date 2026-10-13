import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { forcedWebPort } from './webPort';
import { ConfigLoader, configSchema } from './index';

// Port web forcé par DIMOTIC_WEB_PORT (instance de dev = 8088, conception-esphome-assembleur §6).

describe('forcedWebPort', () => {
  it('lit un port valide', () => {
    expect(forcedWebPort({ DIMOTIC_WEB_PORT: '8088' })).toBe(8088);
    expect(forcedWebPort({ DIMOTIC_WEB_PORT: ' 9000 ' })).toBe(9000);
  });
  it('ignore l\'absence et les valeurs invalides', () => {
    for (const v of [undefined, '', 'abc', '80.5', '0', '65536', '-1', '8088;1']) {
      expect(forcedWebPort({ DIMOTIC_WEB_PORT: v })).toBeNull();
    }
  });
});

describe('ConfigLoader et DIMOTIC_WEB_PORT', () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'webport-test-'));
    previous = process.env.DIMOTIC_WEB_PORT;
    const coreDir = path.join(root, 'data', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'machine_config.yaml'), yaml.dump({ web: { port: 8087, host: '0.0.0.0' } }));
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.DIMOTIC_WEB_PORT; else process.env.DIMOTIC_WEB_PORT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const load = () => new ConfigLoader(path.join(root, 'data', 'core', 'config.yaml'), configSchema, path.join(root, 'data')).load();

  it('sans variable : le port du fichier (8087)', () => {
    delete process.env.DIMOTIC_WEB_PORT;
    expect(load().web.port).toBe(8087);
  });
  it('avec la variable : 8088, quel que soit le fichier', () => {
    process.env.DIMOTIC_WEB_PORT = '8088';
    expect(load().web.port).toBe(8088);
    expect(yaml.load(fs.readFileSync(path.join(root, 'data', 'core', 'machine_config.yaml'), 'utf-8'))).toMatchObject({ web: { port: 8087 } });
  });
  it('variable invalide : ignorée', () => {
    process.env.DIMOTIC_WEB_PORT = 'oups';
    expect(load().web.port).toBe(8087);
  });
});
