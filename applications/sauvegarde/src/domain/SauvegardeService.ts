/**
 * SauvegardeService
 *
 * Orchestrateur de l'application Sauvegarde/Restauration. Pour l'instant (tranche 1 du plan
 * d'implémentation) : chargement/rechargement de la config, statut, import gossip, poussée du secret
 * par SSH — rien de Nextcloud/restauration encore, voir specs/current/fonctionnelles-sauvegarde_specs_v1.3.md §6/§6bis.
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { CorrelatedRequester, runSsh, ensureGlobalSshKey } from '../../../core/dist/exports';
import { sauvegardeConfigSchema, SECRET_FILE_PATH, deriveTargetId, type SauvegardeConfig, type SauvegardeTargetConfig } from './config-schema';
import type { SauvegardeStatus, GossipImportResult } from './types';
import { SecretPushService } from './SecretPushService';
import { ScriptPushService } from './ScriptPushService';
import { BACKUP_SCRIPT_REMOTE_PATH } from './BackupScript';

/** Une exécution manuelle (tar + push WebDAV) peut prendre largement plus que le timeout SSH par
 *  défaut (30s) selon la taille de /docker sur la machine — 5 minutes de marge. */
const BACKUP_RUN_TIMEOUT_MS = 300000;

const MODULE_NAME = 'sauvegarde';

/** Forme brute renvoyée par core (TargetGossipService) — voir DeploymentTargetConfig/
 *  HaStackTargetConfig côté core, non réexportés tels quels, structure recopiée ici. */
interface GossipRawTarget {
  id: string;
  host: string;
  remoteDir: string;
  // ⭐ 17/09/2026 — core.site, diffusé par TargetGossipService (voir resolveSiteFor côté core) ;
  // absent/vide pour un pair qui n'a pas encore son site renseigné, jamais deviné.
  site?: string;
}

interface GossipTargetsReply {
  correlation_id: string;
  targets: GossipRawTarget[];
  haStackTargets: GossipRawTarget[];
}

export interface ISauvegardeService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SauvegardeStatus;
}

export class SauvegardeService implements ISauvegardeService {
  private config: SauvegardeConfig;
  private readonly secretPushService = new SecretPushService();
  private readonly scriptPushService = new ScriptPushService();
  private readonly gossipRequester: CorrelatedRequester<{}, GossipTargetsReply>;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<SauvegardeConfig>
  ) {
    this.config = this.loadConfig();
    this.gossipRequester = new CorrelatedRequester(eventBus, 'sauvegarde:gossip-targets:get', 'sauvegarde:gossip-targets:reply');
  }

  private loadConfig(): SauvegardeConfig {
    const raw = this.configProvider.getAppConfig() as Partial<SauvegardeConfig>;
    return sauvegardeConfigSchema.parse(raw);
  }

  async start(): Promise<void> {
    this.logger.info('SauvegardeService', 'Démarrage du service Sauvegarde/Restauration...');
    this.setupSocketEventListeners();

    // ⭐ 17/09/2026, demande explicite : premier répertoire déjà prépositionné à l'ouverture des
    // Paramètres Techniques, sans bouton à cliquer — uniquement si `targets` est encore vide (ne
    // rejoue jamais après, pour ne pas revenir sur des entrées éditées/supprimées à la main). Best
    // effort : `core` peut ne pas encore avoir de gossip au tout premier démarrage, échec silencieux.
    if (this.config.targets.length === 0) {
      this.handleGossipImport().catch((error) => {
        this.logger.warn('SauvegardeService', `Import gossip au démarrage sans effet: ${error}`);
      });
    }

    this.emitStatus();
    this.logger.info('SauvegardeService', 'Service Sauvegarde/Restauration démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('SauvegardeService', 'Arrêt du service Sauvegarde/Restauration...');
  }

  getStatus(): SauvegardeStatus {
    const { serverUrl, user } = this.config.nextcloud;
    return {
      nextcloudConfigured: Boolean(serverUrl && user),
      webdavUrl: serverUrl && user ? `${serverUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(user)}` : '',
      targetsCount: this.config.targets.length
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('sauvegarde:status', this.getStatus());
  }

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('sauvegarde:status:get', () => this.emitStatus());

    // Même correctif que teleinfo/rpigpio (pas la version d'arexx, qui omet ce reload()) : sans
    // lui, une config sauvegardée depuis l'UI n'est jamais relue ici, malgré une écriture disque
    // correcte — voir ArexxService.ts pour l'historique du bug.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.configProvider.reload();
      this.config = this.loadConfig();
      this.emitStatus();
    });

    this.eventBus.onGeneric<{ targetId: string; appPassword: string }>('sauvegarde:secret:push', (data) => {
      this.handleSecretPush(data.targetId, data.appPassword).catch((error) => {
        this.logger.error('SauvegardeService', `Échec de la poussée du secret (${data.targetId}): ${error}`);
      });
    });

    this.eventBus.onGeneric('sauvegarde:gossip:import', () => {
      this.handleGossipImport().catch((error) => {
        this.logger.error('SauvegardeService', `Échec de l'import gossip: ${error}`);
      });
    });

    this.eventBus.onGeneric<{ targetId: string }>('sauvegarde:backup:run', (data) => {
      this.handleBackupRunNow(data.targetId).catch((error) => {
        this.logger.error('SauvegardeService', `Échec du déclenchement manuel (${data.targetId}): ${error}`);
      });
    });
  }

  /**
   * Import assisté (pas automatique/silencieux) des machines déjà connues par gossip
   * (core.targets/core.haStackTargets) — demande explicite de l'utilisateur du 17/09/2026, via
   * CorrelatedRequester (même mécanisme que ia↔planificateur). N'écrase jamais une entrée déjà
   * présente (voir mergeAndSaveTargets). ⭐ Simplifié une TROISIÈME fois (17/09/2026) : une seule
   * ligne par machine, point — plus de `deploymentType` du tout, voir le commentaire de
   * `sauvegardeTargetSchema` (le futur script hôte sauvegarde les deux arborescences et saute
   * celle qui n'existe pas).
   */
  private async handleGossipImport(): Promise<void> {
    try {
      const reply = await this.gossipRequester.request({}, 5000);
      const byHost = new Map<string, GossipRawTarget>();
      for (const t of [...reply.targets, ...reply.haStackTargets]) {
        if (t.host) byHost.set(t.host, t);
      }

      const suggestions: SauvegardeTargetConfig[] = Array.from(byHost.values()).map((t) => ({
        id: deriveTargetId(t.site || '', t.id),
        site: t.site || '', machine: t.id, host: t.host, secretDeployed: false
      }));

      const result = this.mergeAndSaveTargets(suggestions);
      this.eventBus.emitGeneric('sauvegarde:gossip:import:result', result);
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:gossip:import:result', {
        success: false,
        addedCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Fusionne `newTargets` dans `config.targets` et sauvegarde — utilisé par l'import gossip
   * (l'ajout manuel d'une machine se fait désormais directement via le champ 'array' natif de
   * Paramètres Techniques, plus par cet événement — voir socket-events.ts).
   *
   * ⭐ Déduplication par CONTENU (host seul, depuis la 3e simplification), pas par id généré — bug
   * réel constaté en direct sur l'import gossip : l'utilisateur renomme systématiquement les id
   * après coup (identifiants lisibles plutôt que `gossip-dimotic-noisy2::noisy`), donc un id
   * généré ne correspond plus jamais à ce qui est déjà là et tout se réimportait en double à
   * chaque clic. `host` seul, lui, reste stable même après renommage de l'id/machine/site.
   */
  private mergeAndSaveTargets(newTargets: SauvegardeTargetConfig[]): { success: boolean; addedCount: number; error?: string } {
    const existingKeys = new Set(this.config.targets.map((t) => t.host));
    const toAdd: SauvegardeTargetConfig[] = [];
    for (const t of newTargets) {
      if (!t.host || existingKeys.has(t.host)) continue;
      existingKeys.add(t.host); // évite aussi les doublons ENTRE eux dans le même lot
      toAdd.push(t);
    }

    if (toAdd.length > 0) {
      this.config = { ...this.config, targets: [...this.config.targets, ...toAdd] };
      const result = this.configProvider.savePartialConfig(this.config);
      if (!result.success) {
        return { success: false, addedCount: 0, error: result.error };
      }
      // ⭐ savePartialConfig (ConfigService) écrit sur disque mais NE PRÉVIENT PAS le navigateur
      // (contrairement au flux normal "Sauvegarder" du formulaire, qui émet cet événement lui-même)
      // — sans ça, une page Paramètres Techniques déjà ouverte reste périmée jusqu'à rechargement.
      // Bug réel constaté en direct : import fait, rien de visible côté formulaire tant qu'on ne
      // rafraîchissait pas la page à la main.
      this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
    }

    this.emitStatus();
    return { success: true, addedCount: toAdd.length };
  }

  /**
   * Point d'entrée UI pour écrire le mot de passe d'application Nextcloud sur une machine déjà
   * connue, sans passer par un terminal — voir SecretPushService. `appPassword` ne transite par
   * aucune écriture de config ici, seulement par SSH (stdin) vers `SECRET_FILE_PATH` sur la cible.
   *
   * ⭐ 18/09/2026, demande explicite : « Pousser » ne se limite plus au mot de passe — il pousse
   * aussi le script de sauvegarde (chantier A, BackupScript.ts) et pose son cron quotidien
   * (ScriptPushService), dans la foulée. Le tag persistant `secretDeployed` ne passe à vrai que si
   * les TROIS étapes réussissent (secret → script → cron) : un demi-déploiement (ex. secret écrit
   * mais cron jamais posé) resterait sinon marqué « Déployé » à tort, alors que le script ne
   * tournerait jamais tout seul. `result.step` (`'push'` pour le secret, `'script'`/`'cron'` pour la
   * suite) distingue laquelle des trois a échoué, affiché tel quel côté UI.
   */
  private async handleSecretPush(targetId: string, appPassword: string): Promise<void> {
    const target = this.config.targets.find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', {
        targetId,
        success: false,
        error: `Cible introuvable: ${targetId}`
      });
      return;
    }

    try {
      const secretResult = await this.secretPushService.push(target, SECRET_FILE_PATH, appPassword);
      if (!secretResult.success) {
        this.eventBus.emitGeneric('sauvegarde:secret:push:result', { targetId, ...secretResult });
        return;
      }

      const scriptResult = await this.scriptPushService.push(target, {
        site: target.site,
        machine: target.machine,
        serverUrl: this.config.nextcloud.serverUrl,
        user: this.config.nextcloud.user,
        rootPath: this.config.nextcloud.rootPath,
        secretFilePath: SECRET_FILE_PATH
      });

      if (scriptResult.success) {
        this.config = {
          ...this.config,
          targets: this.config.targets.map((t) => t.id === targetId ? { ...t, secretDeployed: true } : t)
        };
        const saveResult = this.configProvider.savePartialConfig(this.config);
        if (saveResult.success) {
          this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
          this.emitStatus();
        } else {
          this.logger.error('SauvegardeService', `Script poussé mais tag non sauvegardé (${targetId}): ${saveResult.error}`);
        }
      }
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', { targetId, ...scriptResult });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', {
        targetId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Exécute par SSH le script déjà déployé sur `target.host`, tout de suite, sans attendre le cron
   * — ⭐ 18/09/2026, demande explicite ("je dois pouvoir déclencher une sauvegarde à la demande").
   * Ne pousse rien de nouveau (secret/script/cron inchangés) : suppose que « Pousser » a déjà été
   * cliqué au moins une fois pour cette machine — sinon le script est simplement absent et la
   * commande échoue avec un message clair ("No such file or directory"), pas besoin de vérifier
   * `secretDeployed` avant de tenter.
   */
  private async handleBackupRunNow(targetId: string): Promise<void> {
    const target = this.config.targets.find((t) => t.id === targetId);
    if (!target || !target.host) {
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: false,
        error: `Cible introuvable: ${targetId}`
      });
      return;
    }

    try {
      const sshKeyPath = ensureGlobalSshKey();
      const result = await runSsh({ host: target.host, sshKeyPath }, BACKUP_SCRIPT_REMOTE_PATH, undefined, BACKUP_RUN_TIMEOUT_MS);
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: result.success,
        error: result.error
      });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<SauvegardeConfig>
  ): SauvegardeService {
    return new SauvegardeService(eventBus, logger, configProvider);
  }
}
