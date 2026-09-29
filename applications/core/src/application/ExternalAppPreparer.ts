/**
 * ExternalAppPreparer (⭐ 29/09/2026, techniques-diffusion-data_specs §8bis / D8) — une application
 * déposée (ou reçue par la diffusion) dans data/applications/<app>/ n'a que ses SOURCES : le core
 * installe ses dépendances (`npm install`) et la compile sur la machine, avant de l'activer.
 * Compilation = `tsc -p tsconfig.json` (le SEUL projet de l'application, contre core/dist) puis son
 * script `build:ui` s'il existe — jamais son script `build` (`tsc -b`), qui suivrait la référence
 * `../core` et recompilerait le core : impossible dans l'image Docker (sources .ts et outils de
 * développement du core retirés) et faux via le lien data/applications/core (le `extends` relatif du
 * tsconfig du core y tombe sur data/tsconfig.json — constaté le 29/09/2026). Une préparation à la fois (file d'attente) ; état consultable pour la page Gestion des
 * applications.
 *
 * Repères : `node_modules/.dimotic-install` (dernière installation) et `dist/.dimotic-build`
 * (dernière compilation) — comparés aux dates de package.json / package-lock.json et de src/.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../infrastructure/logger/index';

const INSTALL_MARKER = path.join('node_modules', '.dimotic-install');
const BUILD_MARKER = path.join('dist', '.dimotic-build');
const STEP_TIMEOUT_MS = 20 * 60 * 1000; // Raspberry Pi : une installation peut être longue
const OUTPUT_TAIL = 4000;

export interface PreparationState {
  state: 'prête' | 'en cours' | 'échec';
  step?: 'installation des dépendances' | 'compilation';
  error?: string;
  output?: string;
  at: string;
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Date de modification la plus récente sous un dossier (0 s'il n'existe pas). */
function newestUnder(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, mtime(full));
    }
  };
  walk(dir);
  return newest;
}

export class ExternalAppPreparer {
  private readonly states = new Map<string, PreparationState>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(private readonly logger: Logger) {}

  needsInstall(dir: string): boolean {
    const marker = mtime(path.join(dir, INSTALL_MARKER));
    if (!marker || !fs.existsSync(path.join(dir, 'node_modules'))) return true;
    return Math.max(mtime(path.join(dir, 'package.json')), mtime(path.join(dir, 'package-lock.json'))) > marker;
  }

  needsBuild(dir: string): boolean {
    if (!fs.existsSync(path.join(dir, 'dist', 'domain', 'index.js'))) return true;
    const marker = mtime(path.join(dir, BUILD_MARKER)) || mtime(path.join(dir, 'dist', 'domain', 'index.js'));
    return newestUnder(path.join(dir, 'src')) > marker;
  }

  needsPreparation(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'package.json')) && (this.needsInstall(dir) || this.needsBuild(dir));
  }

  getState(appId: string): PreparationState | undefined {
    return this.states.get(appId);
  }

  isRunning(appId: string): boolean {
    return this.pending.has(appId);
  }

  /** Prépare l'application (installation et/ou compilation selon le besoin, ou tout si `force`). */
  prepare(appId: string, dir: string, force = false): Promise<boolean> {
    const running = this.pending.get(appId);
    if (running) return running;
    const job = this.queue.then(() => this.run(appId, dir, force)).finally(() => this.pending.delete(appId));
    this.queue = job.catch(() => undefined);
    this.pending.set(appId, job);
    this.states.set(appId, { state: 'en cours', at: new Date().toISOString() });
    return job;
  }

  private async run(appId: string, dir: string, force: boolean): Promise<boolean> {
    type Step = { label: NonNullable<PreparationState['step']>; command: string; args: string[]; marker?: string };
    const steps: Step[] = [];
    if (force || this.needsInstall(dir)) steps.push({ label: 'installation des dépendances', command: 'npm', args: ['install', '--no-audit', '--no-fund'], marker: INSTALL_MARKER });
    if (force || this.needsBuild(dir) || steps.length) {
      steps.push({ label: 'compilation', command: 'npx', args: ['--no-install', 'tsc', '-p', 'tsconfig.json'], marker: BUILD_MARKER });
      if (this.hasScript(dir, 'build:ui')) steps.push({ label: 'compilation', command: 'npm', args: ['run', 'build:ui'] });
    }
    for (const step of steps) {
      this.states.set(appId, { state: 'en cours', step: step.label, at: new Date().toISOString() });
      this.logger.info('ExternalAppPreparer', `${appId} : ${step.label} (${step.command} ${step.args.join(' ')}) dans ${dir}`);
      const result = await this.exec(dir, step.command, step.args);
      if (!result.ok) {
        this.states.set(appId, { state: 'échec', step: step.label, error: result.error, output: result.output, at: new Date().toISOString() });
        this.logger.error('ExternalAppPreparer', `${appId} : échec de l'étape « ${step.label} » — ${result.error}`);
        return false;
      }
      if (step.marker) {
        try {
          fs.mkdirSync(path.dirname(path.join(dir, step.marker)), { recursive: true });
          fs.writeFileSync(path.join(dir, step.marker), new Date().toISOString());
        } catch { /* repère facultatif */ }
      }
    }
    this.states.set(appId, { state: 'prête', at: new Date().toISOString() });
    this.logger.info('ExternalAppPreparer', `${appId} : prête (${[...new Set(steps.map((s) => s.label))].join(' + ') || 'rien à faire'})`);
    return true;
  }

  private hasScript(dir: string, name: string): boolean {
    try {
      return !!JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.scripts?.[name];
    } catch {
      return false;
    }
  }

  private exec(dir: string, command: string, args: string[]): Promise<{ ok: boolean; error?: string; output: string }> {
    return new Promise((resolve) => {
      execFile(command, args, { cwd: dir, timeout: STEP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'development' } },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`.slice(-OUTPUT_TAIL);
          resolve(error ? { ok: false, error: error.message.split('\n')[0], output } : { ok: true, output });
        });
    });
  }
}
