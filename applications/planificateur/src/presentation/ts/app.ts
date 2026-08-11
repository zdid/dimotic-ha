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

interface PlanificationDefinition {
  id?: number;
  name: string;
  active: boolean;
  phrase_originale: string;
  trigger: { type: string };
  next_fire_at?: string;
  missed?: boolean;
}

interface IaTestReply {
  success: boolean;
  response: string;
  intermediateJson?: string;
  planificateurReply?: string;
}

interface PlanificateurAction {
  at: string;
  source: 'ia:command' | 'ia:tool:execute';
  request: string;
  reply: string;
  success: boolean;
}

interface HaCommandTrace {
  at: string;
  trigger: string;
  step: { verbe?: string; quoi?: string; lieux?: string[]; valeur?: string | number; order?: string };
  outcome: 'resolved' | 'fallback_conversation' | 'ignored';
  resolved?: { domain: string; service: string; entity_id: string | string[]; data?: Record<string, unknown> };
  success?: boolean;
  error?: string;
  triggeredByEntityId?: string;
  nextFireAt?: string;
}

const OUTCOME_LABELS: Record<HaCommandTrace['outcome'], string> = {
  resolved: 'Service HA appelé',
  fallback_conversation: 'Repli conversation HA',
  ignored: 'Ignoré (rien envoyé)'
};

let socket: any | null = null;
// ⭐ ModuleContainer rappelle init() à chaque réaffichage depuis son cache (revisite d'un module
// déjà chargé, voir ModuleContainer.ts) pour rebrancher les écouteurs DOM sur les nouveaux nœuds —
// mais la connexion socket, elle, persiste : s'abonner à nouveau à chaque appel empilerait un
// écouteur supplémentaire par visite (bug réel constaté : l'écran restait bloqué sur "Chargement"
// après une deuxième visite). Ce drapeau garantit que setupEventListeners() (socket.on) ne
// s'exécute qu'une seule fois par cycle de vie de la page.
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
    setupTabs();
    setupNewPlanificationModal();
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

  socket.on('planificateur:planifications:list', (plans: PlanificationDefinition[]) => {
    updatePlanificationsList(plans);
  });

  socket.on('planificateur:actions:list', (actions: PlanificateurAction[]) => {
    updateActionsLog(actions);
  });

  socket.on('planificateur:ha-commands:list', (commands: HaCommandTrace[]) => {
    updateHaCommandsLog(commands);
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
  socket.emit('planificateur:planifications:list:get');
  socket.emit('planificateur:actions:list:get');
  socket.emit('planificateur:ha-commands:list:get');
}

function updateStatusDisplay(status: PlanificateurStatus): void {
  const macrosEl = $('macros-count');
  const planificationsEl = $('planifications-count');
  const activeEl = $('active-count');

  if (macrosEl) macrosEl.textContent = String(status.macrosCount);
  if (planificationsEl) planificationsEl.textContent = String(status.planificationsCount);
  if (activeEl) activeEl.textContent = String(status.activeSchedules.length);
}

function formatNextFireAt(plan: PlanificationDefinition): string {
  if (plan.trigger.type === 'state_change') return 'Réactif (changement d\'état)';
  if (!plan.next_fire_at) return plan.active ? 'Non programmée' : '—';
  return `Prochaine exécution : ${new Date(plan.next_fire_at).toLocaleString('fr-FR')}`;
}

function updatePlanificationsList(plans: PlanificationDefinition[]): void {
  const listEl = $('planifications-list');
  if (!listEl) return;

  if (plans.length === 0) {
    listEl.innerHTML = '<div class="empty">Aucune planification enregistrée.</div>';
    return;
  }

  const sorted = [...plans].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  listEl.innerHTML = sorted.map((p) => `
    <div class="plan-row">
      <div class="plan-num">#${p.id ?? '?'}</div>
      <div class="plan-info">
        <div class="plan-name">
          ${p.name ? escapeHtml(p.name) : ''}
          <span class="status-badge ${p.active ? 'active' : 'inactive'}">${p.active ? 'active' : 'inactive'}</span>
          ${p.missed ? '<span class="status-badge missed">manqué</span>' : ''}
        </div>
        <div class="plan-phrase">"${escapeHtml(p.phrase_originale)}"</div>
        <div class="plan-next">${escapeHtml(formatNextFireAt(p))}</div>
      </div>
      <div class="plan-actions">
        ${p.active
          ? `<button class="btn btn-secondary" data-action="planification-desactiver" data-name="${escapeHtml(p.name)}">Désactiver</button>`
          : `<button class="btn btn-primary" data-action="planification-activer" data-name="${escapeHtml(p.name)}">Activer</button>`}
        <button class="btn btn-danger" data-action="planification-supprimer" data-name="${escapeHtml(p.name)}">Supprimer</button>
      </div>
    </div>
  `).join('');

  wirePlanificationActions(listEl);
}

function wirePlanificationActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const name = btn.dataset.name;
      if (!action || !name || !socket) return;

      switch (action) {
        case 'planification-activer': socket.emit('planificateur:planification:activer', { name }); break;
        case 'planification-desactiver': socket.emit('planificateur:planification:desactiver', { name }); break;
        case 'planification-supprimer': socket.emit('planificateur:planification:supprimer', { name }); break;
      }
    });
  });
}

function setupTabs(): void {
  const root = moduleRoot();
  root.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (!tab) return;
      root.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      root.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${tab}`)?.classList.add('active');
    });
  });
}

/**
 * Modale de création — soumet la phrase telle quelle à ia (`ia:test:send`, même mécanisme que le
 * formulaire de test du dashboard `ia`, specs §13) : aucune validation/structuration locale, c'est
 * Mistral qui décide si la phrase est une planification exploitable et répond via `ia:test:reply`.
 */
function setupNewPlanificationModal(): void {
  const openBtn = $('new-planification-btn');
  const overlay = $('new-planification-overlay');
  const cancelBtn = $('new-planification-cancel');
  const submitBtn = $('new-planification-submit') as HTMLButtonElement | null;
  const input = $('new-planification-input') as HTMLTextAreaElement | null;
  const successEl = $('new-planification-success');
  const errorEl = $('new-planification-error');
  if (!openBtn || !overlay || !cancelBtn || !submitBtn || !input) return;

  const resetAlerts = () => {
    if (successEl) { successEl.style.display = 'none'; successEl.textContent = ''; }
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  };

  const open = () => {
    input.value = '';
    resetAlerts();
    overlay.classList.add('active');
    input.focus();
  };

  const close = () => {
    overlay.classList.remove('active');
  };

  openBtn.addEventListener('click', open);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  submitBtn.addEventListener('click', () => {
    const message = input.value.trim();
    if (!message || !socket) return;

    resetAlerts();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Validation...';

    const onReply = (reply: IaTestReply) => {
      socket.off('ia:test:reply', onReply);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Valider';

      // planificateurReply.success distingue "ia a compris et planificateur a enregistré" d'un
      // simple échange conversationnel (aucun JSON structuré produit) — reply.success ne couvre
      // que l'absence d'erreur technique côté ia, pas la validation métier de la planification.
      let planifOk: boolean | undefined;
      try {
        planifOk = reply.planificateurReply ? JSON.parse(reply.planificateurReply).success : undefined;
      } catch { /* ignore, traité comme indéterminé */ }

      if (reply.success && planifOk !== false) {
        if (successEl) { successEl.textContent = reply.response; successEl.style.display = 'block'; }
        socket.emit('planificateur:planifications:list:get');
        socket.emit('planificateur:status:get');
        setTimeout(close, 1500);
      } else if (errorEl) {
        errorEl.textContent = reply.response || 'La planification n\'a pas pu être créée.';
        errorEl.style.display = 'block';
      }
    };

    socket.on('ia:test:reply', onReply);
    socket.emit('ia:test:send', { message });
  });
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

function updateHaCommandsLog(commands: HaCommandTrace[]): void {
  const cardEl = $('ha-commands-card');
  const listEl = $('ha-commands-list');
  if (!listEl) return;

  if (commands.length === 0) {
    if (cardEl) cardEl.style.display = 'none';
    return;
  }

  if (cardEl) cardEl.style.display = 'block';
  listEl.innerHTML = commands.map((c) => {
    const stepLabel = [c.step.verbe, c.step.quoi, ...(c.step.lieux || [])].filter(Boolean).join(' ') || c.step.order || '(étape sans détail)';
    const metaParts: string[] = [`Déclencheur : ${escapeHtml(c.trigger)}`];
    if (c.triggeredByEntityId) metaParts.push(`En réaction à : ${escapeHtml(c.triggeredByEntityId)}`);
    if (c.nextFireAt) metaParts.push(`Prochaine exécution : ${new Date(c.nextFireAt).toLocaleString('fr-FR')}`);

    return `
    <div class="action-row">
      <span class="at">${new Date(c.at).toLocaleString('fr-FR')}</span>
      <span class="source">${escapeHtml(stepLabel)}</span>
      <span class="badge outcome-${c.outcome}">${OUTCOME_LABELS[c.outcome]}</span>
      ${c.success === false ? '<span class="badge error">Échec</span>' : ''}
      <div class="meta">${metaParts.join(' · ')}</div>
      ${c.resolved ? `<pre>${escapeHtml(JSON.stringify(c.resolved, null, 2))}</pre>` : ''}
      ${c.error ? `<pre>${escapeHtml(c.error)}</pre>` : ''}
    </div>
  `;
  }).join('');
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
