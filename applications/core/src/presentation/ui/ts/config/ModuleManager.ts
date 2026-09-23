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
    if (field.type === 'button') {
      return this.generateButtonFieldHtml(field, moduleId);
    }
    if (field.type === 'preview') {
      return this.generatePreviewFieldHtml(field, moduleId);
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
   * Génère le HTML d'un champ de type 'button' (⭐ 17/09/2026) — envoie un événement générique au
   * clic (`field.action`) au lieu d'éditer une valeur, pour les actions qui n'ont pas leur place
   * dans le flux "Sauvegarder" habituel (import assisté, test de connexion...). Pas de wrapper
   * `.form-group`/label générique ici (le libellé du bouton EST le label, pas une légende
   * au-dessus d'un input) — même raison que `array` a son propre chemin de rendu séparé.
   * Résultat attendu sur `${action}:result` : `{ success: boolean, error?: string }`, écouté par
   * `triggerAction()` — convention déjà utilisée partout ailleurs dans le projet.
   */
  private generateButtonFieldHtml(field: ConfigField, moduleId: string): string {
    const id = `field-${moduleId}-${field.name.replace(/\./g, '-')}`;
    const confirmAttr = field.confirm ? ` onclick="return confirm(${JSON.stringify(field.confirm)})"` : '';
    return `
      <div class="form-group form-group-button" id="${id}">
        <button type="button" class="btn btn-secondary" id="${id}-btn"${confirmAttr}
          onclick="window.app.moduleManager.triggerAction('${field.action}', '${id}')">
          ${field.label}
        </button>
        <span class="field-action-result" id="${id}-result"></span>
        ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
      </div>
    `;
  }

  /**
   * Handler générique du clic sur un champ 'button' — émet `action`, écoute UNE fois
   * `${action}:result` (convention `{ success, error? }`), affiche le résultat à côté du bouton.
   * Volontairement générique : ne connaît rien du contenu métier de l'action (gossip, test de
   * connexion...), juste success/error — chaque app garde le détail (ex: `addedCount`) pour son
   * propre tableau de bord si besoin.
   */
  triggerAction(action: string, fieldId: string): void {
    const btn = document.getElementById(`${fieldId}-btn`) as HTMLButtonElement | null;
    const resultEl = document.getElementById(`${fieldId}-result`);
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.textContent = ''; resultEl.className = 'field-action-result'; }

    const resultEvent = `${action}:result`;
    const onResult = (result: { success?: boolean; error?: string } = {}) => {
      this.socket.off(resultEvent, onResult);
      if (btn) btn.disabled = false;
      if (!resultEl) return;
      resultEl.textContent = result.success ? '✅ Fait' : `❌ ${result.error || 'Échec'}`;
      resultEl.className = `field-action-result ${result.success ? 'success' : 'error'}`;
    };
    this.socket.on(resultEvent, onResult);
    this.socket.emit(action);
  }

  /**
   * Génère le HTML d'un champ de type 'preview' (⭐ 17/09/2026) — lecture seule, recalculé en
   * direct pendant la saisie des champs listés dans `field.previewOf` (voir ConfigForm.
   * setupFormListeners(), qui pose les écouteurs `input` réels et appelle computePreview()). Pas
   * de wrapper Alpine ici : les champs surveillés sont eux-mêmes de simples inputs data-field
   * classiques, pas des champs d'un tableau 'array'.
   */
  private generatePreviewFieldHtml(field: ConfigField, moduleId: string): string {
    const id = `field-${moduleId}-${field.name.replace(/\./g, '-')}`;
    return `
      <div class="form-group" id="${id}">
        <label>${field.label}</label>
        <code class="field-preview" id="${id}-value"
              data-preview-module="${moduleId}"
              data-preview-of="${this.escapeHtmlAttr((field.previewOf || []).join(','))}"
              data-preview-formula="${this.escapeHtmlAttr(field.previewFormula || '')}"></code>
        ${field.hint ? '<div class="field-hint">' + field.hint + '</div>' : ''}
      </div>
    `;
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
    const secretPush = field.secretPush;

    // ⭐ 17/09/2026 — `field.hiddenIdFrom` (ex: ['site','machine']) : pas de champ 'id' visible
    // dans `itemFields`, dérivé automatiquement à la place. Le garde `if (!item.id)` est ce qui
    // rend ce calcul "une seule fois" plutôt que continûment réactif : Alpine ne retrace les
    // dépendances d'un x-effect qu'à partir de ce qui est réellement LU à la dernière exécution —
    // une fois `item.id` non vide, seule la lecture de `item.id` (la condition) est enregistrée,
    // donc un futur changement de site/machine ne redéclenche plus rien. Une ligne déjà persistée
    // (chargée avec un id existant, même selon une ancienne convention) n'est donc jamais réécrite.
    //
    // ⭐ 23/09/2026 — bug constaté en test live : le x-effect s'exécutait dès la création de la
    // ligne, site/machine encore vides → id "-", figé définitivement. Désormais l'id d'une ligne
    // NOUVELLE est recalculé à chaque frappe ; seules les lignes déjà persistées (ids présents au
    // chargement, `lockedIds`) ou poussées avec succès (ajoutées à `lockedIds` par pushSecret)
    // gardent leur id tel quel.
    const hiddenIdFrom = field.hiddenIdFrom;
    const hiddenIdEffectAttr = hiddenIdFrom && hiddenIdFrom.length > 0
      ? ` x-effect="if (!lockedIds.includes(item.id)) { const parts = [${hiddenIdFrom.map(f => `item.${f}`).join(', ')}].map(v => String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')); item.id = parts.every(p => p) ? parts.join('-') : '' }"`
      : '';
    // ⭐ 23/09/2026 (2e bug live) : une ligne vide recevait l'id "-" (parties vides jointes), identique
    // à l'id historique "-" d'une ligne persistée → présent dans lockedIds → figé, et la poussée
    // écrasait l'autre machine. Désormais : id vide tant qu'une partie manque, et seuls les ids
    // bien formés (non vides, sans tiret en bord) peuvent être verrouillés.
    const isWellFormedId = (v: unknown): boolean => typeof v === 'string' && /^[a-z0-9](?:.*[a-z0-9])?$/.test(v);
    const lockedIdsJson = this.escapeHtmlAttr(JSON.stringify(items.map((it: { id?: unknown }) => it && it.id).filter(isWellFormedId)));

    // ⭐ 17/09/2026 — état/méthode Alpine additionnels, uniquement si `field.secretPush` est
    // déclaré (ex: SAUVEGARDE_UI_METADATA `targets`). `passwords`/`pushErrors`/`pushingIds` sont
    // volontairement des clés SÉPARÉES de `items` (jamais posées sur un `item` lui-même) : le seul
    // `x-effect` du composant republie tout changement d'`items` vers moduleConfigs (donc vers un
    // éventuel envoi par le bouton "Sauvegarder" global) — un mot de passe posé sur `item` fuirait
    // dans ce payload dès la frappe, avant même d'être poussé. `item.<statusField> = true` en
    // revanche est un vrai champ persistant de l'élément (comme site/machine/host) : le mettre à
    // jour ici donne un retour visuel immédiat sans attendre un rechargement — le serveur a de
    // toute façon déjà persisté ce même champ de son côté (voir SauvegardeService.handleSecretPush).
    const secretPushStateJs = secretPush ? `,
      passwords: {},
      pushErrors: {},
      pushingIds: [],
      async pushSecret(item) {
        const targetId = item.id;
        const appPassword = this.passwords[targetId] || '';
        if (!appPassword) { this.pushErrors[targetId] = 'Mot de passe manquant.'; return; }
        this.pushErrors[targetId] = '';
        this.pushingIds.push(targetId);
        const result = await window.app.moduleManager.pushArraySecret('${this.escapeJsString(secretPush.action)}', '${moduleId}', JSON.parse(JSON.stringify(item)), appPassword);
        this.pushingIds = this.pushingIds.filter(id => id !== targetId);
        if (result.success) {
          item.${secretPush.statusField} = true;
          if (result.id) item.id = result.id;
          if (item.id && !this.lockedIds.includes(item.id)) this.lockedIds.push(item.id);
          this.passwords[targetId] = '';
        } else {
          this.pushErrors[targetId] = result.error || 'Échec de la poussée.';
        }
      }` : '';

    const secretPushItemHtml = secretPush ? `
      <div class="config-array-item-secret">
        <input type="text" x-model="passwords[item.id]"
               placeholder="${this.escapeHtmlAttr(secretPush.passwordPlaceholder || 'Mot de passe')}"
               autocomplete="off" spellcheck="false" />
        <button type="button" class="btn btn-secondary btn-small" :disabled="pushingIds.includes(item.id)" @click="pushSecret(item)">
          <span x-text="pushingIds.includes(item.id) ? 'Envoi...' : '${this.escapeJsString(secretPush.pushButtonLabel || '📤 Pousser')}'"></span>
        </button>
        <span class="secret-tag" :class="item.${secretPush.statusField} ? 'secret-tag-deployed' : 'secret-tag-pending'"
              x-text="item.${secretPush.statusField} ? '${this.escapeJsString(secretPush.deployedLabel || '✅ Déployé')}' : '${this.escapeJsString(secretPush.pendingLabel || '⏳ En attente')}'"></span>
        <div class="field-feedback" x-show="pushErrors[item.id]" x-text="pushErrors[item.id]"></div>
      </div>
    ` : '';

    // ⭐ 18/09/2026 — `field.rowActions` (ex: « Lancer une sauvegarde maintenant ») : mêmes
    // conventions que `secretPush` (Promise via ModuleManager, état keyé par item.id) mais sans
    // mot de passe — juste `{ targetId }` en payload. `runningKeys` est un TABLEAU (`.includes()`),
    // pas un dictionnaire à clés dynamiques : un dictionnaire (`runningActions[action+':'+id]`)
    // produisait un bouton bloqué "disabled" dès le tout premier rendu (avant même un clic) — reproduit
    // en direct (Alpine 3.15.12), non résolu en profondeur, mais `pushingIds.includes(item.id)`
    // ci-dessus n'a jamais eu ce problème avec exactement le même genre d'état initial vide ; reprendre
    // ce même schéma (tableau + `.includes()`) plutôt que creuser plus loin la cause exacte côté Alpine.
    // `actionErrors` reste un dictionnaire (lecture simple par clé, jamais dans une expression
    // `:disabled`/`x-show` combinée à un `.includes()` sur tableau — jamais vu poser ce problème).
    const rowActions = field.rowActions || [];
    const rowActionsStateJs = rowActions.length > 0 ? `,
      runningKeys: [],
      actionErrors: {},
      async runRowAction(item, action) {
        const targetId = item.id;
        const key = action + ':' + targetId;
        this.actionErrors[key] = '';
        this.runningKeys.push(key);
        const result = await window.app.moduleManager.triggerArrayRowAction(action, '${moduleId}', JSON.parse(JSON.stringify(item)));
        this.runningKeys = this.runningKeys.filter(k => k !== key);
        if (!result.success) {
          this.actionErrors[key] = result.error || 'Échec.';
        }
      }` : '';

    const rowActionsHtml = rowActions.length > 0 ? `
      <div class="config-array-item-row-actions">
        ${rowActions.map(a => `
        <div class="config-array-item-row-action">
          <button type="button" class="btn btn-secondary btn-small"
                  :disabled="runningKeys.includes(${this.jsStringLiteral(a.action)} + ':' + item.id)"
                  ${a.confirm ? `onclick="return confirm(${this.jsStringLiteral(a.confirm)})"` : ''}
                  @click="runRowAction(item, ${this.jsStringLiteral(a.action)})">
            <span x-text="runningKeys.includes(${this.jsStringLiteral(a.action)} + ':' + item.id) ? 'En cours...' : ${this.jsStringLiteral(a.label)}"></span>
          </button>
          <div class="field-feedback" x-show="actionErrors[${this.jsStringLiteral(a.action)} + ':' + item.id]"
               x-text="actionErrors[${this.jsStringLiteral(a.action)} + ':' + item.id]"></div>
        </div>`).join('')}
      </div>
    ` : '';

    return `
      <div class="form-group config-array" id="${id}"
           x-data="{ items: ${itemsJson}, lockedIds: ${lockedIdsJson}${secretPushStateJs}${rowActionsStateJs} }"
           x-effect="window.app.moduleManager.setModuleFieldRaw('${moduleId}', '${fieldName}', JSON.parse(JSON.stringify(items)))">
        <label>${field.label}</label>
        ${field.hint ? `<div class="field-hint">${field.hint}</div>` : ''}
        <template x-for="(item, index) in items" :key="index">
          <div class="config-array-item"${hiddenIdEffectAttr}>
            <div class="config-array-item-header">
              <span x-text="'${itemLabel} ' + (index + 1)"></span>
              <button type="button" class="btn btn-secondary btn-small"
                      x-show="items.length > ${minItems}" @click="items.splice(index, 1)">
                Retirer
              </button>
            </div>
            <div class="config-grid">${itemFieldsHtml}</div>
            ${secretPushItemHtml}
            ${rowActionsHtml}
          </div>
        </template>
        <button type="button" class="btn btn-secondary" @click="items.push(${defaultItemJson})">
          + Ajouter ${itemLabel}
        </button>
      </div>
    `;
  }

  /**
   * Pousse un secret pour UN élément d'un champ 'array' (ex: mot de passe Nextcloud par machine,
   * voir `secretPush` sur `ConfigField`) — Promise-based, pas de callback comme triggerAction(),
   * car appelé via `await` depuis la méthode Alpine `pushSecret()` générée par
   * generateArrayFieldHtml(), qui a besoin du résultat pour mettre à jour son propre état réactif
   * (item.<statusField>, pushingIds, pushErrors) sans dupliquer cette logique ici. `targetId` dans
   * le résultat (plutôt qu'un simple success/error comme triggerAction()) : plusieurs lignes
   * peuvent pousser en parallèle, chacune doit reconnaître SA propre réponse.
   */
  pushArraySecret(action: string, moduleId: string, item: { id: string }, appPassword: string): Promise<{ success: boolean; error?: string; id?: string }> {
    const targetId = item.id;
    return new Promise((resolve) => {
      const resultEvent = `${action}:result`;
      const onResult = (result: { targetId?: string; success?: boolean; error?: string; id?: string } = {}) => {
        if (result.targetId !== targetId) return;
        this.socket.off(resultEvent, onResult);
        resolve({ success: !!result.success, error: result.error, id: result.id });
      };
      this.socket.on(resultEvent, onResult);
      this.socket.emit(action, { targetId, appPassword, item, moduleConfig: this.moduleConfigs[moduleId] });
    });
  }

  /**
   * Déclenche une action générique pour UN élément d'un champ 'array' (ex: « Lancer une sauvegarde
   * maintenant », voir `rowActions` sur `ConfigField`) — même principe que pushArraySecret() mais
   * sans mot de passe : le payload émis est `{ targetId, item, moduleConfig }`.
   */
  triggerArrayRowAction(action: string, moduleId: string, item: { id: string }): Promise<{ success: boolean; error?: string }> {
    const targetId = item.id;
    return new Promise((resolve) => {
      const resultEvent = `${action}:result`;
      const onResult = (result: { targetId?: string; success?: boolean; error?: string } = {}) => {
        if (result.targetId !== targetId) return;
        this.socket.off(resultEvent, onResult);
        resolve({ success: !!result.success, error: result.error });
      };
      this.socket.on(resultEvent, onResult);
      this.socket.emit(action, { targetId, item, moduleConfig: this.moduleConfigs[moduleId] });
    });
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

  /** Échappe une chaîne pour un usage sûr comme littéral JS entre guillemets simples, dans une
   *  expression Alpine inline (ex: x-text="'...'") — labels statiques fournis par l'app, pas une
   *  frontière de confiance réelle, juste une garde contre une apostrophe qui casserait la syntaxe. */
  private escapeJsString(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /** Comme escapeJsString(), mais renvoie un littéral JS complet (guillemets simples inclus) — pour
   *  embarquer une valeur directement dans une expression Alpine (x-text, :disabled...). */
  private jsStringLiteral(text: string): string {
    return `'${this.escapeJsString(text)}'`;
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
