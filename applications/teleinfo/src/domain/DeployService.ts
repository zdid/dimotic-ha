/**
 * Déploiement de device-agent/ + config.yaml généré vers le RPi1 cible — SSH/SCP, puis service
 * systemd (pas de Docker : Node officiel n'a plus de build ARMv6, voir config-schema.ts).
 *
 * Réutilise si possible les binaires natifs déjà compilés/prouvés sur cette machine précise
 * (rpio@2.4.2, serialport@9.0.7, sous /home/domotique/node_applications/node_modules — install
 * historique de l'ancienne domotique) plutôt que de relancer une compilation native complète à
 * chaque déploiement (lente et pas garantie sur un RPi1 à 429 Mo de RAM) — repli sur `npm install`
 * uniquement si cette source n'existe pas.
 *
 * `runSsh`/`runScp`/`shellQuote`/`SystemdUnitController` viennent du socle
 * (`core/infrastructure/remote`, 22/08/2026) — mutualisés avec rpigpio, qui réimplémentait des
 * primitives quasi identiques. `start`/`stop`/`restart` délèguent déjà au contrôleur systemd
 * partagé, prêts pour de futurs boutons dans l'IHM (pas encore câblés sur Socket.io, voir
 * fonctionnelles-teleinfo_specs).
 */

import * as path from 'node:path';
import {
  runSsh,
  runScp,
  shellQuote,
  SystemdUnitController,
  type Logger,
  type RemoteOpResult,
} from '../../../core/dist/exports';
import type { TeleinfoTargetConfig } from './config-schema';

export interface DeployResult {
  success: boolean;
  step?: 'copy-agent' | 'write-config' | 'node-modules' | 'write-service' | 'restart';
  error?: string;
  output?: string;
}

const NPM_INSTALL_TIMEOUT_MS = 300000; // compilation native sur RPi1 : peut être lente
// __dirname (src/domain, ou dist/domain une fois compilé) → .. (src ou dist) → .. (teleinfo) →
// device-agent/ — vérifié par le message d'erreur obtenu en test réel le 12/08/2026 (un ".." de
// trop menait à applications/device-agent/ au lieu de applications/teleinfo/device-agent/).
const DEVICE_AGENT_LOCAL_DIR = path.join(__dirname, '..', '..', 'device-agent');

// js-yaml/argparse : pures JS, pas de compilation native, absentes du node_modules partagé de
// l'ancienne domotique (PROVEN_NODE_MODULES_PATH) — embarquées directement depuis ce dépôt plutôt
// que résolues sur la cible (voir resolveDependenciesTargeted, réservé aux modules natifs partagés).
const JS_YAML_LOCAL_PATH = path.join(__dirname, '..', '..', 'node_modules', 'js-yaml');
const ARGPARSE_LOCAL_PATH = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'argparse');
const PROVEN_NODE_MODULES_PATH = '/home/domotique/node_applications/node_modules';

// teleinfo est connecté en root sur le RPi1 (pas besoin de sudo) — contrairement à rpigpio/stfort.
const unitController = new SystemdUnitController();

export class DeployService {
  constructor(private readonly logger: Logger) {}

  /** Démarre le service systemd sur la machine cible. */
  start(target: TeleinfoTargetConfig): Promise<RemoteOpResult> {
    return unitController.start(target, target.serviceName);
  }

  /** Arrête le service systemd sur la machine cible. */
  stop(target: TeleinfoTargetConfig): Promise<RemoteOpResult> {
    return unitController.stop(target, target.serviceName);
  }

  /** Redémarre le service systemd sur la machine cible sans réappliquer la config/l'agent. */
  restart(target: TeleinfoTargetConfig): Promise<RemoteOpResult> {
    return unitController.restart(target, target.serviceName);
  }

  async deploy(target: TeleinfoTargetConfig, agentConfigYaml: string): Promise<DeployResult> {
    if (!target.host) {
      return { success: false, step: 'copy-agent', error: 'Aucun hôte cible configuré (target.host)' };
    }

    const mkdir = await runSsh(target, `mkdir -p ${shellQuote(target.remoteDir)}`);
    if (!mkdir.success) return { success: false, step: 'copy-agent', error: mkdir.error };

    const agentFiles = [
      'gpio-switch.js', 'teleinfo-reader.js', 'teleinfo-service.js',
      'ha-publisher.js', 'main.js', 'package.json'
    ].map((f) => path.join(DEVICE_AGENT_LOCAL_DIR, f));

    const copyAgent = await runScp(target, agentFiles, target.remoteDir);
    if (!copyAgent.success) {
      this.logger.error('DeployService', `Échec de copie de l'agent sur ${target.host}: ${copyAgent.error}`);
      return { success: false, step: 'copy-agent', error: copyAgent.error };
    }

    const writeConfig = await runSsh(target, `tee ${shellQuote(target.remoteDir + '/config.yaml')} > /dev/null`, agentConfigYaml);
    if (!writeConfig.success) {
      this.logger.error('DeployService', `Échec d'écriture de config.yaml sur ${target.host}: ${writeConfig.error}`);
      return { success: false, step: 'write-config', error: writeConfig.error };
    }

    const nodeModulesResult = await this.ensureNodeModules(target);
    if (!nodeModulesResult.success) return nodeModulesResult;

    const pureJsResult = await this.copyBundledPureJsDeps(target);
    if (!pureJsResult.success) return pureJsResult;

    const serviceResult = await this.writeAndRestartService(target);
    return serviceResult;
  }

  /**
   * ⭐ 12/08/2026 — copier le node_modules PARTAGÉ en entier (`cp -r` du répertoire complet) a été
   * tenté en conditions réelles et abandonné : ce partage sert ~57 applications historiques
   * (66 000+ fichiers), largement plus que ce dont on a besoin — plus de 2h estimées sur la carte
   * SD de ce RPi1. `npm install` seul s'est aussi montré peu fiable ici (résolution réseau lente,
   * et son algorithme de réconciliation a supprimé des paquets déjà en place lors d'un essai).
   *
   * Approche retenue, prouvée en conditions réelles : résolution CIBLÉE, module par module — on
   * essaie de charger chaque dépendance déclarée, et pour chaque "Cannot find module X" on copie
   * UNIQUEMENT X (petit, souvent <1 Mo) depuis le node_modules partagé, puis on retente. Beaucoup
   * plus rapide (quelques dizaines de secondes au total) qu'une copie intégrale ou un npm install.
   * Repli sur `npm install --production` uniquement si le node_modules partagé n'existe pas du tout
   * (autre machine que celle testée) — lent mais fonctionnel en dernier recours.
   */
  private async ensureNodeModules(target: TeleinfoTargetConfig): Promise<DeployResult> {
    const check = await runSsh(target, `test -d ${shellQuote(target.remoteDir + '/node_modules')} && echo present`);
    if (check.success && check.output.trim() === 'present') {
      return { success: true, step: 'node-modules' };
    }

    const sharedExists = await runSsh(target, `test -d ${shellQuote(PROVEN_NODE_MODULES_PATH)} && echo yes`);
    if (sharedExists.success && sharedExists.output.trim() === 'yes') {
      await runSsh(target, `mkdir -p ${shellQuote(target.remoteDir + '/node_modules')}`);
      const resolved = await this.resolveDependenciesTargeted(target, ['rpio', 'serialport', 'mqtt']);
      if (resolved.success) {
        this.logger.info('DeployService', `node_modules résolu par copie ciblée depuis ${PROVEN_NODE_MODULES_PATH} sur ${target.host}`);
        return { success: true, step: 'node-modules' };
      }
      this.logger.warn('DeployService', `Résolution ciblée incomplète sur ${target.host} (${resolved.error}), repli sur npm install`);
    }

    this.logger.info('DeployService', `node_modules partagé introuvable/incomplet sur ${target.host}, npm install (peut être long)...`);
    const install = await runSsh(target, `cd ${shellQuote(target.remoteDir)} && npm install --production`, undefined, NPM_INSTALL_TIMEOUT_MS);
    if (!install.success) {
      this.logger.error('DeployService', `Échec npm install sur ${target.host}: ${install.error}`);
      return { success: false, step: 'node-modules', error: install.error, output: install.output };
    }
    return { success: true, step: 'node-modules' };
  }

  /** Copie js-yaml/argparse (pures JS) directement depuis ce dépôt — voir JS_YAML_LOCAL_PATH ci-dessus. */
  private async copyBundledPureJsDeps(target: TeleinfoTargetConfig): Promise<DeployResult> {
    const result = await runScp(target, [JS_YAML_LOCAL_PATH, ARGPARSE_LOCAL_PATH], `${target.remoteDir}/node_modules/`);
    if (!result.success) {
      this.logger.error('DeployService', `Échec de copie de js-yaml/argparse sur ${target.host}: ${result.error}`);
      return { success: false, step: 'node-modules', error: result.error };
    }
    return { success: true, step: 'node-modules' };
  }

  /**
   * Pour chaque module racine, essaie de le charger depuis remoteDir/node_modules ; copie le
   * module manquant signalé par l'erreur Node ("Cannot find module 'x'") depuis
   * PROVEN_NODE_MODULES_PATH et retente, jusqu'à MAX_RESOLVE_ITERATIONS par module.
   */
  private async resolveDependenciesTargeted(target: TeleinfoTargetConfig, rootModules: string[]): Promise<{ success: boolean; error?: string }> {
    const MAX_RESOLVE_ITERATIONS = 25;

    for (const rootModule of rootModules) {
      for (let i = 0; i < MAX_RESOLVE_ITERATIONS; i++) {
        const testCmd = `cd ${shellQuote(target.remoteDir)} && node -e "require(${JSON.stringify(rootModule)})"`;
        const result = await runSsh(target, testCmd);
        if (result.success) break;

        const match = /Cannot find module '([^']+)'/.exec(result.error || '');
        if (!match) {
          return { success: false, error: `${rootModule}: erreur non résolue automatiquement — ${result.error}` };
        }

        const missing = match[1];
        const pkgDir = missing.startsWith('@') ? missing.split('/').slice(0, 2).join('/') : missing.split('/')[0];
        const copyResult = await runSsh(
          target,
          `test -d ${shellQuote(`${PROVEN_NODE_MODULES_PATH}/${pkgDir}`)} && mkdir -p $(dirname ${shellQuote(`${target.remoteDir}/node_modules/${pkgDir}`)}) && cp -r ${shellQuote(`${PROVEN_NODE_MODULES_PATH}/${pkgDir}`)} ${shellQuote(`${target.remoteDir}/node_modules/${pkgDir}`)} && echo copied`
        );
        if (!copyResult.success || copyResult.output.trim() !== 'copied') {
          return { success: false, error: `${rootModule}: dépendance manquante introuvable dans le partage (${pkgDir})` };
        }

        if (i === MAX_RESOLVE_ITERATIONS - 1) {
          return { success: false, error: `${rootModule}: trop d'itérations (${MAX_RESOLVE_ITERATIONS})` };
        }
      }
    }

    return { success: true };
  }

  private async writeAndRestartService(target: TeleinfoTargetConfig): Promise<DeployResult> {
    const unit = [
      '[Unit]',
      'Description=Teleinfo EDF (mode historique) - lecture alternee 2 compteurs',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${target.remoteDir}`,
      `ExecStart=${target.nodeBinPath} ${target.remoteDir}/main.js`,
      'Restart=always',
      'RestartSec=5',
      'User=root',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n');

    const writeUnit = await runSsh(target, `tee ${shellQuote(`/etc/systemd/system/${target.serviceName}.service`)} > /dev/null`, unit);
    if (!writeUnit.success) {
      this.logger.error('DeployService', `Échec d'écriture du service systemd sur ${target.host}: ${writeUnit.error}`);
      return { success: false, step: 'write-service', error: writeUnit.error };
    }

    const restart = await runSsh(
      target,
      `systemctl daemon-reload && systemctl enable ${shellQuote(target.serviceName)} && systemctl restart ${shellQuote(target.serviceName)} && sleep 2 && systemctl is-active ${shellQuote(target.serviceName)}`
    );
    if (!restart.success) {
      this.logger.error('DeployService', `Échec de redémarrage de ${target.serviceName} sur ${target.host}: ${restart.error}`);
      return { success: false, step: 'restart', error: restart.error, output: restart.output };
    }

    this.logger.info('DeployService', `${target.serviceName} déployé et redémarré sur ${target.host} (statut: ${restart.output.trim()})`);
    return { success: true, step: 'restart', output: restart.output.trim() };
  }
}
