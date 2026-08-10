/**
 * Client HTTP vers l'API Mistral (chat completions, streaming SSE). Port de la construction de
 * requête de ollama-sim/app/main.py (ollama_options_to_mistral, appel /chat/completions) — le
 * parsing du flux de réponse est délégué à streaming.ts.
 */

import type { Logger } from '../../../core/dist/exports';
import type { IaConfig } from './config-schema';
import type { OllamaMessage } from './types';

export interface MistralToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface MistralOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  seed?: number;
}

export type MistralStreamResult =
  | { ok: true; body: AsyncIterable<Uint8Array> }
  | { ok: false; status: number; errorText: string };

function ollamaOptionsToMistral(options: MistralOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options.temperature !== undefined) out.temperature = options.temperature;
  if (options.top_p !== undefined) out.top_p = options.top_p;
  if (options.num_predict !== undefined) out.max_tokens = options.num_predict;
  if (options.seed !== undefined) out.random_seed = options.seed;
  return out;
}

// Backoff exponentiel sur 429 (rate limit Mistral) : 1s, 2s, 4s, 8s, 16s, 32s, puis plafonné à 60s
// (demande utilisateur, constaté en direct pendant une session de test). RATE_LIMIT_MAX_RETRIES
// borne le nombre total de tentatives après le 429 initial — sans borne, un rate limit persistant
// bloquerait indéfiniment l'appelant (HA attend une réponse synchrone à /api/chat). 6 nouvelles
// tentatives (délais 1+2+4+8+16+32 = 63s cumulés) reste un compromis raisonnable avant d'abandonner
// avec un message clair plutôt que de laisser HA lui-même expirer sur un timeout opaque.
const RATE_LIMIT_BASE_DELAY_MS = 1000;
const RATE_LIMIT_MAX_DELAY_MS = 60000;
const RATE_LIMIT_MAX_RETRIES = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MistralClient {
  constructor(
    private readonly config: IaConfig,
    private readonly logger: Logger
  ) {}

  resolveModel(ollamaModel: string): string {
    return this.config.modelMap[ollamaModel.toLowerCase().trim()] || this.config.defaultMistralModel;
  }

  async streamChat(
    messages: OllamaMessage[],
    mistralModel: string,
    options: MistralOptions,
    tools?: MistralToolSchema[]
  ): Promise<MistralStreamResult> {
    if (!this.config.mistralApiKey) {
      return { ok: false, status: 503, errorText: 'mistralApiKey non configurée' };
    }

    const payload: Record<string, unknown> = {
      model: mistralModel,
      messages,
      stream: true,
      ...ollamaOptionsToMistral(options)
    };
    if (tools?.length) payload.tools = tools;

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.config.mistralBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.mistralApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 429) {
        const errorText = await response.text().catch(() => '');
        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
          this.logger.error('MistralClient', `Rate limit Mistral (429) toujours actif après ${attempt} tentative(s) — abandon.`);
          return {
            ok: false,
            status: 429,
            errorText: 'Mistral a atteint sa limite de requêtes (rate limit) et n\'a pas répondu après plusieurs tentatives. Réessaie dans quelques instants.'
          };
        }
        const delayMs = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
        this.logger.warn('MistralClient', `Rate limit Mistral (429) — nouvelle tentative dans ${delayMs / 1000}s (${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}): ${errorText}`);
        await sleep(delayMs);
        continue;
      }

      if (response.status !== 200 || !response.body) {
        const errorText = await response.text().catch(() => '');
        this.logger.error('MistralClient', `Erreur API Mistral ${response.status}: ${errorText}`);
        return { ok: false, status: response.status, errorText };
      }

      return { ok: true, body: response.body as unknown as AsyncIterable<Uint8Array> };
    }
  }
}
