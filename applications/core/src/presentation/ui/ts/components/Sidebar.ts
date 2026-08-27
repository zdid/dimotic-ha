import { Module, ApplicationMenuConfig } from '../types';

/**
 * Composant Sidebar - Barre latérale de navigation
 * Web Component pour afficher le menu des applications
 */

// Template HTML pour le Shadow DOM
const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .sidebar {
        width: 250px;
        height: 100vh;
        background: #2c3e50;
        color: white;
        position: fixed;
        left: 0;
        top: 0;
        display: flex;
        flex-direction: column;
        z-index: 1000;
        box-shadow: 2px 0 5px rgba(0, 0, 0, 0.5);
      }
      
      .sidebar-header {
        padding: 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      
      .sidebar-header h1 {
        margin: 0;
        font-size: 1.5rem;
        font-weight: 600;
      }
      
      .sidebar-header p {
        margin: 5px 0 0 0;
        font-size: 0.85rem;
        color: #bdc3c7;
      }
      
      .sidebar-nav {
        flex: 1;
        padding: 15px;
        overflow-y: auto;
      }
      
      .nav-title {
        font-size: 0.85rem;
        text-transform: uppercase;
        color: #bdc3c7;
        margin-bottom: 10px;
        padding: 0 10px;
      }
      
      .nav-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      
      .nav-item {
        margin-bottom: 5px;
        border-radius: 4px;
        transition: background-color 0.2s;
      }
      
      .nav-item.nav-item-active {
        background-color: #2c3e50;
      }
      
      .nav-item:hover:not(.nav-item-active) {
        background-color: #34495e;
      }
      
      .nav-link {
        display: flex;
        align-items: center;
        padding: 10px 15px;
        color: white;
        text-decoration: none;
        cursor: pointer;
      }
      
      .nav-icon {
        margin-right: 10px;
        font-size: 1.1rem;
      }
      
      .nav-label {
        flex: 1;
        font-size: 0.9rem;
      }
      
      .nav-status {
        display: flex;
        align-items: center;
        font-size: 0.85rem;
      }
      
      .nav-status .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 5px;
      }
      
      .status-configured { color: #2ecc71; }
      .status-partial { color: #f39c12; }
      .status-missing { color: #e74c3c; }
      .status-error { color: #c0392b; }
      
      .sidebar-footer {
        padding: 15px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      }
      
      .status-indicator {
        display: flex;
        align-items: center;
        font-size: 0.85rem;
        color: #bdc3c7;
      }

      .status-indicator + .status-indicator {
        margin-top: 6px;
      }
      
      .status-indicator .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background-color: #e74c3c;
        margin-right: 8px;
        transition: background-color 0.3s;
      }
      
      .status-indicator.pending .status-dot {
        background-color: #f39c12;
      }

      .status-indicator.connected .status-dot {
        background-color: #2ecc71;
      }
      
      .uptime {
        font-size: 0.85rem;
        color: #bdc3c7;
        margin-top: 10px;
      }

      .host-info {
        font-size: 0.75rem;
        color: #7f8c8d;
        margin-top: 4px;
      }
      
      .app-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 15px;
        border-radius: 4px;
        margin-bottom: 5px;
        cursor: pointer;
        transition: background-color 0.2s;
      }
      
      .app-item:hover {
        background-color: #34495e;
      }
      
      .app-info {
        display: flex;
        align-items: center;
        flex: 1;
      }
      
      .app-name {
        margin-left: 10px;
      }
      
      .app-badge {
        font-size: 0.75rem;
        padding: 2px 8px;
        border-radius: 10px;
        background-color: rgba(255, 255, 255, 0.1);
      }
      
      .app-badge.activated { background-color: #2ecc71; }
      .app-badge.disabled { background-color: #e74c3c; }
      
      /* Style pour les sous-menus des paramètres d'applications */
      .app-param-item .nav-link {
        padding-left: 30px;
      }
      
      .app-actions button {
        padding: 4px 12px;
        font-size: 0.75rem;
        border: none;
        border-radius: 3px;
        cursor: pointer;
      }
      
      .btn-success { background-color: #2ecc71; color: white; }
      .btn-warning { background-color: #f39c12; color: white; }
      
      .section-actions {
        margin-top: 15px;
        padding: 10px 15px;
      }
      
      /* Contenu principal */
      .main-content {
        margin-left: 250px;
        padding: 20px;
        min-height: 100vh;
      }
      
      .content-section {
        display: none;
      }
      
      .content-section[style*="display: block"] {
        display: block;
      }
      
      /* Alignement des sous-menus dans Paramètres Techniques */
      .app-param-item .nav-link {
        padding-left: 15px;
      }
      
      /* Menu accordéon pour Paramètres Techniques */
      .nav-section {
        margin-bottom: 5px;
      }
      
      .nav-section-header {
        display: flex;
        align-items: center;
        padding: 10px 15px;
        cursor: pointer;
        border-radius: 4px;
        transition: background-color 0.2s;
      }
      
      .nav-section-header:hover {
        background-color: #34495e;
      }
      
      .nav-section-title {
        font-size: 0.85rem;
        text-transform: uppercase;
        color: #bdc3c7;
        flex: 1;
      }
      
      .toggle-icon {
        font-size: 0.8rem;
        transition: transform 0.3s;
      }
      
      .nav-section-collapse {
        display: none;
      }
      
      .nav-section-collapse.visible {
        display: block !important;
      }
      
      .nav-section-header.expanded .toggle-icon {
        transform: rotate(90deg);
      }
      
      .nav-section-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
    </style>
    
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>HA/MQTT</h1>
        <p>Configuration Interface</p>
      </div>
      
      <nav class="sidebar-nav" x-data="{ openSection: null }">
        <!-- PARAMETRES TECHNIQUES - Accordéon -->
        <div class="nav-section">
          <div class="nav-section-header" id="params-header"
               :class="{ expanded: openSection === 'params', collapsed: openSection !== 'params' }"
               @click="openSection = (openSection === 'params' ? null : 'params')">
            <span class="nav-section-title">Paramètres Techniques</span>
            <span class="toggle-icon" x-text="openSection === 'params' ? '▼' : '▲'">▲</span>
          </div>
          <div class="nav-section-collapse" id="params-collapse" :class="{ visible: openSection === 'params' }">
            <ul class="nav-section-list">
              <li class="nav-item">
                <a href="#ha" class="nav-link" data-section="ha">
                  <span class="nav-icon">⚙️</span>
                  <span class="nav-label">Web-services</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#mqtt" class="nav-link" data-section="mqtt">
                  <span class="nav-icon">📡</span>
                  <span class="nav-label">MQTT (Broker externe)</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#web" class="nav-link" data-section="web">
                  <span class="nav-icon">🌐</span>
                  <span class="nav-label">Serveur Web</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#logging" class="nav-link" data-section="logging">
                  <span class="nav-icon">📝</span>
                  <span class="nav-label">Journalisation</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#applications-manager" class="nav-link" data-section="applications-manager">
                  <span class="nav-icon">📦</span>
                  <span class="nav-label">Gestion des applications</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#deployment" class="nav-link" data-section="deployment">
                  <span class="nav-icon">🚀</span>
                  <span class="nav-label">Déploiement</span>
                </a>
              </li>
              <li class="nav-item">
                <a href="#post-install" class="nav-link" data-section="post-install">
                  <span class="nav-icon">🔧</span>
                  <span class="nav-label">Services post-installation</span>
                </a>
              </li>
              <!-- Sous-menus générés pour chaque application -->
              <div id="app-params-submenu"></div>
            </ul>
          </div>
        </div>

        <!-- MODULES/APPLICATIONS -->
        <div class="nav-section">
          <div class="nav-section-header"
               :class="{ expanded: openSection === 'applications', collapsed: openSection !== 'applications' }"
               @click="openSection = (openSection === 'applications' ? null : 'applications')">
            <span class="nav-section-title">Applications</span>
            <span class="toggle-icon" x-text="openSection === 'applications' ? '▼' : '▲'">▲</span>
          </div>
          <div class="nav-section-collapse" :class="{ visible: openSection === 'applications' }">
            <ul class="nav-section-list" id="modules-container">
              <!-- Les modules seront insérés ici dynamiquement -->
            </ul>
          </div>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="status-indicator" id="status-indicator" :class="{ pending: $store.haWs.enabled && !$store.haWs.connected, connected: $store.haWs.enabled && $store.haWs.connected }">
          <span class="status-dot"></span>
          <span>HA WebSocket</span>
        </div>
        <div class="status-indicator" id="mqtt-status-indicator" :class="{ pending: $store.mqtt.enabled && !$store.mqtt.connected, connected: $store.mqtt.enabled && $store.mqtt.connected }">
          <span class="status-dot"></span>
          <span>MQTT</span>
        </div>
        <div class="uptime">
          Uptime: <span id="uptime">0s</span>
        </div>
        <div class="host-info" id="host-info"></div>
      </div>
    </aside>
  `;
  return template;
};

export class Sidebar extends HTMLElement {
  private modules: Module[] = [];
  private activeModule: string | null = null;
  private uptime: number = 0;
  private customMenus: Record<string, ApplicationMenuConfig> = {};
  // ⭐ 24/08/2026 — version déployée + hôte, affichés sous Uptime (voir updateHostInfo()).
  private appVersion: string | null = null;
  private machineId: string | null = null;
  private hostAddress: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const template = createTemplate();
    this.shadowRoot!.appendChild(template.content.cloneNode(true));
  }

  connectedCallback() {
    this.setupEventListeners();
    this.render();
    this.setupMenuClicks();
    // Le template est cloné dans le constructeur (pas injecté après coup) : le scan initial
    // d'Alpine ne traverse pas cette frontière Shadow DOM (alpinejs-implementation_specs_v1.0.md
    // §3.4), il faut donc l'appeler explicitement une fois le contenu en place.
    window.Alpine?.initTree(this.shadowRoot!);
  }
  
  private setupEventListeners(): void {
    // Écouter les modules chargés
    window.addEventListener('modules:loaded', (e: any) => {
      this.modules = e.detail.modules;
      // ⭐ 27/08/2026 — page d'accueil par défaut (remplace l'ancien auto-sélection du premier
      // module métier), même règle que ModuleContainer.ts : rien à activer si aucune application
      // ne tourne (core seul).
      if (this.modules.length > 0 && !this.activeModule) {
        const hasNonCoreModule = this.modules.some(m => m.id !== 'core');
        if (hasNonCoreModule) {
          // setActiveModuleAndShow (pas juste setActiveModule) : révèle aussi #modules-container
          // (masqué par défaut, style.display:none dans index.html) — sans ça, le contenu de la
          // page d'accueil est bien construit dans le Shadow DOM de ModuleContainer mais reste
          // invisible, aucun autre code ne le révèle sur ce chemin de sélection automatique.
          this.setActiveModuleAndShow('accueil');
        }
      }
      this.render();
    });
    
    // Écouter le module actif changé
    window.addEventListener('module:activated', (e: CustomEvent) => {
      this.activeModule = e.detail.moduleId;
      this.render();
    });
    
    // Écouter les enregistrements de menu dynamiques (pour NOMMAGE et autres)
    // Essayez d'abord avec SocketService via window.app
    const setupSocketMenuListener = () => {
      if (window.app?.socketService) {
        const socketService = window.app.socketService;
        socketService.on('app:menu:register', (data: { appId: string; menuConfig: ApplicationMenuConfig }) => {
          console.log('[Sidebar] Menu dynamique enregistré:', data.appId, data.menuConfig);
          this.registerCustomMenu(data.appId, data.menuConfig);
          this.render();
        });
      } else if (typeof io !== 'undefined') {
        // Si SocketService n'est pas disponible, essayer avec io directement
        io().on('app:menu:register', (data: { appId: string; menuConfig: ApplicationMenuConfig }) => {
          console.log('[Sidebar] Menu dynamique enregistré (via io):', data.appId, data.menuConfig);
          this.registerCustomMenu(data.appId, data.menuConfig);
          this.render();
        });
      } else {
        // Essayer à nouveau dans 1 seconde
        setTimeout(setupSocketMenuListener, 1000);
      }
    };
    
    // Installer l'écouteur
    setupSocketMenuListener();

    // Les indicateurs HA WebSocket / MQTT sont pilotés directement dans le template par
    // $store.haWs.{enabled,connected} / $store.mqtt.{enabled,connected} (⭐ 24/08/2026, tri-état
    // rouge/orange/vert — désactivé / activé mais non connecté / connecté) — voir
    // TechnicalConfigManager.ts, qui écrit dans ces stores. $store.ws.connected (écrit par
    // SocketService.ts) reste la connexion Socket.io locale au navigateur, volontairement
    // distincte et non affichée ici — non conflatée avec le statut HA depuis ce correctif.

    // Écouter l'uptime (+ version, ⭐ 24/08/2026)
    window.addEventListener('app:started', (e: CustomEvent) => {
      this.uptime = e.detail.uptime || Date.now();
      this.updateUptime();
      this.appVersion = e.detail.version || null;
      this.updateHostInfo();

      // Mettre à jour l'uptime toutes les secondes
      setInterval(() => this.updateUptime(), 1000);
    });

    // Identité de la machine hôte (⭐ 24/08/2026, voir app.ts — dispatché depuis app:machine-id)
    window.addEventListener('app:machine-id', (e: CustomEvent) => {
      this.machineId = e.detail.machineId || null;
      this.hostAddress = e.detail.address || null;
      this.updateHostInfo();
    });
    
    // Scroll vers une section
    window.addEventListener('scroll-to-section', (e: CustomEvent) => {
      this.scrollToSection(e.detail.sectionId);
    });
  }
  
  private setupMenuClicks(): void {
    // Masquer toutes les sections au départ
    this.hideAllContentSections();

    // L'ouverture/repliage visuel de l'accordéon (expanded/collapsed, icône, panneau visible)
    // est géré déclarativement par Alpine (x-data/@click dans le template, voir createTemplate).
    // Un clic sur un header reste un "changement de menu" côté contenu principal : effacer la
    // zone de contenu affichée, quel que soit le sens du clic (ouverture ou fermeture).
    const headers = this.shadowRoot!.querySelectorAll('.nav-section-header');
    headers.forEach(header => {
      header.addEventListener('click', () => {
        this.hideAllContentSections();
      });
    });

    // Écouter les clics sur les liens de navigation
    this.shadowRoot!.querySelectorAll('.nav-link[data-section]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Empêcher le déclenchement du clic sur le header parent
        const sectionId = (link as HTMLElement).getAttribute('data-section');
        this.showContentSection(sectionId || '');
      });
    });
  }

  private hideAllContentSections(): void {
    // Méthode 1 : via main.main-content
    const mainContent = document.querySelector('main.main-content');
    if (mainContent) {
      const sections = mainContent.querySelectorAll('.content-section');
      console.log('[Sidebar] hideAllContentSections - Méthode 1, Nombre de sections:', sections.length);
      sections.forEach((section, index) => {
        (section as HTMLElement).style.display = 'none';
        console.log(`[Sidebar] Section ${index} masquée:`, section.id);
      });
      return;
    }
    
    // Méthode 2 : recherche directe
    console.log('[Sidebar] hideAllContentSections - Méthode 2, recherche directe');
    const allSections = document.querySelectorAll('.content-section');
    console.log('[Sidebar] Nombre de sections trouvées:', allSections.length);
    allSections.forEach((section, index) => {
      (section as HTMLElement).style.display = 'none';
      console.log(`[Sidebar] Section ${index} masquée (méthode 2):`, section.id);
    });
    
    if (!mainContent) {
      console.log('[Sidebar] WARNING: main.main-content non trouvé');
    }
  }
  
  private showModuleConfig(moduleId: string): void {
    console.log(`[Sidebar] Affichage de la configuration technique pour module: ${moduleId}`);
    this.hideAllContentSections();
    
    // Afficher la section HA (ou autre section statique) mais avec ConfigForm en mode module
    const haSection = document.getElementById('section-ha');
    if (haSection) {
      haSection.style.display = 'block';
      
      // Trouver le ConfigForm dans cette section et le configurer pour le module
      const configForm = haSection.querySelector('app-config-form');
      if (configForm) {
        console.log(`[Sidebar] ConfigForm trouvé, chargement de la config pour module: ${moduleId}`);
        // Émettre l'événement pour que ConfigForm charge la config du module
        window.dispatchEvent(new CustomEvent('module:config:show', {
          detail: { moduleId }
        }));
      } else {
        console.log('[Sidebar] ConfigForm non trouvé dans section-ha');
      }
    }
  }
  
  private showContentSection(sectionId: string): void {
    console.log('[Sidebar] showContentSection - Début, sectionId:', sectionId);
    this.hideAllContentSections();
    console.log('[Sidebar] showContentSection - hideAllContentSections terminé');
    
    // Réinitialiser ConfigForm s'il était en mode module
    const allConfigForms = document.querySelectorAll('app-config-form');
    allConfigForms.forEach((form) => {
      const htmlForm = form as HTMLElement;
      console.log('[Sidebar] Réinitialisation de ConfigForm:', htmlForm.getAttribute('data-section'));
      // Forcer la réinitialisation en changeant data-section
      htmlForm.setAttribute('data-section', sectionId);
    });
    // ⭐ 24/08/2026, correctif bug réel constaté : setAttribute() ci-dessus ne déclenche
    // attributeChangedCallback() QUE si la valeur change textuellement (comportement natif des
    // Web Components) — revenir sur la MÊME section statique après un détour par showModuleConfig()
    // (qui ne touche jamais data-section, seulement l'événement module:config:show) laisse
    // ConfigForm bloqué en "mode module" indéfiniment : la section affichée montre le formulaire du
    // dernier module consulté plutôt que ses propres champs statiques. `scroll-to-section` est un
    // vrai CustomEvent (toujours redéclenché, pas de garde sur une valeur inchangée) — ConfigForm y
    // réinitialise déjà correctement son mode module (voir son listener dédié), donc le réutiliser
    // ici couvre aussi ce cas sans dépendre de la comparaison de l'attribut.
    window.dispatchEvent(new CustomEvent('scroll-to-section', { detail: { sectionId } }));

    // Mapper les sections du menu aux IDs des div de contenu
    const sectionMappings: Record<string, string> = {
      'ha': 'section-ha',
      'mqtt': 'section-mqtt',
      'web': 'section-web',
      'logging': 'section-logging',
      'applications-manager': 'section-applications-manager',
      'deployment': 'section-deployment',
      'post-install': 'section-post-install'
    };
    
    // Page d'accueil (⭐ 27/08/2026, voir HomeView.ts) — même reveal que les modules dynamiques
    // ci-dessous, 'accueil' n'étant pas dans this.modules.
    if (sectionId === 'accueil') {
      this.setActiveModuleAndShow('accueil');
      return;
    }

    // Pour les applications dynamiques (app-nom)
    if (sectionId.startsWith('app-')) {
      // Pour les applications, on pourrait afficher une section dédiée
      // Pour l'instant, on affiche applications-manager
      this.showContentSection('applications-manager');
      return;
    }
    
    // Pour les modules dynamiques (clic depuis le menu Applications)
    if (this.modules.some(m => m.id === sectionId)) {
      console.log(`[Sidebar] showContentSection - Module dynamique détecté: ${sectionId}`);
      const modulesContainer = document.getElementById('modules-container');
      console.log(`[Sidebar] modules-container trouvé:`, !!modulesContainer);
      if (modulesContainer) {
        modulesContainer.style.display = 'block';
        console.log(`[Sidebar] modules-container affiché`);
        this.setActiveModule(sectionId);
      } else {
        console.log(`[Sidebar] ERREUR: modules-container non trouvé`);
      }
      return;
    }
    
    // Afficher la section mappée
    const contentSectionId = sectionMappings[sectionId];
    if (contentSectionId) {
      const section = document.getElementById(contentSectionId);
      if (section) {
        section.style.display = 'block';
      }
    }
  }
  
  private render(): void {
    this.renderModules();
    this.renderAppParamsSubmenu();
    this.updateUptime();
  }
  
  private renderModules(): void {
    const container = this.shadowRoot!.getElementById('modules-container');
    if (!container) return;
    
    const statusIcons: Record<string, string> = {
      configured: '✓',
      partial: '⚠',
      missing: '✗',
      error: '✘'
    };
    
    // Filtrer pour ne pas afficher 'core' ici (il sera géré dans le contenu principal)
    const displayModules = this.modules.filter(m => m.id !== 'core');
    
    console.log('[Sidebar] renderModules - Modules à afficher:', displayModules.map(m => `${m.id}(${m.name})`));

    // ⭐ 27/08/2026 — entrée "Accueil" épinglée en tête (page d'accueil, voir HomeView.ts) : pas un
    // vrai module (aucune entrée dans this.modules), toujours affichée dès qu'au moins une
    // application non-core tourne, même condition que le choix de module actif par défaut.
    const accueilItem = displayModules.length > 0 ? `
      <li class="nav-item ${this.activeModule === 'accueil' ? 'nav-item-active' : ''}">
        <a href="#accueil" class="nav-link" data-module-id="accueil">
          <span class="nav-icon">🏠</span>
          <span class="nav-label">Accueil</span>
        </a>
      </li>
    ` : '';

    container.innerHTML = accueilItem + displayModules.map(module => `
      <li class="nav-item ${this.activeModule === module.id ? 'nav-item-active' : ''}">
        <a href="#${module.id}" class="nav-link" data-module-id="${module.id}">
          <span class="nav-icon">${module.icon}</span>
          <span class="nav-label">${module.name}</span>
          <span class="nav-status">
            <span class="status-dot ${this.getModuleStatusClass(module.id)}"></span>
            <span>${statusIcons[module.status] || ''}</span>
          </span>
        </a>
      </li>
    `).join('');

    this.shadowRoot!.querySelector('a[data-module-id="accueil"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.setActiveModuleAndShow('accueil');
    });

    // Ajouter les écouteurs de clic
    displayModules.forEach(module => {
      const link = this.shadowRoot!.querySelector(`a[data-module-id="${module.id}"]`);
      link?.addEventListener('click', (e) => {
        // Un module déclarant une entrée de menu vers un vrai fichier servi par le serveur
        // (/applications/:appId/...) navigue réellement vers cette page dédiée, au lieu d'être
        // embarqué dans ModuleContainer — même règle que renderAppParamsSubmenu() ci-dessous, qui
        // ne s'applique qu'au sous-menu "Paramètres Techniques", pas à cette liste principale.
        // Sans ce garde-fou, un module comme HAPLAN (audience "end-user", page dédiée
        // dashboard.html hors de la convention presentation/index.html) tombait toujours dans le
        // chemin générique de ModuleContainer, qui la cherchait au mauvais endroit (404 silencieux
        // → "Aucun contenu à afficher pour ce module").
        const entryPath = this.getAppMenuConfig(module.id)?.entry?.path;
        if (entryPath && entryPath.startsWith('/applications/')) {
          console.log(`[Sidebar] Navigation vers la page dédiée: ${module.id} (${entryPath})`);
          window.location.href = entryPath;
          return;
        }
        e.preventDefault();
        console.log(`[Sidebar] Clic sur module: ${module.id} (${module.name})`);
        this.setActiveModuleAndShow(module.id);
      });
    });
  }
  
  private renderAppParamsSubmenu(): void {
    const container = this.shadowRoot!.getElementById('app-params-submenu');
    if (!container) return;
    
    // Filtrer les modules qui ont une configuration de menu ou configUi (pas core, qui est déjà géré)
    const paramModules = this.modules.filter(m => m.id !== 'core' && (m.configUi || m.menu));
    
    console.log('[Sidebar] renderAppParamsSubmenu - Modules avec menu/configUi:', paramModules.map(m => `${m.id}(${m.name})`));
    
    // Grouper les modules par catégorie et section de menu
    const modulesByCategory: Record<string, Record<string, Module[]>> = {};
    
    paramModules.forEach(module => {
      const menuConfig = this.getAppMenuConfig(module.id);
      const category = menuConfig?.category || 'Autres';
      const section = menuConfig?.section || module.name || module.id;
      
      if (!modulesByCategory[category]) {
        modulesByCategory[category] = {};
      }
      if (!modulesByCategory[category][section]) {
        modulesByCategory[category][section] = [];
      }
      modulesByCategory[category][section].push(module);
    });
    
    if (Object.keys(modulesByCategory).length === 0) {
      console.log('[Sidebar] renderAppParamsSubmenu - Aucun module avec menu/configUi trouvé');
      container.innerHTML = '';
      return;
    }
    
    // Générer le HTML pour chaque catégorie et section
    let html = '';
    
    Object.entries(modulesByCategory).forEach(([_category, sections]) => {
      // Créer une section pour chaque catégorie
      Object.entries(sections).forEach(([_section, modules]) => {
        if (modules.length > 0) {
          // Pour NOMMAGE : générer les sous-pages à partir de menu.pages
          const firstModule = modules[0];
          const menuConfig = this.getAppMenuConfig(firstModule.id);
          
          if (menuConfig && menuConfig.pages && menuConfig.pages.length > 0) {
            // Générer un menu hiérarchique avec les pages du menu
            const entry = menuConfig.entry;
            html += `
              <li class="nav-item app-param-item">
                <a href="${entry.path}" class="nav-link" data-section="${firstModule.id}">
                  <span class="nav-icon">${entry.icon || firstModule.icon}</span>
                  <span class="nav-label">${entry.label || firstModule.name}</span>
                  ${entry.badge ? `<span class="app-badge">${entry.badge}</span>` : ''}
                  <span class="nav-status">
                    <span class="status-dot ${this.getModuleStatusClass(firstModule.id)}"></span>
                    <span>${this.getStatusIcon(firstModule.status)}</span>
                  </span>
                </a>
              </li>
            `;
            
            // Ajouter les sous-pages
            menuConfig.pages.forEach(page => {
              if (page.id !== 'dashboard' && page.path && page.path !== entry.path) {
                html += `
                  <li class="nav-item app-param-item" style="padding-left: 15px;">
                    <a href="${page.path}" class="nav-link" data-section="${firstModule.id}-${page.id}">
                      <span class="nav-icon">${page.icon || ''}</span>
                      <span class="nav-label">${page.label}</span>
                      ${page.badge ? `<span class="app-badge">${page.badge}</span>` : ''}
                    </a>
                  </li>
                `;
              }
            });
          } else {
            // Ancienne méthode : un lien par module. Utilise entry.path comme href quand il
            // existe (pas seulement "#{moduleId}") — sans ça, le sélecteur qui attache l'écouteur
            // de clic plus bas (`entry ? a[href="${entry.path}"] : ...`) ne trouve jamais le lien
            // réellement rendu, et le clic ne fait rien (bug réel constaté sur ESPDISPLAY/HAPLAN,
            // qui n'ont pas de `pages` donc tombent dans cette branche : 15/08/2026).
            modules.forEach(module => {
              const moduleMenuConfig = this.getAppMenuConfig(module.id);
              const href = moduleMenuConfig?.entry?.path || `#${module.id}`;
              html += `
                <li class="nav-item app-param-item">
                  <a href="${href}" class="nav-link" data-section="${module.id}">
                    <span class="nav-icon">${module.icon}</span>
                    <span class="nav-label">${module.name}</span>
                    <span class="nav-status">
                      <span class="status-dot ${this.getModuleStatusClass(module.id)}"></span>
                      <span>${this.getStatusIcon(module.status)}</span>
                    </span>
                  </a>
                </li>
              `;
            });
          }
        }
      });
    });
    
    container.innerHTML = html;
    
    // Ajouter les écouteurs de clic sur les sous-menus Paramètres Techniques
    paramModules.forEach(module => {
      const menuConfig = this.getAppMenuConfig(module.id);
      const entry = menuConfig?.entry;
      const mainSelector = entry ? `a[href="${entry.path}"]` : `a[data-section="${module.id}"]`;
      
      const link = this.shadowRoot!.querySelector(mainSelector);
      link?.addEventListener('click', (e) => {
        // Une entrée pointant vers un vrai fichier servi par le serveur (/applications/:appId/...)
        // navigue réellement vers cette page dédiée. Les autres (routes internes à la SPA, ex:
        // sections statiques #ha/#mqtt) restent gérées par showModuleConfig().
        if (entry?.path && entry.path.startsWith('/applications/')) {
          console.log(`[Sidebar] Navigation vers la page dédiée: ${module.id} (${entry.path})`);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        console.log(`[Sidebar] Clic sur sous-menu Paramètres Techniques: ${module.id} (${module.name})`);
        this.showModuleConfig(module.id);
      });

      // Ajouter les écouteurs pour les sous-pages
      if (menuConfig?.pages) {
        menuConfig.pages.forEach(page => {
          if (page.id !== 'dashboard' && page.path && page.path !== entry?.path) {
            const pageLink = this.shadowRoot!.querySelector(`a[href="${page.path}"]`);
            pageLink?.addEventListener('click', (e) => {
              if (page.path.startsWith('/applications/')) {
                console.log(`[Sidebar] Navigation vers la page dédiée: ${page.id} (${page.path})`);
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              console.log(`[Sidebar] Clic sur page de menu: ${page.id} (${page.label})`);
              // Pour l'instant, on active juste le module
              this.showModuleConfig(module.id);
            });
          }
        });
      }
    });
  }
  

  
  private setActiveModule(id: string): void {
    this.activeModule = id;
    
    window.dispatchEvent(new CustomEvent('module:activated', {
      detail: { moduleId: id }
    }));
    
    this.render();
  }
  
  /**
   * Active un module et affiche son contenu
   */
  private setActiveModuleAndShow(id: string): void {
    this.setActiveModule(id);
    
    // Afficher le conteneur des modules
    const modulesContainer = document.getElementById('modules-container');
    if (modulesContainer) {
      modulesContainer.style.display = 'block';
      console.log(`[Sidebar] modules-container affiché via setActiveModuleAndShow(${id})`);
    }
  }
  
  /**
   * Enregistrer un menu personnalisé pour une application
   */
  private registerCustomMenu(appId: string, menuConfig: ApplicationMenuConfig): void {
    this.customMenus[appId] = menuConfig;
    console.log(`[Sidebar] Menu personnalisé enregistré pour ${appId}:`, menuConfig);
  }
  
  /**
   * Obtenir la configuration de menu pour une application
   */
  private getAppMenuConfig(appId: string): ApplicationMenuConfig | undefined {
    // D'abord vérifier dans les menus personnalisés enregistrés
    if (this.customMenus[appId]) {
      return this.customMenus[appId];
    }
    
    // Sinon, vérifier dans les modules chargés
    const module = this.modules.find(m => m.id === appId);
    if (module?.menu) {
      return module.menu;
    }
    
    return undefined;
  }
  
  private getModuleStatusClass(moduleId: string): string {
    const module = this.modules.find(m => m.id === moduleId);
    if (!module) return '';
    
    const statusClasses: Record<string, string> = {
      configured: 'status-configured',
      partial: 'status-partial',
      missing: 'status-missing',
      error: 'status-error'
    };
    
    return statusClasses[module.status] || '';
  }

  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      configured: '✓',
      partial: '⚠',
      missing: '✗',
      error: '✘'
    };
    return icons[status] || '';
  }
  
  private updateUptime(): void {
    const uptimeEl = this.shadowRoot!.getElementById('uptime');
    if (!uptimeEl) return;
    
    if (this.uptime) {
      const sec = Math.floor((Date.now() - this.uptime) / 1000);
      if (sec < 60) {
        uptimeEl.textContent = `${sec}s`;
      } else {
        const min = Math.floor(sec / 60);
        const remainingSec = sec % 60;
        if (min < 60) {
          uptimeEl.textContent = `${min}m ${remainingSec}s`;
        } else {
          const h = Math.floor(min / 60);
          const remainingMin = min % 60;
          uptimeEl.textContent = `${h}h ${remainingMin}m`;
        }
      }
    } else {
      uptimeEl.textContent = '0s';
    }
  }

  /** Version + hôte (⭐ 24/08/2026) — nom de machine si connu, sinon adresse IP ; les deux si les
   *  deux sont disponibles. Rien affiché tant qu'aucune des deux sources (app:started,
   *  app:machine-id) n'a répondu. */
  private updateHostInfo(): void {
    const el = this.shadowRoot!.getElementById('host-info');
    if (!el) return;

    const parts: string[] = [];
    if (this.appVersion) parts.push(this.appVersion);
    if (this.machineId && this.hostAddress) parts.push(`${this.machineId} (${this.hostAddress})`);
    else if (this.machineId) parts.push(this.machineId);
    else if (this.hostAddress) parts.push(this.hostAddress);

    el.textContent = parts.join(' · ');
  }

  private scrollToSection(sectionId: string): void {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }
}

// Enregistrer le composant
customElements.define('app-sidebar', Sidebar);
