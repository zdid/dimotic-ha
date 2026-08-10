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
import type { DeployContext, ExecutionStep, MacroDefinition, ResolvedServiceCall } from './types';
import { resolveAction } from './resolution';
import { CorrelatedRequester } from './correlation';
import { PLANIFICATEUR_SOCKET_EVENTS } from './socket-events';

interface DeployReply {
  correlation_id: string;
  success: boolean;
  message: string;
  steps?: ExecutionStep[];
}

/** Une entrée du journal "ce qui a réellement été envoyé à HA" (demande utilisateur, voir
 *  socket-events.ts::HA_COMMANDS_LIST) — une par étape 'action' exécutée, quel que soit le
 *  déclencheur (minuteur, macro dite, ou message ia). */
export interface HaCommandTrace {
  at: string;
  trigger: string;
  step: { verbe?: string; quoi?: string; lieux?: string[]; valeur?: string | number; order?: string };
  /** 'resolved' : traduit en appel de service HA direct (resolution.ts) — chemin principal.
   *  'fallback_conversation' : verbe non couvert par resolution.ts, repli sur l'agent de
   *  conversation natif de HA (HaWsClient.processConversation) — pas de service_call déterministe.
   *  'ignored' : ni resolved_service_call ni order exploitable, rien envoyé à HA. */
  outcome: 'resolved' | 'fallback_conversation' | 'ignored';
  resolved?: ResolvedServiceCall;
  success?: boolean;
  error?: string;
  /** Entité HA dont le changement d'état a déclenché cette exécution (triggers state_change
   *  uniquement — "en corrélation des messages reçus de HA", demande utilisateur). */
  triggeredByEntityId?: string;
  /** Prochaine date/heure d'exécution programmée pour ce déclencheur (ISO8601), pour les triggers
   *  temporels récurrents uniquement — reflète déjà le RÉARMEMENT suivant, pas l'horaire qui vient
   *  de se déclencher (SchedulerRuntime.arm() recalcule next_fire_at avant la fin de l'exécution en
   *  cours). Absent pour les triggers state_change (réactifs, pas de prochaine heure connue) et
   *  pour les déclenchements macro dite/action immédiate (pas de minuteur). */
  nextFireAt?: string;
}

export class ExecutionEngine {
  private readonly deployRequester: CorrelatedRequester<DeployContext, DeployReply>;
  private readonly recentHaCommands: HaCommandTrace[] = [];

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

  getRecentHaCommands(): HaCommandTrace[] {
    return this.recentHaCommands;
  }

  private recordHaCommand(trace: Omit<HaCommandTrace, 'at'>): void {
    this.recentHaCommands.unshift({ at: new Date().toISOString(), ...trace });
    if (this.recentHaCommands.length > 20) this.recentHaCommands.length = 20;
    this.eventBus.emitGeneric(PLANIFICATEUR_SOCKET_EVENTS.HA_COMMANDS_LIST, this.recentHaCommands);
  }

  buildDeployContext(triggerName: string, phraseOriginale: string, macros: MacroDefinition[]): DeployContext {
    return {
      trigger_name: triggerName,
      phrase_originale: phraseOriginale,
      macros,
      // HaStructuredEntity porte des références circulaires (entity.area → area.quoiMap →
      // quoi.entities → ... → la même entity) destinées à un usage en mémoire, jamais à être
      // sérialisées — un résumé plat évite le crash JSON.stringify côté DeployResponder (ia).
      // ⭐ 10/08/2026 : lieu_precis ajouté (ex: "Salon", plus fin que l'area HA "Salle" qui le
      // contient) — demande utilisateur ("éteins le salon" éteignait toute la salle). Sans ce
      // champ, Mistral ne voyait jamais "Salon" nulle part dans le contexte (seulement l'area
      // "Salle", identique pour les 4 lumières de la pièce) et retombait sur l'area, faute de
      // donnée plus précise à vérifier. Extrait de l'attribut attributs_taxonomie déjà publié
      // (voir techniques-socle-ha-mqtt_specs §8.5.4 v4.19 pour le mécanisme de publication).
      // ⭐ 10/08/2026 (suite, même jour) : lieu_pere ajouté — cas "toilettes de l'étage" vs
      // "toilettes du rez-de-chaussée" : deux areas HA distinctes ("toilettes du bas"/"toilettes
      // du haut") partagent le même quoi générique, seul lieu_pere (étage/rez-de-chaussée) les
      // distingue. Permet à Mistral de résoudre lui-même vers le nom d'area réel avant même
      // d'appeler l'outil, plutôt que de transmettre un terme ambigu — voir regles_mistral.txt §4.
      entities_snapshot: this.registry ? this.registry.getAllEntities().map((e) => ({
        entity_id: e.entity_id,
        friendly_name: e.friendly_name,
        state: e.state,
        domain: e.domain,
        area_id: e.area_id,
        lieu_precis: (e.attributes?.attributs_taxonomie as Record<string, unknown> | undefined)?.lieu_precis,
        lieu_pere: (e.attributes?.attributs_taxonomie as Record<string, unknown> | undefined)?.lieu_pere
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
    signal?: AbortSignal,
    nextFireAt?: string
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
      await this.executeSteps(reply.steps, triggerName, signal, triggeredEntityId, nextFireAt);
    } catch (error) {
      if (error instanceof AbortedExecutionError) {
        return { success: false, message: `Déploiement "${triggerName}" annulé (redéclenché entre-temps).` };
      }
      throw error;
    }
    return { success: true, message: `${reply.steps.length} étape(s) exécutée(s).` };
  }

  async executeSteps(
    steps: ExecutionStep[],
    trigger: string,
    signal?: AbortSignal,
    triggeredByEntityId?: string,
    nextFireAt?: string
  ): Promise<void> {
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
      await this.executeAction(step, trigger, triggeredByEntityId, nextFireAt);
    }
  }

  private async executeAction(step: ExecutionStep, trigger: string, triggeredByEntityId?: string, nextFireAt?: string): Promise<void> {
    const stepSummary = { verbe: step.verbe, quoi: step.quoi, lieux: step.lieux, valeur: step.valeur, order: step.order };
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
      this.recordHaCommand({ trigger, step: stepSummary, outcome: 'resolved', resolved, success: result.success, error: result.error, triggeredByEntityId, nextFireAt });
      return;
    }

    // Repli : verbe non couvert par resolution.ts (specs §8, filet de sécurité, pas le chemin
    // principal) — l'agent de conversation natif de HA reste responsable de la traduction.
    if (step.order && this.haWsClient) {
      this.logger.info('ExecutionEngine', `Repli conversation.process (aucun resolved_service_call): "${step.order}"`);
      try {
        await this.haWsClient.processConversation(step.order);
        this.recordHaCommand({ trigger, step: stepSummary, outcome: 'fallback_conversation', success: true, triggeredByEntityId, nextFireAt });
      } catch (error) {
        this.logger.error('ExecutionEngine', `Échec du repli conversation.process: ${error}`);
        this.recordHaCommand({ trigger, step: stepSummary, outcome: 'fallback_conversation', success: false, error: String(error), triggeredByEntityId, nextFireAt });
      }
      return;
    }

    this.logger.warn('ExecutionEngine', `Étape action ignorée: ni resolved_service_call ni order exploitable (${JSON.stringify(step)})`);
    this.recordHaCommand({ trigger, step: stepSummary, outcome: 'ignored', triggeredByEntityId, nextFireAt });
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
