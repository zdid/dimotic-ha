/**
 * Script TypeScript pour le tableau de bord EVOO7.
 */

// Ce script est injecté par ModuleContainer.ts (core) après le chargement initial de la page —
// tout son contenu vit dans un Shadow DOM que le `document` global ne traverse pas ;
// `$(...)` y renverrait toujours `null`. ModuleContainer.ts expose son
// shadow root sur `window.__moduleContainerRoot` ; `$()` l'interroge s'il existe, sinon
// `document` (utile hors de ce pipeline, ex: tests). Même pattern qu'arbreouquoi/app.ts.
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface Evoo7Status {
  evoo7Connected: boolean;
  bridgeConnected: boolean;
  donneesCount: number;
  consultationCount: number;
  miseAJourCount: number;
  lastMessageAt: string | null;
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

    console.log('[EVOO7 UI] Initialisation terminée');
  } catch (error) {
    console.error('[EVOO7 UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('evoo7:status', (status: Evoo7Status) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('connect', () => {
    console.log('[EVOO7 UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[EVOO7 UI] Déconnecté du serveur Socket.io');
  });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('evoo7:status:get');
}

function updateStatusDisplay(status: Evoo7Status): void {
  const evoo7BadgeEl = $('evoo7-badge');
  const bridgeBadgeEl = $('bridge-badge');
  const donneesCountEl = $('donnees-count');
  const consultationCountEl = $('consultation-count');
  const miseAJourCountEl = $('miseajour-count');
  const lastMessageEl = $('last-message');

  if (evoo7BadgeEl) {
    evoo7BadgeEl.textContent = `Boîtier EVOO7: ${status.evoo7Connected ? 'Connecté' : 'Déconnecté'}`;
    evoo7BadgeEl.className = `status-badge ${status.evoo7Connected ? 'connected' : 'disconnected'}`;
  }
  if (bridgeBadgeEl) {
    bridgeBadgeEl.textContent = `Bridge HA: ${status.bridgeConnected ? 'Connecté' : 'Déconnecté'}`;
    bridgeBadgeEl.className = `status-badge ${status.bridgeConnected ? 'connected' : 'disconnected'}`;
  }
  if (donneesCountEl) donneesCountEl.textContent = String(status.donneesCount);
  if (consultationCountEl) consultationCountEl.textContent = String(status.consultationCount);
  if (miseAJourCountEl) miseAJourCountEl.textContent = String(status.miseAJourCount);
  if (lastMessageEl) {
    lastMessageEl.textContent = status.lastMessageAt
      ? new Date(status.lastMessageAt).toLocaleString('fr-FR')
      : '--';
  }
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
    evoo7App: { init: () => void; refreshStatus: () => void };
  }
}

window.evoo7App = { init, refreshStatus };
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
