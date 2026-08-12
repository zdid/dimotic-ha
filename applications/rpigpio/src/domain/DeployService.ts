/**
 * Déploiement vers la machine cible — SSH (écriture via `sudo tee`, pas de scp) puis
 * `docker compose up -d` (crée le conteneur au premier déploiement, ne fait rien si sa définition
 * n'a pas changé) + `docker restart` (fait relire config.yml, jamais fait automatiquement par
 * compose sur un simple changement de contenu d'un fichier bind-monté). Mêmes conventions que
 * docker/rebuild-and-deploy.sh (utilisateur dédié, clé SSH par fichier, sudo NOPASSWD déjà en
 * place sur ha2/orangepi) — mais invoqué depuis l'app plutôt qu'un script shell externe, pour être
 * déclenchable depuis l'IHM (demande utilisateur, 12/08/2026).
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { Logger } from '../../../core/dist/exports';
import type { RpigpioTargetConfig } from './config-schema';

export interface DeployResult {
  success: boolean;
  step?: 'write-config' | 'write-compose' | 'compose-up' | 'restart';
  error?: string;
  output?: string;
}

const SSH_TIMEOUT_MS = 30000;

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

/** Exécute une commande distante via SSH, avec un contenu optionnel envoyé sur stdin. */
function runSsh(
  target: RpigpioTargetConfig,
  remoteCommand: string,
  stdin?: string
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes'
    ];
    if (target.sshKeyPath) {
      args.push('-i', expandHome(target.sshKeyPath));
    }
    args.push(`${target.sshUser}@${target.host}`, remoteCommand);

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, output: stdout, error: `Timeout après ${SSH_TIMEOUT_MS}ms` });
    }, SSH_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: stdout, error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `ssh a quitté avec le code ${code}` });
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/** Échappement simple pour un argument shell distant (chemins/noms, pas de saisie libre). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class DeployService {
  constructor(private readonly logger: Logger) {}

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
