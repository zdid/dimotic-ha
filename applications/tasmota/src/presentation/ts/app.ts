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
  provision: ProvisionView;
}

let socket: any = null;
let state: StateView | null = null;
let selectedMac: string | null = null;
let configFilled = false;

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
      : `<span class="badge">À nommer</span> <span class="muted">${esc(d.name)}</span>`;
    return `<tr class="${d.mac === selectedMac ? 'selected' : ''}">
      <td><span class="dot ${dot}" title="${d.online ? 'En ligne' : d.online === false ? 'Hors ligne' : 'État inconnu'}"></span></td>
      <td>${name}<div class="muted">${esc(d.mac)}</div></td>
      <td>${esc(d.quoi ?? '')}</td>
      <td>${esc(d.lieu ?? '')}</td>
      <td>${esc(d.site)}<div class="muted">${esc(d.topic)}</div></td>
      <td>${d.ip ? `<a href="http://${esc(d.ip)}/" target="_blank" rel="noopener">${esc(d.ip)}</a>` : ''}</td>
      <td>${esc(d.model ?? '')}<div class="muted">${esc(d.version ?? '')}</div></td>
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
  $('fiche-title').textContent = `Fiche — ${d.conventional ? (d.precis || d.quoi) : 'appareil à nommer'} (${d.mac})`;
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
  ($('btn-scan') as HTMLButtonElement).disabled = !check?.available || p.running;
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
  $('btn-rules').addEventListener('click', () => {
    if (!selectedMac) return;
    socket.emit('tasmota:rules:save', { mac: selectedMac, rules: collectRules() });
  });
  $('btn-scan').addEventListener('click', () => {
    $('prov-check').textContent = 'Recherche Wi-Fi en cours…';
    socket.emit('tasmota:provision:check', { scan: true });
  });
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
    renderProvision(s.provision);
    fillConfig();
  });
  socket.on('tasmota:device:details', onDetails);
  socket.on('tasmota:log', appendLog);
  socket.on('tasmota:provision:status', (p: ProvisionView) => {
    if (state) state.provision = p;
    renderProvision(p);
  });
  bindActions();
  socket.emit('tasmota:state:get');
  socket.emit('tasmota:provision:check', {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
