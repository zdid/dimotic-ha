/**
 * ReceiverLight — récepteur logique light, avec variateur optionnel (isDimmable).
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §16.3/§14.4 et recepteurs-emetteurs-rfxcom_specs_v5.1.md §6.3.
 * Le niveau RFXCOM natif est 0-15 (converti en 0-15 dans RfxComTransceiver) — ici, tout est en
 * pourcentage 0-100, converti en brightness HA (0-255) uniquement à la publication d'état.
 */

import type { EssentialEntityData, HaMqttStateMessage } from '../../../../core/src/exports';
import type { EmitterAction, ReceiverLightConfig } from '../types';
import type { IReceiverModule, ReceiverCommandResult } from './BaseReceiver';
import { extractTaxonomy, buildAttributsTaxonomie, buildDisplayName } from '../taxonomy';

export class ReceiverLight implements IReceiverModule {
  private on: boolean;
  private level: number; // 0-100%, pertinent seulement si isDimmable

  constructor(public readonly config: ReceiverLightConfig) {
    this.on = config.lastOn ?? false;
    this.level = config.lastLevel ?? config.defaultLevel ?? 100;
  }

  /** `value` en pourcentage 0-100 (converti depuis brightness HA 0-255 par l'appelant). */
  translateHaCommand(command: string, value?: number): ReceiverCommandResult | null {
    if (!this.config.isDimmable) {
      switch (command) {
        case 'turn_on': return { action: 'on' };
        case 'turn_off': return { action: 'off' };
        case 'toggle': return { action: this.on ? 'off' : 'on' };
        default: return null;
      }
    }

    switch (command) {
      case 'turn_on':
        return { action: 'on', value: this.level || this.config.defaultLevel || 100 };
      case 'turn_off':
        return { action: 'off' };
      case 'toggle':
        return this.on ? { action: 'off' } : { action: 'on', value: this.level || 100 };
      case 'set_level':
        return { action: 'set_level', value: value ?? this.level };
      default:
        return null;
    }
  }

  applyEmitterCommand(action: EmitterAction, value?: number): void {
    if (action === 'toggle') {
      this.on = !this.on;
    } else if (action === 'on') {
      this.on = true;
      if (value !== undefined) this.level = value;
    } else if (action === 'off') {
      this.on = false;
    } else if (action === 'set_level') {
      this.on = (value ?? 0) > 0;
      if (value !== undefined) this.level = value;
    }
    // Reflété dans la config persistée pour être rejoué au démarrage — voir
    // RfxComService.publishReceiverStateAtStartup (le service appelant se charge de sauvegarder).
    this.config.lastOn = this.on;
    this.config.lastLevel = this.level;
  }

  getState(): HaMqttStateMessage {
    const taxonomy = extractTaxonomy(this.config.name);
    if (!this.config.isDimmable) {
      return {
        state: this.on ? 'ON' : 'OFF',
        attributes: { attributs_taxonomie: buildAttributsTaxonomie(taxonomy) }
      };
    }
    return {
      state: this.on ? 'ON' : 'OFF',
      attributes: {
        brightness: Math.round((this.level / 100) * 255),
        attributs_taxonomie: buildAttributsTaxonomie(taxonomy)
      }
    };
  }

  getDiscoveryEssential(): { component: string; essential: EssentialEntityData } {
    const taxonomy = extractTaxonomy(this.config.name);
    return {
      component: 'light',
      essential: {
        name: taxonomy.rawQuoi,
        commandEnabled: true,
        payloadOn: 'ON',
        payloadOff: 'OFF',
        // Le schéma MQTT "light" (schema_basic.py) attend state_value_template, PAS value_template
        // (qui n'existe que pour switch/cover/sensor) — vérifié dans le code source HA du conteneur
        // (CONF_STATE_VALUE_TEMPLATE). Sans lui, HA compare le state_topic brut à payload_on/off —
        // or on y publie du JSON ({state, attributes}), jamais égal à "ON"/"OFF" telle quelle ; HA
        // ignore silencieusement une clé "value_template" non reconnue pour ce schéma (validation
        // stricte par plateforme), d'où l'état "unknown" persistant malgré un state_topic correct.
        extra: { state_value_template: '{{ value_json.state }}' },
        device: {
          identifiers: [this.config.receiverId],
          // Nom court (lieu précis, ex: "Plafonnier") plutôt que la chaîne de taxonomie brute
          // complète — l'area (suggested_area ci-dessous) donne déjà le lieu, plus besoin de le
          // répéter dans le nom. buildDisplayName retombe sur le quoi si pas de lieu précis
          // distinct de l'area (évite une redondance style "Cuisine" dans l'area "Cuisine").
          name: buildDisplayName(taxonomy),
          manufacturer: 'RFXCOM',
          model: this.config.isDimmable ? 'ReceiverLight (variateur)' : 'ReceiverLight',
          suggested_area: taxonomy.nomLieu ?? undefined
        }
        // attributs_taxonomie porté par getState() (json_attributes_topic), pas ici.
      }
    };
  }
}
