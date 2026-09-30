/**
 * Moteur de thermostat pour ESP32 — script Berry, dépôt dans le module et configuration
 * (fonctionnelles-tasmota_specs v1.4 §7bis.3). Fonctions pures : rien d'envoyé d'ici, TasmotaService
 * dépose ce qui est construit.
 *
 * Fichiers déposés (système de fichiers du module, écrits par la commande Berry `Br`, sans le
 * téléversement web) :
 *   /dimotic_thermostat.be    programme, versionné (THERMOSTAT_VERSION)
 *   /dimotic_thermostat.json  configuration des thermostats du module
 *   /autoexec.be              charge le programme au démarrage (marqué, jamais écrasé s'il est à l'utilisateur)
 */

/** Version du programme : publiée dans l'état ; différente de celle du module → redépôt. */
export const THERMOSTAT_VERSION = 1;

export const THERMOSTAT_SCRIPT_PATH = '/dimotic_thermostat.be';
export const THERMOSTAT_CONFIG_PATH = '/dimotic_thermostat.json';
export const AUTOEXEC_PATH = '/autoexec.be';
/** Marque de nos fichiers : un autoexec.be qui ne la porte pas appartient à l'utilisateur. */
export const DIMOTIC_MARK = '# dimotic-ha';

export const AUTOEXEC_TEXT = `${DIMOTIC_MARK} : thermostat (géré par l'application tasmota, ne pas modifier)
tasmota.load('${THERMOSTAT_SCRIPT_PATH}')
`;

/** Un thermostat tel que le module le reçoit (fichier JSON). */
export interface ThermostatModuleConfig {
  n: number;
  /** Préfixe des topics du thermostat : dimotic/tasmota/<MAC>/thermostat<n>. */
  base: string;
  /** Relais commandé, numérotation Tasmota (1 = Power1). */
  relais: number;
  /** Capteur : groupe du SENSOR (rang) et identifiant matériel quand il existe ('' sinon), mesure. */
  group: string;
  id: string;
  measure: string;
  hysteresis: number;
  /** Consigne par mode de la maison. */
  consignes: Record<string, number>;
  minOn: number;
  minOff: number;
  /** Délai sans mesure valide avant l'arrêt de sécurité, en secondes. */
  capteurMuet: number;
  /** Mode de la maison pris tant qu'aucun n'est connu (le premier de la configuration). */
  modeDefaut: string;
}

export function buildThermostatConfigJson(thermostats: ThermostatModuleConfig[]): string {
  return JSON.stringify({ version: THERMOSTAT_VERSION, thermostats });
}

/**
 * Commandes `Br` qui écrivent un fichier par morceaux (le contenu passe en hexadécimal : aucun souci de
 * guillemets ni de retours à la ligne, et une commande reste courte — un bloc de 300 octets fait 600
 * caractères).
 */
export function fileWriteCommands(path: string, content: string, chunkBytes = 300): string[] {
  const bytes = Buffer.from(content, 'utf8');
  const commands: string[] = [];
  for (let i = 0; i === 0 || i < bytes.length; i += chunkBytes) {
    const hex = bytes.subarray(i, i + chunkBytes).toString('hex');
    commands.push(`f=open('${path}','${i === 0 ? 'w' : 'a'}'); f.write(bytes('${hex}')); f.close(); return ${Math.min(i + chunkBytes, bytes.length)}`);
  }
  return commands;
}

/** Taille en octets d'un texte écrit dans le module (UTF-8), pour vérifier le dépôt. */
export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

export const THERMOSTAT_SCRIPT = String.raw`# dimotic-ha : moteur de thermostat (généré par l'application tasmota, ne pas modifier à la main)
# Spécification : fonctionnelles-tasmota_specs v1.4 §7bis.3
import string
import json
import persist
import mqtt
import global

class DimoticThermo
  static version = 1
  static config_path = '/dimotic_thermostat.json'
  static house_topic = 'dimotic/tasmota/mode'
  static tick_s = 10

  var items, house, subs, now_s, active

  def init()
    self.items = []
    self.subs = []
    self.now_s = 0
    self.active = true
    self.house = ''
    var saved = persist.find('dt', nil)
    if isinstance(saved, map)
      self.house = saved.find('house', '')
    end
    self.load_config(false)
    tasmota.add_rule('Mqtt#Connected', def() self.on_mqtt() end)
    if mqtt.connected()
      self.on_mqtt()
    end
    self.schedule()
  end

  # ---- configuration et état persistant ------------------------------------------------------

  def load_config(adopt)
    var text = nil
    try
      var f = open(DimoticThermo.config_path, 'r')
      text = f.read()
      f.close()
    except .. as e, m
      tasmota.log('DT: config illisible ' .. str(m), 2)
      return false
    end
    var cfg = json.load(text)
    if !isinstance(cfg, map)
      return false
    end
    var saved = persist.find('dt', nil)
    var st = {}
    if isinstance(saved, map) && isinstance(saved.find('items', nil), map) st = saved['items'] end
    var old = {}
    for it: self.items
      old[it['n']] = it
    end
    var fresh = []
    for c: cfg.find('thermostats', [])
      var n = int(c['n'])
      var it = old.find(n, nil)
      if it == nil
        it = {'temp': nil, 'heating': false, 'last_on': -100000, 'last_off': -100000, 'last_valid': 0,
              'fault': nil, 'fed': nil, 'sig': '', 'mode': 'heat', 'sp': {}}
        var p = st.find(str(n), nil)
        if isinstance(p, map)
          it['mode'] = p.find('mode', 'heat')
          it['sp'] = p.find('sp', {})
        end
        it['last_valid'] = self.now_s
      end
      it['n'] = n
      it['base'] = c['base']
      it['relais'] = int(c['relais'])
      it['group'] = c.find('group', '')
      it['id'] = c.find('id', '')
      it['measure'] = c.find('measure', 'Temperature')
      it['hyst'] = real(c.find('hysteresis', 0.5))
      it['consignes'] = c.find('consignes', {})
      it['min_on'] = int(c.find('minOn', 180))
      it['min_off'] = int(c.find('minOff', 180))
      it['mute'] = int(c.find('capteurMuet', 1800))
      it['mode_defaut'] = c.find('modeDefaut', '')
      if adopt
        it['sp'] = {}
      end
      fresh.push(it)
    end
    self.items = fresh
    if adopt
      self.save()
    end
    if mqtt.connected()
      self.on_mqtt()
    end
    for it: self.items
      self.step(it)
    end
    return true
  end

  def save()
    var items = {}
    for it: self.items
      items[str(it['n'])] = {'mode': it['mode'], 'sp': it['sp']}
    end
    persist.dt = {'house': self.house, 'items': items}
    persist.save()
  end

  # ---- MQTT ------------------------------------------------------------------------------------

  def on_mqtt()
    self.sub(DimoticThermo.house_topic, def(t, i, s, b) return self.on_house(s) end)
    for it: self.items
      var x = it
      self.sub(x['base'] .. '/consigne/set', def(t, i, s, b) return self.on_consigne(x, s) end)
      self.sub(x['base'] .. '/mode/set', def(t, i, s, b) return self.on_mode(x, s) end)
      x['sig'] = ''
      self.publish(x)
    end
  end

  def sub(topic, fn)
    if self.subs.find(topic) == nil
      mqtt.subscribe(topic, fn)
      self.subs.push(topic)
    end
  end

  def on_house(s)
    if size(s) > 0 && s != self.house
      self.house = s
      self.save()
      for it: self.items self.step(it) end
    end
    return true
  end

  def on_consigne(it, s)
    var v = real(s)
    if v >= 5 && v <= 30
      it['sp'][self.key(it)] = v
      self.save()
      self.step(it)
    else
      tasmota.log('DT: consigne refusée ' .. s, 2)
    end
    return true
  end

  def on_mode(it, s)
    if s == 'heat' || s == 'off'
      it['mode'] = s
      self.save()
      self.step(it)
    end
    return true
  end

  # ---- mesure et régulation -----------------------------------------------------------------------

  def valid(t)
    var k = type(t)
    return (k == 'int' || k == 'real') && t > -30 && t < 90 && t != 85
  end

  def read_temp(it)
    if it['fed'] != nil return it['fed'] end
    var text = tasmota.read_sensors()
    if text == nil return nil end
    var m = json.load(text)
    if !isinstance(m, map) return nil end
    for k: m.keys()
      var v = m[k]
      if isinstance(v, map) && v.contains(it['measure'])
        if it['id'] != ''
          if v.find('Id', '') == it['id'] return v[it['measure']] end
        elif k == it['group']
          return v[it['measure']]
        end
      end
    end
    return nil
  end

  def key(it)
    if self.house != ''
      return self.house
    end
    return it['mode_defaut']
  end

  def target(it)
    var k = self.key(it)
    if it['sp'].contains(k)
      return real(it['sp'][k])
    end
    if it['consignes'].contains(k)
      return real(it['consignes'][k])
    end
    for name: it['consignes'].keys()
      return real(it['consignes'][name])
    end
    return 19.0
  end

  def drive(it, on)
    var idx = it['relais'] - 1
    var p = tasmota.get_power()
    if idx < size(p) && p[idx] != on
      tasmota.set_power(idx, on)
    end
    if on != it['heating']
      it['heating'] = on
      if on
        it['last_on'] = self.now_s
      else
        it['last_off'] = self.now_s
      end
    end
  end

  def step(it)
    var t = self.read_temp(it)
    if self.valid(t)
      it['temp'] = t
      it['last_valid'] = self.now_s
      it['fault'] = nil
    end
    if self.now_s - it['last_valid'] > it['mute']
      it['fault'] = 'capteur_muet'
    end
    if it['fault'] != nil || it['mode'] != 'heat' || it['temp'] == nil
      self.drive(it, false)
    else
      var goal = self.target(it)
      var half = it['hyst'] / 2
      if it['heating']
        var stop = it['temp'] > goal + half && (self.now_s - it['last_on']) >= it['min_on']
        self.drive(it, !stop)
      else
        var start = it['temp'] < goal - half && (self.now_s - it['last_off']) >= it['min_off']
        self.drive(it, start)
      end
    end
    self.publish(it)
  end

  def publish(it)
    var action = 'off'
    if it['mode'] == 'heat' && it['fault'] == nil
      action = it['heating'] ? 'heating' : 'idle'
    end
    var eff = {}
    for k: it['consignes'].keys()
      eff[k] = it['consignes'][k]
    end
    for k: it['sp'].keys()
      eff[k] = it['sp'][k]
    end
    var s = {'version': DimoticThermo.version, 'temperature': it['temp'], 'consigne': self.target(it),
             'consignes': eff, 'mode': it['mode'], 'mode_maison': self.house, 'action': action}
    if it['fault'] != nil s['defaut'] = it['fault'] end
    var sig = json.dump(s)
    if sig != it['sig'] && mqtt.connected()
      mqtt.publish(it['base'] .. '/etat', sig, true)
      it['sig'] = sig
    end
  end

  # ---- minuterie ------------------------------------------------------------------------------------

  def schedule()
    tasmota.set_timer(DimoticThermo.tick_s * 1000, def() self.tick() end, 'dimotic_thermo')
  end

  def tick()
    if !self.active return end
    self.now_s += DimoticThermo.tick_s
    for it: self.items
      try
        self.step(it)
      except .. as e, m
        tasmota.log('DT: ' .. str(e) .. ' ' .. str(m), 2)
      end
    end
    self.schedule()
  end

  # ---- diagnostic ---------------------------------------------------------------------------------

  # Mesure simulée (essais sans capteur) : feed(1, 18.5) ; feed(1, nil) pour l'annuler.
  def feed(n, t)
    for it: self.items
      if it['n'] == n
        it['fed'] = t
        self.step(it)
      end
    end
  end

  def state()
    var out = []
    for it: self.items
      out.push({'n': it['n'], 'temp': it['temp'], 'heating': it['heating'], 'mode': it['mode'],
                'fault': it['fault'], 'house': self.house, 'goal': self.target(it)})
    end
    return out
  end
end

var previous = nil
try
  previous = global.dimotic_thermo
except .. as e, m
  previous = nil
end
if previous != nil
  previous.active = false
  tasmota.remove_timer('dimotic_thermo')
end
global.dimotic_thermo = DimoticThermo()
`;
