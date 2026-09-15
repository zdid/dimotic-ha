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

  /** Marge (%) sous laquelle un mouvement est considéré arrivé en butée — voir checkArrival(). */
  private static readonly ARRIVAL_MARGIN_PERCENT = 3;

  /**
   * ⭐ 15/09/2026, demande utilisateur : jusqu'ici `direction` ne redevenait `null` que sur un stop
   * EXPLICITE ou au tout début d'un nouveau mouvement (freeze() dans startMoving()) — jamais tout
   * seul avec le temps qui passe. Un volet arrivé en butée sans commande derrière (cas normal :
   * aucun stop natif n'est envoyé automatiquement à la fin d'un open/close) restait donc
   * indéfiniment "en mouvement" côté logiciel, désynchronisé de la réalité physique. Détection par
   * pourcentage AVEC MARGE (pas pile 0/100) pour absorber l'imprécision du calcul temps
   * écoulé/openTimeSec-closeTimeSec — appelée au début de chaque méthode publique qui lit ou utilise
   * `direction`/`position`.
   */
  private checkArrival(): void {
    if (this.direction === null) return;
    const pos = this.computePosition();
    const arrived =
      (this.direction === 'opening' && pos >= 100 - ReceiverCover.ARRIVAL_MARGIN_PERCENT) ||
      (this.direction === 'closing' && pos <= ReceiverCover.ARRIVAL_MARGIN_PERCENT);
    if (!arrived) return;
    this.position = this.direction === 'opening' ? 100 : 0;
    this.direction = null;
    this.movingSince = null;
  }

  translateHaCommand(command: string, value?: number): ReceiverCommandResult | null {
    this.checkArrival();
    const usesLighting2 = this.primaryEmitterProtocol === 'lighting2';

    if (command === 'set_position' && value !== undefined) {
      const current = this.computePosition();
      if (Math.round(value) === Math.round(current)) return null;
      const desiredDirection: CoverDirection = value > current ? 'opening' : 'closing';
      // Déjà en train de bouger dans la bonne direction (ex: slider glissé progressivement,
      // plusieurs set_position rapprochés) — ne PAS renvoyer on/off : sur Lighting2, une commande
      // répétée dans le même sens arrête le moteur (toggle physique, voir plus bas), ce qui
      // interromprait le mouvement en cours pour rien.
      if (this.direction === desiredDirection) return null;
      this.startMoving(desiredDirection);
      return usesLighting2
        ? { action: desiredDirection === 'opening' ? 'on' : 'off' }
        : { action: desiredDirection === 'opening' ? 'open' : 'close' };
    }

    if (usesLighting2) {
      // fonctionnelles-rfxcom_specs §16.4 : pas de STOP natif, on/off réinterprétés. Comportement
      // matériel (relais AC) : renvoyer la MÊME commande que celle en cours d'exécution arrête le
      // moteur (toggle) — c'est le seul moyen de l'arrêter. Inverser directement de sens (monte→
      // descend ou l'inverse) ne nécessite PAS de stop intermédiaire (confirmé — le relais gère
      // lui-même l'interverrouillage électrique entre les deux sens).
      if (command === 'open') {
        if (this.direction === 'opening') return null; // déjà en train de monter, ignoré
        if (this.direction === null && this.runtimeState() === 'up') return null; // déjà ouvert
        this.startMoving('opening');
        return { action: 'on' };
      }
      if (command === 'close') {
        if (this.direction === 'closing') return null;
        if (this.direction === null && this.runtimeState() === 'down') return null;
        this.startMoving('closing');
        return { action: 'off' };
      }
      if (command === 'stop') {
        if (this.direction === null) return null; // déjà arrêté, rien à envoyer
        // Arrêter un moteur Lighting2 en mouvement = renvoyer la commande qui l'a fait démarrer.
        const stopAction = this.direction === 'opening' ? 'on' : 'off';
        this.freeze();
        return { action: stopAction };
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

  applyEmitterCommand(action: EmitterAction): ReceiverCommandResult | null {
    this.checkArrival();
    // 'on'/'off' : seul Lighting2 parle ce vocabulaire — le bouton associé est donc forcément un
    // bouton Lighting2 (ex: interrupteur mural), quel que soit le protocole du primaryEmitter
    // réellement commandé.
    if (action === 'on' || action === 'off') {
      const wasMoving = this.direction;
      // Répéter le signal qui a démarré le mouvement en cours = stop (comportement toggle d'un
      // relais AC, cf. translateHaCommand) — s'applique ici aussi car c'est la même sémantique
      // physique vue depuis le bouton plutôt que depuis HA.
      const isToggleStop =
        (action === 'on' && wasMoving === 'opening') || (action === 'off' && wasMoving === 'closing');

      if (isToggleStop) this.freeze();
      else this.startMoving(action === 'on' ? 'opening' : 'closing');

      if (this.primaryEmitterProtocol === 'lighting2') {
        // Bouton ET device commandé = même adresse Lighting2 — le device a déjà reçu ce signal
        // directement (le dongle ne fait qu'écouter), rien à retransmettre.
        return null;
      }
      // Bouton Lighting2 associé à un récepteur piloté nativement (ex: volet Somfy) — protocoles
      // et adresses différents, le moteur n'a RIEN reçu : retransmettre dans son vocabulaire natif.
      return { action: isToggleStop ? 'stop' : action === 'on' ? 'open' : 'close' };
    }

    // Bouton lui-même sur protocole natif (ex: vraie télécommande Somfy) : action déjà explicite
    // et sans ambiguïté toggle, et déjà reçue directement par le device — rien à retransmettre.
    if (action === 'open') this.startMoving('opening');
    else if (action === 'close') this.startMoving('closing');
    else if (action === 'stop') this.freeze();
    return null;
  }

  getState(): HaMqttStateMessage {
    this.checkArrival();
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
