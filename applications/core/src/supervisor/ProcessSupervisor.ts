// applications/core/src/supervisor/ProcessSupervisor.ts
//
// Démarre/arrête/redémarre les applications marquées `runsAsSeparateProcess` comme des process OS
// indépendants (child_process.spawn), avec backoff exponentiel en cas de crash — conforme à
// fonctionnelles-supervisor_specs_v2.6 §5.3/§8.4. Phase 1 : un seul enfant possible (espdisplay),
// conçu pour en superviser plusieurs sans changement structurel.
//
// Distinct de `applications/core/scripts/supervisor.js` (qui supervise le process `core` entier
// lui-même, un cran au-dessus) — celui-ci supervise des enfants DE core, un par application migrée.

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../infrastructure/logger/index';
import { MqttTransport, type MqttTransportConfig } from '../infrastructure/transport/MqttTransport';
import type { SupervisorEventBridge } from './SupervisorEventBridge';

export type ManagedAppState = 'stopped' | 'starting' | 'running' | 'crashed';

/** Délai avant chaque nouvelle tentative après un crash : 1s, 2s, 4s, 8s, 16s, puis plafonné à 30s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
/** Au-delà de cette durée de fonctionnement stable, un crash ultérieur repart avec un compteur neuf. */
const STABLE_THRESHOLD_MS = 60000;
/** Au-delà de ce nombre de tentatives rapprochées (sans franchir STABLE_THRESHOLD_MS), abandon. */
const MAX_RAPID_ATTEMPTS = 5;

interface ManagedApp {
  appId: string;
  /** Répertoire de l'application (ex: applications/espdisplay) — pour résoudre dist/src. */
  appDir: string;
  child: ChildProcess | null;
  state: ManagedAppState;
  attempts: number;
  backoffTimer: NodeJS.Timeout | null;
  /** true entre l'appel à stop()/restart() et la sortie effective du process — distingue un arrêt
   *  volontaire d'un crash, pour ne jamais appliquer de backoff à un arrêt demandé. */
  stopRequested: boolean;
  /** Callback one-shot posé par restart() pour relancer une fois l'ancien process bien sorti. */
  onStoppedForRestart: (() => void) | null;
}

export interface LifecycleCommandBrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export class ProcessSupervisor {
  private readonly apps: Map<string, ManagedApp> = new Map();
  private commandTransport: MqttTransport | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly coreDir: string,
    /** Pont EventBus local ↔ IPC (16/08/2026) — attaché/détaché à chaque (re)spawn/sortie
     *  d'enfant, voir spawnChild()/handleExit(). Optionnel pour ne pas casser un usage minimal
     *  (tests) sans pont réel. */
    private readonly eventBridge?: SupervisorEventBridge
  ) {
    // ⭐ Filet de sécurité, en plus de l'arrêt propre (AppService.stopAllSeparateProcesses(), appelé
    // par ApplicationBootstrap.stop() sur SIGTERM/SIGINT) — si ce process core se termine par un
    // autre chemin (SIGKILL externe, tsx watch selon sa configuration, crash non intercepté),
    // 'exit' reste le seul hook fiable pour éviter des enfants orphelins. Synchrone uniquement
    // (Node n'autorise aucune opération async dans un handler 'exit') : un simple SIGTERM, pas
    // d'attente de sortie propre — acceptable, chaque enfant a son propre gestionnaire de SIGTERM.
    process.on('exit', () => {
      for (const app of this.apps.values()) {
        app.child?.kill('SIGTERM');
      }
    });
  }

  /** Déclare une application comme devant tourner en process séparé — ne la démarre pas encore. */
  register(appId: string, appDir: string): void {
    if (this.apps.has(appId)) return;
    this.apps.set(appId, {
      appId,
      appDir,
      child: null,
      state: 'stopped',
      attempts: 0,
      backoffTimer: null,
      stopRequested: false,
      onStoppedForRestart: null
    });
  }

  isRegistered(appId: string): boolean {
    return this.apps.has(appId);
  }

  getState(appId: string): ManagedAppState | undefined {
    return this.apps.get(appId)?.state;
  }

  start(appId: string): void {
    const app = this.apps.get(appId);
    if (!app) {
      this.logger.warn('ProcessSupervisor', `start() : application non enregistrée: ${appId}`);
      return;
    }
    if (app.child) {
      this.logger.debug('ProcessSupervisor', `${appId} déjà démarré (pid ${app.child.pid})`);
      return;
    }
    app.attempts = 0;
    this.spawnChild(app);
  }

  stop(appId: string): void {
    const app = this.apps.get(appId);
    if (!app || !app.child) return;
    this.clearBackoff(app);
    app.stopRequested = true;
    app.child.kill('SIGTERM');
  }

  restart(appId: string): void {
    const app = this.apps.get(appId);
    if (!app) return;
    if (!app.child) {
      this.start(appId);
      return;
    }
    this.clearBackoff(app);
    app.stopRequested = true;
    app.onStoppedForRestart = () => {
      app.attempts = 0;
      this.spawnChild(app);
    };
    app.child.kill('SIGTERM');
  }

  /**
   * Écoute les commandes start/stop/restart via MQTT (fonctionnelles-supervisor_specs v2.6 §7,
   * demande utilisateur explicite — pas seulement pilotable localement depuis l'UI). Une seule
   * connexion, un seul abonnement wildcard sur `appId` couvre toutes les applications déjà
   * enregistrées via register(). ⚠️ Aucune signature/authentification sur ce canal pour cette
   * phase (décision utilisateur : l'authentification viendra du broker mosquitto lui-même, sujet
   * traité séparément plus tard) — à réévaluer avant un déploiement multi-machines réel.
   */
  attachMqttCommandListener(machineId: string, broker: LifecycleCommandBrokerConfig): void {
    if (this.commandTransport) return;

    const config: MqttTransportConfig = {
      host: broker.host,
      port: broker.port,
      clientId: `core-supervisor-commands-${machineId}`,
      username: broker.username ?? '',
      password: broker.password ?? '',
      keepalive: 60,
      reconnectDelay: 5
    };
    this.commandTransport = new MqttTransport(config, this.logger);
    this.commandTransport.onMessage((message) => this.handleCommandMessage(machineId, message.topic, message.payload));
    this.commandTransport.subscribe(`dimotic/supervisor/${machineId}/app/+/command/lifecycle`, 1);
    this.commandTransport.connect();
  }

  private handleCommandMessage(machineId: string, topic: string, payload: Buffer | string): void {
    const match = topic.match(new RegExp(`^dimotic/supervisor/${machineId}/app/([^/]+)/command/lifecycle$`));
    if (!match) return;
    const appId = match[1] as string;
    if (!this.apps.has(appId)) return;

    let action: string;
    try {
      const parsed = JSON.parse(Buffer.isBuffer(payload) ? payload.toString() : payload) as { action?: string };
      action = parsed.action ?? '';
    } catch {
      this.logger.warn('ProcessSupervisor', `Commande lifecycle invalide reçue pour ${appId} (JSON attendu, {action})`);
      return;
    }

    this.logger.info('ProcessSupervisor', `Commande MQTT reçue pour ${appId}: ${action}`);
    switch (action) {
      case 'start': this.start(appId); break;
      case 'stop': this.stop(appId); break;
      case 'restart': this.restart(appId); break;
      default: this.logger.warn('ProcessSupervisor', `Action lifecycle inconnue pour ${appId}: "${action}"`);
    }
  }

  private clearBackoff(app: ManagedApp): void {
    if (app.backoffTimer) {
      clearTimeout(app.backoffTimer);
      app.backoffTimer = null;
    }
  }

  /** dist/standalone.js (prod, node nu) en priorité, sinon src/standalone.ts sous tsx (dev) — même
   *  ordre de priorité que AppService.detectApplicationModules() pour domain/index. */
  private resolveEntryPoint(app: ManagedApp): { command: string; args: string[] } | null {
    const distEntry = path.join(app.appDir, 'dist', 'standalone.js');
    const srcEntry = path.join(app.appDir, 'src', 'standalone.ts');

    if (fs.existsSync(distEntry)) {
      return { command: process.execPath, args: [distEntry] };
    }
    if (fs.existsSync(srcEntry)) {
      const tsxBin = path.join(this.coreDir, 'node_modules', '.bin', 'tsx');
      return { command: tsxBin, args: [srcEntry] };
    }
    this.logger.error('ProcessSupervisor', `${app.appId} : ni dist/standalone.js ni src/standalone.ts trouvé dans ${app.appDir}`);
    return null;
  }

  private spawnChild(app: ManagedApp): void {
    const entry = this.resolveEntryPoint(app);
    if (!entry) {
      app.state = 'crashed';
      return;
    }

    app.state = 'starting';
    const startedAt = Date.now();
    // 4e canal 'ipc' (16/08/2026) : stdin/stdout/stderr toujours hérités (logs visibles dans ceux
    // de core), plus un tuyau IPC dédié — voir SupervisorEventBridge, qui remplace MQTT pour la
    // communication EventBus avec cet enfant.
    const child = spawn(entry.command, entry.args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      cwd: app.appDir
    });
    app.child = child;
    this.eventBridge?.attachChild(app.appId, child);

    child.on('spawn', () => {
      app.state = 'running';
      this.logger.info('ProcessSupervisor', `${app.appId} démarré (pid ${child.pid})`);
    });

    child.on('exit', (code, signal) => this.handleExit(app, code, signal, startedAt));
    child.on('error', (error) => {
      this.logger.error('ProcessSupervisor', `${app.appId} : échec du lancement (${error.message})`);
    });
  }

  private handleExit(app: ManagedApp, code: number | null, signal: NodeJS.Signals | null, startedAt: number): void {
    app.child = null;
    this.eventBridge?.detachChild(app.appId);
    const ranMs = Date.now() - startedAt;

    if (app.stopRequested) {
      app.stopRequested = false;
      app.state = 'stopped';
      this.logger.info('ProcessSupervisor', `${app.appId} arrêté (code=${code}, signal=${signal})`);
      const onRestart = app.onStoppedForRestart;
      app.onStoppedForRestart = null;
      if (onRestart) onRestart();
      return;
    }

    // Crash — pas une sortie demandée.
    if (ranMs >= STABLE_THRESHOLD_MS) {
      app.attempts = 0; // fonctionnement stable avant le crash : pas d'historique d'échecs à hériter
    }
    app.attempts++;

    if (app.attempts > MAX_RAPID_ATTEMPTS) {
      app.state = 'crashed';
      this.logger.error(
        'ProcessSupervisor',
        `${app.appId} : abandon après ${app.attempts - 1} tentatives rapprochées (code=${code}, signal=${signal}) — état "crashed", réactivation manuelle requise`
      );
      return;
    }

    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (app.attempts - 1), BACKOFF_MAX_MS);
    this.logger.warn(
      'ProcessSupervisor',
      `${app.appId} : crash (code=${code}, signal=${signal}, actif ${Math.round(ranMs / 1000)}s) — tentative ${app.attempts}/${MAX_RAPID_ATTEMPTS} dans ${delay}ms`
    );
    app.backoffTimer = setTimeout(() => {
      app.backoffTimer = null;
      this.spawnChild(app);
    }, delay);
  }
}
