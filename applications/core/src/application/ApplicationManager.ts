// applications/core/src/application/ApplicationManager.ts
// Service de gestion dynamique de l'activation/désactivation des applications
// Conforme à specs-techniques-socle-ha-mqtt-v4.4.md §4.3

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../infrastructure/logger';
import type { RestartManager } from './RestartManager';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { ProcessSupervisor } from '../supervisor';
import { scanApplications, resolveAppDir, isValidAppId, ensureExternalRoot, type AppOrigin } from './appRoots';

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
 * ⭐ 24/09/2026 — deux racines (`applications/` interne, `data/applications/` externe, voir
 * appRoots.ts), rapprochement disque/config (`reconcile()` : application nouvelle = désactivée) et
 * JAMAIS de redémarrage du core pour une application : activer/désactiver délèguent à AppService
 * (`setLifecycleHooks`) qui démarre ou arrête l'application à chaud.
 *
 * Responsabilités :
 * - Lister les applications activées et désactivées (+ origine, repère « nouvelle »)
 * - Activer une application (retrait de `disabledApps` + démarrage à chaud)
 * - Désactiver une application (ajout à `disabledApps` + arrêt à chaud)
 */
export class ApplicationManager {
  private readonly projectRoot: string;
  private readonly appsDir: string;
  private readonly legacyDisabledAppsDir: string;
  private logger: Logger;
  private restartManager: RestartManager;
  private configService: ConfigService;
  private processSupervisor?: ProcessSupervisor;

  /**
   * Crée un nouveau ApplicationManager
   * @param processSupervisor - ⭐ fonctionnelles-supervisor_specs v2.6 §8.2, optionnel : si une
   *   application activée/désactivée est enregistrée auprès de lui (runsAsSeparateProcess), enable/
   *   disable délèguent au spawn/kill ciblé au lieu de redémarrer tout le process core.
   */
  constructor(restartManager: RestartManager, logger: Logger, configService: ConfigService, processSupervisor?: ProcessSupervisor) {
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
    this.processSupervisor = processSupervisor;

    if (!existsSync(this.appsDir)) {
      mkdirSync(this.appsDir, { recursive: true });
      this.logger.info('ApplicationManager', `Répertoire ${this.appsDir} créé`);
    }

    this.migrateLegacyDisabledDir();

    const externalRootError = ensureExternalRoot(this.projectRoot);
    if (externalRootError) {
      this.logger.warn('ApplicationManager', externalRootError);
    }
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
   * ⭐ 24/09/2026 — rapprochement entre le disque (les deux racines, voir appRoots.ts) et la config
   * (`disabledApps` / `knownApps`), appelé au démarrage du core et à chaque ouverture de Gestion des
   * applications (décision du 24/09 : jamais de redémarrage du core pour une application).
   * - application jamais vue → ajoutée à `disabledApps` (arrive DÉSACTIVÉE) et repérée « nouvelle » ;
   * - `knownApps` absent (version antérieure) : installation NEUVE → tout désactivé ; mise à jour
   *   d'une installation existante → état actuel conservé (sinon tout se désactiverait d'un coup) ;
   * - application disparue du disque → retirée de `knownApps`/`disabledApps` et signalée dans
   *   `removed` (l'appelant arrête ce qui tournait encore). Revenue plus tard, elle est à nouveau
   *   « nouvelle », donc désactivée.
   */
  reconcile(): { added: string[]; removed: string[] } {
    const present = [...scanApplications().keys()];
    const known = this.configService.getKnownApps();
    let disabled = this.configService.getDisabledApps();
    let added: string[] = [];
    let removed: string[] = [];

    if (known === undefined) {
      if (this.configService.isFreshInstall()) {
        disabled = [...new Set([...disabled, ...present])];
        added = present;
        this.logger.info('ApplicationManager', `Installation neuve : toutes les applications arrivent désactivées (${present.join(', ')})`);
      } else {
        this.logger.info('ApplicationManager', `Mise à jour : mémorisation des applications existantes, état activé/désactivé conservé (${present.join(', ')})`);
      }
    } else {
      added = present.filter((id) => !known.includes(id));
      removed = known.filter((id) => !present.includes(id));
      if (added.length > 0) {
        disabled = [...new Set([...disabled, ...added])];
        this.logger.info('ApplicationManager', `Application(s) nouvelle(s), désactivée(s) en attendant d'être activée(s) : ${added.join(', ')}`);
      }
      if (removed.length > 0) {
        this.logger.info('ApplicationManager', `Application(s) disparue(s) du disque : ${removed.join(', ')}`);
      }
    }

    disabled = disabled.filter((id) => present.includes(id));
    for (const id of added) this.newApps.add(id);
    for (const id of removed) this.newApps.delete(id);

    const unchanged = known !== undefined && added.length === 0 && removed.length === 0
      && disabled.length === this.configService.getDisabledApps().length;
    if (!unchanged) {
      const result = this.configService.setAppLists(disabled, present);
      if (!result.success) {
        this.logger.error('ApplicationManager', `Échec d'enregistrement des listes d'applications: ${result.error}`);
      }
    }
    return { added, removed };
  }

  /** Applications repérées « nouvelles » depuis le démarrage de ce core (repère UI, jamais persisté). */
  private readonly newApps = new Set<string>();

  /**
   * Liste toutes les applications (activées + désactivées) — `details` (⭐ 24/09/2026) : origine
   * (interne / externe / externe-remplace) et repère « nouvelle » pour Gestion des applications.
   */
  listAll(): { activated: string[]; disabled: string[]; details: Array<{ appId: string; origin: AppOrigin; isNew: boolean }> } {
    const apps = scanApplications();
    const disabledSet = new Set(this.configService.getDisabledApps());
    const all = [...apps.keys()];
    return {
      activated: all.filter((appId) => !disabledSet.has(appId)),
      disabled: all.filter((appId) => disabledSet.has(appId)),
      details: [...apps.values()].map((a) => ({ appId: a.appId, origin: a.origin, isNew: this.newApps.has(a.appId) }))
    };
  }

  /** Dossier effectif d'une application (racine externe prioritaire), voir appRoots.ts. */
  resolveAppDir(appId: string): string | undefined {
    return resolveAppDir(appId);
  }

  /**
   * ⭐ 24/09/2026 — activation/désactivation réelles déléguées à AppService (seul à tenir modules,
   * SocketBridge, ProcessSupervisor, schémas) : UN chemin « activer » et UN chemin « désactiver »,
   * les mêmes au démarrage, au clic, à l'apparition ou à la disparition d'un dossier.
   * `activateHook` renvoie un message d'erreur, ou `undefined` si l'application tourne.
   */
  private activateHook?: (appId: string, appDir: string) => string | undefined;
  private deactivateHook?: (appId: string) => void;

  setLifecycleHooks(activate: (appId: string, appDir: string) => string | undefined, deactivate: (appId: string) => void): void {
    this.activateHook = activate;
    this.deactivateHook = deactivate;
  }

  /**
   * Active une application (retire son id de `disabledApps`) et la démarre tout de suite — jamais
   * de redémarrage du core (décision du 24/09/2026).
   */
  enable(appId: string): { success: boolean; error?: string; restarting?: boolean } {
    try {
      if (!isValidAppId(appId)) {
        return { success: false, error: `Nom d'application invalide: ${appId}` };
      }
      const appDir = resolveAppDir(appId);
      if (!appDir) {
        return { success: false, error: `Application ${appId} introuvable (applications/ ni data/applications/)` };
      }
      const disabledApps = this.configService.getDisabledApps();
      if (!disabledApps.includes(appId)) {
        return { success: false, error: `Application ${appId} déjà activée` };
      }

      // `undefined` = succès (l'application tourne) — ne JAMAIS écrire `hook?.() ?? 'erreur'` ici : ce
      // `??` transformait chaque réussite en échec (bug du 24/09/2026, trouvé au premier test réel).
      if (!this.activateHook) {
        return { success: false, error: 'activation indisponible (hook non installé)' };
      }
      const error = this.activateHook(appId, appDir);
      if (error) {
        return { success: false, error: `Activation de ${appId} impossible : ${error}` };
      }
      const result = this.configService.setDisabledApps(disabledApps.filter((id) => id !== appId));
      if (!result.success) {
        return { success: false, error: result.error };
      }
      this.newApps.delete(appId);
      this.logger.info('ApplicationManager', `Application ${appId} activée (${appDir})`);
      return { success: true, restarting: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('ApplicationManager', `Erreur lors de l'activation de ${appId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Désactive une application (ajoute son id à `disabledApps`) et l'arrête tout de suite, en défaisant
   * tout ce que l'activation avait mis en place (voir AppService.deactivateApp()).
   */
  disable(appId: string): { success: boolean; error?: string; restarting?: boolean } {
    try {
      if (!isValidAppId(appId)) {
        return { success: false, error: `Nom d'application invalide: ${appId}` };
      }
      if (appId === 'core') {
        return { success: false, error: `Impossible de désactiver l'application core` };
      }
      if (!resolveAppDir(appId)) {
        return { success: false, error: `Application ${appId} introuvable (applications/ ni data/applications/)` };
      }
      const disabledApps = this.configService.getDisabledApps();
      if (disabledApps.includes(appId)) {
        return { success: false, error: `Application ${appId} déjà désactivée` };
      }
      const result = this.configService.setDisabledApps([...disabledApps, appId]);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      this.deactivateHook?.(appId);
      this.logger.info('ApplicationManager', `Application ${appId} désactivée`);
      return { success: true, restarting: false };
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
