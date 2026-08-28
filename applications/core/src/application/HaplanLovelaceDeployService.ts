/**
 * HaplanLovelaceDeployService — dépose sur HA (via SSH) le YAML d'un tableau de bord Lovelace et
 * l'image de fond associée, générés côté HAPLAN (voir applications/haplan/src/domain/
 * lovelace-generator.ts) — voir fonctionnelles-haplan_specs_v1.6.md §17 pour la conception.
 *
 * Service dédié, pas une extension de `HaStackDeployService` : celui-ci gère spécifiquement le
 * cycle de vie docker-compose HA/Mosquitto (start/stop/deploy des conteneurs) — déposer un fichier
 * utilisateur dans /config n'a rien à voir avec ça, mais réutilise directement les mêmes
 * primitives SSH (SshClient.ts) et la même cible (`haStackTargets`, `ConfigService`).
 *
 * Contrairement à HaStackDeployService, ne connaît RIEN du contenu HAPLAN (icônes, positions,
 * format du YAML) — pur transport générique (écrire un fichier texte + copier une image), la
 * connaissance du domaine reste entièrement côté HAPLAN (autonomie des applications).
 */

import { runSsh, runScp, shellQuote, ensureGlobalSshKey } from '../infrastructure/remote/SshClient';
import type { RemoteOpResult } from '../infrastructure/remote/SshClient';
import type { HaStackTargetConfig } from '../infrastructure/config/schema';
import type { Logger } from '../infrastructure/logger';

const DASHBOARD_FILENAME = 'haplan_lovelace.yaml';

function resolveTarget(target: HaStackTargetConfig): HaStackTargetConfig & { sshKeyPath: string } {
  return { ...target, sshKeyPath: ensureGlobalSshKey() };
}

export class HaplanLovelaceDeployService {
  constructor(private readonly logger: Logger) {}

  /**
   * Écrit `<remoteDir>/homeassistant/config/haplan_lovelace.yaml` (tee, écrase l'existant) puis
   * copie les images (une par plan, voir lovelace-generator.ts) dans
   * `<remoteDir>/homeassistant/config/www/` (un seul `scp`, plusieurs sources vers un répertoire de
   * destination — préserve le nom de fichier local de chacune, d'où l'importance que
   * `images[].localPath` porte déjà le nom de fichier FINAL attendu, voir HaplanService.ts) —
   * servies par HA en `/local/<filename>`, référencées telles quelles dans le YAML. `remoteDir` =
   * dossier PARENT `/docker` (voir schema.ts::haStackTargetSchema) — le `/config` de HA lui-même
   * est un niveau plus bas, dans le projet compose `homeassistant/`.
   */
  async deploy(rawTarget: HaStackTargetConfig, yaml: string, images: Array<{ localPath: string; filename: string }>): Promise<RemoteOpResult> {
    if (!rawTarget.host) {
      return { success: false, step: 'write-yaml', error: 'Aucun hôte cible configuré (target.host)' };
    }
    const target = resolveTarget(rawTarget);
    const configDir = `${target.remoteDir}/homeassistant/config`;
    const wwwDir = `${configDir}/www`;

    const mkdir = await runSsh(target, `mkdir -p ${shellQuote(configDir)} ${shellQuote(wwwDir)}`);
    if (!mkdir.success) {
      this.logger.error('HaplanLovelaceDeployService', `Échec de création des répertoires sur ${target.host}: ${mkdir.error}`);
      return { success: false, step: 'mkdir', error: mkdir.error };
    }

    const writeYaml = await runSsh(target, `tee ${shellQuote(`${configDir}/${DASHBOARD_FILENAME}`)} > /dev/null`, yaml);
    if (!writeYaml.success) {
      this.logger.error('HaplanLovelaceDeployService', `Échec d'écriture du tableau de bord sur ${target.host}: ${writeYaml.error}`);
      return { success: false, step: 'write-yaml', error: writeYaml.error };
    }

    const copyImages = await runScp(target, images.map((i) => i.localPath), wwwDir);
    if (!copyImages.success) {
      this.logger.error('HaplanLovelaceDeployService', `Échec de copie des images sur ${target.host}: ${copyImages.error}`);
      return { success: false, step: 'copy-image', error: copyImages.error };
    }

    this.logger.info('HaplanLovelaceDeployService', `Carte Plan Lovelace déposée sur ${target.host} (${target.id}, ${images.length} plan(s))`);
    return { success: true, step: 'copy-image' };
  }
}
