/**
 * Découverte native Tasmota → découvertes HA standard (fonctionnelles-tasmota_specs §3, §4).
 * Fonctions pures : aucun accès MQTT ici, TasmotaService publie ce qu'elles construisent.
 */

import {
  extractTaxonomy,
  buildDisplayName,
  buildAttributsTaxonomie,
  isConventionalName
} from './taxonomy';

/** tasmota/discovery/<MAC>/config (champs utilisés — voir hatasmota/const.py). */
export interface TasmotaDiscoveryConfig {
  ip?: string;
  dn?: string;
  fn?: Array<string | null>;
  hn?: string;
  mac: string;
  md?: string;
  sw?: string;
  t: string;
  ft: string;
  tp: string[];
  rl?: number[];
  sho?: number[];
  so?: Record<string, number>;
  [key: string]: unknown;
}

export const RL_NONE = 0;
export const RL_RELAY = 1;
export const RL_LIGHT = 2;
export const RL_SHUTTER = 3;

export interface DeviceTopics {
  cmnd: string;
  stat: string;
  tele: string;
}

/** Préfixes cmnd/stat/tele d'un appareil (§3.2) — se terminent par '/'. */
export function deviceTopics(cfg: TasmotaDiscoveryConfig): DeviceTopics {
  const build = (prefix: string): string => {
    let topic = cfg.ft
      .replace('%prefix%', prefix)
      .replace('%topic%', cfg.t)
      .replace('%hostname%', cfg.hn ?? '')
      .replace('%id%', cfg.mac);
    if (!topic.endsWith('/')) topic += '/';
    return topic;
  };
  const [cmnd, stat, tele] = [cfg.tp?.[0] ?? 'cmnd', cfg.tp?.[1] ?? 'stat', cfg.tp?.[2] ?? 'tele'];
  return { cmnd: build(cmnd), stat: build(stat), tele: build(tele) };
}

export interface RelayInfo {
  index: number;      // 0-based
  kind: 'relay' | 'light';
}

export interface ShutterInfo {
  number: number;     // 1-based (Shutter<k>)
  relays: [number, number];
}

/** Relais simples et volets (paires consécutives rl=3, comme hatasmota). */
export function analyseRelays(cfg: TasmotaDiscoveryConfig): { relays: RelayInfo[]; shutters: ShutterInfo[] } {
  const rl = cfg.rl ?? [];
  const relays: RelayInfo[] = [];
  const shutters: ShutterInfo[] = [];
  for (let i = 0; i < rl.length; i++) {
    if (rl[i] === RL_SHUTTER && rl[i + 1] === RL_SHUTTER) {
      shutters.push({ number: shutters.length + 1, relays: [i, i + 1] });
      i++;
    } else if (rl[i] === RL_RELAY || rl[i] === RL_LIGHT) {
      relays.push({ index: i, kind: rl[i] === RL_LIGHT ? 'light' : 'relay' });
    }
  }
  return { relays, shutters };
}

/** Topic d'état d'un relais : POWER seul pour un appareil à un relais (SetOption26 = 0). */
export function powerSuffix(cfg: TasmotaDiscoveryConfig, index: number): string {
  const count = (cfg.rl ?? []).filter((v) => v !== RL_NONE).length;
  const so26 = cfg.so?.['26'] ?? 0;
  return count <= 1 && !so26 ? 'POWER' : `POWER${index + 1}`;
}

// -----------------------------------------------------------------------------
// Capteurs (§4.2) — libellé, unité, device_class, state_class par nom de mesure
// -----------------------------------------------------------------------------

interface MeasureDef {
  label: string;
  unit?: string;
  deviceClass?: string;
  stateClass?: 'measurement' | 'total_increasing';
}

const MEASURES: Record<string, MeasureDef> = {
  Temperature: { label: 'Température', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement' },
  Humidity: { label: 'Humidité', unit: '%', deviceClass: 'humidity', stateClass: 'measurement' },
  DewPoint: { label: 'Point de rosée', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement' },
  Pressure: { label: 'Pression', unit: 'hPa', deviceClass: 'pressure', stateClass: 'measurement' },
  Illuminance: { label: 'Luminosité', unit: 'lx', deviceClass: 'illuminance', stateClass: 'measurement' },
  Power: { label: 'Puissance', unit: 'W', deviceClass: 'power', stateClass: 'measurement' },
  ApparentPower: { label: 'Puissance apparente', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement' },
  ReactivePower: { label: 'Puissance réactive', unit: 'var', deviceClass: 'reactive_power', stateClass: 'measurement' },
  Factor: { label: 'Facteur de puissance', deviceClass: 'power_factor', stateClass: 'measurement' },
  Voltage: { label: 'Tension', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement' },
  Current: { label: 'Intensité', unit: 'A', deviceClass: 'current', stateClass: 'measurement' },
  Total: { label: 'Énergie totale', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing' },
  Today: { label: "Énergie aujourd'hui", unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing' },
  Yesterday: { label: 'Énergie hier', unit: 'kWh', deviceClass: 'energy' }
};

/** Groupes de tele/…/SENSOR qui ne sont pas des capteurs. */
const NOT_SENSORS = /^(Time|TempUnit|PressureUnit|SpeedUnit|Shutter\d+|Switch\d+|Button\d+)$/;

export interface SensorInfo {
  group: string;
  measure: string;
  label: string;
  def?: MeasureDef;
}

/** Mesures numériques de `sn` (tasmota/discovery/<MAC>/sensors) — tableaux ignorés (§11). */
export function analyseSensors(sn: Record<string, unknown> | undefined): SensorInfo[] {
  const out: SensorInfo[] = [];
  if (!sn) return out;
  for (const [group, value] of Object.entries(sn)) {
    if (NOT_SENSORS.test(group) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [measure, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== 'number') continue;
      const def = MEASURES[measure];
      const label = def ? (group === 'ENERGY' ? def.label : `${def.label} ${group}`) : `${measure} ${group}`;
      out.push({ group, measure, label, def });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Construction des découvertes HA
// -----------------------------------------------------------------------------

export interface HaEntityDiscovery {
  component: 'light' | 'switch' | 'cover' | 'sensor';
  /** Topic source pour le passthrough « découverte » (1er segment réécrit en homeassistant). */
  sourceTopic: string;
  /** Topic HA final (pour l'effacement). */
  haTopic: string;
  payload: Record<string, unknown>;
}

export function macColons(mac: string): string {
  return mac.toLowerCase().match(/.{2}/g)?.join(':') ?? mac.toLowerCase();
}

export function attributesTopic(mac: string): string {
  return `dimotic/tasmota/${mac}/attributs`;
}

export function shutterStateTopic(mac: string, k: number): string {
  return `dimotic/tasmota/${mac}/volet${k}`;
}

function entityTopics(component: string, mac: string, objectId: string): { sourceTopic: string; haTopic: string } {
  const tail = `${component}/tasmota_${mac}/${objectId}/config`;
  return { sourceTopic: `tasmota/${tail}`, haTopic: `homeassistant/${tail}` };
}

/** Topics HA de toutes les variantes possibles d'un relais (pour effacer l'ancien composant). */
export function relayHaTopics(mac: string, index: number): string[] {
  return ['light', 'switch'].map((c) => entityTopics(c, mac, `relais${index + 1}`).haTopic);
}

export interface BuiltDevice {
  entities: HaEntityDiscovery[];
  attributes: Record<string, unknown>;
}

/**
 * Découvertes HA d'un appareil nommé selon la convention ; null si « à nommer » (non publié, §3.3).
 */
export function buildHaDiscovery(cfg: TasmotaDiscoveryConfig, sn: Record<string, unknown> | undefined): BuiltDevice | null {
  if (!isConventionalName(cfg.dn)) return null;
  const taxonomy = extractTaxonomy(cfg.dn as string);
  const topics = deviceTopics(cfg);
  const mac = cfg.mac.toUpperCase();
  const isLumiere = taxonomy.slugQuoi.startsWith('lumiere');

  const device: Record<string, unknown> = {
    identifiers: [`tasmota_${mac}`],
    connections: [['mac', macColons(mac)]],
    name: buildDisplayName(taxonomy),
    manufacturer: 'Tasmota',
    model: cfg.md ?? 'Tasmota',
    sw_version: cfg.sw ?? undefined,
    configuration_url: cfg.ip ? `http://${cfg.ip}/` : undefined,
    suggested_area: taxonomy.nomLieu ?? undefined
  };
  const common = {
    availability_topic: `${topics.tele}LWT`,
    payload_available: 'Online',
    payload_not_available: 'Offline',
    json_attributes_topic: attributesTopic(mac),
    device
  };

  const entities: HaEntityDiscovery[] = [];
  const { relays, shutters } = analyseRelays(cfg);

  relays.forEach((relay, position) => {
    const component = relay.kind === 'light' || isLumiere ? 'light' : 'switch';
    const suffix = powerSuffix(cfg, relay.index);
    const fn = cfg.fn?.[relay.index];
    const name = position === 0 ? null : (fn && fn !== cfg.dn ? fn : `Relais ${relay.index + 1}`);
    const payload: Record<string, unknown> = {
      ...common,
      name,
      unique_id: `tasmota_${mac}_relais${relay.index + 1}`,
      command_topic: `${topics.cmnd}POWER${relay.index + 1}`,
      state_topic: `${topics.stat}${suffix}`,
      payload_on: 'ON',
      payload_off: 'OFF'
    };
    if (component === 'switch') {
      payload.state_on = 'ON';
      payload.state_off = 'OFF';
    }
    entities.push({ component, ...entityTopics(component, mac, `relais${relay.index + 1}`), payload });
  });

  shutters.forEach((shutter, position) => {
    const k = shutter.number;
    entities.push({
      component: 'cover',
      ...entityTopics('cover', mac, `volet${k}`),
      payload: {
        ...common,
        name: position === 0 && relays.length === 0 ? null : `Volet ${k}`,
        unique_id: `tasmota_${mac}_volet${k}`,
        device_class: 'shutter',
        command_topic: `${topics.cmnd}Backlog`,
        payload_open: `ShutterOpen${k}`,
        payload_close: `ShutterClose${k}`,
        payload_stop: `ShutterStop${k}`,
        set_position_topic: `${topics.cmnd}ShutterPosition${k}`,
        position_topic: shutterStateTopic(mac, k),
        position_template: '{{ value_json.position }}',
        position_open: 100,
        position_closed: 0
      }
    });
  });

  for (const sensor of analyseSensors(sn)) {
    const objectId = `${sensor.group}_${sensor.measure}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const payload: Record<string, unknown> = {
      ...common,
      name: sensor.label,
      unique_id: `tasmota_${mac}_${objectId}`,
      state_topic: `${topics.tele}SENSOR`,
      value_template: `{{ value_json['${sensor.group}']['${sensor.measure}'] }}`
    };
    if (sensor.def?.unit) payload.unit_of_measurement = sensor.def.unit;
    if (sensor.def?.deviceClass) payload.device_class = sensor.def.deviceClass;
    if (sensor.def?.stateClass) payload.state_class = sensor.def.stateClass;
    entities.push({ component: 'sensor', ...entityTopics('sensor', mac, objectId), payload });
  }

  return { entities, attributes: { attributs_taxonomie: buildAttributsTaxonomie(taxonomy) } };
}
