/**
 * Exécution (specs §6/§8) — ⭐ refonte du 24/09/2026 (décision utilisateur).
 *
 * Avant : à chaque déclenchement, la `phrase_originale` était renvoyée à `ia`/Mistral pour
 * réinterprétation complète (planificateur:deploy), puis la séquence obtenue mise en cache et
 * rejouée (resolvedCache). Deux défauts : Mistral ne répond pas toujours pareil (« dans 5 minutes »
 * parfois oublié) et le cache figeait ce qui doit varier (conditions, aléatoires, entité
 * déclenchante).
 *
 * Maintenant : la structure `action` décidée UNE fois à la création est exécutée et RECALCULÉE EN
 * CODE à chaque exécution (runNode) :
 *  - action (verbe/quoi/lieux/valeur) → resolution.ts contre le référentiel HA courant → service HA ;
 *  - wait → durée fixe, ou nouveau tirage aléatoire à chaque fois ;
 *  - macro_ref → définition COURANTE de la macro, détection de boucle ;
 *  - condition → conditions.ts (soleil, numérique, état simple) ; sinon, seul appel restant à `ia` :
 *    planificateur:condition (vrai/faux), jamais une réinterprétation de la phrase.
 * Plus de repli vers l'agent de conversation de HA (processConversation) : cet agent EST `ia`
 * (émulation Ollama), le repli pouvait boucler — une commande non résolue est tracée en échec.
 */

import type { HaBridgeClient, Logger, IEventBus } from '../../../core/dist/exports';
import { CorrelatedRequester } from '../../../core/dist/exports';
import type {
  ActionNode,
  ConditionReply,
  ConditionRequest,
  ConditionSpec,
  DomoticNode,
  ExecutionStep,
  MacroDefinition,
  ResolvedServiceCall
} from './types';
import { resolveAction, resolveEntityIds, buildServiceCall, isKnownVerb, inverseVerb } from './resolution';
import { evaluateConditionLocally } from './conditions';
import type { SunTimesProvider } from './sun-times';
import { PLANIFICATEUR_SOCKET_EVENTS } from './socket-events';

/** Une entrée du journal « ce qui a réellement été fait » (socket-events.ts::HA_COMMANDS_LIST) —
 *  une par étape action exécutée ou condition évaluée, quel que soit le déclencheur. */
export interface HaCommandTrace {
  at: string;
  trigger: string;
  step: { verbe?: string; quoi?: string; lieux?: string[]; valeur?: string | number; order?: string };
  /** 'resolved' : appel de service HA envoyé. 'unresolved' : commande non exécutable (verbe
   *  inconnu, aucune entité, référentiel indisponible) — rien envoyé à HA. 'condition' : condition
   *  évaluée (résultat dans `conditionResult`). */
  outcome: 'resolved' | 'unresolved' | 'condition';
  resolved?: ResolvedServiceCall;
  success?: boolean;
  error?: string;
  conditionResult?: boolean;
  /** Détail de l'évaluation d'une condition (valeurs lues, heures du soleil, `ia`). */
  detail?: string;
  /** Entité HA dont le changement d'état a déclenché cette exécution (triggers state_change). */
  triggeredByEntityId?: string;
  /** Prochaine exécution programmée (triggers temporels récurrents) — déjà réarmée. */
  nextFireAt?: string;
}

export interface RunContext {
  trigger: string;
  signal?: AbortSignal;
  triggeredEntityId?: string;
  nextFireAt?: string;
  /** Macros en cours de déploiement (détection de boucle). */
  macroStack?: string[];
}

/** Bilan d'une exécution : nombre d'actions tentées et échecs (commande non résolue, condition non
 *  évaluable, macro inconnue…) — sert à positionner `anomalie` sur la planification. */
export interface RunResult {
  actions: number;
  failures: string[];
}

export class ExecutionEngine {
  private readonly conditionRequester: CorrelatedRequester<ConditionRequest, ConditionReply>;
  private readonly recentHaCommands: HaCommandTrace[] = [];

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly registry: HaBridgeClient,
    private readonly conditionTimeoutMs: number,
    private readonly getMacro: (name: string) => MacroDefinition | undefined,
    private readonly getSunTimes: SunTimesProvider
  ) {
    this.conditionRequester = new CorrelatedRequester<ConditionRequest, ConditionReply>(
      eventBus,
      'planificateur:condition',
      'planificateur:condition:reply'
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

  /** Exécute un nœud (planification.action, macro, ou commande directe reçue de `ia`). Ne rejette
   *  que sur annulation (AbortedExecutionError) ; tout autre problème est compté dans `failures`. */
  async run(node: DomoticNode, ctx: RunContext): Promise<RunResult> {
    const result: RunResult = { actions: 0, failures: [] };
    await this.runNode(node, ctx, result);
    return result;
  }

  private async runNode(node: DomoticNode, ctx: RunContext, result: RunResult): Promise<void> {
    if (ctx.signal?.aborted) throw new AbortedExecutionError();

    switch (node.type) {
      case 'action': {
        result.actions++;
        const { error } = await this.executeAction(node, ctx);
        if (error) result.failures.push(error);
        return;
      }

      case 'wait': {
        const seconds = node.seconds
          ?? (node.seconds_min !== undefined && node.seconds_max !== undefined ? randInt(node.seconds_min, node.seconds_max) : undefined)
          ?? parseDurationSeconds(node.duration);
        if (seconds === undefined) {
          result.failures.push(`attente sans durée exploitable (« ${node.duration} »)`);
          return;
        }
        await sleep(seconds * 1000, ctx.signal);
        return;
      }

      case 'sequence':
        for (const step of node.steps) await this.runNode(step, ctx, result);
        return;

      case 'condition': {
        const value = await this.evaluateCondition(node.if, ctx);
        if (value === undefined) {
          result.failures.push(`condition non évaluée : ${conditionText(node.if)}`);
          return;
        }
        const branch = value ? node.then : node.else;
        if (branch) await this.runNode(branch, ctx, result);
        return;
      }

      case 'macro_ref':
      case 'macro': {
        const macro = node.type === 'macro' ? node : this.getMacro(node.name);
        if (!macro) {
          result.failures.push(`macro « ${node.name} » inconnue`);
          return;
        }
        const stack = ctx.macroStack ?? [];
        if (stack.includes(macro.name)) {
          result.failures.push(`boucle de macros : ${[...stack, macro.name].join(' → ')}`);
          return;
        }
        const inner = { ...ctx, macroStack: [...stack, macro.name] };
        for (const step of macro.steps) await this.runNode(step, inner, result);
        return;
      }

      default:
        result.failures.push(`nœud non exécutable : ${(node as { type: string }).type}`);
    }
  }

  /** Condition : d'abord en code (conditions.ts), sinon demandée à `ia` (vrai/faux). `undefined`
   *  si aucun des deux n'a pu conclure — la branche n'est alors PAS exécutée. */
  private async evaluateCondition(condition: string | ConditionSpec, ctx: RunContext): Promise<boolean | undefined> {
    const local = await evaluateConditionLocally(condition, this.registry, this.getSunTimes);
    let value = local.result;
    let detail = local.detail;

    if (value === undefined) {
      try {
        const reply = await this.conditionRequester.request(
          { condition, trigger_name: ctx.trigger, triggered_entity_id: ctx.triggeredEntityId },
          this.conditionTimeoutMs
        );
        value = reply.success ? reply.result : undefined;
        detail = `${detail} → ia : ${reply.message}`;
      } catch (error) {
        detail = `${detail} → ia ne répond pas (${error instanceof Error ? error.message : String(error)})`;
      }
    }

    this.logger.info('ExecutionEngine', `Condition « ${conditionText(condition)} » = ${value === undefined ? 'non évaluée' : value} (${detail})`);
    this.recordHaCommand({
      trigger: ctx.trigger,
      step: { order: conditionText(condition) },
      outcome: 'condition',
      success: value !== undefined,
      conditionResult: value,
      detail,
      triggeredByEntityId: ctx.triggeredEntityId,
      nextFireAt: ctx.nextFireAt
    });
    return value;
  }

  /** Résout et envoie une commande. `error` renseigné si non envoyée ou refusée par HA. */
  private async executeAction(node: Pick<ActionNode, 'verbe' | 'quoi' | 'lieux' | 'valeur' | 'order'>, ctx: RunContext): Promise<{ error?: string; resolved?: ResolvedServiceCall }> {
    const step = { verbe: node.verbe, quoi: node.quoi, lieux: node.lieux, valeur: node.valeur, order: node.order };
    const unresolved = (error: string): { error: string } => {
      this.logger.warn('ExecutionEngine', `Commande non exécutée (${error}) : ${JSON.stringify(step)}`);
      this.recordHaCommand({ trigger: ctx.trigger, step, outcome: 'unresolved', success: false, error, triggeredByEntityId: ctx.triggeredEntityId, nextFireAt: ctx.nextFireAt });
      return { error: `« ${node.order || `${node.verbe ?? '?'} ${node.quoi ?? '?'}`} » : ${error}` };
    };

    if (!node.verbe || !node.quoi) return unresolved('commande sans verbe/quoi');
    if (!this.registry.isAvailable()) return unresolved('référentiel HA indisponible');
    if (!isKnownVerb(node.verbe)) return unresolved(`verbe « ${node.verbe} » inconnu`);

    let resolved: ResolvedServiceCall | undefined;
    // « éteins-la » (trigger state_change, action sans lieu) : cible l'entité qui a déclenché si
    // elle fait partie du quoi visé — une règle sur toutes les lumières agit sur LA lumière
    // concernée, pas sur toutes (ni sur la première mise en cache, défaut du resolvedCache).
    if (ctx.triggeredEntityId && (node.lieux ?? []).length === 0) {
      const ofQuoi = await resolveEntityIds(this.registry, node.quoi, []);
      if (ofQuoi.includes(ctx.triggeredEntityId)) resolved = buildServiceCall(node.verbe, [ctx.triggeredEntityId], node.valeur);
    }
    resolved ??= await resolveAction(this.registry, node.verbe, node.quoi, node.lieux ?? [], node.valeur);
    if (!resolved) return unresolved(`aucune entité pour quoi « ${node.quoi} » ${(node.lieux ?? []).length ? `dans ${(node.lieux ?? []).join(', ')}` : '(sans lieu)'}`);

    this.logger.info('ExecutionEngine', `Exécution: ${resolved.domain}.${resolved.service} → ${resolved.entity_id}`);
    let error: string | undefined;
    try {
      await this.registry.sendCommand(resolved.domain, resolved.service, { entity_id: resolved.entity_id }, resolved.data);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.logger.warn('ExecutionEngine', `Échec commande, pas de nouvelle tentative: ${error}`);
    }
    this.recordHaCommand({ trigger: ctx.trigger, step, outcome: 'resolved', resolved, success: !error, error, triggeredByEntityId: ctx.triggeredEntityId, nextFireAt: ctx.nextFireAt });
    return error ? { error: `« ${node.order || node.verbe} » : ${error}`, resolved } : { resolved };
  }

  /**
   * Action immédiate (outil executer_action de `ia`) — même résolution que ci-dessus. Plus de
   * repli : une commande non résolue est refusée avec la raison exacte.
   */
  async executeImmediateAction(verbe: string, quoi: string, lieux: string[] = [], valeur?: string | number): Promise<{ success: boolean; message: string }> {
    const { error, resolved } = await this.executeAction({ order: '', verbe, quoi, lieux, valeur }, { trigger: 'action_immediate' });
    if (error || !resolved) return { success: false, message: `Commande non exécutée — ${error ?? 'non résolue'}` };
    const target = Array.isArray(resolved.entity_id) ? resolved.entity_id.join(', ') : resolved.entity_id;
    return { success: true, message: `${resolved.domain}.${resolved.service} exécuté sur ${target}.` };
  }

  /** Séquence plate reçue de `ia` (type `execution` — ex. « allume le salon. attendre 3 heures.
   *  éteins le salon. » reconnu par l'interpréteur déterministe). */
  async executeSteps(steps: ExecutionStep[], trigger: string): Promise<RunResult> {
    const nodes: DomoticNode[] = [];
    for (const step of [...steps].sort((a, b) => a.step - b.step)) {
      if (step.delay_before_seconds > 0) nodes.push({ type: 'wait', duration: `${step.delay_before_seconds} s`, seconds: step.delay_before_seconds });
      if (step.type === 'wait') nodes.push({ type: 'wait', duration: step.resolved_from ?? `${step.seconds ?? 0} s`, seconds: step.seconds ?? 0 });
      else nodes.push({ type: 'action', order: step.order ?? '', verbe: step.verbe, quoi: step.quoi, lieux: step.lieux, valeur: step.valeur });
    }
    return this.run({ type: 'sequence', steps: nodes }, { trigger });
  }
}

/**
 * ⭐ 24/09/2026 — action inverse d'un nœud (fin d'une plage `window` ou d'une `duration`) :
 * chaque action à verbe inversible (allumer↔éteindre, ouvrir↔fermer, activer↔désactiver), dans
 * l'ordre inverse ; conditions, attentes et macros ignorées. `undefined` s'il n'y a rien à inverser.
 */
export function inverseOf(node: DomoticNode): DomoticNode | undefined {
  const actions: ActionNode[] = [];
  const collect = (n: DomoticNode): void => {
    if (n.type === 'action') {
      const inv = n.verbe ? inverseVerb(n.verbe) : undefined;
      if (inv) actions.push({ ...n, verbe: inv, order: `${inv} ${n.quoi ?? ''} ${(n.lieux ?? []).join(' ')}`.trim(), valeur: undefined, resolved_service_call: undefined });
    } else if (n.type === 'sequence') {
      n.steps.forEach(collect);
    }
  };
  collect(node);
  if (actions.length === 0) return undefined;
  return { type: 'sequence', steps: actions.reverse() };
}

function conditionText(condition: string | ConditionSpec): string {
  if (typeof condition === 'string') return condition;
  return condition.phrase || [condition.quoi, (condition.lieux ?? []).join(' '), condition.signe, condition.valeur].filter((x) => x !== undefined && x !== '').join(' ');
}

/** « 5 minutes », « 2 h », « 30 secondes » → secondes (secours si `seconds` absent). */
function parseDurationSeconds(duration?: string): number | undefined {
  const m = /(\d+(?:[.,]\d+)?)\s*(s|sec|secondes?|min|minutes?|h|heures?)\b/i.exec(duration ?? '');
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  return Math.round(unit.startsWith('h') ? n * 3600 : unit.startsWith('m') ? n * 60 : n);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Distingue une exécution annulée (redéclenchement "minuterie") d'une vraie erreur. */
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
