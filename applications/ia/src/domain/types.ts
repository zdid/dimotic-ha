/**
 * Types du protocole Ollama émulé (specs §2) et des échanges avec l'API Mistral, ainsi que des
 * messages internes échangés avec `planificateur` (miroir des types de cette dernière — pas
 * d'import croisé entre applications, chacune reste autonome).
 */

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: MistralToolCall[];
}

export interface OllamaChatRequestBody {
  model?: string;
  messages?: OllamaMessage[];
  system?: string;
  prompt?: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    seed?: number;
  };
}

export interface MistralToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string | Record<string, unknown> };
}

export interface MistralChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // ⭐ Tokens du prompt servis depuis le cache Mistral (prompt_cache_key, MistralClient.ts) —
    // facturés à 10% du tarif normal. Vérifié en direct (10/08/2026) : présent aussi bien en
    // réponse non-streamée qu'en dernier chunk d'un flux SSE.
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Résultat de l'assemblage complet d'un flux Mistral (streaming.ts). */
export interface AssembledMistralResponse {
  text: string;
  toolCalls: MistralToolCall[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/** Ensemble des types JSON de premier niveau routés vers planificateur (specs §9). */
export const STRUCTURED_TYPES = new Set([
  'planification',
  'macro',
  'macro_ref',
  'condition',
  'sequence',
  'gestion',
  'execution'
]);

/** Réponse corrélée générique — miroir de planificateur/src/domain/types.ts CorrelatedReponse. */
export interface CorrelatedReponse {
  correlation_id: string;
  success: boolean;
  message: string;
  data?: unknown;
}

export interface ExecuterActionParams {
  verbe: string;
  quoi: string;
  lieux: string[];
  valeur?: string | number;
  phrase_originale?: string;
}

export interface ExecutionStep {
  step: number;
  type: 'action' | 'wait';
  order?: string;
  verbe?: string;
  quoi?: string;
  lieux?: string[];
  valeur?: string | number;
  seconds?: number;
  resolved_from?: string;
  delay_before_seconds: number;
}

export interface DeployRequest {
  correlation_id: string;
  trigger_name: string;
  phrase_originale: string;
  macros: unknown[];
  entities_snapshot: unknown[];
  timestamp: string;
  // Renseigné uniquement pour un déclenchement state_change (planificateur) — l'entité réellement
  // à l'origine de ce déclenchement précis, pour qu'une action sans lieu explicite ("éteins-la")
  // sache quoi cibler (voir applications/planificateur/src/domain/types.ts::DeployContext).
  triggered_entity_id?: string;
}

export interface DeployReply extends CorrelatedReponse {
  steps?: ExecutionStep[];
}
