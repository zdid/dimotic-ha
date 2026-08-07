/**
 * Petit helper de corrélation (id + Promise + timeout) au-dessus de
 * EventBus.emitGeneric/onGeneric/offGeneric — dupliqué du pattern identique côté planificateur
 * (pas de mécanisme partagé dans le socle, voir plan d'implémentation).
 */

import { randomUUID } from 'node:crypto';
import type { IEventBus } from '../../../core/dist/exports';

interface Correlated {
  correlation_id: string;
}

export class CorrelatedRequester<TRequest extends object, TReply extends Correlated> {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly requestEvent: string,
    private readonly replyEvent: string
  ) {}

  request(payload: TRequest, timeoutMs: number): Promise<TReply> {
    const correlation_id = randomUUID();

    return new Promise<TReply>((resolve, reject) => {
      const listener = (reply: TReply) => {
        if (reply.correlation_id !== correlation_id) return;
        clearTimeout(timer);
        this.eventBus.offGeneric<TReply>(this.replyEvent, listener);
        resolve(reply);
      };

      const timer = setTimeout(() => {
        this.eventBus.offGeneric<TReply>(this.replyEvent, listener);
        reject(new Error(`Timeout (${timeoutMs}ms) en attente de réponse sur ${this.replyEvent}`));
      }, timeoutMs);

      this.eventBus.onGeneric<TReply>(this.replyEvent, listener);
      this.eventBus.emitGeneric(this.requestEvent, { ...payload, correlation_id });
    });
  }
}
