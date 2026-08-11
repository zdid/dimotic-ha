/**
 * IaService — orchestrateur unique de l'application `ia`.
 *
 * Traite chaque requête /api/chat : injection des règles, boucle d'appel d'outils (specs §8),
 * détection du JSON structuré (specs §9) et routage vers planificateur, sinon relais texte.
 *
 * Comme le prototype (ollama-sim/app/main.py), le contenu d'un round Mistral est entièrement
 * assemblé avant d'être renvoyé à HA — jamais streamé chunk par chunk en direct : impossible de
 * savoir avant la fin du round si le texte assemblé sera un JSON structuré (qui ne doit jamais
 * atteindre HA tel quel, specs §9) ou une réponse conversationnelle. L'en-tête anti-buffering
 * (specs §4) évite qu'un proxy intermédiaire bufferise une seconde fois par-dessus.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Response } from 'express';
import type { IEventBus, Logger, IAppConfigProvider, HaStructureRegistry, HaWsClient } from '../../../core/dist/exports';
import { iaConfigSchema, type IaConfig } from './config-schema';
import { MistralClient, MISTRAL_PROMPT_CACHE_KEY } from './MistralClient';
import { RulesProvider } from './rules';
import { ToolExecutor } from './ToolExecutor';
import { StructuredRouter } from './StructuredRouter';
import { DeployResponder } from './DeployResponder';
import { OllamaHttpServer } from './OllamaHttpServer';
import { IA_TOOLS } from './tools';
import { translateMistralStream, extractStructuredJson, makeOllamaDoneChunk, makeOllamaErrorChunk } from './streaming';
import type { OllamaChatRequestBody, OllamaMessage, MistralToolCall } from './types';
import { IA_CLIENT_EVENTS } from './socket-events';

const MAX_TOOL_ROUNDS = 5; // garde-fou — évite une boucle d'outils infinie en cas de réponse aberrante

interface Exchange {
  at: string;
  question: string;
  response: string;
  /** JSON structuré détecté (specs §9) ou appels d'outils (specs §8) — null si conversation simple. */
  intermediateJson?: string;
  /** Réponse brute de planificateur (CorrelatedReponse complète) au JSON structuré ci-dessus —
   *  absente si pas de JSON structuré, ou si planificateur n'a pas répondu (mode dégradé). */
  planificateurReply?: string;
  /** Tokens consommés pour cet échange (cumulés sur tous les rounds Mistral, ex: appels d'outils
   *  enchaînés) — demande utilisateur, absent seulement si l'échange n'a jamais atteint Mistral
   *  (erreur avant le premier appel). */
  promptTokens?: number;
  completionTokens?: number;
  /** ⭐ Portion de promptTokens servie depuis le cache Mistral (prompt_cache_key,
   *  MistralClient.MISTRAL_PROMPT_CACHE_KEY) — facturée à 10% du tarif normal. 0 si aucun hit. */
  cachedTokens?: number;
}

export interface IIaService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class IaService implements IIaService {
  // Plus "readonly" : rechargée à chaud (voir watchConfigFile()) — pour l'instant uniquement
  // excludedQuoiIds en dépend (via le callback passé à RulesProvider ci-dessous), les autres
  // champs (clé Mistral, timeouts...) restent lus une seule fois par les composants déjà
  // construits avec leur valeur au démarrage (mistralClient, toolExecutor...), pas de
  // rechargement à chaud pour eux tant que ça n'a pas été demandé.
  private config: IaConfig;
  private readonly mistralClient: MistralClient;
  private readonly rulesProvider: RulesProvider;
  private readonly toolExecutor: ToolExecutor;
  private readonly structuredRouter: StructuredRouter;
  private readonly deployResponder: DeployResponder;
  private ollamaServer?: OllamaHttpServer;
  private readonly recentExchanges: Exchange[] = [];
  private configWatcher?: fs.FSWatcher;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<IaConfig>,
    private readonly haStructureRegistry?: HaStructureRegistry,
    _haWsClient?: HaWsClient // non utilisé directement : ia n'exécute jamais d'action elle-même
  ) {
    this.config = iaConfigSchema.parse(configProvider.getAppConfig());
    this.mistralClient = new MistralClient(() => this.config, this.logger);
    this.rulesProvider = new RulesProvider(this.resolveRulesPath(), this.logger, this.haStructureRegistry, () => this.config.excludedQuoiIds);
    this.toolExecutor = new ToolExecutor(this.eventBus, this.logger, this.haStructureRegistry, this.config.toolExecuteTimeoutMs);
    this.structuredRouter = new StructuredRouter(this.eventBus, this.logger, this.config.commandTimeoutMs);
    this.deployResponder = new DeployResponder(this.eventBus, this.logger, this.mistralClient, this.rulesProvider, this.config.defaultMistralModel);
  }

  private resolveRulesPath(): string {
    const appRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'applications', 'ia');
    const resolved = path.isAbsolute(this.config.rulesFile) ? this.config.rulesFile : path.join(appRoot, this.config.rulesFile);
    // Modèle intégré (toujours présent, fait partie du code applicatif) — sert uniquement
    // d'amorce si le fichier réellement utilisé (par défaut sous data/ia/, voir config-schema.ts)
    // n'existe pas encore, ex: premier démarrage sur une machine neuve (déploiement Docker,
    // data/ vide). N'écrase jamais un fichier déjà présent à l'emplacement cible.
    this.ensureRulesFileSeeded(resolved, path.join(appRoot, 'rules', 'regles_mistral.txt'));
    return resolved;
  }

  private ensureRulesFileSeeded(targetPath: string, templatePath: string): void {
    if (targetPath === templatePath || fs.existsSync(targetPath) || !fs.existsSync(templatePath)) return;
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(templatePath, targetPath);
      this.logger.info('IaService', `Fichier de règles absent — amorcé depuis le modèle intégré vers ${targetPath}`);
    } catch (error) {
      this.logger.error('IaService', `Échec de la copie du modèle de règles vers ${targetPath}: ${error}`);
    }
  }

  /**
   * ⭐ Surveillance de data/ia/config.yaml (même mécanisme que RulesProvider pour
   * regles_mistral.txt) — rechargement à chaud demandé par l'utilisateur pour `excludedQuoiIds`
   * (config-schema.ts), qui n'est pas éditable depuis le formulaire générique "Paramètres du
   * Module" (aucun type de champ "liste de chaînes" réellement implémenté côté ConfigForm.ts,
   * seul le type "array" — objets complexes — l'est) : ce fichier doit pouvoir être modifié à la
   * main sans redémarrage. `configProvider.reload()` relit et refusionne tous les fichiers
   * data/{app}/config.yaml (ConfigService.reload() → loader.load()), pas seulement celui-ci —
   * réutilise le mécanisme déjà existant plutôt que de reparser le YAML nous-mêmes.
   */
  private watchConfigFile(): void {
    const configPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'ia', 'config.yaml');
    if (!fs.existsSync(configPath)) return; // pas encore créé (jamais sauvegardé) — rien à surveiller

    try {
      this.configWatcher = fs.watch(configPath, () => {
        try {
          this.configProvider.reload();
          this.config = iaConfigSchema.parse(this.configProvider.getAppConfig());
          this.logger.info('IaService', `Configuration rechargée depuis ${configPath} (excludedQuoiIds: ${this.config.excludedQuoiIds.join(', ') || 'aucun'})`);
          this.emitStatus(); // reflète tout changement de `provider` (comparatif Claude) sans attendre un GET_STATUS
        } catch (error) {
          this.logger.error('IaService', `Échec du rechargement de ${configPath}: ${error}`);
        }
      });
    } catch (error) {
      this.logger.warn('IaService', `Surveillance de ${configPath} indisponible: ${error}`);
    }
  }

  async start(): Promise<void> {
    this.logger.info('IaService', 'Démarrage du service ia...');

    if (!this.haStructureRegistry) {
      this.logger.warn('IaService', 'HaStructureRegistry indisponible — outils de lecture (lister_entites/obtenir_etat) désactivés.');
    }

    this.rulesProvider.load();
    this.watchConfigFile();
    this.deployResponder.wire();
    this.setupSocketEventListeners();

    this.ollamaServer = new OllamaHttpServer(this.config, this.logger, (body, res) => this.handleChat(body, res));
    this.ollamaServer.start();

    this.emitStatus();
    this.logger.info('IaService', 'Service ia démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('IaService', 'Arrêt du service ia...');
    this.rulesProvider.stop();
    this.configWatcher?.close();
    this.ollamaServer?.stop();
    this.logger.info('IaService', 'Service ia arrêté');
  }

  // ==========================================================================
  // Traitement d'une requête /api/chat
  // ==========================================================================

  private async handleChat(body: OllamaChatRequestBody, res: Response): Promise<void> {
    const ollamaModel = body.model || 'mistral';
    const mistralModel = this.mistralClient.resolveModel(ollamaModel);

    const messages = this.rulesProvider.inject(this.buildMessages(body));
    const question = extractQuestion(messages);

    const result = await this.runChatRounds(messages, mistralModel, body.options || {});

    if (!result.ok) {
      res.write(makeOllamaErrorChunk(ollamaModel, result.errorMessage));
      res.end();
      return;
    }

    if (result.wasStructured) {
      res.write(JSON.stringify({ model: ollamaModel, created_at: new Date().toISOString(), message: { role: 'assistant', content: result.finalText }, done: false }) + '\n');
    } else {
      for (const chunk of result.bufferedChunks) res.write(chunk);
    }

    res.write(makeOllamaDoneChunk(ollamaModel, result.promptTokens, result.completionTokens));
    res.end();

    this.recordExchange(question, result.finalText, result.intermediateJson, result.planificateurReply, result.promptTokens, result.completionTokens, result.cachedTokens);
  }

  /**
   * Traite une conversation jusqu'à la réponse finale (boucle d'outils + routage JSON structuré,
   * specs §8/§9), sans écrire nulle part — partagé entre /api/chat (formaté en NDJSON par
   * l'appelant) et le test manuel côté UI (specs §13, saisie d'une commande "comme si elle venait
   * de HA").
   */
  private async runChatRounds(
    messages: OllamaMessage[],
    mistralModel: string,
    options: OllamaChatRequestBody['options']
  ): Promise<
    | { ok: true; finalText: string; promptTokens: number; completionTokens: number; cachedTokens: number; bufferedChunks: string[]; wasStructured: boolean; intermediateJson?: string; planificateurReply?: string }
    | { ok: false; errorMessage: string }
  > {
    let currentMessages = messages;
    const toolCallsUsed: MistralToolCall[] = [];
    // Cumulés sur tous les rounds (une boucle d'outils peut appeler Mistral plusieurs fois) —
    // demande utilisateur : afficher le nombre de tokens consommés par appel (échange complet, pas
    // seulement le dernier round, qui sous-comptait sinon un échange avec appel(s) d'outil).
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    // Un seul essai de rattrapage par échange (voir plus bas, détection "quoi_introuvable" non
    // vérifié) — jamais plus, pour ne pas boucler indéfiniment si Mistral persiste malgré tout.
    let quoiIntrouvableRetried = false;
    let forceToolChoice: 'any' | undefined;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.mistralClient.streamChat(currentMessages, mistralModel, options || {}, IA_TOOLS, forceToolChoice, MISTRAL_PROMPT_CACHE_KEY);
      forceToolChoice = undefined; // ne force jamais deux rounds de suite (voir MistralClient.streamChat)
      if (!result.ok) {
        // 429 épuisé après backoff (MistralClient) : errorText est déjà un message clair et
        // final destiné à l'utilisateur — pas la peine de le noyer sous un préfixe technique.
        const errorMessage = result.status === 429 ? result.errorText : `Erreur API Mistral ${result.status}: ${result.errorText}`;
        return { ok: false, errorMessage };
      }

      const gen = translateMistralStream(result.body, mistralModel);
      const bufferedChunks: string[] = [];
      let assembled;
      for (let step = await gen.next(); ; step = await gen.next()) {
        if (step.done) { assembled = step.value; break; }
        bufferedChunks.push(step.value);
      }
      this.mistralClient.recordTokenUsage(mistralModel, assembled.promptTokens, assembled.completionTokens);
      totalPromptTokens += assembled.promptTokens;
      totalCompletionTokens += assembled.completionTokens;
      totalCachedTokens += assembled.cachedTokens;

      if (assembled.toolCalls.length > 0) {
        this.logger.info('IaService', `Round ${round}: ${assembled.toolCalls.length} appel(s) d'outil`);
        toolCallsUsed.push(...assembled.toolCalls);
        currentMessages = [...currentMessages, { role: 'assistant', content: assembled.text, tool_calls: assembled.toolCalls }];
        for (const call of assembled.toolCalls) {
          const toolResult = await this.toolExecutor.execute(call);
          currentMessages = [...currentMessages, { role: 'tool', tool_call_id: call.id, content: toolResult }];
        }
        continue; // rappelle Mistral avec les résultats d'outils (specs §8, étape 4)
      }

      // ⭐ Repli anti-hallucination : Mistral a répondu "quoi_introuvable" (règles §0.4) sans
      // avoir appelé le moindre outil dans cet échange, en violation directe de sa propre règle
      // ("jamais par simple supposition") — constaté en conditions réelles ("allume la salle"
      // refusé à tort, alors que l'area existe bien avec 4 lumières). On ne peut pas forcer
      // tool_choice="any" sur tous les rounds (ça empêcherait Mistral d'atteindre le round final
      // texte/JSON dont ont besoin planification/gestion/macro, qui n'appellent jamais d'outil) —
      // un seul essai de rattrapage, ciblé sur ce motif précis, en relançant CE round avec
      // tool_choice forcé pour obliger une vraie vérification avant de conclure.
      if (!quoiIntrouvableRetried && toolCallsUsed.length === 0 && isUnverifiedQuoiIntrouvable(assembled.text)) {
        quoiIntrouvableRetried = true;
        forceToolChoice = 'any';
        this.logger.warn('IaService', `Round ${round}: "quoi_introuvable" sans vérification par outil — relance forcée (tool_choice=any)`);
        continue;
      }

      // Round final (pas de tool_calls) — décision : JSON structuré ou texte conversationnel.
      const structured = extractStructuredJson(assembled.text);
      const intermediateJson = structured
        ? JSON.stringify(structured, null, 2)
        : (toolCallsUsed.length > 0 ? JSON.stringify(toolCallsUsed, null, 2) : undefined);

      if (structured) {
        const reply = await this.structuredRouter.route(structured);
        return {
          ok: true,
          finalText: reply?.message ?? assembled.text, // null → mode dégradé (specs §9)
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          bufferedChunks,
          wasStructured: true,
          intermediateJson,
          planificateurReply: reply ? JSON.stringify(reply, null, 2) : undefined
        };
      }

      return {
        ok: true,
        finalText: assembled.text,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        cachedTokens: totalCachedTokens,
        bufferedChunks,
        wasStructured: false,
        intermediateJson
      };
    }

    return { ok: false, errorMessage: 'Trop d\'appels d\'outils enchaînés' };
  }

  /**
   * Test manuel (UI, specs §13) — traite une phrase comme si elle venait de HA, sans passer par le
   * serveur HTTP Ollama. Répond via ia:test:reply, et alimente aussi le journal des échanges.
   */
  private async handleTestCommand(message: string): Promise<void> {
    if (!message?.trim()) return;

    const mistralModel = this.mistralClient.resolveModel(this.config.defaultMistralModel);
    const messages = this.rulesProvider.inject([{ role: 'user', content: message }]);

    const result = await this.runChatRounds(messages, mistralModel, {});

    if (!result.ok) {
      this.eventBus.emitGeneric('ia:test:reply', { success: false, response: result.errorMessage });
      return;
    }

    this.eventBus.emitGeneric('ia:test:reply', {
      success: true,
      response: result.finalText,
      intermediateJson: result.intermediateJson,
      planificateurReply: result.planificateurReply,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens
    });
    this.recordExchange(message, result.finalText, result.intermediateJson, result.planificateurReply, result.promptTokens, result.completionTokens, result.cachedTokens);
  }

  /** Réconcilie les deux formats de requête Ollama (specs §4, troisième piège). */
  private buildMessages(body: OllamaChatRequestBody): OllamaMessage[] {
    let messages = [...(body.messages || [])];

    if (messages.length === 0) {
      if (body.system) messages.push({ role: 'system', content: body.system });
      if (body.prompt) messages.push({ role: 'user', content: body.prompt });
    } else if (body.system && !messages.some((m) => m.role === 'system')) {
      messages = [{ role: 'system', content: body.system }, ...messages];
    }

    return messages;
  }

  private recordExchange(question: string, response: string, intermediateJson?: string, planificateurReply?: string, promptTokens?: number, completionTokens?: number, cachedTokens?: number): void {
    this.recentExchanges.unshift({ at: new Date().toISOString(), question, response, intermediateJson, planificateurReply, promptTokens, completionTokens, cachedTokens });
    if (this.recentExchanges.length > 20) this.recentExchanges.length = 20;
    this.eventBus.emitGeneric('ia:exchanges:list', this.recentExchanges);
  }

  // ==========================================================================
  // Statut / UI
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric(IA_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.onGeneric(IA_CLIENT_EVENTS.GET_EXCHANGES, () => {
      this.eventBus.emitGeneric('ia:exchanges:list', this.recentExchanges);
    });
    this.eventBus.onGeneric<{ message: string }>(IA_CLIENT_EVENTS.TEST_SEND, ({ message }) => {
      this.handleTestCommand(message).catch((error) => this.logger.error('IaService', `Erreur test manuel: ${error}`));
    });
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('ia:status', {
      mistralConfigured: !!this.config.mistralApiKey,
      ollamaHttpPort: this.config.ollamaHttpPort,
      rulesLoaded: this.rulesProvider.getRules().length > 0,
      // ⭐ Fournisseur/modèle réellement actif (comparatif Claude, config-schema.ts::provider) —
      // demande utilisateur : le savoir en un coup d'œil dans l'UI plutôt que de le déduire d'un
      // badge toujours étiqueté "Mistral".
      provider: this.config.provider,
      activeModel: this.config.provider === 'anthropic' ? this.config.defaultAnthropicModel : this.config.defaultMistralModel,
      providerConfigured: this.config.provider === 'anthropic' ? !!this.config.anthropicApiKey : !!this.config.mistralApiKey
    });
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<IaConfig>,
    haStructureRegistry?: HaStructureRegistry,
    haWsClient?: HaWsClient
  ): IaService {
    return new IaService(eventBus, logger, configProvider, haStructureRegistry, haWsClient);
  }
}

function extractQuestion(messages: OllamaMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

/** Détecte le format d'erreur "quoi_introuvable" (règles §0.4) dans une réponse texte —
 *  peu importe qu'il soit enrobé de balises markdown ```json ou de texte libre autour. */
function isUnverifiedQuoiIntrouvable(text: string): boolean {
  return /"error"\s*:\s*"quoi_introuvable"/.test(text);
}
