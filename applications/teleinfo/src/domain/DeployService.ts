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
  runSshStreaming,
  runScp,
  shellQuote,
  ensureGlobalSshKey,
  SystemdUnitController,
  type Logger,
  type RemoteOpResult,
} from '../../../core/dist/exports';
import type { TeleinfoTargetConfig } from './config-schema';

/** Attache la clé SSH unique de l'installation (générée si absente) avant toute opération SSH —
 *  voir ensureGlobalSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: TeleinfoTargetConfig): TeleinfoTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

export interface DeployResult {
  success: boolean;
  step?: 'ensure-node' | 'copy-agent' | 'write-config' | 'node-modules' | 'write-service' | 'restart';
  error?: string;
  output?: string;
}

// ⭐ 05/09/2026 — installation via apt (voir ensureNode ci-dessous) : plus lent qu'une simple
// vérification, mais reste largement sous le plafond npm install (voir NPM_INSTALL_TIMEOUT_MS).
const APT_INSTALL_TIMEOUT_MS = 300000;
// ⭐ 05/09/2026 — version figée du tarball npm autonome (voir ensureNode ci-dessous) : npm 10.8.2
// est compatible avec Node ^18.17.0 (notre 18.20.4 installé via apt). Version fixée plutôt que
// "latest" pour rester reproductible — comme le reste du dépôt (rpio@2.4.2, serialport@9.0.7...).
const NPM_STANDALONE_VERSION = '10.8.2';
const NPM_STANDALONE_INSTALL_TIMEOUT_MS = 120000;

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
    return unitController.start(resolveTarget(target), target.serviceName);
  }

  /** Arrête le service systemd sur la machine cible. */
  stop(target: TeleinfoTargetConfig): Promise<RemoteOpResult> {
    return unitController.stop(resolveTarget(target), target.serviceName);
  }

  /** Redémarre le service systemd sur la machine cible sans réappliquer la config/l'agent. */
  restart(target: TeleinfoTargetConfig): Promise<RemoteOpResult> {
    return unitController.restart(resolveTarget(target), target.serviceName);
  }

  async deploy(rawTarget: TeleinfoTargetConfig, agentConfigYaml: string, onProgress?: (line: string) => void): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'copy-agent', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);

    const nodeResult = await this.ensureNode(target, onProgress);
    if (!nodeResult.success) return nodeResult;

    onProgress?.('--- Copie de l\'agent ---');
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

    const nodeModulesResult = await this.ensureNodeModules(target, onProgress);
    if (!nodeModulesResult.success) return nodeModulesResult;

    const pureJsResult = await this.copyBundledPureJsDeps(target);
    if (!pureJsResult.success) return pureJsResult;

    onProgress?.('--- Écriture et démarrage du service systemd ---');
    const serviceResult = await this.writeAndRestartService(target);
    return serviceResult;
  }

  /**
   * ⭐ 05/09/2026 (demande utilisateur, découvert en conditions réelles après reflash de la carte SD
   * du RPi1 : node ET npm absents, plus aucune trace de l'ancienne installation domotique) — vérifie
   * la présence de node/npm sur la cible avant toute autre étape, installe séparément si besoin.
   *
   * Contrairement à l'hypothèse historique ("Node officiel n'a plus de build ARMv6" — voir l'en-tête
   * de ce fichier), le dépôt APT de Raspberry Pi OS (Raspbian Bookworm) fournit son propre paquet
   * `nodejs` compilé pour ARMv6 (vérifié en conditions réelles : `apt-cache policy nodejs` propose
   * 18.20.4 sur ce RPi1 précis) — installation légère et rapide via `apt-get install nodejs` seul.
   * `nodeBinPath` (config-schema.ts, défaut `/usr/bin/node`) reste valide : c'est là que le paquet
   * Debian/Raspbian installe le binaire.
   *
   * ⭐ npm PAS installé via apt — bug réel découvert en conditions réelles (05/09/2026) : le paquet
   * Debian `npm` entraîne plus de 400 paquets sans rapport en dépendances "automatic" (eslint,
   * webpack, git, jest, et même une pile graphique X11/Mesa complète — inutile sur un Pi headless qui
   * ne fait que lire des trames série) — plus de 15 minutes et toujours pas terminé lors du test.
   * npm est du JS pur (aucune compilation native, contrairement à rpio/serialport) : un simple
   * tarball téléchargé depuis le registre npm officiel et exécuté par le node déjà installé suffit,
   * sans passer par apt du tout.
   */
  private async ensureNode(target: TeleinfoTargetConfig & { sshKeyPath: string }, onProgress?: (line: string) => void): Promise<DeployResult> {
    onProgress?.('--- Vérification de Node.js/npm sur la cible ---');
    // ⭐ `npm -v`, pas `command -v npm` — bug réel corrigé (05/09/2026) : un essai précédent laissait
    // un symlink npm cassé (pointait vers un mauvais emplacement) sur la cible ; `command -v`
    // vérifie seulement qu'un fichier exécutable existe sous ce nom, pas qu'il fonctionne
    // réellement, donc un réessai passait silencieusement à côté de la réparation.
    const check = await runSsh(target, `node -v >/dev/null 2>&1 && npm -v >/dev/null 2>&1 && echo present`);
    if (check.success && check.output.trim() === 'present') {
      onProgress?.('Node.js et npm déjà présents.');
      return { success: true, step: 'ensure-node' };
    }

    const nodeCheck = await runSsh(target, `command -v node >/dev/null 2>&1 && echo present`);
    if (!(nodeCheck.success && nodeCheck.output.trim() === 'present')) {
      onProgress?.('Node.js absent — installation via apt (paquet Raspbian, compatible ARMv6)...');
      this.logger.info('DeployService', `Node.js absent sur ${target.host} — installation via apt`);
      // ⭐ idleTimeoutMs relevé (défaut 90s, ici 3 min) — constaté en conditions réelles sur ce RPi1
      // précis (ARMv6, très faible puissance CPU) : apt-get, sans TTY, n'émet RIEN sur le canal SSH
      // pendant qu'il télécharge/vérifie un fichier Packages volumineux (~15-19 Mo) — un
      // téléchargement direct du même fichier (curl) a pourtant pris moins de 10s, donc ce n'est pas
      // le débit réseau qui est en cause, mais le silence total d'apt entre deux lignes "Get:" en
      // mode non-interactif, combiné à la vérification de checksum/décompression lente sur ce CPU.
      // DEBIAN_FRONTEND=noninteractive évite par ailleurs qu'une invite debconf bloque
      // silencieusement l'étape install.
      const installNode = await runSshStreaming(
        target,
        'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs',
        { onData: onProgress, maxTotalMs: APT_INSTALL_TIMEOUT_MS, idleTimeoutMs: 180000 }
      );
      if (!installNode.success) {
        this.logger.error('DeployService', `Échec d'installation de Node.js sur ${target.host}: ${installNode.error}`);
        return { success: false, step: 'ensure-node', error: installNode.error, output: installNode.output };
      }
    }

    const npmCheck = await runSsh(target, `npm -v >/dev/null 2>&1 && echo present`);
    if (!(npmCheck.success && npmCheck.output.trim() === 'present')) {
      onProgress?.(`npm absent — installation autonome (tarball npm ${NPM_STANDALONE_VERSION}, PAS le paquet Debian — voir le commentaire d'en-tête de cette méthode)...`);
      this.logger.info('DeployService', `npm absent sur ${target.host} — installation autonome (tarball, pas apt)`);
      // ⭐ bug réel corrigé en conditions réelles (05/09/2026) : un premier essai plaçait le tarball
      // dans /opt/npm-standalone puis symlinkait bin/npm — npm 9/10 résout ses propres fichiers
      // (npm-prefix.js etc.) en repartant du binaire `node` lui-même (/usr/bin/node), pas du
      // symlink, et cherchait donc /usr/bin/node_modules/npm/... (inexistant) au lieu du vrai
      // emplacement. Corrigé en respectant la disposition standard qu'npm attend d'une installation
      // globale : le paquet sous <préfixe>/lib/node_modules/npm (préfixe déduit de /usr/bin/node
      // → /usr), symlink direct vers npm-cli.js (shebang `#!/usr/bin/env node`, exécutable tel
      // quel — pas besoin du script `bin/npm` intermédiaire, dont la propre résolution de basedir
      // avait la même fragilité).
      const installNpm = await runSshStreaming(
        target,
        `mkdir -p /usr/lib/node_modules/npm && curl -fsSL https://registry.npmjs.org/npm/-/npm-${NPM_STANDALONE_VERSION}.tgz | tar -xz -C /usr/lib/node_modules/npm --strip-components=1 && chmod +x /usr/lib/node_modules/npm/bin/npm-cli.js && ln -sf /usr/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm`,
        { onData: onProgress, maxTotalMs: NPM_STANDALONE_INSTALL_TIMEOUT_MS }
      );
      if (!installNpm.success) {
        this.logger.error('DeployService', `Échec d'installation autonome de npm sur ${target.host}: ${installNpm.error}`);
        return { success: false, step: 'ensure-node', error: installNpm.error, output: installNpm.output };
      }
    }

    const recheck = await runSsh(target, `node -v >/dev/null 2>&1 && npm -v >/dev/null 2>&1 && echo present`);
    if (!recheck.success || recheck.output.trim() !== 'present') {
      return { success: false, step: 'ensure-node', error: 'node/npm toujours introuvables ou non fonctionnels après installation' };
    }
    onProgress?.('Node.js/npm installés.');
    return { success: true, step: 'ensure-node' };
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
  private async ensureNodeModules(target: TeleinfoTargetConfig, onProgress?: (line: string) => void): Promise<DeployResult> {
    onProgress?.('--- Résolution des dépendances (node_modules) ---');
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
    onProgress?.('node_modules partagé introuvable — npm install (peut être long, compilation native possible)...');
    // ⭐ idleTimeoutMs relevé (défaut 90s, ici 3 min) — même bug réel que pour apt-get (voir
    // ensureNode ci-dessus) : constaté en conditions réelles, la compilation native de rpio/
    // serialport (node-gyp/gcc) sur ce RPi1 ARMv6 peut rester longtemps sans produire une seule
    // ligne de sortie, tuant le canal SSH prématurément alors que npm install continue de tourner
    // sur la cible (orphelin) — corrige la cause plutôt que d'ajouter un nettoyage après coup.
    const install = await runSshStreaming(
      target,
      `cd ${shellQuote(target.remoteDir)} && npm install --production`,
      { onData: onProgress, maxTotalMs: NPM_INSTALL_TIMEOUT_MS, idleTimeoutMs: 180000 }
    );
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
