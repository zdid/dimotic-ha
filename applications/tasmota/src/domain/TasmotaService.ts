/**
 * TasmotaService (fonctionnelles-tasmota_specs v1.0) — toute la logique de l'application :
 * - liste des appareils depuis `tasmota/discovery/<MAC>/config|sensors` + LWT (§3) ;
 * - publication HA standard comme RFXCOM (§4, ha-discovery.ts) ;
 * - fiche relue / réinjectée par MQTT (§5) ;
 * - mise en service d'un neuf par nmcli + HTTP (§6, provisioning.ts) ;
 * - règles préétablies + modes, entité select dans HA (§7, rules.ts) ;
 * - requêtes corrélées d'ia (§8).
 * Tout passe par la connexion MQTT du socle (bridge passthrough, décision D3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { IEventBus, Logger, IAppConfigProvider, HaBridgeClient } from '../../../core/dist/exports';
import { computeBridgeInstance } from '../../../core/dist/exports';
import {
  tasmotaConfigSchema,
  rulesFileSchema,
  ruleInstanceSchema,
  type TasmotaConfig,
  type RuleInstance,
  type RulesFile
} from './config-schema';
import {
  deviceTopics,
  analyseRelays,
  analyseSensors,
  buildHaDiscovery,
  relayHaTopics,
  attributesTopic,
  shutterStateTopic,
  powerSuffix,
  type TasmotaDiscoveryConfig,
  type DeviceTopics
} from './ha-discovery';
import {
  extractTaxonomy,
  isConventionalName,
  composeDeviceName,
  splitDeviceName,
  suggestTopic,
  slugify,
  DEVICE_NAME_MAX,
  type NameParts
} from './taxonomy';
import { buildRuleText, describeTemplates, findTemplate, isRuleActive, RULE_MAX_LENGTH } from './rules';
import {
  checkProvisioning,
  scanTasmotaAccessPoints,
  provisionNewDevice,
  scanNetworkForTasmota,
  pointToBroker,
  type ProvisionCheck,
  type NetworkTasmota
} from './provisioning';
import { TASMOTA_SOCKET_EVENTS, TASMOTA_CLIENT_EVENTS, TASMOTA_REQUEST_EVENTS } from './socket-events';

const MODULE_NAME = 'tasmota';
const DISCOVERY_CONFIG_RE = /^tasmota\/discovery\/([0-9A-Fa-f]{12})\/config$/;
const DISCOVERY_SENSORS_RE = /^tasmota\/discovery\/([0-9A-Fa-f]{12})\/sensors$/;
const MODE_TOPIC = 'dimotic/tasmota/mode';
const MODE_SET_TOPIC = 'dimotic/tasmota/mode/set';
const HA_STATUS_TOPIC = 'homeassistant/status';
const MODE_SELECT_SOURCE = 'tasmota/select/dimotic_tasmota/mode/config';
const MODE_SELECT_HA = 'homeassistant/select/dimotic_tasmota/mode/config';
const MODE_SETTLE_MS = 3000;

/** Modèle officiel Sonoff Basic R4, GPIO5 = MagicSwitch (repris du script Outils tasmota-config). */
const TEMPLATE_R4 = '{"NAME":"Sonoff Basic R4","GPIO":[0,0,0,0,224,10560,544,0,0,32,0,0,0,0,0,0,0,0,0,0,0,0],"FLAG":0,"BASE":1}';
const MODEL_R4 = 'Sonoff Basic R4 (Magic Switch)';

interface DeviceRecord {
  mac: string;
  cfg: TasmotaDiscoveryConfig;
  sn?: Record<string, unknown>;
  topics: DeviceTopics;
  online?: boolean;
  lastSeen: string;
  /** Signature de la dernière publication HA (évite de republier à l'identique). */
  haSignature?: string;
  haTopics: Set<string>;
}

interface Waiter {
  mac: string;
  match: (suffix: string, body: unknown, raw: string) => unknown;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

type LogLevel = 'info' | 'ok' | 'error';

export interface ITasmotaService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class TasmotaService implements ITasmotaService {
  private config: TasmotaConfig;
  private readonly bridgeInstance: string;
  private readonly dataDir: string;
  private readonly rulesPath: string;
  private rules: RulesFile;
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly subscribed = new Set<string>();
  private waiters: Waiter[] = [];
  private currentMode?: string;
  private modeSeen = false;
  private connected = false;
  private emitTimer?: NodeJS.Timeout;
  private modeSettleTimer?: NodeJS.Timeout;
  private provisionCheck?: ProvisionCheck;
  private accessPoints: Array<{ ssid: string; signal: number }> = [];
  private provisioning = false;
  private readonly busy = new Set<string>();
  /** Résultat de la dernière recherche sur le réseau (§6bis) — Tasmota déjà connectés, non encore
   *  vus par découverte MQTT (sinon déjà dans `devices`). */
  private networkFound: NetworkTasmota[] = [];
  private networkScanning = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<TasmotaConfig>,
    private readonly haBridge?: HaBridgeClient
  ) {
    this.config = this.loadConfig();
    this.bridgeInstance = computeBridgeInstance(MODULE_NAME, process.env.DIMOTIC_MACHINE_ID);
    this.dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', MODULE_NAME);
    this.rulesPath = path.join(this.dataDir, 'rules.yaml');
    this.rules = this.loadRules();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<TasmotaConfig>, haBridge?: HaBridgeClient): TasmotaService {
    return new TasmotaService(eventBus, logger, configProvider, haBridge);
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  private loadConfig(): TasmotaConfig {
    return tasmotaConfigSchema.parse(this.configProvider.getAppConfig() ?? {});
  }

  private loadRules(): RulesFile {
    try {
      if (!fs.existsSync(this.rulesPath)) return {};
      return rulesFileSchema.parse(yaml.load(fs.readFileSync(this.rulesPath, 'utf8')) ?? {});
    } catch (error) {
      this.logger.error('TasmotaService', `rules.yaml illisible, ignoré : ${error}`);
      return {};
    }
  }

  private saveRules(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.rulesPath}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(this.rules));
    fs.renameSync(tmp, this.rulesPath);
  }

  async start(): Promise<void> {
    this.logger.info('TasmotaService', 'Démarrage');
    this.setupListeners();
    this.eventBus.emitGeneric('integration:bridge:register', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
    if (this.haBridge) {
      this.haBridge.start().then(() => this.scheduleEmit()).catch((error) => this.logger.warn('TasmotaService', `Référentiel HA indisponible : ${error}`));
    }
    void this.refreshProvisionCheck();
    this.scheduleEmit();
  }

  async stop(): Promise<void> {
    for (const t of [this.emitTimer, this.modeSettleTimer]) if (t) clearTimeout(t);
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.eventBus.emitGeneric('integration:bridge:unregister', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
  }

  private setupListeners(): void {
    this.eventBus.onGeneric<{ bridgeInstance: string; connected: boolean }>(`integration:${MODULE_NAME}:bridge:connection`, (data) => {
      if (data.bridgeInstance !== this.bridgeInstance) return;
      this.connected = data.connected;
      this.logger.info('TasmotaService', `Connexion MQTT du socle ${data.connected ? 'établie' : 'perdue'}`);
      if (!data.connected) {
        this.scheduleEmit();
        return;
      }
      this.subscribed.clear();
      for (const topic of ['tasmota/discovery/+/config', 'tasmota/discovery/+/sensors', HA_STATUS_TOPIC, MODE_TOPIC, MODE_SET_TOPIC]) {
        this.subscribe(topic);
      }
      for (const device of this.devices.values()) this.subscribeDevice(device);
      this.publishModeSelect();
      if (this.modeSettleTimer) clearTimeout(this.modeSettleTimer);
      this.modeSettleTimer = setTimeout(() => this.initModeIfNone(), MODE_SETTLE_MS);
      this.scheduleEmit();
    });

    this.eventBus.onGeneric<{ bridgeInstance: string; topic: string; payload: string }>(`integration:${MODULE_NAME}:passthrough:message`, (data) => {
      if (data.bridgeInstance !== this.bridgeInstance) return;
      try {
        this.handleMessage(data.topic, data.payload ?? '');
      } catch (error) {
        this.logger.error('TasmotaService', `Message ${data.topic} : ${error}`);
      }
    });

    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.reloadConfig();
    });

    // --- Interface ---
    const on = <T>(event: string, handler: (data: T) => unknown): void => {
      this.eventBus.onGeneric<T>(event, (data) => {
        Promise.resolve(handler(data)).catch((error) => this.log(`Erreur : ${error instanceof Error ? error.message : error}`, 'error'));
      });
    };
    on(TASMOTA_CLIENT_EVENTS.GET_STATE, () => this.emitState());
    // ⭐ 29/09/2026 (techniques-diffusion-data_specs §2bis) — fichier de data/tasmota/ reçu d'une autre
    // machine (diffusion du core) : relu ici, sans redémarrer l'application.
    this.eventBus.onGeneric<{ app: string; path: string; origin: string }>('core:data:file:changed', (e) => {
      if (e?.app !== MODULE_NAME || e.path !== 'tasmota/rules.yaml') return;
      this.rules = this.loadRules();
      this.logger.info('TasmotaService', `rules.yaml reçu de ${e.origin} : règles relues, modes remis en conformité`);
      for (const device of this.devices.values()) void this.enforceModeOnDevice(device, 'règles reçues');
      this.scheduleEmit();
    });
    on<{ mac: string }>(TASMOTA_CLIENT_EVENTS.DEVICE_READ, (d) => this.readDevice(String(d?.mac ?? '')));
    on<ApplyRequest>(TASMOTA_CLIENT_EVENTS.DEVICE_APPLY, (d) => this.applyDevice(d));
    on<{ mac: string; action: string }>(TASMOTA_CLIENT_EVENTS.DEVICE_ACTION, (d) => this.deviceAction(String(d?.mac ?? ''), String(d?.action ?? '')));
    on<{ mac: string }>(TASMOTA_CLIENT_EVENTS.DEVICE_FORGET, (d) => this.forgetDevice(String(d?.mac ?? '')));
    on<{ mac: string; rules: unknown }>(TASMOTA_CLIENT_EVENTS.RULES_SAVE, (d) => this.saveDeviceRules(String(d?.mac ?? ''), d?.rules));
    on<{ mode: string }>(TASMOTA_CLIENT_EVENTS.MODE_SET, (d) => this.setMode(String(d?.mode ?? ''), 'interface'));
    on<{ config: unknown }>(TASMOTA_CLIENT_EVENTS.CONFIG_SAVE, (d) => this.saveConfig(d?.config));
    on<{ scan?: boolean }>(TASMOTA_CLIENT_EVENTS.PROVISION_CHECK, (d) => this.refreshProvisionCheck(!!d?.scan));
    on<{ ssid: string }>(TASMOTA_CLIENT_EVENTS.PROVISION_START, (d) => this.startProvisioning(String(d?.ssid ?? '')));
    on(TASMOTA_CLIENT_EVENTS.NETWORK_SCAN, () => this.scanNetwork());
    on<{ ip: string }>(TASMOTA_CLIENT_EVENTS.NETWORK_POINT, (d) => this.pointDeviceToBroker(String(d?.ip ?? '')));

    // --- Requêtes corrélées (ia, §8) ---
    this.eventBus.onGeneric<{ correlation_id: string }>(TASMOTA_REQUEST_EVENTS.CATALOG_GET, (req) => {
      this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.CATALOG_GET}:reply`, { correlation_id: req?.correlation_id, ...this.getCatalog() });
    });
    this.eventBus.onGeneric<RuleDefineRequest>(TASMOTA_REQUEST_EVENTS.RULE_DEFINE, (req) => {
      this.defineRuleFromRequest(req)
        .then((result) => this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.RULE_DEFINE}:reply`, { correlation_id: req?.correlation_id, ...result }))
        .catch((error) => this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.RULE_DEFINE}:reply`, { correlation_id: req?.correlation_id, accepted: false, reason: String(error instanceof Error ? error.message : error) }));
    });
    this.eventBus.onGeneric<{ correlation_id: string; mode: string }>(TASMOTA_REQUEST_EVENTS.MODE_SET, (req) => {
      const reason = this.setMode(String(req?.mode ?? ''), 'ia');
      this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.MODE_SET}:reply`, { correlation_id: req?.correlation_id, accepted: !reason, reason });
    });
  }

  private reloadConfig(): void {
    this.configProvider.reload();
    this.config = this.loadConfig();
    this.publishModeSelect();
    for (const device of this.devices.values()) {
      device.haSignature = undefined;
      this.publishDevice(device);
    }
    this.scheduleEmit();
  }

  // ==========================================================================
  // MQTT
  // ==========================================================================

  private subscribe(topic: string): void {
    if (this.subscribed.has(topic)) return;
    this.subscribed.add(topic);
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:subscribe`, { bridgeInstance: this.bridgeInstance, topic, qos: 1 });
  }

  private publish(topic: string, payload: unknown, retain = false): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:publish`, { bridgeInstance: this.bridgeInstance, topic, payload, qos: 1, retain });
  }

  private subscribeDevice(device: DeviceRecord): void {
    this.subscribe(`${device.topics.stat}+`);
    this.subscribe(`${device.topics.tele}+`);
  }

  private command(device: DeviceRecord, cmd: string, payload = ''): void {
    this.publish(`${device.topics.cmnd}${cmd}`, payload);
  }

  /** Envoie une commande et attend une réponse reconnue par `match` (valeur retournée non undefined). */
  private commandAndWait<T>(device: DeviceRecord, cmd: string, payload: string, match: Waiter['match'], timeoutMs = 6000): Promise<T | undefined> {
    const promise = new Promise<T | undefined>((resolve) => {
      const waiter: Waiter = {
        mac: device.mac,
        match,
        resolve: (value) => resolve(value as T | undefined),
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(undefined);
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
    this.command(device, cmd, payload);
    return promise;
  }

  /** Réponse RESULT contenant la clé `key` (insensible à la casse). */
  private resultKey(key: string): Waiter['match'] {
    const lower = key.toLowerCase();
    return (suffix, body) => {
      if (suffix !== 'RESULT' || !body || typeof body !== 'object') return undefined;
      const found = Object.keys(body as object).find((k) => k.toLowerCase() === lower);
      return found ? (body as Record<string, unknown>)[found] : undefined;
    };
  }

  private query<T>(device: DeviceRecord, cmd: string, timeoutMs = 6000): Promise<T | undefined> {
    return this.commandAndWait<T>(device, cmd, '', this.resultKey(cmd.replace(/\s.*$/, '')), timeoutMs);
  }

  private handleMessage(topic: string, raw: string): void {
    let m = DISCOVERY_CONFIG_RE.exec(topic);
    if (m) return this.onDiscoveryConfig(m[1].toUpperCase(), raw);
    m = DISCOVERY_SENSORS_RE.exec(topic);
    if (m) return this.onDiscoverySensors(m[1].toUpperCase(), raw);
    if (topic === HA_STATUS_TOPIC) {
      if (raw.trim() === 'online') {
        this.logger.info('TasmotaService', 'HA en ligne : états des relais redemandés');
        for (const device of this.devices.values()) this.queryStates(device);
      }
      return;
    }
    if (topic === MODE_TOPIC) {
      this.modeSeen = true;
      const mode = raw.trim();
      if (mode && mode !== this.currentMode) {
        this.currentMode = mode;
        this.scheduleEmit();
      }
      return;
    }
    if (topic === MODE_SET_TOPIC) {
      const reason = this.setMode(raw.trim(), 'Home Assistant');
      if (reason) this.logger.warn('TasmotaService', `Mode refusé depuis HA : ${reason}`);
      return;
    }

    for (const device of this.devices.values()) {
      let suffix: string | undefined;
      let fromTele = false;
      if (topic.startsWith(device.topics.stat)) suffix = topic.slice(device.topics.stat.length);
      else if (topic.startsWith(device.topics.tele)) {
        suffix = topic.slice(device.topics.tele.length);
        fromTele = true;
      }
      if (suffix === undefined || suffix.includes('/')) continue;
      this.onDeviceMessage(device, suffix, fromTele, raw);
      return;
    }
  }

  private onDeviceMessage(device: DeviceRecord, suffix: string, fromTele: boolean, raw: string): void {
    device.lastSeen = new Date().toISOString();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    if (fromTele && suffix === 'LWT') {
      const online = raw.trim() === 'Online';
      const cameOnline = online && device.online !== true;
      device.online = online;
      if (cameOnline) void this.enforceModeOnDevice(device, 'retour en ligne');
      this.scheduleEmit();
    } else if (body && typeof body === 'object') {
      this.relayShutterState(device, body as Record<string, unknown>, suffix);
    }
    const key = fromTele ? `tele:${suffix}` : suffix;
    for (const waiter of [...this.waiters]) {
      if (waiter.mac !== device.mac) continue;
      const value = waiter.match(key, body, raw);
      if (value === undefined) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(value);
    }
  }

  /** Position des volets → topic retenu lu par HA (§4.2). */
  private relayShutterState(device: DeviceRecord, body: Record<string, unknown>, suffix: string): void {
    if (suffix !== 'RESULT' && suffix !== 'SENSOR' && suffix !== 'STATUS10') return;
    const source = suffix === 'STATUS10' ? (body.StatusSNS as Record<string, unknown> | undefined) ?? {} : body;
    for (const [key, value] of Object.entries(source)) {
      const m = /^Shutter(\d+)$/.exec(key);
      if (!m || !value || typeof value !== 'object') continue;
      const k = Number(m[1]);
      const info = value as { Position?: number; Direction?: number };
      if (typeof info.Position !== 'number') continue;
      const inverted = ((device.cfg.sho ?? [])[k - 1] ?? 0) & 1;
      const position = inverted ? 100 - info.Position : info.Position;
      const direction = typeof info.Direction === 'number' ? (inverted ? -info.Direction : info.Direction) : 0;
      this.publish(shutterStateTopic(device.mac, k), { position, direction }, true);
    }
  }

  private onDiscoveryConfig(mac: string, raw: string): void {
    const existing = this.devices.get(mac);
    if (!raw.trim()) {
      if (existing) {
        this.logger.info('TasmotaService', `Découverte effacée : ${mac} retiré`);
        this.clearHa(existing);
        this.devices.delete(mac);
        this.scheduleEmit();
      }
      return;
    }
    let cfg: TasmotaDiscoveryConfig;
    try {
      cfg = JSON.parse(raw);
    } catch {
      this.logger.warn('TasmotaService', `Découverte illisible pour ${mac}`);
      return;
    }
    if (!cfg || typeof cfg.t !== 'string' || typeof cfg.ft !== 'string') return;
    cfg.mac = mac;
    const device: DeviceRecord = existing ?? { mac, cfg, topics: deviceTopics(cfg), lastSeen: new Date().toISOString(), haTopics: new Set() };
    device.cfg = cfg;
    device.topics = deviceTopics(cfg);
    device.lastSeen = new Date().toISOString();
    this.devices.set(mac, device);
    if (this.connected) this.subscribeDevice(device);
    if (!existing) this.logger.info('TasmotaService', `Appareil ${mac} « ${cfg.dn ?? '?'} » (${cfg.ip ?? '?'})`);
    // Sous gestion par découverte MQTT désormais : plus la peine de le montrer comme « trouvé sur
    // le réseau » (§6bis).
    if (this.networkFound.some((d) => d.mac === mac)) {
      this.networkFound = this.networkFound.filter((d) => d.mac !== mac);
      this.emitNetworkStatus();
    }
    this.publishDevice(device);
    // Un waiter peut attendre la nouvelle découverte (changement de Topic/nom, §5).
    for (const waiter of [...this.waiters]) {
      if (waiter.mac !== mac) continue;
      const value = waiter.match('discovery', cfg, raw);
      if (value === undefined) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(value);
    }
    this.scheduleEmit();
  }

  private onDiscoverySensors(mac: string, raw: string): void {
    const device = this.devices.get(mac);
    if (!device || !raw.trim()) return;
    try {
      const body = JSON.parse(raw) as { sn?: Record<string, unknown> };
      device.sn = body.sn;
      this.publishDevice(device);
      this.scheduleEmit();
    } catch {
      this.logger.warn('TasmotaService', `Capteurs illisibles pour ${mac}`);
    }
  }

  // ==========================================================================
  // Publication HA (§4)
  // ==========================================================================

  private publishDevice(device: DeviceRecord): void {
    if (!this.config.publishToHa || !this.connected) return;
    const built = buildHaDiscovery(device.cfg, device.sn);
    if (!built) {
      if (device.haTopics.size) {
        this.logger.info('TasmotaService', `${device.mac} n'est plus nommé selon la convention : retiré de HA`);
        this.clearHa(device);
      }
      device.haSignature = undefined;
      return;
    }
    const signature = JSON.stringify(built);
    if (signature === device.haSignature) return;
    device.haSignature = signature;

    const newTopics = new Set(built.entities.map((e) => e.haTopic));
    // Ancien composant d'un relais (switch ↔ light) et entités disparues : effacés.
    const stale = new Set<string>(device.haTopics);
    for (const relay of analyseRelays(device.cfg).relays) for (const t of relayHaTopics(device.mac, relay.index)) stale.add(t);
    for (const topic of stale) if (!newTopics.has(topic)) this.publish(topic, '', true);

    this.publish(attributesTopic(device.mac), built.attributes, true);
    for (const entity of built.entities) {
      this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:discovery`, {
        bridgeInstance: this.bridgeInstance,
        sourceTopic: entity.sourceTopic,
        payload: entity.payload
      });
    }
    device.haTopics = newTopics;
    this.logger.info('TasmotaService', `${device.mac} publié vers HA (${built.entities.length} entité(s))`);
    setTimeout(() => this.queryStates(device), 1500);
  }

  private clearHa(device: DeviceRecord): void {
    const topics = new Set<string>(device.haTopics);
    for (const relay of analyseRelays(device.cfg).relays) for (const t of relayHaTopics(device.mac, relay.index)) topics.add(t);
    for (const topic of topics) this.publish(topic, '', true);
    this.publish(attributesTopic(device.mac), '', true);
    device.haTopics.clear();
    device.haSignature = undefined;
  }

  /** États initiaux pour HA : POWER<n> et position des volets. */
  private queryStates(device: DeviceRecord): void {
    if (!device.haTopics.size) return;
    const { relays, shutters } = analyseRelays(device.cfg);
    for (const relay of relays) this.command(device, powerSuffix(device.cfg, relay.index));
    for (const shutter of shutters) this.command(device, `ShutterPosition${shutter.number}`);
  }

  // ==========================================================================
  // Modes (§7.2)
  // ==========================================================================

  private publishModeSelect(): void {
    if (!this.connected || !this.config.publishToHa) return;
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:discovery`, {
      bridgeInstance: this.bridgeInstance,
      sourceTopic: MODE_SELECT_SOURCE,
      payload: {
        name: 'Mode',
        unique_id: 'dimotic_tasmota_mode',
        icon: 'mdi:home-switch',
        command_topic: MODE_SET_TOPIC,
        state_topic: MODE_TOPIC,
        options: this.config.modes,
        device: { identifiers: ['dimotic_tasmota'], name: 'Modes de la maison', manufacturer: 'dimotic-ha', model: 'Application Tasmota' }
      }
    });
  }

  private initModeIfNone(): void {
    if (this.modeSeen || this.currentMode) return;
    const first = this.config.modes[0];
    this.logger.info('TasmotaService', `Aucun mode retenu sur le broker : « ${first} » par défaut`);
    this.currentMode = first;
    this.publish(MODE_TOPIC, first, true);
    this.scheduleEmit();
  }

  /** Retourne la raison d'un refus, undefined si accepté. */
  private setMode(mode: string, origin: string): string | undefined {
    if (!this.config.modes.includes(mode)) return `Mode inconnu : « ${mode} » (modes : ${this.config.modes.join(', ')})`;
    this.currentMode = mode;
    this.modeSeen = true;
    this.publish(MODE_TOPIC, mode, true);
    this.log(`Mode « ${mode} » (depuis ${origin}) : règles mises en conformité`, 'ok');
    for (const device of this.devices.values()) void this.enforceModeOnDevice(device, `mode ${mode}`);
    this.scheduleEmit();
    return undefined;
  }

  /** Active/désactive (Rule<k> 1|0) les règles d'un appareil selon le mode courant. */
  private async enforceModeOnDevice(device: DeviceRecord, why: string): Promise<void> {
    const rules = this.rules[device.mac] ?? [];
    if (!rules.length || device.online === false) return;
    for (const rule of rules) {
      this.command(device, `Rule${rule.slot}`, isRuleActive(rule, this.currentMode) ? '1' : '0');
    }
    this.logger.info('TasmotaService', `${device.mac} : règles mises en conformité (${why})`);
  }

  // ==========================================================================
  // Fiche (§5)
  // ==========================================================================

  private findDevice(ref: string): DeviceRecord | undefined {
    const key = ref.replace(/:/g, '').toUpperCase();
    const byMac = this.devices.get(key);
    if (byMac) return byMac;
    const lower = ref.trim().toLowerCase();
    return [...this.devices.values()].find((d) =>
      (d.cfg.dn ?? '').toLowerCase() === lower ||
      (isConventionalName(d.cfg.dn) && extractTaxonomy(d.cfg.dn as string).nomPrecis?.toLowerCase() === lower) ||
      d.cfg.t.toLowerCase() === lower);
  }

  private requireDevice(mac: string): DeviceRecord {
    const device = this.findDevice(mac);
    if (!device) throw new Error(`Appareil inconnu : ${mac}`);
    return device;
  }

  private async readDevice(mac: string): Promise<void> {
    const device = this.requireDevice(mac);
    // Tasmota 15 répond à « Status 0 » en plusieurs messages (STATUS, STATUS1…STATUS11), les anciens
    // firmwares en un seul STATUS0 : chaque partie utile est demandée séparément (constaté le 29/09/2026).
    const part = (n: number, key: string) => this.commandAndWait<Record<string, unknown>>(device, 'Status', n ? String(n) : '',
      (suffix, body) => {
        if (!body || typeof body !== 'object') return undefined;
        const b = body as Record<string, unknown>;
        if ((suffix === (n ? `STATUS${n}` : 'STATUS') || suffix === 'STATUS0' || suffix === 'RESULT') && key in b) return b[key] as Record<string, unknown>;
        return undefined;
      });
    const st = await part(0, 'Status');
    if (!st) {
      this.log(`${this.label(device)} : pas de réponse à Status 0 (hors ligne ?)`, 'error', device.mac);
      this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.DEVICE_DETAILS, { mac: device.mac, error: 'Pas de réponse' });
      return;
    }
    // Tasmota répond à « Template » sans clé Template : directement {"NAME":…,"GPIO":…} (29/09/2026).
    const template = await this.commandAndWait<unknown>(device, 'Template', '',
      (suffix, body) => suffix === 'RESULT' && body && typeof body === 'object' && 'NAME' in (body as object) ? body : undefined);
    const fullTopic = await this.query<string>(device, 'FullTopic');
    const magic = await this.query<number>(device, 'MagicSwitchPulse', 3000);
    const rules: Record<number, { state: string; text: string }> = {};
    for (const k of [1, 2, 3]) {
      const r = await this.query<{ State?: string; Rules?: string }>(device, `Rule${k}`);
      if (r) rules[k] = { state: r.State ?? '?', text: r.Rules ?? '' };
    }
    const hasShutter = analyseRelays(device.cfg).shutters.length > 0;
    const shutter = hasShutter ? {
      open: await this.query<number>(device, 'ShutterOpenDuration1', 3000),
      close: await this.query<number>(device, 'ShutterCloseDuration1', 3000),
      invert: await this.query<string | number>(device, 'ShutterInvert1', 3000)
    } : undefined;

    const fwr = await part(2, 'StatusFWR');
    const net = await part(5, 'StatusNET');
    const mqt = await part(6, 'StatusMQT');
    const site = /^%prefix%\/([^/%]+)\/%topic%\/?$/.exec(String(fullTopic ?? ''))?.[1] ?? '';
    const templateName = template && typeof template === 'object' ? String((template as Record<string, unknown>).NAME ?? '') : '';
    this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.DEVICE_DETAILS, {
      mac: device.mac,
      deviceName: st.DeviceName ?? device.cfg.dn ?? '',
      nameParts: splitDeviceName(String(st.DeviceName ?? device.cfg.dn ?? '')),
      topic: st.Topic ?? device.cfg.t,
      fullTopic: fullTopic ?? device.cfg.ft,
      site,
      module: st.Module,
      templateName,
      magicSwitchPulse: typeof magic === 'number' ? magic : undefined,
      rules,
      shutter,
      firmware: fwr?.Version,
      mqttHost: mqt?.MqttHost,
      hostname: net?.Hostname
    });
    this.log(`${this.label(device)} : réglages relus`, 'ok', device.mac);
  }

  private async applyDevice(req: ApplyRequest): Promise<void> {
    const device = this.requireDevice(req?.mac ?? '');
    if (this.busy.has(device.mac)) throw new Error(`${this.label(device)} : une opération est déjà en cours`);
    this.busy.add(device.mac);
    try {
      await this.doApply(device, req);
    } finally {
      this.busy.delete(device.mac);
    }
  }

  private async doApply(device: DeviceRecord, req: ApplyRequest): Promise<void> {
    const mac = device.mac;
    const parts: NameParts = {
      quoi: String(req.name?.quoi ?? '').trim(),
      precis: String(req.name?.precis ?? '').trim(),
      lieu: String(req.name?.lieu ?? '').trim(),
      pere: String(req.name?.pere ?? '').trim(),
      grandPere: String(req.name?.grandPere ?? '').trim()
    };
    if (!parts.quoi || !parts.lieu) throw new Error('Le QUOI et le lieu sont obligatoires');
    const deviceName = composeDeviceName(parts);
    if (deviceName.length > DEVICE_NAME_MAX) throw new Error(`Nom trop long (${deviceName.length} > ${DEVICE_NAME_MAX} caractères) : ${deviceName}`);
    const topic = (req.topic?.trim() || suggestTopic(parts));
    // Majuscules et tiret acceptés : le topic d'origine d'un Tasmota est `tasmota_<6 hexa majuscules>`.
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(topic)) throw new Error(`Nom technique invalide « ${topic} » (lettres, chiffres, _ ou - ; 32 caractères au plus)`);
    const site = req.site?.trim() ?? '';
    if (!this.config.sites.includes(site)) throw new Error(`Site inconnu : « ${site} »`);
    const fullTopic = `%prefix%/${site}/%topic%/`;
    const hostname = topic.replace(/_/g, '-');

    this.log(`${this.label(device)} → « ${deviceName} », site ${site}, topic ${topic}`, 'info', mac);

    // 1) Modèle (redémarre l'appareil) — d'abord, pour que la suite s'applique au bon module.
    if (req.model === MODEL_R4) {
      this.log('Modèle Sonoff Basic R4 (GPIO5 = MagicSwitch) : envoi, l’appareil redémarre…', 'info', mac);
      const back = this.waitOnline(device, 60_000);
      this.command(device, 'Backlog', `Template ${TEMPLATE_R4}; Module 0`);
      if (!(await back)) throw new Error('Pas de retour en ligne après le changement de modèle (60 s)');
      this.log('Revenu en ligne avec le nouveau modèle', 'ok', mac);
    }

    // 2) Réglages sans changement de topic.
    const cmds: string[] = [];
    if (req.magicSwitchPulse !== undefined && req.magicSwitchPulse !== null && String(req.magicSwitchPulse) !== '') {
      const pulse = Number(req.magicSwitchPulse);
      if (!Number.isInteger(pulse) || pulse < 1000 || pulse > 100000) throw new Error('Sensibilité Magic Switch : entier entre 1000 et 100000 µs');
      cmds.push(`MagicSwitchPulse ${pulse}`);
    }
    cmds.push('SetOption19 0', 'Timezone 99', 'TimeDST 0,0,3,1,2,120', 'TimeSTD 0,0,10,1,3,60',
      `Latitude ${this.config.latitude}`, `Longitude ${this.config.longitude}`,
      `DeviceName ${deviceName}`, `FriendlyName1 ${deviceName.slice(0, 32)}`, `MqttHost ${this.config.mqtt.host}`, `MqttPort ${this.config.mqtt.port}`);
    const backlog = `Backlog ${cmds.join('; ')}`;
    this.log(`Envoi : ${backlog}`, 'info', mac);
    const reply = await this.commandAndWait<unknown>(device, 'Backlog', cmds.join('; '), this.resultKey('MqttPort'), 10_000);
    this.log(reply !== undefined ? 'Réglages acceptés' : 'Pas d’accusé de réception (vérification à la relecture)', reply !== undefined ? 'ok' : 'info', mac);

    // 3) Volet (redémarrage).
    if (req.shutter?.enabled) {
      const open = Number(req.shutter.open);
      const close = Number(req.shutter.close);
      if (!(open > 0 && open <= 600) || !(close > 0 && close <= 600)) throw new Error('Durées du volet : entre 0 et 600 s');
      const shutterCmds = `Interlock 1,2; Interlock 1; ShutterRelay1 1; ShutterOpenDuration1 ${open}; ShutterCloseDuration1 ${close}; ShutterInvert1 ${req.shutter.invert ? 1 : 0}; Restart 1`;
      this.log(`Volet : ${shutterCmds}`, 'info', mac);
      const back = this.waitOnline(device, 60_000);
      this.command(device, 'Backlog', shutterCmds);
      if (!(await back)) throw new Error('Pas de retour en ligne après le réglage du volet (60 s)');
      this.log('Volet réglé, appareil revenu en ligne', 'ok', mac);
    }

    // 4) Topic/site en dernier : l'appareil se reconnecte sous ses nouveaux topics et republie sa découverte.
    const topicChanged = device.cfg.t !== topic || device.cfg.ft !== fullTopic;
    const expectDiscovery = new Promise<TasmotaDiscoveryConfig | undefined>((resolve) => {
      const waiter: Waiter = {
        mac,
        match: (suffix, body) => {
          const c = body as TasmotaDiscoveryConfig;
          return suffix === 'discovery' && c.dn === deviceName && c.t === topic && c.ft === fullTopic ? c : undefined;
        },
        resolve: (v) => resolve(v as TasmotaDiscoveryConfig | undefined),
        // Tasmota republie sa découverte ~20 s après la reconnexion (mesuré le 29/09/2026) : 60 s.
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(undefined);
        }, 60_000)
      };
      this.waiters.push(waiter);
    });
    if (topicChanged) {
      this.log(`Topics : FullTopic ${fullTopic}, Topic ${topic}, Hostname ${hostname} (reconnexion MQTT, découverte attendue sous ~20 s)`, 'info', mac);
      this.command(device, 'Backlog', `Hostname ${hostname}; FullTopic ${fullTopic}; Topic ${topic}`);
      // Nouveaux topics pris tout de suite (sans attendre la découverte) : la relecture de la fiche
      // interrogeait sinon l'ancien topic et échouait (constaté le 29/09/2026).
      device.cfg = { ...device.cfg, t: topic, ft: fullTopic, hn: hostname };
      device.topics = deviceTopics(device.cfg);
      if (this.connected) this.subscribeDevice(device);
    } else if (device.cfg.dn !== deviceName) {
      // Le nom seul ne republie pas forcément la découverte : un redémarrage la force.
      this.log('Redémarrage pour republier la découverte sous le nouveau nom', 'info', mac);
      this.command(device, 'Restart', '1');
    }
    const confirmed = !topicChanged && device.cfg.dn === deviceName ? device.cfg : await expectDiscovery;
    if (!confirmed) {
      this.log('⚠️ Découverte non reçue avec les nouveaux réglages dans les 60 s : relire la fiche pour vérifier', 'error', mac);
    } else {
      this.log(`Vérifié : nom « ${confirmed.dn} », topics ${deviceTopics(confirmed).cmnd}…`, 'ok', mac);
    }
    await this.readDevice(mac).catch(() => undefined);
  }

  /** Résout true au prochain LWT Online après un Offline (ou nouvelle découverte), false au délai. */
  private waitOnline(device: DeviceRecord, timeoutMs: number): Promise<boolean> {
    let wentOffline = false;
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        mac: device.mac,
        match: (suffix, _body, raw) => {
          if (suffix === 'tele:LWT' && raw.trim() === 'Offline') wentOffline = true;
          if ((suffix === 'tele:LWT' && raw.trim() === 'Online' && wentOffline) || suffix === 'discovery') return true;
          return undefined;
        },
        resolve: (v) => resolve(!!v),
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(false);
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  private async deviceAction(mac: string, action: string): Promise<void> {
    const device = this.requireDevice(mac);
    switch (action) {
      case 'identify':
        if (analyseRelays(device.cfg).shutters.length) throw new Error('Identifier est refusé sur un volet (mouvement du moteur)');
        this.command(device, 'Backlog', 'BlinkCount 3; BlinkTime 5; Power1 Blink');
        this.log(`${this.label(device)} : le relais va clignoter 3 fois`, 'ok', device.mac);
        return;
      case 'upgrade': {
        const reply = await this.query<unknown>(device, 'Upgrade 1', 8000);
        this.log(`${this.label(device)} : mise à jour lancée — ${JSON.stringify(reply ?? 'pas de réponse')}`, reply ? 'ok' : 'error', device.mac);
        return;
      }
      case 'reset': {
        const reply = await this.query<unknown>(device, 'Reset 1', 8000);
        this.log(`${this.label(device)} : remise d'usine — ${JSON.stringify(reply ?? 'pas de réponse')} ; l'appareil redevient neuf (point d'accès tasmota-…)`, reply ? 'ok' : 'error', device.mac);
        return;
      }
      case 'read':
        return this.readDevice(device.mac);
      default:
        throw new Error(`Action inconnue : ${action}`);
    }
  }

  private forgetDevice(mac: string): void {
    const device = this.requireDevice(mac);
    this.clearHa(device);
    this.publish(`tasmota/discovery/${device.mac}/config`, '', true);
    this.publish(`tasmota/discovery/${device.mac}/sensors`, '', true);
    this.devices.delete(device.mac);
    this.log(`${this.label(device)} oublié (réapparaît à son prochain redémarrage s'il est encore en service)`, 'ok', device.mac);
    this.scheduleEmit();
  }

  // ==========================================================================
  // Règles (§7.1)
  // ==========================================================================

  private async saveDeviceRules(mac: string, input: unknown): Promise<void> {
    const device = this.requireDevice(mac);
    const list = (Array.isArray(input) ? input : []).map((r) => ruleInstanceSchema.parse(r));
    const slots = new Set<number>();
    for (const rule of list) {
      if (slots.has(rule.slot)) throw new Error(`Emplacement Rule${rule.slot} utilisé deux fois`);
      slots.add(rule.slot);
      buildRuleText(rule.template, rule.params, rule.slot); // contrôle avant tout envoi
    }
    const previous = this.rules[device.mac] ?? [];
    for (const old of previous) {
      if (!slots.has(old.slot)) {
        this.command(device, `Rule${old.slot}`, '"');
        this.command(device, `Rule${old.slot}`, '0');
        this.log(`Rule${old.slot} effacée`, 'ok', device.mac);
      }
    }
    const results: string[] = [];
    for (const rule of list) {
      const ok = await this.writeRule(device, rule);
      results.push(`Rule${rule.slot} ${ok ? 'OK' : 'NON CONFORME'}`);
    }
    this.rules[device.mac] = list;
    if (!list.length) delete this.rules[device.mac];
    this.saveRules();
    this.log(`${this.label(device)} : règles enregistrées (${results.join(', ') || 'aucune'})`, results.some((r) => r.includes('NON')) ? 'error' : 'ok', device.mac);
    this.scheduleEmit();
  }

  /** Écrit le texte, fixe l'activation selon le mode, relit et compare. */
  private async writeRule(device: DeviceRecord, rule: RuleInstance): Promise<boolean> {
    const text = buildRuleText(rule.template, rule.params, rule.slot);
    const active = isRuleActive(rule, this.currentMode);
    this.log(`Rule${rule.slot} (${findTemplate(rule.template)?.label ?? rule.template}, ${active ? 'active' : 'inactive'}) : ${text}`, 'info', device.mac);
    // Une commande à la fois : sans attendre la réponse à l'écriture du texte, cette réponse (état
    // ANCIEN) était prise pour celle de l'activation → « NON conforme » au hasard (constaté le 28/09).
    const written = await this.commandAndWait<{ State?: string; Rules?: string }>(device, `Rule${rule.slot}`, text, this.resultKey(`Rule${rule.slot}`));
    if (!written) this.log(`Rule${rule.slot} : pas de réponse à l'écriture du texte`, 'error', device.mac);
    const state = await this.commandAndWait<{ State?: string; Rules?: string }>(device, `Rule${rule.slot}`, active ? '1' : '0', this.resultKey(`Rule${rule.slot}`));
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const ok = !!state && norm(state.Rules ?? '') === norm(text) && (state.State ?? '').toUpperCase() === (active ? 'ON' : 'OFF');
    this.log(`Rule${rule.slot} relue : ${state ? `${state.State}, ${(state.Rules ?? '').length} caractères` : 'pas de réponse'} — ${ok ? 'conforme' : 'NON conforme'}`, ok ? 'ok' : 'error', device.mac);
    return ok;
  }

  private async defineRuleFromRequest(req: RuleDefineRequest): Promise<{ accepted: boolean; reason?: string; slot?: number }> {
    const device = this.findDevice(String(req?.device ?? ''));
    if (!device) return { accepted: false, reason: `Appareil inconnu : ${req?.device}` };
    if (device.online === false) return { accepted: false, reason: `${this.label(device)} est hors ligne` };
    if (!findTemplate(String(req.template ?? ''))) return { accepted: false, reason: `Modèle de règle inconnu : ${req.template}` };
    const existing = this.rules[device.mac] ?? [];
    let slot = req.slot ? Number(req.slot) : undefined;
    if (slot === undefined) slot = [1, 2, 3].find((k) => !existing.some((r) => r.slot === k));
    if (!slot) return { accepted: false, reason: 'Plus d’emplacement libre (Rule1 à Rule3 occupées)' };
    if (slot < 1 || slot > 3) return { accepted: false, reason: 'Emplacement : 1 à 3' };
    let rule: RuleInstance;
    try {
      rule = ruleInstanceSchema.parse({ slot, template: req.template, params: req.params ?? {}, modes: req.modes ?? [], enabled: req.enabled ?? true });
      buildRuleText(rule.template, rule.params, rule.slot);
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const unknownModes = rule.modes.filter((m) => !this.config.modes.includes(m));
    if (unknownModes.length) return { accepted: false, reason: `Modes inconnus : ${unknownModes.join(', ')}` };
    const ok = await this.writeRule(device, rule);
    if (!ok) return { accepted: false, reason: 'Relecture non conforme (règle refusée ou appareil muet)', slot };
    this.rules[device.mac] = [...existing.filter((r) => r.slot !== slot), rule].sort((a, b) => a.slot - b.slot);
    this.saveRules();
    this.log(`Règle définie par ia sur ${this.label(device)} (Rule${slot})`, 'ok', device.mac);
    this.scheduleEmit();
    return { accepted: true, slot };
  }

  private getCatalog(): Record<string, unknown> {
    return {
      templates: describeTemplates(),
      modes: this.config.modes,
      currentMode: this.currentMode,
      devices: [...this.devices.values()].map((d) => {
        const used = (this.rules[d.mac] ?? []).map((r) => r.slot);
        return {
          mac: d.mac,
          name: d.cfg.dn,
          online: d.online,
          relays: analyseRelays(d.cfg).relays.map((r) => r.index + 1),
          shutters: analyseRelays(d.cfg).shutters.map((s) => s.number),
          sensors: analyseSensors(d.sn).map((s) => `${s.group}#${s.measure}`),
          freeSlots: [1, 2, 3].filter((k) => !used.includes(k))
        };
      })
    };
  }

  // ==========================================================================
  // Configuration (§9)
  // ==========================================================================

  private saveConfig(input: unknown): void {
    const parsed = tasmotaConfigSchema.parse(input);
    const result = this.configProvider.savePartialConfig(parsed);
    if (!result.success) throw new Error(`Enregistrement impossible : ${result.error}`);
    this.reloadConfig();
    this.log('Paramètres enregistrés', 'ok');
  }

  // ==========================================================================
  // Mise en service d'un neuf (§6)
  // ==========================================================================

  private async refreshProvisionCheck(scan = false): Promise<void> {
    this.provisionCheck = await checkProvisioning();
    if (scan && this.provisionCheck.available && this.provisionCheck.wifiInterface) {
      try {
        this.accessPoints = await scanTasmotaAccessPoints(this.provisionCheck.wifiInterface);
        this.log(`Recherche Wi-Fi : ${this.accessPoints.length} point(s) d'accès Tasmota`, 'ok');
      } catch (error) {
        this.log(String(error instanceof Error ? error.message : error), 'error');
      }
    }
    this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.PROVISION_STATUS, {
      check: this.provisionCheck,
      accessPoints: this.accessPoints,
      running: this.provisioning
    });
  }

  private async startProvisioning(apSsid: string): Promise<void> {
    if (this.provisioning) throw new Error('Une mise en service est déjà en cours');
    if (!/^tasmota[-_]/i.test(apSsid)) throw new Error(`Point d'accès inattendu : « ${apSsid} »`);
    if (!this.config.wifi.ssid || !this.config.wifi.password) throw new Error('Renseigner le Wi-Fi (nom et mot de passe) dans les paramètres');
    this.provisioning = true;
    await this.refreshProvisionCheck();
    const log = (message: string, level: LogLevel = 'info'): void => this.log(message, level, 'provision');
    try {
      const { mac } = await provisionNewDevice(apSsid, {
        ssid: this.config.wifi.ssid,
        password: this.config.wifi.password,
        mqttHost: this.config.mqtt.host,
        mqttPort: this.config.mqtt.port
      }, log);
      log(`Attente de l'appareil sur le broker ${this.config.mqtt.host} (90 s au plus)…`);
      const seen = await this.waitForDevice(mac, 90_000);
      log(seen ? `✅ ${mac} en ligne sur le broker — à nommer dans la liste` : `⚠️ ${mac ?? 'appareil'} non vu sur le broker en 90 s (Wi-Fi ou mot de passe ?)`, seen ? 'ok' : 'error');
    } catch (error) {
      log(`Échec : ${error instanceof Error ? error.message : error}`, 'error');
    } finally {
      this.provisioning = false;
      this.accessPoints = this.accessPoints.filter((ap) => ap.ssid !== apSsid);
      await this.refreshProvisionCheck();
    }
  }

  private async waitForDevice(mac: string | undefined, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mac && this.devices.get(mac)?.online) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  // ==========================================================================
  // Recherche des Tasmota déjà connectés au réseau (§6bis) — distinct de la mise en service d'un
  // neuf ci-dessus (qui cherche un point d'accès Wi-Fi) : ici une requête HTTP active balaie le
  // sous-réseau à la recherche d'appareils déjà rejoints au réseau normal.
  // ==========================================================================

  private async scanNetwork(): Promise<void> {
    if (this.networkScanning) throw new Error('Une recherche est déjà en cours');
    this.networkScanning = true;
    this.emitNetworkStatus();
    const log = (message: string, level: LogLevel = 'info'): void => this.log(message, level, 'réseau');
    try {
      const all = await scanNetworkForTasmota(log);
      // Déjà connu par découverte MQTT (déjà visible dans la liste principale) : pas la peine de
      // le remontrer ici, la recherche sert à retrouver ce qui n'est PAS encore sous gestion.
      const known = new Set(this.devices.keys());
      this.networkFound = all.filter((d) => !known.has(d.mac));
    } catch (error) {
      log(String(error instanceof Error ? error.message : error), 'error');
    } finally {
      this.networkScanning = false;
      this.emitNetworkStatus();
    }
  }

  private async pointDeviceToBroker(ip: string): Promise<void> {
    const entry = this.networkFound.find((d) => d.ip === ip);
    if (!entry) throw new Error("Appareil non trouvé dans la dernière recherche — relancer la recherche");
    await pointToBroker(ip, this.config.mqtt.host, this.config.mqtt.port, (m, l) => this.log(m, l, entry.mac));
    // Retiré de la liste : il devrait apparaître dans la liste principale dès qu'il se sera
    // reconnecté et aura publié sa découverte (quelques secondes) — sinon relancer la recherche.
    this.networkFound = this.networkFound.filter((d) => d.ip !== ip);
    this.emitNetworkStatus();
  }

  private emitNetworkStatus(): void {
    this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.NETWORK_STATUS, {
      scanning: this.networkScanning,
      found: this.networkFound,
      ourMqttHost: this.config.mqtt.host,
      ourMqttPort: this.config.mqtt.port
    });
  }

  // ==========================================================================
  // État / journal
  // ==========================================================================

  private label(device: DeviceRecord): string {
    const dn = device.cfg.dn ?? device.mac;
    // Appareil à nommer : désigné par son topic (unique, ex. tasmota_77B62C), pas par « Tasmota ».
    return isConventionalName(dn) ? `« ${dn} »` : `${device.cfg.t} (« ${dn} »)`;
  }

  private log(message: string, level: LogLevel = 'info', scope?: string): void {
    const line = { at: new Date().toISOString(), level, scope, message };
    if (level === 'error') this.logger.warn('TasmotaService', message);
    else this.logger.info('TasmotaService', message);
    this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.LOG, line);
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitState();
    }, 300);
  }

  private catalogs(): { quoi: string[]; lieux: string[] } {
    if (!this.haBridge?.isAvailable()) return { quoi: [], lieux: [] };
    const quoi = new Set<string>();
    for (const entity of this.haBridge.getAllEntities()) {
      const t = entity.attributes?.attributs_taxonomie as { quoi?: string; virtuel?: boolean } | undefined;
      if (t?.quoi && !t.virtuel) quoi.add(t.quoi);
    }
    let lieux: string[] = [];
    try {
      lieux = this.haBridge.getLieuCatalog();
    } catch {
      lieux = [];
    }
    return { quoi: [...quoi].sort((a, b) => a.localeCompare(b, 'fr')), lieux };
  }

  private emitState(): void {
    const devices = [...this.devices.values()].map((d) => {
      const conventional = isConventionalName(d.cfg.dn);
      const t = conventional ? extractTaxonomy(d.cfg.dn as string) : undefined;
      const { relays, shutters } = analyseRelays(d.cfg);
      return {
        mac: d.mac,
        name: d.cfg.dn ?? '',
        conventional,
        quoi: t?.rawQuoi,
        lieu: t?.nomLieu,
        precis: t?.nomPrecis,
        ip: d.cfg.ip,
        model: d.cfg.md,
        version: d.cfg.sw,
        topic: d.cfg.t,
        site: /^%prefix%\/([^/%]+)\/%topic%\/?$/.exec(d.cfg.ft)?.[1] ?? '',
        online: d.online,
        relays: relays.length,
        shutters: shutters.length,
        sensors: analyseSensors(d.sn).map((s) => s.label),
        published: d.haTopics.size > 0,
        rules: this.rules[d.mac] ?? [],
        suggestedTopic: conventional ? suggestTopic(splitDeviceName(d.cfg.dn as string)) : slugify(d.cfg.t)
      };
    }).sort((a, b) => Number(a.conventional) - Number(b.conventional) || a.name.localeCompare(b.name, 'fr'));

    this.eventBus.emitGeneric(TASMOTA_SOCKET_EVENTS.STATE, {
      connected: this.connected,
      devices,
      config: this.config,
      modes: this.config.modes,
      currentMode: this.currentMode,
      templates: describeTemplates(),
      ruleMaxLength: RULE_MAX_LENGTH,
      deviceNameMax: DEVICE_NAME_MAX,
      models: ['ne pas changer', MODEL_R4],
      catalogs: this.catalogs(),
      provision: { check: this.provisionCheck, accessPoints: this.accessPoints, running: this.provisioning }
    });
  }
}

export interface ApplyRequest {
  mac: string;
  name?: Partial<NameParts>;
  topic?: string;
  site?: string;
  model?: string;
  magicSwitchPulse?: number | string | null;
  shutter?: { enabled: boolean; open?: number | string; close?: number | string; invert?: boolean };
}

export interface RuleDefineRequest {
  correlation_id: string;
  device: string;
  template: string;
  params?: Record<string, string | number>;
  slot?: number;
  modes?: string[];
  enabled?: boolean;
}
