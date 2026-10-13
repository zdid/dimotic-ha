/**
 * Bus d'un site — enveloppe fine autour d'une connexion MQTT : publication et lecture de messages JSON versionnés,
 * conservés ou non, suppression d'un message conservé. Un bus par broker de site (sites étanches : jamais un message
 * d'un site sur le broker d'un autre).
 *
 * `Transport` est l'interface minimale utilisée ; en production elle est fournie par `MqttTransport` du cœur
 * (reconnexion, abonnements rejoués, file courte des publications), dans les tests par un faux broker en mémoire.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import { lire } from './messages';

export interface Transport {
  connect(): void;
  disconnect(): void;
  publish(topic: string, payload: string | Buffer, qos?: 0 | 1, retain?: boolean): void;
  subscribe(topic: string, qos?: 0 | 1): void;
  onMessage(cb: (m: { topic: string; payload: Buffer | string; retain: boolean }) => void): void;
  onConnect(cb: () => void): void;
  onDisconnect(cb: (reason?: string) => void): void;
  getConnected(): boolean;
}

/** Filtre MQTT (`+` un niveau, `#` le reste) appliqué à un sujet. */
export function correspond(filtre: string, sujet: string): boolean {
  const f = filtre.split('/');
  const t = sujet.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export type Gestionnaire<T> = (valeur: T, topic: string) => void;

export class SiteBus {
  private readonly abonnes: { filtre: string; schema: ZodType<any, ZodTypeDef, unknown>; vide?: (topic: string) => void; cb: Gestionnaire<any>; invalide?: (topic: string, raison: string) => void }[] = [];
  private readonly auConnect: (() => void)[] = [];

  constructor(public readonly site: string, private readonly transport: Transport) {
    transport.onMessage((m) => this.recevoir(m.topic, m.payload));
    transport.onConnect(() => this.auConnect.forEach((cb) => cb()));
  }

  connecter(): void {
    this.transport.connect();
  }

  deconnecter(): void {
    this.transport.disconnect();
  }

  get connecte(): boolean {
    return this.transport.getConnected();
  }

  /** Appelé à chaque (re)connexion — les abonnements sont rejoués par le transport, pas les publications d'état. */
  surConnexion(cb: () => void): void {
    this.auConnect.push(cb);
  }

  /**
   * Abonne un gestionnaire à un filtre de sujets. `vide` est appelé quand un message conservé est supprimé
   * (charge vide) ; `invalide` quand une charge ne respecte pas le schéma (jamais une exception).
   */
  abonner<T>(
    filtre: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    cb: Gestionnaire<T>,
    options: { vide?: (topic: string) => void; invalide?: (topic: string, raison: string) => void } = {}
  ): void {
    this.abonnes.push({ filtre, schema, cb, vide: options.vide, invalide: options.invalide });
    this.transport.subscribe(filtre, 1);
  }

  publier(topic: string, valeur: unknown, conserve: boolean): void {
    this.transport.publish(topic, JSON.stringify(valeur), 1, conserve);
  }

  /** Supprime un message conservé (charge vide conservée). */
  supprimer(topic: string): void {
    this.transport.publish(topic, '', 1, true);
  }

  private recevoir(topic: string, charge: Buffer | string): void {
    for (const a of this.abonnes) {
      if (!correspond(a.filtre, topic)) continue;
      const r = lire(a.schema, charge);
      if (r.ok) a.cb(r.valeur, topic);
      else if (r.raison === 'vide') a.vide?.(topic);
      else a.invalide?.(topic, r.raison);
    }
  }
}
