/**
 * Script TypeScript pour le tableau de bord Sauvegarde/Restauration.
 */

// Voir le commentaire équivalent dans arexx/presentation/ts/app.ts : ce script vit dans le
// Shadow DOM de ModuleContainer.ts, `document` ne le traverse pas.
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface SauvegardeTargetSummary {
  id: string;
  site: string;
  machine: string;
  host: string;
}

interface SauvegardeStatus {
  nextcloudConfigured: boolean;
  webdavUrl: string;
  targetsCount: number;
  targets: SauvegardeTargetSummary[];
}

interface SecretPushResult {
  targetId: string;
  success: boolean;
  error?: string;
}

interface GossipImportResult {
  success: boolean;
  addedCount: number;
  error?: string;
}

let socket: any | null = null;
// Voir arexx/presentation/ts/app.ts : ModuleContainer rappelle init() à chaque réaffichage depuis
// son cache — ce drapeau évite d'empiler les écouteurs socket.on() à chaque visite.
let listenersReady = false;
let pushing = false;

function init(): void {
  try {
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    requestInitialStatus();
    hideLoading();

    console.log('[Sauvegarde UI] Initialisation terminée');
  } catch (error) {
    console.error('[Sauvegarde UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('sauvegarde:status', (status: SauvegardeStatus) => {
    updateStatusDisplay(status);
    updateTargetSelect(status.targets);
    showMainContent();
  });

  socket.on('sauvegarde:secret:push:result', (result: SecretPushResult) => {
    pushing = false;
    const btn = $('btn-push-secret') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    if (result.success) {
      showAlert('Mot de passe écrit avec succès sur la machine cible.', 'success');
      const passwordEl = $('secret-password') as HTMLInputElement | null;
      if (passwordEl) passwordEl.value = '';
    } else {
      showAlert(result.error || 'Échec de la poussée du mot de passe.', 'error');
    }
  });

  socket.on('sauvegarde:gossip:import:result', (result: GossipImportResult) => {
    const btn = $('btn-gossip-import') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    if (result.success) {
      showAlert(
        result.addedCount > 0
          ? `${result.addedCount} répertoire(s) importé(s) — complète le site pour chacun.`
          : 'Rien de nouveau à importer (tout est déjà présent, ou le gossip est vide).',
        'success', 'gossip'
      );
    } else {
      showAlert(result.error || 'Échec de l\'import.', 'error', 'gossip');
    }
  });

  socket.on('connect', () => {
    console.log('[Sauvegarde UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[Sauvegarde UI] Déconnecté du serveur Socket.io');
  });

  $('btn-push-secret')?.addEventListener('click', () => {
    if (pushing || !socket) return;
    const targetSelect = $('secret-target') as HTMLSelectElement | null;
    const passwordEl = $('secret-password') as HTMLInputElement | null;
    const targetId = targetSelect?.value ?? '';
    const appPassword = passwordEl?.value ?? '';

    if (!targetId) {
      showAlert('Aucune machine sélectionnée — configurer au moins un répertoire couvert.', 'error');
      return;
    }
    if (!appPassword) {
      showAlert('Mot de passe manquant.', 'error');
      return;
    }

    pushing = true;
    const btn = $('btn-push-secret') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    socket.emit('sauvegarde:secret:push', { targetId, appPassword });
  });

  $('btn-gossip-import')?.addEventListener('click', () => {
    if (!socket) return;
    const btn = $('btn-gossip-import') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    socket.emit('sauvegarde:gossip:import');
  });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('sauvegarde:status:get');
}

function updateStatusDisplay(status: SauvegardeStatus): void {
  const badgeEl = $('nextcloud-badge');
  const targetsCountEl = $('targets-count');
  const webdavPreviewEl = $('webdav-preview');
  const webdavUrlEl = $('webdav-url');

  if (badgeEl) {
    badgeEl.textContent = status.nextcloudConfigured ? 'Nextcloud configuré' : 'Non configuré';
    badgeEl.className = `status-badge ${status.nextcloudConfigured ? 'connected' : 'disconnected'}`;
  }
  if (targetsCountEl) targetsCountEl.textContent = String(status.targetsCount);
  if (webdavPreviewEl) webdavPreviewEl.style.display = status.webdavUrl ? 'block' : 'none';
  if (webdavUrlEl) webdavUrlEl.textContent = status.webdavUrl;
}

function updateTargetSelect(targets: SauvegardeTargetSummary[]): void {
  const selectEl = $('secret-target') as HTMLSelectElement | null;
  if (!selectEl) return;

  const previousValue = selectEl.value;
  selectEl.innerHTML = targets
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.machine)} (${escapeHtml(t.site)}) — ${escapeHtml(t.host || 'hôte non renseigné')}</option>`)
    .join('');

  if (targets.some((t) => t.id === previousValue)) {
    selectEl.value = previousValue;
  }
}

function showMainContent(): void {
  const actionsEl = $('actions');
  const statusCardEl = $('status-card');
  const gossipCardEl = $('gossip-card');
  const secretCardEl = $('secret-card');
  if (actionsEl) actionsEl.style.display = 'flex';
  if (statusCardEl) statusCardEl.style.display = 'block';
  if (gossipCardEl) gossipCardEl.style.display = 'block';
  if (secretCardEl) secretCardEl.style.display = 'block';
}

function hideLoading(): void {
  const loadingEl = $('loading');
  if (loadingEl) loadingEl.style.display = 'none';
}

function refreshStatus(): void {
  requestInitialStatus();
}

function showAlert(message: string, type: 'success' | 'error', prefix: string = 'secret'): void {
  const successEl = $(`${prefix}-success`);
  const errorEl = $(`${prefix}-error`);
  [successEl, errorEl].forEach((el) => { if (el) el.style.display = 'none'; });

  const el = type === 'error' ? errorEl : successEl;
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

declare global {
  interface Window {
    sauvegardeApp: { init: () => void; refreshStatus: () => void };
  }
}

window.sauvegardeApp = { init, refreshStatus };
(window as unknown as { refreshStatus: () => void }).refreshStatus = refreshStatus;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export {};
