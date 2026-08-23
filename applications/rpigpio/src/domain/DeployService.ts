/**
 * Déploiement vers la machine cible — SSH (écriture via `tee`, pas de scp) puis
 * `docker compose up -d` (crée le conteneur au premier déploiement, ne fait rien si sa définition
 * n'a pas changé) + `docker restart` (fait relire config.yml, jamais fait automatiquement par
 * compose sur un simple changement de contenu d'un fichier bind-monté).
 *
 * `runSsh`/`shellQuote`/`DockerContainerController` viennent du socle (`core/infrastructure/remote`,
 * 22/08/2026) — mutualisés avec teleinfo, qui réimplémentait des primitives quasi identiques.
 * `start`/`stop`/`restart` délèguent déjà au contrôleur Docker partagé, prêts pour de futurs
 * boutons dans l'IHM (pas encore câblés sur Socket.io, voir fonctionnelles-rpigpio_specs).
 *
 * Toutes les commandes distantes s'exécutent en root direct (⭐ 23/08/2026, plus de `sudo` — voir
 * le commentaire d'en-tête de `core/infrastructure/remote/SshClient.ts` pour le raisonnement).
 */

import {
  runSsh,
  shellQuote,
  ensureSshKey,
  DockerContainerController,
  type Logger,
  type RemoteOpResult,
} from '../../../core/dist/exports';
import type { RpigpioTargetConfig } from './config-schema';

export interface DeployResult {
  success: boolean;
  step?: 'write-config' | 'write-compose' | 'compose-up' | 'restart';
  error?: string;
  output?: string;
}

const APP_ID = 'rpigpio';
const unitController = new DockerContainerController();

/** Résout le chemin de clé effectif (génère la clé si absente) avant toute opération SSH — voir
 *  ensureSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: RpigpioTargetConfig): RpigpioTargetConfig {
  return { ...target, sshKeyPath: ensureSshKey(APP_ID, target.id, target.sshKeyPath) };
}

export class DeployService {
  constructor(private readonly logger: Logger) {}

  /** Démarre le conteneur sur la machine cible (docker start). */
  start(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.start(resolveTarget(target), target.containerName);
  }

  /** Arrête le conteneur sur la machine cible (docker stop). */
  stop(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.stop(resolveTarget(target), target.containerName);
  }

  /** Redémarre le conteneur sur la machine cible (docker restart) sans réappliquer la config. */
  restart(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.restart(resolveTarget(target), target.containerName);
  }

  /** Écrit un fichier sur la machine cible (tee, écrase l'existant, crée le répertoire au besoin). */
  private async writeRemoteFile(target: RpigpioTargetConfig, remotePath: string, content: string): Promise<DeployResult> {
    const dir = shellQuote(remotePath.substring(0, remotePath.lastIndexOf('/')) || '.');
    const mkdirAndWrite = `mkdir -p ${dir} && tee ${shellQuote(remotePath)} > /dev/null`;
    const result = await runSsh(target, mkdirAndWrite, content);
    if (!result.success) {
      this.logger.error('DeployService', `Échec d'écriture de ${remotePath} sur ${target.host}: ${result.error}`);
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Écrit config.yml + compose.yaml dans target.hostDir, applique la définition du conteneur
   * (docker compose up -d — crée au premier déploiement, sans effet sinon) puis force un
   * redémarrage pour que le nouveau config.yml soit effectivement relu.
   */
  async deploy(rawTarget: RpigpioTargetConfig, mqttIoConfigYaml: string, composeYaml: string): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'write-config', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);

    const configPath = `${target.hostDir}/config.yml`;
    const composePath = `${target.hostDir}/compose.yaml`;

    const writeConfig = await this.writeRemoteFile(target, configPath, mqttIoConfigYaml);
    if (!writeConfig.success) return { ...writeConfig, step: 'write-config' };

    const writeCompose = await this.writeRemoteFile(target, composePath, composeYaml);
    if (!writeCompose.success) return { ...writeCompose, step: 'write-compose' };

    const composeUp = await runSsh(target, `cd ${shellQuote(target.hostDir)} && docker compose up -d`);
    if (!composeUp.success) {
      this.logger.error('DeployService', `Échec de docker compose up sur ${target.host}: ${composeUp.error}`);
      return { success: false, step: 'compose-up', error: composeUp.error, output: composeUp.output };
    }

    const restart = await runSsh(target, `docker restart ${shellQuote(target.containerName)} && sleep 2 && docker inspect ${shellQuote(target.containerName)} --format '{{.State.Status}}'`);
    if (!restart.success) {
      this.logger.error('DeployService', `Échec de redémarrage de ${target.containerName} sur ${target.host}: ${restart.error}`);
      return { success: false, step: 'restart', error: restart.error, output: restart.output };
    }

    this.logger.info('DeployService', `${target.containerName} déployé et redémarré sur ${target.host} (statut: ${restart.output.trim()})`);
    return { success: true, step: 'restart', output: restart.output.trim() };
  }
}
