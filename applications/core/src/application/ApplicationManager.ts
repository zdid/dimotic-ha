// applications/core/src/application/ApplicationManager.ts
// Service de gestion dynamique de l'activation/désactivation des applications
// Conforme à specs-techniques-socle-ha-mqtt-v4.4.md §4.3

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../infrastructure/logger';
import type { RestartManager } from './RestartManager';
import type { ConfigService } from '../infrastructure/config/ConfigService';

/** Fenêtre glissante avant redémarrage après une activation/désactivation — voir
 *  RestartManager.scheduleRestart() : chaque nouvel appel pendant ce délai le réinitialise à
 *  15s, laissant le temps d'enchaîner plusieurs changements avant un seul redémarrage. */
const APPLICATION_TOGGLE_RESTART_DELAY_MS = 15000;

/**
 * ApplicationManager - Gère l'activation et la désactivation dynamique des applications
 *
 * Toutes les applications restent physiquement dans applications/{app}/ en permanence —
 * l'état activé/désactivé est une simple liste (`disabledApps`) dans data/core/config.yaml
 * (voir ConfigService.getDisabledApps/setDisabledApps), pas un déplacement de dossier.
 *
 * Ancienne conception (jusqu'au 07/08/2026) : déplacement physique via fs.renameSync() entre
 * applications/ et applications_désactivées/ — abandonnée après avoir découvert (03/08/2026,
 * voir Dockerfile) qu'elle échoue avec EXDEV sous overlay2 tant qu'un volume Docker nommé
 * dédié ne couvre pas tout /app. Le nouveau mécanisme n'a plus ce besoin : aucune opération de
 * déplacement de fichier n'a plus lieu en fonctionnement normal.
 *
 * `migrateLegacyDisabledDir()` (appelée une fois au démarrage) rapatrie automatiquement toute
 * application encore présente dans applications_désactivées/ (installations existantes, ex.
 * ha2) vers applications/ + `disabledApps`, pour une transition sans intervention manuelle.
 *
 * Responsabilités :
 * - Lister les applications activées et désactivées
 * - Activer une application (retrait de `disabledApps`)
 * - Désactiver une application (ajout à `disabledApps`)
 * - Déclencher un restart après modification
 */
export class ApplicationManager {
  private readonly projectRoot: string;
  private readonly appsDir: string;
  private readonly legacyDisabledAppsDir: string;
  private logger: Logger;
  private restartManager: RestartManager;
  private configService: ConfigService;

  /**
   * Crée un nouveau ApplicationManager
   */
  constructor(restartManager: RestartManager, logger: Logger, configService: ConfigService) {
    // Chemin vers la racine du projet
    this.projectRoot = process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../../'));

    // Répertoire des applications (toujours actives physiquement)
    this.appsDir = path.join(this.projectRoot, 'applications');
    // Répertoire historique — plus jamais alimenté, seulement vidé une fois au démarrage
    // par migrateLegacyDisabledDir() pour les installations pré-07/08/2026.
    this.legacyDisabledAppsDir = path.join(this.projectRoot, 'applications_désactivées');

    this.restartManager = restartManager;
    this.logger = logger;
    this.configService = configService;

    if (!existsSync(this.appsDir)) {
      mkdirSync(this.appsDir, { recursive: true });
      this.logger.info('ApplicationManager', `Répertoire ${this.appsDir} créé`);
    }

    this.migrateLegacyDisabledDir();
  }

  /**
   * Migration one-shot : rapatrie toute application encore trouvée dans
   * applications_désactivées/ (ancien mécanisme) vers applications/, en l'ajoutant à
   * `disabledApps` si elle n'y est pas déjà — pour que son état désactivé soit préservé sous
   * le nouveau mécanisme sans action manuelle sur les installations existantes.
   */
  private migrateLegacyDisabledDir(): void {
    if (!existsSync(this.legacyDisabledAppsDir)) return;

    let legacyEntries: string[] = [];
    try {
      legacyEntries = readdirSync(this.legacyDisabledAppsDir).filter((entry) => {
        if (entry.startsWith('.')) return false;
        try {
          return statSync(path.join(this.legacyDisabledAppsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch (error) {
      this.logger.warn('ApplicationManager', `Erreur de lecture de ${this.legacyDisabledAppsDir}: ${error}`);
      return;
    }

    if (legacyEntries.length === 0) return;

    const disabledApps = new Set(this.configService.getDisabledApps());
    let migrated = 0;

    for (const appId of legacyEntries) {
      const legacyPath = path.join(this.legacyDisabledAppsDir, appId);
      const activePath = path.join(this.appsDir, appId);
      try {
        if (existsSync(activePath)) {
          this.logger.warn('ApplicationManager', `Migration ${appId} : ${activePath} existe déjà, dossier legacy ignoré (à nettoyer manuellement)`);
          continue;
        }
        renameSync(legacyPath, activePath);
        disabledApps.add(appId);
        migrated++;
        this.logger.info('ApplicationManager', `Migration : ${appId} rapatrié depuis applications_désactivées/ vers applications/ (reste désactivé via config)`);
      } catch (error) {
        this.logger.error('ApplicationManager', `Échec de migration de ${appId}: ${error}`);
      }
    }

    if (migrated > 0) {
      const result = this.configService.setDisabledApps([...disabledApps]);
      if (!result.success) {
        this.logger.error('ApplicationManager', `Échec de sauvegarde de disabledApps après migration: ${result.error}`);
      }
    }
  }

  /**
   * Liste toutes les applications (activées + désactivées)
   */
  listAll(): { activated: string[]; disabled: string[] } {
    const all = this.getApplicationsInDir(this.appsDir).filter((appId) => appId !== 'core');
    const disabledSet = new Set(this.configService.getDisabledApps());

    const activated = all.filter((appId) => !disabledSet.has(appId));
    const disabled = all.filter((appId) => disabledSet.has(appId));

    return { activated, disabled };
  }

  /**
   * Récupère la liste des applications dans un répertoire
   */
  private getApplicationsInDir(baseDir: string): string[] {
    const apps: string[] = [];

    if (!existsSync(baseDir)) return apps;

    try {
      const entries = readdirSync(baseDir).filter(entry => {
        if (entry.startsWith('.')) return false;
        const fullPath = path.join(baseDir, entry);
        try {
          return statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      for (const entry of entries) {
        if (this.isValidAppDir(path.join(baseDir, entry))) {
          apps.push(entry);
        }
      }
    } catch (error) {
      this.logger.warn('ApplicationManager', `Erreur de lecture du répertoire ${baseDir}: ${error}`);
    }

    return apps;
  }

  /**
   * Vérifie qu'un répertoire est une application valide
   * (contient un répertoire src/ ou dist/ ou package.json)
   */
  private isValidAppDir(dirPath: string): boolean {
    const srcDir = path.join(dirPath, 'src');
    const distDir = path.join(dirPath, 'dist');
    const packageJson = path.join(dirPath, 'package.json');

    // Une application valide a au moins un de ces éléments
    return existsSync(srcDir) || existsSync(distDir) || existsSync(packageJson);
  }

  /**
   * Active une application (retire son id de `disabledApps`)
   */
  enable(appId: string): { success: boolean; error?: string } {
    try {
      if (!this.isValidAppId(appId)) {
        return { success: false, error: `Nom d'application invalide: ${appId}` };
      }

      if (!existsSync(path.join(this.appsDir, appId))) {
        return { success: false, error: `Application ${appId} introuvable dans applications/` };
      }

      const disabledApps = this.configService.getDisabledApps();
      if (!disabledApps.includes(appId)) {
        return { success: false, error: `Application ${appId} déjà activée` };
      }

      const result = this.configService.setDisabledApps(disabledApps.filter((id) => id !== appId));
      if (!result.success) {
        return { success: false, error: result.error };
      }

      this.restartManager.scheduleRestart(APPLICATION_TOGGLE_RESTART_DELAY_MS, `Application ${appId} activée`);
      this.logger.info('ApplicationManager', `Application ${appId} activée`);

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('ApplicationManager', `Erreur lors de l'activation de ${appId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Désactive une application (ajoute son id à `disabledApps`)
   */
  disable(appId: string): { success: boolean; error?: string } {
    try {
      if (!this.isValidAppId(appId)) {
        return { success: false, error: `Nom d'application invalide: ${appId}` };
      }

      if (appId === 'core') {
        return { success: false, error: `Impossible de désactiver l'application core` };
      }

      if (!existsSync(path.join(this.appsDir, appId))) {
        return { success: false, error: `Application ${appId} introuvable dans applications/` };
      }

      const disabledApps = this.configService.getDisabledApps();
      if (disabledApps.includes(appId)) {
        return { success: false, error: `Application ${appId} déjà désactivée` };
      }

      const result = this.configService.setDisabledApps([...disabledApps, appId]);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      this.restartManager.scheduleRestart(APPLICATION_TOGGLE_RESTART_DELAY_MS, `Application ${appId} désactivée`);
      this.logger.info('ApplicationManager', `Application ${appId} désactivée`);

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('ApplicationManager', `Erreur lors de la désactivation de ${appId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Déclenche immédiatement un redémarrage déjà planifié (fenêtre de 15s en cours) — utilisé
   * quand l'utilisateur quitte l'écran "Gestion des applications" avant la fin du compte à
   * rebours : plus la peine d'attendre, il n'ajoutera plus de changement depuis cet écran.
   * Sans effet si aucun redémarrage n'est actuellement planifié.
   */
  restartNowIfPending(): void {
    if (!this.restartManager.isRestartScheduled()) return;
    this.logger.info('ApplicationManager', 'Écran "Gestion des applications" quitté avec un redémarrage en attente — déclenché immédiatement');
    this.restartManager.immediateRestart('Navigation quittée avec redémarrage en attente');
  }

  /**
   * Vérifie qu'un identifiant d'application est valide
   * (ne contient que des caractères alphanumériques, tirets et underscores)
   */
  private isValidAppId(appId: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(appId);
  }

  /**
   * Vérifie si une application existe (activée ou désactivée)
   */
  exists(appId: string): boolean {
    const { activated, disabled } = this.listAll();
    return activated.includes(appId) || disabled.includes(appId);
  }

  /**
   * Récupère le statut d'une application spécifique
   */
  getStatus(appId: string): 'activated' | 'disabled' | 'not_found' {
    const { activated, disabled } = this.listAll();
    if (activated.includes(appId)) return 'activated';
    if (disabled.includes(appId)) return 'disabled';
    return 'not_found';
  }
}
