/**
 * Boucle de déploiement (specs §6) + exécution (specs §8).
 *
 * Déploiement : construit un contexte (phrase_originale + macros connues + état HA vivant +
 * horodatage), le fait réinterpréter par `ia`/Mistral via planificateur:deploy, reçoit une
 * séquence plate (ExecutionStep[]) en retour — jamais de version pré-compilée exécutée telle
 * quelle.
 *
 * Exécution : pour chaque étape, résolution déterministe du service HA (resolution.ts, jamais
 * faite par Mistral) puis exécution directe via HaCommandService (chemin principal) ou repli sur
 * HaWsClient.processConversation (verbe non couvert par la table §7).
 */

import type { HaCommandService, HaStructureRegistry, HaWsClient, Logger, IEventBus } from '../../../core/dist/exports';
import type { DeployContext, ExecutionStep, MacroDefinition } from './types';
import { resolveAction } from './resolution';
import { CorrelatedRequester } from './correlation';

interface DeployReply {
  correlation_id: string;
  success: boolean;
  message: string;
  steps?: ExecutionStep[];
}

export class ExecutionEngine {
  private readonly deployRequester: CorrelatedRequester<DeployContext, DeployReply>;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly registry: HaStructureRegistry | undefined,
    private readonly haCommandService: HaCommandService | undefined,
    private readonly haWsClient: HaWsClient | undefined,
    private readonly deployTimeoutMs: number
  ) {
    this.deployRequester = new CorrelatedRequester<DeployContext, DeployReply>(
      eventBus,
      'planificateur:deploy',
      'planificateur:deploy:reply'
    );
  }

  buildDeployContext(triggerName: string, phraseOriginale: string, macros: MacroDefinition[]): DeployContext {
    return {
      trigger_name: triggerName,
      phrase_originale: phraseOriginale,
      macros,
      // HaStructuredEntity porte des références circulaires (entity.area → area.quoiMap →
      // quoi.entities → ... → la même entity) destinées à un usage en mémoire, jamais à être
      // sérialisées — un résumé plat évite le crash JSON.stringify côté DeployResponder (ia).
      entities_snapshot: this.registry ? this.registry.getAllEntities().map((e) => ({
        entity_id: e.entity_id,
        friendly_name: e.friendly_name,
        state: e.state,
        domain: e.domain,
        area_id: e.area_id
      })) : [],
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Déclenche la boucle de déploiement complète : contexte → réinterprétation → exécution.
   * Retourne un résultat explicite (jamais d'échec avalé en silence) — l'appelant (handler.ts)
   * s'en sert pour ne confirmer un succès à `ia`/Mistral que si l'exécution a réellement eu lieu.
   *
   * `signal` optionnel (StateWatcher, triggers state_change) : permet d'annuler une exécution en
   * cours — typiquement une attente (`WaitNode`) avant l'action finale — quand la même entité
   * redéclenche entre-temps (comportement "minuterie" : on repart de zéro, pas d'empilement).
   * Aucun effet sur les triggers temporels (SchedulerRuntime n'en passe jamais).
   */
  async deployAndExecute(
    triggerName: string,
    phraseOriginale: string,
    macros: MacroDefinition[],
    triggeredEntityId?: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; message: string }> {
    const context = this.buildDeployContext(triggerName, phraseOriginale, macros);
    if (triggeredEntityId) context.triggered_entity_id = triggeredEntityId;

    let reply: DeployReply;
    try {
      reply = await this.deployRequester.request(context, this.deployTimeoutMs);
    } catch (error) {
      const message = `Déploiement "${triggerName}" échoué (pas de réponse de ia): ${error}`;
      this.logger.error('ExecutionEngine', message);
      return { success: false, message };
    }

    if (signal?.aborted) {
      return { success: false, message: `Déploiement "${triggerName}" annulé (redéclenché entre-temps).` };
    }

    if (!reply.success || !reply.steps) {
      const message = `Déploiement "${triggerName}" refusé par ia: ${reply.message}`;
      this.logger.warn('ExecutionEngine', message);
      return { success: false, message };
    }

    try {
      await this.executeSteps(reply.steps, signal);
    } catch (error) {
      if (error instanceof AbortedExecutionError) {
        return { success: false, message: `Déploiement "${triggerName}" annulé (redéclenché entre-temps).` };
      }
      throw error;
    }
    return { success: true, message: `${reply.steps.length} étape(s) exécutée(s).` };
  }

  async executeSteps(steps: ExecutionStep[], signal?: AbortSignal): Promise<void> {
    for (const step of steps.sort((a, b) => a.step - b.step)) {
      if (signal?.aborted) throw new AbortedExecutionError();

      if (step.delay_before_seconds > 0) {
        await sleep(step.delay_before_seconds * 1000, signal);
      }

      if (step.type === 'wait') {
        if (step.seconds) await sleep(step.seconds * 1000, signal);
        continue;
      }

      if (signal?.aborted) throw new AbortedExecutionError();
      await this.executeAction(step);
    }
  }

  private async executeAction(step: ExecutionStep): Promise<void> {
    const resolved = this.registry && step.verbe && step.quoi
      ? resolveAction(this.registry, step.verbe, step.quoi, step.lieux, step.valeur)
      : undefined;

    if (resolved && this.haCommandService) {
      this.logger.info('ExecutionEngine', `Exécution directe: ${resolved.domain}.${resolved.service} → ${resolved.entity_id}`);
      const result = await this.haCommandService.sendCommand({
        entity_id: resolved.entity_id,
        domain: resolved.domain,
        service: resolved.service,
        service_data: resolved.data
      });
      if (!result.success) {
        this.logger.warn('ExecutionEngine', `Échec commande directe, pas de nouvelle tentative: ${result.error}`);
      }
      return;
    }

    // Repli : verbe non couvert par resolution.ts (specs §8, filet de sécurité, pas le chemin
    // principal) — l'agent de conversation natif de HA reste responsable de la traduction.
    if (step.order && this.haWsClient) {
      this.logger.info('ExecutionEngine', `Repli conversation.process (aucun resolved_service_call): "${step.order}"`);
      try {
        await this.haWsClient.processConversation(step.order);
      } catch (error) {
        this.logger.error('ExecutionEngine', `Échec du repli conversation.process: ${error}`);
      }
      return;
    }

    this.logger.warn('ExecutionEngine', `Étape action ignorée: ni resolved_service_call ni order exploitable (${JSON.stringify(step)})`);
  }
}

/** Distingue une exécution annulée (redéclenchement "minuterie") d'une vraie erreur — voir deployAndExecute. */
export class AbortedExecutionError extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AbortedExecutionError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AbortedExecutionError());
    }, { once: true });
  });
}
