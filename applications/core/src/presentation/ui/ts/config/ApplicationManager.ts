/**
 * Manager des applications
 * Gère l'activation/désactivation des applications
 */

interface ApplicationStatus {
  activated: string[];
  disabled: string[];
}

interface ApplicationEnableResult {
  appId: string;
  success: boolean;
  error?: string;
  /** false pour une app en process séparé (superviseur Phase 2) : elle démarre/s'arrête seule,
   *  sans jamais redémarrer core — voir ApplicationManager.enable()/disable() côté serveur. */
  restarting?: boolean;
}

export class ApplicationManager {
  private applications: ApplicationStatus = { activated: [], disabled: [] };
  private socket: any;
  public loading: boolean = false;
  public error: string | null = null;
  
  constructor(socket: any) {
    this.socket = socket;
    this.setupSocketListeners();
  }
  
  /**
   * Configure les écouteurs Socket.io
   */
  private setupSocketListeners(): void {
    // Demander la liste des applications
    this.socket.emit('app:applications:list');
    
    // Écouter la liste des applications
    this.socket.on('app:applications:list:result', (data: ApplicationStatus) => {
      this.applications = data;
      this.loading = false;
      this.error = null;
      console.log('[ApplicationManager] Liste des applications reçue:', data);
      
      window.dispatchEvent(new CustomEvent('applications:loaded', {
        detail: this.applications
      }));
    });
    
    // Écouter les résultats d'activation
    this.socket.on('app:applications:enable:result', (data: ApplicationEnableResult) => {
      this.loading = false;
      if (data.success) {
        // Rafraîchir la liste
        this.socket.emit('app:applications:list');
        console.log(`[ApplicationManager] Application ${data.appId} activée avec succès`);
        this.notifyActionCompleted(data.appId, 'activée', data.restarting);
      } else {
        this.error = `Erreur lors de l'activation: ${data.error || 'Inconnu'}`;
        console.error(`[ApplicationManager] Erreur activation ${data.appId}:`, data.error);

        window.dispatchEvent(new CustomEvent('applications:error', {
          detail: { message: this.error }
        }));
      }
    });

    // Écouter les résultats de désactivation
    this.socket.on('app:applications:disable:result', (data: ApplicationEnableResult) => {
      this.loading = false;
      if (data.success) {
        // Rafraîchir la liste
        this.socket.emit('app:applications:list');
        console.log(`[ApplicationManager] Application ${data.appId} désactivée avec succès`);
        this.notifyActionCompleted(data.appId, 'désactivée', data.restarting);
      } else {
        this.error = `Erreur lors de la désactivation: ${data.error || 'Inconnu'}`;
        console.error(`[ApplicationManager] Erreur désactivation ${data.appId}:`, data.error);

        window.dispatchEvent(new CustomEvent('applications:error', {
          detail: { message: this.error }
        }));
      }
    });
  }

  /**
   * `restarting` (⭐ 24/08/2026, voir ApplicationManager.enable()/disable() côté serveur) distingue
   * les deux issues possibles : une app en process séparé (superviseur Phase 2 — toutes les apps du
   * socle aujourd'hui) démarre/s'arrête seule, sans jamais redémarrer core — pas de compte à rebours
   * à afficher, juste une confirmation. Une app encore in-process (aucune actuellement, mécanisme
   * conservé pour une future app non migrée) déclenche le vrai redémarrage complet — fenêtre de 15s
   * (RestartManager.scheduleRestart), diffusée à tous les onglets ouverts sur cet écran pour que
   * leur compte à rebours reste cohérent entre eux.
   */
  private notifyActionCompleted(appId: string, action: 'activée' | 'désactivée', restarting?: boolean): void {
    if (restarting) {
      window.dispatchEvent(new CustomEvent('applications:restart-pending', {
        detail: { delaySeconds: 15 }
      }));
    } else {
      window.dispatchEvent(new CustomEvent('applications:action-completed', {
        detail: { appId, action }
      }));
    }
  }

  /**
   * Déclenche immédiatement un redémarrage déjà planifié — appelé quand l'utilisateur quitte
   * l'écran "Gestion des applications" avant la fin du compte à rebours.
   */
  restartNow(): void {
    this.socket.emit('app:applications:restart-now');
  }
  
  /**
   * Retourne la liste des applications
   */
  getApplications(): ApplicationStatus {
    return { ...this.applications };
  }
  
  /**
   * Active une application. Pas de confirmation bloquante (dialogue natif `confirm()`,
   * retiré le 07/08/2026) : incompatible avec la fenêtre de 15s qui permet d'enchaîner
   * plusieurs activations/désactivations avant un seul redémarrage — le compte à rebours
   * affiché (voir ApplicationsManager.ts) tient lieu de délai de réflexion/annulation implicite.
   * @param appId ID de l'application à activer
   */
  enableApplication(appId: string): void {
    this.loading = true;
    this.error = null;
    this.socket.emit('app:applications:enable', { appId });

    window.dispatchEvent(new CustomEvent('applications:enabling', {
      detail: { appId }
    }));
  }

  /**
   * Désactive une application — voir le commentaire de enableApplication() ci-dessus.
   * @param appId ID de l'application à désactiver
   */
  disableApplication(appId: string): void {
    this.loading = true;
    this.error = null;
    this.socket.emit('app:applications:disable', { appId });

    window.dispatchEvent(new CustomEvent('applications:disabling', {
      detail: { appId }
    }));
  }
  
  /**
   * Rafraîchit la liste des applications
   */
  refreshApplications(): void {
    this.loading = true;
    this.socket.emit('app:applications:list');
  }
  
  /**
   * Vérifie si une application est activée
   */
  isActivated(appId: string): boolean {
    return this.applications.activated.includes(appId);
  }
  
  /**
   * Vérifie si une application est désactivée
   */
  isDisabled(appId: string): boolean {
    return this.applications.disabled.includes(appId);
  }
}
