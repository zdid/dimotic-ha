/**
 * Gestion des minuteurs actifs (un par planification active) — état + effets de bord, au-dessus du
 * calcul pur de scheduler.ts. Port de la partie "état" de ts-planner/src/scheduler.ts, adapté :
 * au lieu de publier sur MQTT, appelle directement un callback de déploiement (voir
 * PlanificateurService — même mécanisme que le déclenchement d'une macro dite directement,
 * specs §6).
 */

import type { Logger } from '../../../core/dist/exports';
import type { PlanificationDefinition } from './types';
import { triggerToMs, isRecurring } from './scheduler';

export type FireCallback = (plan: PlanificationDefinition) => void;
/** Appelé chaque fois qu'un nouveau next_fire_at est calculé (programmation initiale ET réarmement
 *  d'un trigger récurrent) — au appelant de le persister (voir CommandHandler.persistPlanifications). */
export type ScheduledCallback = (plan: PlanificationDefinition) => void;

export class SchedulerRuntime {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly logger: Logger,
    private readonly onFire: FireCallback,
    private readonly onScheduled?: ScheduledCallback
  ) {}

  /** Programmation normale — délai recalculé depuis maintenant (`triggerToMs`). */
  schedule(plan: PlanificationDefinition): void {
    const ms = triggerToMs(plan.trigger, this.logger);
    if (ms === null) {
      this.logger.warn('SchedulerRuntime', `Déclencheur non supporté pour "${plan.name}": ${plan.trigger.type}`);
      return;
    }
    this.arm(plan, ms);
  }

  /**
   * Reprise après (re)démarrage — programme sur le délai RESTANT déjà connu (`deltaMs`), au lieu
   * de recalculer un délai complet depuis maintenant comme le ferait schedule(). C'est ce qui
   * évite qu'un `delay`/`duration` en cours reparte intégralement à zéro à chaque redémarrage
   * (voir CommandHandler.load()).
   */
  resume(plan: PlanificationDefinition, deltaMs: number): void {
    this.arm(plan, deltaMs);
  }

  private arm(plan: PlanificationDefinition, ms: number): void {
    this.unschedule(plan.name);

    const recurring = isRecurring(plan.trigger);

    const fire = () => {
      this.logger.info('SchedulerRuntime', `Déclenchement: "${plan.name}"`);
      this.onFire(plan);

      if (recurring) {
        const next = triggerToMs(plan.trigger, this.logger);
        if (next !== null) {
          const t = setTimeout(fire, next);
          this.timers.set(plan.name, t);
          plan.next_fire_at = new Date(Date.now() + next).toISOString();
          this.onScheduled?.(plan);
          this.logger.info('SchedulerRuntime', `Prochain déclenchement "${plan.name}" dans ${Math.round(next / 1000)}s`);
        }
      } else {
        this.timers.delete(plan.name);
      }
    };

    const timer = setTimeout(fire, ms);
    this.timers.set(plan.name, timer);
    plan.next_fire_at = new Date(Date.now() + ms).toISOString();
    this.onScheduled?.(plan);
    this.logger.info('SchedulerRuntime', `"${plan.name}" programmée dans ${Math.round(ms / 1000)}s (${plan.trigger.type})`);
  }

  unschedule(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(name);
      this.logger.info('SchedulerRuntime', `"${name}" annulée`);
    }
  }

  listScheduled(): string[] {
    return [...this.timers.keys()];
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
