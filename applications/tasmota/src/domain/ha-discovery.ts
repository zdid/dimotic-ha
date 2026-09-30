/**
 * Découverte native Tasmota → découvertes HA standard (fonctionnelles-tasmota_specs §3, §4).
 * Fonctions pures : aucun accès MQTT ici, TasmotaService publie ce qu'elles construisent.
 */

import {
  extractTaxonomy,
  buildDisplayName,
  buildAttributsTaxonomie,
  isConventionalName,
  type ExtractedTaxonomy
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

export interface MeasureDef {
  label: string;
  unit?: string;
  deviceClass?: string;
  stateClass?: 'measurement' | 'total_increasing';
}

export const MEASURES: Record<string, MeasureDef> = {
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

/** QUOI proposé pour la voie d'une mesure (spec v1.3 §4.1bis) — modifiable dans la fiche ; les mesures
 *  électriques reprennent « compteur », déjà utilisé par les compteurs existants. */
export const MEASURE_QUOI: Record<string, string> = {
  Temperature: 'température',
  Humidity: 'humidité',
  DewPoint: 'point de rosée',
  Pressure: 'pression',
  Illuminance: 'luminosité',
  Power: 'compteur',
  ApparentPower: 'compteur',
  ReactivePower: 'compteur',
  Factor: 'compteur',
  Voltage: 'compteur',
  Current: 'compteur',
  Total: 'compteur',
  Today: 'compteur',
  Yesterday: 'compteur'
};

/** Types de capteur proposés pour une mesure inconnue (device_class HA). */
export const DEVICE_CLASSES = [
  'temperature', 'humidity', 'pressure', 'illuminance', 'power', 'energy', 'voltage', 'current',
  'battery', 'carbon_dioxide', 'moisture', 'distance', 'speed', 'signal_strength'
] as const;

/** Groupes de tele/…/SENSOR qui ne sont pas des capteurs. */
const NOT_SENSORS = /^(Time|TempUnit|PressureUnit|SpeedUnit|Shutter\d+|Switch\d+|Button\d+)$/;

/** Groupe « classé » quand le module porte plusieurs capteurs de même type : DS18B20-1, DS18B20-2… */
const RANKED_GROUP = /^(.+)-(\d+)$/;

export interface SensorInfo {
  group: string;
  measure: string;
  label: string;
  def?: MeasureDef;
  /** Clé de voie stable (spec v1.3 §4.1bis) — aussi l'identifiant d'objet de la découverte HA. */
  voieId: string;
  /** Identifiant matériel (`Id`) quand le groupe est classé (plusieurs capteurs de même type). */
  sensorId?: string;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/** Mesures numériques de `sn` (tasmota/discovery/<MAC>/sensors) — tableaux ignorés (§11). */
export function analyseSensors(sn: Record<string, unknown> | undefined): SensorInfo[] {
  const out: SensorInfo[] = [];
  if (!sn) return out;
  for (const [group, value] of Object.entries(sn)) {
    if (NOT_SENSORS.test(group) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const ranked = RANKED_GROUP.exec(group);
    const sensorId = typeof record.Id === 'string' && record.Id ? record.Id : undefined;
    // Rang instable (ajout d'un capteur) → identifiant matériel, seulement quand il existe.
    const byId = !!ranked && !!sensorId;
    for (const [measure, v] of Object.entries(record)) {
      if (typeof v !== 'number') continue;
      const def = MEASURES[measure];
      const label = def ? (group === 'ENERGY' ? def.label : `${def.label} ${group}`) : `${measure} ${group}`;
      const voieId = slug(byId ? `${ranked![1]}_${sensorId}_${measure}` : `${group}_${measure}`);
      out.push({ group, measure, label, def, voieId, sensorId: byId ? sensorId : undefined });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Voies (spec v1.3 §4.1bis) : un relais, un volet ou une mesure de capteur = un appareil HA
// -----------------------------------------------------------------------------

/** Réglage d'une voie, stocké dans data/tasmota/devices.yaml (`voies`). */
export interface VoieConfig {
  /** Nom au format QUOI---lieu précis--lieu--père--grand-père (60 caractères au plus). */
  nom?: string;
  /** Mesure inconnue seulement : type et unité choisis dans la fiche. */
  deviceClass?: string;
  unit?: string;
  // --- Thermostat (spec v1.4 §7bis.2) : clé `thermostat<n>`, reconnu à `relais` renseigné ---------
  /** Relais commandé (1 = Power1) : il appartient au thermostat, son entité n'est plus publiée. */
  relais?: number;
  /** Clé de la voie capteur de température (§4.1bis). */
  capteur?: string;
  /** Marge totale autour de la consigne, en °C. */
  hysteresis?: number;
  /** Consigne par mode de la maison. */
  consignes?: Record<string, number>;
  /** Durées minimales allumé / éteint, en secondes (moteur Berry seulement). */
  minOn?: number;
  minOff?: number;
  /** Délai sans mesure valide avant l'arrêt de sécurité, en secondes. */
  capteurMuet?: number;
  /** Moteur à règles (ESP8266) : emplacement de règle occupé, et thermostat mis à l'arrêt depuis HA. */
  regleSlot?: number;
  arret?: boolean;
}
export type VoiesMap = Record<string, VoieConfig>;

export const THERMOSTAT_ID = /^thermostat(\d+)$/;

export interface VoieInfo {
  id: string;
  kind: 'relay' | 'shutter' | 'sensor' | 'thermostat';
  /** Libellé technique (« Relais 2 », « Température DS18B20-1 »). */
  label: string;
  index?: number;
  number?: number;
  measure?: string;
  sensorId?: string;
  /** Mesure connue (type et unité imposés) — sinon la fiche demande le type. */
  known: boolean;
  unit?: string;
  suggestedQuoi?: string;
}

/** Toutes les voies d'un module, dans l'ordre : relais, volets, capteurs, puis thermostats (ceux enregistrés). */
export function listVoies(cfg: TasmotaDiscoveryConfig, sn: Record<string, unknown> | undefined, voies?: VoiesMap): VoieInfo[] {
  const { relays, shutters } = analyseRelays(cfg);
  const out: VoieInfo[] = [];
  for (const r of relays) out.push({ id: `relais${r.index + 1}`, kind: 'relay', label: `Relais ${r.index + 1}`, index: r.index, known: true });
  for (const sh of shutters) out.push({ id: `volet${sh.number}`, kind: 'shutter', label: `Volet ${sh.number}`, number: sh.number, known: true });
  for (const s of analyseSensors(sn)) {
    out.push({
      id: s.voieId, kind: 'sensor', label: s.label, measure: s.measure, sensorId: s.sensorId,
      known: !!s.def, unit: s.def?.unit, suggestedQuoi: MEASURE_QUOI[s.measure]
    });
  }
  for (const id of Object.keys(voies ?? {})) {
    const m = THERMOSTAT_ID.exec(id);
    if (m && voies![id].relais) out.push({ id, kind: 'thermostat', label: `Thermostat ${m[1]}`, number: Number(m[1]), known: true, suggestedQuoi: 'thermostat' });
  }
  return out;
}

/** Préfixe des topics d'un thermostat (spec §7bis.3). */
export function thermostatBase(mac: string, n: number): string {
  return `dimotic/tasmota/${mac}/thermostat${n}`;
}

// -----------------------------------------------------------------------------
// Construction des découvertes HA
// -----------------------------------------------------------------------------

export function macColons(mac: string): string {
  return mac.toLowerCase().match(/.{2}/g)?.join(':') ?? mac.toLowerCase();
}

export function attributesTopic(mac: string): string {
  return `dimotic/tasmota/${mac}/attributs`;
}

/** Topic d'attributs (taxonomie) d'une voie nommée (spec v1.3 §4.1bis). */
export function voieAttributesTopic(mac: string, voieId: string): string {
  return `dimotic/tasmota/${mac}/voie/${voieId}/attributs`;
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

export interface HaEntityDiscovery {
  component: 'light' | 'switch' | 'cover' | 'sensor' | 'binary_sensor' | 'climate';
  /** Topic source pour le passthrough « découverte » (1er segment réécrit en homeassistant). */
  sourceTopic: string;
  /** Topic HA final (pour l'effacement). */
  haTopic: string;
  payload: Record<string, unknown>;
}

export interface BuiltDevice {
  entities: HaEntityDiscovery[];
  /** Topics d'attributs (taxonomie) à publier, retenus : un pour le module, un par voie nommée. */
  attributes: Array<{ topic: string; payload: Record<string, unknown> }>;
}

/** Taxonomie d'une voie nommée, undefined si elle n'a pas de nom valide (elle hérite du module). */
function voieTaxonomy(voies: VoiesMap | undefined, id: string): ExtractedTaxonomy | undefined {
  const nom = voies?.[id]?.nom;
  return nom && isConventionalName(nom) ? extractTaxonomy(nom) : undefined;
}

/**
 * Découvertes HA d'un module (spec v1.3 §4.1bis). Une voie nommée est publiée comme son propre appareil
 * (`via_device` vers le module) ; une voie non nommée reste une entité de l'appareil du module, à condition
 * que le module suive la convention (§3.3). null si rien n'est publiable (module « à nommer » sans voie nommée).
 */
export function buildHaDiscovery(
  cfg: TasmotaDiscoveryConfig,
  sn: Record<string, unknown> | undefined,
  voies?: VoiesMap
): BuiltDevice | null {
  const moduleTax = isConventionalName(cfg.dn) ? extractTaxonomy(cfg.dn as string) : undefined;
  const infos = listVoies(cfg, sn, voies);
  const named = new Set(infos.filter((v) => voieTaxonomy(voies, v.id)).map((v) => v.id));
  // Un relais utilisé par un thermostat nommé appartient au thermostat : plus d'entité manuelle (§7bis.2).
  const owned = new Set<string>();
  for (const v of infos) if (v.kind === 'thermostat' && named.has(v.id)) owned.add(`relais${voies![v.id].relais}`);
  if (!moduleTax && named.size === 0) return null;

  const topics = deviceTopics(cfg);
  const mac = cfg.mac.toUpperCase();
  const moduleId = `tasmota_${mac}`;

  const moduleDevice: Record<string, unknown> = {
    identifiers: [moduleId],
    connections: [['mac', macColons(mac)]],
    name: moduleTax ? buildDisplayName(moduleTax) : `Tasmota ${cfg.t}`,
    manufacturer: 'Tasmota',
    model: cfg.md ?? 'Tasmota',
    sw_version: cfg.sw ?? undefined,
    configuration_url: cfg.ip ? `http://${cfg.ip}/` : undefined,
    suggested_area: moduleTax?.nomLieu ?? undefined
  };
  const availability = {
    availability_topic: `${topics.tele}LWT`,
    payload_available: 'Online',
    payload_not_available: 'Offline'
  };
  const moduleCommon = { ...availability, json_attributes_topic: attributesTopic(mac), device: moduleDevice };

  /** Bloc commun d'une voie nommée : son propre appareil, ses propres attributs. */
  const voieCommon = (id: string, tax: ExtractedTaxonomy): Record<string, unknown> => ({
    ...availability,
    json_attributes_topic: voieAttributesTopic(mac, id),
    device: {
      identifiers: [`${moduleId}_${id}`],
      via_device: moduleId,
      name: buildDisplayName(tax),
      manufacturer: 'Tasmota',
      model: cfg.md ?? 'Tasmota',
      configuration_url: cfg.ip ? `http://${cfg.ip}/` : undefined,
      suggested_area: tax.nomLieu ?? undefined
    }
  });

  const entities: HaEntityDiscovery[] = [];
  const attributes: BuiltDevice['attributes'] = [];
  if (moduleTax) attributes.push({ topic: attributesTopic(mac), payload: { attributs_taxonomie: buildAttributsTaxonomie(moduleTax) } });
  for (const id of named) {
    attributes.push({ topic: voieAttributesTopic(mac, id), payload: { attributs_taxonomie: buildAttributsTaxonomie(voieTaxonomy(voies, id)!) } });
  }

  const { relays, shutters } = analyseRelays(cfg);

  relays.forEach((relay, position) => {
    const id = `relais${relay.index + 1}`;
    if (owned.has(id)) return;
    const own = voieTaxonomy(voies, id);
    const tax = own ?? moduleTax;
    if (!tax) return;
    // Voie nommée : son QUOI décide (un relais réglé « lumière » dans Tasmota mais nommé « moteur » est un
    // switch) ; sinon comme avant (rl = 2 ou QUOI = lumière).
    const isLight = tax.slugQuoi.startsWith('lumiere');
    const component = own ? (isLight ? 'light' : 'switch') : (relay.kind === 'light' || isLight ? 'light' : 'switch');
    const suffix = powerSuffix(cfg, relay.index);
    const fn = cfg.fn?.[relay.index];
    const name = own || position === 0 ? null : (fn && fn !== cfg.dn ? fn : `Relais ${relay.index + 1}`);
    const payload: Record<string, unknown> = {
      ...(own ? voieCommon(id, own) : moduleCommon),
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
    entities.push({ component, ...entityTopics(component, mac, id), payload });
  });

  shutters.forEach((shutter, position) => {
    const k = shutter.number;
    const id = `volet${k}`;
    const own = voieTaxonomy(voies, id);
    if (!own && !moduleTax) return;
    entities.push({
      component: 'cover',
      ...entityTopics('cover', mac, id),
      payload: {
        ...(own ? voieCommon(id, own) : moduleCommon),
        name: own || (position === 0 && relays.length === 0) ? null : `Volet ${k}`,
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
    const own = voieTaxonomy(voies, sensor.voieId);
    if (!own && !moduleTax) continue;
    const custom = voies?.[sensor.voieId];
    const deviceClass = sensor.def?.deviceClass ?? custom?.deviceClass;
    const unit = sensor.def?.unit ?? custom?.unit;
    const payload: Record<string, unknown> = {
      ...(own ? voieCommon(sensor.voieId, own) : moduleCommon),
      name: own ? null : sensor.label,
      unique_id: `tasmota_${mac}_${sensor.voieId}`,
      state_topic: `${topics.tele}SENSOR`,
      value_template: `{{ value_json['${sensor.group}']['${sensor.measure}'] }}`
    };
    if (unit) payload.unit_of_measurement = unit;
    if (deviceClass) payload.device_class = deviceClass;
    if (sensor.def?.stateClass) payload.state_class = sensor.def.stateClass;
    else if (custom?.deviceClass) payload.state_class = 'measurement';
    entities.push({ component: 'sensor', ...entityTopics('sensor', mac, sensor.voieId), payload });
  }

  // Thermostats (§7bis.5) : une entité `climate` par thermostat nommé, état lu dans `…/etat`.
  for (const v of infos) {
    if (v.kind !== 'thermostat' || !named.has(v.id)) continue;
    const own = voieTaxonomy(voies, v.id)!;
    const base = thermostatBase(mac, v.number as number);
    entities.push({
      component: 'climate',
      ...entityTopics('climate', mac, v.id),
      payload: {
        ...voieCommon(v.id, own),
        name: null,
        unique_id: `tasmota_${mac}_${v.id}`,
        modes: ['off', 'heat'],
        min_temp: 5,
        max_temp: 30,
        temp_step: 0.5,
        precision: 0.1,
        temperature_unit: 'C',
        current_temperature_topic: `${base}/etat`,
        current_temperature_template: '{{ value_json.temperature }}',
        temperature_state_topic: `${base}/etat`,
        temperature_state_template: '{{ value_json.consigne }}',
        mode_state_topic: `${base}/etat`,
        mode_state_template: '{{ value_json.mode }}',
        action_topic: `${base}/etat`,
        action_template: '{{ value_json.action }}',
        temperature_command_topic: `${base}/consigne/set`,
        mode_command_topic: `${base}/mode/set`
      }
    });
  }

  // Le module doit exister comme appareil pour que `via_device` pointe quelque chose : dès qu'une voie est
  // nommée, une entité diagnostic « Connexion » (LWT) lui est ajoutée.
  if (named.size > 0) {
    entities.push({
      component: 'binary_sensor',
      ...entityTopics('binary_sensor', mac, 'connexion'),
      payload: {
        name: 'Connexion',
        unique_id: `tasmota_${mac}_connexion`,
        device_class: 'connectivity',
        entity_category: 'diagnostic',
        state_topic: `${topics.tele}LWT`,
        payload_on: 'Online',
        payload_off: 'Offline',
        device: moduleDevice
      }
    });
  }

  return { entities, attributes };
}
