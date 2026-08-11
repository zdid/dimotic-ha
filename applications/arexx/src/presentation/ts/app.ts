/**
 * Script TypeScript pour le tableau de bord AREXX.
 */

// Ce script est injecté par ModuleContainer.ts (core) après le chargement initial de la page —
// tout son contenu vit dans un Shadow DOM que le `document` global ne traverse pas ;
// `$(...)` y renverrait toujours `null`. ModuleContainer.ts expose son
// shadow root sur `window.__moduleContainerRoot` ; `$()` l'interroge s'il existe, sinon
// `document` (utile hors de ce pipeline, ex: tests). Même pattern que rfxcom/app.ts.
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface ArexxStatus {
  acquisitionMode: 'push' | 'poll' | 'usb';
  running: boolean;
  sensorsCount: number;
  lastReadingAt: string | null;
}

interface ArexxDiscoveredSensor {
  uniqueId: string;
  kind: 'temperature' | 'humidity';
  detectedAt: string;
}

interface ArexxSensorsListEvent {
  configured: unknown[];
  discovered: ArexxDiscoveredSensor[];
}

let socket: any | null = null;
// ⭐ ModuleContainer rappelle init() à chaque réaffichage depuis son cache (revisite d'un module
// déjà chargé, voir ModuleContainer.ts) pour rebrancher les écouteurs DOM sur les nouveaux nœuds —
// mais la connexion socket, elle, persiste : s'abonner à nouveau à chaque appel empilerait un
// écouteur supplémentaire par visite. Ce drapeau garantit que setupEventListeners() (socket.on)
// ne s'exécute qu'une seule fois par cycle de vie de la page.
let listenersReady = false;

function init(): void {
  try {
    // Connexion Socket.io unique, réutilisée depuis le core (window.app.socketService) au lieu
    // d'en ouvrir une seconde — voir arbreouquoi/app.ts pour le détail du pourquoi.
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    requestInitialStatus();
    hideLoading();

    console.log('[AREXX UI] Initialisation terminée');
  } catch (error) {
    console.error('[AREXX UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('arexx:status', (status: ArexxStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('arexx:sensors:list', (data: ArexxSensorsListEvent) => {
    updateRecentSensors(data.discovered);
  });

  socket.on('arexx:sensor:detected', () => {
    socket.emit('arexx:sensors:list:get');
  });

  socket.on('connect', () => {
    console.log('[AREXX UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[AREXX UI] Déconnecté du serveur Socket.io');
  });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('arexx:status:get');
  socket.emit('arexx:sensors:list:get');
}

function updateStatusDisplay(status: ArexxStatus): void {
  const badgeEl = $('connection-badge');
  const modeEl = $('acquisition-mode');
  const sensorsCountEl = $('sensors-count');
  const lastReadingEl = $('last-reading');

  if (badgeEl) {
    badgeEl.textContent = status.running ? 'En cours' : 'Arrêté';
    badgeEl.className = `status-badge ${status.running ? 'connected' : 'disconnected'}`;
  }
  if (modeEl) modeEl.textContent = status.acquisitionMode;
  if (sensorsCountEl) sensorsCountEl.textContent = String(status.sensorsCount);
  if (lastReadingEl) {
    lastReadingEl.textContent = status.lastReadingAt
      ? new Date(status.lastReadingAt).toLocaleString('fr-FR')
      : '--';
  }
}

function updateRecentSensors(discovered: ArexxDiscoveredSensor[]): void {
  const cardEl = $('recent-sensors-card');
  const listEl = $('recent-sensors-list');
  if (!listEl) return;

  if (discovered.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = discovered.map((s) => `
    <div class="sensor-row">
      <span>${escapeHtml(s.uniqueId)} (${escapeHtml(s.kind)})</span>
      <span>${new Date(s.detectedAt).toLocaleTimeString('fr-FR')}</span>
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
    arexxApp: { init: () => void; refreshStatus: () => void };
  }
}

window.arexxApp = { init, refreshStatus };
// Utilisé par l'attribut onclick="refreshStatus()" du HTML (script classique, portée globale)
(window as unknown as { refreshStatus: () => void }).refreshStatus = refreshStatus;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Force ce fichier à être traité comme un module TS (nécessaire pour `declare global` ci-dessus)
// — perdu en retirant l'import de SocketService, seul import du fichier jusqu'ici.
export {};
