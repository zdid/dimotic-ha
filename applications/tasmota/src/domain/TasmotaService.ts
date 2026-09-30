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
  listVoies,
  THERMOSTAT_ID,
  thermostatBase,
  buildHaDiscovery,
  relayHaTopics,
  attributesTopic,
  shutterStateTopic,
  powerSuffix,
  DEVICE_CLASSES,
  type TasmotaDiscoveryConfig,
  type DeviceTopics,
  type VoiesMap,
  type VoieConfig
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
  THERMOSTAT_SCRIPT,
  THERMOSTAT_VERSION,
  THERMOSTAT_SCRIPT_PATH,
  THERMOSTAT_CONFIG_PATH,
  AUTOEXEC_PATH,
  AUTOEXEC_TEXT,
  DIMOTIC_MARK,
  buildThermostatConfigJson,
  fileWriteCommands,
  byteLength,
  type ThermostatModuleConfig
} from './thermostat-berry';
import { buildThermostatRuleText, memBacklog, RULES_MAX_THERMOSTATS } from './thermostat-rules';
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
/** dimotic/tasmota/<MAC>/thermostat<n>/(etat|consigne/set|mode/set) — spec v1.4 §7bis.3. */
const THERMO_TOPIC_RE = /^dimotic\/tasmota\/([0-9A-Fa-f]{12})\/thermostat(\d+)\/(etat|consigne\/set|mode\/set)$/;
/** Consignes proposées à la création (°C) — les autres modes prennent 19. */
const DEFAULT_CONSIGNES: Record<string, number> = { 'présence': 19, confort: 21, 'éco': 17, absence: 15 };

/** Modèle officiel Sonoff Basic R4, GPIO5 = MagicSwitch. */
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
  /** ⭐ 29/09/2026 (spec v1.2 §3.4) — modèle (commande `Module`), puce (`Status 2`), contenu du
   *  modèle (`Gpio 255`, broches utilisées) et firmware au moment de la lecture. Stockés. */
  model?: string;
  hardware?: string;
  pins?: string[];
  modelFirmware?: string;
  /** ⭐ 30/09/2026 (spec v1.3 §4.1bis) — voies nommées : une voie = un appareil HA avec sa taxonomie. */
  voies?: VoiesMap;
  /** Moteur de thermostat disponible sur ce module (spec v1.4 §7bis.7). */
  engine?: 'berry' | 'regles' | 'aucun';
  engineReason?: string;
}

/** Ce qui est stocké par appareil dans data/tasmota/devices.yaml (spec v1.2 §3.4). */
interface StoredDevice {
  cfg: TasmotaDiscoveryConfig;
  sn?: Record<string, unknown>;
  lastSeen: string;
  model?: string;
  hardware?: string;
  pins?: string[];
  modelFirmware?: string;
  voies?: VoiesMap;
  engine?: 'berry' | 'regles' | 'aucun';
  engineReason?: string;
}

/** Mesure et relais suivis par l'application pour un thermostat à règles (ESP8266, §7bis.4). */
interface RulesRuntime {
  temperature?: number;
  measuredAt: number;
  heating?: boolean;
  sig?: string;
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
  private readonly devicesPath: string;
  private saveDevicesTimer?: NodeJS.Timeout;
  private readonly modelReading = new Set<string>();
  /** Dernier état reçu de chaque thermostat (`<MAC>:<n>`) — publié par le module (Berry) ou par nous (règles). */
  private readonly thermoStates = new Map<string, Record<string, unknown>>();
  private readonly rulesRuntime = new Map<string, RulesRuntime>();
  private thermoTimer?: NodeJS.Timeout;
  private readonly thermoBusy = new Set<string>();
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
    this.devicesPath = path.join(this.dataDir, 'devices.yaml');
    this.loadDevices();
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

  /**
   * ⭐ 29/09/2026 (spec v1.2 §3.4) — la liste des appareils est STOCKÉE : le broker repart vide à
   * chaque redémarrage (persistance désactivée, voulu), un Tasmota débranché ne se réannonce pas et
   * disparaissait donc de la liste (et de HA).
   */
  private loadDevices(): void {
    try {
      if (!fs.existsSync(this.devicesPath)) return;
      const stored = (yaml.load(fs.readFileSync(this.devicesPath, 'utf8')) ?? {}) as Record<string, StoredDevice>;
      for (const [mac, d] of Object.entries(stored)) this.adoptStored(mac, d);
      this.logger.info('TasmotaService', `${this.devices.size} appareil(s) relus de devices.yaml`);
    } catch (error) {
      this.logger.error('TasmotaService', `devices.yaml illisible, ignoré : ${error}`);
    }
  }

  /** Ajoute ou met à jour un appareil depuis sa forme stockée — jamais un appareil en ligne, dont
   *  l'annonce vivante fait foi. */
  private adoptStored(mac: string, d: StoredDevice): void {
    if (!d?.cfg || typeof d.cfg.t !== 'string' || typeof d.cfg.ft !== 'string') return;
    const existing = this.devices.get(mac);
    if (existing?.online) return;
    const cfg = { ...d.cfg, mac };
    const device: DeviceRecord = existing ?? { mac, cfg, topics: deviceTopics(cfg), lastSeen: d.lastSeen, haTopics: new Set() };
    Object.assign(device, { cfg, topics: deviceTopics(cfg), sn: d.sn, lastSeen: d.lastSeen, model: d.model, hardware: d.hardware, pins: d.pins, modelFirmware: d.modelFirmware, voies: d.voies, engine: d.engine, engineReason: d.engineReason });
    this.devices.set(mac, device);
    if (this.connected) {
      this.subscribeDevice(device);
      this.publishDevice(device);
    }
  }

  /** devices.yaml reçu d'une autre machine (diffusion) : ajouts et mises à jour adoptés, appareils
   *  oubliés là-bas retirés ici (sauf s'ils sont en ligne : ils se réannonceraient). */
  private mergeDevicesFile(origin: string): void {
    try {
      const stored = (yaml.load(fs.readFileSync(this.devicesPath, 'utf8')) ?? {}) as Record<string, StoredDevice>;
      for (const [mac, d] of Object.entries(stored)) this.adoptStored(mac, d);
      for (const device of [...this.devices.values()]) {
        if (stored[device.mac] || device.online) continue;
        this.clearHa(device);
        this.devices.delete(device.mac);
      }
      this.logger.info('TasmotaService', `devices.yaml reçu de ${origin} : ${this.devices.size} appareil(s)`);
      this.scheduleEmit();
    } catch (error) {
      this.logger.error('TasmotaService', `devices.yaml reçu illisible : ${error}`);
    }
  }

  private scheduleSaveDevices(): void {
    if (this.saveDevicesTimer) return;
    this.saveDevicesTimer = setTimeout(() => {
      this.saveDevicesTimer = undefined;
      this.saveDevices();
    }, 2000);
  }

  private saveDevices(): void {
    const out: Record<string, StoredDevice> = {};
    for (const d of [...this.devices.values()].sort((a, b) => a.mac.localeCompare(b.mac))) {
      out[d.mac] = { cfg: d.cfg, ...(d.sn ? { sn: d.sn } : {}), lastSeen: d.lastSeen,
        ...(d.model ? { model: d.model } : {}), ...(d.hardware ? { hardware: d.hardware } : {}),
        ...(d.pins ? { pins: d.pins } : {}), ...(d.modelFirmware ? { modelFirmware: d.modelFirmware } : {}),
        ...(d.voies && Object.keys(d.voies).length ? { voies: d.voies } : {}),
        ...(d.engine ? { engine: d.engine } : {}), ...(d.engineReason ? { engineReason: d.engineReason } : {}) };
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.devicesPath}.tmp`;
      fs.writeFileSync(tmp, yaml.dump(out));
      fs.renameSync(tmp, this.devicesPath);
    } catch (error) {
      this.logger.error('TasmotaService', `Enregistrement de devices.yaml impossible : ${error}`);
    }
  }

  /** Modèle, puce et contenu du modèle lus par MQTT — quand ils manquent ou que le firmware a changé. */
  private async readModel(device: DeviceRecord, force = false): Promise<void> {
    if (this.modelReading.has(device.mac)) return;
    if (!force && device.model && device.pins && device.modelFirmware === device.cfg.sw) {
      if (!device.engine) await this.detectEngine(device);
      return;
    }
    this.modelReading.add(device.mac);
    try {
      const mod = await this.query<Record<string, string>>(device, 'Module', 5000);
      const gpio = await this.commandAndWait<Record<string, Record<string, number>>>(device, 'Gpio', '255',
        (suffix, body) => suffix === 'RESULT' && body && typeof body === 'object' && Object.keys(body as object).some((k) => /^GPIO\d+$/.test(k))
          ? body as Record<string, Record<string, number>> : undefined, 5000);
      const fwr = await this.commandAndWait<Record<string, unknown>>(device, 'Status', '2',
        (suffix, body) => (suffix === 'STATUS2' || suffix === 'RESULT') && body && typeof body === 'object' && 'StatusFWR' in (body as object)
          ? (body as Record<string, Record<string, unknown>>).StatusFWR : undefined, 5000);
      if (!mod && !gpio && !fwr) return;
      if (mod && typeof mod === 'object') device.model = Object.values(mod)[0];
      if (gpio) device.pins = Object.entries(gpio).flatMap(([pin, role]) =>
        Object.entries(role ?? {}).filter(([, code]) => code !== 0).map(([name]) => `${pin} : ${name}`));
      if (fwr?.Hardware) device.hardware = String(fwr.Hardware);
      device.modelFirmware = device.cfg.sw;
      await this.detectEngine(device);
      this.logger.info('TasmotaService', `${this.label(device)} : modèle ${device.model ?? '?'} (${device.hardware ?? '?'}) — ${(device.pins ?? []).join(', ') || 'aucune broche'}`);
      this.scheduleSaveDevices();
      this.scheduleEmit();
    } finally {
      this.modelReading.delete(device.mac);
    }
  }

  /**
   * ⭐ 30/09/2026 (spec v1.4 §7bis.7) — quel moteur de thermostat ce module peut-il porter ? Berry + système
   * de fichiers (ESP32 standard) ; sinon les règles (ESP8266 standard) ; sinon aucun (firmware lite / minimal).
   */
  private async detectEngine(device: DeviceRecord): Promise<void> {
    const br = await this.commandAndWait<Record<string, unknown>>(device, 'Br', 'return 1+1',
      (suffix, body) => suffix === 'RESULT' && body && typeof body === 'object' && ('Br' in (body as object) || (body as { Command?: string }).Command === 'Unknown')
        ? body as Record<string, unknown> : undefined, 5000);
    if (!br) return; // pas de réponse (hors ligne) : on ne sait pas, on réessaiera
    let engine: DeviceRecord['engine'];
    let reason: string | undefined;
    if ('Br' in br) {
      const ufs = await this.query<number>(device, 'UfsType', 4000);
      if (typeof ufs === 'number' && ufs > 0) engine = 'berry';
      else { engine = 'aucun'; reason = 'Berry présent mais pas de système de fichiers'; }
    } else {
      const rule = await this.query<unknown>(device, 'Rule1', 4000);
      if (rule) engine = 'regles';
      else { engine = 'aucun'; reason = 'ni Berry ni règles (firmware « lite » ou « minimal » ?)'; }
    }
    if (device.engine !== engine || device.engineReason !== reason) {
      device.engine = engine;
      device.engineReason = reason;
      this.logger.info('TasmotaService', `${this.label(device)} : moteur de thermostat ${engine}${reason ? ` (${reason})` : ''}`);
      this.scheduleSaveDevices();
      this.scheduleEmit();
    }
  }

  async start(): Promise<void> {
    this.logger.info('TasmotaService', 'Démarrage');
    this.setupListeners();
    this.eventBus.emitGeneric('integration:bridge:register', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
    if (this.haBridge) {
      this.haBridge.start().then(() => this.scheduleEmit()).catch((error) => this.logger.warn('TasmotaService', `Référentiel HA indisponible : ${error}`));
    }
    void this.refreshProvisionCheck();
    this.thermoTimer = setInterval(() => this.checkRulesMute(), 60_000);
    this.scheduleEmit();
  }

  async stop(): Promise<void> {
    if (this.saveDevicesTimer) {
      clearTimeout(this.saveDevicesTimer);
      this.saveDevicesTimer = undefined;
      this.saveDevices();
    }
    for (const t of [this.emitTimer, this.modeSettleTimer]) if (t) clearTimeout(t);
    if (this.thermoTimer) clearInterval(this.thermoTimer);
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
      for (const topic of ['tasmota/discovery/+/config', 'tasmota/discovery/+/sensors', HA_STATUS_TOPIC, MODE_TOPIC, MODE_SET_TOPIC,
        'dimotic/tasmota/+/+/etat', 'dimotic/tasmota/+/+/consigne/set', 'dimotic/tasmota/+/+/mode/set']) {
        this.subscribe(topic);
      }
      // ⭐ 30/09/2026 (spec v1.4 §7bis.3) — le broker repart vide à chaque redémarrage : le mode courant
      // est republié (retenu) à chaque connexion, pour que les thermostats des modules le retrouvent.
      if (this.currentMode) this.publish(MODE_TOPIC, this.currentMode, true);
      // Broker peut-être reparti vide (persistance désactivée) : les entités HA des appareils connus
      // sont republiées à chaque connexion, y compris ceux qui sont débranchés (spec v1.2 §3.4).
      for (const device of this.devices.values()) {
        this.subscribeDevice(device);
        device.haSignature = undefined;
        this.publishDevice(device);
      }
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
      if (e?.app === MODULE_NAME && e.path === 'tasmota/devices.yaml') {
        this.mergeDevicesFile(e.origin);
        return;
      }
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
    on<{ mac: string; voies: unknown }>(TASMOTA_CLIENT_EVENTS.VOIES_SAVE, (d) => this.saveVoies(String(d?.mac ?? ''), d?.voies));
    on<{ mac: string; thermostats: unknown }>(TASMOTA_CLIENT_EVENTS.THERMOSTATS_SAVE, (d) => this.saveThermostats(String(d?.mac ?? ''), d?.thermostats));
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
    this.eventBus.onGeneric<ThermostatSetRequest>(TASMOTA_REQUEST_EVENTS.THERMOSTAT_SET, (req) => {
      this.thermostatSetFromRequest(req)
        .then((result) => this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.THERMOSTAT_SET}:reply`, { correlation_id: req?.correlation_id, ...result }))
        .catch((error) => this.eventBus.emitGeneric(`${TASMOTA_REQUEST_EVENTS.THERMOSTAT_SET}:reply`, { correlation_id: req?.correlation_id, accepted: false, reason: String(error instanceof Error ? error.message : error) }));
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
    const thermo = THERMO_TOPIC_RE.exec(topic);
    if (thermo) {
      void this.onThermostatTopic(thermo[1].toUpperCase(), Number(thermo[2]), thermo[3], raw).catch((e) => this.logger.warn('TasmotaService', `Thermostat ${topic} : ${e}`));
      return;
    }
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
      if (cameOnline) {
        void this.enforceModeOnDevice(device, 'retour en ligne');
        void this.enforceThermostats(device, 'retour en ligne');
        void this.readModel(device);
      }
      this.scheduleEmit();
    } else if (body && typeof body === 'object') {
      this.relayShutterState(device, body as Record<string, unknown>, suffix);
    }
    this.trackRulesThermostats(device, suffix, fromTele, body, raw);
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
        this.scheduleSaveDevices();
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
    this.scheduleSaveDevices();
    if (this.connected) this.subscribeDevice(device);
    if (!existing) this.logger.info('TasmotaService', `Appareil ${mac} « ${cfg.dn ?? '?'} » (${cfg.ip ?? '?'})`);
    // L'annonce arrive à la connexion de l'appareil : il est joignable, modèle lu si besoin.
    setTimeout(() => void this.readModel(device), 3000);
    // Sous gestion par découverte MQTT désormais : plus la peine de le montrer comme « trouvé sur
    // le réseau » (§6bis).
    if (this.networkFound.some((d) => d.mac === mac && !d.known)) {
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
      this.scheduleSaveDevices();
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
    const built = buildHaDiscovery(device.cfg, device.sn, device.voies);
    if (!built) {
      if (device.haTopics.size) {
        this.logger.info('TasmotaService', `${device.mac} n'est plus nommé selon la convention (ni aucune voie) : retiré de HA`);
        this.clearHa(device);
      }
      device.haSignature = undefined;
      return;
    }
    const signature = JSON.stringify(built);
    if (signature === device.haSignature) return;
    device.haSignature = signature;

    const newTopics = new Set([...built.entities.map((e) => e.haTopic), ...built.attributes.map((a) => a.topic)]);
    // Ancien composant d'un relais (switch ↔ light) et entités disparues : effacés.
    const stale = new Set<string>(device.haTopics);
    for (const relay of analyseRelays(device.cfg).relays) for (const t of relayHaTopics(device.mac, relay.index)) stale.add(t);
    for (const topic of stale) if (!newTopics.has(topic)) this.publish(topic, '', true);

    for (const a of built.attributes) this.publish(a.topic, a.payload, true);
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
    for (const device of this.devices.values()) {
      void this.enforceModeOnDevice(device, `mode ${mode}`);
      void this.enforceThermostats(device, `mode ${mode}`);
    }
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
        // ⭐ 30/09/2026 : l'argument va dans le PAYLOAD — « Upgrade 1 » comme nom de topic n'était pas compris du module.
        const reply = await this.commandAndWait<unknown>(device, 'Upgrade', '1', this.resultKey('Upgrade'), 8000);
        this.log(`${this.label(device)} : mise à jour lancée — ${JSON.stringify(reply ?? 'pas de réponse')}`, reply ? 'ok' : 'error', device.mac);
        return;
      }
      case 'reset': {
        // ⭐ 30/09/2026 : les fichiers déposés sont effacés AVANT (Tasmota conserve le système de fichiers) et la
        // remise d'usine est refusée s'ils ne peuvent pas l'être ; l'état local n'est nettoyé qu'une fois
        // la remise d'usine confirmée par le module. L'argument va dans le payload (le nom de topic
        // « Reset 1 » n'était pas compris du module : la commande n'a jamais fonctionné avant ce jour).
        await this.eraseModuleFiles(device);
        const reply = await this.commandAndWait<unknown>(device, 'Reset', '1', this.resultKey('Reset'), 8000);
        if (reply === undefined) throw new Error(`${this.label(device)} : pas de réponse à « Reset 1 » — remise d'usine non confirmée (le module est-il en ligne ?)`);
        this.dropThermostats(device);
        this.log(`${this.label(device)} : remise d'usine — ${JSON.stringify(reply)} ; l'appareil redevient neuf (point d'accès tasmota-…)`, 'ok', device.mac);
        return;
      }
      case 'read':
        return this.readDevice(device.mac);
      default:
        throw new Error(`Action inconnue : ${action}`);
    }
  }

  /**
   * ⭐ 30/09/2026 (spec v1.3 §4.1bis) — enregistre les voies d'un appareil : chaque voie nommée devient son
   * propre appareil HA (QUOI et lieu de la voie). L'entrée est le remplacement COMPLET des voies : une
   * voie absente ou entièrement vidée n'a plus de nom (elle hérite du module, comme avant).
   */
  private async saveVoies(mac: string, input: unknown): Promise<void> {
    const device = this.requireDevice(mac);
    const known = new Map(listVoies(device.cfg, device.sn).map((v) => [v.id, v]));
    // Les thermostats se règlent ailleurs (saveThermostats) : leurs entrées sont conservées telles quelles.
    const next: VoiesMap = {};
    for (const [id, config] of Object.entries(device.voies ?? {})) if (THERMOSTAT_ID.test(id)) next[id] = config;
    const rows = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown>>;
    for (const [id, raw] of Object.entries(rows)) {
      const voie = known.get(id);
      if (!voie) throw new Error(`Voie inconnue : ${id}`);
      const text = (k: string): string => String(raw?.[k] ?? '').trim();
      const parts: NameParts = { quoi: text('quoi'), precis: text('precis'), lieu: text('lieu'), pere: text('pere'), grandPere: text('grandPere') };
      const config: NonNullable<VoiesMap[string]> = {};
      if (parts.quoi || parts.precis || parts.lieu || parts.pere || parts.grandPere) {
        if (!parts.quoi || !parts.lieu) throw new Error(`${voie.label} : le QUOI et le lieu sont obligatoires (ou tout vider pour reprendre le nom du module)`);
        const nom = composeDeviceName(parts);
        if (nom.length > DEVICE_NAME_MAX) throw new Error(`${voie.label} : nom trop long (${nom.length} > ${DEVICE_NAME_MAX} caractères) : ${nom}`);
        config.nom = nom;
      }
      if (!voie.known) {
        const deviceClass = text('deviceClass');
        if (deviceClass && !(DEVICE_CLASSES as readonly string[]).includes(deviceClass)) throw new Error(`${voie.label} : type inconnu « ${deviceClass} »`);
        const unit = text('unit');
        if (unit.length > 12) throw new Error(`${voie.label} : unité trop longue`);
        if (deviceClass) config.deviceClass = deviceClass;
        if (unit) config.unit = unit;
      }
      if (config.nom || config.deviceClass || config.unit) next[id] = config;
    }
    device.voies = Object.keys(next).length ? next : undefined;
    device.haSignature = undefined;
    this.publishDevice(device);
    this.scheduleSaveDevices();
    this.scheduleEmit();
    const named = Object.values(next).filter((v) => v.nom).length;
    this.log(`${this.label(device)} : ${named} voie(s) nommée(s) sur ${known.size}`, 'ok', device.mac);
  }

  private forgetDevice(mac: string): void {
    const device = this.requireDevice(mac);
    this.clearHa(device);
    this.publish(`tasmota/discovery/${device.mac}/config`, '', true);
    this.publish(`tasmota/discovery/${device.mac}/sensors`, '', true);
    this.devices.delete(device.mac);
    this.scheduleSaveDevices();
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
          freeSlots: [1, 2, 3].filter((k) => !used.includes(k)),
          thermostats: this.thermostatKeys(d).map((id) => {
            const st = this.thermoStates.get(`${d.mac}:${this.numberOf(id)}`);
            return { thermostat: this.numberOf(id), name: d.voies![id].nom, consigne: st?.consigne, mode: st?.mode, action: st?.action, defaut: st?.defaut };
          })
        };
      })
    };
  }

  // ==========================================================================
  // Thermostats (spec v1.4 §7bis)
  // ==========================================================================

  private thermostatKeys(device: DeviceRecord): string[] {
    return Object.entries(device.voies ?? {}).filter(([id, c]) => THERMOSTAT_ID.test(id) && c.relais).map(([id]) => id);
  }

  private numberOf(id: string): number {
    return Number(THERMOSTAT_ID.exec(id)?.[1] ?? 0);
  }

  private currentModeName(): string {
    return this.currentMode ?? this.config.modes[0];
  }

  /** Valeur de la clé `Br` renvoyée par le module. */
  private brCommand(device: DeviceRecord, code: string, timeoutMs = 8000): Promise<unknown> {
    return this.commandAndWait<unknown>(device, 'Br', code, this.resultKey('Br'), timeoutMs);
  }

  /**
   * Enregistre les thermostats d'un module : contrôle, dépôt sur le module (Berry : fichiers ; règles :
   * règle et mémoires), puis publication. L'entrée remplace TOUS les thermostats du module ; une entrée
   * vide supprime le thermostat. En cas d'échec du dépôt, l'ancien état est rétabli.
   */
  private async saveThermostats(mac: string, input: unknown): Promise<void> {
    const device = this.requireDevice(mac);
    if (this.thermoBusy.has(device.mac)) throw new Error(`${this.label(device)} : un dépôt de thermostat est déjà en cours`);
    this.thermoBusy.add(device.mac);
    const before = device.voies ? JSON.parse(JSON.stringify(device.voies)) as VoiesMap : undefined;
    try {
      if (!device.engine) await this.detectEngine(device);
      if (device.engine !== 'berry' && device.engine !== 'regles') {
        throw new Error(`Thermostat indisponible : ${device.engineReason ?? 'moteur non détecté (module hors ligne ?)'}`);
      }
      const rows = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown> | null>;
      const infos = listVoies(device.cfg, device.sn, device.voies);
      const relays = new Set(analyseRelays(device.cfg).relays.map((r) => r.index + 1));
      const temperatureSensors = new Set(analyseSensors(device.sn).filter((x) => x.measure === 'Temperature').map((x) => x.voieId));
      const next: VoiesMap = {};
      for (const [id, config] of Object.entries(device.voies ?? {})) if (!THERMOSTAT_ID.test(id)) next[id] = config;
      const usedRelays = new Set<number>();
      let count = 0;
      for (const [id, raw] of Object.entries(rows)) {
        if (!raw) continue;
        if (!THERMOSTAT_ID.test(id) || this.numberOf(id) < 1) throw new Error(`Thermostat inconnu : ${id}`);
        const label = `Thermostat ${this.numberOf(id)}`;
        const text = (k: string): string => String(raw[k] ?? '').trim();
        const parts: NameParts = { quoi: text('quoi') || 'thermostat', precis: text('precis'), lieu: text('lieu'), pere: text('pere'), grandPere: text('grandPere') };
        if (!parts.lieu) throw new Error(`${label} : le lieu est obligatoire`);
        const nom = composeDeviceName(parts);
        if (nom.length > DEVICE_NAME_MAX) throw new Error(`${label} : nom trop long (${nom.length} > ${DEVICE_NAME_MAX} caractères)`);
        const relais = Number(raw.relais);
        if (!relays.has(relais)) throw new Error(`${label} : relais ${raw.relais} inexistant sur ce module`);
        if (usedRelays.has(relais)) throw new Error(`${label} : le relais ${relais} est déjà utilisé par un autre thermostat`);
        usedRelays.add(relais);
        const capteur = text('capteur');
        if (!temperatureSensors.has(capteur)) throw new Error(`${label} : capteur de température inconnu (${capteur || 'vide'})`);
        const number = (key: string, def: number, min: number, max: number, unit: string): number => {
          const v = raw[key] === undefined || raw[key] === '' || raw[key] === null ? def : Number(raw[key]);
          if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label} : ${key} entre ${min} et ${max} ${unit}`);
          return v;
        };
        const consignes: Record<string, number> = {};
        for (const mode of this.config.modes) {
          const given = (raw.consignes as Record<string, unknown> | undefined)?.[mode];
          const v = given === undefined || given === '' ? (DEFAULT_CONSIGNES[mode] ?? 19) : Number(given);
          if (!Number.isFinite(v) || v < 5 || v > 30) throw new Error(`${label} : consigne « ${mode} » entre 5 et 30 °C`);
          consignes[mode] = v;
        }
        next[id] = {
          nom, relais, capteur, consignes,
          hysteresis: number('hysteresis', 0.5, 0.1, 10, '°C'),
          minOn: number('minOn', 180, 0, 3600, 's'),
          minOff: number('minOff', 180, 0, 3600, 's'),
          capteurMuet: number('capteurMuet', 1800, 300, 86400, 's')
        };
        count++;
      }
      if (device.engine === 'regles' && count > RULES_MAX_THERMOSTATS) throw new Error(`Ce module (ESP8266, règles) porte ${RULES_MAX_THERMOSTATS} thermostats au plus`);
      void infos;
      const removed = this.thermostatKeys(device).filter((id) => !next[id]);
      device.voies = Object.keys(next).length ? next : undefined;
      if (device.engine === 'berry') await this.deployBerry(device);
      else await this.deployRules(device, removed);
      for (const id of removed) this.publish(`${thermostatBase(device.mac, this.numberOf(id))}/etat`, '', true);
      device.haSignature = undefined;
      this.publishDevice(device);
      this.scheduleSaveDevices();
      this.scheduleEmit();
      this.log(`${this.label(device)} : ${count} thermostat(s) enregistré(s) (${device.engine === 'berry' ? 'Berry' : 'règles'})`, 'ok', device.mac);
    } catch (error) {
      device.voies = before;
      device.haSignature = undefined;
      this.publishDevice(device);
      throw error;
    } finally {
      this.thermoBusy.delete(device.mac);
    }
  }

  /** Configuration de chaque thermostat telle que le module Berry la reçoit. */
  private moduleConfigs(device: DeviceRecord): ThermostatModuleConfig[] {
    const sensors = analyseSensors(device.sn);
    const out: ThermostatModuleConfig[] = [];
    for (const id of this.thermostatKeys(device)) {
      const c = device.voies![id];
      const sensor = sensors.find((x) => x.voieId === c.capteur);
      if (!sensor) continue;
      const n = this.numberOf(id);
      out.push({
        n, base: thermostatBase(device.mac, n), relais: c.relais as number, group: sensor.group, id: sensor.sensorId ?? '', measure: sensor.measure,
        hysteresis: c.hysteresis ?? 0.5, consignes: c.consignes ?? {}, minOn: c.minOn ?? 180, minOff: c.minOff ?? 180,
        capteurMuet: c.capteurMuet ?? 1800, modeDefaut: this.config.modes[0]
      });
    }
    return out;
  }

  /** Écrit un fichier sur le module (par morceaux) et contrôle sa taille. */
  private async writeModuleFile(device: DeviceRecord, path: string, content: string): Promise<void> {
    for (const code of fileWriteCommands(path, content)) {
      if (await this.brCommand(device, code) === undefined) throw new Error(`Écriture de ${path} : pas de réponse du module`);
    }
    const size = await this.brCommand(device, `var f=open('${path}','r'); var n=f.size(); f.close(); return n`);
    if (Number(size) !== byteLength(content)) throw new Error(`${path} : ${size} octets dans le module, ${byteLength(content)} attendus`);
  }

  /** Version du moteur en marche sur le module, d'après les états reçus (y compris ceux de thermostats qu'on vient de retirer). */
  private runningVersion(device: DeviceRecord): number | undefined {
    for (const [key, state] of this.thermoStates) {
      if (key.startsWith(`${device.mac}:`) && typeof state.version === 'number') return state.version;
    }
    return undefined;
  }

  /** Dépôt Berry : programme + autoexec (si absent ou périmé), configuration, puis activation. */
  private async deployBerry(device: DeviceRecord): Promise<void> {
    const mac = device.mac;
    const log = (m: string, level: LogLevel = 'info'): void => this.log(m, level, mac);
    const running = this.runningVersion(device);
    // Rien à retirer d'un module où le moteur n'a jamais été déposé.
    if (running === undefined && this.moduleConfigs(device).length === 0) return;
    const needScript = running !== THERMOSTAT_VERSION;
    if (needScript) {
      // Un autoexec.be qui n'est pas le nôtre appartient à l'utilisateur : jamais écrasé.
      if (String(await this.brCommand(device, "import path; return path.exists('/autoexec.be')")) === 'true') {
        const current = String(await this.brCommand(device, "var f=open('/autoexec.be','r'); var s=f.read(); f.close(); return s") ?? '');
        if (!current.includes(DIMOTIC_MARK)) {
          throw new Error(`${AUTOEXEC_PATH} existe déjà sur le module et n'est pas géré par dimotic-ha : y ajouter à la main la ligne tasmota.load('${THERMOSTAT_SCRIPT_PATH}')`);
        }
      }
      log(`Dépôt du moteur de thermostat (version ${THERMOSTAT_VERSION}, ${byteLength(THERMOSTAT_SCRIPT)} octets)…`);
      await this.writeModuleFile(device, THERMOSTAT_SCRIPT_PATH, THERMOSTAT_SCRIPT);
      await this.writeModuleFile(device, AUTOEXEC_PATH, AUTOEXEC_TEXT);
    }
    await this.writeModuleFile(device, THERMOSTAT_CONFIG_PATH, buildThermostatConfigJson(this.moduleConfigs(device)));
    if (!needScript) {
      const ok = await this.brCommand(device, 'import global; return global.dimotic_thermo.load_config(true)');
      if (String(ok) !== 'true') throw new Error(`Rechargement de la configuration refusé par le module (${ok})`);
      log('Configuration rechargée sans redémarrage', 'ok');
    } else if (running !== undefined) {
      // Ancienne version en marche : redémarrage pour repartir proprement (abonnements, minuteries).
      log('Nouvelle version du moteur : redémarrage du module…');
      const back = this.waitOnline(device, 90_000);
      this.command(device, 'Restart', '1');
      if (!(await back)) throw new Error('Pas de retour en ligne après le redémarrage (90 s)');
    } else {
      const loaded = await this.brCommand(device, `return tasmota.load('${THERMOSTAT_SCRIPT_PATH}')`);
      if (String(loaded) !== 'true') throw new Error(`Chargement du moteur refusé par le module (${loaded}) : voir la console du module`);
    }
    // Contrôle : le module publie son état (version comprise).
    const deadline = Date.now() + 25_000;
    const wanted = this.thermostatKeys(device).map((id) => `${mac}:${this.numberOf(id)}`);
    while (Date.now() < deadline) {
      if (wanted.every((k) => this.thermoStates.get(k)?.version === THERMOSTAT_VERSION)) {
        log('Moteur actif : état reçu du module', 'ok');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    log('⚠️ Pas d’état reçu du module en 25 s : vérifier la connexion MQTT du module', 'error');
  }

  // ---- moteur à règles (ESP8266, §7bis.4) ------------------------------------------------------------

  private freeRuleSlot(device: DeviceRecord, id: string): number {
    const used = new Set<number>((this.rules[device.mac] ?? []).map((r) => r.slot));
    for (const other of this.thermostatKeys(device)) if (other !== id && device.voies![other].regleSlot) used.add(device.voies![other].regleSlot as number);
    const own = device.voies?.[id]?.regleSlot;
    if (own && !used.has(own)) return own;
    const slot = [1, 2, 3].find((k) => !used.has(k));
    if (!slot) throw new Error('Plus d’emplacement de règle libre (Rule1 à Rule3 occupées)');
    return slot;
  }

  private async deployRules(device: DeviceRecord, removed: string[]): Promise<void> {
    for (const id of removed) {
      const old = this.lastRuleSlot.get(`${device.mac}:${id}`);
      if (old) {
        this.command(device, `Rule${old}`, '"');
        this.command(device, `Rule${old}`, '0');
        this.lastRuleSlot.delete(`${device.mac}:${id}`);
      }
      this.rulesRuntime.delete(`${device.mac}:${this.numberOf(id)}`);
      this.thermoStates.delete(`${device.mac}:${this.numberOf(id)}`);
    }
    const sensors = analyseSensors(device.sn);
    for (const id of this.thermostatKeys(device)) {
      const c = device.voies![id];
      const sensor = sensors.find((x) => x.voieId === c.capteur)!;
      c.regleSlot = this.freeRuleSlot(device, id);
      const text = buildThermostatRuleText({ n: this.numberOf(id), relais: c.relais as number, group: sensor.group, measure: sensor.measure, capteurMuet: c.capteurMuet ?? 1800 });
      this.log(`Rule${c.regleSlot} (thermostat ${this.numberOf(id)}) : ${text}`, 'info', device.mac);
      const written = await this.commandAndWait<{ Rules?: string }>(device, `Rule${c.regleSlot}`, text, this.resultKey(`Rule${c.regleSlot}`));
      const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!written || norm(written.Rules ?? '') !== norm(text)) throw new Error(`Rule${c.regleSlot} : relecture non conforme (règle refusée ou module muet)`);
      this.lastRuleSlot.set(`${device.mac}:${id}`, c.regleSlot);
    }
    await this.enforceThermostats(device, 'enregistrement');
  }

  /** Mémoires (seuils), activation de la règle et état HA, selon le mode de la maison et le mode du thermostat. */
  private async enforceThermostats(device: DeviceRecord, why: string): Promise<void> {
    if (device.engine !== 'regles' || device.online === false) return;
    for (const id of this.thermostatKeys(device)) {
      const c = device.voies![id];
      if (!c.regleSlot) continue;
      const n = this.numberOf(id);
      if (c.arret) {
        this.command(device, `Rule${c.regleSlot}`, '0');
        this.command(device, `Power${c.relais}`, '0');
      } else {
        const goal = c.consignes?.[this.currentModeName()] ?? 19;
        this.command(device, 'Backlog', memBacklog(n, goal, c.hysteresis ?? 0.5).replace(/^Backlog /, ''));
        this.command(device, `Rule${c.regleSlot}`, '1');
      }
      this.publishRulesState(device, id);
    }
    this.logger.info('TasmotaService', `${device.mac} : thermostats à règles remis en conformité (${why})`);
  }

  private readonly lastRuleSlot = new Map<string, number>();

  /** Mesure et relais suivis pour publier l'état des thermostats à règles. */
  private trackRulesThermostats(device: DeviceRecord, suffix: string, fromTele: boolean, body: unknown, raw: string): void {
    if (device.engine !== 'regles') return;
    const ids = this.thermostatKeys(device);
    if (!ids.length) return;
    const power = !fromTele ? /^POWER(\d*)$/.exec(suffix) : null;
    for (const id of ids) {
      const c = device.voies![id];
      const key = `${device.mac}:${this.numberOf(id)}`;
      const run = this.rulesRuntime.get(key) ?? { measuredAt: Date.now() };
      let changed = false;
      if (fromTele && suffix === 'SENSOR' && body && typeof body === 'object') {
        const sensor = analyseSensors(body as Record<string, unknown>).find((x) => x.voieId === c.capteur);
        const value = sensor ? ((body as Record<string, Record<string, unknown>>)[sensor.group]?.[sensor.measure]) : undefined;
        if (typeof value === 'number' && value > -30 && value < 90 && value !== 85) {
          run.temperature = value;
          run.measuredAt = Date.now();
          changed = true;
        }
      }
      if (power && (power[1] ? Number(power[1]) : 1) === c.relais) {
        run.heating = raw.trim().toUpperCase() === 'ON';
        changed = true;
      }
      this.rulesRuntime.set(key, run);
      if (changed) this.publishRulesState(device, id);
    }
  }

  private publishRulesState(device: DeviceRecord, id: string): void {
    const c = device.voies?.[id];
    if (!c) return;
    const n = this.numberOf(id);
    const key = `${device.mac}:${n}`;
    const run = this.rulesRuntime.get(key) ?? { measuredAt: Date.now() };
    const mode = this.currentModeName();
    const silent = Date.now() - run.measuredAt > (c.capteurMuet ?? 1800) * 1000;
    const state: Record<string, unknown> = {
      moteur: 'regles',
      temperature: run.temperature ?? null,
      consigne: c.consignes?.[mode] ?? 19,
      consignes: c.consignes ?? {},
      mode: c.arret ? 'off' : 'heat',
      mode_maison: mode,
      action: c.arret || silent ? 'off' : run.heating ? 'heating' : 'idle'
    };
    if (silent && !c.arret) state.defaut = 'capteur_muet';
    const sig = JSON.stringify(state);
    if (sig === run.sig) return;
    run.sig = sig;
    this.rulesRuntime.set(key, run);
    this.thermoStates.set(key, state);
    this.publish(`${thermostatBase(device.mac, n)}/etat`, state, true);
    this.scheduleEmit();
  }

  private checkRulesMute(): void {
    for (const device of this.devices.values()) {
      if (device.engine !== 'regles') continue;
      for (const id of this.thermostatKeys(device)) this.publishRulesState(device, id);
    }
  }

  /** Commandes de HA pour un thermostat à règles (le module Berry, lui, les reçoit directement). */
  private async onThermostatTopic(mac: string, n: number, kind: string, raw: string): Promise<void> {
    const device = this.devices.get(mac);
    if (!device) return;
    const id = `thermostat${n}`;
    const key = `${mac}:${n}`;
    if (kind === 'etat') {
      if (!raw.trim()) {
        this.thermoStates.delete(key);
        this.scheduleEmit();
        return;
      }
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(raw);
      } catch {
        return;
      }
      if (state.moteur === 'regles') return; // notre propre republication
      this.thermoStates.set(key, state);
      // Consignes réglées depuis HA : la configuration enregistrée suit le module (source de vérité).
      const c = device.voies?.[id];
      if (c && state.consignes && typeof state.consignes === 'object') {
        const next = state.consignes as Record<string, number>;
        if (JSON.stringify(next) !== JSON.stringify(c.consignes ?? {})) {
          c.consignes = next;
          this.scheduleSaveDevices();
        }
      }
      this.scheduleEmit();
      return;
    }
    if (device.engine !== 'regles') return;
    const c = device.voies?.[id];
    if (!c) return;
    if (kind === 'consigne/set') {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 5 || value > 30) {
        this.logger.warn('TasmotaService', `${mac} thermostat ${n} : consigne refusée (${raw})`);
        return;
      }
      c.consignes = { ...(c.consignes ?? {}), [this.currentModeName()]: value };
      this.scheduleSaveDevices();
    } else {
      const mode = raw.trim();
      if (mode !== 'heat' && mode !== 'off') return;
      c.arret = mode === 'off';
      this.scheduleSaveDevices();
    }
    await this.enforceThermostats(device, `commande HA (${kind})`);
  }

  /** Remise d'usine, 1re étape : efface les fichiers déposés sur le module (Berry). Lève une erreur si l'un d'eux ne s'efface pas. */
  private async eraseModuleFiles(device: DeviceRecord): Promise<void> {
    if (device.engine !== 'berry') return;
    const exists = async (path: string): Promise<boolean> => String(await this.brCommand(device, `import path; return path.exists('${path}')`)) === 'true';
    const paths = [THERMOSTAT_SCRIPT_PATH, THERMOSTAT_CONFIG_PATH];
    if (await exists(AUTOEXEC_PATH)) {
      const current = String(await this.brCommand(device, `var f=open('${AUTOEXEC_PATH}','r'); var s=f.read(); f.close(); return s`) ?? '');
      if (current.includes(DIMOTIC_MARK)) paths.push(AUTOEXEC_PATH);
      else this.log(`${AUTOEXEC_PATH} n'est pas géré par dimotic-ha : conservé`, 'info', device.mac);
    }
    // La mémoire persistante de Berry (clé `dt` : mode, consignes réglées depuis HA) survit aussi à la remise d'usine.
    await this.brCommand(device, "import persist; persist.remove('dt'); persist.save(); return 'ok'");
    for (const path of paths) {
      if (!(await exists(path))) continue;
      const reply = await this.commandAndWait<string>(device, 'UfsDelete', path, this.resultKey('UfsDelete'), 5000);
      if (reply !== 'Done') throw new Error(`${path} : effacement impossible (${reply ?? 'pas de réponse'}) — remise d'usine annulée pour ne pas laisser un thermostat orphelin`);
      this.log(`${path} effacé`, 'ok', device.mac);
    }
  }

  /** Remise d'usine, 2e étape (confirmée) : les thermostats du module disparaissent de la liste et de HA. */
  private dropThermostats(device: DeviceRecord): void {
    const ids = this.thermostatKeys(device);
    for (const id of ids) {
      this.publish(`${thermostatBase(device.mac, this.numberOf(id))}/etat`, '', true);
      this.thermoStates.delete(`${device.mac}:${this.numberOf(id)}`);
      this.rulesRuntime.delete(`${device.mac}:${this.numberOf(id)}`);
    }
    if (ids.length) {
      const next: VoiesMap = {};
      for (const [id, config] of Object.entries(device.voies ?? {})) if (!THERMOSTAT_ID.test(id)) next[id] = config;
      device.voies = Object.keys(next).length ? next : undefined;
      device.haSignature = undefined;
      this.publishDevice(device);
      this.scheduleSaveDevices();
    }
    device.engine = undefined;
  }

  /** Requête d'ia (§7bis.6) : consigne, mode du thermostat ou mode de la maison. */
  private async thermostatSetFromRequest(req: ThermostatSetRequest): Promise<{ accepted: boolean; reason?: string }> {
    const device = this.findDevice(String(req?.device ?? ''));
    if (!device) return { accepted: false, reason: `Appareil inconnu : ${req?.device}` };
    if (device.online === false) return { accepted: false, reason: `${this.label(device)} est hors ligne` };
    const ids = this.thermostatKeys(device);
    const id = req.thermostat ? `thermostat${Number(req.thermostat)}` : ids[0];
    if (!id || !ids.includes(id)) return { accepted: false, reason: `Thermostat inconnu sur ${this.label(device)}` };
    const base = thermostatBase(device.mac, this.numberOf(id));
    if (req.mode_maison !== undefined) {
      const reason = this.setMode(String(req.mode_maison), 'ia');
      if (reason) return { accepted: false, reason };
    }
    if (req.consigne !== undefined) {
      const v = Number(req.consigne);
      if (!Number.isFinite(v) || v < 5 || v > 30) return { accepted: false, reason: 'Consigne : entre 5 et 30 °C' };
      this.publish(`${base}/consigne/set`, String(v));
    }
    if (req.mode !== undefined) {
      if (req.mode !== 'heat' && req.mode !== 'off') return { accepted: false, reason: 'Mode : heat ou off' };
      this.publish(`${base}/mode/set`, req.mode);
    }
    return { accepted: true };
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
    // ⭐ 29/09/2026 (demande utilisateur : « tous les Tasmota qu'il ne connaît pas, les neufs et les
    // pas neufs, surtout quand ils pointent n'importe où ») : la même recherche lance aussi celle
    // des neufs (points d'accès Wi-Fi), si cette machine le permet.
    const apScan = this.provisionCheck?.available ? this.refreshProvisionCheck(true) : Promise.resolve();
    try {
      const all = await scanNetworkForTasmota(log);
      // Appareil connu trouvé sur le réseau : son modèle stocké est complété au passage.
      for (const f of all) {
        const device = this.devices.get(f.mac);
        if (!device || !f.model) continue;
        Object.assign(device, { model: f.model, hardware: f.hardware ?? device.hardware, pins: f.pins ?? device.pins, modelFirmware: device.cfg.sw });
        this.scheduleSaveDevices();
      }
      // Écarté seulement s'il est connu ET pointe vers notre broker : un Tasmota connu par une
      // ancienne annonce mais qui pointe ailleurs (ou nulle part) reste à reprendre en main.
      const ours = (d: NetworkTasmota): boolean => d.mqttHost === this.config.mqtt.host && (d.mqttPort ?? 1883) === this.config.mqtt.port;
      this.networkFound = all
        .filter((d) => !this.devices.has(d.mac) || !ours(d))
        .map((d) => ({ ...d, known: this.devices.has(d.mac) }));
    } catch (error) {
      log(String(error instanceof Error ? error.message : error), 'error');
    } finally {
      await apScan;
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
        model: d.model ?? d.cfg.md,
        hardware: d.hardware,
        pins: d.pins,
        lastSeen: d.lastSeen,
        engine: d.engine,
        engineReason: d.engineReason,
        voies: listVoies(d.cfg, d.sn, d.voies).filter((v) => v.kind !== 'thermostat').map((v) => {
          const c = d.voies?.[v.id];
          return { ...v, nom: c?.nom ?? '', parts: c?.nom ? splitDeviceName(c.nom) : undefined, deviceClass: c?.deviceClass, customUnit: c?.unit };
        }),
        thermostats: listVoies(d.cfg, d.sn, d.voies).filter((v) => v.kind === 'thermostat').map((v) => {
          const c = d.voies?.[v.id] as VoieConfig;
          return {
            id: v.id, n: v.number, nom: c.nom ?? '', parts: c.nom ? splitDeviceName(c.nom) : undefined, relais: c.relais, capteur: c.capteur,
            hysteresis: c.hysteresis ?? 0.5, consignes: c.consignes ?? {}, minOn: c.minOn ?? 180, minOff: c.minOff ?? 180, capteurMuet: c.capteurMuet ?? 1800,
            state: this.thermoStates.get(`${d.mac}:${v.number}`)
          };
        }),
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
      defaultConsignes: DEFAULT_CONSIGNES,
      deviceClasses: [...DEVICE_CLASSES],
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

export interface ThermostatSetRequest {
  correlation_id: string;
  device: string;
  thermostat?: number;
  consigne?: number;
  mode?: string;
  mode_maison?: string;
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
