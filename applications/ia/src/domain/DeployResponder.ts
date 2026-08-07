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

import type { Logger, IEventBus } from '../../../core/dist/exports';
import type { DeployRequest, DeployReply, ExecutionStep, OllamaMessage } from './types';
import type { MistralClient } from './MistralClient';
import type { RulesProvider } from './rules';
import { translateMistralStream, stripMarkdownFences } from './streaming';

export class DeployResponder {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly mistralClient: MistralClient,
    private readonly rulesProvider: RulesProvider,
    private readonly defaultModel: string
  ) {}

  wire(): void {
    this.eventBus.onGeneric<DeployRequest>('planificateur:deploy', (req) => {
      this.handle(req).catch((error) => this.logger.error('DeployResponder', `Erreur de déploiement: ${error}`));
    });
  }

  private async handle(req: DeployRequest): Promise<void> {
    this.logger.info('DeployResponder', `Réinterprétation demandée: "${req.trigger_name}"`);

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

    const result = await this.mistralClient.streamChat(messages, mistralModel, {});
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

    const parsed = this.parseExecution(assembled.text);
    if (!parsed) {
      this.reply(req.correlation_id, false, `Réponse non exploitable de Mistral: ${assembled.text.slice(0, 200)}`);
      return;
    }

    this.reply(req.correlation_id, true, `Séquence de ${parsed.length} étape(s) produite pour "${req.trigger_name}".`, parsed);
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

  private reply(correlation_id: string, success: boolean, message: string, steps?: ExecutionStep[]): void {
    const reply: DeployReply = { correlation_id, success, message, steps };
    this.eventBus.emitGeneric('planificateur:deploy:reply', reply);
  }
}
