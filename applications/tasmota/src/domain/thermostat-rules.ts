/**
 * Moteur de thermostat pour ESP8266 — règles Tasmota et mémoires persistantes (fonctionnelles-tasmota_specs
 * v1.4 §7bis.4). Pas de Berry, pas de système de fichiers, 20 ko de mémoire libre : le texte de la règle ne
 * contient AUCUN chiffre, il compare la mesure aux mémoires `Mem` que l'application réécrit à chaque
 * changement de consigne ou de mode de la maison.
 *
 * ⚠️ Non essayé en réel : le poêle (seul ESP8266) est en production et n'a pas de capteur. Les points à
 * valider sont listés en §7bis.8 (comparaison à `%mem<n>%` dans un déclencheur, `RuleTimer`).
 */

/** Emplacements de mémoire par thermostat : seuil bas, seuil haut. Mem1..Mem5 existent → 2 thermostats. */
export const RULES_MAX_THERMOSTATS = 2;

export function memSlots(n: number): { low: number; high: number } {
  if (n < 1 || n > RULES_MAX_THERMOSTATS) throw new Error(`Thermostat ${n} : le moteur à règles n'en porte que ${RULES_MAX_THERMOSTATS}`);
  return { low: 2 * n - 1, high: 2 * n };
}

const SENSOR_RE = /^[A-Za-z0-9_-]+$/;
const MEASURE_RE = /^[A-Za-z0-9_]+$/;

export interface RulesThermostatParams {
  n: number;
  /** Relais commandé (1 = Power1). */
  relais: number;
  /** Groupe du capteur tel que Tasmota le publie (`DS18B20`, `DS18B20-1`…) et mesure (`Temperature`). */
  group: string;
  measure: string;
  /** Délai sans mesure avant l'arrêt de sécurité, en secondes (0 = pas de sécurité). */
  capteurMuet: number;
}

/**
 * Texte de la règle : allume sous le seuil bas, éteint au-dessus du seuil haut ; chaque mesure réarme un
 * `RuleTimer` dont l'échéance éteint le relais (capteur muet). Tient dans un seul emplacement (511 car.).
 */
export function buildThermostatRuleText(p: RulesThermostatParams): string {
  if (!SENSOR_RE.test(p.group) || !MEASURE_RE.test(p.measure)) throw new Error('Capteur : nom de groupe ou de mesure invalide');
  if (!Number.isInteger(p.relais) || p.relais < 1 || p.relais > 8) throw new Error('Relais : 1 à 8');
  const { low, high } = memSlots(p.n);
  const source = `${p.group}#${p.measure}`;
  let text = `ON ${source}<%mem${low}% DO Power${p.relais} 1 ENDON ON ${source}>%mem${high}% DO Power${p.relais} 0 ENDON`;
  if (p.capteurMuet > 0) {
    if (!Number.isInteger(p.capteurMuet) || p.capteurMuet > 64800) throw new Error('Capteur muet : entier de secondes, 64800 au plus');
    text += ` ON ${source} DO RuleTimer${p.n} ${p.capteurMuet} ENDON ON Rules#Timer=${p.n} DO Power${p.relais} 0 ENDON`;
  }
  if (text.length > 511) throw new Error(`Règle trop longue (${text.length} > 511 caractères)`);
  return text;
}

/** Seuils (°C) pour une consigne et une marge totale : allume sous consigne − marge/2, éteint au-dessus de consigne + marge/2. */
export function thresholds(consigne: number, hysteresis: number): { low: number; high: number } {
  const round = (x: number): number => Math.round(x * 100) / 100;
  return { low: round(consigne - hysteresis / 2), high: round(consigne + hysteresis / 2) };
}

/** Commande écrivant les deux seuils de mémoire du thermostat `n`. */
export function memBacklog(n: number, consigne: number, hysteresis: number): string {
  const { low, high } = memSlots(n);
  const t = thresholds(consigne, hysteresis);
  return `Backlog Mem${low} ${t.low}; Mem${high} ${t.high}`;
}
