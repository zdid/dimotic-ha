/**
 * HaStackDeployService — déploiement d'un stack Home Assistant + Mosquitto sur une machine
 * distante (⭐ nouveau 24/08/2026, demande explicite pour équiper un nouveau site/foyer).
 *
 * Service dédié, pas une extension de `CoreDeployService` : les compose sont générés dynamiquement
 * (pas de fichier statique dans le dépôt, contrairement à `compose.deploy.yaml`) et il n'y a pas de
 * healthcheck simple comme pour dimotic-ha (`docker inspect --format {{.State.Health.Status}}` —
 * l'image officielle Home Assistant n'en déclare pas).
 *
 * Homeassistant et Mosquitto sont deux projets Docker Compose ISOLÉS (⭐ 24/08/2026, demande
 * explicite) — chacun son propre `compose.yaml` sous un sous-dossier dédié
 * (`<remoteDir>/homeassistant/`, `<remoteDir>/mosquitto/`), pas un seul fichier à deux services.
 * Chaque logiciel peut ainsi être mis à jour/arrêté/supprimé indépendamment sans toucher à
 * l'autre — utile si un autre logiciel doit un jour rejoindre ce stack (ex: zigbee2mqtt), et
 * cohérent avec le fait que rien ne les lie techniquement (`network_mode: host` côté HA, donc pas
 * de réseau Compose partagé nécessaire pour joindre Mosquitto en `localhost:1883`).
 * `start`/`stop`/`restart` exécutent donc `docker compose {action}` deux fois (un projet après
 * l'autre), pas `DockerContainerController` (pensé pour UNE unité nommée isolée).
 *
 * Réutilise les primitives SSH/SCP du socle (`infrastructure/remote/SshClient.ts`) — import
 * relatif direct, `core` étant lui-même la source de ce module.
 */

import * as yaml from 'js-yaml';
import { runSsh, runSshStreaming, shellQuote, ensureGlobalSshKey } from '../infrastructure/remote/SshClient';
import type { RemoteOpResult } from '../infrastructure/remote/SshClient';
import type { HaStackTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

export interface DeployResult {
  success: boolean;
  step?: 'mkdir' | 'write-compose' | 'write-mosquitto-conf' | 'pull-up';
  error?: string;
  output?: string;
}

const MOSQUITTO_IMAGE = 'eclipse-mosquitto:latest';
const HA_SUBDIR = 'homeassistant';
const MOSQUITTO_SUBDIR = 'mosquitto';

/** Attache la clé SSH unique de l'installation (générée si absente) avant toute opération SSH —
 *  voir ensureGlobalSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: HaStackTargetConfig): HaStackTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

function buildHaComposeYaml(haVersion: string | undefined): string {
  const doc = {
    services: {
      homeassistant: {
        image: `homeassistant/home-assistant:${haVersion?.trim() || 'latest'}`,
        container_name: 'homeassistant',
        restart: 'unless-stopped',
        network_mode: 'host',
        volumes: ['./config:/config'],
        environment: ['TZ=Europe/Paris']
      }
    }
  };
  return yaml.dump(doc, { indent: 2, sortKeys: false });
}

function buildMosquittoComposeYaml(): string {
  const doc = {
    services: {
      mosquitto: {
        image: MOSQUITTO_IMAGE,
        container_name: 'mosquitto',
        restart: 'unless-stopped',
        ports: ['1883:1883'],
        volumes: [
          './config:/mosquitto/config',
          './data:/mosquitto/data',
          './log:/mosquitto/log'
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
 * sur une autre machine. `persistence false` (⭐ 24/08/2026, corrigé après test réel sur ha2 —
 * `persistence true` posait problème en pratique, cause exacte non creusée).
 */
function buildMosquittoConf(): string {
  return [
    'listener 1883 0.0.0.0',
    'allow_anonymous true',
    'persistence false',
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

  /** Exécute l'action sur les deux projets Compose isolés, séquentiellement (mosquitto d'abord —
   *  peu importe l'ordre réel, `network_mode: host` + localhost rend HA indépendant de l'état de
   *  Mosquitto au démarrage, mais autant démarrer le broker avant son éventuel client). */
  private async composeAction(rawTarget: HaStackTargetConfig, action: 'start' | 'stop' | 'restart'): Promise<RemoteOpResult> {
    const target = resolveTarget(rawTarget);

    const mqResult = await runSsh(target, `cd ${shellQuote(target.remoteDir + '/' + MOSQUITTO_SUBDIR)} && docker compose ${action}`);
    if (!mqResult.success) {
      return { success: false, step: action, error: `mosquitto: ${mqResult.error}`, output: mqResult.output };
    }

    const haResult = await runSsh(target, `cd ${shellQuote(target.remoteDir + '/' + HA_SUBDIR)} && docker compose ${action}`);
    if (!haResult.success) {
      return { success: false, step: action, error: `homeassistant: ${haResult.error}`, output: haResult.output };
    }

    return { success: true, step: action, output: [mqResult.output, haResult.output].filter(Boolean).join('\n') };
  }

  /**
   * Écrit `<remoteDir>/homeassistant/compose.yaml` et `<remoteDir>/mosquitto/compose.yaml`
   * (générés en mémoire — pas de fichier statique), et `<remoteDir>/mosquitto/config/mosquitto.conf`
   * UNIQUEMENT s'il est absent (jamais écrasé — un utilisateur pourrait avoir personnalisé la
   * config Mosquitto entre-temps), puis `docker compose pull && up -d` sur chaque projet. Pas
   * d'attente "healthy" (pas de HEALTHCHECK simple côté HA).
   */
  /** `onProgress` (⭐ 24/08/2026) : appelé pour chaque ligne de progression pendant les deux
   *  étapes pull-up (mosquitto puis homeassistant), préfixée pour distinguer laquelle progresse —
   *  voir runSshStreaming (SshClient.ts) pour le timeout adaptatif par inactivité. */
  async deploy(rawTarget: HaStackTargetConfig, haVersion?: string, onProgress?: (line: string) => void): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'mkdir', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);
    const haDir = `${target.remoteDir}/${HA_SUBDIR}`;
    const mqDir = `${target.remoteDir}/${MOSQUITTO_SUBDIR}`;

    // ⭐ 25/08/2026, bug réel constaté sur ha2 : sans ce chown, `./log` est auto-créé par Docker au
    // premier démarrage (bind-mount source manquant) et reste root:root — l'image mosquitto tourne
    // en uid 1883 (contrairement à `./data`, que l'entrypoint de l'image chown lui-même vers 1883,
    // usage attendu/documenté ; `./log` n'est pas concerné par ce mécanisme, cas d'usage propre à
    // buildMosquittoConf() ci-dessous). Résultat observé : mosquitto démarre quand même mais
    // n'écrit jamais mosquitto.log ("Unable to open log file... for writing"), silencieusement —
    // aucun log de connexion/déconnexion disponible pour diagnostiquer quoi que ce soit ensuite.
    // Toujours root@ (voir SshClient.ts), le chown vers un uid arbitraire ne peut pas échouer pour
    // une raison de droits ; idempotent, sûr à rejouer sur une cible déjà déployée.
    const mkdir = await runSsh(
      target,
      `mkdir -p ${shellQuote(haDir)} ${shellQuote(mqDir + '/config')} ${shellQuote(mqDir + '/log')} && chown -R 1883:1883 ${shellQuote(mqDir + '/log')}`
    );
    if (!mkdir.success) {
      this.logger.error('HaStackDeployService', `Échec de création des répertoires sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const writeHaCompose = await runSsh(target, `tee ${shellQuote(haDir + '/compose.yaml')} > /dev/null`, buildHaComposeYaml(haVersion));
    if (!writeHaCompose.success) {
      this.logger.error('HaStackDeployService', `Échec d'écriture de ${haDir}/compose.yaml sur ${target.host}: ${writeHaCompose.error}`);
      return { success: false, step: 'write-compose', error: writeHaCompose.error };
    }

    const writeMqCompose = await runSsh(target, `tee ${shellQuote(mqDir + '/compose.yaml')} > /dev/null`, buildMosquittoComposeYaml());
    if (!writeMqCompose.success) {
      this.logger.error('HaStackDeployService', `Échec d'écriture de ${mqDir}/compose.yaml sur ${target.host}: ${writeMqCompose.error}`);
      return { success: false, step: 'write-compose', error: writeMqCompose.error };
    }

    const mosquittoConfPath = `${mqDir}/config/mosquitto.conf`;
    const exists = await runSsh(target, `test -f ${shellQuote(mosquittoConfPath)} && echo present`);
    if (exists.output.trim() !== 'present') {
      const writeConf = await runSsh(target, `tee ${shellQuote(mosquittoConfPath)} > /dev/null`, buildMosquittoConf());
      if (!writeConf.success) {
        this.logger.error('HaStackDeployService', `Échec d'écriture de mosquitto.conf sur ${target.host}: ${writeConf.error}`);
        return { success: false, step: 'write-mosquitto-conf', error: writeConf.error };
      }
    } else {
      this.logger.info('HaStackDeployService', `mosquitto.conf déjà présent sur ${target.host}, non écrasé`);
    }

    const mqUp = await runSshStreaming(target, `cd ${shellQuote(mqDir)} && docker compose pull && docker compose up -d`, {
      onData: onProgress ? (line) => onProgress(`[mosquitto] ${line}`) : undefined
    });
    if (!mqUp.success) {
      this.logger.error('HaStackDeployService', `Échec de docker compose pull/up (mosquitto) sur ${target.host}: ${mqUp.error}`);
      return { success: false, step: 'pull-up', error: `mosquitto: ${mqUp.error}`, output: mqUp.output };
    }

    const haUp = await runSshStreaming(target, `cd ${shellQuote(haDir)} && docker compose pull && docker compose up -d`, {
      onData: onProgress ? (line) => onProgress(`[homeassistant] ${line}`) : undefined
    });
    if (!haUp.success) {
      this.logger.error('HaStackDeployService', `Échec de docker compose pull/up (homeassistant) sur ${target.host}: ${haUp.error}`);
      return { success: false, step: 'pull-up', error: `homeassistant: ${haUp.error}`, output: haUp.output };
    }

    this.logger.info('HaStackDeployService', `Home Assistant + Mosquitto déployés sur ${target.host} (${target.id})`);
    return { success: true, step: 'pull-up', output: [mqUp.output.trim(), haUp.output.trim()].filter(Boolean).join('\n') };
  }
}
