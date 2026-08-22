/**
 * Déploiement vers la machine cible — SSH (écriture via `sudo tee`, pas de scp) puis
 * `docker compose up -d` (crée le conteneur au premier déploiement, ne fait rien si sa définition
 * n'a pas changé) + `docker restart` (fait relire config.yml, jamais fait automatiquement par
 * compose sur un simple changement de contenu d'un fichier bind-monté). Mêmes conventions que
 * docker/rebuild-and-deploy.sh (utilisateur dédié, clé SSH par fichier, sudo NOPASSWD déjà en
 * place sur ha2/orangepi) — mais invoqué depuis l'app plutôt qu'un script shell externe, pour être
 * déclenchable depuis l'IHM (demande utilisateur, 12/08/2026).
 *
 * `runSsh`/`shellQuote`/`DockerContainerController` viennent du socle (`core/infrastructure/remote`,
 * 22/08/2026) — mutualisés avec teleinfo, qui réimplémentait des primitives quasi identiques.
 * `start`/`stop`/`restart` délèguent déjà au contrôleur Docker partagé, prêts pour de futurs
 * boutons dans l'IHM (pas encore câblés sur Socket.io, voir fonctionnelles-rpigpio_specs).
 */

import {
  runSsh,
  shellQuote,
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

const unitController = new DockerContainerController({ useSudo: true });

export class DeployService {
  constructor(private readonly logger: Logger) {}

  /** Démarre le conteneur sur la machine cible (docker start, via sudo — voir docker/rebuild-and-deploy.sh). */
  start(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.start(target, target.containerName);
  }

  /** Arrête le conteneur sur la machine cible (docker stop). */
  stop(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.stop(target, target.containerName);
  }

  /** Redémarre le conteneur sur la machine cible (docker restart) sans réappliquer la config. */
  restart(target: RpigpioTargetConfig): Promise<RemoteOpResult> {
    return unitController.restart(target, target.containerName);
  }

  /** Écrit un fichier sur la machine cible (sudo tee, écrase l'existant, crée le répertoire au besoin). */
  private async writeRemoteFile(target: RpigpioTargetConfig, remotePath: string, content: string): Promise<DeployResult> {
    const dir = shellQuote(remotePath.substring(0, remotePath.lastIndexOf('/')) || '.');
    const mkdirAndWrite = `sudo mkdir -p ${dir} && sudo tee ${shellQuote(remotePath)} > /dev/null`;
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
  async deploy(target: RpigpioTargetConfig, mqttIoConfigYaml: string, composeYaml: string): Promise<DeployResult> {
    if (!target.host) {
      return { success: false, step: 'write-config', error: 'Aucun hôte cible configuré (target.host)' };
    }

    const configPath = `${target.hostDir}/config.yml`;
    const composePath = `${target.hostDir}/compose.yaml`;

    const writeConfig = await this.writeRemoteFile(target, configPath, mqttIoConfigYaml);
    if (!writeConfig.success) return { ...writeConfig, step: 'write-config' };

    const writeCompose = await this.writeRemoteFile(target, composePath, composeYaml);
    if (!writeCompose.success) return { ...writeCompose, step: 'write-compose' };

    const composeUp = await runSsh(target, `cd ${shellQuote(target.hostDir)} && sudo docker compose up -d`);
    if (!composeUp.success) {
      this.logger.error('DeployService', `Échec de docker compose up sur ${target.host}: ${composeUp.error}`);
      return { success: false, step: 'compose-up', error: composeUp.error, output: composeUp.output };
    }

    const restart = await runSsh(target, `sudo docker restart ${shellQuote(target.containerName)} && sleep 2 && sudo docker inspect ${shellQuote(target.containerName)} --format '{{.State.Status}}'`);
    if (!restart.success) {
      this.logger.error('DeployService', `Échec de redémarrage de ${target.containerName} sur ${target.host}: ${restart.error}`);
      return { success: false, step: 'restart', error: restart.error, output: restart.output };
    }

    this.logger.info('DeployService', `${target.containerName} déployé et redémarré sur ${target.host} (statut: ${restart.output.trim()})`);
    return { success: true, step: 'restart', output: restart.output.trim() };
  }
}
