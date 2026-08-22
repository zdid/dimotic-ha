/**
 * Script TypeScript pour le tableau de bord RPI GPIO.
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface PinDefinition {
  id: string;
  quoi: string;
  lieuPrecis?: string;
  lieu: string;
  lieuPere?: string;
  lieuGrandPere?: string;
  pin: number;
  direction: 'input' | 'output';
  inverted: boolean;
}

interface RpigpioStatus {
  pinsCount: number;
  target: { host: string; containerName: string };
  agentOnline: boolean | null;
  agentLastSeenAt: string | null;
}

interface DeployResult {
  success: boolean;
  step?: 'write' | 'restart';
  error?: string;
  output?: string;
}

let socket: any | null = null;
let listenersReady = false;
let pins: PinDefinition[] = [];

function init(): void {
  try {
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    setupPinModal();
    setupDeployButton();
    requestInitialStatus();
    hideLoading();

    console.log('[RPI GPIO UI] Initialisation terminée');
  } catch (error) {
    console.error('[RPI GPIO UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('rpigpio:status', (status: RpigpioStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('rpigpio:pins:list', (list: PinDefinition[]) => {
    pins = list;
    renderPins();
  });

  socket.on('rpigpio:remote-op:result', (result: DeployResult) => {
    showDeployResult(result);
  });

  socket.on('rpigpio:error', (data: { message: string }) => {
    showDeployResult({ success: false, error: data.message });
  });
}

function requestInitialStatus(): void {
  socket?.emit('rpigpio:status:get');
  socket?.emit('rpigpio:pins:list:get');
}

function updateStatusDisplay(status: RpigpioStatus): void {
  const countEl = $('pins-count');
  const hostEl = $('target-host');
  const serviceEl = $('target-service');
  const agentEl = $('agent-status');
  const lastSeenEl = $('agent-last-seen');
  if (countEl) countEl.textContent = String(status.pinsCount);
  if (hostEl) hostEl.textContent = status.target.host || '—';
  if (serviceEl) serviceEl.textContent = status.target.containerName || '—';
  if (agentEl) {
    agentEl.textContent = status.agentOnline === null ? 'Inconnu' : status.agentOnline ? 'En ligne' : 'Hors ligne';
  }
  if (lastSeenEl) {
    lastSeenEl.textContent = status.agentLastSeenAt ? new Date(status.agentLastSeenAt).toLocaleString('fr-FR') : '—';
  }

  const statusCard = $('status-card');
  const actions = $('actions');
  if (statusCard) statusCard.style.display = 'block';
  if (actions) actions.style.display = 'flex';
}

function showMainContent(): void {
  hideLoading();
}

function hideLoading(): void {
  const loading = $('loading');
  if (loading) loading.style.display = 'none';
}

// ==========================================================================
// Liste des pins
// ==========================================================================

function buildQuoiOuLabel(pin: PinDefinition): string {
  const segments: string[] = [];
  const precisDistinct = pin.lieuPrecis && pin.lieuPrecis.toLowerCase() !== pin.lieu.toLowerCase();
  if (precisDistinct) segments.push(pin.lieuPrecis!);
  segments.push(pin.lieu);
  if (pin.lieuPere) segments.push(pin.lieuPere);
  if (pin.lieuGrandPere) segments.push(pin.lieuGrandPere);
  return `${pin.quoi}---${segments.join('--')}`;
}

function renderPins(): void {
  const el = $('pins-list');
  if (!el) return;

  if (pins.length === 0) {
    el.innerHTML = '<div class="empty">Aucun pin configuré.</div>';
    return;
  }

  el.innerHTML = pins.map((p) => `
    <div class="pin-row">
      <div class="pin-info">
        <div class="pin-name">${escapeHtml(buildQuoiOuLabel(p))}
          <span class="badge ${p.direction}">${p.direction === 'input' ? 'entrée' : 'sortie'}</span>
          ${p.inverted ? '<span class="badge inverted">inversé</span>' : ''}
        </div>
        <div class="pin-detail">GPIO ${p.pin} — id: ${escapeHtml(p.id)}</div>
      </div>
      <div class="pin-actions">
        <button class="btn btn-secondary" data-action="edit" data-id="${escapeHtml(p.id)}">Modifier</button>
        <button class="btn btn-danger" data-action="delete" data-id="${escapeHtml(p.id)}">Supprimer</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (!id) return;
      if (action === 'edit') openPinModalForEdit(id);
      if (action === 'delete') {
        if (confirm('Supprimer ce pin ?')) socket?.emit('rpigpio:pin:delete', { id });
      }
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==========================================================================
// Modale de création/modification
// ==========================================================================

function setupPinModal(): void {
  const newBtn = $('new-pin-btn');
  const cancelBtn = $('pin-cancel');
  const submitBtn = $('pin-submit');
  const overlay = $('pin-overlay');

  newBtn?.addEventListener('click', () => openPinModalForCreate());
  cancelBtn?.addEventListener('click', () => closePinModal());
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closePinModal(); });
  submitBtn?.addEventListener('click', () => submitPinForm());
}

function openPinModalForCreate(): void {
  clearPinForm();
  const title = $('pin-modal-title');
  if (title) title.textContent = '➕ Nouveau pin';
  showPinModal();
}

function openPinModalForEdit(id: string): void {
  const pin = pins.find((p) => p.id === id);
  if (!pin) return;

  clearPinForm();
  setInputValue('pin-id', pin.id);
  setInputValue('pin-quoi', pin.quoi);
  setInputValue('pin-lieu-precis', pin.lieuPrecis || '');
  setInputValue('pin-lieu', pin.lieu);
  setInputValue('pin-lieu-pere', pin.lieuPere || '');
  setInputValue('pin-lieu-grand-pere', pin.lieuGrandPere || '');
  setInputValue('pin-number', String(pin.pin));
  setInputValue('pin-direction', pin.direction);
  setCheckboxValue('pin-inverted', pin.inverted);

  const title = $('pin-modal-title');
  if (title) title.textContent = '✏️ Modifier le pin';
  showPinModal();
}

function clearPinForm(): void {
  setInputValue('pin-id', '');
  setInputValue('pin-quoi', '');
  setInputValue('pin-lieu-precis', '');
  setInputValue('pin-lieu', '');
  setInputValue('pin-lieu-pere', '');
  setInputValue('pin-lieu-grand-pere', '');
  setInputValue('pin-number', '');
  setInputValue('pin-direction', 'output');
  setCheckboxValue('pin-inverted', false);
  hideElement('pin-form-error');
}

function setInputValue(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
  if (el) el.value = value;
}

function setCheckboxValue(id: string, checked: boolean): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

function showPinModal(): void {
  $('pin-overlay')?.classList.add('active');
}

function closePinModal(): void {
  $('pin-overlay')?.classList.remove('active');
}

function hideElement(id: string): void {
  const el = $(id);
  if (el) el.style.display = 'none';
}

function submitPinForm(): void {
  const errorEl = $('pin-form-error');
  const id = (($('pin-id') as HTMLInputElement)?.value || '').trim();
  const quoi = (($('pin-quoi') as HTMLInputElement)?.value || '').trim();
  const lieuPrecis = (($('pin-lieu-precis') as HTMLInputElement)?.value || '').trim();
  const lieu = (($('pin-lieu') as HTMLInputElement)?.value || '').trim();
  const lieuPere = (($('pin-lieu-pere') as HTMLInputElement)?.value || '').trim();
  const lieuGrandPere = (($('pin-lieu-grand-pere') as HTMLInputElement)?.value || '').trim();
  const pinNumberRaw = (($('pin-number') as HTMLInputElement)?.value || '').trim();
  const direction = (($('pin-direction') as HTMLSelectElement)?.value || 'output') as 'input' | 'output';
  const inverted = (($('pin-inverted') as HTMLInputElement)?.checked) || false;

  if (!quoi || !lieu || !pinNumberRaw) {
    if (errorEl) { errorEl.textContent = 'Quoi, lieu et numéro de pin sont obligatoires.'; errorEl.style.display = 'block'; }
    return;
  }

  const payload: Record<string, unknown> = {
    quoi,
    lieu,
    pin: Number(pinNumberRaw),
    direction,
    inverted
  };
  if (id) payload.id = id;
  if (lieuPrecis) payload.lieuPrecis = lieuPrecis;
  if (lieuPere) payload.lieuPere = lieuPere;
  if (lieuGrandPere) payload.lieuGrandPere = lieuGrandPere;

  socket?.emit('rpigpio:pin:save', payload);
  closePinModal();
}

// ==========================================================================
// Déploiement
// ==========================================================================

function setupDeployButton(): void {
  $('deploy-btn')?.addEventListener('click', () => {
    hideElement('deploy-success');
    hideElement('deploy-error');
    socket?.emit('rpigpio:remote-op', { action: 'deploy' });
  });
}

function showDeployResult(result: DeployResult): void {
  const successEl = $('deploy-success');
  const errorEl = $('deploy-error');

  if (result.success) {
    if (successEl) {
      successEl.textContent = `Déploiement réussi (config écrit, conteneur redémarré${result.output ? ` — statut: ${result.output}` : ''}).`;
      successEl.style.display = 'block';
    }
    if (errorEl) errorEl.style.display = 'none';
  } else {
    if (errorEl) {
      errorEl.textContent = `Échec (${result.step || 'inconnu'}) : ${result.error || 'erreur inconnue'}`;
      errorEl.style.display = 'block';
    }
    if (successEl) successEl.style.display = 'none';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
