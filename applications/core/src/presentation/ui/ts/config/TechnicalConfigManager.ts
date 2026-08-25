/**
 * Manager de configuration technique
 * Gère toute la configuration HA, MQTT, Web, Logging
 */

interface TechnicalConfig {
  ha: {
    ws_enable: boolean;
    mqtt_enable: boolean;
    ws: {
      host: string;
      port: number;
      token: string;
      reconnect_delay: number;
    };
    mqtt: {
      host: string;
      port: number;
      client_id: string;
      username: string;
      password: string;
      keepalive: number;
      reconnect_delay: number;
    };
    structure: {
      include_unassigned: boolean;
      unassigned_label: string;
    };
  };
  web: {
    port: number;
    host: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    rotate: {
      max_size_mb: number;
      max_files: number;
    };
  };
}

interface ValidationError {
  path: string;
  message: string;
  type: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  requiredMissing: string[];
}

interface ConfigSaveResult {
  success: boolean;
  message?: string;
  errors?: ValidationError[];
}

export class TechnicalConfigManager {
  private config: TechnicalConfig;
  private socket: any;
  public validationResult: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    requiredMissing: []
  };
  public saveInProgress: boolean = false;
  public isLoading: boolean = true;
  public isHaConnected: boolean | null = null;
  public isMqttConnected: boolean | null = null;
  public uptime: number = 0;
  
  /**
   * Configuration par défaut
   */
  private getDefaultConfig(): TechnicalConfig {
    return {
      ha: {
        ws_enable: false,
        mqtt_enable: false,
        ws: {
          host: '',
          port: 8123,
          token: '',
          reconnect_delay: 5
        },
        mqtt: {
          host: '',
          port: 1883,
          client_id: 'ha-app-unique-id',
          username: '',
          password: '',
          keepalive: 60,
          reconnect_delay: 5
        },
        structure: {
          include_unassigned: false,
          unassigned_label: 'Non assigné'
        }
      },
      web: {
        port: 8080,
        host: '0.0.0.0'
      },
      logging: {
        level: 'info',
        rotate: {
          max_size_mb: 10,
          max_files: 5
        }
      }
    };
  }
  
  constructor(socket: any) {
    this.socket = socket;
    this.config = this.getDefaultConfig();
    this.setupSocketListeners();
  }
  
  /**
   * Configure les écouteurs Socket.io
   */
  private setupSocketListeners(): void {
    // Connexion
    this.socket.on('connect', () => {
      this.isLoading = false;
      // Note: config:current est un événement persistant, reçu automatiquement
      // Pas besoin de socket.emit('config:get')
      window.dispatchEvent(new CustomEvent('socket:connected'));
    });
    
    // Configuration actuelle
    this.socket.on('config:current', (partialConfig: Partial<TechnicalConfig>) => {
      this.config = this.mergeDeep({ ...this.config }, partialConfig);
      this.isLoading = false;
      this.notifyConfigUpdated();
    });
    
    // Résultat de validation
    this.socket.on('config:validation:result', (result: ValidationResult) => {
      this.validationResult = result;
      this.notifyValidationUpdated();
    });

    // Résultat réel d'une sauvegarde (succès/échec/erreurs de validation) — jusqu'ici reçu mais
    // jamais relayé à l'UI, qui affichait une confirmation optimiste via un simple setTimeout
    // (voir TODO.md "Aucune confirmation visible..."). Redispatché sous un nom sans ':' pour
    // rester consommable par un sélecteur Alpine x-on:config-save-result.window.
    this.socket.on('config:save:result', (result: ConfigSaveResult) => {
      this.saveInProgress = false;
      window.dispatchEvent(new CustomEvent('config-save-result', { detail: result }));
    });

    // Résultat de la demande de redémarrage manuel — l'arrêt réel du process suit de peu
    // (voir RestartManager côté serveur), la déconnexion Socket.io qui s'ensuit est déjà
    // gérée par les écouteurs 'disconnect' existants.
    this.socket.on('app:restart:result', (result: { success: boolean; error?: string }) => {
      window.dispatchEvent(new CustomEvent('app-restart-result', { detail: result }));
    });
    
    // Connexion HA
    this.socket.on('ha:connected', () => {
      this.isHaConnected = true;
      this.notifyHaStatusChanged();
    });

    this.socket.on('ha:disconnected', () => {
      this.isHaConnected = false;
      this.notifyHaStatusChanged();
    });

    // Connexion MQTT (statut agrégé — au moins un bridge d'application connecté, voir
    // IntegrationBridge.updateAggregateMqttStatus)
    this.socket.on('mqtt:connected', () => {
      this.isMqttConnected = true;
      this.notifyMqttStatusChanged();
    });

    this.socket.on('mqtt:disconnected', () => {
      this.isMqttConnected = false;
      this.notifyMqttStatusChanged();
    });

    // Application démarrée — jusqu'ici jamais relayé à Socket.io (absent de
    // SOCLE_SOCKET_EVENTS/persistentCoreEvents, voir AppService.ts) : ce handler n'avait donc
    // jamais pu s'exécuter, l'uptime restant figé à "0s" (bug constaté le 07/08/2026). Payload
    // serveur ({timestamp, version}, voir index.ts) — utiliser data.timestamp (l'heure réelle de
    // démarrage) plutôt que Date.now() (l'heure de réception côté client) : l'événement étant
    // maintenant persistant, il est rejoué tel quel à un client qui se connecte bien après le
    // démarrage réel, Date.now() donnerait alors un uptime totalement faux à ce moment-là.
    this.socket.on('app:started', (data: { timestamp?: string; version?: string }) => {
      this.uptime = data?.timestamp ? new Date(data.timestamp).getTime() : Date.now();
      window.dispatchEvent(new CustomEvent('app:started', { detail: { uptime: this.uptime, version: data?.version } }));
    });
    
    // Liste des modules
    this.socket.on('app:modules:list', (data: { modules: any[] }) => {
      window.dispatchEvent(new CustomEvent('app-modules-loaded', {
        detail: { modules: data.modules }
      }));
    });
  }
  
  /**
   * Fusion profonde de deux objets
   */
  private mergeDeep<T>(target: T, source: Partial<T>): T {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!result[key]) {
          result[key] = {} as any;
        }
        result[key] = this.mergeDeep(result[key] as any, source[key] as any);
      } else {
        result[key] = source[key] as any;
      }
    }
    
    return result;
  }
  
  /**
   * Retourne la configuration complète
   */
  getConfig(): TechnicalConfig {
    return { ...this.config };
  }
  
  /**
   * Met à jour une partie de la configuration
   * @param partial - Configuration partielle à fusionner
   * @param silent - Si true, n'émet pas config:updated (pour éviter les boucles avec ConfigForm)
   */
  updateConfig(partial: Partial<TechnicalConfig>, silent: boolean = false): void {
    this.config = this.mergeDeep(this.config, partial);
    if (!silent) {
      this.notifyConfigUpdated();
    }
  }
  
  /**
   * Sauvegarde la configuration
   */
  saveConfig(): void {
    console.log('[TechnicalConfigManager] Envoi de config:save au serveur');
    console.log('[TechnicalConfigManager] Config envoyée:', JSON.stringify(this.config, null, 2));
    
    this.saveInProgress = true;
    this.socket.emit('config:save', this.config);
    // this.saveInProgress est remis à false par le vrai résultat serveur (config:save:result,
    // voir setupSocketListeners) — plus de setTimeout optimiste ici.
  }
  
  /**
   * Demande le redémarrage manuel de l'application (bouton "Redémarrer l'application").
   * Redémarrage seulement : sous Docker `restart: unless-stopped`, un arrêt persistant
   * nécessiterait une action externe (docker stop), pas quelque chose que ce bouton peut faire.
   */
  restartApplication(): void {
    if (confirm('Voulez-vous vraiment redémarrer l\'application ? Toutes les connexions en cours seront brièvement interrompues.')) {
      this.socket.emit('app:restart');
      window.dispatchEvent(new CustomEvent('app-restart-requested'));
    }
  }

  /**
   * Récupère la valeur d'un champ de configuration
   */
  getFieldValue(fieldPath: string): any {
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
   * Met à jour la valeur d'un champ de configuration
   */
  setFieldValue(fieldPath: string, value: any): void {
    const parts = fieldPath.split('.');
    let current: any = this.config;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    current[parts[parts.length - 1]] = value;
    this.notifyConfigUpdated();
  }
  
  /**
   * Valide un champ spécifique
   */
  validateField(fieldPath: string): { isValid: boolean; errorMessage: string } {
    const error = this.validationResult.errors?.find(e => e.path === fieldPath);
    return {
      isValid: !error,
      errorMessage: error ? error.message : ''
    };
  }
  
  /**
   * Retourne la classe CSS pour le statut d'un champ
   */
  getFieldStatusClass(fieldPath: string): string {
    return this.validateField(fieldPath).isValid ? '' : 'field-invalid';
  }
  
  /**
   * Formate le temps de fonctionnement (uptime)
   */
  formatUptime(ts: number = this.uptime): string {
    if (!ts) return '0s';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }
  
  /**
   * Retourne le label d'une section
   */
  getSectionLabel(section: string): string {
    const labels: Record<string, string> = {
      global: 'Global',
      ha: 'Web-Services',
      mqtt: 'MQTT',
      web: 'Web',
      logging: 'Logging'
    };
    return labels[section] || section;
  }
  
  // ======================================================================
  // NOTIFICATIONS
  // ======================================================================
  
  private notifyConfigUpdated(): void {
    window.dispatchEvent(new CustomEvent('config:updated', {
      detail: { config: this.config }
    }));
    // ⭐ 24/08/2026 : synchronise les indicateurs "activé" (rouge/orange/vert, voir Sidebar.ts) —
    // ws_enable/mqtt_enable ne voyagent que dans config:current, jamais dans ha:connected/
    // mqtt:connected eux-mêmes, donc c'est ici (à chaque mise à jour de config, pas seulement au
    // premier chargement) qu'il faut les recopier vers les stores.
    if (window.Alpine) {
      window.Alpine.store('haWs').enabled = this.config.ha?.ws_enable === true;
      window.Alpine.store('mqtt').enabled = this.config.ha?.mqtt_enable === true;
    }
  }
  
  private notifyValidationUpdated(): void {
    window.dispatchEvent(new CustomEvent('config:validation:updated', {
      detail: this.validationResult
    }));
  }
  
  private notifyHaStatusChanged(): void {
    window.dispatchEvent(new CustomEvent('ha:status:changed', {
      detail: { isConnected: this.isHaConnected }
    }));
    if (window.Alpine) window.Alpine.store('haWs').connected = this.isHaConnected;
  }

  private notifyMqttStatusChanged(): void {
    window.dispatchEvent(new CustomEvent('mqtt:status:changed', {
      detail: { isConnected: this.isMqttConnected }
    }));
    if (window.Alpine) window.Alpine.store('mqtt').connected = this.isMqttConnected;
  }
  
  // ======================================================================
  // UTILITAIRES
  // ======================================================================
  
  /**
   * Scroll vers une section
   */
  scrollToSection(sectionId: string): void {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }
  
  /**
   * Scroll vers un champ spécifique
   */
  scrollToField(fieldPath: string): void {
    const field = document.querySelector(`[data-field="${fieldPath}"]`);
    if (field) {
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
