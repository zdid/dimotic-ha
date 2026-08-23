/**
 * Déploiement automatisé d'un émetteur USB (BS500) vers une cible — ⭐ 23/08/2026, remplace la
 * copie manuelle de `data/arexx/drivers/` décrite jusqu'ici sur la page Déploiement (scp + ssh
 * lancés à la main par l'utilisateur). Le bundle `data/arexx/drivers/` (généré à chaque démarrage
 * par `DriversBundle.ts`, `target.txt` déjà renseigné — adresse du récepteur, commune à tous les
 * émetteurs) est copié sur la cible, puis `scripts/deploy-sender.sh` y est lancé à distance — ce
 * script gère lui-même tout le reste (détection d'architecture, dépendances, service systemd
 * `arexx-sender.service`, idempotent), aucune modification du script lui-même.
 *
 * Même patron que `teleinfo/DeployService.ts` : `runSsh`/`runScp`/`shellQuote`/
 * `SystemdUnitController` viennent du socle partagé (`core/infrastructure/remote/`), toutes les
 * commandes distantes s'exécutent en root direct (voir SshClient.ts pour le raisonnement).
 */

import {
  runSsh,
  runScp,
  shellQuote,
  ensureGlobalSshKey,
  SystemdUnitController,
  type Logger,
  type RemoteOpResult,
} from '../../../core/dist/exports';
import type { ArexxTargetConfig } from './config-schema';
import { driversDirPath } from './DriversBundle';

export interface DeployResult {
  success: boolean;
  step?: 'mkdir' | 'copy-drivers' | 'run-script';
  error?: string;
  output?: string;
}

const SENDER_SERVICE_NAME = 'arexx-sender.service';
const unitController = new SystemdUnitController();

/** Attache la clé SSH unique de l'installation (générée si absente) avant toute opération SSH —
 *  voir ensureGlobalSshKey (core/infrastructure/remote/SshClient.ts). */
function resolveTarget(target: ArexxTargetConfig): ArexxTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

export class ArexxDeployService {
  constructor(private readonly logger: Logger) {}

  /** Démarre le service arexx-sender sur la machine cible. */
  start(target: ArexxTargetConfig): Promise<RemoteOpResult> {
    return unitController.start(resolveTarget(target), SENDER_SERVICE_NAME);
  }

  /** Arrête le service arexx-sender sur la machine cible. */
  stop(target: ArexxTargetConfig): Promise<RemoteOpResult> {
    return unitController.stop(resolveTarget(target), SENDER_SERVICE_NAME);
  }

  /** Redémarre le service arexx-sender sur la machine cible sans rejouer le déploiement. */
  restart(target: ArexxTargetConfig): Promise<RemoteOpResult> {
    return unitController.restart(resolveTarget(target), SENDER_SERVICE_NAME);
  }

  /**
   * Copie tout `data/arexx/drivers/` vers `target.remoteDir` puis lance `scripts/deploy-sender.sh`
   * à distance — installe/démarre `arexx-sender.service`, idempotent (ré-exécutable sans risque).
   */
  async deploy(rawTarget: ArexxTargetConfig): Promise<DeployResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'mkdir', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);

    const mkdir = await runSsh(target, `mkdir -p ${shellQuote(target.remoteDir)}`);
    if (!mkdir.success) {
      this.logger.error('ArexxDeployService', `Échec de création de ${target.remoteDir} sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const copy = await runScp(target, [driversDirPath()], target.remoteDir);
    if (!copy.success) {
      this.logger.error('ArexxDeployService', `Échec de copie de drivers/ sur ${target.host}: ${copy.error}`);
      return { success: false, step: 'copy-drivers', error: copy.error };
    }

    const run = await runSsh(target, `cd ${shellQuote(`${target.remoteDir}/drivers/scripts`)} && ./deploy-sender.sh`);
    if (!run.success) {
      this.logger.error('ArexxDeployService', `Échec de deploy-sender.sh sur ${target.host}: ${run.error}`);
      return { success: false, step: 'run-script', error: run.error, output: run.output };
    }

    this.logger.info('ArexxDeployService', `Émetteur déployé sur ${target.host} (${target.id})`);
    return { success: true, step: 'run-script', output: run.output.trim() };
  }
}
