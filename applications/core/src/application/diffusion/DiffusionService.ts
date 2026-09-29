/**
 * DiffusionService (techniques-diffusion-data_specs v1.3, temps 3) — reproduit les fichiers de
 * data/ entre les machines dimotic-ha, par MQTT SANS message retenu :
 *   - envoi d'un fichier à sa modification (surveillance de data/, regroupée sur 2 s) ;
 *   - au démarrage, à chaque reconnexion et sur « Resynchroniser » : demande des inventaires,
 *     puis demande des fichiers plus récents ailleurs, envoi de ceux plus récents ici ;
 *   - le plus récent gagne, version remplacée gardée dans l'historique local (5 par fichier) ;
 *   - suppressions notées 30 jours (data/core/machine_diffusion/suppressions.yaml).
 * Mode PROPRE À LA MACHINE (§2bis) : arretee (défaut) / complet / reception (applications actives
 * isolées). Règles pures dans rules.ts.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { MqttTransport } from '../../infrastructure/transport/MqttTransport';
import type { ConfigService } from '../../infrastructure/config/ConfigService';
import type { IEventBus } from '../IEventBus';
import type { Logger } from '../../infrastructure/logger/index';
import {
  exclusionReason,
  isExcludedDir,
  appOf,
  canSend,
  canReceive,
  isIsolated,
  isNewer,
  type DiffusionMode,
  type Version
} from './rules';

const TOPIC = 'dimotic/data';
const SETTLE_MS = 2000;           // regroupement des modifications (§5)
const INVENTORY_WINDOW_MS = 10000; // attente des inventaires (§5)
const SEND_SPACING_MS = 200;       // espacement des envois (§5)
const HISTORY_KEEP = 5;            // versions gardées par fichier (§7)
const DELETION_KEEP_MS = 30 * 24 * 3600 * 1000; // suppressions notées 30 jours (§7)
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;      // horloges (§6)

interface LocalEntry {
  mtime: number;
  sha256: string;
  size: number;
}

interface FileMessage extends Version {
  path: string;
  size?: number;
  content?: string;
}

interface InventoryMessage {
  from: string;
  files: Array<Version & { path: string; size?: number }>;
}

export interface DiffusionFileView {
  path: string;
  app: string;
  size?: number;
  mtime?: number;
  state: 'reproduit' | 'isolé' | 'exclu' | 'supprimé';
  reason?: string;
  last?: { event: 'envoyé' | 'reçu' | 'remplacé ici'; machine: string; at: string };
}

export interface DiffusionStatus {
  machineId: string;
  mode: DiffusionMode;
  connected: boolean;
  lastSync?: string;
  peers: Record<string, string>; // machineId → dernier inventaire reçu
  files: DiffusionFileView[];
}

/** Sous-ensemble de MqttTransport utilisé ici. */
export type DiffusionTransport = Pick<MqttTransport, 'connect' | 'disconnect' | 'publish' | 'subscribe' | 'onMessage' | 'onConnect' | 'onDisconnect'>;

export class DiffusionService {
  private transport?: DiffusionTransport;
  private readonly machineId: string;
  private readonly dataRoot: string;
  private readonly stateDir: string;
  private readonly index = new Map<string, LocalEntry>();
  private deletions = new Map<string, { at: number; origin: string }>();
  private readonly lastEvents = new Map<string, NonNullable<DiffusionFileView['last']>>();
  private readonly peers = new Map<string, string>();
  private watcher?: fs.FSWatcher;
  private pendingChanges = new Set<string>();
  private settleTimer?: ReturnType<typeof setTimeout>;
  private inventoryTimer?: ReturnType<typeof setTimeout>;
  private peerJoinTimer?: ReturnType<typeof setTimeout>;
  private inventories: InventoryMessage[] = [];
  private connected = false;
  private lastSync?: string;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configService: ConfigService,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    dataRoot: string,
    /** Fabrique de la connexion MQTT — remplaçable par les tests (broker en mémoire). */
    private readonly transportFactory: (config: ConstructorParameters<typeof MqttTransport>[0]) => DiffusionTransport =
      (config) => new MqttTransport(config, logger),
    /** Délais (ms) — raccourcis par les tests. */
    private readonly timings: { settle: number; inventoryWindow: number; sendSpacing: number } =
      { settle: SETTLE_MS, inventoryWindow: INVENTORY_WINDOW_MS, sendSpacing: SEND_SPACING_MS }
  ) {
    this.machineId = configService.getConfig().core.machineId;
    this.dataRoot = dataRoot;
    this.stateDir = path.join(dataRoot, 'core', 'machine_diffusion');
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  private get mode(): DiffusionMode {
    return this.configService.getDiffusionMode();
  }

  start(): void {
    this.loadDeletions();
    this.scan();
    this.startWatcher();
    const mqtt = this.configService.getConfig().ha?.mqtt;
    if (!mqtt?.host) {
      this.logger.info('Diffusion', 'ha.mqtt non configuré — diffusion des données inactive');
      return;
    }
    this.transport = this.transportFactory({
      host: mqtt.host,
      port: mqtt.port,
      clientId: `dimotic-core-diffusion-${this.machineId}`,
      username: mqtt.username || '',
      password: mqtt.password || '',
      keepalive: mqtt.keepalive || 60,
      reconnectDelay: mqtt.reconnect_delay || 10,
      protocolVersion: 5
    });
    this.transport.onMessage((m) => {
      try {
        this.handleMessage(m.topic, typeof m.payload === 'string' ? m.payload : m.payload.toString('utf8'));
      } catch (error) {
        this.logger.error('Diffusion', `Message ${m.topic} : ${error}`);
      }
    });
    this.transport.onConnect(() => {
      this.connected = true;
      this.requestInventories('connexion MQTT');
      this.emitStatus();
    });
    this.transport.onDisconnect(() => {
      this.connected = false;
      this.emitStatus();
    });
    this.transport.connect();
    this.transport.subscribe(`${TOPIC}/#`, 1);
    this.logger.info('Diffusion', `Diffusion des données : mode « ${this.mode} » (machine ${this.machineId})`);
  }

  stop(): void {
    for (const t of [this.settleTimer, this.inventoryTimer, this.peerJoinTimer]) if (t) clearTimeout(t);
    this.watcher?.close();
    this.transport?.disconnect();
  }

  setMode(mode: DiffusionMode): { success: boolean; error?: string } {
    const result = this.configService.setDiffusionMode(mode);
    if (result.success) {
      this.logger.info('Diffusion', `Mode de diffusion : « ${mode} »`);
      if (mode !== 'arretee') this.requestInventories('changement de mode');
      this.emitStatus();
    }
    return result;
  }

  resync(): void {
    this.scan();
    this.requestInventories('resynchronisation demandée');
  }

  // ==========================================================================
  // Index local
  // ==========================================================================

  private activeApps(): Set<string> {
    const known = this.configService.getKnownApps() ?? [];
    const disabled = new Set(this.configService.getDisabledApps());
    return new Set(['core', ...known.filter((a) => !disabled.has(a))]);
  }

  private abs(rel: string): string {
    return path.join(this.dataRoot, ...rel.split('/'));
  }

  private hashFile(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /** Inventaire complet de data/ (fichiers reproductibles seulement). */
  private scan(): void {
    this.index.clear();
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          // dist/ des applications externes : compilé sur chaque machine (D8), jamais parcouru.
          if (!isExcludedDir(e.name) && !/^applications\/[^/]+\/dist$/.test(childRel)) {
            walk(path.join(dir, e.name), childRel);
          }
        } else if (e.isFile()) {
          this.indexFile(childRel);
        }
      }
    };
    walk(this.dataRoot, '');
  }

  /** (Ré)indexe un fichier ; retourne l'entrée, ou undefined s'il n'est pas reproductible/absent. */
  private indexFile(rel: string): LocalEntry | undefined {
    try {
      const st = fs.statSync(this.abs(rel));
      if (!st.isFile() || exclusionReason(rel, st.size)) {
        this.index.delete(rel);
        return undefined;
      }
      const prev = this.index.get(rel);
      const mtime = Math.round(st.mtimeMs);
      if (prev && prev.mtime === mtime && prev.size === st.size) return prev;
      const entry = { mtime, size: st.size, sha256: this.hashFile(this.abs(rel)) };
      this.index.set(rel, entry);
      return entry;
    } catch {
      this.index.delete(rel);
      return undefined;
    }
  }

  private localVersion(rel: string): Version | undefined {
    const e = this.index.get(rel);
    if (e) return { mtime: e.mtime, sha256: e.sha256, origin: this.machineId };
    const d = this.deletions.get(rel);
    if (d) return { mtime: d.at, sha256: '', origin: d.origin, deleted: true };
    return undefined;
  }

  // ==========================================================================
  // Surveillance de data/ (§5)
  // ==========================================================================

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.dataRoot, { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join('/');
        // Exclusion par le nom seul ici (la taille est vérifiée à l'indexation).
        if (exclusionReason(rel)) return;
        this.pendingChanges.add(rel);
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.flushChanges(), this.timings.settle);
      });
    } catch (error) {
      this.logger.error('Diffusion', `Surveillance de ${this.dataRoot} impossible : ${error}`);
    }
  }

  private flushChanges(): void {
    const changes = [...this.pendingChanges];
    this.pendingChanges.clear();
    for (const rel of changes) {
      const full = this.abs(rel);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) continue;
      const before = this.index.get(rel);
      if (fs.existsSync(full)) {
        const after = this.indexFile(rel);
        if (!after || (before && before.sha256 === after.sha256)) continue;
        this.deletions.delete(rel);
        if (canSend(rel, this.mode)) this.sendFile(rel, 'modification locale');
      } else if (before) {
        this.index.delete(rel);
        const at = Date.now();
        this.deletions.set(rel, { at, origin: this.machineId });
        this.saveDeletions();
        if (canSend(rel, this.mode)) this.publishFile({ path: rel, mtime: at, sha256: '', origin: this.machineId, deleted: true });
      }
    }
    this.emitStatus();
  }

  // ==========================================================================
  // Messages (§4)
  // ==========================================================================

  private publish(topic: string, payload: unknown): void {
    this.transport?.publish(topic, JSON.stringify(payload), 1, false);
  }

  private requestInventories(why: string): void {
    if (this.mode === 'arretee' || !this.transport) return;
    this.inventories = [];
    this.publish(`${TOPIC}/inventaire/demande`, { from: this.machineId, at: new Date().toISOString() });
    this.logger.info('Diffusion', `Demande des inventaires (${why})`);
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    this.inventoryTimer = setTimeout(() => this.reconcile(), this.timings.inventoryWindow);
  }

  private myInventory(): InventoryMessage {
    const files: InventoryMessage['files'] = [];
    for (const [rel, e] of this.index) {
      if (canSend(rel, this.mode)) files.push({ path: rel, mtime: e.mtime, sha256: e.sha256, origin: this.machineId, size: e.size });
    }
    for (const [rel, d] of this.deletions) {
      if (canSend(rel, this.mode)) files.push({ path: rel, mtime: d.at, sha256: '', origin: d.origin, deleted: true });
    }
    return { from: this.machineId, files };
  }

  private handleMessage(topic: string, raw: string): void {
    if (this.mode === 'arretee' || !topic.startsWith(`${TOPIC}/`)) return;
    const parts = topic.slice(TOPIC.length + 1).split('/');
    const body = JSON.parse(raw);
    if (parts[0] === 'inventaire' && parts[1] === 'demande') {
      if (body.from === this.machineId) return;
      // Réception seule : on ne publie rien, donc pas d'inventaire à fournir. Mais une machine qui
      // (re)démarre ne pousse rien vers une machine muette : on refait NOTRE demande, décalée, pour
      // récupérer ses fichiers (constaté à l'essai du 29/09/2026 : il fallait « Resynchroniser »).
      if (this.mode === 'complet') this.publish(`${TOPIC}/inventaire/${this.machineId}`, this.myInventory());
      else if (this.mode === 'reception' && !this.inventoryTimer) {
        if (this.peerJoinTimer) clearTimeout(this.peerJoinTimer);
        this.peerJoinTimer = setTimeout(() => {
          this.peerJoinTimer = undefined;
          this.requestInventories(`machine ${body.from} apparue`);
        }, this.timings.inventoryWindow);
      }
      return;
    }
    if (parts[0] === 'inventaire' && parts[1] && parts[1] !== this.machineId) {
      this.peers.set(parts[1], new Date().toISOString());
      if (this.inventoryTimer) this.inventories.push(body as InventoryMessage);
      return;
    }
    if (parts[0] === 'demande' && parts[1] === this.machineId) {
      if (this.mode !== 'complet') return;
      for (const rel of (body.paths ?? []) as string[]) {
        if (this.index.has(rel) || this.deletions.has(rel)) this.sendFile(rel, `demandé par ${body.from}`);
      }
      return;
    }
    if (parts[0] === 'fichier' && parts[1] && parts[1] !== this.machineId) {
      this.receiveFile(body as FileMessage);
    }
  }

  /** Après la fenêtre d'inventaire : demandes et envois (§5.3). */
  private reconcile(): void {
    this.inventoryTimer = undefined;
    const active = this.activeApps();
    const best = new Map<string, Version & { from: string }>();
    for (const inv of this.inventories) {
      for (const f of inv.files ?? []) {
        if (exclusionReason(f.path, f.size) || !canReceive(f.path, this.mode, active)) continue;
        const cur = best.get(f.path);
        if (!cur || isNewer(f, cur)) best.set(f.path, { ...f, from: inv.from });
      }
    }
    const wanted = new Map<string, string[]>();
    for (const [rel, v] of best) {
      if (!isNewer(v, this.localVersion(rel))) continue;
      const list = wanted.get(v.from) ?? [];
      list.push(rel);
      wanted.set(v.from, list);
    }
    for (const [from, paths] of wanted) this.publish(`${TOPIC}/demande/${from}`, { from: this.machineId, paths });
    let pushed = 0;
    // Envoi « plus récent ici » seulement si d'autres machines ont répondu (sinon personne à qui
    // l'envoyer : une machine seule renverrait tout à chaque démarrage).
    if (this.mode === 'complet' && this.inventories.length > 0) {
      for (const rel of [...this.index.keys(), ...this.deletions.keys()]) {
        const mine = this.localVersion(rel);
        const theirs = best.get(rel);
        if (mine && canSend(rel, this.mode) && (!theirs || isNewer(mine, theirs))) {
          this.sendFile(rel, 'plus récent ici');
          pushed++;
        }
      }
    }
    this.lastSync = new Date().toISOString();
    const asked = [...wanted.values()].reduce((n, l) => n + l.length, 0);
    this.logger.info('Diffusion', `Synchronisation : ${this.inventories.length} inventaire(s), ${asked} fichier(s) demandé(s), ${pushed} envoyé(s)`);
    this.emitStatus();
  }

  private sendFile(rel: string, why: string): void {
    this.sendQueue = this.sendQueue.then(async () => {
      const d = this.deletions.get(rel);
      const e = this.indexFile(rel);
      if (!e && d) {
        this.publishFile({ path: rel, mtime: d.at, sha256: '', origin: d.origin, deleted: true });
      } else if (e) {
        const content = fs.readFileSync(this.abs(rel)).toString('base64');
        this.publishFile({ path: rel, mtime: e.mtime, sha256: e.sha256, origin: this.machineId, size: e.size, content });
      } else {
        return;
      }
      this.lastEvents.set(rel, { event: 'envoyé', machine: this.machineId, at: new Date().toISOString() });
      this.logger.debug('Diffusion', `Envoyé : ${rel} (${why})`);
      await new Promise((r) => setTimeout(r, this.timings.sendSpacing));
    });
  }

  private publishFile(msg: FileMessage): void {
    this.publish(`${TOPIC}/fichier/${this.machineId}`, msg);
  }

  // ==========================================================================
  // Réception (§6)
  // ==========================================================================

  private receiveFile(msg: FileMessage): void {
    const rel = msg.path;
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) return;
    if (exclusionReason(rel, msg.size) || !canReceive(rel, this.mode, this.activeApps())) return;
    if (msg.mtime > Date.now() + FUTURE_TOLERANCE_MS) {
      this.logger.warn('Diffusion', `${rel} reçu de ${msg.origin} daté dans le futur (${new Date(msg.mtime).toISOString()}) — horloge à vérifier`);
    }
    if (!isNewer(msg, this.localVersion(rel))) return;
    const full = this.abs(rel);
    this.keepHistory(rel);
    if (msg.deleted) {
      try { fs.unlinkSync(full); } catch { /* déjà absent */ }
      this.index.delete(rel);
      this.deletions.set(rel, { at: msg.mtime, origin: msg.origin });
      this.saveDeletions();
    } else {
      const content = Buffer.from(msg.content ?? '', 'base64');
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      if (sha !== msg.sha256) {
        this.logger.warn('Diffusion', `${rel} reçu de ${msg.origin} : empreinte incorrecte, ignoré`);
        return;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.diffusion.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, full);
      const when = new Date(msg.mtime);
      fs.utimesSync(full, when, when);
      // Index mis à jour AVANT que la surveillance voie le fichier : pas de renvoi (écho).
      this.index.set(rel, { mtime: Math.round(fs.statSync(full).mtimeMs), sha256: sha, size: content.length });
      this.deletions.delete(rel);
    }
    this.lastEvents.set(rel, { event: 'reçu', machine: msg.origin, at: new Date().toISOString() });
    this.logger.info('Diffusion', `${msg.deleted ? 'Supprimé' : 'Reçu'} : ${rel} (de ${msg.origin})`);
    this.notifyApplication(rel, msg.origin);
    this.emitStatus();
  }

  /** Prévient l'application (§9) : config.yaml → rechargement existant ; autre → core:data:file:changed. */
  private notifyApplication(rel: string, origin: string): void {
    const app = appOf(rel);
    const segs = rel.split('/');
    if (segs[0] !== 'applications' && segs.length === 2 && segs[1] === 'config.yaml') {
      this.configService.reload();
      if (app !== 'core') this.eventBus.emit('app:module:config:saved', { moduleId: app, success: true } as never);
      return;
    }
    this.eventBus.emitGeneric('core:data:file:changed', { app, path: rel, origin });
  }

  private keepHistory(rel: string): void {
    const full = this.abs(rel);
    if (!fs.existsSync(full)) return;
    try {
      const dir = path.join(this.stateDir, 'historique', path.dirname(rel));
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(rel);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(full, path.join(dir, `${base}.${stamp}`));
      const versions = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && /\d{4}-\d{2}-\d{2}T/.test(f.slice(base.length + 1))).sort();
      for (const old of versions.slice(0, Math.max(0, versions.length - HISTORY_KEEP))) fs.unlinkSync(path.join(dir, old));
    } catch (error) {
      this.logger.warn('Diffusion', `Historique de ${rel} impossible : ${error}`);
    }
  }

  // ==========================================================================
  // Suppressions (§7)
  // ==========================================================================

  private deletionsFile(): string {
    return path.join(this.stateDir, 'suppressions.yaml');
  }

  private loadDeletions(): void {
    try {
      const raw = yaml.load(fs.readFileSync(this.deletionsFile(), 'utf8')) as Record<string, { at: number; origin: string }> | null;
      const limit = Date.now() - DELETION_KEEP_MS;
      this.deletions = new Map(Object.entries(raw ?? {}).filter(([, d]) => d && d.at >= limit));
    } catch {
      this.deletions = new Map();
    }
  }

  private saveDeletions(): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const limit = Date.now() - DELETION_KEEP_MS;
      const obj = Object.fromEntries([...this.deletions].filter(([, d]) => d.at >= limit));
      fs.writeFileSync(`${this.deletionsFile()}.tmp`, yaml.dump(obj));
      fs.renameSync(`${this.deletionsFile()}.tmp`, this.deletionsFile());
    } catch (error) {
      this.logger.warn('Diffusion', `Écriture de suppressions.yaml impossible : ${error}`);
    }
  }

  // ==========================================================================
  // État (page Diffusion des données)
  // ==========================================================================

  getStatus(): DiffusionStatus {
    const mode = this.mode;
    const active = this.activeApps();
    const files: DiffusionFileView[] = [];
    for (const [rel, e] of this.index) {
      files.push({
        path: rel, app: appOf(rel), size: e.size, mtime: e.mtime,
        state: isIsolated(rel, mode, active) ? 'isolé' : 'reproduit',
        last: this.lastEvents.get(rel)
      });
    }
    for (const [rel, d] of this.deletions) {
      files.push({ path: rel, app: appOf(rel), mtime: d.at, state: 'supprimé', last: this.lastEvents.get(rel) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { machineId: this.machineId, mode, connected: this.connected, lastSync: this.lastSync, peers: Object.fromEntries(this.peers), files };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('diffusion:status', this.getStatus());
  }
}
