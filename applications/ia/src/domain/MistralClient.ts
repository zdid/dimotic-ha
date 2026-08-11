/**
 * Client HTTP vers l'API Mistral (chat completions, streaming SSE). Port de la construction de
 * requête de ollama-sim/app/main.py (ollama_options_to_mistral, appel /chat/completions) — le
 * parsing du flux de réponse est délégué à streaming.ts.
 */

import type { Logger } from '../../../core/dist/exports';
import type { IaConfig } from './config-schema';
import type { OllamaMessage } from './types';
import { RateLimiter } from './RateLimiter';

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

// ⭐ Clé de cache de prompt Mistral (prompt_cache_key), commune à tous les appels de l'app — le
// but est de faire matcher le préfixe partagé (regles_mistral.txt + catalogue quoi/lieux, voir
// RulesProvider) entre TOUS les appels de `ia`, qu'ils viennent de IaService (conversation
// directe) ou de DeployResponder (réinterprétation à l'exécution) : c'est le même contenu de
// message system dans les deux cas, donc la même clé permet aux deux chemins de profiter du
// même cache. Vérifié en direct (10/08/2026) contre l'API Mistral réelle : premier appel avec
// cette clé → `cached_tokens: 0` ; second appel, même contenu, même clé → ~99% du prompt system
// (11232/11263 tokens) servi depuis le cache, facturé à 10% du tarif normal (voir doc Mistral,
// https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching) ; sans la clé,
// aucun cache même avec un contenu strictement identique — confirmé, pas un effet automatique.
export const MISTRAL_PROMPT_CACHE_KEY = 'dimotic-ha-ia';

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
  // Un RateLimiter par modèle Mistral — des modèles différents du même compte ont des quotas
  // indépendants (constaté par l'utilisateur : mistral-small 1,67 req/s / 100k tokens/min,
  // mistral-large 0,25 req/s / 400k tokens/min), créés à la demande (lazy) au premier appel.
  private readonly rateLimiters = new Map<string, RateLimiter>();

  constructor(
    // Getter plutôt qu'un IaConfig figé : IaService réassigne this.config (nouvel objet) au
    // rechargement à chaud (watchConfigFile()) — un champ construit une seule fois par valeur
    // (comme c'était le cas avant) resterait bloqué sur les valeurs de config au démarrage. Même
    // précédent que RulesProvider (getExcludedQuoiIds), nécessaire ici depuis l'ajout du
    // comparatif Claude (provider peut changer sans redémarrage).
    private readonly getConfig: () => IaConfig,
    private readonly logger: Logger
  ) {}

  // `providerOverride` : ignore le `provider` global de la config pour CET appel précis — utilisé
  // par le comparatif Claude/Mistral (IaService.handleCompareCommand) pour interroger les deux
  // fournisseurs dans le même échange, indépendamment de celui actuellement actif en config.
  resolveModel(ollamaModel: string, providerOverride?: 'mistral' | 'anthropic'): string {
    const config = this.getConfig();
    const provider = providerOverride ?? config.provider;
    // Mode comparatif Claude (config-schema.ts::provider) : un seul modèle actif, pas de table de
    // correspondance équivalente à modelMap (celle-ci reste dédiée aux alias envoyés par HA côté
    // Mistral, ex: "mistral" → "mistral-small-latest").
    if (provider === 'anthropic') return config.defaultAnthropicModel;
    return config.modelMap[ollamaModel.toLowerCase().trim()] || config.defaultMistralModel;
  }

  private getRateLimiter(mistralModel: string): RateLimiter {
    let limiter = this.rateLimiters.get(mistralModel);
    if (!limiter) {
      const config = this.getConfig();
      const limits = config.mistralRateLimits[mistralModel] ?? this.fallbackRateLimits();
      if (!config.mistralRateLimits[mistralModel]) {
        this.logger.warn('MistralClient', `Aucune limite configurée pour le modèle "${mistralModel}" (mistralRateLimits) — repli sur le profil le plus restrictif connu (${limits.requestsPerSecond} req/s, ${limits.tokensPerMinute} tokens/min).`);
      }
      limiter = new RateLimiter(mistralModel, limits.requestsPerSecond, limits.tokensPerMinute, this.logger);
      this.rateLimiters.set(mistralModel, limiter);
    }
    return limiter;
  }

  /** Modèle non présent dans mistralRateLimits (nouveau modèle jamais configuré) : le profil le
   *  plus restrictif parmi ceux connus, par prudence — mieux vaut throttler trop qu'encaisser des
   *  429 en boucle sur un modèle dont on ignore les vraies limites. */
  private fallbackRateLimits(): { requestsPerSecond: number; tokensPerMinute: number } {
    const known = Object.values(this.getConfig().mistralRateLimits);
    if (known.length === 0) return { requestsPerSecond: 0.25, tokensPerMinute: 100000 };
    return {
      requestsPerSecond: Math.min(...known.map((l) => l.requestsPerSecond)),
      tokensPerMinute: Math.min(...known.map((l) => l.tokensPerMinute))
    };
  }

  /** À appeler par l'appelant une fois le flux entièrement consommé et l'usage réel connu (Mistral
   *  ne le renvoie qu'à la fin de la réponse, jamais avant) — alimente le throttling préventif des
   *  requêtes suivantes (RateLimiter.waitForSlot), pour CE modèle précis. Voir IaService/DeployResponder. */
  recordTokenUsage(mistralModel: string, promptTokens: number, completionTokens: number): void {
    this.getRateLimiter(mistralModel).recordUsage(promptTokens + completionTokens);
  }

  async streamChat(
    messages: OllamaMessage[],
    mistralModel: string,
    options: MistralOptions,
    tools?: MistralToolSchema[],
    // 'any' force Mistral à appeler un des outils fournis plutôt que répondre directement en
    // texte — utilisé en repli ponctuel par IaService quand un round précédent a répondu
    // "quoi_introuvable" sans jamais avoir vérifié via un outil (règles §0.4, "jamais par simple
    // supposition"). Jamais la valeur par défaut : forcer un outil sur tous les rounds
    // empêcherait Mistral d'atteindre le round final texte/JSON (création de planification,
    // gestion, macro — aucun de ces cas n'appelle d'outil) et le ferait échouer avec "trop
    // d'appels d'outils enchaînés" une fois MAX_TOOL_ROUNDS atteint.
    toolChoice?: 'any',
    // Voir MISTRAL_PROMPT_CACHE_KEY — optionnel pour ne pas casser un appelant qui ne s'en
    // soucierait pas (pas de valeur par défaut ici : chaque appelant choisit explicitement,
    // évite qu'un futur usage générique de ce client cache par erreur un prompt sans rapport).
    promptCacheKey?: string,
    // Voir resolveModel() ci-dessus — même rôle, pour le comparatif Claude/Mistral.
    providerOverride?: 'mistral' | 'anthropic'
  ): Promise<MistralStreamResult> {
    const config = this.getConfig();
    // Mode comparatif Claude (voir config-schema.ts::provider) : même format de requête/réponse
    // (couche de compatibilité OpenAI d'Anthropic), donc réutilise ce client tel quel — seuls
    // base_url/clé/modèle changent. L'en-tête Authorization: Bearer reste correct dans les deux
    // cas (confirmé par la doc Anthropic pour cette couche précise — pas x-api-key, réservé à
    // l'API Messages native, hors scope ici).
    const useAnthropic = (providerOverride ?? config.provider) === 'anthropic';
    const apiKey = useAnthropic ? config.anthropicApiKey : config.mistralApiKey;
    const baseUrl = useAnthropic ? config.anthropicBaseUrl : config.mistralBaseUrl;
    if (!apiKey) {
      return { ok: false, status: 503, errorText: `${useAnthropic ? 'anthropicApiKey' : 'mistralApiKey'} non configurée` };
    }

    const payload: Record<string, unknown> = {
      model: mistralModel,
      messages,
      stream: true,
      ...ollamaOptionsToMistral(options)
    };
    if (tools?.length) payload.tools = tools;
    if (toolChoice && tools?.length) payload.tool_choice = toolChoice;
    // Jamais transmis en mode anthropic — voir commentaire de provider dans config-schema.ts.
    if (promptCacheKey && !useAnthropic) payload.prompt_cache_key = promptCacheKey;

    const rateLimiter = this.getRateLimiter(mistralModel);
    for (let attempt = 0; ; attempt++) {
      await rateLimiter.waitForSlot();

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
