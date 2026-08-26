/**
 * Répond aux demandes de réinterprétation à l'exécution (planificateur:deploy, specs §10) —
 * jamais initié par `ia` lui-même. Construit un message décrivant le déclenchement (phrase
 * d'origine, macros connues, état HA, horodatage) selon le format attendu par regles_mistral.txt
 * §4 "Règles de déploiement à l'exécution", interroge Mistral, et renvoie la séquence plate reçue.
 *
 * Note : regles_mistral.txt (copié tel quel du prototype, évolution séparée — voir
 * PROMPT_CLAUDE_REGLES_MISTRAL.md) ne produit pour l'instant que des étapes `order` en langage
 * naturel, pas encore verbe/quoi/lieux structurés (§4 du prompt actuel, exemple "Exemple 3"). Tant
 * que le prompt n'aura pas été mis à jour pour les inclure, resolution.ts (côté planificateur) ne
 * pourra jamais peupler resolved_service_call et chaque étape retombera sur le repli
 * processConversation — comportement correct, pas une erreur d'implémentation ici.
 */

import type { Logger, IEventBus, HaBridgeClient } from '../../../core/dist/exports';
import type { DeployRequest, DeployReply, ExecutionStep, OllamaMessage } from './types';
import type { MistralClient } from './MistralClient';
import { MISTRAL_PROMPT_CACHE_KEY } from './MistralClient';
import type { RulesProvider } from './rules';
import { translateMistralStream, stripMarkdownFences } from './streaming';
import { validateReferences, buildCorrectionRequestMessage } from './referenceValidator';
import { interpretDeterministic, outcomesToExecutionSteps, type Vocabulaire, type GabaritDef, type DeterministicOutcome } from './interpreter/index';
import { buildLiveCatalogs } from './liveCatalogs';
import type { PhraseCache } from './PhraseCache';
import type { InterpreterMetrics } from './InterpreterMetrics';

export class DeployResponder {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly mistralClient: MistralClient,
    private readonly rulesProvider: RulesProvider,
    private readonly defaultModel: string,
    // ⭐ Même vérification quoi/lieux/entity_id qu'IaService.runChatRounds (referenceValidator.ts)
    // — "d'où qu'ils viennent" (demande utilisateur, 12/08/2026) : ce chemin-ci (réinterprétation à
    // l'exécution, specs §10) produit aussi du JSON structuré, jamais vérifié jusqu'ici contre le
    // référentiel HA réel avant transmission à planificateur.
    private readonly haBridgeClient: HaBridgeClient,
    // ⭐ 26/08/2026, demande utilisateur — cache + interpréteur déterministe tentés avant Mistral,
    // ICI AUSSI (un déclenchement planifié re-sollicitait Mistral à chaque tir, même pour une
    // phrase déjà résolue mille fois) : instance partagée avec IaService (une seule PhraseCache/
    // InterpreterMetrics pour tout le service), vocabulaire/gabarits/macros lus via callback pour
    // toujours refléter le rechargement à chaud d'IaService sans dupliquer sa surveillance de
    // fichier.
    private readonly phraseCache: PhraseCache,
    private readonly metrics: InterpreterMetrics,
    private readonly getVocabulaire: () => Vocabulaire,
    private readonly getGabarits: () => Record<string, GabaritDef>,
    private readonly getMacros: () => string[],
    private readonly getExcludedQuoiIds: () => string[]
  ) {}

  wire(): void {
    this.eventBus.onGeneric<DeployRequest>('planificateur:deploy', (req) => {
      this.handle(req).catch((error) => this.logger.error('DeployResponder', `Erreur de déploiement: ${error}`));
    });
  }

  private async handle(req: DeployRequest): Promise<void> {
    this.logger.info('DeployResponder', `Réinterprétation demandée: "${req.trigger_name}"`);

    // ⭐ 26/08/2026, demande utilisateur — cache puis interpréteur déterministe AVANT Mistral : une
    // planification récurrente ("tous les jours à midi...") ressollicitait Mistral à IDENTIQUE à
    // chaque déclenchement, alors que `phrase_originale` ne change jamais entre deux tirs.
    const cached = this.phraseCache.get(req.phrase_originale);
    if (cached) {
      const steps = outcomesToExecutionSteps(cached) as ExecutionStep[] | undefined;
      if (steps && (await this.tryReplyWithSteps(req, steps, 'cache'))) return;
    }

    const interpreted = this.tryInterpreter(req.phrase_originale);
    if (interpreted) {
      const steps = outcomesToExecutionSteps(interpreted) as ExecutionStep[] | undefined;
      if (steps) {
        this.phraseCache.set(req.phrase_originale, interpreted);
        if (await this.tryReplyWithSteps(req, steps, 'interpréteur')) return;
      }
    }

    this.metrics.recordMistralCall();

    const now = new Date();
    const triggerMessage: OllamaMessage = {
      role: 'user',
      // Préfixe explicite nécessaire : un JSON brut sans contexte n'est pas reconnu de façon
      // fiable comme la notification de déclenchement décrite en section 4 des règles — Mistral y
      // répondait parfois par du texte conversationnel au lieu du JSON de séquence plate attendu.
      content: 'Déclenchement de planification — applique les règles de déploiement à l\'exécution '
        + '(section 4). Réponds UNIQUEMENT avec le JSON {"execution": {...}} correspondant, aucun '
        + 'texte libre. Contexte :\n' + JSON.stringify({
          declenchement: {
            trigger_name: req.trigger_name,
            phrase_originale: req.phrase_originale,
            triggered_at: req.timestamp,
            macros: req.macros,
            entites: req.entities_snapshot,
            heure: now.toTimeString().slice(0, 5),
            jour: now.toLocaleDateString('fr-FR', { weekday: 'long' }),
            date: now.toISOString().slice(0, 10),
            // Uniquement pour un déclencheur state_change (section 3.9) — l'entité réellement à
            // l'origine de CE déclenchement précis, absent pour tout autre type de déclencheur.
            ...(req.triggered_entity_id ? { triggered_entity_id: req.triggered_entity_id } : {})
          }
        })
    };

    const messages = this.rulesProvider.inject([triggerMessage]);
    const mistralModel = this.mistralClient.resolveModel(this.defaultModel);

    const result = await this.mistralClient.streamChat(messages, mistralModel, {}, undefined, undefined, MISTRAL_PROMPT_CACHE_KEY);
    if (!result.ok) {
      this.reply(req.correlation_id, false, `Erreur Mistral ${result.status}: ${result.errorText}`);
      return;
    }

    const gen = translateMistralStream(result.body, this.defaultModel);
    let assembled;
    // Réinterprétation interne : les chunks intermédiaires ne sont jamais streamés (pas d'appel
    // HA en cours ici), seul le texte final assemblé (valeur de retour du générateur) importe.
    for (let step = await gen.next(); ; step = await gen.next()) {
      if (step.done) { assembled = step.value; break; }
    }
    this.mistralClient.recordTokenUsage(mistralModel, assembled.promptTokens, assembled.completionTokens);

    const parsed = this.parseExecution(assembled.text);
    if (!parsed) {
      this.reply(req.correlation_id, false, `Réponse non exploitable de Mistral: ${assembled.text.slice(0, 200)}`);
      return;
    }

    // Pas de boucle de relance ici (contrairement à IaService.runChatRounds) — DeployResponder est
    // un aller-retour unique, pas une boucle d'outils. Référence non vérifiée → on refuse plutôt
    // que d'exécuter une étape sur une entité inventée.
    const problems = await validateReferences(parsed, this.haBridgeClient);
    if (problems.length > 0) {
      this.logger.warn('DeployResponder', `Référence(s) non vérifiée(s) dans la séquence produite (${problems.map((p) => p.detail).join(' | ')}) — refusée.`);
      // ⭐ invalidReferences=true (demande utilisateur, 12/08/2026) — distingue ce refus précis
      // (quoi/lieux/entity_id invalides) d'un échec générique (timeout, JSON inexploitable) : côté
      // planificateur, seul celui-ci doit positionner un flag d'anomalie persistant sur la
      // planification (handler.ts::handleTriggerFired), pas n'importe quel échec de déploiement.
      this.reply(req.correlation_id, false, buildCorrectionRequestMessage(problems), undefined, true);
      return;
    }

    // ⭐ 26/08/2026 — met en cache la décision pour les prochains tirs de ce même déclenchement.
    this.phraseCache.set(req.phrase_originale, [{
      kind: 'structured',
      data: { type: 'execution', execution: { trigger_name: req.trigger_name, triggered_at: req.timestamp, context_snapshot: {}, steps: parsed } }
    }]);

    this.reply(req.correlation_id, true, `Séquence de ${parsed.length} étape(s) produite pour "${req.trigger_name}".`, parsed);
  }

  /** Résout `phrase_originale` via l'interpréteur déterministe (specs §16), même mécanisme que
   *  `IaService.tryDeterministicPath` — `undefined` si non reconnu (l'appelant retombe sur Mistral,
   *  comportement inchangé). */
  private tryInterpreter(phrase: string): DeterministicOutcome[] | undefined {
    if (!this.haBridgeClient.isAvailable()) return undefined;
    const gabarits = this.getGabarits();
    if (Object.keys(gabarits).length === 0) return undefined;
    const live = buildLiveCatalogs(this.haBridgeClient, this.getMacros(), this.getExcludedQuoiIds());
    try {
      return interpretDeterministic(phrase, this.getVocabulaire(), gabarits, live);
    } catch (error) {
      this.logger.error('DeployResponder', `Erreur interpréteur déterministe (repli Mistral): ${error}`);
      return undefined;
    }
  }

  /** Vérifie les références (même garde-fou que le chemin Mistral, "d'où qu'elles viennent") et
   *  répond si valides. `false` (pas de réponse envoyée) si les références sont invalides — laisse
   *  l'appelant continuer vers la source suivante (interpréteur, puis Mistral) plutôt que de
   *  refuser sur la seule base d'un cache/match potentiellement obsolète. */
  private async tryReplyWithSteps(req: DeployRequest, steps: ExecutionStep[], source: 'cache' | 'interpréteur'): Promise<boolean> {
    const problems = await validateReferences(steps, this.haBridgeClient);
    if (problems.length > 0) {
      this.logger.warn('DeployResponder', `Référence(s) non vérifiée(s) dans la séquence issue du ${source} — repli sur la suite (${problems.map((p) => p.detail).join(' | ')}).`);
      return false;
    }
    this.logger.info('DeployResponder', `Réinterprétation "${req.trigger_name}" résolue via ${source} — ${steps.length} étape(s), sans appel Mistral.`);
    if (source === 'cache') this.metrics.recordCacheHit();
    else this.metrics.recordInterpreterHit();
    this.reply(req.correlation_id, true, `Séquence de ${steps.length} étape(s) produite pour "${req.trigger_name}" (${source}).`, steps);
    return true;
  }

  /** Accepte {"execution":{"steps":[...]}}  et  {"type":"execution","execution":{"steps":[...]}} */
  private parseExecution(text: string): ExecutionStep[] | null {
    try {
      const data = JSON.parse(stripMarkdownFences(text));
      const steps = data?.execution?.steps;
      if (Array.isArray(steps)) return steps as ExecutionStep[];
    } catch (error) {
      this.logger.warn('DeployResponder', `JSON non parseable: ${error}`);
    }
    return null;
  }

  private reply(correlation_id: string, success: boolean, message: string, steps?: ExecutionStep[], invalidReferences?: boolean): void {
    const reply: DeployReply = { correlation_id, success, message, steps, invalidReferences };
    this.eventBus.emitGeneric('planificateur:deploy:reply', reply);
  }
}
