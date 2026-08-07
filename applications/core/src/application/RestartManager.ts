// src/application/RestartManager.ts
// Gestion du redémarrage propre de l'application
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §10.3

import type { Logger } from '../infrastructure/logger/index';

/**
 * RestartManager - Gère le redémarrage différé après sauvegarde de configuration
 * 
 * Règles (conforme §9.3 specs-techniques-socle-ha-mqtt-v4.3) :
 * - Code de sortie 0 = arrêt propre (normal ou après sauvegarde config)
 * - Code de sortie 1 = erreur fatale au démarrage
 * - Docker redémarre automatiquement grâce à `restart: unless-stopped`
 */
export class RestartManager {
  private logger: Logger;
  private restartTimeout: NodeJS.Timeout | null = null;
  private restartScheduled: boolean = false;

  /**
   * Crée un nouveau RestartManager
   * @param logger - Instance du logger pour le logging
   */
  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Planifie un redémarrage après un délai. Un appel alors qu'un redémarrage est déjà planifié
   * RÉINITIALISE le délai (annule l'ancien timer, reprogramme un nouveau delayMs complet) plutôt
   * que d'ignorer l'appel — utilisé par ApplicationManager.enable/disable pour laisser une
   * fenêtre de 15s glissante permettant d'activer/désactiver plusieurs applications avant qu'un
   * seul redémarrage ne s'applique à toutes les modifications (demande utilisateur 07/08/2026).
   * @param delayMs - Délai en millisecondes avant le redémarrage (default: 500ms)
   * @param reason - Raison du redémarrage (pour le logging)
   */
  scheduleRestart(delayMs: number = 500, reason: string = 'Configuration saved'): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.logger.info('RestartManager', `Redémarrage déjà planifié — délai réinitialisé à ${delayMs}ms : ${reason}`);
    } else {
      this.logger.info('RestartManager', `Redémarrage planifié dans ${delayMs}ms : ${reason}`);
    }

    this.restartScheduled = true;

    // Planifier le nouveau timeout
    this.restartTimeout = setTimeout(() => {
      this.executeRestart();
    }, delayMs);

    // Le timeout sera nettoyé par executeRestart
  }

  /**
   * Exécute le redémarrage immédiatement
   * Ne doit être appelé que par scheduleRestart() ou dans des cas exceptionnels
   */
  private executeRestart(): void {
    this.restartScheduled = false;
    
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    this.logger.info('RestartManager', 'Redémarrage de l\'application...');
    
    // Code de sortie 0 = arrêt propre
    // Docker redémarrera automatiquement grâce à restart: unless-stopped
    process.exit(0);
  }

  /**
   * Annule un redémarrage planifié
   */
  cancelRestart(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
      this.restartScheduled = false;
      this.logger.info('RestartManager', 'Redémarrage annulé');
    }
  }

  /**
   * Vérifie si un redémarrage est planifié
   */
  isRestartScheduled(): boolean {
    return this.restartScheduled;
  }

  /**
   * Redémarrage immédiat sans délai
   * ⚠️ À utiliser avec précaution - peut causer une perte de données
   * @param reason - Raison du redémarrage
   */
  immediateRestart(reason: string = 'Immediate restart requested'): void {
    this.cancelRestart();
    this.logger.warn('RestartManager', `Redémarrage immédiat : ${reason}`);
    this.executeRestart();
  }
}
