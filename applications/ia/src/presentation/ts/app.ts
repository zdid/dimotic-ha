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
  // ⭐ Comparatif Claude (config-schema.ts::provider, IaService.emitStatus()) — savoir en un coup
  // d'œil quel fournisseur traite réellement les commandes, plutôt qu'un badge toujours "Mistral".
  provider: 'mistral' | 'anthropic';
  activeModel: string;
  providerConfigured: boolean;
  // ⭐ 26/08/2026, demande utilisateur — combien de phrases traitées par le cache, l'interpréteur
  // déterministe, ou Mistral/Claude depuis le démarrage (IaService.emitStatus()).
  cacheHits: number;
  interpreterHits: number;
  mistralCalls: number;
  cacheSize: number;
}

interface ComparisonSide {
  provider: 'mistral' | 'anthropic';
  model: string;
  label?: string;
  latencyMs: number;
  decision: Record<string, unknown>;
  /** true si ce modèle a dû être relancé (vérification quoi/lieux/entity_id ratée au premier
   *  essai) avant d'arriver à cette décision — voir IaService.handleCompareCommand. */
  corrected: boolean;
}

interface CompareReply {
  question: string;
  sides: ComparisonSide[];
  match: boolean;
  anyCorrected: boolean;
  diffsPerSide: { label: string; diffs: string[] }[];
}

interface Exchange {
  at: string;
  question: string;
  response: string;
  intermediateJson?: string;
  planificateurReply?: string;
  promptTokens?: number;
  completionTokens?: number;
}

let socket: any | null = null;
// ⭐ ModuleContainer rappelle init() à chaque réaffichage depuis son cache (revisite d'un module
// déjà chargé, voir ModuleContainer.ts) pour rebrancher les écouteurs DOM sur les nouveaux nœuds —
// mais la connexion socket, elle, persiste : s'abonner à nouveau à chaque appel empilerait un
// écouteur supplémentaire par visite (bug réel constaté : "tester une commande" ne répondait plus
// après une deuxième visite, plus aucune requête n'atteignant le serveur). Ce drapeau garantit que
// setupEventListeners() (socket.on) ne s'exécute qu'une seule fois par cycle de vie de la page.
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
    setupTestForm();
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

  socket.on('ia:compare:reply', (reply: CompareReply) => {
    showCompareResult(reply);
  });

  socket.on('connect', () => {
    console.log('[IA UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[IA UI] Déconnecté du serveur Socket.io');
  });
}

// Historique des commandes de test — localStorage (propre à ce navigateur, pas synchronisé entre
// clients), demande utilisateur : les 20 dernières, sélectionnables dans la zone de saisie
// (<datalist>), une commande n'est stockée que si elle diffère de la précédente (pas de doublons
// consécutifs en répétant la même commande plusieurs fois).
const TEST_HISTORY_KEY = 'ia-test-history';
const TEST_HISTORY_MAX = 20;

function loadTestHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(TEST_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function recordTestHistory(message: string): void {
  const history = loadTestHistory();
  if (history[0] === message) return; // identique à la précédente — pas stockée
  history.unshift(message);
  history.length = Math.min(history.length, TEST_HISTORY_MAX);
  window.localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify(history));
  renderTestHistory(history);
}

function renderTestHistory(history: string[]): void {
  const datalistEl = $('test-history') as HTMLDataListElement | null;
  if (!datalistEl) return;
  datalistEl.innerHTML = history.map((h) => `<option value="${escapeHtml(h)}"></option>`).join('');
}

function setupTestForm(): void {
  const input = $('test-input') as HTMLInputElement | null;
  const sendBtn = $('test-send') as HTMLButtonElement | null;
  const compareBtn = $('test-compare') as HTMLButtonElement | null;
  if (!input || !sendBtn) return;

  renderTestHistory(loadTestHistory());

  const send = () => {
    const message = input.value.trim();
    if (!message || !socket) return;

    recordTestHistory(message);

    sendBtn.disabled = true;
    sendBtn.textContent = 'Envoi...';
    const resultEl = $('test-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'test-result';
      resultEl.textContent = 'En attente de la réponse...';
    }

    socket.emit('ia:test:send', { message });
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') send();
  });

  // Comparatif Claude/Mistral (demande utilisateur, 11/08/2026) — même phrase aux deux
  // fournisseurs, résultat détaillé dans data/ia/comparatif.log (tail -f), résumé bref ici.
  if (compareBtn) {
    compareBtn.addEventListener('click', () => {
      const message = input.value.trim();
      if (!message || !socket) return;

      recordTestHistory(message);

      compareBtn.disabled = true;
      compareBtn.textContent = 'Comparaison...';
      const resultEl = $('test-result');
      if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.className = 'test-result';
        resultEl.textContent = 'En attente des deux réponses...';
      }

      socket.emit('ia:compare:send', { message });
    });
  }
}

function showTestResult(reply: { success: boolean; response: string; intermediateJson?: string; planificateurReply?: string; promptTokens?: number; completionTokens?: number }): void {
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
    + (reply.promptTokens !== undefined ? `<div class="tokens-label">${formatTokens(reply.promptTokens, reply.completionTokens)}</div>` : '')
    + (reply.intermediateJson ? `<pre class="intermediate-json">${escapeHtml(reply.intermediateJson)}</pre>` : '')
    + (reply.planificateurReply ? `<div class="planificateur-reply-label">Réponse de planificateur :</div><pre class="intermediate-json">${escapeHtml(reply.planificateurReply)}</pre>` : '');
}

function showCompareResult(reply: CompareReply): void {
  const compareBtn = $('test-compare') as HTMLButtonElement | null;
  if (compareBtn) {
    compareBtn.disabled = false;
    compareBtn.textContent = '🧪 Comparer';
  }

  const resultEl = $('test-result');
  if (!resultEl) return;
  const fmtSide = (s: ComparisonSide) =>
    `<div>🧪 <strong>${escapeHtml(s.label ?? s.model)}</strong> (${escapeHtml(s.model)}, ${s.latencyMs} ms)${s.corrected ? ' — <span style="color:var(--color-warning)">⚠️ corrigé après vérification</span>' : ''} — non exécuté (comparatif)</div>`
    + `<pre class="intermediate-json">${escapeHtml(JSON.stringify(s.decision, null, 2))}</pre>`;

  const diffLines = reply.diffsPerSide.filter((d) => d.diffs.length > 0).map((d) => `${d.label}: ${d.diffs.join(' ; ')}`);
  const matchLabel = reply.match
    ? (reply.anyCorrected ? '⚠️ Décisions identiques, mais au moins un modèle a eu besoin d\'être corrigé (pas juste du premier coup)' : '✅ Décisions identiques, tous justes du premier coup')
    : `⚠️ Décisions différentes : ${diffLines.map(escapeHtml).join(' | ')}`;

  resultEl.style.display = 'block';
  resultEl.className = `test-result ${reply.match && !reply.anyCorrected ? 'ok' : 'error'}`;
  resultEl.innerHTML = `<div class="tokens-label">${matchLabel}</div>`
    + reply.sides.map(fmtSide).join('')
    + `<div class="tokens-label">Détail complet dans data/ia/comparatif.log</div>`;
}

function formatTokens(promptTokens: number, completionTokens?: number): string {
  const total = promptTokens + (completionTokens ?? 0);
  return `🔢 ${total} token${total > 1 ? 's' : ''} (${promptTokens} prompt + ${completionTokens ?? 0} réponse)`;
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
  const providerEl = $('provider-status');

  const providerLabel = status.provider === 'anthropic' ? 'Claude' : 'Mistral';
  if (badgeEl) {
    badgeEl.textContent = status.providerConfigured ? `Clé ${providerLabel} configurée` : `Clé ${providerLabel} manquante`;
    badgeEl.className = `status-badge ${status.providerConfigured ? 'connected' : 'disconnected'}`;
  }
  if (portEl) portEl.textContent = String(status.ollamaHttpPort);
  if (rulesEl) rulesEl.textContent = status.rulesLoaded ? 'Chargées' : 'Absentes';
  if (providerEl) providerEl.textContent = `${providerLabel} (${status.activeModel})`;

  const countersEl = $('counters-status');
  if (countersEl) countersEl.textContent = `${status.cacheHits} / ${status.interpreterHits} / ${status.mistralCalls} (cache: ${status.cacheSize}/100)`;
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
      ${e.promptTokens !== undefined ? `<div class="tokens-label">${formatTokens(e.promptTokens, e.completionTokens)}</div>` : ''}
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
