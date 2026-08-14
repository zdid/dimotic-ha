/**
 * Script TypeScript pour le tableau de bord RFXCOM.
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

interface RfxComHardwareInfo {
  receiverType: string;
  firmwareType: string;
  firmwareVersion: number;
  enabledProtocols: string[];
  availableProtocols: string[];
}

interface RfxComStatus {
  connected: boolean;
  devicesCount: number;
  receiversCount: number;
  lastDiscovery: string | null;
  scanInProgress: boolean;
  error?: string;
  hardware?: RfxComHardwareInfo;
}

interface RfxComDiscoveredDevice {
  sensorId: string;
  type: string;
  subType: string;
  uniqueId: string;
  defaultQuoi: string;
  detectedAt: string;
}

interface RfxComDevicesListEvent {
  configured: unknown[];
  discovered: RfxComDiscoveredDevice[];
}

interface RfxComOrderTrace {
  at: string;
  receiverId: string;
  command: string;
  value?: number;
  success: boolean;
  error?: string;
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

    console.log('[RFXCOM UI] Initialisation terminée');
  } catch (error) {
    console.error('[RFXCOM UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('rfxcom:status', (status: RfxComStatus) => {
    updateStatusDisplay(status);
    showMainContent();
  });

  socket.on('rfxcom:devices:list', (data: RfxComDevicesListEvent) => {
    updateRecentDevices(data.discovered);
  });

  socket.on('rfxcom:device:detected', () => {
    socket.emit('rfxcom:devices:list:get');
  });

  socket.on('rfxcom:orders:list', (orders: RfxComOrderTrace[]) => {
    updateOrdersList(orders);
  });

  socket.on('connect', () => {
    console.log('[RFXCOM UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[RFXCOM UI] Déconnecté du serveur Socket.io');
  });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('rfxcom:status:get');
  socket.emit('rfxcom:devices:list:get');
  socket.emit('rfxcom:orders:list:get');
}

function updateStatusDisplay(status: RfxComStatus): void {
  const badgeEl = $('connection-badge');
  const devicesCountEl = $('devices-count');
  const receiversCountEl = $('receivers-count');
  const lastDiscoveryEl = $('last-discovery');

  if (badgeEl) {
    badgeEl.textContent = status.connected ? 'Connecté' : 'Déconnecté';
    badgeEl.className = `status-badge ${status.connected ? 'connected' : 'disconnected'}`;
  }
  if (devicesCountEl) devicesCountEl.textContent = String(status.devicesCount);
  if (receiversCountEl) receiversCountEl.textContent = String(status.receiversCount);
  if (lastDiscoveryEl) {
    lastDiscoveryEl.textContent = status.lastDiscovery
      ? new Date(status.lastDiscovery).toLocaleString('fr-FR')
      : '--';
  }

  updateHardwareDisplay(status.hardware);
}

/** Infos matérielles remontées par le transceiver (événement 'status' de la lib `rfxcom`) —
 *  absentes tant qu'aucun statut matériel n'a encore été reçu (ex: transceiver jamais connecté),
 *  la carte reste alors masquée plutôt que d'afficher des valeurs vides. */
function updateHardwareDisplay(hardware: RfxComHardwareInfo | undefined): void {
  const cardEl = $('hardware-card');
  if (!cardEl) return;

  if (!hardware) {
    cardEl.style.display = 'none';
    return;
  }
  cardEl.style.display = '';

  const typeEl = $('hardware-type');
  const firmwareEl = $('hardware-firmware');
  const enabledEl = $('hardware-enabled-protocols');
  const availableEl = $('hardware-available-protocols');

  if (typeEl) typeEl.textContent = hardware.receiverType;
  if (firmwareEl) firmwareEl.textContent = `${hardware.firmwareType} v${hardware.firmwareVersion}`;
  if (enabledEl) {
    enabledEl.textContent = hardware.enabledProtocols.length > 0
      ? hardware.enabledProtocols.join(', ')
      : 'Aucun';
  }
  if (availableEl) availableEl.textContent = hardware.availableProtocols.join(', ');
}

function updateRecentDevices(discovered: RfxComDiscoveredDevice[]): void {
  const cardEl = $('recent-devices-card');
  const listEl = $('recent-devices-list');
  if (!listEl) return;

  if (discovered.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = discovered.map((d) => `
    <div class="device-row">
      <span>${escapeHtml(d.uniqueId)} (${escapeHtml(d.defaultQuoi)})</span>
      <span>${new Date(d.detectedAt).toLocaleTimeString('fr-FR')}</span>
    </div>
  `).join('');
}

function updateOrdersList(orders: RfxComOrderTrace[]): void {
  const cardEl = $('orders-card');
  const listEl = $('orders-list');
  if (!listEl) return;

  if (orders.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = orders.map((o) => `
    <div class="order-row">
      <span class="at">${new Date(o.at).toLocaleString('fr-FR')}</span>
      <span>${escapeHtml(o.receiverId)} → ${escapeHtml(o.command)}${o.value !== undefined ? ` (${o.value})` : ''}</span>
      <span class="badge ${o.success ? 'ok' : 'error'}">${o.success ? 'OK' : 'Échec'}</span>
      ${o.error ? `<span class="error-msg">${escapeHtml(o.error)}</span>` : ''}
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
    rfxcomApp: { init: () => void; refreshStatus: () => void };
  }
}

window.rfxcomApp = { init, refreshStatus };
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
