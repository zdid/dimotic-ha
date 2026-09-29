import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exclusionReason, appOf, canReceive, isNewer } from './rules';
import { DiffusionService, type DiffusionTransport } from './DiffusionService';

// Diffusion des fichiers de data/ (techniques-diffusion-data_specs v1.3).

describe('règles', () => {
  it('exclut machine_, secrets_, tmp, node_modules, dist des applications externes, .bak, .origine.yaml, > 1 Mo', () => {
    expect(exclusionReason('tasmota/rules.yaml', 100)).toBeNull();
    expect(exclusionReason('rfxcom/machine_config.yaml')).toMatch(/machine_/);
    expect(exclusionReason('tasmota/secrets_config.yaml')).toMatch(/secrets_/);
    expect(exclusionReason('outils/tmp/x.sh')).toMatch(/temporaire/);
    expect(exclusionReason('haplan/images/.lovelace-tmp/a.png')).toMatch(/temporaire/);
    expect(exclusionReason('applications/x/node_modules/a/b.js')).toMatch(/node_modules/);
    expect(exclusionReason('applications/x/dist/index.js')).toMatch(/dist/);
    expect(exclusionReason('applications/x/src/index.ts')).toBeNull();
    expect(exclusionReason('scriptsha/a.yaml.bak')).toMatch(/bak/);
    expect(exclusionReason('rfxcom/config-rfxcom-devices-v1.0.origine.yaml')).toMatch(/origine/);
    expect(exclusionReason('ia/regles.txt', 2 * 1024 * 1024)).toMatch(/1 Mo/);
    expect(exclusionReason('haplan/images/plan.png', 5 * 1024 * 1024)).toBeNull();
    expect(exclusionReason('config-rfxcom-defaults-v1.0.yaml')).toMatch(/hors dossier/);
  });

  it('isole en réception seule les applications actives, jamais en mode complet', () => {
    const active = new Set(['core', 'rfxcom']);
    expect(appOf('applications/monapp/src/a.ts')).toBe('monapp');
    expect(canReceive('rfxcom/config.yaml', 'reception', active)).toBe(false);
    expect(canReceive('tasmota/rules.yaml', 'reception', active)).toBe(true);
    expect(canReceive('rfxcom/config.yaml', 'complet', active)).toBe(true);
    expect(canReceive('tasmota/rules.yaml', 'arretee', active)).toBe(false);
  });

  it('le plus récent gagne, départage stable à date égale', () => {
    expect(isNewer({ mtime: 2, sha256: 'b', origin: 'a' }, { mtime: 1, sha256: 'a', origin: 'z' })).toBe(true);
    expect(isNewer({ mtime: 1, sha256: 'b', origin: 'a' }, { mtime: 2, sha256: 'a', origin: 'z' })).toBe(false);
    expect(isNewer({ mtime: 1, sha256: 'b', origin: 'z' }, { mtime: 1, sha256: 'a', origin: 'a' })).toBe(true);
    expect(isNewer({ mtime: 5, sha256: 'a', origin: 'z' }, { mtime: 1, sha256: 'a', origin: 'a' })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Trois machines reliées par un broker en mémoire
// -----------------------------------------------------------------------------

type Listener = (m: { topic: string; payload: string }) => void;

class MemoryBroker {
  private readonly clients: Array<{ listener?: Listener; onConnect?: () => void }> = [];
  transport(): DiffusionTransport {
    const client: { listener?: Listener; onConnect?: () => void } = {};
    this.clients.push(client);
    return {
      connect: () => setTimeout(() => client.onConnect?.(), 5),
      disconnect: () => undefined,
      subscribe: () => undefined,
      publish: (topic: string, payload: string | Buffer) => {
        for (const c of this.clients) setTimeout(() => c.listener?.({ topic, payload: payload.toString() }), 1);
      },
      onMessage: (cb: Listener) => { client.listener = cb; },
      onConnect: (cb: () => void) => { client.onConnect = cb; },
      onDisconnect: () => undefined
    } as unknown as DiffusionTransport;
  }
}

function fakeConfig(machineId: string, mode: 'arretee' | 'complet' | 'reception', active: string[] = []) {
  let m = mode;
  return {
    getConfig: () => ({ core: { machineId }, ha: { mqtt: { host: 'memoire', port: 1883 } } }),
    getDiffusionMode: () => m,
    setDiffusionMode: (x: typeof m) => { m = x; return { success: true }; },
    getKnownApps: () => active,
    getDisabledApps: () => [],
    reload: () => undefined
  } as never;
}

const events: Array<{ machine: string; name: string; data: unknown }> = [];
const fakeBus = (machine: string) => ({
  emit: (name: string, data: unknown) => events.push({ machine, name, data }),
  emitGeneric: (name: string, data: unknown) => { if (name !== 'diffusion:status') events.push({ machine, name, data }); }
}) as never;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = { settle: 100, inventoryWindow: 300, sendSpacing: 5 };

let root: string;
const services: DiffusionService[] = [];
const dataOf = (m: string) => path.join(root, m, 'data');
const put = (m: string, rel: string, content: string, mtime?: number) => {
  const f = path.join(dataOf(m), rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
};
const read = (m: string, rel: string) => { try { return fs.readFileSync(path.join(dataOf(m), rel), 'utf8'); } catch { return undefined; } };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-test-'));
  events.length = 0;
});
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function machine(broker: MemoryBroker, id: string, mode: 'arretee' | 'complet' | 'reception', active: string[] = []) {
  fs.mkdirSync(dataOf(id), { recursive: true });
  const s = new DiffusionService(fakeConfig(id, mode, active), fakeBus(id), quietLogger, dataOf(id), () => broker.transport(), T);
  services.push(s);
  return s;
}

describe('DiffusionService — trois machines', () => {
  it('synchronise au démarrage (le plus récent gagne), respecte machine_ / secrets_ et le mode réception', async () => {
    const broker = new MemoryBroker();
    const t0 = Date.now() - 3600_000;
    put('ha2', 'tasmota/rules.yaml', 'regles ha2', t0 + 2000);          // le plus récent
    put('stfort', 'tasmota/rules.yaml', 'regles stfort', t0 + 1000);
    put('stfort', 'planificateur/macros.yaml', 'macros stfort', t0);  // présent seulement sur stfort
    put('ha2', 'rfxcom/machine_config.yaml', 'port ha2', t0);          // jamais reproduit
    put('ha2', 'tasmota/secrets_config.yaml', 'mdp', t0);              // jamais reproduit
    put('falbala', 'rfxcom/config.yaml', 'rfxcom en test sur falbala', t0 - 5000); // actif ici → isolé
    put('ha2', 'rfxcom/config.yaml', 'rfxcom production', t0 + 5000);
    put('falbala', 'tasmota/rules.yaml', 'essai falbala', t0 - 9000);

    const ha2 = machine(broker, 'ha2', 'complet');
    const stfort = machine(broker, 'stfort', 'complet');
    const falbala = machine(broker, 'falbala', 'reception', ['rfxcom']);
    for (const s of [ha2, stfort, falbala]) s.start();
    await wait(1500);

    expect(read('stfort', 'tasmota/rules.yaml')).toBe('regles ha2');
    expect(read('ha2', 'planificateur/macros.yaml')).toBe('macros stfort');
    expect(read('falbala', 'tasmota/rules.yaml')).toBe('regles ha2');          // reçu en réception
    expect(read('falbala', 'planificateur/macros.yaml')).toBe('macros stfort');
    expect(read('falbala', 'rfxcom/config.yaml')).toBe('rfxcom en test sur falbala'); // isolé
    expect(read('stfort', 'rfxcom/machine_config.yaml')).toBeUndefined();
    expect(read('stfort', 'tasmota/secrets_config.yaml')).toBeUndefined();
    // Version remplacée gardée dans l'historique local.
    const hist = path.join(dataOf('stfort'), 'core', 'machine_diffusion', 'historique', 'tasmota');
    expect(fs.readdirSync(hist).some((f) => f.startsWith('rules.yaml.'))).toBe(true);
    // Date d'origine conservée.
    expect(Math.round(fs.statSync(path.join(dataOf('stfort'), 'tasmota/rules.yaml')).mtimeMs)).toBe(t0 + 2000);
    // Applications prévenues.
    expect(events.some((e) => e.machine === 'stfort' && e.name === 'core:data:file:changed' && (e.data as { path: string }).path === 'tasmota/rules.yaml')).toBe(true);
  });

  it('modification et suppression envoyées en direct ; la machine en réception ne renvoie rien ; config.yaml → rechargement', async () => {
    const broker = new MemoryBroker();
    const ha2 = machine(broker, 'ha2', 'complet');
    const stfort = machine(broker, 'stfort', 'complet');
    const falbala = machine(broker, 'falbala', 'reception');
    for (const s of [ha2, stfort, falbala]) s.start();
    await wait(500);

    put('ha2', 'scriptsha/scripts.yaml', 'v1');
    put('ha2', 'tasmota/config.yaml', 'sites: [maison]');
    await wait(600);
    expect(read('stfort', 'scriptsha/scripts.yaml')).toBe('v1');
    expect(read('falbala', 'scriptsha/scripts.yaml')).toBe('v1');
    expect(events.some((e) => e.machine === 'stfort' && e.name === 'app:module:config:saved' && (e.data as { moduleId: string }).moduleId === 'tasmota')).toBe(true);

    put('falbala', 'scriptsha/scripts.yaml', 'essai sur falbala');
    await wait(600);
    expect(read('ha2', 'scriptsha/scripts.yaml')).toBe('v1'); // rien ne sort de falbala

    fs.unlinkSync(path.join(dataOf('ha2'), 'scriptsha/scripts.yaml'));
    await wait(600);
    expect(read('stfort', 'scriptsha/scripts.yaml')).toBeUndefined();
    // Une machine en retard ne fait pas « revivre » le fichier supprimé.
    stfort.resync();
    await wait(600);
    expect(read('ha2', 'scriptsha/scripts.yaml')).toBeUndefined();
  });

  it('une machine de production qui démarre APRÈS la machine en réception lui envoie quand même ses fichiers', async () => {
    const broker = new MemoryBroker();
    put('ha2', 'teleinfo/compteurs.yaml', 'compteurs ha2');
    const falbala = machine(broker, 'falbala', 'reception');
    falbala.start();
    await wait(500); // falbala a déjà fait sa demande, personne n'a répondu
    const ha2 = machine(broker, 'ha2', 'complet');
    ha2.start();
    await wait(1200);
    expect(read('falbala', 'teleinfo/compteurs.yaml')).toBe('compteurs ha2');
  });

  it('mode arrêté : rien ne part, rien n’arrive', async () => {
    const broker = new MemoryBroker();
    put('ha2', 'tasmota/rules.yaml', 'regles ha2');
    put('isolee', 'tasmota/rules.yaml', 'regles isolee', Date.now() - 100000);
    const ha2 = machine(broker, 'ha2', 'complet');
    const isolee = machine(broker, 'isolee', 'arretee');
    for (const s of [ha2, isolee]) s.start();
    await wait(800);
    expect(read('isolee', 'tasmota/rules.yaml')).toBe('regles isolee');
  });
});
