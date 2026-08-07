/**
 * Script TypeScript pour la page de configuration RFXCOM (Devices & Récepteurs).
 */

// SocketService : URL réellement servie par le socle (core la compile déjà en JS navigateur
// et l'expose via son middleware /js/ts) — pas un chemin de fichier TypeScript, un import
// d'exécution résolu par le navigateur lui-même. Voir presentation/tsconfig.ui.json.
import { SocketService } from '/js/ts/services/SocketService.js';

// ============================================================================
// Types (miroir simplifié de domain/types.ts, pour l'UI uniquement)
// ============================================================================

interface RfxComDeviceInfo {
  uniqueId: string;
  sensorId: string;
  type: string;
  subType: string;
  protocole: string;
  name: string;
  defaultQuoi: string;
  transmitToHa: boolean;
  lastSeen?: string;
}

interface RfxComDiscoveredDevice {
  sensorId: string;
  type: string;
  subType: string;
  uniqueId: string;
  defaultQuoi: string;
  detectedAt: string;
}

interface AssociatedEmitter {
  emitterId: string;
  action: string;
  value?: number;
}

interface ReceiverConfig {
  receiverId: string;
  name: string;
  type: 'switch' | 'light' | 'cover' | 'scene';
  primaryEmitter: string;
  emitters: AssociatedEmitter[];
  transmitToHa: boolean;
  isDimmable?: boolean;
  defaultLevel?: number;
  coverType?: string;
  openTimeSec?: number;
  closeTimeSec?: number;
}

interface SceneAction {
  target: string;
  command: string;
  value?: number;
  delayMs?: number;
}

interface ReceiverSceneConfig {
  receiverId: string;
  name: string;
  type: 'scene';
  description?: string;
  sceneType: 'parallel' | 'sequential';
  delayBetweenCommands?: number;
  actions: SceneAction[];
  transmitToHa: boolean;
}

interface SceneExecutionResult {
  sceneId: string;
  success: boolean;
  executedCommands: number;
  failedCommands: number;
  errors: Array<{ receiverId: string; action: string; error: string }>;
  duration: number;
}

const SCENE_COMMANDS = ['turn_on', 'turn_off', 'toggle', 'set_level', 'open', 'close', 'stop', 'set_position'];

// ============================================================================
// Taxonomie QUOI/OÙ — miroir client de domain/taxonomy.ts (extractTaxonomy), pour scinder le
// champ `name` (format `quoi---lieu_precis--lieu--pere--grand_pere`) en 5 entrées éditables
// séparément, comme pour EVOO7.
// ============================================================================

interface SplitTaxonomy {
  quoi: string;
  lieuPrecis: string;
  lieu: string;
  pere: string;
  grandPere: string;
}

function splitTaxonomyName(fullName: string): SplitTaxonomy {
  const parts = (fullName || '').split('---');
  const quoi = (parts[0] || '').trim();
  const lieux = parts[1] ? parts[1].split('--').map((s) => s.trim()) : [];
  return {
    quoi,
    lieuPrecis: lieux[0] || '',
    lieu: lieux.length > 1 ? (lieux[1] || '') : (lieux[0] || ''),
    pere: lieux[2] || '',
    grandPere: lieux[3] || ''
  };
}

function composeTaxonomyName(t: SplitTaxonomy): string {
  let out = `${t.quoi}---${t.lieuPrecis}`;
  for (const seg of [t.lieu, t.pere, t.grandPere]) {
    if (seg) out += `--${seg}`;
  }
  return out;
}

/**
 * Libellé lisible pour un device dans une liste déroulante d'émetteur — la taxonomie scindée
 * (quoi + lieux), pas le uniqueId brut ni le name avec ses séparateurs `---`/`--`, sinon on ne
 * sait pas de quoi il s'agit en choisissant un émetteur appairé.
 */
function formatDeviceLabel(d: RfxComDeviceInfo): string {
  const t = splitTaxonomyName(d.name);
  const lieux = [t.lieuPrecis, t.lieu, t.pere, t.grandPere].filter(Boolean).join(' — ');
  return `${t.quoi || d.uniqueId}${lieux ? ' · ' + lieux : ''} (${d.uniqueId})`;
}

// ============================================================================
// État
// ============================================================================

let socket: any | null = null;
let configuredDevices: RfxComDeviceInfo[] = [];
let discoveredDevices: RfxComDiscoveredDevice[] = [];
let receivers: ReceiverConfig[] = [];
let editingReceiverId: string | null = null;
let editingDeviceUniqueId: string | null = null;
let scenes: ReceiverSceneConfig[] = [];
let editingSceneId: string | null = null;
/** Statut matériel RFXtrx433 (miroir de RfxComTransceiver.RfxComHardwareStatus) — null tant que non reçu. */
interface RfxComHardwareStatus {
  receiverType: string;
  firmwareVersion: number;
  firmwareType: string;
  enabledProtocols: string[];
}
let hardwareStatus: RfxComHardwareStatus | null = null;
/** Catalogue + sélection de protocoles matériel (granularité X10/ARC/AC/OREGON/...), poussés au RFXtrx433 en une seule fois via le bouton dédié (RAM, pas d'écriture EEPROM). */
let hardwareAvailableProtocols: string[] = [];
let hardwareEnabledProtocols: string[] = [];

// ============================================================================
// Initialisation
// ============================================================================

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  setupSocketListeners();
  setupUiListeners();

  socket.emit('rfxcom:devices:list:get');
  socket.emit('rfxcom:receivers:list:get');
  socket.emit('rfxcom:scenes:list:get');
  socket.emit('rfxcom:protocols:list:get');

  hideLoading();
}

function setupSocketListeners(): void {
  socket.on('rfxcom:devices:list', (data: { configured: RfxComDeviceInfo[]; discovered: RfxComDiscoveredDevice[] }) => {
    configuredDevices = data.configured;
    discoveredDevices = data.discovered;
    renderConfiguredDevices();
    renderDiscoveredDevices();
    renderPrimaryEmitterOptions();
  });

  socket.on('rfxcom:device:detected', () => {
    socket.emit('rfxcom:devices:list:get');
  });

  socket.on('rfxcom:device:deleted', () => showAlert('Device supprimé', 'success'));

  socket.on('rfxcom:receivers:list', (data: { receivers: ReceiverConfig[] }) => {
    receivers = data.receivers;
    renderReceivers();
  });

  socket.on('rfxcom:receiver:created', () => showAlert('Récepteur créé', 'success'));
  socket.on('rfxcom:receiver:updated', () => showAlert('Récepteur mis à jour', 'success'));
  socket.on('rfxcom:receiver:deleted', () => showAlert('Récepteur supprimé', 'success'));

  socket.on('rfxcom:scan:complete', () => showAlert('Scan terminé', 'info'));
  socket.on('rfxcom:scan:failed', (data: { error: string }) => showAlert(`Scan échoué: ${data.error}`, 'error'));
  socket.on('rfxcom:error', (error: { message: string }) => showAlert(error.message, 'error'));

  socket.on('rfxcom:scenes:list', (data: { scenes: ReceiverSceneConfig[] }) => {
    scenes = data.scenes;
    renderScenes();
  });

  socket.on('rfxcom:scene:created', () => showAlert('Scène créée', 'success'));
  socket.on('rfxcom:scene:updated', () => showAlert('Scène mise à jour', 'success'));
  socket.on('rfxcom:scene:deleted', () => showAlert('Scène supprimée', 'success'));
  socket.on('rfxcom:scene:status', (data: { sceneId: string; status: string }) => {
    if (data.status === 'scene_executing') showAlert(`Scène ${data.sceneId} en cours d'exécution...`, 'info');
  });
  socket.on('rfxcom:scene:executed', (result: SceneExecutionResult) => {
    showAlert(
      result.success
        ? `Scène ${result.sceneId} exécutée (${result.executedCommands} commande(s))`
        : `Scène ${result.sceneId}: ${result.failedCommands} commande(s) en échec sur ${result.executedCommands + result.failedCommands}`,
      result.success ? 'success' : 'error'
    );
  });

  socket.on('rfxcom:protocols:list', (data: {
    hardware: RfxComHardwareStatus | null;
    hardwareAvailable: string[]; hardwareEnabled: string[];
  }) => {
    hardwareStatus = data.hardware;
    hardwareAvailableProtocols = data.hardwareAvailable;
    hardwareEnabledProtocols = data.hardwareEnabled;
    renderProtocols();
  });
}

// ============================================================================
// Onglets
// ============================================================================

function setupUiListeners(): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
    });
  });

  document.getElementById('btn-scan')?.addEventListener('click', () => {
    socket.emit('rfxcom:scan:start');
    showAlert('Scan RF433 démarré — actionnez le device à détecter', 'info');
  });

  document.getElementById('btn-clear-unconfigured')?.addEventListener('click', () => {
    if (!confirm('Effacer tous les devices auto-découverts non paramétrés ?')) return;
    socket.emit('rfxcom:devices:clear-unconfigured');
  });

  document.getElementById('btn-refresh-devices')?.addEventListener('click', () => {
    socket.emit('rfxcom:devices:refresh');
    socket.emit('rfxcom:devices:list:get');
  });

  document.getElementById('dv-cancel')?.addEventListener('click', closeDeviceModal);
  document.getElementById('dv-save')?.addEventListener('click', saveDeviceModal);

  document.getElementById('btn-add-receiver')?.addEventListener('click', () => openReceiverForm(null));
  document.getElementById('rf-cancel')?.addEventListener('click', closeReceiverForm);
  document.getElementById('rf-save')?.addEventListener('click', saveReceiver);
  document.getElementById('rf-add-emitter')?.addEventListener('click', () => addEmitterRow());

  document.getElementById('rf-type')?.addEventListener('change', updateTypeSpecificFields);

  document.getElementById('btn-add-scene')?.addEventListener('click', () => openSceneForm(null));
  document.getElementById('sc-cancel')?.addEventListener('click', closeSceneForm);
  document.getElementById('sc-save')?.addEventListener('click', saveScene);
  document.getElementById('sc-add-action')?.addEventListener('click', () => addActionRow());

  // Clic sur l'arrière-plan (pas sur la carte elle-même) = fermer la modale, comme Annuler.
  document.getElementById('device-modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDeviceModal(); });
  document.getElementById('receiver-modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeReceiverForm(); });
  document.getElementById('scene-modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSceneForm(); });

  // Délégation d'événements pour les boutons générés dynamiquement
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest('[data-action]')?.getAttribute('data-action');
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    if (!action) return;

    if (action === 'edit-device' && id) return openDeviceModal(id);
    if (action === 'toggle-transmit' && id) return toggleDeviceTransmit(id);
    if (action === 'delete-device' && id) return deleteDevice(id);
    if (action === 'edit-receiver' && id) return openReceiverForm(id);
    if (action === 'delete-receiver' && id) return deleteReceiver(id);
    if (action === 'remove-emitter-row') {
      target.closest('.emitter-row')?.remove();
      return;
    }
    if (action === 'edit-scene' && id) return openSceneForm(id);
    if (action === 'delete-scene' && id) return deleteScene(id);
    if (action === 'execute-scene' && id) return executeScene(id);
    if (action === 'cancel-scene' && id) return cancelScene(id);
    if (action === 'remove-action-row') {
      target.closest('.emitter-row')?.remove();
      return;
    }
    if (action === 'toggle-hardware-protocol' && id) return toggleHardwareProtocol(id);
    if (action === 'push-hardware-protocols') return pushHardwareProtocols();
    if (action === 'refresh-hardware-status') return refreshHardwareStatus();
  });
}

// ============================================================================
// Devices
// ============================================================================

function renderConfiguredDevices(): void {
  const body = document.getElementById('configured-devices-body');
  if (!body) return;

  body.innerHTML = configuredDevices.map((d) => {
    const t = splitTaxonomyName(d.name);
    return `
    <div class="receiver-item">
      <div class="icon-col">
        <button class="btn btn-secondary" data-action="edit-device" data-id="${escapeHtml(d.uniqueId)}">✏️</button>
        <button class="btn btn-danger" data-action="delete-device" data-id="${escapeHtml(d.uniqueId)}">🗑️</button>
      </div>
      <div class="content-col">
        <div class="line1"><strong>${escapeHtml(t.quoi)} — ${escapeHtml(t.lieuPrecis)} / ${escapeHtml(t.lieu)} / ${escapeHtml(t.pere)} / ${escapeHtml(t.grandPere)}</strong></div>
        <div class="line2">
          <span class="mono">${escapeHtml(d.uniqueId)}</span>
          &middot; Vers HA: <input type="checkbox" data-action="toggle-transmit" data-id="${escapeHtml(d.uniqueId)}" ${d.transmitToHa ? 'checked' : ''}>
          &middot; Dernière réception: ${d.lastSeen ? new Date(d.lastSeen).toLocaleString('fr-FR') : '--'}
        </div>
      </div>
    </div>
  `;
  }).join('') || '<p>Aucun device paramétré</p>';
}

function renderDiscoveredDevices(): void {
  const body = document.getElementById('discovered-devices-body');
  if (!body) return;

  body.innerHTML = discoveredDevices.map((d) => `
    <div class="receiver-item">
      <div class="icon-col">
        <button class="btn btn-primary" data-action="edit-device" data-id="${escapeHtml(d.uniqueId)}">✏️</button>
      </div>
      <div class="content-col">
        <div class="line1"><strong>${escapeHtml(d.defaultQuoi)}</strong></div>
        <div class="line2">
          <span class="mono">${escapeHtml(d.uniqueId)}</span>
          &middot; Détecté à: ${new Date(d.detectedAt).toLocaleString('fr-FR')}
        </div>
      </div>
    </div>
  `).join('') || '<p>Aucun device en auto-découverte</p>';
}

/** Ouvre la modale de taxonomie pour un device configuré OU en auto-découverte (même mécanisme). */
function openDeviceModal(uniqueId: string): void {
  editingDeviceUniqueId = uniqueId;
  const overlay = document.getElementById('device-modal-overlay');
  const title = document.getElementById('device-form-title');
  if (!overlay) return;

  const existing = configuredDevices.find((d) => d.uniqueId === uniqueId);
  const discovered = discoveredDevices.find((d) => d.uniqueId === uniqueId);
  const t = existing ? splitTaxonomyName(existing.name) : { quoi: discovered?.defaultQuoi || '', lieuPrecis: '', lieu: '', pere: '', grandPere: '' };

  if (title) title.textContent = existing ? `Modifier ${uniqueId}` : `Paramétrer ${uniqueId}`;
  setValue('dv-uniqueId', uniqueId);
  setValue('dv-taxo-quoi', t.quoi);
  setValue('dv-taxo-lieuprecis', t.lieuPrecis);
  setValue('dv-taxo-lieu', t.lieu);
  setValue('dv-taxo-pere', t.pere);
  setValue('dv-taxo-grandpere', t.grandPere);

  overlay.classList.add('active');
}

function closeDeviceModal(): void {
  document.getElementById('device-modal-overlay')?.classList.remove('active');
  editingDeviceUniqueId = null;
}

function saveDeviceModal(): void {
  if (!editingDeviceUniqueId) return;

  const t: SplitTaxonomy = {
    quoi: getValue('dv-taxo-quoi').trim(),
    lieuPrecis: getValue('dv-taxo-lieuprecis').trim(),
    lieu: getValue('dv-taxo-lieu').trim(),
    pere: getValue('dv-taxo-pere').trim(),
    grandPere: getValue('dv-taxo-grandpere').trim()
  };

  if (!t.quoi) {
    showAlert('Le champ "Quoi" est requis', 'error');
    return;
  }

  socket.emit('rfxcom:device:set_name', { uniqueId: editingDeviceUniqueId, name: composeTaxonomyName(t) });
  showAlert(`Device "${editingDeviceUniqueId}" mis à jour`, 'success');
  closeDeviceModal();
}

function toggleDeviceTransmit(uniqueId: string): void {
  const device = configuredDevices.find((d) => d.uniqueId === uniqueId);
  if (!device) return;
  socket.emit('rfxcom:device:set_transmit', { uniqueId, transmitToHa: !device.transmitToHa });
}

function deleteDevice(uniqueId: string): void {
  if (!confirm(`Supprimer le device ${uniqueId} ?`)) return;
  socket.emit('rfxcom:device:delete', { uniqueId });
}

// ============================================================================
// Récepteurs
// ============================================================================

/** Libellé lisible pour un émetteur référencé par uniqueId (récepteur.primaryEmitter/emitters). */
function emitterLabel(uniqueId: string): string {
  const device = configuredDevices.find((d) => d.uniqueId === uniqueId);
  return device ? formatDeviceLabel(device) : uniqueId;
}

function renderReceivers(): void {
  const listEl = document.getElementById('receivers-list');
  if (!listEl) return;

  listEl.innerHTML = receivers.map((r) => `
    <div class="receiver-item">
      <div class="icon-col">
        <button class="btn btn-secondary" data-action="edit-receiver" data-id="${escapeHtml(r.receiverId)}">✏️</button>
        <button class="btn btn-danger" data-action="delete-receiver" data-id="${escapeHtml(r.receiverId)}">🗑️</button>
      </div>
      <div class="content-col">
        <div class="line1"><strong>${escapeHtml(r.name)}</strong></div>
        <div class="line2">${escapeHtml(r.receiverId)} (${escapeHtml(r.type)})</div>
        <div>Émetteur principal : ${escapeHtml(emitterLabel(r.primaryEmitter))}</div>
        <div>Vers HA: <span class="badge ${r.transmitToHa ? 'on' : 'off'}">${r.transmitToHa ? 'oui' : 'non'}</span></div>
        <div>Émetteurs appairés: ${r.emitters.map((e) => `${escapeHtml(emitterLabel(e.emitterId))} (${escapeHtml(e.action)})`).join(', ') || 'aucun'}</div>
      </div>
    </div>
  `).join('') || '<p>Aucun récepteur configuré</p>';
}

function renderPrimaryEmitterOptions(): void {
  const select = document.getElementById('rf-primaryEmitter') as HTMLSelectElement | null;
  if (!select) return;

  // Seuls les devices de type Lighting*/Blinds1 sont des émetteurs commandables
  const emitters = configuredDevices.filter((d) => d.type.startsWith('Lighting') || d.type === 'Blinds1');
  select.innerHTML = emitters.map((d) => `<option value="${escapeHtml(d.uniqueId)}">${escapeHtml(formatDeviceLabel(d))}</option>`).join('');
}

function openReceiverForm(receiverId: string | null): void {
  editingReceiverId = receiverId;
  const overlay = document.getElementById('receiver-modal-overlay');
  const title = document.getElementById('receiver-form-title');
  if (!overlay) return;

  overlay.classList.add('active');
  renderPrimaryEmitterOptions();

  const existing = receiverId ? receivers.find((r) => r.receiverId === receiverId) : null;

  if (title) title.textContent = existing ? `Modifier ${existing.receiverId}` : 'Nouveau récepteur';

  setValue('rf-receiverId', existing?.receiverId || `recepteur_${String(receivers.length + 1).padStart(3, '0')}`);
  (document.getElementById('rf-receiverId') as HTMLInputElement).disabled = !!existing;
  const t = splitTaxonomyName(existing?.name || '');
  setValue('rf-taxo-quoi', t.quoi);
  setValue('rf-taxo-lieuprecis', t.lieuPrecis);
  setValue('rf-taxo-lieu', t.lieu);
  setValue('rf-taxo-pere', t.pere);
  setValue('rf-taxo-grandpere', t.grandPere);
  setValue('rf-type', existing?.type || 'switch');
  setValue('rf-primaryEmitter', existing?.primaryEmitter || '');
  setChecked('rf-isDimmable', existing?.isDimmable || false);
  setValue('rf-defaultLevel', String(existing?.defaultLevel ?? 100));
  setValue('rf-coverType', existing?.coverType || 'Curtain1');
  setValue('rf-openTimeSec', String(existing?.openTimeSec ?? ''));
  setValue('rf-closeTimeSec', String(existing?.closeTimeSec ?? ''));
  setChecked('rf-transmitToHa', existing?.transmitToHa || false);

  const emittersContainer = document.getElementById('rf-emitters-container');
  if (emittersContainer) {
    emittersContainer.innerHTML = '';
    (existing?.emitters || []).forEach((e) => addEmitterRow(e));
    if (!existing) addEmitterRow();
  }

  updateTypeSpecificFields();
}

function closeReceiverForm(): void {
  document.getElementById('receiver-modal-overlay')?.classList.remove('active');
  editingReceiverId = null;
}

function updateTypeSpecificFields(): void {
  const type = getValue('rf-type');
  document.getElementById('rf-light-fields')?.classList.toggle('hidden', type !== 'light');
  document.getElementById('rf-cover-fields')?.classList.toggle('hidden', type !== 'cover');
}

function addEmitterRow(existing?: AssociatedEmitter): void {
  const container = document.getElementById('rf-emitters-container');
  if (!container) return;

  const emitterOptions = configuredDevices
    .filter((d) => d.type.startsWith('Lighting') || d.type === 'Blinds1')
    .map((d) => `<option value="${escapeHtml(d.uniqueId)}" ${existing?.emitterId === d.uniqueId ? 'selected' : ''}>${escapeHtml(formatDeviceLabel(d))}</option>`)
    .join('');

  const row = document.createElement('div');
  row.className = 'emitter-row';
  row.innerHTML = `
    <select class="select-control emitter-id">${emitterOptions}</select>
    <select class="select-control emitter-action">
      ${['toggle', 'on', 'off', 'set_level', 'open', 'close', 'stop'].map((a) =>
        `<option value="${a}" ${existing?.action === a ? 'selected' : ''}>${a}</option>`).join('')}
    </select>
    <input type="number" class="form-control emitter-value" placeholder="valeur (set_level)" min="0" max="100" value="${existing?.value ?? ''}">
    <button type="button" class="btn btn-danger" data-action="remove-emitter-row">✕</button>
  `;
  container.appendChild(row);
}

function saveReceiver(): void {
  const receiverId = getValue('rf-receiverId').trim();
  const taxoQuoi = getValue('rf-taxo-quoi').trim();
  const name = composeTaxonomyName({
    quoi: taxoQuoi,
    lieuPrecis: getValue('rf-taxo-lieuprecis').trim(),
    lieu: getValue('rf-taxo-lieu').trim(),
    pere: getValue('rf-taxo-pere').trim(),
    grandPere: getValue('rf-taxo-grandpere').trim()
  });
  const type = getValue('rf-type') as ReceiverConfig['type'];
  const primaryEmitter = getValue('rf-primaryEmitter');

  if (!receiverId || !taxoQuoi || !primaryEmitter) {
    showAlert('Identifiant, nom et émetteur principal sont requis', 'error');
    return;
  }

  const emitters: AssociatedEmitter[] = Array.from(document.querySelectorAll('#rf-emitters-container .emitter-row')).map((row) => {
    const emitterId = (row.querySelector('.emitter-id') as HTMLSelectElement).value;
    const action = (row.querySelector('.emitter-action') as HTMLSelectElement).value;
    const valueStr = (row.querySelector('.emitter-value') as HTMLInputElement).value;
    return { emitterId, action, value: valueStr ? Number(valueStr) : undefined };
  }).filter((e) => e.emitterId);

  const config: ReceiverConfig = {
    receiverId,
    name,
    type,
    primaryEmitter,
    emitters,
    transmitToHa: isChecked('rf-transmitToHa')
  };

  if (type === 'light') {
    config.isDimmable = isChecked('rf-isDimmable');
    config.defaultLevel = Number(getValue('rf-defaultLevel') || 100);
  }
  if (type === 'cover') {
    config.coverType = getValue('rf-coverType');
    config.openTimeSec = Number(getValue('rf-openTimeSec'));
    config.closeTimeSec = Number(getValue('rf-closeTimeSec'));
    if (!config.openTimeSec || !config.closeTimeSec) {
      showAlert('Les temps d\'ouverture/fermeture sont obligatoires pour un cover', 'error');
      return;
    }
  }

  if (editingReceiverId) {
    socket.emit('rfxcom:receiver:update', { receiverId: editingReceiverId, config });
  } else {
    socket.emit('rfxcom:receiver:create', { config });
  }

  closeReceiverForm();
}

function deleteReceiver(receiverId: string): void {
  if (!confirm(`Supprimer le récepteur ${receiverId} ?`)) return;
  socket.emit('rfxcom:receiver:delete', { receiverId });
}

// ============================================================================
// Scènes
// ============================================================================

function renderScenes(): void {
  const listEl = document.getElementById('scenes-list');
  if (!listEl) return;

  listEl.innerHTML = scenes.map((s) => `
    <div class="receiver-item">
      <div class="icon-col">
        <button class="btn btn-primary" data-action="execute-scene" data-id="${escapeHtml(s.receiverId)}">▶️</button>
        <button class="btn btn-secondary" data-action="cancel-scene" data-id="${escapeHtml(s.receiverId)}">⏹️</button>
        <button class="btn btn-secondary" data-action="edit-scene" data-id="${escapeHtml(s.receiverId)}">✏️</button>
        <button class="btn btn-danger" data-action="delete-scene" data-id="${escapeHtml(s.receiverId)}">🗑️</button>
      </div>
      <div class="content-col">
        <div class="line1"><strong>${escapeHtml(s.receiverId)}</strong> (${escapeHtml(s.sceneType)})</div>
        <div class="line2">${escapeHtml(s.name)}</div>
        ${s.description ? `<div>${escapeHtml(s.description)}</div>` : ''}
        <div>Vers HA: <span class="badge ${s.transmitToHa ? 'on' : 'off'}">${s.transmitToHa ? 'oui' : 'non'}</span></div>
        <div>Commandes: ${s.actions.map((a) => `<span class="mono">${escapeHtml(a.target)}</span> → ${escapeHtml(a.command)}${a.value !== undefined ? `(${a.value})` : ''}`).join(', ') || 'aucune'}</div>
      </div>
    </div>
  `).join('') || '<p>Aucune scène configurée</p>';
}

function openSceneForm(sceneId: string | null): void {
  editingSceneId = sceneId;
  const overlay = document.getElementById('scene-modal-overlay');
  const title = document.getElementById('scene-form-title');
  if (!overlay) return;

  overlay.classList.add('active');

  const existing = sceneId ? scenes.find((s) => s.receiverId === sceneId) : null;

  if (title) title.textContent = existing ? `Modifier ${existing.receiverId}` : 'Nouvelle scène';

  setValue('sc-sceneId', existing?.receiverId || `scene_${String(scenes.length + 1).padStart(3, '0')}`);
  (document.getElementById('sc-sceneId') as HTMLInputElement).disabled = !!existing;
  setValue('sc-name', existing?.name || '');
  setValue('sc-description', existing?.description || '');
  setValue('sc-sceneType', existing?.sceneType || 'sequential');
  setValue('sc-delayBetweenCommands', String(existing?.delayBetweenCommands ?? 500));
  setChecked('sc-transmitToHa', existing?.transmitToHa || false);

  const actionsContainer = document.getElementById('sc-actions-container');
  if (actionsContainer) {
    actionsContainer.innerHTML = '';
    (existing?.actions || []).forEach((a) => addActionRow(a));
    if (!existing) addActionRow();
  }

}

function closeSceneForm(): void {
  document.getElementById('scene-modal-overlay')?.classList.remove('active');
  editingSceneId = null;
}

function addActionRow(existing?: SceneAction): void {
  const container = document.getElementById('sc-actions-container');
  if (!container) return;

  const targetOptions = receivers
    .filter((r) => r.type !== 'scene')
    .map((r) => `<option value="${escapeHtml(r.receiverId)}" ${existing?.target === r.receiverId ? 'selected' : ''}>${escapeHtml(r.receiverId)} (${escapeHtml(r.name)})</option>`)
    .join('');

  const row = document.createElement('div');
  row.className = 'emitter-row';
  row.innerHTML = `
    <select class="select-control action-target">${targetOptions}</select>
    <select class="select-control action-command">
      ${SCENE_COMMANDS.map((c) => `<option value="${c}" ${existing?.command === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>
    <input type="number" class="form-control action-value" placeholder="valeur" value="${existing?.value ?? ''}">
    <input type="number" class="form-control action-delay" placeholder="délai (ms)" min="0" value="${existing?.delayMs ?? ''}">
    <button type="button" class="btn btn-danger" data-action="remove-action-row">✕</button>
  `;
  container.appendChild(row);
}

function saveScene(): void {
  const receiverId = getValue('sc-sceneId').trim();
  const name = getValue('sc-name').trim();

  if (!receiverId || !name) {
    showAlert('Identifiant et nom sont requis', 'error');
    return;
  }

  const actions: SceneAction[] = Array.from(document.querySelectorAll('#sc-actions-container .emitter-row')).map((row) => {
    const target = (row.querySelector('.action-target') as HTMLSelectElement).value;
    const command = (row.querySelector('.action-command') as HTMLSelectElement).value;
    const valueStr = (row.querySelector('.action-value') as HTMLInputElement).value;
    const delayStr = (row.querySelector('.action-delay') as HTMLInputElement).value;
    return {
      target,
      command,
      value: valueStr ? Number(valueStr) : undefined,
      delayMs: delayStr ? Number(delayStr) : undefined
    };
  }).filter((a) => a.target);

  if (actions.length === 0) {
    showAlert('Au moins une commande est requise', 'error');
    return;
  }

  const config: ReceiverSceneConfig = {
    receiverId,
    name,
    type: 'scene',
    description: getValue('sc-description').trim() || undefined,
    sceneType: getValue('sc-sceneType') as 'parallel' | 'sequential',
    delayBetweenCommands: Number(getValue('sc-delayBetweenCommands') || 500),
    actions,
    transmitToHa: isChecked('sc-transmitToHa')
  };

  if (editingSceneId) {
    socket.emit('rfxcom:scene:update', { sceneId: editingSceneId, config });
  } else {
    socket.emit('rfxcom:scene:create', { config });
  }

  closeSceneForm();
}

function deleteScene(sceneId: string): void {
  if (!confirm(`Supprimer la scène ${sceneId} ?`)) return;
  socket.emit('rfxcom:scene:delete', { sceneId });
}

// ============================================================================
// Protocoles
// ============================================================================

function renderHardwareStatus(): void {
  const container = document.getElementById('hardware-status');
  if (!container) return;

  if (!hardwareStatus) {
    container.innerHTML = '<p style="color:var(--color-text-muted);">Statut matériel pas encore reçu (en attente de la connexion au transceiver).</p>';
    return;
  }

  container.innerHTML = `
    <div>Récepteur : <strong>${escapeHtml(hardwareStatus.receiverType)}</strong></div>
    <div>Firmware : <strong>${escapeHtml(hardwareStatus.firmwareType)} v${hardwareStatus.firmwareVersion}</strong></div>
  `;
}

/** Liste à cocher éditable, granularité matérielle (X10/ARC/AC/...) — sélection persistée à chaque
 *  coche, mais poussée au RFXtrx433 en une seule fois via le bouton dédié (RAM, jamais écrit en EEPROM). */
function renderHardwareProtocols(): void {
  const container = document.getElementById('hardware-protocols-list');
  if (!container) return;

  container.innerHTML = hardwareAvailableProtocols.map((p) => `
    <div class="checkbox-group" style="margin-bottom:10px;">
      <input type="checkbox" id="hwproto-${escapeHtml(p)}" data-action="toggle-hardware-protocol" data-id="${escapeHtml(p)}" ${hardwareEnabledProtocols.includes(p) ? 'checked' : ''}>
      <label for="hwproto-${escapeHtml(p)}" style="margin:0;cursor:pointer;">${escapeHtml(p)}</label>
    </div>
  `).join('') || '<p style="color:var(--color-text-muted);">Catalogue pas encore reçu (en attente du statut matériel).</p>';
}

function renderProtocols(): void {
  renderHardwareStatus();
  renderHardwareProtocols();
}

function toggleHardwareProtocol(protocol: string): void {
  const checkbox = document.getElementById(`hwproto-${protocol}`) as HTMLInputElement | null;
  const enabled = checkbox?.checked ?? false;
  socket.emit('rfxcom:hardware-protocol:toggle', { protocol, enabled });
}

function pushHardwareProtocols(): void {
  socket.emit('rfxcom:hardware-protocols:push');
  showAlert('Protocoles matériel envoyés au RFXtrx433.', 'success');
}

function refreshHardwareStatus(): void {
  socket.emit('rfxcom:hardware-status:refresh');
  showAlert('Statut matériel rafraîchi.', 'success');
}

function executeScene(sceneId: string): void {
  socket.emit('rfxcom:scene:execute', { sceneId });
}

function cancelScene(sceneId: string): void {
  socket.emit('rfxcom:scene:cancel', { sceneId });
}

// ============================================================================
// Utilitaires
// ============================================================================

function setValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (el) el.value = value;
}
function getValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || '';
}
function setChecked(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}
function isChecked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked || false;
}

function showAlert(message: string, type: 'success' | 'error' | 'info'): void {
  const successEl = document.getElementById('success-alert');
  const errorEl = document.getElementById('error-alert');
  [successEl, errorEl].forEach((el) => { if (el) el.style.display = 'none'; });

  const el = type === 'error' ? errorEl : successEl;
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
}

function hideLoading(): void {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

// N'échappe pas seulement &/</> : ce helper sert aussi à insérer des valeurs dans des attributs
// value="..." — un guillemet non échappé y referme l'attribut prématurément (voir même bug
// corrigé dans evoo7/config-app.ts, TODO.md).
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
