/**
 * Poussée du script de sauvegarde (chantier A) + pose de son cron sur une machine déjà connue —
 * ⭐ 18/09/2026, demande explicite : le bouton « Pousser » de Paramètres Techniques ne se limite
 * plus au mot de passe (§3bis), il déploie aussi ce qui permet au script de tourner seul ensuite,
 * cohérent avec §5bis ("greffé sur un mécanisme de poussée existant" — celui-ci, plutôt qu'un
 * nouveau système de déploiement séparé à construire).
 */

import { runSsh, ensureGlobalSshKey, shellQuote, type RemoteOpResult } from '../../../core/dist/exports';
import {
  renderBackupScript,
  BACKUP_DIR,
  BACKUP_SCRIPT_REMOTE_PATH,
  BACKUP_CRON_LOG_REMOTE_PATH,
  BACKUP_CRON_HOUR,
  BACKUP_CRON_MINUTE,
  type BackupScriptParams
} from './BackupScript';
import type { SauvegardeTargetConfig } from './config-schema';

export class ScriptPushService {
  /**
   * Écrit le script généré sur `target.host` puis installe son cron quotidien — deux allers-retours
   * SSH séquentiels (le contenu du script transite par stdin, comme SecretPushService ; la commande
   * cron n'a pas besoin de stdin). `step` du résultat distingue lequel des deux a échoué.
   */
  async push(target: SauvegardeTargetConfig, params: BackupScriptParams): Promise<RemoteOpResult> {
    if (!target.host) {
      return { success: false, step: 'script', error: `Aucun hôte renseigné pour la cible ${target.id}` };
    }

    const sshKeyPath = ensureGlobalSshKey();
    const scriptContent = renderBackupScript(params);

    const writeCommand = `mkdir -p ${shellQuote(BACKUP_DIR)} && cat > ${shellQuote(BACKUP_SCRIPT_REMOTE_PATH)} && chmod +x ${shellQuote(BACKUP_SCRIPT_REMOTE_PATH)}`;
    const writeResult = await runSsh({ host: target.host, sshKeyPath }, writeCommand, scriptContent);
    if (!writeResult.success) {
      return { success: false, step: 'script', error: writeResult.error, output: writeResult.output };
    }

    // ⭐ Idempotent et non-destructif : retire uniquement une éventuelle ligne précédente référençant
    // CE script (repoussé une 2e fois, ex. après un changement d'horaire) avant de rajouter la
    // nôtre — ne touche à AUCUNE autre entrée déjà présente dans le crontab de la machine (demande
    // explicite : ne pas interférer avec des automatisations existantes, ex. extinction de lumières
    // vers la même heure).
    const cronLine = `${BACKUP_CRON_MINUTE} ${BACKUP_CRON_HOUR} * * * ${BACKUP_SCRIPT_REMOTE_PATH} >> ${BACKUP_CRON_LOG_REMOTE_PATH} 2>&1`;
    const cronCommand = `(crontab -l 2>/dev/null | grep -vF ${shellQuote(BACKUP_SCRIPT_REMOTE_PATH)} ; echo ${shellQuote(cronLine)}) | crontab -`;
    const cronResult = await runSsh({ host: target.host, sshKeyPath }, cronCommand);
    if (!cronResult.success) {
      return { success: false, step: 'cron', error: cronResult.error, output: cronResult.output };
    }

    return { success: true, step: 'cron' };
  }
}

export type { BackupScriptParams };
