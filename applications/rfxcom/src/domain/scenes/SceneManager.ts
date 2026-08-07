/**
 * SceneManager
 *
 * Registre des scènes RFXCOM (`rfxcom_receivers` de type `scene`). Gérées séparément de
 * ReceiverManager : une scène n'est pas un IReceiverModule commandable via un primaryEmitter,
 * c'est un ensemble de commandes appliquées à d'autres récepteurs — voir
 * recepteurs-emetteurs-rfxcom_specs_v5.1.md §14.3 (fonctionnelles-rfxcom_specs).
 */

import type { Logger } from '../../../../core/dist/exports';
import type { ReceiverConfig, ReceiverSceneConfig } from '../types';

export class SceneManager {
  private scenes: Map<string, ReceiverSceneConfig> = new Map();

  constructor(private readonly logger: Logger) {}

  loadScenes(receiversConfig: Record<string, ReceiverConfig>): void {
    this.scenes.clear();
    for (const config of Object.values(receiversConfig)) {
      if (config.type === 'scene') {
        this.scenes.set(config.receiverId, config);
      }
    }
    this.logger.info('SceneManager', `${this.scenes.size} scène(s) chargée(s)`);
  }

  addScene(config: ReceiverSceneConfig): void {
    this.scenes.set(config.receiverId, config);
  }

  removeScene(sceneId: string): boolean {
    return this.scenes.delete(sceneId);
  }

  getScene(sceneId: string): ReceiverSceneConfig | undefined {
    return this.scenes.get(sceneId);
  }

  getAllScenes(): ReceiverSceneConfig[] {
    return Array.from(this.scenes.values());
  }
}
