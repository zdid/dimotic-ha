/**
 * CoreDeployService — déploiement de dimotic-ha lui-même sur une machine distante (⭐ 23/08/2026),
 * en remplacement de docker/rebuild-and-deploy.sh (qui ne gérait que la mise à jour d'une machine
 * déjà provisionnée — aucune copie de compose.yaml, aucune création de data/core/config.yaml).
 *
 * Même patron que les DeployService des applications (rpigpio/teleinfo/arexx) : réutilise les
 * primitives SSH/SCP + le contrôleur Docker du socle (`infrastructure/remote/`) — import relatif
 * direct, `core` étant lui-même la source de ce module.
 *
 * Hors périmètre volontairement : le build multi-arch + push Docker Hub (étape 1 de
 * rebuild-and-deploy.sh) reste une opération manuelle/scriptée à part, pas une action par cible —
 * `deploy()` suppose que le tag `:latest` existe déjà sur Docker Hub.
 */

import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runSsh, runSshStreaming, runScp, shellQuote, ensureGlobalSshKey, type RemoteOpResult } from '../infrastructure/remote/SshClient';
import { DockerContainerController, type RemoteUnitController } from '../infrastructure/remote/RemoteUnitController';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { ApplicationManager } from './ApplicationManager';
import type { DeploymentTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

export interface DeployResult {
  success: boolean;
  step?: 'ha-ws-check' | 'mkdir' | 'copy-compose' | 'seed-config' | 'pull-up' | 'health-check' | 'push-config' | 'restart';
  error?: string;
  output?: string;
}

const CONTAINER_NAME = 'dimotic-ha';
const HEALTH_CHECK_ATTEMPTS = 30;
const HEALTH_CHECK_INTERVAL_MS = 3000;

/** Attache la clé SSH unique de l'installation (générée si absente) avant toute opération SSH —
 *  voir ensureGlobalSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: DeploymentTargetConfig): DeploymentTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

/**
 * `compose.deploy.yaml`, PAS `compose.yaml` — ce dernier reste réservé à la machine de
 * développement (`build: .`, image locale). `compose.deploy.yaml` tire l'image uniquement depuis
 * Docker Hub (`zdid2/dimotic-ha:latest`), sans code source ni Dockerfile requis sur la cible — voir
 * techniques-socle-ha-mqtt_specs §11.4. Copié puis renommé en `compose.yaml` sur la cible (scp ne
 * renomme pas, `docker compose` cherche `compose.yaml` par convention).
 */
function composeDeployYamlPath(): string {
  return path.join(process.env.PROJECT_ROOT || process.cwd(), 'compose.deploy.yaml');
}

export class CoreDeployService {
  private readonly unitController: RemoteUnitController = new DockerContainerController();

  constructor(
    private readonly configService: ConfigService,
    private readonly applicationManager: ApplicationManager,
    private readonly logger: Logger
  ) {}

  start(target: DeploymentTargetConfig): Promise<RemoteOpResult> {
    return this.unitController.start(resolveTarget(target), CONTAINER_NAME);
  }

  stop(target: DeploymentTargetConfig): Promise<RemoteOpResult> {
    return this.unitController.stop(resolveTarget(target), CONTAINER_NAME);
  }

  restart(target: DeploymentTargetConfig): Promise<RemoteOpResult> {
    return this.unitController.restart(resolveTarget(target), CONTAINER_NAME);
  }

  /**
   * Copie compose.deploy.yaml (renommé compose.yaml sur la cible), sème data/core/config.yaml
   * UNIQUEMENT s'il est absent (jamais écrasé sur une cible déjà provisionnée — même principe que
   * target.txt/DriversBundle côté AREXX), puis `docker compose pull && up -d` et attend "healthy".
   *
   * `version` (⭐ 24/08/2026) : tag Docker Hub à déployer (ex: "2.1.0") — vide/absent = `latest`.
   * `compose.deploy.yaml` référence `zdid2/dimotic-ha:${DIMOTIC_TAG:-latest}` (interpolation Docker
   * Compose) : la variable est injectée sur `pull` ET `up -d` (compose relit le fichier à chaque
   * invocation, les deux doivent voir la même valeur).
   */
  /** `onProgress` (⭐ 24/08/2026) : appelé pour chaque ligne de progression pendant l'étape
   *  pull-up (voir runSshStreaming, SshClient.ts) — timeout adaptatif par inactivité plutôt qu'un
   *  timeout fixe, s'adapte naturellement au matériel de la cible (RPi3 lent vs RPi5). */
  async deploy(rawTarget: DeploymentTargetConfig, version?: string, onProgress?: (line: string) => void): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'mkdir', error: 'Aucun hôte cible configuré (target.host)' };
    }

    // seedConfigIfAbsent() copie ha.ws tel quel (voir plus bas) — refuser de propager un HA WS
    // voulu (ws_enable) mais sans token utilisable évite de reproduire sur la nouvelle machine le
    // même échec ("Invalid HA token") que celui déjà constaté ici (⭐ 24/08/2026, demande
    // explicite, suite à l'incident réel du déploiement sur ha2 le 24/08/2026). ws_enable=false :
    // HA WS n'est simplement pas utilisé, rien à bloquer.
    const haWs = this.configService.getHaWsConfig();
    const haConfig = this.configService.getHaConfig();
    if (haConfig?.ws_enable && !haWs?.token) {
      return {
        success: false,
        step: 'ha-ws-check',
        error: "HA WebSocket est activé (ws_enable) sur cette machine mais sans token valide — configurez-le d'abord (ou désactivez HA WS) avant de déployer sur une nouvelle machine, pour ne pas y propager un accès HA cassé."
      };
    }

    const target = resolveTarget(rawTarget);
    const tag = version?.trim() || 'latest';

    // `logs/` et `data/` sont bind-montés dans le conteneur, qui tourne en `USER node` (uid/gid
    // 1000, image officielle node:*-bookworm-slim — voir Dockerfile) — créés ici en root via SSH,
    // ils doivent être chownés pour rester inscriptibles par ce user, sinon le conteneur crashe en
    // boucle (EACCES sur logs/app.log.*, bug réel constaté au premier déploiement réel sur ha2,
    // ⭐ 24/08/2026). `compose.yaml` lui-même reste root : jamais lu depuis l'intérieur du conteneur.
    const mkdir = await runSsh(
      target,
      `mkdir -p ${shellQuote(target.remoteDir)} ${shellQuote(target.remoteDir + '/logs')} ${shellQuote(target.remoteDir + '/data')} && chown -R 1000:1000 ${shellQuote(target.remoteDir + '/logs')} ${shellQuote(target.remoteDir + '/data')}`
    );
    if (!mkdir.success) {
      this.logger.error('CoreDeployService', `Échec de création de ${target.remoteDir} sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const copyCompose = await runScp(target, [composeDeployYamlPath()], target.remoteDir);
    if (!copyCompose.success) {
      this.logger.error('CoreDeployService', `Échec de copie de compose.deploy.yaml sur ${target.host}: ${copyCompose.error}`);
      return { success: false, step: 'copy-compose', error: copyCompose.error };
    }

    const rename = await runSsh(target, `mv -f ${shellQuote(target.remoteDir + '/compose.deploy.yaml')} ${shellQuote(target.remoteDir + '/compose.yaml')}`);
    if (!rename.success) {
      this.logger.error('CoreDeployService', `Échec de renommage de compose.deploy.yaml sur ${target.host}: ${rename.error}`);
      return { success: false, step: 'copy-compose', error: rename.error };
    }

    const seedResult = await this.seedConfigIfAbsent(target);
    if (!seedResult.success) return seedResult;

    // seedConfigIfAbsent() écrit via `tee` en root (nouveau sous-dossier data/core/) — re-chown
    // après coup, le premier passage (avant cette étape) ne couvre pas ce qui vient d'être créé.
    const rechown = await runSsh(target, `chown -R 1000:1000 ${shellQuote(target.remoteDir + '/data')}`);
    if (!rechown.success) {
      this.logger.error('CoreDeployService', `Échec de chown de ${target.remoteDir}/data sur ${target.host}: ${rechown.error}`);
      return { success: false, step: 'seed-config', error: rechown.error };
    }

    const envPrefix = `DIMOTIC_TAG=${shellQuote(tag)}`;
    const pullUp = await runSshStreaming(target, `cd ${shellQuote(target.remoteDir)} && ${envPrefix} docker compose pull && ${envPrefix} docker compose up -d`, { onData: onProgress });
    if (!pullUp.success) {
      this.logger.error('CoreDeployService', `Échec de docker compose pull/up sur ${target.host}: ${pullUp.error}`);
      return { success: false, step: 'pull-up', error: pullUp.error, output: pullUp.output };
    }

    return this.waitHealthy(target);
  }

  /**
   * N'écrit data/core/config.yaml QUE s'il est absent — sème les vraies valeurs HA/MQTT/web/
   * logging de CETTE machine (identiques pour tout le foyer, décision explicite de l'utilisateur),
   * sans `core.machineId` (chaque machine garde le sien, défaut `os.hostname()`) ni `targets`
   * (chaque instance gère sa propre liste de cibles, ne hérite pas de celle de la machine
   * déployante). `disabledApps` forcé à TOUTES les applications connues sauf core — l'admin de la
   * machine cible active ensuite ce qu'il veut localement, via sa propre IHM.
   */
  private async seedConfigIfAbsent(target: DeploymentTargetConfig): Promise<DeployResult> {
    const remoteConfigPath = `${target.remoteDir}/data/core/config.yaml`;
    const exists = await runSsh(target, `test -f ${shellQuote(remoteConfigPath)} && echo present`);
    if (exists.output.trim() === 'present') {
      this.logger.info('CoreDeployService', `data/core/config.yaml déjà présent sur ${target.host}, non écrasé`);
      return { success: true, step: 'seed-config' };
    }

    const current = this.configService.getConfig();
    const { activated, disabled } = this.applicationManager.listAll();
    const seeded = {
      ha: current.ha,
      web: current.web,
      logging: current.logging,
      disabledApps: [...activated, ...disabled],
      targets: []
    };
    const seededYaml = yaml.dump(seeded, { indent: 2, sortKeys: false });

    const write = await runSsh(
      target,
      `mkdir -p ${shellQuote(target.remoteDir + '/data/core')} && tee ${shellQuote(remoteConfigPath)} > /dev/null`,
      seededYaml
    );
    if (!write.success) {
      this.logger.error('CoreDeployService', `Échec d'écriture de data/core/config.yaml sur ${target.host}: ${write.error}`);
      return { success: false, step: 'seed-config', error: write.error };
    }

    this.logger.info('CoreDeployService', `data/core/config.yaml semé sur ${target.host} (${seeded.disabledApps.length} application(s) désactivée(s) par défaut)`);
    return { success: true, step: 'seed-config' };
  }

  /**
   * Diffuse UNIQUEMENT la section `ha` (WebSocket + MQTT, section partagée par tout le foyer)
   * vers une machine DÉJÀ déployée, sans y republier ni redémarrer via `docker compose up` — juste
   * réécrire `data/core/config.yaml` puis redémarrer (⭐ 24/08/2026, demande explicite :
   * re-synchroniser des installations existantes après un changement local, ex. un token HA WS
   * régénéré, sans repasser par un déploiement complet).
   *
   * Périmètre volontairement restreint à `ha` seul (pas `web`/`logging`/`disabledApps`) — décision
   * explicite après avoir constaté en vérifiant ha2 avant un premier essai que diffuser
   * `disabledApps` y aurait activé RFXCOM/AREXX/etc. dans le conteneur dimotic-ha, alors que ces
   * applications y tournent déjà en production via l'ancien système, hors dimotic-ha : quelles
   * applications sont activées reste une décision propre à chaque machine, jamais écrasée par une
   * diffusion de config. Lit d'abord le fichier distant pour PRÉSERVER tout le reste (`web`/
   * `logging`/`disabledApps`/`targets`/`haStackTargets`/`core.machineId`/sections par application,
   * déjà en place sur la cible) — un remplacement intégral du fichier les perdrait.
   */
  async pushConfig(rawTarget: DeploymentTargetConfig): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'push-config', error: 'Aucun hôte cible configuré (target.host)' };
    }

    const target = resolveTarget(rawTarget);
    const remoteConfigPath = `${target.remoteDir}/data/core/config.yaml`;

    const read = await runSsh(target, `cat ${shellQuote(remoteConfigPath)}`);
    if (!read.success || !read.output.trim()) {
      return {
        success: false,
        step: 'push-config',
        error: `Impossible de lire ${remoteConfigPath} sur ${target.host} (${read.error || 'fichier absent ou vide'}) — la machine doit déjà avoir été déployée au moins une fois avant de pouvoir y diffuser la config seule.`
      };
    }

    let remoteConfig: Record<string, unknown>;
    try {
      remoteConfig = (yaml.load(read.output) as Record<string, unknown>) || {};
    } catch (error) {
      return { success: false, step: 'push-config', error: `Config distante illisible (YAML invalide): ${error instanceof Error ? error.message : String(error)}` };
    }

    const current = this.configService.getConfig();
    const merged = {
      ...remoteConfig,
      ha: current.ha
    };
    const mergedYaml = yaml.dump(merged, { indent: 2, sortKeys: false });

    const write = await runSsh(target, `tee ${shellQuote(remoteConfigPath)} > /dev/null`, mergedYaml);
    if (!write.success) {
      this.logger.error('CoreDeployService', `Échec de diffusion de la config sur ${target.host}: ${write.error}`);
      return { success: false, step: 'push-config', error: write.error };
    }
    this.logger.info('CoreDeployService', `Section ha (WebSocket + MQTT) diffusée vers ${target.host}, reste du fichier préservé`);

    const restart = await this.unitController.restart(target, CONTAINER_NAME);
    if (!restart.success) {
      return { success: false, step: 'restart', error: restart.error };
    }
    return { success: true, step: 'restart', output: restart.output };
  }

  private async waitHealthy(target: DeploymentTargetConfig): Promise<DeployResult> {
    for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt++) {
      const inspect = await runSsh(target, `docker inspect ${shellQuote(CONTAINER_NAME)} --format '{{.State.Health.Status}}'`);
      const status = inspect.output.trim();
      if (status === 'healthy') {
        this.logger.info('CoreDeployService', `${target.host} : conteneur healthy`);
        return { success: true, step: 'health-check', output: status };
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }
    this.logger.warn('CoreDeployService', `${target.host} : conteneur pas 'healthy' après ${HEALTH_CHECK_ATTEMPTS * HEALTH_CHECK_INTERVAL_MS / 1000}s`);
    return { success: false, step: 'health-check', error: `Pas 'healthy' après ${HEALTH_CHECK_ATTEMPTS * HEALTH_CHECK_INTERVAL_MS / 1000}s` };
  }
}
