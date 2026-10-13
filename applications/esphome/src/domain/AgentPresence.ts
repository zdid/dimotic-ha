/**
 * Présence d'un agent (usine ou poseur) sur ses brokers et décision du garde-fou « un seul agent actif »
 * (fonctionnelles-esphome_specs §7). Un message conservé `{ enLigne:true, instance, port }` est publié à la connexion ;
 * le testament MQTT (déclaré à la création de la connexion, voir MqttSites) publie `enLigne:false`.
 *
 * La décision est prise sur la présence lue AVANT de publier la sienne : l'agent qui trouve un autre agent en ligne
 * ne traite aucune demande, et la raison est exposée à l'interface. Elle est réévaluée quand une présence change
 * (l'autre agent s'arrête : son testament nous rend la main).
 */

import { presenceSchema, type Presence } from './messages';
import { decider, type Identite, type Decision } from './presence';
import type { SiteBus } from './bus';

export class AgentPresence {
  private readonly vues = new Map<string, Presence | null>();
  private decision: Decision = { actif: true };
  private auChangement: ((d: Decision) => void)[] = [];
  /** Vrai une fois SA présence publiée : l'agent installé ne cède jamais la place à un nouvel arrivant (c'est le nouveau qui se retire). */
  private annonce = false;

  /** `topic` : sujet de présence propre à ce rôle ; `bus` : les brokers sur lesquels il est surveillé et publié. */
  constructor(private readonly topic: string, private readonly moi: Identite, private readonly bus: SiteBus[], private readonly maintenant: () => Date = () => new Date()) {
    for (const b of bus) {
      this.vues.set(b.site, null);
      b.abonner(
        topic,
        presenceSchema,
        (p) => {
          this.vues.set(b.site, p);
          this.reevaluer();
        },
        { vide: () => { this.vues.set(b.site, null); this.reevaluer(); } }
      );
    }
  }

  /** Charge du testament à déclarer à la création de la connexion. */
  static testament(moi: Identite, at: Date): string {
    return JSON.stringify({ v: 1, enLigne: false, instance: moi.instance, port: moi.port, at: at.toISOString() });
  }

  /**
   * Publie SA présence sur chaque broker (après avoir lu celle des autres : à appeler un peu après la connexion).
   * Un agent en retrait n'annonce RIEN (il écraserait la présence conservée de l'agent actif) ; il annonce de lui-même
   * dès qu'il reprend la main.
   */
  annoncer(): void {
    if (!this.decision.actif) return;
    this.annonce = true;
    const presence: Presence = { v: 1, enLigne: true, instance: this.moi.instance, port: this.moi.port, at: this.maintenant().toISOString() };
    for (const b of this.bus) if (b.connecte) b.publier(this.topic, presence, true);
  }

  get etat(): Decision {
    return this.decision;
  }

  surChangement(cb: (d: Decision) => void): void {
    this.auChangement.push(cb);
  }

  private reevaluer(): void {
    // Déjà installé et actif : un nouvel arrivant se retire de lui-même, on ne lui cède pas la place.
    if (this.annonce && this.decision.actif) return;
    // Un seul autre agent en ligne, sur n'importe lequel des brokers surveillés, suffit à nous mettre en retrait.
    let decision: Decision = { actif: true };
    for (const p of this.vues.values()) {
      const d = decider(this.moi, p);
      if (!d.actif) {
        decision = d;
        break;
      }
    }
    const change = JSON.stringify(decision) !== JSON.stringify(this.decision);
    const reprise = decision.actif && !this.decision.actif;
    this.decision = decision;
    if (reprise) this.annoncer();
    if (change) this.auChangement.forEach((cb) => cb(decision));
  }
}
