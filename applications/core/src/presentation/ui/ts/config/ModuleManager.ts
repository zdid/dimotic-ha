import { Module, ModuleUiMetadata, ConfigField, ConfigFieldGroup, isConfigFieldGroup } from '../types';

/**
 * Manager de modules
 * Gère la liste des modules et leurs métadonnées UI
 */

interface ModuleConfig {
  [key: string]: any;
}

export class ModuleManager {
  private modules: Module[] = [];
  private socket: any;
  private moduleConfigs: Record<string, ModuleConfig> = {};
  // Modules ayant reçu une vraie réponse serveur app:module:config au moins une fois — distinct
  // de la simple présence dans moduleConfigs, qui peut aussi être une coquille {} pré-remplie par
  // generateModuleConfigForm() avant que la réponse réelle n'arrive (voir app:module:config
  // ci-dessous pour le pourquoi de cette distinction).
  private moduleConfigLoaded: Set<string> = new Set();
  private moduleUiMetadata: Record<string, ModuleUiMetadata> = {};
  public activeModule: string | null = null;
  
  constructor(socket: any) {
    this.socket = socket;
    this.setupSocketListeners();
  }
  
  /**
   * Configure les écouteurs Socket.io
   */
  private setupSocketListeners(): void {
    // Liste des modules
    this.socket.on('app:modules:list', (data: { modules: Module[] }) => {
      this.modules = data.modules;
      
      // Charger les configurations de chaque module
      data.modules.forEach(module => {
        this.socket.emit('app:modules:config:get', { moduleId: module.id });
      });
      
      // Notifier que les modules sont chargés
      console.log('[ModuleManager] Modules chargés, dispatch modules:loaded:', this.modules.map(m => `${m.id}(${m.name})`));
      window.dispatchEvent(new CustomEvent('modules:loaded', {
        detail: { modules: this.modules }
      }));

      // ⭐ 27/08/2026 : la sélection du module actif par défaut vit maintenant exclusivement dans
      // Sidebar.ts/ModuleContainer.ts (page d'accueil par défaut, voir HomeView.ts) — ce bloc
      // dupliquait la même décision ("premier module non-core") et dispatchait `module:activated`
      // juste après `modules:loaded`, écrasant systématiquement le choix "accueil" des deux autres
      // écouteurs (bug réel constaté en test : atterrissait sur arbreouquoi malgré "accueil" fixé
      // ailleurs). `setActiveModule` ci-dessous exige de toute façon un module CONNU dans
      // `this.modules` pour dispatcher quoi que ce soit — 'accueil' n'en fait pas partie — donc ce
      // bloc n'a plus de rôle à jouer ici, supprimé plutôt que rendu incohérent.
    });
    
    // Configuration d'un module — app:modules:config:get est redemandé à la fois par
    // app:modules:list et par app:module:ui:register (tous deux rejoués à chaque connexion,
    // indépendamment l'un de l'autre), donc au moins deux réponses app:module:config arrivent
    // en pratique pour un même module. Sans garde, chacune écrase moduleConfigs[moduleId] — une
    // édition locale en cours (formulaire déjà ouvert, notamment le champ 'array') pouvait donc
    // être silencieusement effacée par une réponse tardive/dupliquée avant même la sauvegarde.
    // On n'accepte que la toute première vraie réponse par module ; moduleConfigLoaded (pas la
    // simple présence dans moduleConfigs, qui peut être une coquille {} pré-remplie par
    // generateModuleConfigForm() avant que cette réponse n'arrive) distingue les deux cas.
    this.socket.on('app:module:config', (data: { moduleId: string; config: ModuleConfig }) => {
      if (data.moduleId && data.config !== undefined) {
        if (this.moduleConfigLoaded.has(data.moduleId)) {
          console.log(`[ModuleManager] Configuration dupliquée ignorée pour module: ${data.moduleId}`);
          return;
        }
        this.moduleConfigLoaded.add(data.moduleId);
        this.moduleConfigs[data.moduleId] = data.config;
        console.log(`[ModuleManager] Configuration reçue pour module: ${data.moduleId}`);

        window.dispatchEvent(new CustomEvent('module:config:loaded', {
          detail: { moduleId: data.moduleId, config: data.config }
        }));
      }
    });
    
    // Métadonnées UI d'un module
    this.socket.on('app:module:ui:register', (data: { moduleId: string; metadata: ModuleUiMetadata }) => {
      this.moduleUiMetadata[data.moduleId] = data.metadata;
      console.log(`[ModuleManager] Métadonnées UI reçues pour module: ${data.moduleId}`);
      
      // Demander la config du module
      this.socket.emit('app:modules:config:get', { moduleId: data.moduleId });
    });
    
    // Configuration sauvegardée — relayé pour affichage réel côté formulaire (voir TODO.md
    // "Aucune confirmation visible..."), jusqu'ici seulement loggé et jamais montré à
    // l'utilisateur. Nom sans ':' pour rester consommable par un sélecteur Alpine
    // x-on:module-config-save-result.window.
    this.socket.on('app:module:config:saved', (data: { moduleId: string; success: boolean; error?: string }) => {
      console.log(`[ModuleManager] Résultat de sauvegarde pour ${data.moduleId}:`, data);
      window.dispatchEvent(new CustomEvent('module-config-save-result', { detail: data }));
    });
  }
  
  /**
   * Retourne la liste de tous les modules
   */
  getModules(): Module[] {
    return [...this.modules];
  }
  
  /**
   * Retourne un module spécifique
   */
  getModule(id: string): Module | undefined {
    return this.modules.find(m => m.id === id);
  }
  
  /**
   * Définit le module actif
   */
  setActiveModule(id: string): void {
    this.activeModule = id;
    const module = this.modules.find(m => m.id === id);
    
    if (module) {
      // Charger le contenu du module si nécessaire
      window.dispatchEvent(new CustomEvent('module:activated', {
        detail: { moduleId: id, module }
      }));
    }
  }
  
  /**
   * Charge la configuration d'un module
   */
  getModuleConfig(moduleId: string): ModuleConfig | undefined {
    return this.moduleConfigs[moduleId];
  }
  
  /**
   * Récupère la valeur d'un champ d'un module
   */
  getModuleField(moduleId: string, fieldName: string): any {
    const config = this.moduleConfigs[moduleId] || {};
    return this.getNestedValue(config, fieldName);
  }
  
  /**
   * Écrit une valeur dans l'objet config en respectant un chemin imbriqué
   * (ex: "mqtt.host" → config.mqtt.host) — symétrique de getNestedValue().
   */
  private setNestedValue(config: ModuleConfig, fieldPath: string, value: any): void {
    const parts = fieldPath.split('.');
    let current: any = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Met à jour la valeur d'un champ d'un module
   */
  setModuleField(event: Event, moduleId: string, fieldName: string): void {
    if (!this.moduleConfigs[moduleId]) {
      this.moduleConfigs[moduleId] = {};
    }

    const target = event.target as HTMLInputElement;
    const value = target.type === 'number'
      ? parseFloat(target.value) || 0
      : target.type === 'checkbox'
        ? target.checked
        : target.value;

    this.setNestedValue(this.moduleConfigs[moduleId], fieldName, value);

    window.dispatchEvent(new CustomEvent('module:field:updated', {
      detail: { moduleId, fieldName, value }
    }));
  }

  /**
   * Écrit une valeur déjà résolue (ex: un tableau) dans un champ de module — utilisé par les
   * champs Alpine (type 'array'), où un x-effect republie l'état géré par Alpine directement à
   * chaque mutation, sans passer par un événement DOM input/change comme setModuleField().
   */
  setModuleFieldRaw(moduleId: string, fieldName: string, value: any): void {
    if (!this.moduleConfigs[moduleId]) {
      this.moduleConfigs[moduleId] = {};
    }
    this.setNestedValue(this.moduleConfigs[moduleId], fieldName, value);
  }

  /**
   * Sélectionne une valeur dans un select
   */
  setSelectField(event: Event, moduleId: string, fieldName: string): void {
    if (!this.moduleConfigs[moduleId]) {
      this.moduleConfigs[moduleId] = {};
    }

    const target = event.target as HTMLSelectElement;
    this.setNestedValue(this.moduleConfigs[moduleId], fieldName, target.value);

    window.dispatchEvent(new CustomEvent('module:field:updated', {
      detail: { moduleId, fieldName, value: target.value }
    }));
  }
  
  /**
   * Sauvegarde la configuration d'un module
   */
  saveModuleConfig(moduleId: string): void {
    console.log('[ModuleManager] Sauvegarde config module - moduleId:', moduleId);

    // Utiliser this.moduleConfigs, alimenté en direct par les éditions du formulaire
    // (setModuleField/setSelectField) — TechnicalConfigManager ne
    // reflète jamais ces éditions, seulement la dernière config confirmée par le serveur.
    const config = this.moduleConfigs[moduleId] || {};
    console.log('[ModuleManager] Config module:', JSON.stringify(config, null, 2));
    console.log('[ModuleManager] Envoi de app:modules:config:save au serveur');
    this.socket.emit('app:modules:config:save', { moduleId, config });
    // Le bouton (Alpine, generateModuleConfigForm) passe en état "saving" localement au clic —
    // la sortie de cet état est pilotée par le vrai résultat serveur, voir app:module:config:saved
    // ci-dessus (module-config-save-result), plus de setTimeout optimiste ici.
  }
  
  /**
   * Retourne les métadonnées UI d'un module
   */
  getModuleUiMetadata(moduleId: string): ModuleUiMetadata | undefined {
    return this.moduleUiMetadata[moduleId];
  }
  
  /**
   * Génère un formulaire de configuration pour un module
   */
  generateModuleConfigForm(moduleId: string): string {
    const metadata = this.moduleUiMetadata[moduleId];
    
    if (!metadata) {
      return `<div class="error-hint">Métadonnées UI non disponibles pour ${moduleId}</div>`;
    }
    
    if (!this.moduleConfigs[moduleId]) {
      this.moduleConfigs[moduleId] = {};
    }
    
    const config = this.moduleConfigs[moduleId];
    const fields = metadata.fields || [];

    let html = `
      <div class="module-config-header">
        <h3>${metadata.icon || ''} ${metadata.title}</h3>
        <p class="section-description">${metadata.description}</p>
      </div>
      <form class="module-config-form" onsubmit="return false">
    `;

    // Générer les champs — supporte les champs plats (ConfigField[]) ET les groupes
    // (ConfigFieldGroup[], ex: nommage/rfxcom/evoo7) : un groupe entier traité comme un champ
    // unique produisait auparavant une ligne "undefined" (field.name/type inexistants).
    fields.forEach(item => {
      if (isConfigFieldGroup(item)) {
        html += this.generateFieldGroupHtml(item, config, moduleId);
      } else {
        html += `<div class="config-grid">${this.generateFieldHtml(item, config, moduleId)}</div>`;
      }
    });

    html += `
      </form>
      <div class="section-actions module-config-actions"
           x-data="{ saving: false, resultType: null, resultMessage: '' }"
           x-on:module-config-save-result.window="if ($event.detail.moduleId === '${moduleId}') { saving = false; resultType = $event.detail.success ? 'success' : 'error'; resultMessage = $event.detail.success ? 'Configuration sauvegardée' : ($event.detail.error || 'Erreur de sauvegarde'); setTimeout(() => resultType = null, 4000) }">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving"
          @click="saving = true; resultType = null; window.app.moduleManager.saveModuleConfig('${moduleId}')"
        >
          <span x-text="saving ? 'Sauvegarde en cours...' : 'Sauvegarder'"></span>
        </button>
        <span class="save-feedback" x-show="resultType" x-text="resultMessage" :class="{ 'save-feedback-error': resultType === 'error' }"></span>
      </div>
    `;

    return html;
  }

  /**
   * Génère le HTML pour un groupe de champs (title/description/fields imbriqués).
   */
  private generateFieldGroupHtml(group: ConfigFieldGroup, config: ModuleConfig, moduleId: string): string {
    const fieldsHtml = group.fields.map(field => this.generateFieldHtml(field, config, moduleId)).join('');
    return `
      <div class="module-config-group">
        <h4>${group.icon || ''} ${group.title || ''}</h4>
        ${group.description ? `<p class="section-description">${group.description}</p>` : ''}
        <div class="config-grid">${fieldsHtml}</div>
      </div>
    `;
  }
  
  /**
   * Génère le HTML pour un champ spécifique
   */
  private generateFieldHtml(field: ConfigField, config: ModuleConfig, moduleId: string): string {
    // Périmètre/rendu suffisamment différents (pas de wrapper .form-group générique, en-tête
    // par élément, boutons Ajouter/Retirer) pour justifier un chemin de rendu séparé plutôt que
    // d'étendre le switch ci-dessous.
    if (field.type === 'array') {
      return this.generateArrayFieldHtml(field, config, moduleId);
    }

    const fieldName = field.name;
    const resolved = this.getNestedValue(config, fieldName);
    const value = resolved !== undefined ? resolved : field.default ?? '';
    const id = `field-${moduleId}-${fieldName.replace(/\./g, '-')}`;

    let html = `
      <div class="form-group" id="${id}">
        <label for="${id}">
          ${field.label}
          ${field.required ? '<span class="required-badge">Requis</span>' : ''}
        </label>
    `;

    // Générer l'input en fonction du type
    switch (field.type) {
      case 'text':
      case 'string':
        html += `
          <input
            type="text"
            id="${id}"
            value="${this.escapeHtmlAttr(String(value ?? ''))}"
            data-module="${moduleId}"
            data-field="${fieldName}"
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
        `;
        break;

      case 'number':
        html += `
          <input 
            type="number" 
            id="${id}"
            value="${value || ''}"
            data-module="${moduleId}"
            data-field="${fieldName}"
            ${field.min !== undefined ? `min="${field.min}"` : ''}
            ${field.max !== undefined ? `max="${field.max}"` : ''}
            ${field.step !== undefined ? `step="${field.step}"` : ''}
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
        `;
        break;
        
      case 'boolean':
        html += `
          <input 
            type="checkbox" 
            id="${id}"
            ${value ? 'checked' : ''}
            data-module="${moduleId}"
            data-field="${fieldName}"
          />
          ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
        `;
        break;
        
      case 'select':
        html += `
          <select
            id="${id}"
            data-module="${moduleId}"
            data-field="${fieldName}"
          >
            ${field.options?.map(opt => {
              // options accepte soit string[] (ex: ['debug','info',...]) soit {value,label}[]
              const optValue = typeof opt === 'string' ? opt : opt.value;
              const optLabel = typeof opt === 'string' ? opt : opt.label;
              return `<option value="${optValue}" ${value === optValue ? 'selected' : ''}>${optLabel}</option>`;
            }).join('') || ''}
          </select>
          ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
        `;
        break;
        
      case 'password':
        html += `
          <input
            type="password"
            id="${id}"
            value="${this.escapeHtmlAttr(String(value ?? ''))}"
            data-module="${moduleId}"
            data-field="${fieldName}"
            autocomplete="off"
            placeholder="${field.placeholder || ''}"
          />
          ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
        `;
        break;
    }
    
    html += '</div>';
    return html;
  }

  /**
   * Génère le HTML d'un champ de type 'array' — liste avec ajout/suppression dynamique, rendue
   * entièrement par Alpine (x-for/x-model), pas par le système data-field/addEventListener des
   * autres types. `items` est un état Alpine local (x-data), initialisé une fois avec la valeur
   * courante ; `x-effect` republie ensuite tout changement (ajout, suppression, édition d'un
   * sous-champ) vers ModuleManager.moduleConfigs via setModuleFieldRaw(), qui reste la source de
   * vérité lue par saveModuleConfig() — inchangé pour les autres types de champs.
   *
   * `JSON.parse(JSON.stringify(items))` avant setModuleFieldRaw() n'est pas cosmétique : `items`
   * est le Proxy réactif d'Alpine lui-même, pas un tableau brut. Le passer tel quel stocke ce
   * Proxy DANS moduleConfigs (un magasin JS ordinaire, non géré par Alpine) — exactement le
   * scénario que déconseille alpinejs-implementation_specs_v1.0.md §4 ("piloter la même donnée
   * par Alpine ET par du code non-Alpine en parallèle") : constaté en pratique, une édition ne
   * se propageait plus de façon fiable à moduleConfigs après quelques cycles de rendu. Le clone
   * JSON découple complètement : moduleConfigs ne contient plus jamais de Proxy Alpine.
   */
  private generateArrayFieldHtml(field: ConfigField, config: ModuleConfig, moduleId: string): string {
    const fieldName = field.name;
    const resolved = this.getNestedValue(config, fieldName);
    const items = Array.isArray(resolved) ? resolved : (Array.isArray(field.default) ? field.default : []);
    const itemFields = field.itemFields || [];
    const itemLabel = field.itemLabel || 'Élément';
    const minItems = field.minItems ?? 0;
    const id = `field-${moduleId}-${fieldName.replace(/\./g, '-')}`;

    const itemsJson = this.escapeHtmlAttr(JSON.stringify(items));
    const defaultItemJson = this.escapeHtmlAttr(JSON.stringify(this.buildDefaultArrayItem(itemFields)));
    const itemFieldsHtml = itemFields.map(f => this.generateArrayItemFieldHtml(f)).join('');

    return `
      <div class="form-group config-array" id="${id}"
           x-data="{ items: ${itemsJson} }"
           x-effect="window.app.moduleManager.setModuleFieldRaw('${moduleId}', '${fieldName}', JSON.parse(JSON.stringify(items)))">
        <label>${field.label}</label>
        ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
        <template x-for="(item, index) in items" :key="index">
          <div class="config-array-item">
            <div class="config-array-item-header">
              <span x-text="'${itemLabel} ' + (index + 1)"></span>
              <button type="button" class="btn btn-secondary btn-small"
                      x-show="items.length > ${minItems}" @click="items.splice(index, 1)">
                Retirer
              </button>
            </div>
            <div class="config-grid">${itemFieldsHtml}</div>
          </div>
        </template>
        <button type="button" class="btn btn-secondary" @click="items.push(${defaultItemJson})">
          + Ajouter ${itemLabel}
        </button>
      </div>
    `;
  }

  /**
   * Génère le HTML d'un sous-champ d'un élément de tableau — toujours lié via x-model à
   * `item.<chemin>` (Alpine gère nativement les chemins imbriqués sur un objet JS réel, ex:
   * "mqtt.host"), jamais via data-field/addEventListener comme generateFieldHtml().
   */
  private generateArrayItemFieldHtml(field: ConfigField): string {
    const path = `item.${field.name}`;
    const label = `<label>${field.label}${field.required ? ' <span class="required-badge">Requis</span>' : ''}</label>`;
    const hint = field.hint ? `<div class="field-hint">${field.hint}</div>` : '';

    let input: string;
    switch (field.type) {
      case 'boolean':
        input = `<input type="checkbox" x-model="${path}" />`;
        break;
      case 'select': {
        const opts = field.options || [];
        const optionsHtml = opts.map(opt => {
          const optValue = typeof opt === 'string' ? opt : opt.value;
          const optLabel = typeof opt === 'string' ? opt : opt.label;
          return `<option value="${optValue}">${optLabel}</option>`;
        }).join('');
        // Un <select> ne connaît que des valeurs string — si toutes les options sont numériques
        // (ex: QoS 0/1/2), x-model.number convertit en nombre réel pour matcher un schéma Zod
        // qui attend z.number(), pas la string "1".
        const allNumeric = opts.length > 0 && opts.every(opt => {
          const v = typeof opt === 'string' ? opt : opt.value;
          return v !== '' && !isNaN(Number(v));
        });
        input = `<select x-model${allNumeric ? '.number' : ''}="${path}">${optionsHtml}</select>`;
        break;
      }
      case 'number':
        input = `<input type="number" x-model.number="${path}"` +
          `${field.min !== undefined ? ` min="${field.min}"` : ''}` +
          `${field.max !== undefined ? ` max="${field.max}"` : ''}` +
          `${field.step !== undefined ? ` step="${field.step}"` : ''} />`;
        break;
      case 'password':
        input = `<input type="password" x-model="${path}" autocomplete="off" placeholder="${field.placeholder || ''}" />`;
        break;
      case 'text':
      case 'string':
      default:
        input = `<input type="text" x-model="${path}" placeholder="${field.placeholder || ''}" />`;
        break;
    }

    return `<div class="form-group">${label}${input}${hint}</div>`;
  }

  /**
   * Construit l'objet par défaut d'un nouvel élément de tableau à partir de itemFields — chaque
   * sous-champ prend sa propre valeur `default`, sinon une valeur vide adaptée à son type.
   * setNestedValue() gère les chemins imbriqués (ex: "mqtt.host") de la même façon que pour un
   * champ plat, garantissant que x-model trouve toujours un objet existant à chaque niveau.
   */
  private buildDefaultArrayItem(itemFields: ConfigField[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const f of itemFields) {
      const value = f.default !== undefined
        ? f.default
        : f.type === 'number' ? 0
        : f.type === 'boolean' ? false
        : '';
      this.setNestedValue(result, f.name, value);
    }
    return result;
  }

  /** Échappe une chaîne pour un usage sûr comme valeur d'attribut HTML entre guillemets doubles. */
  private escapeHtmlAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  /**
   * Résout un chemin de champ (ex: "mqtt.host") en valeur imbriquée dans l'objet config
   * (ex: config.mqtt.host) — accès plat config[fieldName] auparavant, qui ne trouvait jamais
   * rien pour les noms de champs pointés utilisés par nommage/rfxcom/evoo7 (mirroring
   * ConfigForm.getFieldValue, applications/core/src/presentation/ui/ts/components/ConfigForm.ts).
   */
  private getNestedValue(config: ModuleConfig, fieldPath: string): any {
    const parts = fieldPath.split('.');
    let current: any = config;
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
   * Retourne la classe CSS pour le statut d'un module
   */
  getModuleStatusClass(moduleId: string): string {
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
  
  /**
   * Retourne l'icône de statut d'un module
   */
  getModuleStatusIcon(moduleId: string): string {
    const module = this.modules.find(m => m.id === moduleId);
    if (!module) return '';
    
    const statusIcons: Record<string, string> = {
      configured: '✓',
      partial: '⚠',
      missing: '✗',
      error: '✘'
    };
    
    return statusIcons[module.status] || '';
  }
  
  /**
   * Charge les modules depuis le socket
   */
  loadModules(modules: Module[]): void {
    this.modules = modules;
    if (modules.length > 0 && !this.activeModule) {
      this.setActiveModule(modules[0].id);
    }
    
    console.log('[ModuleManager] loadModules - Modules chargés, dispatch modules:loaded:', modules.map(m => `${m.id}(${m.name})`));
    window.dispatchEvent(new CustomEvent('modules:loaded', {
      detail: { modules: this.modules }
    }));
  }
}
