/**
 * Page « Console screen » : affiche une session screen distante dans xterm.js. Tous les réglages
 * (cibles SSH, délais) sont dans Paramètres Techniques ; ici, seulement l'affichage.
 *
 * Le contenu de la page est injecté dans un Shadow DOM (ModuleContainer) et ré-injecté à chaque
 * retour sur la page : l'état (terminal, session) vit donc dans ce module, et `init()` — rappelé à
 * chaque visite (convention `window.{moduleId}App.init`) — rattache le terminal existant au nouveau
 * DOM. Quitter la page ne coupe pas la session ; fermer l'onglet, si.
 */

interface TargetInfo { id: string; label: string; host: string; screenName: string }
type SessionState = 'connecting' | 'connected' | 'closed' | 'error';

const VENDOR = '/applications/screen2http/presentation/vendor';
const PING_INTERVAL_MS = 15000;
const RECONNECT_DELAY_MS = 3000;
/** Une connexion tombée après au moins ce délai est considérée comme une vraie coupure : reconnexion auto. */
const MIN_STABLE_MS = 10000;
const LAST_TARGET_KEY = 'screen2http:lastTarget';

let socket: any | null = null;
let listenersReady = false;
let targets: TargetInfo[] = [];
let selectedTargetId = '';
let sessionId: string | null = null;
let sessionState: SessionState | 'idle' = 'idle';
let stateMessage = 'Non connecté';
let term: any | null = null;
let fit: any | null = null;
let pingTimer: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let connectedAt = 0;
let reconnectTimer: number | null = null;
let autoConnectDone = false;

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.head.appendChild(el);
  });
}

/** xterm.js est un script classique (global `Terminal`) : chargé une fois, dans l'ordre. */
async function ensureXterm(): Promise<void> {
  if (!window.Terminal) await loadScript(`${VENDOR}/xterm.js`);
  if (!window.FitAddon) await loadScript(`${VENDOR}/addon-fit.js`);
}

function newSessionId(): string {
  return 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

async function init(): Promise<void> {
  try {
    socket = window.app.socketService.getSocket();
    if (!listenersReady) {
      setupSocketListeners();
      listenersReady = true;
      window.addEventListener('beforeunload', () => closeSession());
    }
    $('s2h-root')?.classList.toggle('embedded', moduleRoot() !== document);
    setupToolbar();
    renderTargets();
    renderState();

    await ensureXterm();
    attachTerminal();
    socket.emit('screen2http:status:get');
  } catch (error) {
    console.error('[Console screen] Erreur d\'initialisation:', error);
    setState('error', error instanceof Error ? error.message : String(error));
  }
}

function setupSocketListeners(): void {
  socket.on('screen2http:status', (status: { targets: TargetInfo[] }) => {
    targets = status.targets || [];
    renderTargets();
    if (!autoConnectDone && targets.length > 0 && !sessionId) {
      autoConnectDone = true;
      connect(); // comme l'outil d'origine : la console se connecte dès l'ouverture de la page
    }
  });

  socket.on('screen2http:output', (msg: { sessionId: string; data: string }) => {
    if (msg.sessionId === sessionId) term?.write(msg.data);
  });

  socket.on('screen2http:session:state', (msg: { sessionId: string; state: SessionState; message?: string }) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.state === 'connected') {
      connectedAt = Date.now();
      setState('connected', `Connecté — ${selectedLabel()}`);
      sendResize();
      term?.focus();
    } else if (msg.state === 'connecting') {
      setState('connecting', msg.message || 'Connexion...');
    } else {
      // closed / error : la session n'existe plus côté serveur
      term?.writeln(`\r\n\x1b[33m[${msg.message || 'Session terminée'}]\x1b[0m`);
      const wasStable = connectedAt > 0 && Date.now() - connectedAt >= MIN_STABLE_MS;
      connectedAt = 0;
      endLocalSession(msg.state, msg.message || 'Session terminée');
      if (wasStable) scheduleReconnect();
    }
  });

  socket.on('screen2http:error', (msg: { message: string }) => setState('error', msg.message));
}

function setupToolbar(): void {
  ($('s2h-connect') as HTMLButtonElement | null)?.addEventListener('click', () => connect());
  ($('s2h-disconnect') as HTMLButtonElement | null)?.addEventListener('click', () => disconnect());
  ($('s2h-target') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    selectedTargetId = (e.target as HTMLSelectElement).value;
    try { localStorage.setItem(LAST_TARGET_KEY, selectedTargetId); } catch { /* stockage indisponible */ }
  });
}

function renderTargets(): void {
  const select = $('s2h-target') as HTMLSelectElement | null;
  if (!select) return;
  if (!selectedTargetId) {
    try { selectedTargetId = localStorage.getItem(LAST_TARGET_KEY) ?? ''; } catch { /* stockage indisponible */ }
  }
  if (!targets.some((t) => t.id === selectedTargetId)) selectedTargetId = targets[0]?.id ?? '';
  select.innerHTML = '';
  for (const t of targets) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = targetText(t);
    opt.selected = t.id === selectedTargetId;
    select.appendChild(opt);
  }
  // Une seule session : inutile d'afficher un sélecteur.
  select.style.display = targets.length > 1 ? '' : 'none';
  if (targets.length === 0 && sessionState === 'idle') {
    stateMessage = 'Aucune session configurée (Paramètres Techniques > Console screen)';
  }
  renderState();
}

function targetText(t: TargetInfo): string {
  return t.screenName ? `${t.label} — ${t.host} (${t.screenName})` : `${t.label} — ${t.host}`;
}

function selectedLabel(): string {
  const t = targets.find((x) => x.id === selectedTargetId);
  return t ? targetText(t) : selectedTargetId;
}

function scheduleReconnect(): void {
  setState('closed', 'Déconnecté — reconnexion...');
  cancelReconnect();
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!sessionId) connect();
  }, RECONNECT_DELAY_MS);
}

function cancelReconnect(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function setState(state: SessionState | 'idle', message: string): void {
  sessionState = state;
  stateMessage = message;
  renderState();
}

function renderState(): void {
  const el = $('s2h-state');
  if (el) {
    el.textContent = stateMessage;
    el.className = 's2h-status' + (sessionState === 'connected' ? ' connected' : sessionState === 'error' ? ' error' : '');
  }
  const active = sessionState === 'connecting' || sessionState === 'connected';
  const connectBtn = $('s2h-connect') as HTMLButtonElement | null;
  const disconnectBtn = $('s2h-disconnect') as HTMLButtonElement | null;
  const select = $('s2h-target') as HTMLSelectElement | null;
  if (connectBtn) connectBtn.disabled = active || targets.length === 0;
  if (disconnectBtn) disconnectBtn.disabled = !active;
  if (select) select.disabled = active;
}

function attachTerminal(): void {
  const host = $('s2h-terminal');
  if (!host) return;

  if (!term) {
    term = new window.Terminal!({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      theme: { background: '#000000' }
    });
    fit = new window.FitAddon!.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((data: string) => {
      if (sessionId && sessionState === 'connected') socket.emit('screen2http:input', { sessionId, data });
    });
    term.onResize(() => sendResize());
  } else if (term.element && term.element.parentElement !== host) {
    // Retour sur la page : le DOM a été remplacé, on rattache le terminal existant (contenu conservé).
    host.appendChild(term.element);
  }

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    try { fit?.fit(); } catch { /* conteneur masqué : sans taille */ }
  });
  resizeObserver.observe(host);
  try { fit.fit(); } catch { /* idem */ }
}

function sendResize(): void {
  if (sessionId && term) {
    socket.emit('screen2http:resize', { sessionId, cols: term.cols, rows: term.rows });
  }
}

function connect(): void {
  cancelReconnect();
  if (!selectedTargetId || !term || sessionId) return;
  try { fit?.fit(); } catch { /* ignoré */ }
  term.reset();
  sessionId = newSessionId();
  setState('connecting', 'Connexion...');
  socket.emit('screen2http:session:open', {
    sessionId,
    targetId: selectedTargetId,
    cols: term.cols,
    rows: term.rows
  });
  if (pingTimer === null) {
    pingTimer = window.setInterval(() => {
      if (sessionId) socket.emit('screen2http:ping', { sessionId });
    }, PING_INTERVAL_MS);
  }
}

function disconnect(): void {
  cancelReconnect();
  closeSession();
  setState('idle', 'Déconnecté');
}

/** Demande la fermeture côté serveur et oublie la session localement. */
function closeSession(): void {
  if (sessionId) socket?.emit('screen2http:session:close', { sessionId });
  forgetSession();
}

/** La session s'est terminée côté serveur : rien à fermer, juste oublier. */
function endLocalSession(state: SessionState, message: string): void {
  forgetSession();
  setState(state === 'error' ? 'error' : 'closed', message);
}

function forgetSession(): void {
  sessionId = null;
  if (pingTimer !== null) {
    window.clearInterval(pingTimer);
    pingTimer = null;
  }
  renderState();
}

window.screen2httpApp = { init: () => { void init(); } };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
  void init();
}

export {};
