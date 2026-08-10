/**
 * Script TypeScript pour le tableau de bord planificateur.
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface PlanificateurStatus {
  macrosCount: number;
  planificationsCount: number;
  activeSchedules: string[];
}

interface PlanificateurAction {
  at: string;
  source: 'ia:command' | 'ia:tool:execute';
  request: string;
  reply: string;
  success: boolean;
}

let socket: any | null = null;

function init(): void {
  try {
    // Connexion Socket.io unique, réutilisée depuis le core (window.app.socketService) au lieu
    // d'en ouvrir une seconde — voir arbreouquoi/app.ts pour le détail du pourquoi.
    socket = window.app.socketService.getSocket();

    setupEventListeners();
    requestInitialStatus();
    hideLoading();

    console.log('[Planificateur UI] Initialisation terminée');
  } catch (error) {
    console.error('[Planificateur UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('planificateur:status', (status: PlanificateurStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('planificateur:actions:list', (actions: PlanificateurAction[]) => {
    updateActionsLog(actions);
  });

  socket.on('connect', () => {
    console.log('[Planificateur UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[Planificateur UI] Déconnecté du serveur Socket.io');
  });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('planificateur:status:get');
  socket.emit('planificateur:actions:list:get');
}

function updateStatusDisplay(status: PlanificateurStatus): void {
  const macrosEl = $('macros-count');
  const planificationsEl = $('planifications-count');
  const activeEl = $('active-count');

  if (macrosEl) macrosEl.textContent = String(status.macrosCount);
  if (planificationsEl) planificationsEl.textContent = String(status.planificationsCount);
  if (activeEl) activeEl.textContent = String(status.activeSchedules.length);
}

function updateActionsLog(actions: PlanificateurAction[]): void {
  const cardEl = $('actions-log-card');
  const listEl = $('actions-log-list');
  if (!listEl) return;

  if (actions.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = actions.map((a) => `
    <div class="action-row">
      <span class="at">${new Date(a.at).toLocaleString('fr-FR')}</span>
      <span class="source">${escapeHtml(a.source)}</span>
      <span class="badge ${a.success ? 'ok' : 'error'}">${a.success ? 'OK' : 'Échec'}</span>
      <pre>${escapeHtml(a.request)}</pre>
      <pre>${escapeHtml(a.reply)}</pre>
    </div>
  `).join('');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    planificateurApp: { init: () => void; refreshStatus: () => void };
  }
}

window.planificateurApp = { init, refreshStatus };
(window as unknown as { refreshStatus: () => void }).refreshStatus = refreshStatus;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Force ce fichier à être traité comme un module TS (nécessaire pour `declare global` ci-dessus)
// — perdu en retirant l'import de SocketService, seul import du fichier jusqu'ici.
export {};
