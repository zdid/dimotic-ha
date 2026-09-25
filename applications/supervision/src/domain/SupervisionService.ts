/**
 * SupervisionService (fonctionnelles-supervision_specs v1.2) — toute la logique de la supervision,
 * dans le process de l'application (rien dans le core, décision utilisateur) :
 * - inventaire des machines du site : `dimotic/core/+/known-apps` (gossip retenu des cores, machine
 *   locale comprise) — §3 ;
 * - présence : LWT de la connexion gossip de chaque core, `app/+/status` filtré sur
 *   `dimotic-core-appgossip-<machineId>` ; annonce « périmée » au-delà de N périodes — §3bis ;
 * - sélection diffusée : retenue sur `dimotic/supervision/selection`, la plus récente l'emporte,
 *   copie locale data/supervision/selection.yaml — §4 ;
 * - sauvegardes : demandées à l'application sauvegarde (requête corrélée) — §5.
 * Tout passe par la connexion MQTT du socle (bridge `main`, passthrough).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { computeBridgeInstance } from '../../../core/dist/exports';
import {
  supervisionConfigSchema,
  selectionSchema,
  selectionMachinesSchema,
  type Selection,
  type SupervisionConfig
} from './config-schema';
import { evaluateBackup, type BackupMachineReport, type BackupView } from './BackupEvaluation';
import { SUPERVISION_SOCKET_EVENTS, SUPERVISION_CLIENT_EVENTS } from './socket-events';

const MODULE_NAME = 'supervision';
const KNOWN_APPS_TOPIC = 'dimotic/core/+/known-apps';
const LWT_TOPIC = 'app/+/status';
const SELECTION_TOPIC = 'dimotic/supervision/selection';
const KNOWN_APPS_RE = /^dimotic\/core\/([^/]+)\/known-apps$/;
const LWT_RE = /^app\/dimotic-core-appgossip-(.+)\/status$/;
/** Laisse arriver la sélection retenue du broker avant de décider s'il faut publier la copie locale. */
const SELECTION_SETTLE_MS = 3000;

interface AnnouncedApp {
  id: string;
  name: string;
  icon: string;
  state?: string;
}

interface Announcement {
  address?: string;
  webPort?: number;
  runningInDocker?: boolean;
  apps?: AnnouncedApp[];
  publishedAt?: string;
}

export interface MachineView {
  machineId: string;
  label?: string;
  local: boolean;
  selected: boolean;
  inGossip: boolean;
  address?: string;
  webPort?: number;
  runningInDocker?: boolean;
  presence: 'online' | 'lost' | 'unknown';
  publishedAt?: string;
  /** null : annonce sans heure (core pas encore mis à jour) — pas de contrôle de péremption. */
  stale: boolean | null;
  apps: Array<AnnouncedApp & { selected: boolean; announced: boolean }>;
  backup?: BackupView | { level: 'unconfigured'; reason: string };
}

export interface SupervisionState {
  localMachineId: string;
  staleAfterSeconds: number;
  selection: Selection | null;
  machines: MachineView[];
  backups: { fetchedAt?: string; pending: boolean; error?: string };
}

export interface ISupervisionService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class SupervisionService implements ISupervisionService {
  private config: SupervisionConfig;
  private readonly bridgeInstance: string;
  private readonly selectionPath: string;
  private readonly announcements = new Map<string, Announcement>();
  private readonly presence = new Map<string, 'online' | 'offline'>();
  private selection: Selection | null;
  private brokerSelectionSeen = false;
  private backupReports: BackupMachineReport[] | null = null;
  private backups: SupervisionState['backups'] = { pending: false };
  private pendingBackupRequest: { id: string; timer: NodeJS.Timeout } | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<SupervisionConfig>,
    private readonly localMachineId: string,
    private readonly gossipIntervalSeconds: number
  ) {
    this.config = this.loadConfig();
    this.bridgeInstance = computeBridgeInstance(MODULE_NAME, process.env.DIMOTIC_MACHINE_ID);
    this.selectionPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', MODULE_NAME, 'selection.yaml');
    this.selection = this.loadLocalSelection();
  }

  private loadConfig(): SupervisionConfig {
    return supervisionConfigSchema.parse(this.configProvider.getAppConfig() ?? {});
  }

  private loadLocalSelection(): Selection | null {
    try {
      if (fs.existsSync(this.selectionPath)) {
        return selectionSchema.parse(yaml.load(fs.readFileSync(this.selectionPath, 'utf8')));
      }
    } catch (error) {
      this.logger.warn('SupervisionService', `selection.yaml illisible, ignoré : ${error}`);
    }
    return null;
  }

  private saveLocalSelection(selection: Selection): void {
    try {
      fs.mkdirSync(path.dirname(this.selectionPath), { recursive: true });
      const tmp = `${this.selectionPath}.tmp`;
      fs.writeFileSync(tmp, yaml.dump(selection));
      fs.renameSync(tmp, this.selectionPath);
    } catch (error) {
      this.logger.error('SupervisionService', `Écriture de selection.yaml impossible : ${error}`);
    }
  }

  async start(): Promise<void> {
    this.logger.info('SupervisionService', `Démarrage (machine ${this.localMachineId})`);
    this.setupListeners();
    this.eventBus.emitGeneric('integration:bridge:register', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
    // Recalcul périodique des états qui dépendent de l'heure (annonce périmée).
    this.tickTimer = setInterval(() => this.scheduleEmit(), 60_000);
    this.restartBackupTimer();
    setTimeout(() => this.requestBackups(), 10_000);
    this.scheduleEmit();
  }

  async stop(): Promise<void> {
    for (const t of [this.emitTimer, this.settleTimer, this.pendingBackupRequest?.timer]) if (t) clearTimeout(t);
    for (const t of [this.tickTimer, this.backupTimer]) if (t) clearInterval(t);
    this.eventBus.emitGeneric('integration:bridge:unregister', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
  }

  private restartBackupTimer(): void {
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.backupTimer = setInterval(() => this.requestBackups(), this.config.backupRefreshMinutes * 60_000);
  }

  private setupListeners(): void {
    this.eventBus.onGeneric<{ bridgeInstance: string; connected: boolean }>(`integration:${MODULE_NAME}:bridge:connection`, (data) => {
      if (data.bridgeInstance !== this.bridgeInstance) return;
      this.logger.info('SupervisionService', `Connexion MQTT du socle ${data.connected ? 'établie' : 'perdue'}`);
      if (!data.connected) return;
      for (const topic of [KNOWN_APPS_TOPIC, LWT_TOPIC, SELECTION_TOPIC]) {
        this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:subscribe`, { bridgeInstance: this.bridgeInstance, topic, qos: 1 });
      }
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.publishLocalSelectionIfNewer(), SELECTION_SETTLE_MS);
    });

    this.eventBus.onGeneric<{ bridgeInstance: string; topic: string; payload: string }>(`integration:${MODULE_NAME}:passthrough:message`, (data) => {
      if (data.bridgeInstance !== this.bridgeInstance) return;
      this.handleMessage(data.topic, data.payload ?? '');
    });

    this.eventBus.onGeneric<{ correlation_id: string; success: boolean; error?: string; machines?: BackupMachineReport[] }>(
      'sauvegarde:supervision:status:reply', (reply) => this.handleBackupReply(reply));

    this.eventBus.onGeneric(SUPERVISION_CLIENT_EVENTS.GET_STATE, () => this.emitState());
    this.eventBus.onGeneric<{ machines: unknown }>(SUPERVISION_CLIENT_EVENTS.SET_SELECTION, (data) => this.setSelection(data?.machines));
    this.eventBus.onGeneric(SUPERVISION_CLIENT_EVENTS.REFRESH_BACKUPS, () => this.requestBackups());

    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.configProvider.reload();
      this.config = this.loadConfig();
      this.restartBackupTimer();
      this.scheduleEmit();
    });
  }

  // ==========================================================================
  // Réception MQTT
  // ==========================================================================

  private handleMessage(topic: string, payload: string): void {
    let m = KNOWN_APPS_RE.exec(topic);
    if (m) {
      if (payload.trim() === '') {
        this.announcements.delete(m[1]);
      } else {
        try {
          this.announcements.set(m[1], JSON.parse(payload) as Announcement);
        } catch {
          this.logger.warn('SupervisionService', `Annonce illisible ignorée sur ${topic}`);
          return;
        }
      }
      this.scheduleEmit();
      return;
    }
    m = LWT_RE.exec(topic);
    if (m) {
      const value = payload.trim();
      if (value === 'online' || value === 'offline') {
        this.presence.set(m[1], value);
        this.scheduleEmit();
      }
      return;
    }
    if (topic === SELECTION_TOPIC) {
      this.brokerSelectionSeen = true;
      if (payload.trim() === '') return;
      try {
        this.adoptSelection(selectionSchema.parse(JSON.parse(payload)), false);
      } catch (error) {
        this.logger.warn('SupervisionService', `Sélection diffusée invalide ignorée : ${error}`);
      }
    }
  }

  // ==========================================================================
  // Sélection diffusée (§4)
  // ==========================================================================

  private isNewer(candidate: Selection, current: Selection | null): boolean {
    return !current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt);
  }

  /** Adopte une sélection si elle est plus récente ; `publish` : la diffuser (modification locale). */
  private adoptSelection(selection: Selection, publish: boolean): void {
    if (!this.isNewer(selection, this.selection)) {
      // Broker plus ancien que la copie locale (machine restée hors ligne pendant une modification
      // faite ailleurs, puis broker réinitialisé…) : la copie locale est rediffusée.
      if (!publish && this.selection && Date.parse(selection.updatedAt) < Date.parse(this.selection.updatedAt)) {
        this.publishSelection(this.selection);
      }
      return;
    }
    this.selection = selection;
    this.saveLocalSelection(selection);
    this.logger.info('SupervisionService', `Sélection adoptée (${selection.updatedAt}, depuis ${selection.updatedBy || '?'})`);
    if (publish) this.publishSelection(selection);
    this.scheduleEmit();
  }

  private publishSelection(selection: Selection): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:publish`, {
      bridgeInstance: this.bridgeInstance, topic: SELECTION_TOPIC, payload: selection, qos: 1, retain: true
    });
  }

  private publishLocalSelectionIfNewer(): void {
    if (this.selection && !this.brokerSelectionSeen) {
      this.logger.info('SupervisionService', 'Aucune sélection retenue sur le broker : diffusion de la copie locale');
      this.publishSelection(this.selection);
    }
  }

  private setSelection(machines: unknown): void {
    const parsed = selectionMachinesSchema.safeParse(machines);
    if (!parsed.success) {
      this.logger.warn('SupervisionService', `Sélection refusée : ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      this.scheduleEmit();
      return;
    }
    // Horodatage strictement croissant même si l'horloge de cette machine retarde sur la dernière.
    let now = Date.now();
    if (this.selection) now = Math.max(now, Date.parse(this.selection.updatedAt) + 1);
    this.adoptSelection({ updatedAt: new Date(now).toISOString(), updatedBy: this.localMachineId, machines: parsed.data }, true);
  }

  // ==========================================================================
  // Sauvegardes (§5)
  // ==========================================================================

  private requestBackups(): void {
    if (this.pendingBackupRequest) return;
    const localApps = this.announcements.get(this.localMachineId)?.apps;
    if (localApps && !localApps.some((a) => a.id === 'sauvegarde')) {
      this.backups = { fetchedAt: new Date().toISOString(), pending: false, error: "application sauvegarde non active sur cette machine" };
      this.backupReports = null;
      this.scheduleEmit();
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (this.pendingBackupRequest?.id !== id) return;
      this.pendingBackupRequest = null;
      this.backups = { ...this.backups, pending: false, error: `pas de réponse de l'application sauvegarde en ${this.config.backupTimeoutSec} s` };
      this.scheduleEmit();
    }, this.config.backupTimeoutSec * 1000);
    this.pendingBackupRequest = { id, timer };
    this.backups = { ...this.backups, pending: true };
    this.eventBus.emitGeneric('sauvegarde:supervision:status', { correlation_id: id });
    this.scheduleEmit();
  }

  private handleBackupReply(reply: { correlation_id: string; success: boolean; error?: string; machines?: BackupMachineReport[] }): void {
    if (!this.pendingBackupRequest || reply.correlation_id !== this.pendingBackupRequest.id) return;
    clearTimeout(this.pendingBackupRequest.timer);
    this.pendingBackupRequest = null;
    if (reply.success) {
      this.backupReports = reply.machines ?? [];
      this.backups = { fetchedAt: new Date().toISOString(), pending: false };
    } else {
      this.backups = { ...this.backups, pending: false, error: reply.error || 'erreur inconnue' };
    }
    this.scheduleEmit();
  }

  /** Correspondance par adresse IP (§5) — jamais par nom : un même nom peut désigner deux machines
   *  successives (ex: ha2 remplacé le 24/09/2026). */
  private backupFor(address: string | undefined): MachineView['backup'] {
    if (!this.backupReports) return undefined;
    if (!address) return { level: 'unconfigured', reason: "adresse de la machine inconnue (aucune annonce)" };
    const report = this.backupReports.find((r) => r.host === address);
    return report ? evaluateBackup(report) : { level: 'unconfigured', reason: `aucune machine ${address} dans Sauvegarde` };
  }

  // ==========================================================================
  // Vue
  // ==========================================================================

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitState();
    }, 300);
  }

  getState(): SupervisionState {
    const staleAfterSeconds = this.config.staleAfterPeriods * this.gossipIntervalSeconds;
    const selected = this.selection?.machines ?? {};
    // Machines vues seulement par leur LWT (core sans annonce retenue — version ancienne) : listées
    // aussi, « absentes du gossip », pour ne pas les ignorer.
    const ids = new Set([...this.announcements.keys(), ...this.presence.keys(), ...Object.keys(selected)]);
    const now = Date.now();

    const machines: MachineView[] = [...ids].map((machineId) => {
      const a = this.announcements.get(machineId);
      const sel = selected[machineId];
      const announced = a?.apps ?? [];
      const selectedApps = new Set(sel?.apps ?? []);
      const apps = [
        ...announced.map((app) => ({ ...app, selected: selectedApps.has(app.id), announced: true })),
        ...[...selectedApps].filter((id) => !announced.some((app) => app.id === id))
          .map((id) => ({ id, name: id, icon: '❔', selected: true, announced: false }))
      ];
      const lwt = this.presence.get(machineId);
      const publishedMs = a?.publishedAt ? Date.parse(a.publishedAt) : NaN;
      return {
        machineId,
        label: sel?.label,
        local: machineId === this.localMachineId,
        selected: Boolean(sel),
        inGossip: Boolean(a),
        address: a?.address,
        webPort: a?.webPort,
        runningInDocker: a?.runningInDocker,
        presence: lwt === 'online' ? 'online' : lwt === 'offline' ? 'lost' : 'unknown',
        publishedAt: a?.publishedAt,
        stale: Number.isNaN(publishedMs) ? null : now - publishedMs > staleAfterSeconds * 1000,
        apps,
        backup: sel ? this.backupFor(a?.address) : undefined
      };
    });
    machines.sort((x, y) => Number(y.selected) - Number(x.selected) || x.machineId.localeCompare(y.machineId));

    return { localMachineId: this.localMachineId, staleAfterSeconds, selection: this.selection, machines, backups: this.backups };
  }

  private emitState(): void {
    this.eventBus.emitGeneric(SUPERVISION_SOCKET_EVENTS.STATE, this.getState());
  }
}
