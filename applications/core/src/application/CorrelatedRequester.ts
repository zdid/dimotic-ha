/**
 * Petit helper de corrélation (id + Promise + timeout) au-dessus de
 * IEventBus.emitGeneric/onGeneric/offGeneric — jusqu'au 24/08/2026 dupliqué à l'identique dans
 * `ia`/`planificateur` (dialogue ia↔planificateur : StructuredRouter, ToolExecutor, execution.ts),
 * centralisé ici pour être aussi réutilisé par HaQueryBridge/HaBridgeClient (découplage
 * HaStructureRegistry/HaWsClient, voir fonctionnelles-supervisor_specs). Fonctionne à l'identique
 * qu'un IEventBus soit in-process (EventBus) ou inter-process (IpcEventBus) — c'est cette
 * transparence qui permet à un même code de fonctionner avant et après migration en process séparé.
 */

import { randomUUID } from 'node:crypto';
import type { IEventBus } from './IEventBus';

interface Correlated {
  correlation_id: string;
}

/** Émet `requestEvent` et attend une réponse corrélée sur `replyEvent`, avec timeout. */
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
