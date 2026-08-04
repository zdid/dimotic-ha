import { ConfigField } from '../types';

/**
 * Composant ConfigForm - Formulaire de configuration technique
 * Web Component pour afficher et éditer les paramètres
 */

interface ConfigSection {
  id: string;
  title: string;
  icon: string;
  description: string;
  fields: ConfigField[];
}

// Sections de configuration techniques
const configSections: ConfigSection[] = [
  {
    id: 'ha',
    title: 'Web-Services',
    icon: '⚙️',
    description: 'Configuration de la connexion à Home Assistant',
    fields: [
      { name: 'ha.ws_enable', label: 'Activer Web-Services', type: 'boolean' },
      { name: 'ha.ws.host', label: 'Hôte', type: 'text', required: true, placeholder: '192.168.1.x' },
      { name: 'ha.ws.port', label: 'Port', type: 'number', min: 1, max: 65535, placeholder: '8123' },
      { name: 'ha.ws.token', label: 'Long-Lived Access Token', type: 'text', required: true, hint: 'Token très long - saisir en clair' },
      { name: 'ha.ws.reconnect_delay', label: 'Délai de reconnexion (secondes)', type: 'number', min: 0, max: 60, hint: 'Backoff exponentiel, plafond à 60s' },
    ]
  },
  {
    id: 'mqtt',
    title: 'MQTT (Broker Externe)',
    icon: '📡',
    description: 'Configurer uniquement si cette application est de type "intégration"',
    fields: [
      { name: 'ha.mqtt_enable', label: 'Activer MQTT', type: 'boolean' },
      { name: 'ha.mqtt.host', label: 'Hôte', type: 'text', required: true, placeholder: '192.168.1.x' },
      { name: 'ha.mqtt.port', label: 'Port', type: 'number', min: 1, max: 65535, placeholder: '1883' },
      { name: 'ha.mqtt.client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'ha-app-unique-id', hint: 'Doit être unique par application' },
      { name: 'ha.mqtt.username', label: 'Identifiant (optionnel)', type: 'text', autocomplete: 'off' },
      { name: 'ha.mqtt.password', label: 'Mot de passe (optionnel)', type: 'password', autocomplete: 'off' },
      { name: 'ha.mqtt.keepalive', label: 'Keepalive (secondes)', type: 'number', min: 0, placeholder: '60' },
      { name: 'ha.mqtt.reconnect_delay', label: 'Délai de reconnexion (secondes)', type: 'number', min: 0, max: 60 },
    ]
  },
  {
    id: 'web',
    title: 'Serveur Web',
    icon: '🌐',
    description: 'Configuration du serveur HTTP',
    fields: [
      { name: 'web.port', label: 'Port', type: 'number', min: 1, max: 65535, placeholder: '8080' },
      { name: 'web.host', label: 'Hôte', type: 'text', placeholder: '0.0.0.0' },
    ]
  },
  {
    id: 'logging',
    title: 'Journalisation',
    icon: '📝',
    description: 'Configuration des logs',
    fields: [
      { name: 'logging.level', label: 'Niveau de log', type: 'select', options: [
        { value: 'debug', label: 'Debug' },
        { value: 'info', label: 'Info' },
        { value: 'warn', label: 'Warning' },
        { value: 'error', label: 'Error' }
      ] },
      { name: 'logging.rotate.max_size_mb', label: 'Taille max par fichier (Mo)', type: 'number', min: 1, placeholder: '10' },
      { name: 'logging.rotate.max_files', label: 'Nombre max de fichiers', type: 'number', min: 1, max: 100, placeholder: '5' },
    ]
  }
];

// Template HTML pour le Shadow DOM
const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .config-form {
        padding: 20px;
      }
      
      .config-section {
        margin-bottom: 30px;
        padding: 20px;
        background: #2c3e50;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        color: #ecf0f1;
      }
      
      .config-section h3 {
        margin: 0 0 15px 0;
        color: #ecf0f1;
        font-size: 1.2rem;
      }
      
      .section-description {
        margin: 0 0 20px 0;
        color: #7f8c8d;
        font-size: 0.9rem;
      }
      
      .config-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 20px;
        max-width: 1200px;
      }
      
      .form-group {
        margin-bottom: 15px;
      }
      
      .form-group label {
        display: flex;
        align-items: center;
        margin-bottom: 5px;
        font-size: 0.9rem;
        color: #ecf0f1;
      }
      
      .required-badge {
        background-color: #e74c3c;
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.75rem;
        margin-left: 8px;
      }
      
      .form-group input[type="text"],
      .form-group input[type="number"],
      .form-group input[type="password"],
      .form-group select,
      .form-group textarea {
        width: calc(100% - 15px);
        padding: 8px 12px;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 0.9rem;
        transition: border-color 0.2s;
        word-break: break-all;
      }
      
      /* Limiter la largeur pour les formulaires de modules uniquement */
      .module-config-form .form-group input[type="text"],
      .module-config-form .form-group input[type="number"],
      .module-config-form .form-group input[type="password"],
      .module-config-form .form-group select,
      .module-config-form .form-group textarea {
        max-width: 500px;
      }
        white-space: normal;
        background: #34495e;
        color: #ecf0f1;
      }
      
      .form-group input:focus,
      .form-group select:focus {
        outline: none;
        border-color: #3498db;
      }

      .form-group select {
        background: #34495e;
        color: #ecf0f1;
      }

      .form-group input::placeholder {
        color: #95a5a6;
      }

      .form-group select option {
        background: #2c3e50;
        color: #ecf0f1;
      }
      
      .form-group input[type="checkbox"] {
        width: auto;
        margin-right: 10px;
      }
      
      .field-hint {
        font-size: 0.8rem;
        color: #bdc3c7;
        margin-top: 5px;
      }
      
      .field-feedback {
        font-size: 0.8rem;
        color: #e74c3c;
        margin-top: 5px;
      }
      
      .field-invalid {
        border-color: #e74c3c !important;
      }
      
      .section-actions {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #eee;
      }
      
      .btn {
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        font-size: 0.9rem;
        cursor: pointer;
        transition: background-color 0.2s;
      }
      
      .btn-primary {
        background-color: #3498db;
        color: white;
      }
      
      .btn-primary:hover {
        background-color: #2980b9;
      }
      
      .btn-primary:disabled {
        background-color: #bdc3c7;
        cursor: not-allowed;
      }

      .btn-secondary {
        background-color: #e67e22;
        color: white;
      }

      .btn-secondary:hover {
        background-color: #d35400;
      }

      .btn-secondary:disabled {
        background-color: #bdc3c7;
        cursor: not-allowed;
      }

      .section-actions-danger {
        border-top-style: dashed;
      }

      .save-feedback {
        display: inline-block;
        margin-left: 12px;
        font-size: 0.9rem;
        color: #2ecc71;
      }

      .save-feedback.save-feedback-error {
        color: #e74c3c;
      }
    </style>
    
    <div class="config-form" id="config-form">
      <!-- Les sections seront insérées ici dynamiquement -->
    </div>
  `;
  return template;
};

export class ConfigForm extends HTMLElement {
  private config: any = {};
  private validationErrors: Record<string, string> = {};
  private moduleId: string | null = null;
  private moduleConfigFormHtml: string = '';
  // Résultat de la dernière sauvegarde (sections statiques) — état de CE composant, pas de
  // l'Alpine x-data local du bouton : une sauvegarde globale déclenche presque toujours un
  // config:current juste après (AppService.handleConfigSave), qui refait un render() ici (voir
  // setupEventListeners ci-dessous) — un Alpine x-data local serait recréé à neuf par ce
  // render() et perdrait le résultat avant même d'avoir pu s'afficher (constaté en direct : la
  // confirmation n'apparaissait jamais). En le portant ici, buildSaveButton() le réinjecte tel
  // quel à chaque render(), quelle qu'en soit la cause.
  private saveResult: { success: boolean; message: string } | null = null;
  private saveResultTimeout: number | undefined;
  // Même raisonnement que saveResult ci-dessus (état du composant, pas un x-data Alpine local)
  // pour survivre à un éventuel render() déclenché entre la demande et la réponse serveur.
  private restartResult: { success: boolean; message: string } | null = null;
  private restartResultTimeout: number | undefined;
  // Chemins de champ modifiés localement depuis la dernière sauvegarde réussie (sections
  // statiques uniquement — les modules ne re-render jamais sur config:updated, voir plus bas).
  // Sans ce suivi, un config:current reçu pendant que l'utilisateur édite un champ pas encore
  // sauvegardé (sauvegarde par un autre onglet/utilisateur, ou tout autre déclencheur du même
  // événement) écrase silencieusement sa saisie en cours (TODO.md "Édition non sauvegardée
  // écrasée par config:current").
  private dirtyFields: Set<string> = new Set();
  // config:save:result est un broadcast global (tous les clients connectés, pas seulement celui
  // à l'origine de la sauvegarde — vérifié en direct : la sauvegarde depuis un 2e onglet
  // déclenchait bien config-save-result ici aussi) — sans ce indicateur, un succès de sauvegarde
  // déclenché par un AUTRE onglet/utilisateur viderait dirtyFields ici et l'édition locale en
  // cours ne serait alors plus protégée par la fusion de config:updated qui suit presque
  // toujours. Positionné juste avant d'appeler saveConfig() (voir setupFormListeners).
  private pendingLocalSave: boolean = false;
  
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    const template = createTemplate();
    this.shadowRoot!.appendChild(template.content.cloneNode(true));
  }
  
  connectedCallback() {
    this.setupEventListeners();
    this.render();
  }
  
  static get observedAttributes() {
    return ['data-section'];
  }
  
  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (name === 'data-section' && oldValue !== newValue) {
      console.log(`[ConfigForm] data-section changé de ${oldValue} à ${newValue}`);
      // Si on change de section statique, réinitialiser le mode module
      const staticSections = ['ha', 'mqtt', 'web', 'logging', 'applications-manager'];
      if (staticSections.includes(newValue)) {
        console.log('[ConfigForm] Réinitialisation du mode module (section statique détectée)');
        this.moduleId = null;
        this.moduleConfigFormHtml = '';
        this.render();
      }
    }
  }
  
  private setupEventListeners(): void {
    // Écouter les mises à jour de configuration (sections statiques ha/mqtt/web/logging
    // uniquement). En mode module, ne pas re-render : buildFormSections() réinjecterait
    // moduleConfigFormHtml — figé au moment de l'ouverture de l'onglet — et écraserait
    // l'édition en cours ou tout juste sauvegardée. Le module a son propre canal de
    // rafraîchissement (module:config:loaded, voir plus bas).
    window.addEventListener('config:updated', (e: CustomEvent) => {
      const incoming = { ...e.detail.config };
      // Préserver les champs en cours d'édition (non sauvegardés) : sans ça, un config:current
      // qui arrive pendant la frappe (sauvegarde par un autre onglet/utilisateur, entre autres
      // déclencheurs possibles) écraserait silencieusement la saisie en cours.
      for (const fieldPath of this.dirtyFields) {
        const localValue = this.getFieldValue(fieldPath);
        if (localValue !== undefined) {
          this.setNestedValue(incoming, fieldPath, localValue);
        }
      }
      this.config = incoming;
      if (!this.moduleId) {
        this.render();
      }
    });

    // Résultat réel d'une sauvegarde de section statique (relayé par TechnicalConfigManager,
    // voir TODO.md "Aucune confirmation visible..."). Ce même événement socket est aussi émis
    // par le serveur pour une sauvegarde de MODULE (AppService.handleModuleConfigSave) — sans
    // condition ici, cette bannière apparaîtrait alors à tort en mode module ; ce chemin a de
    // toute façon son propre bouton/état (voir ModuleManager.generateModuleConfigForm), donc on
    // ignore l'événement tant qu'on est en mode module.
    window.addEventListener('config-save-result', (e: CustomEvent) => {
      if (this.moduleId) return;
      this.saveResult = e.detail;
      // Un succès signifie que this.config (déjà envoyé tel quel au serveur) est maintenant la
      // vérité serveur — les champs modifiés localement ne sont plus "en avance" sur elle. Un
      // échec (validation, écriture disque) laisse les champs dirty : l'utilisateur doit encore
      // les corriger/renvoyer, un config:current entre-temps ne doit toujours pas les écraser.
      // pendingLocalSave distingue NOTRE sauvegarde de celle d'un autre onglet/utilisateur (même
      // événement broadcast à tous) — sans cette garde, un succès distant viderait dirtyFields
      // ici et laisserait la prochaine fusion config:updated écraser l'édition locale en cours.
      if (e.detail.success && this.pendingLocalSave) {
        this.dirtyFields.clear();
      }
      this.pendingLocalSave = false;
      this.render();
      if (this.saveResultTimeout !== undefined) window.clearTimeout(this.saveResultTimeout);
      this.saveResultTimeout = window.setTimeout(() => {
        this.saveResult = null;
        this.render();
      }, 4000);
    });

    // Résultat de la demande de redémarrage manuel (bouton section Journalisation) — le process
    // serveur va s'arrêter juste après (voir RestartManager), donc ce message n'a le temps de
    // s'afficher que brièvement avant la déconnexion Socket.io ; on l'affiche quand même pour
    // confirmer que la demande a bien été reçue avant la coupure.
    window.addEventListener('app-restart-result', ((e: CustomEvent) => {
      this.restartResult = e.detail.success
        ? { success: true, message: 'Redémarrage en cours...' }
        : { success: false, message: e.detail.error || 'Échec de la demande de redémarrage' };
      this.render();
      if (this.restartResultTimeout !== undefined) window.clearTimeout(this.restartResultTimeout);
      this.restartResultTimeout = window.setTimeout(() => {
        this.restartResult = null;
        this.render();
      }, 4000);
    }) as EventListener);

    // Écouter les validations
    window.addEventListener('config:validation:updated', (e: CustomEvent) => {
      this.validationErrors = {};
      e.detail.errors?.forEach((error: any) => {
        this.validationErrors[error.path] = error.message;
      });
      this.render();
    });
    
    // Écouter l'affichage de la config d'un module
    window.addEventListener('module:config:show', ((e: Event) => {
      const customEvent = e as CustomEvent;
      console.log('[ConfigForm] Événement module:config:show reçu:', customEvent.detail);
      this.moduleId = customEvent.detail?.moduleId || null;
      this.loadModuleConfigForm();
    }) as EventListener);

    // Régénérer le formulaire quand la vraie config du module arrive (premier chargement
    // asynchrone, ou rafraîchissement après une sauvegarde) — sans ça, le formulaire reste
    // figé sur les valeurs par défaut affichées lors du premier rendu synchrone.
    window.addEventListener('module:config:loaded', ((e: Event) => {
      const customEvent = e as CustomEvent;
      const moduleId = customEvent.detail?.moduleId;
      if (moduleId && moduleId === this.moduleId && window.app?.moduleManager) {
        console.log('[ConfigForm] Configuration réelle reçue pour module', moduleId, '- régénération du formulaire');
        this.moduleConfigFormHtml = window.app.moduleManager.generateModuleConfigForm(moduleId);
        this.render();
      }
    }) as EventListener);
    
    // Écouter les changements de section pour réinitialiser le mode module
    window.addEventListener('scroll-to-section', ((e: Event) => {
      const customEvent = e as CustomEvent;
      const sectionId = customEvent.detail?.sectionId;
      console.log('[ConfigForm] Changement de section détecté:', sectionId);
      // Si on change de section et qu'on était en mode module, réinitialiser
      if (this.moduleId && sectionId && !sectionId.startsWith('module-')) {
        console.log('[ConfigForm] Réinitialisation du mode module');
        this.moduleId = null;
        this.moduleConfigFormHtml = '';
        this.render();
      }
    }) as EventListener);
  }
  
  private async loadModuleConfigForm(): Promise<void> {
    if (!this.moduleId || !window.app?.moduleManager) {
      console.log('[ConfigForm] moduleManager non disponible');
      return;
    }
    
    try {
      const metadata = window.app.moduleManager.getModuleUiMetadata(this.moduleId);
      console.log('[ConfigForm] Métadonnées UI pour module', this.moduleId, ':', metadata);
      
      if (metadata) {
        // Générer le formulaire HTML via ModuleManager
        this.moduleConfigFormHtml = window.app.moduleManager.generateModuleConfigForm(this.moduleId);
        console.log('[ConfigForm] Formulaire généré pour module', this.moduleId);
        this.render();
      } else {
        console.log('[ConfigForm] Aucune métadonnées UI trouvées pour module', this.moduleId);
        this.moduleConfigFormHtml = `<div class="error-hint">Pas de configuration UI disponible pour ${this.moduleId}</div>`;
        this.render();
      }
    } catch (error) {
      console.error('[ConfigForm] Erreur de chargement de la config du module:', error);
      this.moduleConfigFormHtml = `<div class="error-hint">Erreur de chargement: ${error}</div>`;
      this.render();
    }
  }
  
  private render(): void {
    const container = this.shadowRoot!.getElementById('config-form');
    if (!container) return;

    container.innerHTML = this.buildFormSections();
    this.setupFormListeners();
    // render() est rappelé bien après le montage initial (config:updated, changement de section,
    // module:config:show/loaded...) — chaque appel remplace le contenu du Shadow DOM, ce qui exige
    // un nouveau scan Alpine à chaque fois (alpinejs-implementation_specs_v1.0.md §3.4), pas
    // seulement au premier rendu.
    window.Alpine?.initTree(container);
  }
  
  private get activeSection(): string {
    return this.getAttribute('data-section') || 'ha';
  }
  
  private buildFormSections(): string {
    // Si on affiche la config d'un module, retourner le formulaire généré
    if (this.moduleId && this.moduleConfigFormHtml) {
      console.log('[ConfigForm] buildFormSections - Affichage du formulaire pour module:', this.moduleId);
      
      return `
        <div class="config-section" id="config-section-module-${this.moduleId}">
          ${this.moduleConfigFormHtml}
        </div>
      `;
    }
    
    // Sinon, afficher la section statique normale
    const activeSectionId = this.activeSection;
    const section = configSections.find(s => s.id === activeSectionId);
    
    if (!section) {
      // Si section non trouvée, afficher la première (ha)
      return this.buildSection(configSections[0]);
    }
    
    return this.buildSection(section);
  }
  
  private buildSection(section: ConfigSection): string {
    return `
      <div class="config-section" id="config-section-${section.id}">
        <h3>${section.icon} ${section.title}</h3>
        <p class="section-description">${section.description}</p>
        <div class="config-grid">
          ${section.fields.map(field => this.buildFieldHtml(field)).join('')}
        </div>
      </div>
      ${this.buildSaveButton()}
      ${section.id === 'logging' ? this.buildRestartButton() : ''}
    `;
  }
  
  private buildFieldHtml(field: ConfigField): string {
    const value = this.getFieldValue(`${field.name}`);
    const fieldId = `field-${field.name.replace('.', '-')}`;
    const isInvalid = this.validationErrors[field.name];
    const statusClass = isInvalid ? 'field-invalid' : '';
    
    let html = `
      <div class="form-group" id="${fieldId}">
        <label for="${fieldId}">
          ${field.label}
          ${field.required ? '<span class="required-badge">Requis</span>' : ''}
        </label>
    `;
    
    // Générer l'input en fonction du type
    switch (field.type) {
      case 'text':
        html += `
          <input 
            type="text" 
            id="${fieldId}"
            value="${this.escapeHtml(value || '')}"
            data-field="${field.name}"
            class="${statusClass}"
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
          ${isInvalid ? `<div class="field-feedback">${this.escapeHtml(this.validationErrors[field.name])}</div>` : ''}
        `;
        break;
        
      case 'number':
        html += `
          <input 
            type="number" 
            id="${fieldId}"
            value="${value || ''}"
            data-field="${field.name}"
            class="${statusClass}"
            ${field.min !== undefined ? `min="${field.min}"` : ''}
            ${field.max !== undefined ? `max="${field.max}"` : ''}
            ${field.step !== undefined ? `step="${field.step}"` : ''}
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
          ${isInvalid ? `<div class="field-feedback">${this.escapeHtml(this.validationErrors[field.name])}</div>` : ''}
        `;
        break;
        
      case 'boolean':
        html += `
          <input 
            type="checkbox" 
            id="${fieldId}"
            ${value ? 'checked' : ''}
            data-field="${field.name}"
            data-type="boolean"
          />
          ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
        `;
        break;
        
      case 'select':
        html += `
          <select 
            id="${fieldId}"
            data-field="${field.name}"
            class="${statusClass}"
          >
            ${field.options?.map(opt => {
              const optValue = typeof opt === 'string' ? opt : opt.value;
              const optLabel = typeof opt === 'string' ? opt : opt.label;
              return `<option value="${optValue}" ${value === optValue ? 'selected' : ''}>${optLabel}</option>`;
            }).join('') || ''}
          </select>
          ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
          ${isInvalid ? `<div class="field-feedback">${this.escapeHtml(this.validationErrors[field.name])}</div>` : ''}
        `;
        break;
        
      case 'password':
        html += `
          <input 
            type="password" 
            id="${fieldId}"
            value="${this.escapeHtml(value || '')}"
            data-field="${field.name}"
            class="${statusClass}"
            autocomplete="off"
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
          ${isInvalid ? `<div class="field-feedback">${this.escapeHtml(this.validationErrors[field.name])}</div>` : ''}
        `;
        break;
    }
    
    html += '</div>';
    return html;
  }
  
  private buildSaveButton(): string {
    // Le résultat réel (this.saveResult) est un état du composant, pas de l'Alpine x-data local
    // du bouton — voir le commentaire sur le champ pour le pourquoi (render() déclenché par
    // config:current juste après une sauvegarde recréerait un x-data local vierge). "saving" en
    // revanche peut rester local à Alpine : purement une réaction immédiate au clic, sans besoin
    // de survivre à un re-render déclenché ailleurs.
    const feedbackHtml = this.saveResult
      ? `<span class="save-feedback${this.saveResult.success ? '' : ' save-feedback-error'}">${this.escapeHtml(this.saveResult.message)}</span>`
      : '';
    return `
      <div class="section-actions" x-data="{ saving: false }">
        <button
          type="button"
          id="static-save-button"
          class="btn btn-primary"
          :disabled="saving"
          @click="saving = true; window.app.configManager.saveConfig()"
        >
          <span x-text="saving ? 'Sauvegarde en cours...' : 'Sauvegarder'"></span>
        </button>
        ${feedbackHtml}
      </div>
    `;
  }

  private buildRestartButton(): string {
    const feedbackHtml = this.restartResult
      ? `<span class="save-feedback${this.restartResult.success ? '' : ' save-feedback-error'}">${this.escapeHtml(this.restartResult.message)}</span>`
      : '';
    return `
      <div class="section-actions section-actions-danger" x-data="{ restarting: false }">
        <button
          type="button"
          id="restart-application-button"
          class="btn btn-secondary"
          :disabled="restarting"
          @click="restarting = true; window.app.configManager.restartApplication(); setTimeout(() => restarting = false, 4000)"
        >
          <span x-text="restarting ? 'Redémarrage en cours...' : '🔄 Redémarrer l\\'application'"></span>
        </button>
        ${feedbackHtml}
      </div>
    `;
  }

  private setupFormListeners(): void {
    // Le bouton de sauvegarde (état saving/disabled) est géré déclarativement par Alpine
    // (x-data/@click dans buildSaveButton()) — pas besoin d'écouteur pour ça. En revanche,
    // pendingLocalSave (voir le champ) doit être positionné en JS, avant l'appel réel à
    // saveConfig(), pour que config-save-result sache distinguer NOTRE sauvegarde de celle d'un
    // autre onglet/utilisateur (même événement broadcast à tous les clients connectés).
    this.shadowRoot!.getElementById('static-save-button')?.addEventListener('click', () => {
      this.pendingLocalSave = true;
    });

    // Écouter les changements sur tous les inputs
    this.shadowRoot!.querySelectorAll('input, select').forEach(input => {
      const field = input.getAttribute('data-field');
      const module = input.getAttribute('data-module');

      if (!field) return;

      if (module) {
        // Champ d'un module : écrire directement dans ModuleManager.moduleConfigs,
        // jamais touché par config:current — évite que l'édition en cours soit
        // écrasée par une resynchronisation serveur avant que l'utilisateur sauvegarde.
        const moduleManager = window.app?.moduleManager;
        if (!moduleManager) return;

        if (input.tagName === 'SELECT') {
          input.addEventListener('change', (e) => moduleManager.setSelectField(e, module, field));
        } else if ((input as HTMLInputElement).type === 'checkbox') {
          input.addEventListener('change', (e) => moduleManager.setModuleField(e, module, field));
        } else {
          input.addEventListener('input', (e) => moduleManager.setModuleField(e, module, field));
          input.addEventListener('change', (e) => moduleManager.setModuleField(e, module, field));
        }
      } else {
        input.addEventListener('input', (e) => {
          this.handleFieldChange(e, field);
        });

        input.addEventListener('change', (e) => {
          this.handleFieldChange(e, field);
        });
      }
    });
  }
  
  private handleFieldChange(event: Event, field: string): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    let value: any;
    
    if (target.type === 'checkbox') {
      value = (target as HTMLInputElement).checked;
    } else if (target.type === 'number') {
      value = parseFloat(target.value || '0') || 0;
    } else {
      value = target.value || '';
    }
    
    this.dirtyFields.add(field);
    this.updateField(field, value);
  }

  /** Écrit une valeur dans un objet imbriqué à partir d'un chemin pointé (ex: "ha.ws.host"). */
  private setNestedValue(target: any, fieldPath: string, value: any): void {
    const parts = fieldPath.split('.');
    let current: any = target;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = value;
  }

  private updateField(fieldPath: string, value: any): void {
    this.setNestedValue(this.config, fieldPath, value);

    // Mettre à jour TechnicalConfigManager pour les sauvegardes (sans déclencher config:updated pour éviter la boucle)
    if (window.app?.configManager) {
      const partialConfig: any = {};
      this.setNestedValue(partialConfig, fieldPath, value);
      window.app.configManager.updateConfig(partialConfig, true);
    }
  }
  
  private getFieldValue(fieldPath: string): any {
    const parts = fieldPath.split('.');
    let current: any = this.config;
    
    for (const part of parts) {
      if (current && current[part] !== undefined) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
  }
  
  /**
   * Échappe les caractères HTML pour éviter XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Enregistrer le composant
customElements.define('app-config-form', ConfigForm);
