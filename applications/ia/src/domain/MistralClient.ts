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

    const response = await fetch(`${this.config.mistralBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.mistralApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload)
    });

    if (response.status !== 200 || !response.body) {
      const errorText = await response.text().catch(() => '');
      this.logger.error('MistralClient', `Erreur API Mistral ${response.status}: ${errorText}`);
      return { ok: false, status: response.status, errorText };
    }

    return { ok: true, body: response.body as unknown as AsyncIterable<Uint8Array> };
  }
}
