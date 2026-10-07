/**
 * Screen2HttpService — console web d'une session `screen` distante.
 *
 * Porté depuis le dépôt autonome zdid/screen2http : une connexion SSH (ssh2) par session ouverte
 * depuis le navigateur, un pseudo-terminal exécutant `screen -xS <nom>`, les octets du terminal
 * relayés en Socket.io. Les paramètres (cibles, délais) vivent dans Paramètres Techniques ; la page
 * de l'application ne fait qu'afficher le terminal (xterm.js).
 *
 * Écart volontaire avec l'original : la commande est exécutée directement (`exec` + pty) plutôt que
 * tapée dans un shell — quand screen se détache, la session se termine proprement au lieu de laisser
 * un shell nu ouvert.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { ensureGlobalSshKey } from '../../../core/dist/exports';
import { screen2httpConfigSchema, type Screen2HttpConfig, type Screen2HttpTargetConfig } from './config-schema';
import {
  SCREEN2HTTP_SOCKET_EVENTS,
  SCREEN2HTTP_CLIENT_EVENTS,
  type Screen2HttpSessionState
} from './socket-events';

export interface IScreen2HttpService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_INPUT_BYTES = 64 * 1024;
const MIN_DIM = 1;
const MAX_DIM = 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface Session {
  id: string;
  ssh: Client;
  channel: ClientChannel | null;
  lastPing: number;
  closing: boolean;
  cols: number;
  rows: number;
}

function validDim(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= MIN_DIM && (n as number) <= MAX_DIM;
}

export class Screen2HttpService implements IScreen2HttpService {
  private config: Screen2HttpConfig;
  private readonly sessions = new Map<string, Session>();
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<Screen2HttpConfig>
  ) {
    this.config = screen2httpConfigSchema.parse(configProvider.getAppConfig());
    this.setupEventListeners();
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<Screen2HttpConfig>
  ): Screen2HttpService {
    return new Screen2HttpService(eventBus, logger, configProvider);
  }

  private setupEventListeners(): void {
    const C = SCREEN2HTTP_CLIENT_EVENTS;
    this.eventBus.on(C.GET_STATUS, () => this.emitStatus());
    this.eventBus.on(C.SESSION_OPEN, (data: unknown) => this.handleOpen(data as OpenRequest));
    this.eventBus.on(C.INPUT, (data: unknown) => this.handleInput(data as InputRequest));
    this.eventBus.on(C.RESIZE, (data: unknown) => this.handleResize(data as ResizeRequest));
    this.eventBus.on(C.SESSION_CLOSE, (data: unknown) => this.handleClose(data as { sessionId?: string }));
    this.eventBus.on(C.PING, (data: unknown) => this.handlePing(data as { sessionId?: string }));

    // ⚠️ `configProvider.reload()` AVANT `getAppConfig()` (process séparé, instance ConfigService
    // propre — voir guide-nouvelle-application_specs §3.2). Les sessions déjà ouvertes gardent leur
    // connexion ; la nouvelle config vaut pour les suivantes.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== 'screen2http' || !event.success) return;
      this.configProvider.reload();
      this.config = screen2httpConfigSchema.parse(this.configProvider.getAppConfig());
      this.emitStatus();
    });
  }

  async start(): Promise<void> {
    this.logger.info('Screen2HttpService', 'Démarrage du service screen2http...');
    try {
      ensureGlobalSshKey();
    } catch (error) {
      // Sans ssh-keygen la clé unique ne peut être créée ; les cibles ayant leur propre clé restent utilisables.
      this.logger.warn('Screen2HttpService', `Clé SSH de l'installation indisponible : ${error instanceof Error ? error.message : error}`);
    }
    this.watchdog = setInterval(() => this.closeStaleSessions(), 5000);
    this.emitStatus();
    this.logger.info('Screen2HttpService', 'Service screen2http démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('Screen2HttpService', 'Arrêt du service screen2http');
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const session of [...this.sessions.values()]) this.endSession(session);
  }

  // ==========================================================================
  // Sessions
  // ==========================================================================

  private handleOpen(req: OpenRequest): void {
    const sessionId = req?.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      this.emitError('Identifiant de session invalide.');
      return;
    }
    if (this.sessions.has(sessionId)) {
      this.emitState(sessionId, 'error', 'Session déjà ouverte.');
      return;
    }
    const target = this.config.targets.find((t) => t.id === req.targetId);
    if (!target) {
      this.emitState(sessionId, 'error', `Cible inconnue : ${req.targetId}`);
      return;
    }
    if (!target.host) {
      this.emitState(sessionId, 'error', `Aucun hôte configuré pour la cible « ${target.label || target.id} ».`);
      return;
    }

    const cols = validDim(req.cols) ? req.cols : 120;
    const rows = validDim(req.rows) ? req.rows : 40;

    let sshConfig: ConnectConfig;
    try {
      sshConfig = this.buildConnectConfig(target);
    } catch (error) {
      this.emitState(sessionId, 'error', `Impossible de lire la clé SSH : ${error instanceof Error ? error.message : error}`);
      return;
    }

    const ssh = new Client();
    const session: Session = { id: sessionId, ssh, channel: null, lastPing: Date.now(), closing: false, cols, rows };
    this.sessions.set(sessionId, session);
    this.emitState(sessionId, 'connecting', `Connexion à ${target.username}@${target.host}...`);

    ssh.on('ready', () => {
      ssh.exec(
        this.screenCommand(target),
        { pty: { term: 'xterm-256color', cols: session.cols, rows: session.rows } },
        (err, channel) => {
          if (err) {
            this.finishSession(session, 'error', `Impossible d'ouvrir le terminal : ${err.message}`);
            return;
          }
          session.channel = channel;
          this.emitState(sessionId, 'connected');
          const forward = (chunk: Buffer): void => {
            this.eventBus.emit(SCREEN2HTTP_SOCKET_EVENTS.OUTPUT, { sessionId, data: chunk.toString('utf8') });
          };
          channel.on('data', forward);
          channel.stderr.on('data', forward);
          channel.on('close', () => this.finishSession(session, 'closed', 'Session terminée'));
        }
      );
    });
    ssh.on('error', (err) => this.finishSession(session, 'error', `Erreur SSH : ${err.message}`));
    ssh.on('close', () => this.finishSession(session, 'closed', 'Connexion SSH fermée'));

    try {
      ssh.connect(sshConfig);
    } catch (error) {
      this.finishSession(session, 'error', `Erreur SSH : ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildConnectConfig(target: Screen2HttpTargetConfig): ConnectConfig {
    const keyPath = target.privateKeyPath ? path.resolve(target.privateKeyPath) : ensureGlobalSshKey();
    return {
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: fs.readFileSync(keyPath, 'utf8'),
      keepaliveInterval: this.config.keepaliveInterval,
      readyTimeout: this.config.readyTimeout
    };
  }

  /** Nom filtré (même jeu de caractères que l'original) — jamais interpolé tel quel dans la commande. */
  private screenCommand(target: Screen2HttpTargetConfig): string {
    const name = target.screenName.replace(/[^a-zA-Z0-9_.:-]/g, '');
    return name ? `screen -xS ${name}` : 'screen -x';
  }

  private handleInput(req: InputRequest): void {
    const session = this.sessionOf(req);
    if (!session?.channel || typeof req.data !== 'string') return;
    if (Buffer.byteLength(req.data, 'utf8') > MAX_INPUT_BYTES) return;
    session.lastPing = Date.now();
    session.channel.write(req.data);
  }

  private handleResize(req: ResizeRequest): void {
    const session = this.sessionOf(req);
    if (!session || !validDim(req.cols) || !validDim(req.rows)) return;
    session.cols = req.cols;
    session.rows = req.rows;
    session.channel?.setWindow(req.rows, req.cols, 0, 0);
  }

  private handlePing(req: { sessionId?: string }): void {
    const session = this.sessionOf(req);
    if (session) session.lastPing = Date.now();
  }

  private handleClose(req: { sessionId?: string }): void {
    const session = this.sessionOf(req);
    if (session) this.endSession(session);
  }

  private sessionOf(req: { sessionId?: string } | undefined): Session | undefined {
    return typeof req?.sessionId === 'string' ? this.sessions.get(req.sessionId) : undefined;
  }

  private closeStaleSessions(): void {
    const limit = this.config.sessionTimeoutSeconds * 1000;
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastPing > limit) {
        this.logger.info('Screen2HttpService', `Session ${session.id} sans battement de cœur — fermée`);
        this.endSession(session);
      }
    }
  }

  /** Fermeture à l'initiative du service/navigateur : libère SSH, sans état supplémentaire à émettre. */
  private endSession(session: Session): void {
    session.closing = true;
    this.sessions.delete(session.id);
    try {
      session.channel?.end();
      session.ssh.end();
    } catch {
      // déjà fermée
    }
  }

  /** Fin constatée (distant, erreur) : une seule notification par session, même si plusieurs événements arrivent. */
  private finishSession(session: Session, state: Screen2HttpSessionState, message: string): void {
    if (session.closing) return;
    this.endSession(session);
    this.emitState(session.id, state, message);
  }

  // ==========================================================================
  // Émissions
  // ==========================================================================

  private emitStatus(): void {
    this.eventBus.emit(SCREEN2HTTP_SOCKET_EVENTS.STATUS, {
      targets: this.config.targets.map((t) => ({
        id: t.id,
        label: t.label || t.id,
        host: t.host,
        screenName: t.screenName
      }))
    });
  }

  private emitState(sessionId: string, state: Screen2HttpSessionState, message?: string): void {
    this.eventBus.emit(SCREEN2HTTP_SOCKET_EVENTS.SESSION_STATE, { sessionId, state, message });
  }

  private emitError(message: string): void {
    this.logger.error('Screen2HttpService', message);
    this.eventBus.emit(SCREEN2HTTP_SOCKET_EVENTS.ERROR, { message });
  }
}

interface OpenRequest { sessionId?: string; targetId?: string; cols?: number; rows?: number }
interface InputRequest { sessionId?: string; data?: string }
interface ResizeRequest { sessionId?: string; cols?: number; rows?: number }
