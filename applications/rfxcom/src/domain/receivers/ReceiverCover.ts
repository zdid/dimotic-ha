/**
 * ReceiverCover — récepteur logique cover, avec calcul de position par le temps écoulé.
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §16.4 (Lighting2 : on/off réinterprétés en
 * montée/descente, pas de commande stop native) et §16.5 (Blinds1/Curtain1 : open/close/stop
 * natifs). Le protocole du primaryEmitter détermine laquelle des deux logiques s'applique.
 *
 * ⚠️ Limitation connue de cette première passe : `set_position` démarre un mouvement calculé vers
 * la position cible mais n'envoie pas de commande STOP automatique à l'atteinte de cette position
 * (nécessiterait un minuteur asynchrone en dehors de cette classe synchrone) — la position reste
 * correcte au prochain getState()/commande, mais le mouvement RF ne s'arrête que sur open/close/stop
 * explicite ou sur la butée 0/100%.
 */

import type { EssentialEntityData, HaMqttStateMessage } from '../../../../core/dist/exports';
import type { EmitterAction, ReceiverCoverConfig } from '../types';
import type { IReceiverModule, ReceiverCommandResult } from './BaseReceiver';
import { extractTaxonomy, buildAttributsTaxonomie, buildDisplayName } from '../taxonomy';

type CoverDirection = 'opening' | 'closing' | null;

export class ReceiverCover implements IReceiverModule {
  private position = 100; // 0-100, 100 = totalement ouvert (up)
  private direction: CoverDirection = null;
  private movingSince: number | null = null; // epoch ms

  constructor(
    public readonly config: ReceiverCoverConfig,
    /** Protocole RFXCOM du primaryEmitter (ex: "lighting2", "blinds1") — détermine la logique de traduction. */
    private readonly primaryEmitterProtocol: string
  ) {}

  private computePosition(): number {
    if (this.movingSince === null || this.direction === null) return this.position;
    const elapsedMs = Date.now() - this.movingSince;
    const timeSec = this.direction === 'opening' ? this.config.openTimeSec : this.config.closeTimeSec;
    const deltaPercent = (elapsedMs / (timeSec * 1000)) * 100;
    const raw = this.direction === 'opening' ? this.position + deltaPercent : this.position - deltaPercent;
    return Math.max(0, Math.min(100, raw));
  }

  private freeze(): void {
    this.position = this.computePosition();
    this.movingSince = null;
    this.direction = null;
  }

  private startMoving(direction: CoverDirection): void {
    this.freeze();
    this.direction = direction;
    this.movingSince = Date.now();
  }

  private runtimeState(): 'up' | 'down' | 'intermediate' {
    const pos = this.computePosition();
    if (pos >= 100) return 'up';
    if (pos <= 0) return 'down';
    return 'intermediate';
  }

  translateHaCommand(command: string, value?: number): ReceiverCommandResult | null {
    const usesLighting2 = this.primaryEmitterProtocol === 'lighting2';

    if (command === 'set_position' && value !== undefined) {
      const current = this.computePosition();
      if (Math.round(value) === Math.round(current)) return null;
      this.startMoving(value > current ? 'opening' : 'closing');
      return usesLighting2
        ? { action: this.direction === 'opening' ? 'on' : 'off' }
        : { action: this.direction === 'opening' ? 'open' : 'close' };
    }

    if (usesLighting2) {
      // fonctionnelles-rfxcom_specs §16.4 : pas de STOP natif, on/off réinterprétés
      const state = this.runtimeState();
      if (command === 'open') {
        if (state === 'up') return null; // déjà ouvert, ignoré
        this.startMoving('opening');
        return { action: 'on' };
      }
      if (command === 'close') {
        if (state === 'down') return null;
        this.startMoving('closing');
        return { action: 'off' };
      }
      if (command === 'stop') {
        this.freeze();
        return null; // rien à envoyer au device : on fige juste la position calculée côté HA
      }
      return null;
    }

    // fonctionnelles-rfxcom_specs §16.5 : Blinds1/Curtain1, commandes natives
    switch (command) {
      case 'open':
        this.startMoving('opening');
        return { action: 'open' };
      case 'close':
        this.startMoving('closing');
        return { action: 'close' };
      case 'stop':
        this.freeze();
        return { action: 'stop' };
      default:
        return null;
    }
  }

  applyEmitterCommand(action: EmitterAction): void {
    if (action === 'on' || action === 'open') {
      this.startMoving('opening');
    } else if (action === 'off' || action === 'close') {
      this.startMoving('closing');
    } else if (action === 'stop') {
      this.freeze();
    }
  }

  getState(): HaMqttStateMessage {
    return {
      state: this.runtimeState(),
      attributes: { position: Math.round(this.computePosition()) }
    };
  }

  getDiscoveryEssential(): { component: string; essential: EssentialEntityData } {
    const taxonomy = extractTaxonomy(this.config.name);
    return {
      component: 'cover',
      essential: {
        // null — voir ReceiverLight.ts::getDiscoveryEssential (corrigé le 08/08/2026).
        name: null,
        commandEnabled: true,
        // Voir ReceiverLight.ts : sans ça, state_topic (JSON) n'est jamais reconnu par HA.
        valueTemplate: '{{ value_json.state }}',
        attributsTaxonomie: buildAttributsTaxonomie(taxonomy),
        device: {
          identifiers: [this.config.receiverId],
          // Nom court (lieu précis) — voir ReceiverLight.ts::buildDisplayName pour le pourquoi.
          name: buildDisplayName(taxonomy),
          manufacturer: 'RFXCOM',
          model: `ReceiverCover (${this.config.coverType})`,
          suggested_area: taxonomy.nomLieu ?? undefined
        }
      }
    };
  }
}
