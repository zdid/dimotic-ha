/**
 * Interface commune aux modules de récepteur (switch/light/cover).
 *
 * Conforme à recepteurs-emetteurs-rfxcom_specs_v5.1.md §6.2 et fonctionnelles-rfxcom_specs_v5.6.md
 * §16 (traduction commandes HA→RFXCOM, propre à chaque type + protocole du primaryEmitter).
 */

import type { EssentialEntityData, HaMqttStateMessage } from '../../../../core/dist/exports';
import type { EmitterAction, CommandableReceiverConfig } from '../types';

/** Commande RFXCOM résultant de la traduction d'une commande HA. */
export interface ReceiverCommandResult {
  action: EmitterAction;
  value?: number;
}

export interface IReceiverModule {
  readonly config: CommandableReceiverConfig;

  /**
   * Traduit une commande HA (turn_on, turn_off, toggle, set_level, open, close, stop, ...) en
   * commande RFXCOM à envoyer au primaryEmitter. `null` si la commande n'est pas supportée par
   * ce type de récepteur.
   */
  translateHaCommand(command: string, value?: number): ReceiverCommandResult | null;

  /**
   * Met à jour l'état interne suite à l'action déclenchée par un émetteur appairé (bouton
   * physique) — voir recepteurs-emetteurs-rfxcom_specs §8.2.
   */
  applyEmitterCommand(action: EmitterAction, value?: number): void;

  /** État courant à publier vers HA. */
  getState(): HaMqttStateMessage;

  /** Composant HA + données essentielles de découverte (le socle complète le reste). */
  getDiscoveryEssential(): { component: string; essential: EssentialEntityData };
}
