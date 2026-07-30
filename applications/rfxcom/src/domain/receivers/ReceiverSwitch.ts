/**
 * ReceiverSwitch — récepteur logique simple on/off (fonctionnelles-rfxcom_specs_v5.6.md §16.2).
 */

import type { EssentialEntityData, HaMqttStateMessage } from '../../../../core/src/exports';
import type { EmitterAction, ReceiverSwitchConfig } from '../types';
import type { IReceiverModule, ReceiverCommandResult } from './BaseReceiver';
import { extractTaxonomy, buildAttributsTaxonomie, buildDisplayName } from '../taxonomy';

export class ReceiverSwitch implements IReceiverModule {
  private on: boolean;

  constructor(public readonly config: ReceiverSwitchConfig) {
    this.on = config.lastOn ?? false;
  }

  translateHaCommand(command: string): ReceiverCommandResult | null {
    switch (command) {
      case 'turn_on':
        return { action: 'on' };
      case 'turn_off':
        return { action: 'off' };
      case 'toggle':
        return { action: this.on ? 'off' : 'on' };
      default:
        return null;
    }
  }

  applyEmitterCommand(action: EmitterAction): void {
    if (action === 'toggle') this.on = !this.on;
    else if (action === 'on') this.on = true;
    else if (action === 'off') this.on = false;
    // Reflété dans la config persistée pour être rejoué au démarrage — voir
    // RfxComService.publishReceiverStateAtStartup (le service appelant se charge de sauvegarder).
    this.config.lastOn = this.on;
  }

  getState(): HaMqttStateMessage {
    const taxonomy = extractTaxonomy(this.config.name);
    return {
      state: this.on ? 'ON' : 'OFF',
      attributes: { attributs_taxonomie: buildAttributsTaxonomie(taxonomy) }
    };
  }

  getDiscoveryEssential(): { component: string; essential: EssentialEntityData } {
    const taxonomy = extractTaxonomy(this.config.name);
    return {
      component: 'switch',
      essential: {
        name: taxonomy.rawQuoi,
        commandEnabled: true,
        payloadOn: 'ON',
        payloadOff: 'OFF',
        device: {
          identifiers: [this.config.receiverId],
          // Nom court (lieu précis) — voir ReceiverLight.ts::buildDisplayName pour le pourquoi.
          name: buildDisplayName(taxonomy),
          manufacturer: 'RFXCOM',
          model: 'ReceiverSwitch',
          suggested_area: taxonomy.nomLieu ?? undefined
        }
        // attributs_taxonomie porté par getState() (json_attributes_topic), pas ici — voir
        // discovery.ts / RfxComService.publishDeviceDiscovery.
      }
    };
  }
}
