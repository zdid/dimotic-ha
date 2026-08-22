/**
 * Script TypeScript pour le tableau de bord Téléinfo.
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface CompteurDefinition {
  adco: number;
  quoi: string;
  lieuPrecis?: string;
  lieu: string;
  lieuPere?: string;
  lieuGrandPere?: string;
}

interface TeleinfoStatus {
  compteursCount: number;
  target: { host: string; serviceName: string };
  agentOnline: boolean | null;
  agentLastSeenAt: string | null;
}

interface DeployResult {
  success: boolean;
  step?: string;
  error?: string;
  output?: string;
}

let socket: any | null = null;
let listenersReady = false;
let compteurs: CompteurDefinition[] = [];

function init(): void {
  try {
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    setupCompteurModal();
    setupDeployButton();
    requestInitialStatus();
    hideLoading();

    console.log('[Téléinfo UI] Initialisation terminée');
  } catch (error) {
    console.error('[Téléinfo UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('teleinfo:status', (status: TeleinfoStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('teleinfo:compteurs:list', (list: CompteurDefinition[]) => {
    compteurs = list;
    renderCompteurs();
  });

  socket.on('teleinfo:remote-op:result', (result: DeployResult) => {
    showDeployResult(result);
  });

  socket.on('teleinfo:error', (data: { message: string }) => {
    showDeployResult({ success: false, error: data.message });
  });
}

function requestInitialStatus(): void {
  socket?.emit('teleinfo:status:get');
  socket?.emit('teleinfo:compteurs:list:get');
}

function updateStatusDisplay(status: TeleinfoStatus): void {
  const countEl = $('compteurs-count');
  const hostEl = $('target-host');
  const serviceEl = $('target-service');
  const agentEl = $('agent-status');
  const lastSeenEl = $('agent-last-seen');
  if (countEl) countEl.textContent = String(status.compteursCount);
  if (hostEl) hostEl.textContent = status.target.host || '—';
  if (serviceEl) serviceEl.textContent = status.target.serviceName || '—';
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

  const deployBtn = $('deploy-btn') as HTMLButtonElement | null;
  if (deployBtn) deployBtn.disabled = status.compteursCount !== 2;

  const newBtn = $('new-compteur-btn') as HTMLButtonElement | null;
  if (newBtn) newBtn.disabled = status.compteursCount >= 2;
}

function showMainContent(): void {
  hideLoading();
}

function hideLoading(): void {
  const loading = $('loading');
  if (loading) loading.style.display = 'none';
}

// ==========================================================================
// Liste des compteurs
// ==========================================================================

function buildQuoiOuLabel(c: CompteurDefinition): string {
  const segments: string[] = [];
  const precisDistinct = c.lieuPrecis && c.lieuPrecis.toLowerCase() !== c.lieu.toLowerCase();
  if (precisDistinct) segments.push(c.lieuPrecis!);
  segments.push(c.lieu);
  if (c.lieuPere) segments.push(c.lieuPere);
  if (c.lieuGrandPere) segments.push(c.lieuGrandPere);
  return `${c.quoi}---${segments.join('--')}`;
}

function renderCompteurs(): void {
  const el = $('compteurs-list');
  if (!el) return;

  if (compteurs.length === 0) {
    el.innerHTML = '<div class="empty">Aucun compteur configuré.</div>';
    return;
  }

  el.innerHTML = compteurs.map((c) => `
    <div class="compteur-row">
      <div class="compteur-info">
        <div class="compteur-name">${escapeHtml(buildQuoiOuLabel(c))}</div>
        <div class="compteur-detail">ADCO: ${c.adco}</div>
      </div>
      <div class="compteur-actions">
        <button class="btn btn-secondary" data-action="edit" data-adco="${c.adco}">Modifier</button>
        <button class="btn btn-danger" data-action="delete" data-adco="${c.adco}">Supprimer</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const adco = Number(btn.dataset.adco);
      const action = btn.dataset.action;
      if (!adco) return;
      if (action === 'edit') openCompteurModalForEdit(adco);
      if (action === 'delete') {
        if (confirm('Supprimer ce compteur ?')) socket?.emit('teleinfo:compteur:delete', { adco });
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

function setupCompteurModal(): void {
  $('new-compteur-btn')?.addEventListener('click', () => openCompteurModalForCreate());
  $('compteur-cancel')?.addEventListener('click', () => closeCompteurModal());
  $('compteur-overlay')?.addEventListener('click', (e) => { if (e.target === $('compteur-overlay')) closeCompteurModal(); });
  $('compteur-submit')?.addEventListener('click', () => submitCompteurForm());
}

function openCompteurModalForCreate(): void {
  clearCompteurForm();
  const title = $('compteur-modal-title');
  if (title) title.textContent = '➕ Nouveau compteur';
  showCompteurModal();
}

function openCompteurModalForEdit(adco: number): void {
  const c = compteurs.find((x) => x.adco === adco);
  if (!c) return;

  clearCompteurForm();
  setInputValue('compteur-original-adco', String(c.adco));
  setInputValue('compteur-adco', String(c.adco));
  setInputValue('compteur-quoi', c.quoi);
  setInputValue('compteur-lieu-precis', c.lieuPrecis || '');
  setInputValue('compteur-lieu', c.lieu);
  setInputValue('compteur-lieu-pere', c.lieuPere || '');
  setInputValue('compteur-lieu-grand-pere', c.lieuGrandPere || '');

  const title = $('compteur-modal-title');
  if (title) title.textContent = '✏️ Modifier le compteur';
  showCompteurModal();
}

function clearCompteurForm(): void {
  setInputValue('compteur-original-adco', '');
  setInputValue('compteur-adco', '');
  setInputValue('compteur-quoi', '');
  setInputValue('compteur-lieu-precis', '');
  setInputValue('compteur-lieu', '');
  setInputValue('compteur-lieu-pere', '');
  setInputValue('compteur-lieu-grand-pere', '');
  hideElement('compteur-form-error');
}

function setInputValue(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

function showCompteurModal(): void {
  $('compteur-overlay')?.classList.add('active');
}

function closeCompteurModal(): void {
  $('compteur-overlay')?.classList.remove('active');
}

function hideElement(id: string): void {
  const el = $(id);
  if (el) el.style.display = 'none';
}

function submitCompteurForm(): void {
  const errorEl = $('compteur-form-error');
  const originalAdcoRaw = (($('compteur-original-adco') as HTMLInputElement)?.value || '').trim();
  const adcoRaw = (($('compteur-adco') as HTMLInputElement)?.value || '').trim();
  const quoi = (($('compteur-quoi') as HTMLInputElement)?.value || '').trim();
  const lieuPrecis = (($('compteur-lieu-precis') as HTMLInputElement)?.value || '').trim();
  const lieu = (($('compteur-lieu') as HTMLInputElement)?.value || '').trim();
  const lieuPere = (($('compteur-lieu-pere') as HTMLInputElement)?.value || '').trim();
  const lieuGrandPere = (($('compteur-lieu-grand-pere') as HTMLInputElement)?.value || '').trim();

  if (!adcoRaw || !quoi || !lieu) {
    if (errorEl) { errorEl.textContent = 'ADCO, quoi et lieu sont obligatoires.'; errorEl.style.display = 'block'; }
    return;
  }

  const payload: Record<string, unknown> = { adco: Number(adcoRaw), quoi, lieu };
  if (originalAdcoRaw) payload.originalAdco = Number(originalAdcoRaw);
  if (lieuPrecis) payload.lieuPrecis = lieuPrecis;
  if (lieuPere) payload.lieuPere = lieuPere;
  if (lieuGrandPere) payload.lieuGrandPere = lieuGrandPere;

  socket?.emit('teleinfo:compteur:save', payload);
  closeCompteurModal();
}

// ==========================================================================
// Déploiement
// ==========================================================================

function setupDeployButton(): void {
  $('deploy-btn')?.addEventListener('click', () => {
    hideElement('deploy-success');
    hideElement('deploy-error');
    socket?.emit('teleinfo:remote-op', { action: 'deploy' });
  });
}

function showDeployResult(result: DeployResult): void {
  const successEl = $('deploy-success');
  const errorEl = $('deploy-error');

  if (result.success) {
    if (successEl) {
      successEl.textContent = `Déploiement réussi (agent copié, service redémarré${result.output ? ` — statut: ${result.output}` : ''}).`;
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
