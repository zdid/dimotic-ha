/**
 * Catalogue de règles préétablies (fonctionnelles-tasmota_specs §7.1) — texte Tasmota standard
 * (Rule1..3, 511 caractères), donc utilisable sur ESP8266 (décision D8).
 */

export const RULE_MAX_LENGTH = 511;

export interface RuleParamDef {
  key: string;
  label: string;
  type: 'number' | 'text' | 'time' | 'select';
  options?: string[];
  default?: string | number;
  min?: number;
  max?: number;
  help?: string;
}

export interface RuleTemplate {
  id: string;
  label: string;
  description: string;
  params: RuleParamDef[];
  /** Construit le texte de la règle pour l'emplacement `slot` ; lève une Error lisible si invalide. */
  build(params: Record<string, string | number>, slot: number): string;
}

function num(params: Record<string, string | number>, key: string, label: string, min: number, max: number): number {
  const raw = params[key];
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} : valeur attendue entre ${min} et ${max}`);
  }
  return value;
}

function relay(params: Record<string, string | number>): number {
  return Math.round(num(params, 'relais', 'Relais', 1, 8));
}

/** Nombre au format Tasmota (point décimal, 2 décimales au plus). */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'minuterie',
    label: 'Minuterie',
    description: "Éteint le relais tout seul après la durée choisie (compte à partir de l'allumage).",
    params: [
      { key: 'relais', label: 'Relais', type: 'number', default: 1, min: 1, max: 8 },
      { key: 'duree', label: 'Durée (secondes)', type: 'number', default: 180, min: 1, max: 86400 }
    ],
    build(params, slot) {
      const r = relay(params);
      const d = Math.round(num(params, 'duree', 'Durée', 1, 86400));
      return `ON Power${r}#State=1 DO RuleTimer${slot} ${d} ENDON ON Power${r}#State=0 DO RuleTimer${slot} 0 ENDON ON Rules#Timer=${slot} DO Power${r} 0 ENDON`;
    }
  },
  {
    id: 'thermostat',
    label: 'Thermostat',
    description: 'Allume le relais sous la consigne, l’éteint au-dessus (avec une marge pour éviter les battements).',
    params: [
      { key: 'relais', label: 'Relais', type: 'number', default: 1, min: 1, max: 8 },
      { key: 'capteur', label: 'Capteur (ex. DS18B20#Temperature)', type: 'text', default: 'DS18B20#Temperature',
        help: 'Nom du capteur et de la mesure tels que Tasmota les publie dans tele/…/SENSOR.' },
      { key: 'consigne', label: 'Consigne (°C)', type: 'number', default: 19, min: -30, max: 90 },
      { key: 'hysteresis', label: 'Marge (°C)', type: 'number', default: 0.5, min: 0.1, max: 10 }
    ],
    build(params) {
      const r = relay(params);
      const capteur = String(params.capteur ?? '').trim();
      if (!/^[A-Za-z0-9_-]+#[A-Za-z0-9_]+$/.test(capteur)) throw new Error('Capteur : format attendu Capteur#Mesure');
      const consigne = num(params, 'consigne', 'Consigne', -30, 90);
      const marge = num(params, 'hysteresis', 'Marge', 0.1, 10);
      return `ON ${capteur}<${fmt(consigne - marge / 2)} DO Power${r} 1 ENDON ON ${capteur}>${fmt(consigne + marge / 2)} DO Power${r} 0 ENDON`;
    }
  },
  {
    id: 'horaire',
    label: 'Programmation horaire',
    description: "Allume ou éteint le relais chaque jour à l'heure choisie.",
    params: [
      { key: 'relais', label: 'Relais', type: 'number', default: 1, min: 1, max: 8 },
      { key: 'heure', label: 'Heure (HH:MM)', type: 'time', default: '07:00' },
      { key: 'action', label: 'Action', type: 'select', options: ['allumer', 'éteindre'], default: 'allumer' }
    ],
    build(params) {
      const r = relay(params);
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(params.heure ?? '').trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Heure : format attendu HH:MM');
      const minutes = Number(m[1]) * 60 + Number(m[2]);
      const action = String(params.action ?? 'allumer');
      if (action !== 'allumer' && action !== 'éteindre') throw new Error('Action : allumer ou éteindre');
      return `ON Time#Minute=${minutes} DO Power${r} ${action === 'allumer' ? 1 : 0} ENDON`;
    }
  },
  {
    id: 'masquage',
    label: 'Masquage anti-rebond (Magic Switch)',
    description: "Ignore l'interrupteur mural pendant la durée choisie après chaque commutation (fausses coupures des alimentations LED). Demande IF : firmware ESP32 ou compilé avec les expressions.",
    params: [
      { key: 'duree', label: 'Durée de masquage (secondes)', type: 'number', default: 2, min: 1, max: 10 }
    ],
    build(params, slot) {
      const d = Math.round(num(params, 'duree', 'Durée', 1, 10));
      return `ON Power1#State DO Backlog Var${slot} 1; RuleTimer${slot} ${d} ENDON ON Rules#Timer=${slot} DO Var${slot} 0 ENDON ON Switch1#State DO IF (Var${slot}==0) Power1 TOGGLE ENDIF ENDON`;
    }
  }
];

export function findTemplate(id: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find((t) => t.id === id);
}

/** Construit et contrôle le texte (longueur). */
export function buildRuleText(templateId: string, params: Record<string, string | number>, slot: number): string {
  const template = findTemplate(templateId);
  if (!template) throw new Error(`Modèle de règle inconnu : ${templateId}`);
  const text = template.build(params, slot);
  if (text.length > RULE_MAX_LENGTH) throw new Error(`Règle trop longue (${text.length} > ${RULE_MAX_LENGTH} caractères)`);
  return text;
}

/** Règle active pour un mode donné ? */
export function isRuleActive(rule: { enabled: boolean; modes: string[] }, currentMode: string | undefined): boolean {
  if (!rule.enabled) return false;
  if (rule.modes.length === 0 || !currentMode) return true;
  return rule.modes.includes(currentMode);
}

/** Catalogue sans fonctions, pour l'UI et ia. */
export function describeTemplates(): Array<Omit<RuleTemplate, 'build'>> {
  return RULE_TEMPLATES.map(({ build: _build, ...rest }) => rest);
}
