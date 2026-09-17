/**
 * Poussée du mot de passe d'application Nextcloud vers le fichier hôte d'une machine déjà connue
 * (§3bis de la spec) — jamais via config.yaml, jamais dans les arguments de la commande distante
 * (le secret passe uniquement par stdin, invisible dans `ps`). Un mot de passe par machine, jamais
 * partagé — voir la discussion utilisateur du 17/09/2026 sur la non-diffusion de ce secret.
 */

import { runSsh, ensureGlobalSshKey, shellQuote, type RemoteOpResult } from '../../../core/dist/exports';
import type { SauvegardeTargetConfig } from './config-schema';

export class SecretPushService {
  /**
   * Écrit `appPassword` dans `remotePasswordFile` sur `target.host`, avec les permissions
   * restrictives attendues (§3bis) — `mkdir -p` du dossier parent au passage, au cas où
   * `/docker/.secrets/` n'existe pas encore sur cette machine.
   */
  async push(target: SauvegardeTargetConfig, remotePasswordFile: string, appPassword: string): Promise<RemoteOpResult> {
    if (!target.host) {
      return { success: false, step: 'push', error: `Aucun hôte renseigné pour la cible ${target.id}` };
    }

    const sshKeyPath = ensureGlobalSshKey();
    const remoteDir = remotePasswordFile.slice(0, remotePasswordFile.lastIndexOf('/')) || '/';
    const command = `mkdir -p ${shellQuote(remoteDir)} && cat > ${shellQuote(remotePasswordFile)} && chmod 600 ${shellQuote(remotePasswordFile)}`;

    const result = await runSsh({ host: target.host, sshKeyPath }, command, appPassword);
    return { success: result.success, step: 'push', error: result.error, output: result.output };
  }
}
