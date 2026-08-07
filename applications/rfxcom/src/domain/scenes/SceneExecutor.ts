/**
 * SceneExecutor
 *
 * Exécute les commandes d'une scène sur les récepteurs cibles, en parallèle ou en séquentiel
 * avec délai entre commandes — fonctionnelles-rfxcom_specs_v5.6.md §14.3.3 :
 * - parallel : toutes les commandes envoyées simultanément, même si certaines échouent.
 * - sequential : commandes envoyées une à une ; un échec annule les commandes suivantes.
 *
 * Ne connaît rien du transceiver/ReceiverManager : reçoit une fonction d'envoi de commande
 * (RfxComService.applyReceiverCommand), pour rester testable indépendamment du matériel.
 */

import type { Logger } from '../../../../core/dist/exports';
import type { ReceiverSceneConfig, SceneExecutionResult } from '../types';

export type ReceiverCommandSender = (
  receiverId: string,
  command: string,
  value?: number
) => { success: boolean; error?: string };

const DEFAULT_DELAY_MS = 500;

export class SceneExecutor {
  constructor(private readonly logger: Logger) {}

  async execute(
    scene: ReceiverSceneConfig,
    sendCommand: ReceiverCommandSender,
    isCancelled: () => boolean
  ): Promise<SceneExecutionResult> {
    const start = Date.now();
    const errors: SceneExecutionResult['errors'] = [];
    let executedCommands = 0;
    let failedCommands = 0;
    let cancelled = false;

    if (scene.sceneType === 'parallel') {
      for (const action of scene.actions) {
        const result = sendCommand(action.target, action.command, action.value);
        if (result.success) {
          executedCommands++;
        } else {
          failedCommands++;
          errors.push({ receiverId: action.target, action: action.command, error: result.error ?? 'Erreur inconnue' });
        }
      }
    } else {
      for (let i = 0; i < scene.actions.length; i++) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }

        const action = scene.actions[i];
        if (i > 0) {
          await this.wait(action.delayMs ?? scene.delayBetweenCommands ?? DEFAULT_DELAY_MS);
          if (isCancelled()) {
            cancelled = true;
            break;
          }
        }

        const result = sendCommand(action.target, action.command, action.value);
        if (result.success) {
          executedCommands++;
          continue;
        }

        failedCommands++;
        errors.push({ receiverId: action.target, action: action.command, error: result.error ?? 'Erreur inconnue' });
        this.logger.warn('SceneExecutor',
          `Scène ${scene.receiverId}: échec de "${action.command}" sur ${action.target}, commandes suivantes annulées`);
        break;
      }
    }

    return {
      sceneId: scene.receiverId,
      success: failedCommands === 0 && !cancelled,
      executedCommands,
      failedCommands,
      errors,
      duration: Date.now() - start
    };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
