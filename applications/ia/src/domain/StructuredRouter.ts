/**
 * Routage du JSON structuré détecté dans une réponse Mistral assemblée (specs §9) vers
 * planificateur, via ia:command / ia:command:reply. Timeout → mode dégradé (texte brut renvoyé à
 * HA par l'appelant, voir IaService).
 */

import type { Logger, IEventBus } from '../../../core/dist/exports';
import type { CorrelatedReponse } from './types';
import { CorrelatedRequester } from './correlation';

export class StructuredRouter {
  private readonly requester: CorrelatedRequester<Record<string, unknown>, CorrelatedReponse>;

  constructor(
    eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly commandTimeoutMs: number
  ) {
    this.requester = new CorrelatedRequester<Record<string, unknown>, CorrelatedReponse>(
      eventBus,
      'ia:command',
      'ia:command:reply'
    );
  }

  /** Retourne la réponse complète de planificateur, ou null en mode dégradé (timeout). */
  async route(structured: Record<string, unknown>): Promise<CorrelatedReponse | null> {
    try {
      return await this.requester.request(structured, this.commandTimeoutMs);
    } catch (error) {
      this.logger.warn('StructuredRouter', `Mode dégradé (planificateur ne répond pas): ${error}`);
      return null;
    }
  }
}
