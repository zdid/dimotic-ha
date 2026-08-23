/**
 * HaStackDeployService — déploiement d'un stack Home Assistant + Mosquitto sur une machine
 * distante (⭐ nouveau 24/08/2026, demande explicite pour équiper un nouveau site/foyer).
 *
 * Service dédié, pas une extension de `CoreDeployService` : le compose est généré dynamiquement
 * (pas de fichier statique dans le dépôt, contrairement à `compose.deploy.yaml`) et il n'y a pas de
 * healthcheck simple comme pour dimotic-ha (`docker inspect --format {{.State.Health.Status}}` —
 * l'image officielle Home Assistant n'en déclare pas). `start`/`stop`/`restart` passent par
 * `docker compose {action}` (les 2 conteneurs du même projet ensemble), pas par
 * `DockerContainerController` (pensé pour UNE unité nommée isolée, pas un projet compose à 2
 * services).
 *
 * Réutilise les primitives SSH/SCP du socle (`infrastructure/remote/SshClient.ts`) — import
 * relatif direct, `core` étant lui-même la source de ce module.
 */

import * as yaml from 'js-yaml';
import { runSsh, shellQuote, ensureSshKey } from '../infrastructure/remote/SshClient';
import type { RemoteOpResult } from '../infrastructure/remote/SshClient';
import type { HaStackTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

export interface DeployResult {
  success: boolean;
  step?: 'mkdir' | 'write-compose' | 'write-mosquitto-conf' | 'pull-up';
  error?: string;
  output?: string;
}

const APP_ID = 'core';
const MOSQUITTO_IMAGE = 'eclipse-mosquitto:latest';

/** Résout le chemin de clé effectif (génère la clé si absente) avant toute opération SSH — voir
 *  ensureSshKey (core/infrastructure/remote/SshClient.ts). Même espace de noms que les cibles
 *  dimotic-ha (`data/core/ssh/<id>/`) — voir le commentaire de haStackTargetSchema. */
function resolveTarget(target: HaStackTargetConfig): HaStackTargetConfig {
  return { ...target, sshKeyPath: ensureSshKey(APP_ID, target.id, target.sshKeyPath) };
}

function buildComposeYaml(haVersion: string | undefined): string {
  const doc = {
    services: {
      homeassistant: {
        image: `homeassistant/home-assistant:${haVersion?.trim() || 'latest'}`,
        container_name: 'homeassistant',
        restart: 'unless-stopped',
        network_mode: 'host',
        volumes: ['./homeassistant:/config'],
        environment: ['TZ=Europe/Paris']
      },
      mosquitto: {
        image: MOSQUITTO_IMAGE,
        container_name: 'mosquitto',
        restart: 'unless-stopped',
        ports: ['1883:1883'],
        volumes: [
          './mosquitto/config:/mosquitto/config',
          './mosquitto/data:/mosquitto/data',
          './mosquitto/log:/mosquitto/log'
        ]
      }
    }
  };
  return yaml.dump(doc, { indent: 2, sortKeys: false });
}

/**
 * Config minimale sans authentification (décision explicite de l'utilisateur — LAN de confiance,
 * cohérent avec la posture de sécurité déjà acceptée partout ailleurs dans ce projet). Sans elle,
 * l'image Mosquitto par défaut ne répond qu'en local (localhost), inutilisable depuis dimotic-ha
 * sur une autre machine.
 */
function buildMosquittoConf(): string {
  return [
    'listener 1883 0.0.0.0',
    'allow_anonymous true',
    'persistence true',
    'persistence_location /mosquitto/data/',
    'log_dest file /mosquitto/log/mosquitto.log',
    ''
  ].join('\n');
}

export class HaStackDeployService {
  constructor(private readonly logger: Logger) {}

  start(target: HaStackTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'start');
  }

  stop(target: HaStackTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'stop');
  }

  restart(target: HaStackTargetConfig): Promise<RemoteOpResult> {
    return this.composeAction(target, 'restart');
  }

  private async composeAction(rawTarget: HaStackTargetConfig, action: 'start' | 'stop' | 'restart'): Promise<RemoteOpResult> {
    const target = resolveTarget(rawTarget);
    const result = await runSsh(target, `cd ${shellQuote(target.remoteDir)} && docker compose ${action}`);
    return { success: result.success, step: action, error: result.error, output: result.output };
  }

  /**
   * Écrit `remoteDir/compose.yaml` (généré en mémoire — pas de fichier statique) et
   * `remoteDir/mosquitto/config/mosquitto.conf` UNIQUEMENT s'il est absent (jamais écrasé — un
   * utilisateur pourrait avoir personnalisé la config Mosquitto entre-temps), puis
   * `docker compose pull && up -d`. Pas d'attente "healthy" (pas de HEALTHCHECK simple côté HA).
   */
  async deploy(rawTarget: HaStackTargetConfig, haVersion?: string): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'mkdir', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);

    const mkdir = await runSsh(target, `mkdir -p ${shellQuote(target.remoteDir)}`);
    if (!mkdir.success) {
      this.logger.error('HaStackDeployService', `Échec de création de ${target.remoteDir} sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const composeYaml = buildComposeYaml(haVersion);
    const writeCompose = await runSsh(target, `tee ${shellQuote(target.remoteDir + '/compose.yaml')} > /dev/null`, composeYaml);
    if (!writeCompose.success) {
      this.logger.error('HaStackDeployService', `Échec d'écriture de compose.yaml sur ${target.host}: ${writeCompose.error}`);
      return { success: false, step: 'write-compose', error: writeCompose.error };
    }

    const mosquittoConfPath = `${target.remoteDir}/mosquitto/config/mosquitto.conf`;
    const exists = await runSsh(target, `test -f ${shellQuote(mosquittoConfPath)} && echo present`);
    if (exists.output.trim() !== 'present') {
      const writeConf = await runSsh(
        target,
        `mkdir -p ${shellQuote(target.remoteDir + '/mosquitto/config')} && tee ${shellQuote(mosquittoConfPath)} > /dev/null`,
        buildMosquittoConf()
      );
      if (!writeConf.success) {
        this.logger.error('HaStackDeployService', `Échec d'écriture de mosquitto.conf sur ${target.host}: ${writeConf.error}`);
        return { success: false, step: 'write-mosquitto-conf', error: writeConf.error };
      }
    } else {
      this.logger.info('HaStackDeployService', `mosquitto.conf déjà présent sur ${target.host}, non écrasé`);
    }

    const pullUp = await runSsh(target, `cd ${shellQuote(target.remoteDir)} && docker compose pull && docker compose up -d`);
    if (!pullUp.success) {
      this.logger.error('HaStackDeployService', `Échec de docker compose pull/up sur ${target.host}: ${pullUp.error}`);
      return { success: false, step: 'pull-up', error: pullUp.error, output: pullUp.output };
    }

    this.logger.info('HaStackDeployService', `Home Assistant + Mosquitto déployés sur ${target.host} (${target.id})`);
    return { success: true, step: 'pull-up', output: pullUp.output.trim() };
  }
}
