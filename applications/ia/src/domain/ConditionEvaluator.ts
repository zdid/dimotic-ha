/**
 * ⭐ 24/09/2026 — évaluation d'une condition en texte libre à la demande de `planificateur`
 * (planificateur:condition / :reply). Remplace `DeployResponder` (réinterprétation COMPLÈTE de la
 * phrase à chaque déclenchement, supprimée — décision utilisateur : Mistral ne répond pas toujours
 * pareil, « dans 5 minutes » parfois oublié). `planificateur` exécute désormais lui-même la
 * structure décidée à la création et n'appelle `ia` QUE pour une condition qu'il ne sait pas
 * évaluer en code (soleil, numérique et état simple le sont déjà, voir planificateur conditions.ts).
 *
 * Question posée : « cette condition est-elle vraie maintenant ? », avec les seuls outils de
 * LECTURE (lister_entites/obtenir_etat) — executer_action n'est jamais proposé, et même s'il était
 * appelé, ToolExecutor en mode dryRun ne transmet rien à planificateur.
 */

import type { IEventBus, Logger } from '../../../core/dist/exports';
import type { MistralClient } from './MistralClient';
import type { ToolExecutor } from './ToolExecutor';
import { IA_TOOLS } from './tools';
import { translateMistralStream, stripMarkdownFences } from './streaming';
import type { CorrelatedReponse, OllamaMessage } from './types';

const MAX_ROUNDS = 4;
const READ_TOOLS = IA_TOOLS.filter((t) => t.function.name !== 'executer_action');

export interface ConditionRequest {
  correlation_id: string;
  condition: string | Record<string, unknown>;
  trigger_name: string;
  triggered_entity_id?: string;
}

export interface ConditionReply extends CorrelatedReponse {
  result?: boolean;
}

const SYSTEM_PROMPT = [
  'Tu évalues UNE condition domotique à l\'instant présent, pour une planification qui se déclenche.',
  'Lis l\'état réel des entités avec les outils lister_entites / obtenir_etat — ne suppose jamais un état.',
  'Réponds UNIQUEMENT par un JSON, sans aucun texte autour :',
  '{"resultat": true, "raison": "<courte justification>"} ou {"resultat": false, "raison": "..."}',
  'ou, si tu ne peux vraiment pas conclure : {"resultat": null, "raison": "..."}.'
].join('\n');

export class ConditionEvaluator {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly mistralClient: MistralClient,
    private readonly toolExecutor: ToolExecutor,
    private readonly getModel: () => string,
    // Même attente que le reste d'ia : pas d'évaluation sans référentiel HA chargé.
    private readonly waitHaReady: () => Promise<void>
  ) {}

  wire(): void {
    this.eventBus.onGeneric<ConditionRequest>('planificateur:condition', (req) => {
      this.handle(req).catch((error) => {
        this.logger.error('ConditionEvaluator', `Erreur d'évaluation: ${error}`);
        this.reply(req.correlation_id, false, `Erreur d'évaluation: ${error}`);
      });
    });
  }

  private async handle(req: ConditionRequest): Promise<void> {
    await this.waitHaReady();
    const text = typeof req.condition === 'string' ? req.condition : JSON.stringify(req.condition);
    this.logger.info('ConditionEvaluator', `Évaluation demandée pour "${req.trigger_name}": ${text}`);

    const now = new Date();
    let messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Condition : ${text}\nContexte : ${JSON.stringify({
          planification: req.trigger_name,
          heure: now.toTimeString().slice(0, 5),
          jour: now.toLocaleDateString('fr-FR', { weekday: 'long' }),
          date: now.toISOString().slice(0, 10),
          ...(req.triggered_entity_id ? { entite_declenchante: req.triggered_entity_id } : {})
        })}`
      }
    ];
    const model = this.mistralClient.resolveModel(this.getModel());

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await this.mistralClient.streamChat(messages, model, {}, READ_TOOLS);
      if (!result.ok) {
        this.reply(req.correlation_id, false, `Erreur Mistral ${result.status}: ${result.errorText}`);
        return;
      }
      const gen = translateMistralStream(result.body, model);
      let assembled;
      for (let step = await gen.next(); ; step = await gen.next()) {
        if (step.done) { assembled = step.value; break; }
      }
      this.mistralClient.recordTokenUsage(model, assembled.promptTokens, assembled.completionTokens);

      if (assembled.toolCalls.length > 0) {
        messages = [...messages, { role: 'assistant', content: assembled.text, tool_calls: assembled.toolCalls }];
        for (const call of assembled.toolCalls) {
          const content = await this.toolExecutor.execute(call, true); // dryRun : jamais d'action
          messages = [...messages, { role: 'tool', tool_call_id: call.id, content }];
        }
        continue;
      }

      const parsed = parseVerdict(assembled.text);
      if (parsed === undefined) {
        this.reply(req.correlation_id, false, `Réponse inexploitable : ${assembled.text.slice(0, 200)}`);
      } else if (parsed.resultat === null) {
        this.reply(req.correlation_id, false, `Non concluant : ${parsed.raison ?? ''}`);
      } else {
        this.reply(req.correlation_id, true, parsed.raison ?? '', parsed.resultat);
      }
      return;
    }
    this.reply(req.correlation_id, false, `Trop d'appels d'outils (${MAX_ROUNDS} rounds)`);
  }

  private reply(correlation_id: string, success: boolean, message: string, result?: boolean): void {
    const reply: ConditionReply = { correlation_id, success, message, result };
    this.logger.info('ConditionEvaluator', `Verdict: ${success ? result : 'non évalué'} — ${message}`);
    this.eventBus.emitGeneric('planificateur:condition:reply', reply);
  }
}

function parseVerdict(text: string): { resultat: boolean | null; raison?: string } | undefined {
  try {
    const data = JSON.parse(stripMarkdownFences(text));
    if (data && (typeof data.resultat === 'boolean' || data.resultat === null)) return data;
  } catch { /* texte non JSON */ }
  return undefined;
}
