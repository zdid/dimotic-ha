/**
 * SauvegardeService
 *
 * Orchestrateur de l'application Sauvegarde/Restauration. Pour l'instant (tranche 1 du plan
 * d'implémentation) : chargement/rechargement de la config, statut, rien de Nextcloud/restauration
 * encore — voir specs/current/fonctionnelles-sauvegarde_specs_v1.0.md §6/§6bis.
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { CorrelatedRequester } from '../../../core/dist/exports';
import { sauvegardeConfigSchema, type SauvegardeConfig, type SauvegardeTargetConfig } from './config-schema';
import type { SauvegardeStatus, GossipImportResult } from './types';
import { SecretPushService } from './SecretPushService';

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
      targetsCount: this.config.targets.length,
      targets: this.config.targets.map((t) => ({ id: t.id, site: t.site, machine: t.machine, host: t.host }))
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
  }

  /**
   * Import assisté (pas automatique/silencieux) des répertoires « dimotic-ha » et « HA » déjà
   * connus par gossip (core.targets/core.haStackTargets) — demande explicite de l'utilisateur du
   * 17/09/2026, via CorrelatedRequester (même mécanisme que ia↔planificateur). N'écrase jamais une
   * entrée déjà présente, n'ajoute que ce qui manque vraiment.
   *
   * ⭐ Déduplication par CONTENU (host + deploymentDir), pas par id généré — bug réel constaté en
   * direct : l'utilisateur renomme systématiquement les id à l'import (identifiants lisibles
   * plutôt que `gossip-dimotic-noisy2::noisy`), donc un id généré ne correspond plus jamais à ce
   * qui est déjà là et tout se réimportait en double à chaque clic. Le couple host+deploymentDir,
   * lui, reste stable même après renommage de l'id/machine/site par l'utilisateur.
   */
  private async handleGossipImport(): Promise<void> {
    try {
      const reply = await this.gossipRequester.request({}, 5000);
      const existingKeys = new Set(this.config.targets.map((t) => `${t.host}::${t.deploymentDir}`));
      const suggestions: SauvegardeTargetConfig[] = [];

      const tryAdd = (host: string, deploymentDir: string, unitName: string, destinationPath: string, machine: string, site: string) => {
        const key = `${host}::${deploymentDir}`;
        if (!host || existingKeys.has(key)) return;
        existingKeys.add(key); // évite aussi les doublons ENTRE eux si core.targets/haStackTargets se recoupent
        suggestions.push({
          id: `gossip-${deploymentDir}-${suggestions.length}-${Date.now().toString(36)}`,
          site, machine, host, deploymentDir, deploymentType: 'docker', unitName, destinationPath
        });
      };

      for (const t of reply.targets) {
        const deploymentDir = t.remoteDir.split('/').filter(Boolean).pop() || t.remoteDir;
        tryAdd(t.host, deploymentDir, deploymentDir, t.remoteDir, t.id, t.site || '');
      }

      for (const t of reply.haStackTargets) {
        // remoteDir = dossier PARENT (/docker) — HA vit dans <remoteDir>/homeassistant, voir
        // haStackTargetSchema côté core.
        const destinationPath = `${t.remoteDir.replace(/\/+$/, '')}/homeassistant`;
        tryAdd(t.host, 'homeassistant', 'homeassistant', destinationPath, t.id, t.site || '');
      }

      if (suggestions.length > 0) {
        this.config = { ...this.config, targets: [...this.config.targets, ...suggestions] };
        const result = this.configProvider.savePartialConfig(this.config);
        if (!result.success) {
          this.eventBus.emitGeneric('sauvegarde:gossip:import:result', { success: false, addedCount: 0, error: result.error });
          return;
        }
        // ⭐ savePartialConfig (ConfigService) écrit sur disque mais NE PRÉVIENT PAS le navigateur
        // (contrairement au flux normal "Sauvegarder" du formulaire, qui émet cet événement lui-même)
        // — sans ça, une page Paramètres Techniques déjà ouverte reste périmée jusqu'à rechargement.
        // Bug réel constaté en direct : import fait, rien de visible côté formulaire tant qu'on ne
        // rafraîchissait pas la page à la main.
        this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
      }

      this.eventBus.emitGeneric('sauvegarde:gossip:import:result', { success: true, addedCount: suggestions.length });
      this.emitStatus();
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:gossip:import:result', {
        success: false,
        addedCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Point d'entrée UI pour écrire le mot de passe d'application Nextcloud sur une machine déjà
   * connue, sans passer par un terminal — voir SecretPushService. `appPassword` ne transite par
   * aucune écriture de config ici, seulement par SSH (stdin) vers le fichier hôte cible.
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
      const result = await this.secretPushService.push(target, this.config.nextcloud.appPasswordFile, appPassword);
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', { targetId, ...result });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', {
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
