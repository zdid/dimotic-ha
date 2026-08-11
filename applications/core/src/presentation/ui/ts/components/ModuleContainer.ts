/**
 * Composant ModuleContainer - Conteneur pour les modules dynamiques
 * Charge et affiche le contenu des modules
 */

// Template HTML pour le Shadow DOM
const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .module-container {
        padding: 20px;
        min-height: 200px;
      }
      
      .module-content {
        background: #2c3e50;
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        color: #ecf0f1;
      }
      
      .loading-hint {
        text-align: center;
        padding: 40px;
        color: #bdc3c7;
      }
      
      .error-hint {
        text-align: center;
        padding: 40px;
        color: #e74c3c;
        background: #34282c;
        border-radius: 8px;
      }
    </style>
    
    <div class="module-container" id="module-container">
      <div class="loading-hint">Chargement du module...</div>
    </div>
  `;
  return template;
};

export class ModuleContainer extends HTMLElement {
  private activeModule: string | null = null;
  private moduleContents: Record<string, string> = {};
  private moduleInited: Record<string, boolean> = {};
  // Chargement en cours par moduleId — verrou empêchant deux appels concurrents à
  // loadModuleContent() de déclencher chacun leur propre fetch()/innerHTML/executeScripts()
  // pour le même module (voir loadModuleContent ci-dessous pour le pourquoi).
  private moduleLoading: Partial<Record<string, Promise<void>>> = {};
  // Module dont le contenu est actuellement affiché dans #module-container — distinct de
  // activeModule (mis à jour AVANT l'appel à loadModuleContent, donc inutilisable pour détecter
  // un re-clic sur le module déjà affiché) et de moduleInited (juste "a déjà été chargé au moins
  // une fois", vrai même après un changement d'onglet). Voir loadModuleContent ci-dessous.
  private displayedModule: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    const template = createTemplate();
    this.shadowRoot!.appendChild(template.content.cloneNode(true));
  }
  
  connectedCallback() {
    this.setupEventListeners();
    // Le contenu de chaque application métier est injecté dans ce Shadow DOM — le `document`
    // global d'un script d'app ne le traverse jamais (document.getElementById(...) y renverrait
    // toujours null, cf. TODO.md "scripts injectés inertes"). On expose ce shadow root pour que
    // ces scripts puissent s'y scoper explicitement (voir arbreouquoi/app.ts pour le pattern
    // d'usage : `(window as any).__moduleContainerRoot`).
    (window as any).__moduleContainerRoot = this.shadowRoot;
  }
  
  private setupEventListeners(): void {
    console.log('[ModuleContainer] setupEventListeners - Initialisation des écouteurs d\'événements');
    
    // Écouter les changements de module actif
    window.addEventListener('module:activated', (e: CustomEvent) => {
      console.log('[ModuleContainer] Événement module:activated reçu:', e.detail);
      this.activeModule = e.detail.moduleId || null;
      console.log('[ModuleContainer] Module actif défini à:', this.activeModule);
      if (this.activeModule) {
        console.log('[ModuleContainer] Chargement du contenu pour module:', this.activeModule);
        this.loadModuleContent(this.activeModule);
      }
    });
    
    // Écouter le chargement initial
    window.addEventListener('modules:loaded', (e: any) => {
      console.log('[ModuleContainer] Événement modules:loaded reçu:', e.detail);
      const modules = e.detail.modules;
      if (modules.length > 0 && !this.activeModule) {
        this.activeModule = modules[0].id;
        console.log('[ModuleContainer] Premier module défini à:', this.activeModule);
        if (this.activeModule) {
          console.log('[ModuleContainer] Chargement du contenu pour premier module:', this.activeModule);
          this.loadModuleContent(this.activeModule);
        }
      }
    });
  }
  
  /**
   * Charge le contenu d'un module
   */
  async loadModuleContent(moduleId: string): Promise<void> {
    console.log(`[ModuleContainer] loadModuleContent appelé pour module: ${moduleId}`);
    
    if (!moduleId) {
      console.log('[ModuleContainer] loadModuleContent - moduleId est vide, abandon');
      return;
    }
    
    // Ne pas charger de contenu pour le module core (géré par ConfigForm)
    // et ne pas recharger si déjà chargé et initialisé
    if (moduleId === 'core' || (this.moduleContents[moduleId] && this.moduleInited[moduleId])) {
      // Re-clic sur le module déjà affiché à l'écran : pur no-op. Sans ce garde-fou, on
      // remplaçait innerHTML par une copie fraîche du cache SANS jamais rappeler
      // executeScripts() (pour ne pas ré-exécuter customElements.define()) — le script déjà en
      // vie continuait de tourner, mais sur des nœuds DOM maintenant orphelins/remplacés :
      // l'écran affiché redevenait l'état par défaut ("Chargement...") et restait bloqué là pour
      // de bon, plus aucun script vivant n'étant attaché à ce qui est réellement visible. Un
      // second clic sur un onglet qui semble bloqué est un réflexe naturel — ce bug se
      // déclenchait donc facilement (cf TODO.md "ModuleContainer : re-clic casse le module déjà
      // affiché").
      if (this.displayedModule === moduleId) {
        console.log(`[ModuleContainer] Module ${moduleId} déjà affiché, rien à faire`);
        return;
      }
      console.log(`[ModuleContainer] Module ${moduleId} déjà chargé, affichage du contenu existant`);
      console.log(`[ModuleContainer] moduleContents[${moduleId}] existe:`, !!this.moduleContents[moduleId]);
      console.log(`[ModuleContainer] moduleContents[${moduleId}] length:`, this.moduleContents[moduleId]?.length || 0);
      const container = this.shadowRoot!.getElementById('module-container');
      console.log(`[ModuleContainer] Conteneur trouvé:`, !!container);
      if (container && this.moduleContents[moduleId]) {
        container.innerHTML = `<div class="module-content">${this.moduleContents[moduleId]}</div>`;
        this.displayedModule = moduleId;
        console.log(`[ModuleContainer] Contenu réaffiché pour ${moduleId}`);
        console.log(`[ModuleContainer] Conteneur innerHTML length:`, container.innerHTML.length);
        // Le scan Alpine (initial + MutationObserver) ne traverse jamais une frontière Shadow
        // DOM (alpinejs-implementation_specs_v1.0.md §3.4) — sans cet appel, le contenu
        // réaffiché resterait inerte (aucune directive Alpine évaluée).
        window.Alpine?.initTree(container);
        // ⭐ Pour les apps vanilla TS (pas Alpine) : le script n'est volontairement pas
        // ré-exécuté ici (voir commentaire ci-dessus, customElements.define()), donc aucun
        // écouteur n'est jamais rattaché aux nouveaux nœuds injectés par le innerHTML
        // ci-dessus — les anciens écouteurs, posés sur les nœuds de la visite précédente,
        // restent orphelins. Convention `window.{moduleId}App = { init, ... }` (déjà suivie par
        // toutes les apps) : on rappelle explicitement `init()` pour re-brancher les
        // écouteurs sur le DOM réellement affiché. `init()` doit être idempotent côté app —
        // ne jamais réabonner deux fois le même événement socket (déjà le cas partout,
        // `setupEventListeners()` gardé par un drapeau, voir chaque app.ts). Trouvé en
        // conditions réelles (demande utilisateur) : "tester une commande" (ia) et l'écran
        // planificateur restaient inertes après une deuxième visite depuis le menu.
        (window as unknown as Record<string, { init?: () => void }>)[`${moduleId}App`]?.init?.();
        // Notifier que le module est chargé (pour les eventuels listeners)
        window.dispatchEvent(new CustomEvent('module:content:loaded', {
          detail: { moduleId }
        }));
      } else {
        console.log(`[ModuleContainer] ERREUR: Conteneur ou contenu manquant pour ${moduleId}`);
        console.log(`[ModuleContainer] container:`, !!container);
        console.log(`[ModuleContainer] moduleContents[${moduleId}]:`, !!this.moduleContents[moduleId]);
      }
      return;
    }
    
    const container = this.shadowRoot!.getElementById('module-container');
    if (!container) {
      console.log('[ModuleContainer] Conteneur introuvable, abandon');
      return;
    }

    // Un chargement est déjà en cours pour ce module — plusieurs sources peuvent redéclencher
    // 'module:activated'/'modules:loaded' pour la même activation en quelques millisecondes
    // (Sidebar se réécoute elle-même, rejeu des événements persistants à chaque nouvelle
    // connexion socket d'une app, cf. TODO.md "ModuleContainer : loadModuleContent s'exécute
    // plusieurs fois"). Sans ce verrou, chaque appel concurrent lançait son propre
    // fetch()/innerHTML/executeScripts() — plusieurs instances du script de l'app coexistaient
    // brièvement, chacune avec son propre état et ses propres écouteurs, dont certains finissaient
    // attachés à des nœuds DOM déjà remplacés (donc morts). On attend le chargement déjà en vol
    // au lieu d'en démarrer un second.
    if (this.moduleLoading[moduleId]) {
      console.log(`[ModuleContainer] Chargement déjà en cours pour ${moduleId}, attente de celui-ci`);
      return this.moduleLoading[moduleId];
    }

    const loadPromise = this.fetchAndRenderModule(moduleId, container);
    this.moduleLoading[moduleId] = loadPromise;
    try {
      await loadPromise;
    } finally {
      delete this.moduleLoading[moduleId];
    }
  }

  private async fetchAndRenderModule(moduleId: string, container: HTMLElement): Promise<void> {
    try {
      console.log(`[ModuleContainer] Début du chargement du module: ${moduleId}`);

      // Afficher le chargement
      container.innerHTML = '<div class="loading-hint">Chargement du module...</div>';

      // Récupérer le contenu depuis le serveur
      console.log(`[ModuleContainer] Fetch URL: /applications/${moduleId}/presentation/index.html`);
      const response = await fetch(`/applications/${moduleId}/presentation/index.html`);

      console.log(`[ModuleContainer] Réponse reçue pour ${moduleId}: status=${response.status}, statusText=${response.statusText}`);

      if (response.ok) {
        const html = await response.text();
        this.moduleContents[moduleId] = html;
        console.log(`[ModuleContainer] Contenu HTML reçu pour ${moduleId}, longueur: ${html.length}`);

        container.innerHTML = `<div class="module-content">${html}</div>`;

        // innerHTML n'exécute jamais les <script> qu'il insère (comportement standard du DOM,
        // quel que soit le navigateur) — il faut les recréer explicitement pour qu'ils tournent.
        // Seulement ici, au premier chargement : ne pas rejouer au ré-affichage depuis le cache
        // (voir plus haut), sous peine de ré-exécuter des customElements.define() déjà appelés.
        this.executeScripts(container);

        // Même règle que dans la branche de réaffichage ci-dessus (§3.4) : le premier scan
        // d'Alpine ne traverse pas cette frontière Shadow DOM non plus.
        window.Alpine?.initTree(container);

        this.moduleInited[moduleId] = true;
        this.displayedModule = moduleId;
        console.log(`[ModuleContainer] Module ${moduleId} marqué comme initialisé`);

        // Notifier que le module est chargé
        window.dispatchEvent(new CustomEvent('module:content:loaded', {
          detail: { moduleId }
        }));
        console.log(`[ModuleContainer] Événement module:content:loaded émis pour ${moduleId}`);

      } else if (response.status === 404) {
        // Module sans présentation HTML (comme core), ne pas afficher d'erreur
        console.log(`[ModuleContainer] Module ${moduleId} - 404: Aucun contenu HTML trouvé`);
        container.innerHTML = '<div class="loading-hint">Aucun contenu à afficher pour ce module</div>';
        this.moduleInited[moduleId] = true;
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`[ModuleContainer] Erreur de chargement du module ${moduleId}:`, error);
      const container = this.shadowRoot!.getElementById('module-container');
      if (container) {
        container.innerHTML = `<div class="error-hint">Erreur de chargement: ${(error as Error).message}</div>`;
      }
    }
  }

  /**
   * Recrée chaque <script> trouvé dans le conteneur pour forcer son exécution — un <script>
   * inséré via innerHTML reste inerte, y compris pour type="module" (même règle du DOM).
   */
  private executeScripts(container: HTMLElement): void {
    container.querySelectorAll('script').forEach((oldScript) => {
      const newScript = document.createElement('script');
      for (const attr of Array.from(oldScript.attributes)) {
        newScript.setAttribute(attr.name, attr.value);
      }
      newScript.textContent = oldScript.textContent;
      oldScript.replaceWith(newScript);
    });
  }

  /**
   * Retourne le contenu d'un module (pour accès externe)
   */
  getModuleContent(moduleId: string): string | undefined {
    return this.moduleContents[moduleId];
  }
  
  /**
   * Vérifie si un module est chargé
   */
  isModuleLoaded(moduleId: string): boolean {
    return !!this.moduleContents[moduleId];
  }
  
  /**
   * Vérifie si un module est initialisé
   */
  isModuleInited(moduleId: string): boolean {
    return !!this.moduleInited[moduleId];
  }
}

// Enregistrer le composant
customElements.define('app-module-container', ModuleContainer);
