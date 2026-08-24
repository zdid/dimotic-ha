/**
 * Composant ApplicationsManager - Gestion des applications
 * Affiche et permet d'activer/désactiver les applications
 */

// Template HTML pour le Shadow DOM
const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .applications-management {
        padding: 20px;
        background: #2c3e50;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        color: #ecf0f1;
      }
      
      .applications-management h2 {
        color: #ecf0f1;
        margin-bottom: 10px;
      }
      
      .section-description {
        margin: 0 0 20px 0;
        color: #7f8c8d;
        font-size: 0.9rem;
      }
      
      .app-list-section {
        margin-bottom: 30px;
      }
      
      .app-list-section h3 {
        margin: 0 0 15px 0;
        color: #ecf0f1;
        font-size: 1.2rem;
        display: flex;
        align-items: center;
      }
      
      .app-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      .app-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 15px;
        background: #34495e;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        transition: transform 0.2s, box-shadow 0.2s;
        color: #ecf0f1;
      }
      
      .app-item:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      }
      
      .app-info {
        display: flex;
        align-items: center;
        flex: 1;
      }
      
      .app-name {
        margin-left: 10px;
        font-weight: 500;
      }
      
      .app-badge {
        font-size: 0.75rem;
        padding: 4px 10px;
        border-radius: 12px;
        margin-left: 10px;
        font-weight: bold;
      }
      
      .app-badge.activated {
        background-color: #2ecc71;
        color: white;
      }
      
      .app-badge.disabled {
        background-color: #e74c3c;
        color: white;
      }
      
      .app-actions {
        display: flex;
        gap: 10px;
      }
      
      .btn {
        padding: 6px 16px;
        border: none;
        border-radius: 4px;
        font-size: 0.85rem;
        cursor: pointer;
        transition: background-color 0.2s, opacity 0.2s;
      }
      
      .btn-success {
        background-color: #2ecc71;
        color: white;
      }
      
      .btn-success:hover {
        background-color: #27ae60;
      }
      
      .btn-warning {
        background-color: #f39c12;
        color: white;
      }
      
      .btn-warning:hover {
        background-color: #e67e22;
      }
      
      .btn-secondary {
        background-color: #34495e;
        color: #ecf0f1;
        border: 1px solid #444;
      }
      
      .btn-secondary:hover {
        background-color: #2c3e50;
      }
      
      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      
      .app-empty {
        text-align: center;
        padding: 20px;
        color: #7f8c8d;
        font-style: italic;
      }
      
      .section-actions {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      }
      
      .alert {
        padding: 12px 16px;
        border-radius: 4px;
        margin-bottom: 15px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .alert-info {
        background-color: #d9edf7;
        color: #31708f;
        border: 1px solid #bce8f1;
      }
      
      .alert-error {
        background-color: #f2dede;
        color: #a94442;
        border: 1px solid #ebccd1;
      }
      
      .alert-icon {
        font-size: 1.2rem;
      }
      
      .alert-message {
        flex: 1;
      }
      
      .alert-close {
        background: none;
        border: none;
        font-size: 1.2rem;
        cursor: pointer;
        color: inherit;
        padding: 0;
        line-height: 1;
      }

      .restart-countdown {
        display: none;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        margin-bottom: 15px;
        border-radius: 4px;
        background-color: #f39c12;
        color: #2c3e50;
        font-weight: 500;
      }

      .restart-countdown.visible {
        display: flex;
      }

      .restart-countdown .countdown-icon {
        font-size: 1.2rem;
      }
    </style>
    
    <div class="applications-management">
      <h2>📦 Gestion des applications</h2>
      <p class="section-description">
        Activez ou désactivez les applications. Chaque application démarre/s'arrête indépendamment,
        sans redémarrage de l'application principale.
      </p>
      
      <!-- Alertes -->
      <div id="alert-container"></div>

      <!-- Compte à rebours avant redémarrage (visible après une activation/désactivation) -->
      <div id="restart-countdown" class="restart-countdown">
        <span class="countdown-icon">⏱️</span>
        <span>Redémarrage dans <strong id="restart-countdown-value">15</strong>s — vous pouvez activer/désactiver d'autres applications avant, le décompte repart alors à 15s. Quitter cet écran déclenche le redémarrage immédiatement.</span>
      </div>

      <!-- Applications activées -->
      <div class="app-list-section">
        <h3>✅ Applications activées</h3>
        <div class="app-list" id="activated-list">
          <div class="app-empty">Chargement...</div>
        </div>
      </div>
      
      <!-- Applications désactivées -->
      <div class="app-list-section">
        <h3>❌ Applications désactivées</h3>
        <div class="app-list" id="disabled-list">
          <div class="app-empty">Chargement...</div>
        </div>
      </div>
      
      <!-- Bouton de rafraîchissement -->
      <div class="section-actions">
        <button id="refresh-btn" class="btn btn-secondary">
          Rafraîchir la liste
        </button>
      </div>
    </div>
  `;
  return template;
};

export class ApplicationsManager extends HTMLElement {
  private applications: { activated: string[]; disabled: string[] } = { activated: [], disabled: [] };
  private loading: boolean = false;
  private error: string | null = null;

  // Compte à rebours avant redémarrage (voir RestartManager.scheduleRestart côté serveur,
  // réinitialisé à 15s à chaque activation/désactivation) — purement visuel, ne pilote rien :
  // le serveur gère son propre minuteur indépendamment, ce compteur ne fait que le refléter.
  private restartCountdownSeconds: number | null = null;
  private restartCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private hasPendingRestart: boolean = false;
  private visibilityObserver: MutationObserver | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const template = createTemplate();
    this.shadowRoot!.appendChild(template.content.cloneNode(true));
  }

  connectedCallback() {
    this.setupEventListeners();
    this.loadApplications();
    this.observeVisibility();
  }

  disconnectedCallback() {
    this.visibilityObserver?.disconnect();
    if (this.restartCountdownInterval) clearInterval(this.restartCountdownInterval);
  }

  /**
   * Cet élément reste en permanence dans le DOM (Sidebar bascule `display: none`/`block` sur son
   * conteneur `.content-section` plutôt que de le retirer, voir Sidebar.ts::hideAllContentSections)
   * — `disconnectedCallback` ne se déclenche donc jamais à la navigation. On observe directement
   * ce basculement pour détecter "l'utilisateur a quitté cet écran".
   */
  private observeVisibility(): void {
    const section = this.closest('.content-section') as HTMLElement | null;
    if (!section) return;

    this.visibilityObserver = new MutationObserver(() => {
      if (section.style.display === 'none' && this.hasPendingRestart) {
        console.log('[ApplicationsManager] Écran quitté avec un redémarrage en attente — déclenchement immédiat');
        window.app?.appManager?.restartNow();
        this.hasPendingRestart = false;
        this.stopRestartCountdown();
      }
    });
    this.visibilityObserver.observe(section, { attributes: true, attributeFilter: ['style'] });
  }

  private setupEventListeners(): void {
    // Fenêtre de 15s avant redémarrage — (re)démarre le compte à rebours affiché à chaque
    // activation/désactivation réussie (la sienne ou celle d'un autre onglet, cet événement
    // reflète un broadcast serveur reçu par toutes les sessions connectées).
    window.addEventListener('applications:restart-pending', ((e: Event) => {
      const customEvent = e as CustomEvent<{ delaySeconds: number }>;
      this.hasPendingRestart = true;
      this.startRestartCountdown(customEvent.detail?.delaySeconds ?? 15);
    }) as EventListener);

    // Une app en process séparé (superviseur Phase 2, toutes les apps du socle aujourd'hui) démarre/
    // s'arrête seule — pas de redémarrage de core, donc pas de compte à rebours à afficher.
    window.addEventListener('applications:action-completed', ((e: Event) => {
      const customEvent = e as CustomEvent<{ appId: string; action: 'activée' | 'désactivée' }>;
      const { appId, action } = customEvent.detail;
      this.showAlert('info', `Application ${appId} ${action} avec succès.`);
    }) as EventListener);

    // Écouter le chargement des applications
    window.addEventListener('applications:loaded', ((e: Event) => {
      const customEvent = e as CustomEvent;
      this.applications = customEvent.detail;
      this.loading = false;
      this.error = null;
      this.render();
    }) as EventListener);
    
    // Écouter les erreurs
    window.addEventListener('applications:error', ((e: Event) => {
      const customEvent = e as CustomEvent;
      this.error = customEvent.detail?.message || null;
      this.loading = false;
      if (this.error) {
        this.showAlert('error', this.error);
      }
    }) as EventListener);
    
    // Écouter les actions
    window.addEventListener('applications:enabling', ((e: Event) => {
      const customEvent = e as CustomEvent;
      this.loading = true;
      this.showAlert('info', `Activation de ${customEvent.detail?.appId || 'application'} en cours...`);
    }) as EventListener);
    
    window.addEventListener('applications:disabling', ((e: Event) => {
      const customEvent = e as CustomEvent;
      this.loading = true;
      this.showAlert('info', `Désactivation de ${customEvent.detail?.appId || 'application'} en cours...`);
    }) as EventListener);
    
    // Bouton de rafraîchissement
    const refreshBtn = this.shadowRoot!.getElementById('refresh-btn');
    refreshBtn?.addEventListener('click', () => {
      this.loadApplications();
    });
  }
  
  private loadApplications(): void {
    this.loading = true;
    this.error = null;
    
    // Attendre que window.app soit disponible
    if (window.app && window.app.appManager) {
      window.app.appManager.refreshApplications();
    } else {
      // Si pas encore chargé, essayer plus tard
      setTimeout(() => this.loadApplications(), 100);
    }
  }
  
  private render(): void {
    this.renderActivatedList();
    this.renderDisabledList();
    this.updateLoadingState();
  }
  
  private renderActivatedList(): void {
    const container = this.shadowRoot!.getElementById('activated-list');
    if (!container) return;
    
    if (this.loading) {
      container.innerHTML = '<div class="app-empty">Chargement...</div>';
      return;
    }
    
    if (this.applications.activated.length === 0) {
      container.innerHTML = '<div class="app-empty">Aucune application activée</div>';
      return;
    }
    
    container.innerHTML = this.applications.activated.map(app => `
      <div class="app-item">
        <div class="app-info">
          <span>📦</span>
          <span class="app-name">${app}</span>
          <span class="app-badge activated">Activée</span>
        </div>
        <div class="app-actions">
          <button 
            onclick="if(window.app && window.app.appManager) { window.app.appManager.disableApplication('${app}'); } else { console.error('appManager non disponible'); }"
            class="btn btn-warning"
            ${this.loading ? 'disabled' : ''}
          >
            Désactiver
          </button>
        </div>
      </div>
    `).join('');
  }
  
  private renderDisabledList(): void {
    const container = this.shadowRoot!.getElementById('disabled-list');
    if (!container) return;
    
    if (this.loading) {
      container.innerHTML = '<div class="app-empty">Chargement...</div>';
      return;
    }
    
    if (this.applications.disabled.length === 0) {
      container.innerHTML = '<div class="app-empty">Aucune application désactivée</div>';
      return;
    }
    
    container.innerHTML = this.applications.disabled.map(app => `
      <div class="app-item">
        <div class="app-info">
          <span>📦</span>
          <span class="app-name">${app}</span>
          <span class="app-badge disabled">Désactivée</span>
        </div>
        <div class="app-actions">
          <button 
            onclick="if(window.app && window.app.appManager) { window.app.appManager.enableApplication('${app}'); } else { console.error('appManager non disponible'); }"
            class="btn btn-success"
            ${this.loading ? 'disabled' : ''}
          >
            Activer
          </button>
        </div>
      </div>
    `).join('');
  }
  
  private updateLoadingState(): void {
    const refreshBtn = this.shadowRoot!.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.setAttribute('disabled', this.loading ? 'true' : 'false');
      refreshBtn.textContent = this.loading ? 'Chargement...' : 'Rafraîchir la liste';
    }
  }
  
  /**
   * (Re)démarre le compte à rebours affiché — un appel alors qu'un compte à rebours est déjà en
   * cours le réinitialise à `seconds` (même sémantique que RestartManager.scheduleRestart côté
   * serveur, qu'il ne fait ici que refléter visuellement).
   */
  private startRestartCountdown(seconds: number): void {
    if (this.restartCountdownInterval) clearInterval(this.restartCountdownInterval);

    this.restartCountdownSeconds = seconds;
    this.renderRestartCountdown();

    this.restartCountdownInterval = setInterval(() => {
      if (this.restartCountdownSeconds === null) return;
      this.restartCountdownSeconds -= 1;
      if (this.restartCountdownSeconds <= 0) {
        this.stopRestartCountdown();
        this.showRestartingBanner();
        return;
      }
      this.renderRestartCountdown();
    }, 1000);
  }

  private stopRestartCountdown(): void {
    if (this.restartCountdownInterval) {
      clearInterval(this.restartCountdownInterval);
      this.restartCountdownInterval = null;
    }
    this.restartCountdownSeconds = null;
    const el = this.shadowRoot!.getElementById('restart-countdown');
    el?.classList.remove('visible');
  }

  private renderRestartCountdown(): void {
    const el = this.shadowRoot!.getElementById('restart-countdown');
    const valueEl = this.shadowRoot!.getElementById('restart-countdown-value');
    if (!el || !valueEl || this.restartCountdownSeconds === null) return;
    valueEl.textContent = String(this.restartCountdownSeconds);
    el.classList.add('visible');
  }

  private showRestartingBanner(): void {
    const el = this.shadowRoot!.getElementById('restart-countdown');
    if (!el) return;
    el.innerHTML = '<span class="countdown-icon">🔄</span><span>Redémarrage en cours...</span>';
    el.classList.add('visible');
  }

  private showAlert(type: 'info' | 'error', message: string): void {
    const container = this.shadowRoot!.getElementById('alert-container');
    if (!container) return;
    
    const alertClasses = type === 'info' ? 'alert alert-info' : 'alert alert-error';
    const alertIcon = type === 'info' ? 'ℹ️' : '⚠️';
    
    container.innerHTML = `
      <div class="${alertClasses}">
        <span class="alert-icon">${alertIcon}</span>
        <span class="alert-message">${message}</span>
        <button class="alert-close" onclick="this.parentElement.parentElement.innerHTML = ''">×</button>
      </div>
    `;
    
    // Supprimer l'alerte après 5 secondes
    setTimeout(() => {
      container.innerHTML = '';
    }, 5000);
  }
}

// Enregistrer le composant
customElements.define('app-applications-manager', ApplicationsManager);
