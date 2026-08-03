/**
 * Suivi des triggers `state_change` — pendant de SchedulerRuntime pour les déclencheurs
 * temporels, mais avec un suivi par (planification, entité) plutôt que par planification seule :
 * une règle par défaut sur tout un domaine (ex: "toutes les lumières") gère plusieurs comptes à
 * rebours indépendants en parallèle, un par entité qui a effectivement déclenché.
 *
 * Différence structurelle avec SchedulerRuntime, découverte en implémentant : pour un trigger
 * temporel, le délai est connu à l'avance (`triggerToMs`), un `setTimeout` brut suffit à le
 * représenter et à le reprendre après coupure. Pour un trigger `state_change`, l'attente ("attends
 * 24h puis éteins") fait partie de l'ACTION, réinterprétée par Mistral à CHAQUE déclenchement
 * (jamais depuis une version figée, principe déjà en place pour tous les triggers) — la durée
 * réelle n'est donc connue qu'une fois la réponse de `ia` reçue, jamais avant. Conséquence
 * assumée pour cette première version : annuler/relancer une exécution déjà en cours (comportement
 * "minuterie" pendant que le service tourne) est précis (AbortController sur l'exécution en vol,
 * voir execution.ts) ; en revanche la REPRISE APRÈS REDÉMARRAGE d'une entité dont l'attente était
 * en cours ne peut pas reprendre sur le temps exact restant (rien de figé à reprendre) — elle
 * redéclenche simplement à neuf (nouvelle interrogation de Mistral, nouvelle attente complète).
 * La lumière finira donc toujours par s'éteindre, mais potentiellement plus tard que si le service
 * n'avait jamais redémarré. Contrairement aux triggers temporels (reprise précise, voir
 * scheduler-runtime.ts), pas de fenêtre de rattrapage/`missed` ici en v1 (voir plan).
 */

import type { Logger, HaWsClient, HaRawEntity } from '../../../core/src/exports';
import type { PlanificationDefinition } from './types';

export type StateFireCallback = (plan: PlanificationDefinition, entityId: string, signal: AbortSignal) => Promise<void>;
export type PendingChangedCallback = (plan: PlanificationDefinition) => void;

export class StateWatcher {
  private readonly pending = new Map<string, AbortController>(); // clé "planName::entityId"
  private plans: PlanificationDefinition[] = [];

  constructor(
    private readonly haWsClient: HaWsClient,
    private readonly logger: Logger,
    private readonly onFire: StateFireCallback,
    private readonly onPendingChanged: PendingChangedCallback
  ) {}

  /** À appeler une fois au démarrage : s'abonne aux changements d'état HA et redéclenche à neuf
   *  toute entrée `pending` trouvée dans les planifications actives (reprise après coupure — voir
   *  limitation de précision documentée en tête de fichier). */
  start(plans: PlanificationDefinition[]): void {
    this.setPlans(plans);
    this.haWsClient.onStateChanged((entity) => this.handleStateChanged(entity));

    for (const plan of plans) {
      if (plan.trigger.type !== 'state_change' || !plan.active || !plan.pending) continue;
      for (const entityId of Object.keys(plan.pending)) {
        this.logger.info('StateWatcher', `Reprise après coupure pour "${plan.name}" (${entityId}) — redéclenchement à neuf`);
        this.restart(plan, entityId);
      }
    }
  }

  /** À rappeler après toute modification de la liste des planifications (création/modification/
   *  suppression) — StateWatcher garde sa propre référence pour résoudre les déclenchements sans
   *  dépendre d'un rechargement complet à chaque changement d'état. */
  setPlans(plans: PlanificationDefinition[]): void {
    this.plans = plans;
  }

  private handleStateChanged(entity: HaRawEntity): void {
    const domain = entity.entity_id.split('.')[0];
    const plan = this.resolvePlan(entity.entity_id, domain);
    if (!plan || entity.state !== plan.trigger.to_state) return;

    this.logger.info('StateWatcher', `"${plan.name}" déclenché par ${entity.entity_id} → ${entity.state}`);
    this.restart(plan, entity.entity_id);
  }

  /** Priorité : une règle ciblant précisément cette entité l'emporte sur une règle par défaut de domaine. */
  private resolvePlan(entityId: string, domain: string): PlanificationDefinition | undefined {
    const specific = this.plans.find((p) =>
      p.active && p.trigger.type === 'state_change' && p.trigger.entity_id === entityId);
    if (specific) return specific;
    return this.plans.find((p) =>
      p.active && p.trigger.type === 'state_change' && !p.trigger.entity_id && p.trigger.domain === domain);
  }

  /** Annule l'exécution en cours pour ce (plan, entité) si elle existe (comportement "minuterie" :
   *  redéclencher pendant l'attente repart de zéro, pas d'empilement), puis relance à neuf. */
  private restart(plan: PlanificationDefinition, entityId: string): void {
    const key = `${plan.name}::${entityId}`;
    this.pending.get(key)?.abort();

    const controller = new AbortController();
    this.pending.set(key, controller);

    plan.pending = { ...(plan.pending ?? {}), [entityId]: new Date().toISOString() };
    this.onPendingChanged(plan);

    this.onFire(plan, entityId, controller.signal).finally(() => {
      // Ne nettoyer que si cette exécution est toujours la plus récente pour ce couple (un
      // redéclenchement entre-temps a déjà posé un nouveau controller sous la même clé).
      if (this.pending.get(key) === controller) {
        this.pending.delete(key);
        if (plan.pending) {
          delete plan.pending[entityId];
          this.onPendingChanged(plan);
        }
      }
    });
  }

  /** Désarme tous les comptes à rebours en cours pour une planification (désactivation/suppression). */
  unschedule(planName: string): void {
    for (const [key, controller] of this.pending) {
      if (key.startsWith(`${planName}::`)) {
        controller.abort();
        this.pending.delete(key);
      }
    }
  }

  listPending(): string[] {
    return [...this.pending.keys()];
  }
}
