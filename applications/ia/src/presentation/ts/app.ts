/**
 * Script TypeScript pour le tableau de bord IA.
 */

// Voir arexx/presentation/ts/app.ts pour l'explication du Shadow DOM (ModuleContainer.ts).
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface IaStatus {
  mistralConfigured: boolean;
  ollamaHttpPort: number;
  rulesLoaded: boolean;
}

interface Exchange {
  at: string;
  question: string;
  response: string;
  intermediateJson?: string;
  planificateurReply?: string;
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

    console.log('[IA UI] Initialisation terminée');
  } catch (error) {
    console.error('[IA UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('ia:status', (status: IaStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('ia:exchanges:list', (exchanges: Exchange[]) => {
    updateExchanges(exchanges);
  });

  socket.on('ia:test:reply', (reply: { success: boolean; response: string; intermediateJson?: string; planificateurReply?: string }) => {
    showTestResult(reply);
  });

  socket.on('connect', () => {
    console.log('[IA UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[IA UI] Déconnecté du serveur Socket.io');
  });

  setupTestForm();
}

function setupTestForm(): void {
  const input = $('test-input') as HTMLInputElement | null;
  const sendBtn = $('test-send') as HTMLButtonElement | null;
  if (!input || !sendBtn) return;

  const send = () => {
    const message = input.value.trim();
    if (!message || !socket) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Envoi...';
    const resultEl = $('test-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'test-result';
      resultEl.textContent = 'En attente de Mistral...';
    }

    socket.emit('ia:test:send', { message });
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') send();
  });
}

function showTestResult(reply: { success: boolean; response: string; intermediateJson?: string; planificateurReply?: string }): void {
  const sendBtn = $('test-send') as HTMLButtonElement | null;
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Envoyer';
  }

  const resultEl = $('test-result');
  if (!resultEl) return;
  resultEl.style.display = 'block';
  resultEl.className = `test-result ${reply.success ? 'ok' : 'error'}`;
  resultEl.innerHTML = `<div>${escapeHtml(reply.response)}</div>`
    + (reply.intermediateJson ? `<pre class="intermediate-json">${escapeHtml(reply.intermediateJson)}</pre>` : '')
    + (reply.planificateurReply ? `<div class="planificateur-reply-label">Réponse de planificateur :</div><pre class="intermediate-json">${escapeHtml(reply.planificateurReply)}</pre>` : '');
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('ia:status:get');
  socket.emit('ia:exchanges:list:get');
}

function updateStatusDisplay(status: IaStatus): void {
  const badgeEl = $('mistral-badge');
  const portEl = $('ollama-port');
  const rulesEl = $('rules-status');

  if (badgeEl) {
    badgeEl.textContent = status.mistralConfigured ? 'Clé Mistral configurée' : 'Clé Mistral manquante';
    badgeEl.className = `status-badge ${status.mistralConfigured ? 'connected' : 'disconnected'}`;
  }
  if (portEl) portEl.textContent = String(status.ollamaHttpPort);
  if (rulesEl) rulesEl.textContent = status.rulesLoaded ? 'Chargées' : 'Absentes';
}

function updateExchanges(exchanges: Exchange[]): void {
  const cardEl = $('exchanges-card');
  const listEl = $('exchanges-list');
  if (!listEl) return;

  if (exchanges.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = exchanges.map((e) => `
    <div class="exchange-row">
      <div class="at">${new Date(e.at).toLocaleString('fr-FR')}</div>
      <div class="question">❓ ${escapeHtml(e.question)}</div>
      <div class="response">💬 ${escapeHtml(e.response)}</div>
      ${e.intermediateJson ? `<pre class="intermediate-json">${escapeHtml(e.intermediateJson)}</pre>` : ''}
      ${e.planificateurReply ? `<div class="planificateur-reply-label">Réponse de planificateur :</div><pre class="intermediate-json">${escapeHtml(e.planificateurReply)}</pre>` : ''}
    </div>
  `).join('');
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

declare global {
  interface Window {
    iaApp: { init: () => void; refreshStatus: () => void };
  }
}

window.iaApp = { init, refreshStatus };
(window as unknown as { refreshStatus: () => void }).refreshStatus = refreshStatus;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Force ce fichier à être traité comme un module TS (nécessaire pour `declare global` ci-dessus)
// — perdu en retirant l'import de SocketService, seul import du fichier jusqu'ici.
export {};
