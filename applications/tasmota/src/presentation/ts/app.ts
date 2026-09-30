/**
 * Page de l'application Tasmota (fonctionnelles-tasmota_specs v1.0) — liste, fiche, règles, modes,
 * mise en service d'un neuf, paramètres, journal. Socket.io uniquement (window.app.socketService).
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return moduleRoot().querySelector(`#${id}`) as T;
}

function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

interface RuleInstance {
  slot: number;
  template: string;
  params: Record<string, string | number>;
  modes: string[];
  enabled: boolean;
}

interface DeviceView {
  mac: string;
  name: string;
  conventional: boolean;
  quoi?: string;
  lieu?: string;
  precis?: string;
  ip?: string;
  model?: string;
  hardware?: string;
  pins?: string[];
  lastSeen?: string;
  voies?: VoieView[];
  engine?: 'berry' | 'regles' | 'aucun';
  engineReason?: string;
  thermostats?: ThermostatView[];
  version?: string;
  topic: string;
  site: string;
  online?: boolean;
  relays: number;
  shutters: number;
  sensors: string[];
  published: boolean;
  rules: RuleInstance[];
  suggestedTopic: string;
}

interface VoieView {
  id: string;
  kind: 'relay' | 'shutter' | 'sensor';
  label: string;
  measure?: string;
  sensorId?: string;
  known: boolean;
  unit?: string;
  suggestedQuoi?: string;
  nom: string;
  parts?: { quoi?: string; precis?: string; lieu?: string; pere?: string; grandPere?: string };
  deviceClass?: string;
  customUnit?: string;
}

interface ThermostatView {
  id: string;
  n?: number;
  nom: string;
  parts?: { quoi?: string; precis?: string; lieu?: string; pere?: string; grandPere?: string };
  relais?: number;
  capteur?: string;
  hysteresis: number;
  consignes: Record<string, number>;
  minOn: number;
  minOff: number;
  capteurMuet: number;
  state?: { temperature?: number | null; consigne?: number; mode?: string; action?: string; defaut?: string; version?: number; moteur?: string };
}

interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'text' | 'time' | 'select';
  options?: string[];
  default?: string | number;
  min?: number;
  max?: number;
  help?: string;
}

interface TemplateView {
  id: string;
  label: string;
  description: string;
  params: ParamDef[];
}

interface ProvisionView {
  check?: { available: boolean; reason?: string; wifiInterface?: string; ethernetInterface?: string; wifiConnection?: string };
  accessPoints: Array<{ ssid: string; signal: number }>;
  running: boolean;
}

interface NetworkFound {
  mac: string;
  ip: string;
  deviceName?: string;
  topic?: string;
  mqttHost?: string;
  mqttPort?: number;
  firmware?: string;
  model?: string;
  hardware?: string;
  pins?: string[];
  known?: boolean;
}

interface NetworkStatusView {
  scanning: boolean;
  found: NetworkFound[];
  ourMqttHost?: string;
  ourMqttPort?: number;
}

interface StateView {
  connected: boolean;
  devices: DeviceView[];
  config: {
    wifi: { ssid: string; password: string };
    mqtt: { host: string; port: number };
    sites: string[];
    latitude: number;
    longitude: number;
    modes: string[];
    publishToHa: boolean;
  };
  modes: string[];
  currentMode?: string;
  templates: TemplateView[];
  deviceNameMax: number;
  models: string[];
  catalogs: { quoi: string[]; lieux: string[] };
  deviceClasses: string[];
  defaultConsignes: Record<string, number>;
  provision: ProvisionView;
}

let socket: any = null;
let state: StateView | null = null;
let selectedMac: string | null = null;
let configFilled = false;
/** Voies affichées dans la fiche : la section n'est redessinée que quand cette liste change (sinon les
 *  saisies en cours seraient effacées à chaque état reçu). */
let renderedVoies = '';
/** Thermostats de la fiche : lignes enregistrées + lignes ajoutées ; redessinés seulement si cette liste change. */
let renderedThermo = '';
let thermoRows: ThermostatView[] = [];
const thermoRemoved = new Set<string>();

// =============================================================================
// Rendu
// =============================================================================

function renderModes(): void {
  if (!state) return;
  $('modes').innerHTML = state.modes.map((m) =>
    `<button class="mode-btn${m === state!.currentMode ? ' active' : ''}" data-mode="${esc(m)}">${esc(m)}</button>`).join('');
  moduleRoot().querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) =>
    b.addEventListener('click', () => socket.emit('tasmota:mode:set:ui', { mode: b.dataset.mode })));
}

function renderDevices(): void {
  if (!state) return;
  $('conn-status').textContent = state.connected ? 'Connecté au broker MQTT du socle' : '⚠️ Broker MQTT du socle non connecté';
  $('no-device').classList.toggle('hidden', state.devices.length > 0);
  $('device-rows').innerHTML = state.devices.map((d) => {
    const dot = d.online === undefined ? '' : d.online ? 'on' : 'off';
    const content = [
      d.relays ? `${d.relays} relais` : '',
      d.shutters ? `${d.shutters} volet(s)` : '',
      d.sensors.length ? `${d.sensors.length} mesure(s)` : ''
    ].filter(Boolean).join(', ') || '—';
    const name = d.conventional
      ? esc(d.precis || d.quoi)
      // Appareil à nommer : son topic (unique, ex. tasmota_77B62C) plutôt que « Tasmota », commun à tous les neufs.
      : `<span class="badge">À nommer</span> <strong>${esc(d.topic)}</strong> <span class="muted">(${esc(d.name)})</span>`;
    return `<tr class="${d.mac === selectedMac ? 'selected' : ''}">
      <td><span class="dot ${dot}" title="${d.online ? 'En ligne' : d.online === false ? 'Hors ligne' : 'État inconnu'}"></span>${!d.online && d.lastSeen ? `<div class="muted" title="Dernière annonce">${esc(new Date(d.lastSeen).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }))}</div>` : ''}</td>
      <td>${name}<div class="muted">${esc(d.mac)}</div></td>
      <td>${esc(d.quoi ?? '')}</td>
      <td>${esc(d.lieu ?? '')}</td>
      <td>${esc(d.site)}<div class="muted">${esc(d.topic)}</div></td>
      <td>${d.ip ? `<a href="http://${esc(d.ip)}/" target="_blank" rel="noopener">${esc(d.ip)}</a>` : ''}</td>
      <td>${esc(d.model ?? '')}${d.hardware ? ` <span class="muted">(${esc(d.hardware)})</span>` : ''}<div class="muted">${esc(d.version ?? '')}</div>${d.pins ? `<div class="muted">${d.pins.length ? d.pins.map(esc).join('<br>') : 'aucune broche utilisée'}</div>` : ''}</td>
      <td>${esc(content)}${d.rules.length ? `<div class="muted">${d.rules.length} règle(s)</div>` : ''}</td>
      <td>${d.published ? '<span class="badge ok">publié</span>' : '—'}</td>
      <td><button class="btn btn-secondary" data-fiche="${esc(d.mac)}">Fiche</button></td>
    </tr>`;
  }).join('');
  moduleRoot().querySelectorAll<HTMLButtonElement>('[data-fiche]').forEach((b) =>
    b.addEventListener('click', () => openFiche(b.dataset.fiche as string)));
}

function renderCatalogs(): void {
  if (!state) return;
  $('dl-quoi').innerHTML = state.catalogs.quoi.map((q) => `<option value="${esc(q)}">`).join('');
  $('dl-lieux').innerHTML = state.catalogs.lieux.map((l) => `<option value="${esc(l)}">`).join('');
}

function currentDevice(): DeviceView | undefined {
  return state?.devices.find((d) => d.mac === selectedMac);
}

function openFiche(mac: string): void {
  selectedMac = mac;
  const d = currentDevice();
  if (!d || !state) return;
  $('fiche').classList.remove('hidden');
  $('fiche-title').textContent = `Fiche — ${d.conventional ? (d.precis || d.quoi) : `${d.topic}, à nommer`} (${d.mac})`;
  $('fiche-sub').textContent = `${d.model ?? ''} ${d.version ?? ''} — ${d.ip ?? ''} — lecture de l'appareil en cours…`;
  $<HTMLSelectElement>('f-site').innerHTML = state.config.sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  $<HTMLSelectElement>('f-model').innerHTML = state.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  $<HTMLInputElement>('f-quoi').value = d.quoi ?? '';
  $<HTMLInputElement>('f-precis').value = d.precis ?? '';
  $<HTMLInputElement>('f-lieu').value = d.lieu ?? '';
  $<HTMLInputElement>('f-pere').value = '';
  $<HTMLInputElement>('f-gp').value = '';
  $<HTMLSelectElement>('f-site').value = d.site || state.config.sites[0];
  $<HTMLInputElement>('f-topic').value = d.topic;
  $<HTMLInputElement>('f-pulse').value = '';
  $<HTMLInputElement>('f-shutter').checked = d.shutters > 0;
  renderRules(d);
  renderVoies(d);
  thermoRows = [];
  thermoRemoved.clear();
  renderThermostats(d);
  updatePreview();
  renderDevices();
  socket.emit('tasmota:device:read', { mac });
  $('fiche').scrollIntoView({ behavior: 'smooth' });
}

function onDetails(details: any): void {
  if (!details || details.mac !== selectedMac) return;
  if (details.error) {
    $('fiche-sub').textContent = `Lecture impossible : ${details.error}`;
    return;
  }
  const p = details.nameParts ?? {};
  const d = currentDevice();
  if (d?.conventional) {
    $<HTMLInputElement>('f-quoi').value = p.quoi ?? '';
    $<HTMLInputElement>('f-precis').value = p.precis ?? '';
    $<HTMLInputElement>('f-lieu').value = p.lieu ?? '';
    $<HTMLInputElement>('f-pere').value = p.pere ?? '';
    $<HTMLInputElement>('f-gp').value = p.grandPere ?? '';
  }
  if (details.site) $<HTMLSelectElement>('f-site').value = details.site;
  if (details.topic) $<HTMLInputElement>('f-topic').value = details.topic;
  if (typeof details.magicSwitchPulse === 'number') $<HTMLInputElement>('f-pulse').value = String(details.magicSwitchPulse);
  if (details.shutter) {
    $<HTMLInputElement>('f-open').value = details.shutter.open ?? '';
    $<HTMLInputElement>('f-close').value = details.shutter.close ?? '';
    $<HTMLInputElement>('f-invert').checked = String(details.shutter.invert) === '1' || details.shutter.invert === 'ON';
  }
  const rulesText = Object.entries(details.rules ?? {}).map(([k, r]: [string, any]) => `Rule${k} ${r.state}${r.text ? ` (${r.text.length} car.)` : ''}`).join(', ');
  $('fiche-sub').textContent = `Nom actuel : « ${details.deviceName} » — modèle ${details.templateName || details.module} — ${details.firmware ?? ''} — broker ${details.mqttHost ?? '?'} — ${rulesText}`;
  updatePreview();
}

function nameParts(): Record<string, string> {
  return {
    quoi: $<HTMLInputElement>('f-quoi').value.trim(),
    precis: $<HTMLInputElement>('f-precis').value.trim(),
    lieu: $<HTMLInputElement>('f-lieu').value.trim(),
    pere: $<HTMLInputElement>('f-pere').value.trim(),
    grandPere: $<HTMLInputElement>('f-gp').value.trim()
  };
}

/** Même assemblage que composeDeviceName côté serveur (taxonomy.ts). */
function composeName(p: Record<string, string>): string {
  const lieux = [p.precis || p.lieu, p.lieu, p.pere, p.grandPere];
  while (lieux.length > 2 && !lieux[lieux.length - 1]) lieux.pop();
  const segs = lieux.length === 2 && lieux[0].toLowerCase() === lieux[1].toLowerCase() ? [lieux[1]] : lieux;
  return `${p.quoi}---${segs.join('--')}`;
}

function slug(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function updatePreview(): void {
  if (!state) return;
  const p = nameParts();
  const name = p.quoi && p.lieu ? composeName(p) : '';
  const tooLong = name.length > state.deviceNameMax;
  $('f-name-preview').innerHTML = name
    ? `DeviceName : <strong>${esc(name)}</strong> (${name.length}/${state.deviceNameMax})${tooLong ? ' <span class="badge">trop long</span>' : ''}`
    : '<span class="muted">QUOI et lieu obligatoires</span>';
  const suggestion = slug([p.precis || p.quoi, p.lieu].filter(Boolean).join(' ')).slice(0, 32);
  $('f-topic-hint').textContent = suggestion ? `Proposé d'après le nom : ${suggestion}` : '';
}

const KIND_ICON: Record<string, string> = { relay: '🔌', shutter: '🪟', sensor: '🌡️' };

function renderVoies(d: DeviceView): void {
  const voies = d.voies ?? [];
  renderedVoies = voies.map((v) => v.id).join('|');
  if (!voies.length) {
    $('voies').innerHTML = '<div class="muted">Aucune voie détectée pour l’instant (relais, volet ou capteur).</div>';
    return;
  }
  const classes = state?.deviceClasses ?? [];
  $('voies').innerHTML = voies.map((v) => {
    const p = v.parts ?? {};
    const quoiPlaceholder = v.suggestedQuoi ? `${v.suggestedQuoi} (proposé)` : v.kind === 'relay' ? 'lumière, prise, moteur…' : '';
    const extra = v.kind === 'sensor' && !v.known ? `
      <label>Type de mesure <select data-voie="${esc(v.id)}" data-f="deviceClass"><option value="">— non précisé —</option>${classes.map((c) => `<option${v.deviceClass === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Unité <input data-voie="${esc(v.id)}" data-f="unit" value="${esc(v.customUnit ?? '')}" placeholder="°C, %, W…"></label>` : '';
    return `<div class="voie" data-voie-id="${esc(v.id)}">
      <h4>${KIND_ICON[v.kind] ?? ''} ${esc(v.label)}${v.sensorId ? ` <span class="muted">(capteur ${esc(v.sensorId)})</span>` : ''} ${v.nom ? '<span class="badge ok">appareil HA propre</span>' : '<span class="muted">reprend le nom du module</span>'}</h4>
      <div class="form-grid">
        <label>QUOI <input list="dl-quoi" data-voie="${esc(v.id)}" data-f="quoi" value="${esc(p.quoi ?? '')}" placeholder="${esc(quoiPlaceholder)}"></label>
        <label>Lieu précis <input list="dl-lieux" data-voie="${esc(v.id)}" data-f="precis" value="${esc(p.precis ?? '')}"></label>
        <label>Lieu (pièce) <input list="dl-lieux" data-voie="${esc(v.id)}" data-f="lieu" value="${esc(p.lieu ?? '')}"></label>
        <label>Lieu père (étage) <input list="dl-lieux" data-voie="${esc(v.id)}" data-f="pere" value="${esc(p.pere ?? '')}"></label>
        <label>Lieu grand-père <input list="dl-lieux" data-voie="${esc(v.id)}" data-f="grandPere" value="${esc(p.grandPere ?? '')}"></label>
        ${extra}
      </div>
    </div>`;
  }).join('');
  // QUOI proposé pour une mesure : rempli au clic si la case est vide (jamais écrasé).
  moduleRoot().querySelectorAll<HTMLInputElement>('input[data-f="quoi"]').forEach((input) => {
    const v = voies.find((x) => x.id === input.dataset.voie);
    if (v?.suggestedQuoi) input.addEventListener('focus', () => { if (!input.value) input.value = v.suggestedQuoi as string; });
  });
}

const ACTION_LABEL: Record<string, string> = { heating: '🔥 chauffe', idle: '💤 repos', off: '⏹ arrêt' };

function thermoSignature(d: DeviceView): string {
  return `${d.engine ?? '?'}|${(d.thermostats ?? []).map((t) => t.id).join(',')}|${thermoRows.map((t) => t.id).join(',')}`;
}

function renderThermostats(d: DeviceView): void {
  if (!state) return;
  const engine = d.engine;
  $('thermo-engine').innerHTML = engine === 'berry'
    ? '⚙️ Moteur <strong>Berry</strong> (ESP32) : le thermostat tourne <strong>dans le module</strong>, même si Home Assistant ou le réseau tombent ; durées minimales de marche et d’arrêt disponibles.'
    : engine === 'regles'
      ? '⚙️ Moteur <strong>règles</strong> (ESP8266) : plus limité — les seuils sont écrits par l’application à chaque changement de consigne ou de mode ; pas de durées minimales. <span class="badge">non essayé en réel</span>'
      : engine === 'aucun'
        ? `❌ Thermostat indisponible sur ce module : ${esc(d.engineReason ?? 'moteur absent')}.`
        : '⏳ Moteur non détecté (module hors ligne ?).';
  const usable = engine === 'berry' || engine === 'regles';
  ($('btn-thermo-add') as HTMLButtonElement).disabled = !usable;
  ($('btn-thermostats') as HTMLButtonElement).disabled = !usable;
  // Lignes : celles enregistrées, plus celles ajoutées ici et pas encore enregistrées.
  const saved = d.thermostats ?? [];
  thermoRows = [...saved, ...thermoRows.filter((r) => !saved.some((t) => t.id === r.id))];
  renderedThermo = thermoSignature(d);
  const relays = (d.voies ?? []).filter((v) => v.kind === 'relay').map((v) => ({ n: Number(v.id.replace('relais', '')), label: v.label }));
  const sensors = (d.voies ?? []).filter((v) => v.kind === 'sensor' && v.measure === 'Temperature');
  const modes = state.modes;
  $('thermostats').innerHTML = thermoRows.filter((t) => !thermoRemoved.has(t.id)).map((t) => {
    const p = t.parts ?? {};
    const c = (mode: string): number => t.consignes?.[mode] ?? state!.defaultConsignes?.[mode] ?? 19;
    const berry = engine === 'berry';
    return `<div class="voie" data-thermo-id="${esc(t.id)}">
      <h4>🌡️ ${esc(t.id.replace('thermostat', 'Thermostat '))} <span class="muted" id="th-live-${esc(t.id)}"></span>
        <button class="btn btn-secondary danger" data-thermo-del="${esc(t.id)}" style="float:right">Retirer</button></h4>
      <div class="form-grid">
        <label>QUOI <input list="dl-quoi" data-th="${esc(t.id)}" data-f="quoi" value="${esc(p.quoi ?? 'thermostat')}"></label>
        <label>Lieu précis <input list="dl-lieux" data-th="${esc(t.id)}" data-f="precis" value="${esc(p.precis ?? '')}"></label>
        <label>Lieu (pièce) <input list="dl-lieux" data-th="${esc(t.id)}" data-f="lieu" value="${esc(p.lieu ?? '')}"></label>
        <label>Lieu père (étage) <input list="dl-lieux" data-th="${esc(t.id)}" data-f="pere" value="${esc(p.pere ?? '')}"></label>
        <label>Lieu grand-père <input list="dl-lieux" data-th="${esc(t.id)}" data-f="grandPere" value="${esc(p.grandPere ?? '')}"></label>
        <label>Relais commandé <select data-th="${esc(t.id)}" data-f="relais">${relays.map((r) => `<option value="${r.n}"${t.relais === r.n ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
        <label>Thermomètre <select data-th="${esc(t.id)}" data-f="capteur">${sensors.map((x) => `<option value="${esc(x.id)}"${t.capteur === x.id ? ' selected' : ''}>${esc(x.label)}${x.sensorId ? ` (${esc(x.sensorId)})` : ''}</option>`).join('') || '<option value="">aucun thermomètre détecté</option>'}</select></label>
        <label>Marge (°C, totale) <input type="number" step="0.1" min="0.1" max="10" data-th="${esc(t.id)}" data-f="hysteresis" value="${t.hysteresis}"></label>
        ${berry ? `<label>Marche minimale (s) <input type="number" min="0" max="3600" data-th="${esc(t.id)}" data-f="minOn" value="${t.minOn}"></label>
        <label>Arrêt minimal (s) <input type="number" min="0" max="3600" data-th="${esc(t.id)}" data-f="minOff" value="${t.minOff}"></label>` : ''}
        <label>Capteur muet après (min) <input type="number" min="5" max="1440" data-th="${esc(t.id)}" data-f="capteurMuet" value="${Math.round(t.capteurMuet / 60)}"></label>
      </div>
      <div class="form-grid">${modes.map((m) => `<label>Consigne « ${esc(m)} » (°C) <input type="number" step="0.5" min="5" max="30" data-th="${esc(t.id)}" data-consigne="${esc(m)}" value="${c(m)}"></label>`).join('')}</div>
    </div>`;
  }).join('') || '<div class="muted">Aucun thermostat.</div>';
  moduleRoot().querySelectorAll<HTMLButtonElement>('[data-thermo-del]').forEach((b) => b.addEventListener('click', () => {
    thermoRemoved.add(b.dataset.thermoDel as string);
    renderThermostats(d);
  }));
  updateThermostatLive(d);
}

function updateThermostatLive(d: DeviceView): void {
  for (const t of d.thermostats ?? []) {
    const el = moduleRoot().querySelector<HTMLElement>(`#th-live-${t.id}`);
    const s = t.state;
    if (!el) continue;
    el.textContent = s
      ? `— ${s.temperature == null ? 'pas de mesure' : `${s.temperature} °C`}, consigne ${s.consigne ?? '?'} °C, ${ACTION_LABEL[s.action ?? ''] ?? s.action ?? ''}${s.defaut ? ' ⚠️ capteur muet' : ''}`
      : '— pas encore d’état reçu';
  }
}

function collectThermostats(): Record<string, Record<string, unknown> | null> {
  const rows: Record<string, Record<string, unknown> | null> = {};
  for (const t of thermoRows) {
    if (thermoRemoved.has(t.id)) { rows[t.id] = null; continue; }
    const row: Record<string, unknown> = { consignes: {} };
    moduleRoot().querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-th="${t.id}"]`).forEach((el) => {
      if (el.dataset.consigne) (row.consignes as Record<string, number>)[el.dataset.consigne] = Number(el.value);
      else if (el.dataset.f === 'capteurMuet') row.capteurMuet = Number(el.value) * 60;
      else row[el.dataset.f as string] = el.value.trim();
    });
    rows[t.id] = row;
  }
  return rows;
}

function collectVoies(): Record<string, Record<string, string>> {
  const rows: Record<string, Record<string, string>> = {};
  moduleRoot().querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-voie]').forEach((el) => {
    const id = el.dataset.voie as string;
    (rows[id] ??= {})[el.dataset.f as string] = el.value.trim();
  });
  return rows;
}

function renderRules(d: DeviceView): void {
  if (!state) return;
  const html = [1, 2, 3].map((slot) => {
    const rule = d.rules.find((r) => r.slot === slot);
    const options = [`<option value="">— aucune —</option>`]
      .concat(state!.templates.map((t) => `<option value="${esc(t.id)}"${rule?.template === t.id ? ' selected' : ''}>${esc(t.label)}</option>`)).join('');
    const modes = state!.modes.map((m) =>
      `<label><input type="checkbox" data-rule-mode="${slot}" value="${esc(m)}"${rule?.modes.includes(m) ? ' checked' : ''}> ${esc(m)}</label>`).join('');
    return `<div class="rule-slot" data-slot="${slot}">
      <div class="form-grid">
        <label>Rule${slot} <select data-rule-template="${slot}">${options}</select></label>
        <label><span><input type="checkbox" data-rule-enabled="${slot}"${rule ? (rule.enabled ? ' checked' : '') : ' checked'}> Activée</span></label>
      </div>
      <div class="muted" data-rule-desc="${slot}"></div>
      <div class="form-grid" data-rule-params="${slot}"></div>
      <div class="modes-check">Modes : ${modes}</div>
    </div>`;
  }).join('');
  $('rules').innerHTML = html;
  for (const slot of [1, 2, 3]) {
    const select = moduleRoot().querySelector<HTMLSelectElement>(`[data-rule-template="${slot}"]`)!;
    const rule = d.rules.find((r) => r.slot === slot);
    renderRuleParams(slot, select.value, rule?.params ?? {});
    select.addEventListener('change', () => renderRuleParams(slot, select.value, {}));
  }
}

function renderRuleParams(slot: number, templateId: string, values: Record<string, string | number>): void {
  const template = state?.templates.find((t) => t.id === templateId);
  const container = moduleRoot().querySelector<HTMLElement>(`[data-rule-params="${slot}"]`)!;
  moduleRoot().querySelector<HTMLElement>(`[data-rule-desc="${slot}"]`)!.textContent = template?.description ?? '';
  if (!template) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = template.params.map((p) => {
    const value = values[p.key] ?? p.default ?? '';
    const attrs = `data-rule-param="${slot}" data-key="${esc(p.key)}" title="${esc(p.help ?? '')}"`;
    const input = p.type === 'select'
      ? `<select ${attrs}>${(p.options ?? []).map((o) => `<option${String(value) === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input ${attrs} type="${p.type === 'number' ? 'number' : 'text'}" value="${esc(value)}"${p.min !== undefined ? ` min="${p.min}"` : ''}${p.max !== undefined ? ` max="${p.max}"` : ''} step="any">`;
    return `<label>${esc(p.label)} ${input}</label>`;
  }).join('');
}

function collectRules(): RuleInstance[] {
  const rules: RuleInstance[] = [];
  for (const slot of [1, 2, 3]) {
    const template = moduleRoot().querySelector<HTMLSelectElement>(`[data-rule-template="${slot}"]`)!.value;
    if (!template) continue;
    const params: Record<string, string | number> = {};
    moduleRoot().querySelectorAll<HTMLInputElement>(`[data-rule-param="${slot}"]`).forEach((el) => {
      params[el.dataset.key as string] = el.type === 'number' ? Number(el.value) : el.value;
    });
    const modes = [...moduleRoot().querySelectorAll<HTMLInputElement>(`[data-rule-mode="${slot}"]`)].filter((el) => el.checked).map((el) => el.value);
    const enabled = moduleRoot().querySelector<HTMLInputElement>(`[data-rule-enabled="${slot}"]`)!.checked;
    rules.push({ slot, template, params, modes, enabled });
  }
  return rules;
}

function renderProvision(p: ProvisionView | undefined): void {
  if (!p) return;
  const check = p.check;
  $('prov-check').innerHTML = !check
    ? 'Vérification…'
    : check.available
      ? `✅ Possible depuis cette machine : Wi-Fi ${esc(check.wifiInterface)} (${check.wifiConnection ? `connecté à « ${esc(check.wifiConnection)} », sera rétabli` : 'déconnecté, sera laissé déconnecté'}), Ethernet ${esc(check.ethernetInterface)} inchangé.`
      : `❌ Indisponible sur cette machine : ${esc(check.reason)}`;
  $('ap-list').innerHTML = p.accessPoints.map((ap) => `<div class="ap-item">
      <span>📶 <strong>${esc(ap.ssid)}</strong> <span class="muted">signal ${ap.signal} %</span></span>
      <button class="btn btn-primary" data-ap="${esc(ap.ssid)}"${p.running ? ' disabled' : ''}>Mettre en service</button>
    </div>`).join('') || (p.running ? '<div class="muted">Mise en service en cours… (voir le journal)</div>' : '');
  moduleRoot().querySelectorAll<HTMLButtonElement>('[data-ap]').forEach((b) => b.addEventListener('click', () => {
    if (!state?.config.wifi.password) {
      alert('Renseigner d’abord le Wi-Fi (nom et mot de passe) dans les paramètres.');
      return;
    }
    if (confirm(`Mettre en service ${b.dataset.ap} ?\nLe Wi-Fi de cette machine va basculer quelques secondes sur ce Tasmota, puis revenir à son état d'origine.`)) {
      socket.emit('tasmota:provision:start', { ssid: b.dataset.ap });
    }
  }));
}

function renderNetworkFound(v: NetworkStatusView | undefined): void {
  if (!v) return;
  $('btn-network-scan').textContent = v.scanning ? '🔍 Recherche en cours…' : '🔍 Rechercher les Tasmota inconnus';
  ($('btn-network-scan') as HTMLButtonElement).disabled = v.scanning;
  const list = $('network-list');
  if (v.scanning && v.found.length === 0) {
    list.innerHTML = '<div class="muted">Recherche en cours, quelques secondes…</div>';
    return;
  }
  if (v.found.length === 0) {
    list.innerHTML = '<div class="muted">Aucun : tous les Tasmota trouvés sur le réseau pointent vers notre broker.</div>';
    return;
  }
  list.innerHTML = v.found.map((d) => {
    const alreadyOurs = d.mqttHost === v.ourMqttHost && (d.mqttPort ?? 1883) === (v.ourMqttPort ?? 1883);
    const knownTag = d.known ? ' <span class="badge">déjà dans la liste</span>' : '';
    const action = alreadyOurs
      ? '<span class="muted">déjà pointé vers notre broker — apparaîtra ici sous peu s’il ne s’est pas encore reconnecté</span>'
      : `<button class="btn btn-primary" data-network-point="${esc(d.ip)}">Pointer vers notre broker</button>`;
    return `<div class="ap-item">
      <span>💡 <strong>${esc(d.deviceName || d.topic || d.mac)}</strong>${knownTag}
        <span class="muted">${esc(d.ip)} — ${esc(d.mac)} — modèle ${esc(d.model ?? '?')}${d.hardware ? ` (${esc(d.hardware)})` : ''}${d.model === 'Generic' ? ' : carte générique' : ''} — firmware ${esc(d.firmware ?? '?')} — broker actuel : ${esc(d.mqttHost || 'aucun')}${d.mqttHost ? `:${d.mqttPort ?? 1883}` : ''}</span>
      </span>
      ${action}
      ${d.pins ? `<div class="muted" style="flex-basis:100%">Contenu du modèle : ${d.pins.length ? d.pins.map(esc).join(' · ') : 'aucune broche utilisée'}</div>` : ''}
    </div>`;
  }).join('');
  moduleRoot().querySelectorAll<HTMLButtonElement>('[data-network-point]').forEach((b) => b.addEventListener('click', () => {
    if (confirm(`Pointer ${b.dataset.networkPoint} vers notre broker (${state?.config.mqtt.host}:${state?.config.mqtt.port}) ?`)) {
      socket.emit('tasmota:network:point', { ip: b.dataset.networkPoint });
    }
  }));
}

function fillConfig(): void {
  if (!state || configFilled) return;
  configFilled = true;
  const c = state.config;
  $<HTMLInputElement>('c-ssid').value = c.wifi.ssid;
  $<HTMLInputElement>('c-pass').value = c.wifi.password;
  $<HTMLInputElement>('c-host').value = c.mqtt.host;
  $<HTMLInputElement>('c-port').value = String(c.mqtt.port);
  $<HTMLInputElement>('c-sites').value = c.sites.join(', ');
  $<HTMLInputElement>('c-modes').value = c.modes.join(', ');
  $<HTMLInputElement>('c-lat').value = String(c.latitude);
  $<HTMLInputElement>('c-lon').value = String(c.longitude);
  $<HTMLInputElement>('c-publish').checked = c.publishToHa;
}

function appendLog(line: { at: string; level: string; scope?: string; message: string }): void {
  const el = $('log');
  const div = document.createElement('div');
  div.className = line.level;
  div.textContent = `${new Date(line.at).toLocaleTimeString('fr-FR')}  ${line.message}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// =============================================================================
// Actions
// =============================================================================

function bindActions(): void {
  ['f-quoi', 'f-precis', 'f-lieu', 'f-pere', 'f-gp'].forEach((id) => $(id).addEventListener('input', updatePreview));
  $('btn-apply').addEventListener('click', () => {
    if (!selectedMac) return;
    const shutter = $<HTMLInputElement>('f-shutter').checked;
    const d = currentDevice();
    const payload = {
      mac: selectedMac,
      name: nameParts(),
      topic: $<HTMLInputElement>('f-topic').value.trim(),
      site: $<HTMLSelectElement>('f-site').value,
      model: $<HTMLSelectElement>('f-model').value,
      magicSwitchPulse: $<HTMLInputElement>('f-pulse').value.trim() || null,
      // Le volet n'est (ré)appliqué que si la case est cochée : décocher ne défait pas un volet existant.
      shutter: shutter ? { enabled: true, open: $<HTMLInputElement>('f-open').value, close: $<HTMLInputElement>('f-close').value, invert: $<HTMLInputElement>('f-invert').checked } : undefined
    };
    const extra = payload.model !== 'ne pas changer' ? '\nLe modèle sera changé (redémarrage).' : '';
    if (confirm(`Appliquer à ${d?.ip ?? selectedMac} ?\nNom : ${composeName(payload.name)}${extra}`)) {
      socket.emit('tasmota:device:apply', payload);
    }
  });
  $('btn-read').addEventListener('click', () => selectedMac && socket.emit('tasmota:device:read', { mac: selectedMac }));
  $('btn-identify').addEventListener('click', () => selectedMac && socket.emit('tasmota:device:action', { mac: selectedMac, action: 'identify' }));
  $('btn-upgrade').addEventListener('click', () => {
    if (selectedMac && confirm('Lancer la mise à jour du firmware (OTA) ? L’appareil redémarre.')) socket.emit('tasmota:device:action', { mac: selectedMac, action: 'upgrade' });
  });
  $('btn-reset').addEventListener('click', () => {
    if (selectedMac && confirm('Remise d’usine : tous les réglages (Wi-Fi compris) sont effacés, l’appareil redevient neuf. Continuer ?')) {
      socket.emit('tasmota:device:action', { mac: selectedMac, action: 'reset' });
    }
  });
  $('btn-forget').addEventListener('click', () => {
    if (selectedMac && confirm('Oublier cet appareil (retiré de la liste et de Home Assistant) ?')) {
      socket.emit('tasmota:device:forget', { mac: selectedMac });
      selectedMac = null;
      $('fiche').classList.add('hidden');
    }
  });
  $('btn-thermo-add').addEventListener('click', () => {
    const d = currentDevice();
    if (!d) return;
    const taken = [...(d.thermostats ?? []), ...thermoRows].map((t) => Number(t.id.replace('thermostat', '')));
    const id = `thermostat${Math.max(0, ...taken) + 1}`;
    const firstRelay = (d.voies ?? []).find((v) => v.kind === 'relay');
    const firstSensor = (d.voies ?? []).find((v) => v.kind === 'sensor' && v.measure === 'Temperature');
    thermoRows.push({ id, nom: '', relais: firstRelay ? Number(firstRelay.id.replace('relais', '')) : 1, capteur: firstSensor?.id, hysteresis: 0.5, consignes: {}, minOn: 180, minOff: 180, capteurMuet: 1800 });
    renderThermostats(d);
  });
  $('btn-thermostats').addEventListener('click', () => {
    if (selectedMac) socket.emit('tasmota:thermostats:save', { mac: selectedMac, thermostats: collectThermostats() });
  });
  $('btn-voies').addEventListener('click', () => {
    if (selectedMac) socket.emit('tasmota:voies:save', { mac: selectedMac, voies: collectVoies() });
  });
  $('btn-rules').addEventListener('click', () => {
    if (!selectedMac) return;
    socket.emit('tasmota:rules:save', { mac: selectedMac, rules: collectRules() });
  });
  $('btn-network-scan').addEventListener('click', () => socket.emit('tasmota:network:scan'));
  $('btn-config').addEventListener('click', () => {
    const list = (id: string) => $<HTMLInputElement>(id).value.split(',').map((s) => s.trim()).filter(Boolean);
    socket.emit('tasmota:config:save', {
      config: {
        wifi: { ssid: $<HTMLInputElement>('c-ssid').value.trim(), password: $<HTMLInputElement>('c-pass').value },
        mqtt: { host: $<HTMLInputElement>('c-host').value.trim(), port: Number($<HTMLInputElement>('c-port').value) },
        sites: list('c-sites'),
        modes: list('c-modes'),
        latitude: Number($<HTMLInputElement>('c-lat').value),
        longitude: Number($<HTMLInputElement>('c-lon').value),
        publishToHa: $<HTMLInputElement>('c-publish').checked
      }
    });
    configFilled = false;
  });
}

function init(): void {
  socket = (window as any).app.socketService.getSocket();
  socket.on('tasmota:state', (s: StateView) => {
    state = s;
    renderModes();
    renderDevices();
    renderCatalogs();
    // Voies : redessinées seulement si la liste des voies de l'appareil ouvert a changé (capteur détecté).
    const open = currentDevice();
    if (open && !$('fiche').classList.contains('hidden') && (open.voies ?? []).map((v) => v.id).join('|') !== renderedVoies) renderVoies(open);
    // Thermostats : liste redessinée seulement si elle change (moteur détecté, thermostat ajouté) ; sinon l'état en direct.
    if (open && !$('fiche').classList.contains('hidden')) {
      if (thermoSignature(open) !== renderedThermo && !thermoRows.some((r) => !(open.thermostats ?? []).some((t) => t.id === r.id))) {
        thermoRows = [];
        renderThermostats(open);
      } else {
        updateThermostatLive(open);
      }
    }
    renderProvision(s.provision);
    fillConfig();
  });
  socket.on('tasmota:device:details', onDetails);
  socket.on('tasmota:log', appendLog);
  socket.on('tasmota:provision:status', (p: ProvisionView) => {
    if (state) state.provision = p;
    renderProvision(p);
  });
  socket.on('tasmota:network:status', renderNetworkFound);
  bindActions();
  socket.emit('tasmota:state:get');
  socket.emit('tasmota:provision:check', {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
