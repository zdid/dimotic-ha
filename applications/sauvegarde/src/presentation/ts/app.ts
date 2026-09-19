/**
 * Script TypeScript pour le tableau de bord Sauvegarde/Restauration.
 *
 * ⭐ 17/09/2026 — allégé au statut seul : l'import gossip, l'ajout de machine et la poussée du mot
 * de passe Nextcloud par machine vivent désormais sur Paramètres Techniques → Sauvegarde/
 * Restauration (demande explicite : "on ne travaille que sur la page de paramètres techniques").
 * Ce tableau de bord garde uniquement le statut et le lien vers la restauration.
 */

// Voir le commentaire équivalent dans arexx/presentation/ts/app.ts : ce script vit dans le
// Shadow DOM de ModuleContainer.ts, `document` ne le traverse pas.
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface SauvegardeStatus {
  nextcloudConfigured: boolean;
  webdavUrl: string;
  targetsCount: number;
}

let socket: any | null = null;
// Voir arexx/presentation/ts/app.ts : ModuleContainer rappelle init() à chaque réaffichage depuis
// son cache — ce drapeau évite d'empiler les écouteurs socket.on() à chaque visite.
let listenersReady = false;

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
    showMainContent();
  });

  socket.on('connect', () => {
    console.log('[Sauvegarde UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[Sauvegarde UI] Déconnecté du serveur Socket.io');
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

function showMainContent(): void {
  const actionsEl = $('actions');
  const statusCardEl = $('status-card');
  if (actionsEl) actionsEl.style.display = 'flex';
  if (statusCardEl) statusCardEl.style.display = 'block';
}

function hideLoading(): void {
  const loadingEl = $('loading');
  if (loadingEl) loadingEl.style.display = 'none';
}

function refreshStatus(): void {
  requestInitialStatus();
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
