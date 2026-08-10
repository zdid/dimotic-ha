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
import { MistralClient } from './MistralClient';
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
}

export interface IIaService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class IaService implements IIaService {
  private readonly config: IaConfig;
  private readonly mistralClient: MistralClient;
  private readonly rulesProvider: RulesProvider;
  private readonly toolExecutor: ToolExecutor;
  private readonly structuredRouter: StructuredRouter;
  private readonly deployResponder: DeployResponder;
  private ollamaServer?: OllamaHttpServer;
  private readonly recentExchanges: Exchange[] = [];

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    configProvider: IAppConfigProvider<IaConfig>,
    private readonly haStructureRegistry?: HaStructureRegistry,
    _haWsClient?: HaWsClient // non utilisé directement : ia n'exécute jamais d'action elle-même
  ) {
    this.config = iaConfigSchema.parse(configProvider.getAppConfig());
    this.mistralClient = new MistralClient(this.config, this.logger);
    this.rulesProvider = new RulesProvider(this.resolveRulesPath(), this.logger);
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

  async start(): Promise<void> {
    this.logger.info('IaService', 'Démarrage du service ia...');

    if (!this.haStructureRegistry) {
      this.logger.warn('IaService', 'HaStructureRegistry indisponible — outils de lecture (lister_entites/obtenir_etat) désactivés.');
    }

    this.rulesProvider.load();
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

    this.recordExchange(question, result.finalText, result.intermediateJson, result.planificateurReply);
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
    | { ok: true; finalText: string; promptTokens: number; completionTokens: number; bufferedChunks: string[]; wasStructured: boolean; intermediateJson?: string; planificateurReply?: string }
    | { ok: false; errorMessage: string }
  > {
    let currentMessages = messages;
    const toolCallsUsed: MistralToolCall[] = [];

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.mistralClient.streamChat(currentMessages, mistralModel, options || {}, IA_TOOLS);
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
          promptTokens: assembled.promptTokens,
          completionTokens: assembled.completionTokens,
          bufferedChunks,
          wasStructured: true,
          intermediateJson,
          planificateurReply: reply ? JSON.stringify(reply, null, 2) : undefined
        };
      }

      return {
        ok: true,
        finalText: assembled.text,
        promptTokens: assembled.promptTokens,
        completionTokens: assembled.completionTokens,
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
      planificateurReply: result.planificateurReply
    });
    this.recordExchange(message, result.finalText, result.intermediateJson, result.planificateurReply);
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

  private recordExchange(question: string, response: string, intermediateJson?: string, planificateurReply?: string): void {
    this.recentExchanges.unshift({ at: new Date().toISOString(), question, response, intermediateJson, planificateurReply });
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
      rulesLoaded: this.rulesProvider.getRules().length > 0
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
