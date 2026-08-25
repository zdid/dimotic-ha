/**
 * Zigbee2mqttDeployService — déploiement de zigbee2mqtt (image officielle `koenkk/zigbee2mqtt`)
 * sur une machine distante (⭐ nouveau 24/08/2026). Liste de cibles SÉPARÉE de `haStackTargets` —
 * décision explicite de l'utilisateur : un dongle USB Zigbee peut être branché sur une machine
 * différente de celle qui héberge HA+Mosquitto (même principe que RFXCOM : matériel physique = sa
 * propre cible).
 *
 * Même patron que `HaStackDeployService.ts` (compose généré en mémoire, pas de fichier statique
 * dans le dépôt), adapté : un seul service (pas deux projets isolés comme HA/Mosquitto), et
 * passthrough du device USB du dongle (`devices: ['<port>:<port>']` — approche officiellement
 * recommandée par zigbee2mqtt lui-même, plus légère que `privileged: true` utilisé par rpigpio
 * pour GPIO : ici un simple device série, pas un accès mémoire).
 *
 * Réutilise les primitives SSH/SCP du socle (`infrastructure/remote/SshClient.ts`) — import
 * relatif direct, `core` étant lui-même la source de ce module.
 */

import * as yaml from 'js-yaml';
import { runSsh, runSshStreaming, shellQuote, ensureGlobalSshKey } from '../infrastructure/remote/SshClient';
import type { RemoteOpResult } from '../infrastructure/remote/SshClient';
import type { Zigbee2mqttTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

export interface DeployResult {
  success: boolean;
  step?: 'mkdir' | 'write-compose' | 'write-configuration' | 'pull-up';
  error?: string;
  output?: string;
}

const ZIGBEE2MQTT_IMAGE = 'koenkk/zigbee2mqtt';
const DATA_SUBDIR = 'data';

/** Attache la clé SSH unique de l'installation (générée si absente) avant toute opération SSH —
 *  voir ensureGlobalSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: Zigbee2mqttTargetConfig): Zigbee2mqttTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

function buildComposeYaml(target: Zigbee2mqttTargetConfig, version: string | undefined): string {
  const doc = {
    services: {
      zigbee2mqtt: {
        image: `${ZIGBEE2MQTT_IMAGE}:${version?.trim() || 'latest'}`,
        container_name: 'zigbee2mqtt',
        restart: 'unless-stopped',
        network_mode: 'host',
        devices: [`${target.serialPort}:${target.serialPort}`],
        volumes: [`./${DATA_SUBDIR}:/app/data`],
        environment: ['TZ=Europe/Paris']
      }
    }
  };
  return yaml.dump(doc, { indent: 2, sortKeys: false });
}

/**
 * Config minimale — connexion MQTT explicite (cette cible peut être une machine différente de
 * celle qui héberge le broker, contrairement à Mosquitto co-localisé dans HaStackDeployService),
 * frontend activé par défaut (utile pour l'appairage), `permit_join: false` par défaut (activé
 * ponctuellement par l'utilisateur depuis le frontend ou en éditant ce fichier).
 */
function buildConfigurationYaml(target: Zigbee2mqttTargetConfig): string {
  const doc = {
    mqtt: { server: `mqtt://${target.mqttHost}:${target.mqttPort}` },
    serial: { port: target.serialPort },
    frontend: { port: 8080 },
    permit_join: false
  };
  return yaml.dump(doc, { indent: 2, sortKeys: false });
}

export class Zigbee2mqttDeployService {
  constructor(private readonly logger: Logger) {}

  start(target: Zigbee2mqttTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'start');
  }

  stop(target: Zigbee2mqttTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'stop');
  }

  restart(target: Zigbee2mqttTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'restart');
  }

  private async composeAction(rawTarget: Zigbee2mqttTargetConfig, action: 'start' | 'stop' | 'restart'): Promise<RemoteOpResult> {
    const target = resolveTarget(rawTarget);
    return runSsh(target, `cd ${shellQuote(target.remoteDir)} && docker compose ${action}`);
  }

  /**
   * Écrit `<remoteDir>/compose.yaml` (toujours régénéré) et `<remoteDir>/data/configuration.yaml`
   * UNIQUEMENT s'il est absent (jamais écrasé — l'utilisateur peut avoir modifié la config entre
   * temps, ex: `permit_join` activé temporairement pour appairer), puis `docker compose pull &&
   * up -d`. `onProgress` (⭐ 24/08/2026) : ligne de progression pendant le pull-up, voir
   * runSshStreaming (SshClient.ts) pour le timeout adaptatif par inactivité.
   */
  async deploy(rawTarget: Zigbee2mqttTargetConfig, version?: string, onProgress?: (line: string) => void): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'mkdir', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);
    const dataDir = `${target.remoteDir}/${DATA_SUBDIR}`;

    const mkdir = await runSsh(target, `mkdir -p ${shellQuote(dataDir)}`);
    if (!mkdir.success) {
      this.logger.error('Zigbee2mqttDeployService', `Échec de création de ${dataDir} sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const writeCompose = await runSsh(target, `tee ${shellQuote(target.remoteDir + '/compose.yaml')} > /dev/null`, buildComposeYaml(target, version));
    if (!writeCompose.success) {
      this.logger.error('Zigbee2mqttDeployService', `Échec d'écriture de compose.yaml sur ${target.host}: ${writeCompose.error}`);
      return { success: false, step: 'write-compose', error: writeCompose.error };
    }

    const configPath = `${dataDir}/configuration.yaml`;
    const exists = await runSsh(target, `test -f ${shellQuote(configPath)} && echo present`);
    if (exists.output.trim() !== 'present') {
      const writeConfig = await runSsh(target, `tee ${shellQuote(configPath)} > /dev/null`, buildConfigurationYaml(target));
      if (!writeConfig.success) {
        this.logger.error('Zigbee2mqttDeployService', `Échec d'écriture de configuration.yaml sur ${target.host}: ${writeConfig.error}`);
        return { success: false, step: 'write-configuration', error: writeConfig.error };
      }
    } else {
      this.logger.info('Zigbee2mqttDeployService', `configuration.yaml déjà présent sur ${target.host}, non écrasé`);
    }

    const pullUp = await runSshStreaming(target, `cd ${shellQuote(target.remoteDir)} && docker compose pull && docker compose up -d`, { onData: onProgress });
    if (!pullUp.success) {
      this.logger.error('Zigbee2mqttDeployService', `Échec de docker compose pull/up sur ${target.host}: ${pullUp.error}`);
      return { success: false, step: 'pull-up', error: pullUp.error, output: pullUp.output };
    }

    this.logger.info('Zigbee2mqttDeployService', `zigbee2mqtt déployé sur ${target.host} (${target.id})`);
    return { success: true, step: 'pull-up', output: pullUp.output.trim() };
  }
}
