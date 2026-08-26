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
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { IEventBus, Logger, IAppConfigProvider, HaBridgeClient } from '../../../core/dist/exports';
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
import { validateReferences, buildCorrectionRequestMessage } from './referenceValidator';
import {
  interpretDeterministic,
  loadVocabulaire,
  loadGabarits,
  type Vocabulaire,
  type GabaritDef,
  type DeterministicOutcome
} from './interpreter/index';
import { ensureSeeded, watchFile } from './interpreter/loader';
import { buildLiveCatalogs } from './liveCatalogs';
import { PhraseCache } from './PhraseCache';
import { InterpreterMetrics } from './InterpreterMetrics';

const MAX_TOOL_ROUNDS = 5; // garde-fou — évite une boucle d'outils infinie en cas de réponse aberrante

// ⭐ Assistance Q&R à la création de planification (demande utilisateur, 12/08/2026, option A des
// propositions faites) — durée de vie d'une session de clarification en mémoire (jamais persistée,
// jamais destinée à survivre un redémarrage). Glissante : réinitialisée à chaque tour.
const ASSIST_SESSION_TTL_MS = 10 * 60 * 1000;

type RunChatRoundsResult =
  | {
      ok: true; finalText: string; promptTokens: number; completionTokens: number; cachedTokens: number; bufferedChunks: string[]; wasStructured: boolean; intermediateJson?: string; planificateurReply?: string;
      // ⭐ true si la relance forcée (tool_choice) a dû intervenir au moins une fois dans cet
      // échange — "quoi_introuvable" non vérifié OU référence quoi/lieux/entity_id invalide dans le
      // JSON structuré (voir isUnverifiedQuoiIntrouvable / validateReferences ci-dessous). Demande
      // utilisateur, 12/08/2026 : distinguer "juste du premier coup" de "corrigé après relance" au
      // lieu de mélanger les deux sous un même verdict MATCH dans le comparatif.
      verificationRetried: boolean;
    }
  | { ok: false; errorMessage: string };

/** Un "côté" du comparatif multi-modèles (handleCompareCommand) — voir extractDecision(). */
interface ComparisonSide {
  provider: 'mistral' | 'anthropic';
  model: string;
  label?: string;
  latencyMs: number;
  decision: Record<string, unknown>;
  /** true si ce modèle a dû être relancé (tool_choice forcé) suite à une vérification quoi/lieux/
   *  entity_id ratée avant d'arriver à cette décision — voir RunChatRoundsResult.verificationRetried. */
  corrected: boolean;
}

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
  // ⭐ Sessions d'assistance Q&R (voir ASSIST_SESSION_TTL_MS) — jamais alimentée par un appelant qui
  // ne passe pas `assist: true` (le formulaire générique "Tester une commande" du dashboard ia n'en
  // envoie jamais, comportement strictement inchangé pour lui).
  private readonly assistSessions = new Map<string, { messages: OllamaMessage[]; lastUsedAt: number }>();
  private assistSessionsCleanupTimer?: ReturnType<typeof setInterval>;
  private ollamaServer?: OllamaHttpServer;
  private readonly recentExchanges: Exchange[] = [];
  private configWatcher?: fs.FSWatcher;

  // ⭐ 26/08/2026 — interpréteur déterministe (specs §16) : vocabulaire/gabarits rechargés à chaud,
  // même convention que rulesProvider. Cache local des macros connues, alimenté par le relais
  // `planificateur:macros:list` (bridgedEvents, index.ts) — jamais interrogé à la demande, la donnée
  // arrive par diffusion.
  private interpreterVocabulaire: Vocabulaire = { verbeGroupes: {}, enums: {}, motsIgnores: [], separateurs: [] };
  private interpreterGabarits: Record<string, GabaritDef> = {};
  private interpreterMacros: string[] = [];
  private vocabulaireWatcher?: fs.FSWatcher;
  private gabaritsWatcher?: fs.FSWatcher;
  // ⭐ 26/08/2026, demande utilisateur — cache des 100 dernières phrases résolues + compteurs
  // cache/interpréteur/Mistral, partagés avec DeployResponder (une seule instance de chaque).
  private readonly phraseCache = new PhraseCache();
  private readonly metrics = new InterpreterMetrics();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<IaConfig>,
    private readonly haBridgeClient: HaBridgeClient
  ) {
    this.config = iaConfigSchema.parse(configProvider.getAppConfig());
    this.mistralClient = new MistralClient(() => this.config, this.logger);
    this.rulesProvider = new RulesProvider(this.resolveRulesPath(), this.logger, this.haBridgeClient, () => this.config.excludedQuoiIds);
    this.toolExecutor = new ToolExecutor(this.eventBus, this.logger, this.haBridgeClient, this.config.toolExecuteTimeoutMs);
    this.structuredRouter = new StructuredRouter(this.eventBus, this.logger, this.config.commandTimeoutMs);
    this.deployResponder = new DeployResponder(
      this.eventBus, this.logger, this.mistralClient, this.rulesProvider, this.config.defaultMistralModel, this.haBridgeClient,
      this.phraseCache, this.metrics,
      () => this.interpreterVocabulaire, () => this.interpreterGabarits, () => this.interpreterMacros,
      () => this.config.excludedQuoiIds
    );
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

  /** Chemins des fichiers YAML de l'interpréteur — même amorçage que `resolveRulesPath()`
   *  ci-dessus (modèle intégré sous `applications/ia/interpreter/`, copié vers `data/ia/` au
   *  premier démarrage si absent, jamais écrasé ensuite). */
  private resolveInterpreterPath(dataFileName: string, templateFileName: string): string {
    const appRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'applications', 'ia');
    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'ia');
    const resolved = path.join(dataDir, dataFileName);
    ensureSeeded(resolved, path.join(appRoot, 'interpreter', templateFileName));
    return resolved;
  }

  private loadInterpreterFiles(): void {
    try {
      this.interpreterVocabulaire = loadVocabulaire(this.resolveInterpreterPath('vocabulaire_interpreteur.yaml', 'vocabulaire.yaml'));
      this.interpreterGabarits = loadGabarits(this.resolveInterpreterPath('gabarits_interpreteur.yaml', 'gabarits.yaml'));
    } catch (error) {
      this.logger.error('IaService', `Échec du chargement du vocabulaire/gabarits de l'interpréteur: ${error}`);
    }
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

    await this.haBridgeClient.start();
    if (!this.haBridgeClient.isAvailable()) {
      this.logger.warn('IaService', 'Référentiel HA indisponible — outils de lecture (lister_entites/obtenir_etat) désactivés.');
    }

    this.rulesProvider.load();
    this.watchConfigFile();
    this.deployResponder.wire();
    this.setupSocketEventListeners();

    // ⭐ 26/08/2026 — interpréteur déterministe (specs §16).
    this.loadInterpreterFiles();
    this.vocabulaireWatcher = watchFile(this.resolveInterpreterPath('vocabulaire_interpreteur.yaml', 'vocabulaire.yaml'), () => {
      this.logger.info('IaService', 'Vocabulaire interpréteur modifié, rechargement');
      this.loadInterpreterFiles();
    });
    this.gabaritsWatcher = watchFile(this.resolveInterpreterPath('gabarits_interpreteur.yaml', 'gabarits.yaml'), () => {
      this.logger.info('IaService', 'Gabarits interpréteur modifiés, rechargement');
      this.loadInterpreterFiles();
    });
    // Relais déjà émis par planificateur pour son propre tableau de bord (PlanificateurService.ts)
    // — jamais interrogé à la demande, juste mis en cache ici (bridgedEvents, voir domain/index.ts).
    this.eventBus.onGeneric<Array<{ name: string }>>('planificateur:macros:list', (macros) => {
      this.interpreterMacros = (macros ?? []).map((m) => m.name);
    });

    this.ollamaServer = new OllamaHttpServer(this.config, this.logger, (body, res) => this.handleChat(body, res));
    this.ollamaServer.start();

    // Purge périodique des sessions d'assistance abandonnées (utilisateur qui ferme la modale sans
    // conclure) — la TTL est glissante (réarmée à chaque tour), donc une purge peu fréquente suffit.
    this.assistSessionsCleanupTimer = setInterval(() => this.cleanupAssistSessions(), 60_000);

    this.emitStatus();
    this.logger.info('IaService', 'Service ia démarré');
  }

  private cleanupAssistSessions(): void {
    const cutoff = Date.now() - ASSIST_SESSION_TTL_MS;
    for (const [id, session] of this.assistSessions) {
      if (session.lastUsedAt < cutoff) this.assistSessions.delete(id);
    }
  }

  async stop(): Promise<void> {
    this.logger.info('IaService', 'Arrêt du service ia...');
    this.rulesProvider.stop();
    this.configWatcher?.close();
    this.vocabulaireWatcher?.close();
    this.gabaritsWatcher?.close();
    this.ollamaServer?.stop();
    if (this.assistSessionsCleanupTimer) clearInterval(this.assistSessionsCleanupTimer);
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
    const fresh = isFreshExchange(messages);

    // ⭐ 26/08/2026, demande utilisateur — cache (100 dernières phrases) puis interpréteur
    // déterministe (specs §16), tentés AVANT tout appel Mistral, seulement sur un échange FRAIS
    // (aucun tour d'assistant déjà présent dans la conversation) : une conversation déjà engagée
    // avec Mistral — ex. formulation assistée d'une planification complexe — ne doit jamais être
    // interceptée ici, seule Mistral a le contexte des tours précédents.
    let result = fresh && question ? await this.tryCache(question) : undefined;
    if (!result && fresh && question) result = await this.tryDeterministicPath(question);
    if (!result) {
      this.metrics.recordMistralCall();
      result = await this.runChatRounds(messages, mistralModel, body.options || {});
      if (fresh && question) this.cacheMistralResult(question, result);
    }

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

  /** ⭐ 26/08/2026 — `PhraseCache` : `question` déjà résolue récemment → exécution directe, sans
   *  repasser ni par l'interpréteur ni par Mistral. */
  private async tryCache(question: string): Promise<RunChatRoundsResult | undefined> {
    const outcomes = this.phraseCache.get(question);
    if (!outcomes) return undefined;
    this.metrics.recordCacheHit();
    this.logger.info('IaService', `Cache: "${question}" déjà résolue — exécution directe (${outcomes.length} énoncé(s))`);
    return this.executeOutcomes(outcomes, question);
  }

  /**
   * ⭐ 26/08/2026 — interpréteur déterministe (specs §16). Tente de reconnaître `question` sans
   * aucun appel Mistral ; `undefined` si non reconnu avec confiance (l'appelant retombe sur
   * `runChatRounds`, comportement inchangé). Sur succès, met en cache la décision (même forme que
   * ce que `PhraseCache` rejoue) avant de l'exécuter.
   */
  private async tryDeterministicPath(question: string): Promise<RunChatRoundsResult | undefined> {
    if (!this.haBridgeClient.isAvailable() || Object.keys(this.interpreterGabarits).length === 0) return undefined;

    const live = buildLiveCatalogs(this.haBridgeClient, this.interpreterMacros, this.config.excludedQuoiIds);

    let outcomes: DeterministicOutcome[] | undefined;
    try {
      outcomes = interpretDeterministic(question, this.interpreterVocabulaire, this.interpreterGabarits, live);
    } catch (error) {
      this.logger.error('IaService', `Erreur interpréteur déterministe (repli Mistral): ${error}`);
      return undefined;
    }
    if (!outcomes) return undefined;

    this.metrics.recordInterpreterHit();
    this.logger.info('IaService', `Interpréteur déterministe: "${question}" reconnu sans Mistral (${outcomes.length} énoncé(s))`);
    this.phraseCache.set(question, outcomes);
    return this.executeOutcomes(outcomes, question);
  }

  /** Exécute une décision déjà résolue (`ToolExecutor.executeDirect`/`StructuredRouter.route`,
   *  mêmes canaux que le chemin Mistral existant — aucun nouveau mécanisme d'exécution), qu'elle
   *  vienne d'un match frais de l'interpréteur ou d'une relecture du cache — assemble un résultat
   *  conforme au contrat de `runChatRounds` pour que le reste de `handleChat()`/
   *  `handleTestCommand()` n'ait rien à savoir de ce court-circuit. */
  private async executeOutcomes(outcomes: DeterministicOutcome[], phraseOriginale: string): Promise<RunChatRoundsResult> {
    const messages: string[] = [];
    let planificateurReply: string | undefined;
    for (const outcome of outcomes) {
      if (outcome.kind === 'action') {
        const reply = await this.toolExecutor.executeDirect(outcome.params);
        messages.push(reply.message);
        planificateurReply = reply.message;
      } else if (outcome.kind === 'structured') {
        const reply = await this.structuredRouter.route(outcome.data);
        messages.push(reply ? reply.message : 'Planificateur ne répond pas — commande non transmise.');
        if (reply) planificateurReply = reply.message;
      } else {
        // evenement (si_alors) : entity_id résolu À CHAQUE EXÉCUTION, jamais mis en cache tel
        // quel — seuls trigger_quoi/trigger_lieu (des NOMS, pas un entity_id) sont cachés, cette
        // résolution reste donc toujours fraîche même en relecture depuis PhraseCache.
        const entities = await this.haBridgeClient.getEntitiesByQuoiAndLieux(
          outcome.triggerQuoi ? slugifyInterpreter(outcome.triggerQuoi) : undefined,
          outcome.triggerLieu ? [outcome.triggerLieu] : []
        );
        if (entities.length === 0) {
          messages.push(`Aucune entité trouvée pour déclencher sur "${outcome.triggerQuoi ?? ''} ${outcome.triggerLieu ?? ''}".`);
          continue;
        }
        const structured = {
          type: 'planification',
          name: `interpreteur_evenement_${Date.now()}`,
          active: true,
          phrase_originale: phraseOriginale,
          trigger: { type: 'state_change', entity_id: entities[0].entity_id, to_state: outcome.triggerEtat },
          action: { type: 'action', order: '', verbe: outcome.action.verbe, quoi: outcome.action.quoi, lieux: outcome.action.lieux, valeur: outcome.action.valeur }
        };
        const reply = await this.structuredRouter.route(structured);
        messages.push(reply ? reply.message : 'Planificateur ne répond pas — commande non transmise.');
        if (reply) planificateurReply = reply.message;
      }
    }

    return {
      ok: true,
      finalText: messages.join(' '),
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      bufferedChunks: [],
      wasStructured: true,
      intermediateJson: JSON.stringify(outcomes),
      planificateurReply,
      verificationRetried: false
    };
  }

  /** Met en cache une décision Mistral conclue (voir `extractOutcomesFromMistralResult`) — no-op
   *  silencieux pour tout ce qui n'est pas une conclusion nette (texte, clarification, échec). */
  private cacheMistralResult(question: string, result: RunChatRoundsResult): void {
    if (!result.ok) return;
    const outcomes = extractOutcomesFromMistralResult(result);
    if (outcomes) this.phraseCache.set(question, outcomes);
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
    options: OllamaChatRequestBody['options'],
    // Comparatif Claude/Mistral (handleCompareCommand) — absent (undefined) pour tout appel normal
    // (/api/chat, test manuel), comportement strictement inchangé dans ce cas.
    runOpts?: { providerOverride?: 'mistral' | 'anthropic'; dryRun?: boolean }
  ): Promise<RunChatRoundsResult> {
    let currentMessages = messages;
    const toolCallsUsed: MistralToolCall[] = [];
    // Cumulés sur tous les rounds (une boucle d'outils peut appeler Mistral plusieurs fois) —
    // demande utilisateur : afficher le nombre de tokens consommés par appel (échange complet, pas
    // seulement le dernier round, qui sous-comptait sinon un échange avec appel(s) d'outil).
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    // Un seul essai de rattrapage par échange (voir plus bas : détection "quoi_introuvable" non
    // vérifié, OU référence quoi/lieux/entity_id non vérifiée dans un JSON structuré) — jamais
    // plus, pour ne pas boucler indéfiniment si Mistral persiste malgré tout.
    let verificationRetried = false;
    let forceToolChoice: 'any' | undefined;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.mistralClient.streamChat(currentMessages, mistralModel, options || {}, IA_TOOLS, forceToolChoice, MISTRAL_PROMPT_CACHE_KEY, runOpts?.providerOverride);
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
        this.logger.info('IaService', `Round ${round}: ${assembled.toolCalls.length} appel(s) d'outil (${assembled.toolCalls.map((c) => `${c.function.name}(${typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments)})`).join(', ')})`);
        toolCallsUsed.push(...assembled.toolCalls);
        currentMessages = [...currentMessages, { role: 'assistant', content: assembled.text, tool_calls: assembled.toolCalls }];
        for (const call of assembled.toolCalls) {
          const toolResult = await this.toolExecutor.execute(call, runOpts?.dryRun);
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
      if (!verificationRetried && toolCallsUsed.length === 0 && isUnverifiedQuoiIntrouvable(assembled.text)) {
        verificationRetried = true;
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
        // ⭐ Vérification des références HA (quoi/lieux, entity_id de déclencheur state_change)
        // AVANT tout dispatch — bug réel constaté (comparatif Claude/Mistral, 11/08/2026) : sans
        // ce garde-fou, une condition (state_change) référençant une entité inventée était
        // transmise telle quelle à planificateur, produisant une planification qui ne se déclenche
        // jamais, en silence. Même principe qu'isUnverifiedQuoiIntrouvable ci-dessus : un seul
        // essai de rattrapage forcé (tool_choice=any), sinon on refuse et on demande une correction
        // plutôt que de créer/exécuter sur une référence non vérifiée.
        const problems = await validateReferences(structured, this.haBridgeClient);
        if (problems.length > 0 && !verificationRetried) {
          verificationRetried = true;
          forceToolChoice = 'any';
          this.logger.warn('IaService', `Round ${round}: référence(s) non vérifiée(s) dans le JSON structuré (${problems.map((p) => p.detail).join(' | ')}) — relance forcée (tool_choice=any)`);
          continue;
        }
        if (problems.length > 0) {
          this.logger.warn('IaService', `Round ${round}: référence(s) toujours invalide(s) après vérification — demande de correction plutôt que création/exécution (${problems.map((p) => p.detail).join(' | ')})`);
          return {
            ok: true,
            finalText: buildCorrectionRequestMessage(problems),
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            cachedTokens: totalCachedTokens,
            bufferedChunks,
            wasStructured: false,
            intermediateJson,
            verificationRetried
          };
        }

        // dry-run (comparatif) : jamais transmis à planificateur, voir ToolExecutor.execute pour
        // le même principe côté executer_action.
        const reply = runOpts?.dryRun ? null : await this.structuredRouter.route(structured);
        return {
          ok: true,
          finalText: reply?.message ?? assembled.text, // null → mode dégradé (specs §9)
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          bufferedChunks,
          wasStructured: true,
          intermediateJson,
          planificateurReply: reply ? JSON.stringify(reply, null, 2) : undefined,
          verificationRetried
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
        intermediateJson,
        verificationRetried
      };
    }

    this.logger.warn('IaService', `Trop d'appels d'outils enchaînés (${MAX_TOOL_ROUNDS} rounds) — historique: ${toolCallsUsed.map((c) => c.function.name).join(' -> ')}`);
    return { ok: false, errorMessage: 'Trop d\'appels d\'outils enchaînés' };
  }

  /**
   * Test manuel (UI, specs §13) — traite une phrase comme si elle venait de HA, sans passer par le
   * serveur HTTP Ollama. Répond via ia:test:reply, et alimente aussi le journal des échanges.
   *
   * ⭐ Assistance Q&R à la création (demande utilisateur, 12/08/2026) — `assist: true` (envoyé
   * uniquement par la modale "Nouvelle planification" de `planificateur`, jamais par le formulaire
   * générique "Tester une commande" de ce dashboard) fait persister l'historique de conversation
   * entre deux tours tant que l'échange n'a pas abouti à une planification réellement créée :
   * `regles_mistral.txt` encourage déjà Mistral à poser une question de clarification en texte
   * libre plutôt que de refuser sans appel — jusqu'ici cette question tombait dans le vide, chaque
   * appel repartant de zéro sans le contexte de ce qui avait déjà été dit.
   */
  private async handleTestCommand(message: string, sessionId?: string, assist?: boolean): Promise<void> {
    if (!message?.trim()) return;

    const mistralModel = this.mistralClient.resolveModel(this.config.defaultMistralModel);
    const existing = sessionId ? this.assistSessions.get(sessionId) : undefined;
    const messages = existing
      ? [...existing.messages, { role: 'user' as const, content: message }]
      : this.rulesProvider.inject([{ role: 'user', content: message }]);

    // ⭐ 26/08/2026, demande utilisateur — même court-circuit cache/déterministe que handleChat()
    // (specs §16), seulement sur une conversation fraîche (pas de session d'assistance en cours :
    // une clarification déjà engagée reste un dialogue Mistral, jamais interceptée ici — c'est
    // exactement l'assistance Q&R prévue pour formuler une planification complexe).
    let result = !existing ? await this.tryCache(message) : undefined;
    if (!result && !existing) result = await this.tryDeterministicPath(message);
    if (!result) {
      this.metrics.recordMistralCall();
      result = await this.runChatRounds(messages, mistralModel, {});
      if (!existing) this.cacheMistralResult(message, result);
    }

    if (!result.ok) {
      // Échec technique (Mistral injoignable...) : la session n'est pas perdue, l'utilisateur peut
      // réessayer le même tour — seule une conclusion réussie ou l'absence de mode assistance la ferme.
      this.eventBus.emitGeneric('ia:test:reply', { success: false, response: result.errorMessage, sessionId });
      return;
    }

    let planifOk: boolean | undefined;
    try {
      planifOk = result.planificateurReply ? JSON.parse(result.planificateurReply).success : undefined;
    } catch { /* indéterminé, traité comme non conclu */ }
    // ⭐ Une action immédiate (specs §9) ne produit jamais de JSON structuré (wasStructured reste
    // faux) — sans ce cas, une session restait ouverte indéfiniment après une action réellement
    // exécutée (bug trouvé en testant : "allume le sauna du salon" → clarification → "utilise la
    // lumière" → executer_action exécuté pour de vrai, mais wasStructured=false laissait la session
    // active). Un tool_call lister_entites/obtenir_etat seul (lecture, pas d'action) ne conclut pas.
    let usedExecuterAction = false;
    if (!result.wasStructured && result.intermediateJson) {
      try {
        const calls = JSON.parse(result.intermediateJson);
        if (Array.isArray(calls)) usedExecuterAction = calls.some((c) => c?.function?.name === 'executer_action');
      } catch { /* pas un tableau de tool_calls (texte simple) — pas d'action exécutée */ }
    }
    const concluded = (result.wasStructured && planifOk !== false) || usedExecuterAction;

    let replySessionId: string | undefined;
    if (assist && !concluded) {
      const id = sessionId ?? randomUUID();
      this.assistSessions.set(id, { messages: [...messages, { role: 'assistant', content: result.finalText }], lastUsedAt: Date.now() });
      replySessionId = id;
    } else if (sessionId) {
      this.assistSessions.delete(sessionId);
    }

    this.eventBus.emitGeneric('ia:test:reply', {
      success: true,
      response: result.finalText,
      intermediateJson: result.intermediateJson,
      planificateurReply: result.planificateurReply,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens,
      sessionId: replySessionId
    });
    this.recordExchange(message, result.finalText, result.intermediateJson, result.planificateurReply, result.promptTokens, result.completionTokens, result.cachedTokens);
  }

  /**
   * ⭐ Comparatif multi-modèles (demande utilisateur, 11-12/08/2026) — envoie la même phrase à tous
   * les modèles de `config.compareModels` (4 par défaut : Mistral Small/Medium, Claude
   * Haiku/Sonnet, mêmes clés API que le reste de l'app). AUCUN côté n'exécute réellement ni ne
   * transmet à planificateur (toujours dry-run, voir runChatRounds/ToolExecutor.execute) — pur
   * outil d'observation, jamais une action, quel que soit le fournisseur actif en config. Compare
   * la décision structurée (verbe/quoi/lieux ou JSON planification/gestion/macro), pas le texte, et
   * le temps de réponse de chacun ; journalise une ligne dans data/ia/comparatif.log (tail -f
   * dessus, demande utilisateur).
   */
  private async handleCompareCommand(message: string): Promise<void> {
    if (!message?.trim()) return;

    const messages = this.rulesProvider.inject([{ role: 'user', content: message }]);

    const runSide = async (candidate: IaConfig['compareModels'][number]): Promise<ComparisonSide> => {
      const startedAt = Date.now();
      const result = await this.runChatRounds(messages, candidate.model, {}, { providerOverride: candidate.provider, dryRun: true });
      const latencyMs = Date.now() - startedAt;
      return {
        provider: candidate.provider,
        model: candidate.model,
        label: candidate.label,
        latencyMs,
        decision: extractDecision(result),
        // ⭐ demande utilisateur, 12/08/2026 : distinguer un modèle juste du premier coup d'un
        // modèle qui a dû être repris par la vérification quoi/lieux/entity_id — voir
        // RunChatRoundsResult.verificationRetried.
        corrected: result.ok && result.verificationRetried
      };
    };

    // En parallèle : rate limiter séparé par modèle dans MistralClient, pas d'interférence entre
    // candidats — le temps total du comparatif reste celui du plus lent plutôt que la somme.
    const sides = await Promise.all(this.config.compareModels.map(runSide));

    // Pas de "côté actif" ici (tout est dry-run) — le premier candidat sert de référence pour le
    // résumé match/diff, mais la ligne de log conserve la décision complète de chaque côté.
    const [reference, ...rest] = sides;
    const diffsPerSide = rest.map((s) => ({ label: s.label ?? s.model, diffs: reference ? diffDecisions(reference.decision, s.decision) : [] }));
    // ⭐ Un MATCH obtenu uniquement parce qu'un modèle a été rattrapé par la relance forcée n'est
    // PAS un vrai match "du premier coup" — demande utilisateur : le faire vraiment peser dans le
    // verdict, pas juste l'annoter en aparté. anyCorrected distingue ces deux cas dans le résumé.
    const anyCorrected = sides.some((s) => s.corrected);
    const allMatch = diffsPerSide.every((d) => d.diffs.length === 0);

    this.logComparison(message, sides, diffsPerSide, allMatch);

    this.eventBus.emitGeneric('ia:compare:reply', {
      question: message,
      sides,
      match: allMatch,
      anyCorrected,
      diffsPerSide
    });
  }

  /** Une ligne par comparaison, format compact à plat — pensé pour `tail -f data/ia/comparatif.log`. */
  private logComparison(question: string, sides: ComparisonSide[], diffsPerSide: { label: string; diffs: string[] }[], allMatch: boolean): void {
    const fmtSide = (s: ComparisonSide) => `${s.label ?? s.model}(${s.provider}:${s.model}) ${s.latencyMs}ms${s.corrected ? ' [corrigé après vérification]' : ''} ${JSON.stringify(s.decision)}`;
    const anyCorrected = sides.some((s) => s.corrected);
    const verdict = allMatch
      ? (anyCorrected ? `MATCH (mais ${sides.filter((s) => s.corrected).map((s) => s.label ?? s.model).join(', ')} corrigé après vérification — pas juste du premier coup)` : 'MATCH')
      : `DIFF(${diffsPerSide.filter((d) => d.diffs.length > 0).map((d) => `${d.label}: ${d.diffs.join('; ')}`).join(' || ')})`;
    const line = `${new Date().toISOString()} | "${question}" | ${sides.map(fmtSide).join(' | ')} | ${verdict}\n`;
    const logPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'ia', 'comparatif.log');
    try {
      fs.appendFileSync(logPath, line);
    } catch (error) {
      this.logger.error('IaService', `Échec d'écriture dans ${logPath}: ${error}`);
    }
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
    this.emitStatus(); // ⭐ 26/08/2026 — rafraîchit les compteurs cache/interpréteur/Mistral affichés
  }

  // ==========================================================================
  // Statut / UI
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric(IA_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.onGeneric(IA_CLIENT_EVENTS.GET_EXCHANGES, () => {
      this.eventBus.emitGeneric('ia:exchanges:list', this.recentExchanges);
    });
    this.eventBus.onGeneric<{ message: string; sessionId?: string; assist?: boolean }>(IA_CLIENT_EVENTS.TEST_SEND, ({ message, sessionId, assist }) => {
      this.handleTestCommand(message, sessionId, assist).catch((error) => this.logger.error('IaService', `Erreur test manuel: ${error}`));
    });
    this.eventBus.onGeneric<{ message: string }>(IA_CLIENT_EVENTS.COMPARE_SEND, ({ message }) => {
      this.handleCompareCommand(message).catch((error) => this.logger.error('IaService', `Erreur comparatif: ${error}`));
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
      providerConfigured: this.config.provider === 'anthropic' ? !!this.config.anthropicApiKey : !!this.config.mistralApiKey,
      // ⭐ 26/08/2026, demande utilisateur — combien de phrases traitées par le cache, l'interpréteur
      // déterministe, ou Mistral/Claude, depuis le démarrage (en mémoire, remis à zéro à chaque
      // redémarrage). cacheSize : nombre d'entrées actuellement en cache (sur 100 max).
      cacheHits: this.metrics.cacheHits,
      interpreterHits: this.metrics.interpreterHits,
      mistralCalls: this.metrics.mistralCalls,
      cacheSize: this.phraseCache.size()
    });
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<IaConfig>,
    haBridgeClient: HaBridgeClient
  ): IaService {
    return new IaService(eventBus, logger, configProvider, haBridgeClient);
  }
}

/** Mirror volontaire de `slugify()` déjà dupliquée dans `ToolExecutor.ts`/`resolution.ts` (pas
 *  d'import croisé entre modules internes non plus, même principe que pour les applications). */
function slugifyInterpreter(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** ⭐ 26/08/2026, demande utilisateur — une conversation est "fraîche" si aucun tour d'assistant
 *  n'y figure déjà. Une conversation déjà engagée avec Mistral (ex. formulation assistée d'une
 *  planification complexe) ne doit JAMAIS être interceptée par le cache ni l'interpréteur
 *  déterministe — seule Mistral connaît le contexte des tours précédents. */
function isFreshExchange(messages: OllamaMessage[]): boolean {
  return !messages.some((m) => m.role === 'assistant');
}

/** ⭐ 26/08/2026 — extrait la décision d'un résultat Mistral réussi et CONCLU (action réellement
 *  exécutée, ou JSON structuré transmis avec succès à planificateur) sous la même forme que
 *  l'interpréteur déterministe, pour alimenter `PhraseCache` uniformément quelle que soit
 *  l'origine de la décision. `undefined` pour tout ce qui n'est pas une conclusion nette (texte
 *  conversationnel, demande de clarification, refus, échec) — même niveau de rigueur que
 *  `handleTestCommand`'s `concluded`/`usedExecuterAction`, jamais un résultat approximatif mis en
 *  cache. */
function extractOutcomesFromMistralResult(result: RunChatRoundsResult): DeterministicOutcome[] | undefined {
  if (!result.ok || !result.intermediateJson) return undefined;

  if (result.wasStructured) {
    if (result.planificateurReply) {
      try {
        if (JSON.parse(result.planificateurReply).success === false) return undefined;
      } catch { /* pas de statut exploitable — on ne bloque pas la mise en cache pour ça */ }
    }
    try {
      return [{ kind: 'structured', data: JSON.parse(result.intermediateJson) }];
    } catch {
      return undefined;
    }
  }

  try {
    const calls = JSON.parse(result.intermediateJson) as MistralToolCall[];
    if (!Array.isArray(calls)) return undefined;
    const actionCall = [...calls].reverse().find((c) => c?.function?.name === 'executer_action');
    if (!actionCall) return undefined;
    const args = typeof actionCall.function.arguments === 'string' ? JSON.parse(actionCall.function.arguments) : actionCall.function.arguments;
    if (!args?.verbe || !args?.quoi) return undefined;
    return [{ kind: 'action', params: { verbe: args.verbe, quoi: args.quoi, lieux: Array.isArray(args.lieux) ? args.lieux : [], valeur: args.valeur } }];
  } catch {
    return undefined;
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

/** Normalise le résultat d'un round (comparatif Claude/Mistral, handleCompareCommand) en une
 *  décision structurée comparable champ à champ — jamais le texte final, qui varie d'une IA à
 *  l'autre même à décision identique (formulations différentes). Trois cas : (1) un appel d'outil
 *  executer_action a eu lieu → {kind:'action', verbe, quoi, lieux, valeur} ; (2) un JSON structuré
 *  (planification/gestion/macro/...) a été produit → l'objet tel quel ; (3) ni l'un ni l'autre
 *  (réponse conversationnelle, quoi_introuvable, erreur) → {kind:'texte'|'erreur', ...}. */
function extractDecision(result: RunChatRoundsResult): Record<string, unknown> {
  if (!result.ok) return { kind: 'erreur', message: result.errorMessage };
  if (!result.intermediateJson) return { kind: 'texte', reponse: result.finalText };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.intermediateJson);
  } catch {
    return { kind: 'texte', reponse: result.finalText };
  }

  if (Array.isArray(parsed)) {
    const actionCall = (parsed as MistralToolCall[]).find((c) => c?.function?.name === 'executer_action');
    if (!actionCall) return { kind: 'texte', reponse: result.finalText };
    const args = typeof actionCall.function.arguments === 'string'
      ? JSON.parse(actionCall.function.arguments)
      : actionCall.function.arguments;
    return { kind: 'action', verbe: args?.verbe, quoi: args?.quoi, lieux: args?.lieux, valeur: args?.valeur };
  }

  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  return { kind: 'texte', reponse: result.finalText };
}

/** Diff champ à champ (pas texte à texte) entre deux décisions normalisées — clé absente d'un côté
 *  traitée comme `undefined`, pas ignorée (une IA qui omet un champ que l'autre renseigne EST une
 *  différence de comportement, pas un détail à masquer). */
function diffDecisions(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const key of keys) {
    const av = JSON.stringify(a[key]);
    const bv = JSON.stringify(b[key]);
    if (av !== bv) diffs.push(`${key}: ${av} ≠ ${bv}`);
  }
  return diffs;
}
