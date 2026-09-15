/**
 * ReceiverManager
 *
 * Orchestre les récepteurs logiques : création des modules selon le type, routage des messages
 * émetteur → récepteurs associés (N↔N), routage des commandes HA → primaryEmitter.
 *
 * Conforme à recepteurs-emetteurs-rfxcom_specs_v5.1.md §6/§8.2/§8.3.
 */

import type { Logger } from '../../../../core/dist/exports';
import type { DeviceManager } from '../devices/DeviceManager';
import type { AssociatedEmitter, ReceiverConfig } from '../types';
import type { IReceiverModule, ReceiverCommandResult } from './BaseReceiver';
import { ReceiverSwitch } from './ReceiverSwitch';
import { ReceiverLight } from './ReceiverLight';
import { ReceiverCover } from './ReceiverCover';

export interface EmitterMatch {
  receiver: IReceiverModule;
  associated: AssociatedEmitter;
}

/** Récepteur affecté par un message émetteur, avec une éventuelle commande à retransmettre
 * (pont protocole — ex: bouton Lighting2 associé à un volet Somfy, voir ReceiverCover). */
export interface AffectedReceiver {
  receiver: IReceiverModule;
  toTransmit: ReceiverCommandResult | null;
}

export class ReceiverManager {
  private receivers: Map<string, IReceiverModule> = new Map();

  constructor(
    private readonly deviceManager: DeviceManager,
    private readonly logger: Logger
  ) {}

  loadReceivers(receiversConfig: Record<string, ReceiverConfig>): void {
    this.receivers.clear();
    for (const config of Object.values(receiversConfig)) {
      if (config.type === 'scene') {
        // Gérées séparément par SceneManager — pas un IReceiverModule "commandable" classique.
        continue;
      }
      this.receivers.set(config.receiverId, this.createModule(config));
    }
    this.logger.info('ReceiverManager', `${this.receivers.size} récepteur(s) chargé(s)`);
  }

  private createModule(config: ReceiverConfig): IReceiverModule {
    switch (config.type) {
      case 'switch':
        return new ReceiverSwitch(config);
      case 'light':
        return new ReceiverLight(config);
      case 'cover': {
        const primaryDevice = this.deviceManager.getDevice(config.primaryEmitter);
        return new ReceiverCover(config, primaryDevice?.protocole ?? 'lighting2');
      }
      default:
        throw new Error(`Type de récepteur non géré par ReceiverManager: ${(config as ReceiverConfig).type}`);
    }
  }

  addReceiver(config: ReceiverConfig): IReceiverModule | undefined {
    if (config.type === 'scene') return undefined;
    const module = this.createModule(config);
    this.receivers.set(config.receiverId, module);
    return module;
  }

  removeReceiver(receiverId: string): boolean {
    return this.receivers.delete(receiverId);
  }

  getReceiver(receiverId: string): IReceiverModule | undefined {
    return this.receivers.get(receiverId);
  }

  getAllReceivers(): IReceiverModule[] {
    return Array.from(this.receivers.values());
  }

  /** Récepteurs (et l'appairage correspondant) concernés par un émetteur donné. */
  findReceiversForEmitter(emitterId: string): EmitterMatch[] {
    const matches: EmitterMatch[] = [];
    for (const receiver of this.receivers.values()) {
      const associated = receiver.config.emitters.find((e) => e.emitterId === emitterId);
      if (associated) matches.push({ receiver, associated });
    }
    return matches;
  }

  /**
   * Traite un message RF433 issu d'un émetteur : applique l'action configurée sur chaque
   * récepteur associé (recepteurs-emetteurs-rfxcom_specs §8.2). Retourne les récepteurs affectés
   * (pour publication d'état par l'appelant).
   *
   * `receivedAction` : vraie valeur on/off portée par la trame RF reçue (RfxComRawMessage.data.command
   * normalisé), quand elle a pu être résolue sans ambiguïté — voir AssociatedEmitter.followReceivedSignal
   * (⭐ 15/09/2026). Prime sur `associated.action` uniquement pour les appairages qui l'ont demandé
   * explicitement ; sinon comportement historique inchangé (valeur figée de la config).
   */
  handleEmitterMessage(emitterId: string, receivedAction?: 'on' | 'off'): AffectedReceiver[] {
    const matches = this.findReceiversForEmitter(emitterId);
    if (matches.length === 0) {
      this.logger.debug('ReceiverManager', `Émetteur ${emitterId} non associé à un récepteur`);
    }
    return matches.map(({ receiver, associated }) => {
      const action = associated.followReceivedSignal && receivedAction ? receivedAction : associated.action;
      // ⭐ 15/09/2026, demande utilisateur (surveillance volets) : jusqu'ici seul le cas SANS
      // appariement était loggé — un appariement réussi restait silencieux, y compris en debug.
      this.logger.debug('ReceiverManager', `Émetteur ${emitterId} → ${receiver.config.receiverId} (${receiver.config.name}) : action=${action}${associated.followReceivedSignal ? ` (signal reçu, config=${associated.action})` : ' (figée en config)'}`);
      const toTransmit = receiver.applyEmitterCommand(action, associated.value);
      return { receiver, toTransmit };
    });
  }
}
