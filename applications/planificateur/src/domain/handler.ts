/**
 * Traitement des commandes reçues de `ia` (ia:command — JSON structuré détecté en conversation) et
 * des appels d'outil résolus (ia:tool:execute — action immédiate, specs ia §7/§8). Port adapté de
 * ts-planner/src/handler.ts : CRUD sur les fichiers YAML au lieu du store en mémoire du prototype,
 * réponses via EventBus corrélé au lieu de MQTT.
 */

import type { Logger } from '../../../core/dist/exports';
import type {
  DomoticNode,
  MacroDefinition,
  PlanificationDefinition,
  GestionNode,
  ExecutionPayload,
  ExecuterActionParams,
  CorrelatedReponse
} from './types';
import type { ConfigFileManager } from './yaml/ConfigFileManager';
import type { MacrosConfigFile, PlanificationsConfigFile } from './storage-schema';
import type { SchedulerRuntime } from './scheduler-runtime';
import { isRecurring, triggerToMs, windowEndMs, durationEndMs } from './scheduler';
import type { StateWatcher } from './state-watcher';
import { AbortedExecutionError, inverseOf, type ExecutionEngine, type RunResult } from './execution';
import { macroDefinitionSchema, planificationDefinitionSchema } from './nodes-schema';
import { isKnownVerb } from './resolution';
import type { ZodError } from 'zod';

// ⭐ Rétention des planifications terminées (demande utilisateur, 12/08/2026) — voir
// CommandHandler.cleanupCompletedPlanifications().
const COMPLETED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export class CommandHandler {
  private macros: Record<string, MacroDefinition>;
  private planifications: Record<string, PlanificationDefinition>;
  /** ⭐ 24/09/2026 — fin programmée d'une plage `window` / d'une `duration` (action inverse), par
   *  planification. En mémoire seulement : une fin en attente est perdue si le service redémarre. */
  private readonly endTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly logger: Logger,
    private readonly macrosManager: ConfigFileManager<MacrosConfigFile>,
    private readonly planificationsManager: ConfigFileManager<PlanificationsConfigFile>,
    private readonly schedulerRuntime: SchedulerRuntime,
    private readonly executionEngine: ExecutionEngine,
    private readonly catchUpWindowSeconds: number,
    private readonly stateWatcher?: StateWatcher
  ) {
    this.macros = {};
    this.planifications = {};
  }

  /** Arme une planification active selon le type de son trigger — SchedulerRuntime (temporel) ou
   *  StateWatcher (state_change, purement réactif : pas de minuteur à poser, juste s'assurer que
   *  StateWatcher voit la liste à jour des planifications actives). */
  private armIfActive(plan: PlanificationDefinition): void {
    if (!plan.active) return;
    if (plan.trigger.type === 'state_change') {
      this.stateWatcher?.setPlans(this.listPlanifications());
    } else {
      this.resumeOrSchedule(plan);
    }
  }

  /** Symétrique de armIfActive — désarme quel que soit le runtime concerné. */
  private disarm(plan: PlanificationDefinition): void {
    const end = this.endTimers.get(plan.name);
    if (end) { clearTimeout(end); this.endTimers.delete(plan.name); }
    if (plan.trigger.type === 'state_change') {
      this.stateWatcher?.unschedule(plan.name);
      this.stateWatcher?.setPlans(this.listPlanifications());
    } else {
      this.schedulerRuntime.unschedule(plan.name);
    }
  }

  /** Charge le contenu des fichiers YAML et reprogramme les planifications actives. */
  load(): void {
    this.macros = this.macrosManager.load().macros;
    this.planifications = this.planificationsManager.load().planifications;

    // Rattrapage : toute planification déjà sur disque avant l'ajout du champ `id` (ou modifiée à
    // la main) en reçoit un — jamais réattribué ensuite, voir types.ts::PlanificationDefinition.id.
    let backfilled = false;
    for (const plan of Object.values(this.planifications)) {
      if (typeof plan.id !== 'number') {
        plan.id = this.nextPlanificationId();
        backfilled = true;
      }
    }
    if (backfilled) this.persistPlanifications();

    this.cleanupCompletedPlanifications();
    this.logger.info('CommandHandler', `Chargé: ${Object.keys(this.macros).length} macro(s), ${Object.keys(this.planifications).length} planification(s) — programmation/rattrapage via scheduleActivePlanifications()`);
  }

  /**
   * ⭐ 24/09/2026 — programmation des planifications actives + RATTRAPAGE de celles manquées
   * pendant une coupure (≤ catchUpWindowSeconds, règle inchangée : la fenêtre court depuis l'heure
   * prévue). Séparé de load() pour que PlanificateurService ne l'appelle qu'une fois HA synchronisé :
   * un rattrapage déclenché avant le premier ha:ready était réinterprété par ia avec un référentiel
   * vide — l'action rattrapée était perdue.
   */
  scheduleActivePlanifications(): void {
    for (const plan of Object.values(this.planifications)) {
      // Les triggers state_change sont repris séparément par StateWatcher (voir
      // PlanificateurService), pas par SchedulerRuntime. Une planification déjà `completed_at`
      // (trigger non récurrent déjà consommé, demande utilisateur 12/08/2026) ne doit plus jamais
      // être reprogrammée — sinon le rattrapage après coupure (resumeOrSchedule) pourrait la
      // réexécuter puisque next_fire_at reste figé dans le passé une fois le trigger consommé.
      if (plan.active && !plan.completed_at && plan.trigger.type !== 'state_change') this.resumeOrSchedule(plan);
    }
    this.logger.info('CommandHandler', `${this.schedulerRuntime.listScheduled().length} planification(s) programmée(s)`);
  }

  /** Prochain identifiant numérique stable à attribuer — max courant + 1, jamais réutilisé. */
  private nextPlanificationId(): number {
    const ids = Object.values(this.planifications)
      .map((p) => p.id)
      .filter((id): id is number => typeof id === 'number');
    return ids.length ? Math.max(...ids) + 1 : 1;
  }

  /** Résout une planification par nom exact, ou par son identifiant numérique en repli (demande
   *  utilisateur : "désactive la planification 3") — jamais l'inverse (un nom qui ressemble à un
   *  nombre reste prioritaire sur toute correspondance par id). */
  private resolvePlan(nameOrId: string): PlanificationDefinition | undefined {
    const direct = this.planifications[nameOrId];
    if (direct) return direct;
    if (!/^\d+$/.test(nameOrId)) return undefined;
    const id = Number(nameOrId);
    return Object.values(this.planifications).find((p) => p.id === id);
  }

  /**
   * Reprise après (re)démarrage d'un trigger temporel (specs — voir conception state_change) :
   * si `next_fire_at` est déjà connu, reprend sur le délai restant plutôt que de recalculer un
   * délai complet depuis maintenant (évite qu'un `delay`/`duration` en cours reparte de zéro).
   * Si l'heure cible est déjà passée, rattrape immédiatement si dans la fenêtre configurée,
   * sinon abandonne visiblement (log + `missed`, voir handleTriggerFired pour l'effacement).
   */
  private resumeOrSchedule(plan: PlanificationDefinition): void {
    if (!plan.next_fire_at) {
      this.schedulerRuntime.schedule(plan);
      return;
    }

    const deltaMs = new Date(plan.next_fire_at).getTime() - Date.now();
    if (deltaMs > 0) {
      this.schedulerRuntime.resume(plan, deltaMs);
      return;
    }

    const overdueMs = -deltaMs;
    if (overdueMs <= this.catchUpWindowSeconds * 1000) {
      this.logger.info('CommandHandler', `"${plan.name}" en retard de ${Math.round(overdueMs / 1000)}s (dans la fenêtre de rattrapage) — déclenchement immédiat`);
      this.handleTriggerFired(plan).catch((e) => this.logger.error('CommandHandler', `Erreur de rattrapage pour "${plan.name}": ${e}`));
      // ⭐ demande utilisateur, 12/08/2026 — ce chemin de rattrapage appelle handleTriggerFired()
      // directement, en contournant SchedulerRuntime.arm()/fire() (et donc son marquage
      // completed_at pour les triggers non récurrents, voir scheduler-runtime.ts) : sans ce garde-
      // fou, schedule(plan) était appelé inconditionnellement, ce qui recalculait un délai complet
      // ET réarmait un trigger "delay"/"date" pourtant censé n'avoir lieu qu'une fois — il se
      // redéclenchait alors une seconde fois, plus tard, après le rattrapage.
      if (isRecurring(plan.trigger)) {
        this.schedulerRuntime.schedule(plan);
      } else {
        plan.completed_at = new Date().toISOString();
        this.persistPlanifications();
      }
    } else {
      this.logger.warn('CommandHandler', `"${plan.name}" manquée (en retard de ${Math.round(overdueMs / 1000)}s, au-delà de la fenêtre de rattrapage de ${this.catchUpWindowSeconds}s) — abandonnée`);
      plan.missed = true;
      if (isRecurring(plan.trigger)) {
        // ⭐ Bug réel constaté (demande utilisateur, 26/08/2026) : une planification récurrente
        // ("tous les jours à 2h30") manquée au-delà de la fenêtre de rattrapage se voyait bien
        // marquée `missed`, mais plus JAMAIS reprogrammée — sans schedule() ici, aucun minuteur
        // n'était réarmé, la planification restait active mais silencieuse indéfiniment (jusqu'au
        // redémarrage suivant, qui retombait dans le même cas puisque next_fire_at était encore
        // plus dans le passé). schedule() recalcule next_fire_at par rapport à MAINTENANT
        // (triggerToMs, scheduler.ts), donc saute naturellement l'occurrence manquée et vise la
        // suivante — `missed` reste affiché tel quel jusqu'au prochain déclenchement réussi
        // (handleTriggerFired() l'efface déjà, voir plus bas).
        this.schedulerRuntime.schedule(plan);
      } else {
        // Un déclenchement non récurrent manqué ne se représentera jamais — terminée au même titre
        // qu'un déclenchement réussi (voir cleanupCompletedPlanifications), sinon elle resterait
        // active indéfiniment, reconsidérée (et re-logguée "manquée") à chaque redémarrage.
        plan.completed_at = new Date().toISOString();
      }
      this.persistPlanifications();
    }
  }

  listMacros(): MacroDefinition[] {
    return Object.values(this.macros);
  }

  listPlanifications(): PlanificationDefinition[] {
    return Object.values(this.planifications);
  }

  getMacro(name: string): MacroDefinition | undefined {
    return this.macros[name];
  }

  /** Traite un ia:command (JSON structuré, jamais un ActionNode de premier niveau — specs ia §9). */
  async handleCommand(payload: DomoticNode & { correlation_id: string }): Promise<CorrelatedReponse> {
    const corr = payload.correlation_id;

    try {
      switch (payload.type) {
        case 'macro': {
          // ⭐ 24/09/2026 — validée AVANT d'être acceptée (schéma de stockage + commandes
          // exécutables) : une entrée refusée à l'écriture restait en mémoire et faisait échouer
          // toutes les écritures suivantes, et la réponse disait quand même « enregistrée ».
          const parsed = macroDefinitionSchema.safeParse(withoutCorrelation(payload));
          if (!parsed.success) return err(corr, `Macro refusée — format invalide : ${zodDetails(parsed.error)}`);
          const problems = commandProblems(parsed.data.steps);
          if (problems.length) return err(corr, `Macro refusée — ${problems.join(' ; ')}`);
          const previous = this.macros[parsed.data.name];
          this.macros[parsed.data.name] = parsed.data;
          if (!this.persistMacros()) {
            if (previous) this.macros[parsed.data.name] = previous; else delete this.macros[parsed.data.name];
            return err(corr, `Macro "${parsed.data.name}" non enregistrée (écriture du fichier en échec).`);
          }
          return ok(corr, `Macro "${parsed.data.name}" enregistrée avec ${parsed.data.steps.length} étape(s).`);
        }

        case 'planification': {
          const checked = this.checkPlanification(withoutCorrelation(payload));
          if ('error' in checked) return err(corr, `Planification refusée — ${checked.error}`);
          const plan = checked.plan;
          // ⭐ 24/09/2026 — recréation sous un nom existant : l'ancienne est d'abord DÉSARMÉE (avant,
          // son minuteur ou sa surveillance d'état continuait d'exécuter l'ancienne phrase).
          const existing = this.planifications[plan.name];
          if (existing) this.disarm(existing);
          // Conserve l'id existant si on recrée une planification sous le même nom (ex: "modifie
          // la planification X" reformulée en une nouvelle création complète par Mistral) — n'en
          // attribue un nouveau que pour un nom réellement inédit.
          plan.id = existing?.id ?? this.nextPlanificationId();
          this.planifications[plan.name] = plan;
          if (!this.persistPlanifications()) {
            if (existing) { this.planifications[plan.name] = existing; this.armIfActive(existing); } else delete this.planifications[plan.name];
            return err(corr, `Planification "${plan.name}" non enregistrée (écriture du fichier en échec).`);
          }
          this.armIfActive(plan);
          // ⭐ data.name (demande utilisateur, 12/08/2026) — l'UI "Modifier" (modale de création
          // réutilisée) doit savoir sous quel nom la version éditée a réellement été enregistrée :
          // si Mistral choisit un nom différent de l'original, l'ancienne entrée doit être
          // supprimée pour éviter un doublon (voir app.ts::setupNewPlanificationModal).
          return ok(corr, `Planification "${plan.name}" (#${plan.id}) enregistrée et ${plan.active ? 'activée' : 'désactivée'}.`, { name: plan.name, id: plan.id });
        }

        case 'gestion':
          return this.handleGestion(corr, payload as GestionNode & { correlation_id: string });

        case 'execution': {
          const exec = payload as ExecutionPayload & { correlation_id: string };
          const problems = commandProblems(exec.execution.steps.filter((st) => st.type === 'action').map((st) => ({ ...st, type: 'action' as const, order: st.order ?? '' })));
          if (problems.length) return err(corr, `Exécution refusée — ${problems.join(' ; ')}`);
          this.logger.info('CommandHandler', `Exécution directe "${exec.execution.trigger_name}" — ${exec.execution.steps.length} étape(s)`);
          this.executionEngine.executeSteps(exec.execution.steps, exec.execution.trigger_name)
            .then((r) => this.logRun(exec.execution.trigger_name, r))
            .catch((e) => this.logger.error('CommandHandler', `Erreur d'exécution: ${e}`));
          return ok(corr, `Exécution de "${exec.execution.trigger_name}" lancée.`);
        }

        // ⭐ 24/09/2026 — commande immédiate structurée (ex. macro dite : « je vais me coucher » →
        // {type:'macro_ref'} produit par l'interpréteur de ia) — auparavant refusée (« type non pris
        // en charge »). Exécutée par le même moteur que les planifications.
        case 'macro_ref':
        case 'sequence':
        case 'condition':
        case 'action':
        case 'wait': {
          if (payload.type === 'macro_ref' && !this.macros[payload.name]) return err(corr, `Macro "${payload.name}" inconnue.`);
          const node = withoutCorrelation(payload) as unknown as DomoticNode;
          const problems = commandProblems(node);
          if (problems.length) return err(corr, `Commande refusée — ${problems.join(' ; ')}`);
          const label = payload.type === 'macro_ref' ? payload.name : 'commande_directe';
          this.executionEngine.run(node, { trigger: label })
            .then((r) => this.logRun(label, r))
            .catch((e) => this.logger.error('CommandHandler', `Erreur d'exécution: ${e}`));
          return ok(corr, payload.type === 'macro_ref' ? `Macro "${payload.name}" lancée.` : 'Commande lancée.');
        }

        default:
          return err(corr, `Type non pris en charge en premier niveau: ${(payload as { type: string }).type}`);
      }
    } catch (error) {
      this.logger.error('CommandHandler', `Erreur: ${error}`);
      return err(corr, `Erreur interne: ${error}`);
    }
  }

  /**
   * Traite un ia:tool:execute (executer_action résolu, specs ia §7/§8) — traité comme une
   * planification immédiate et non répétitive, même mécanisme de déploiement que les deux autres
   * déclencheurs (specs planificateur §6).
   */
  async handleToolExecute(params: ExecuterActionParams & { correlation_id: string }): Promise<CorrelatedReponse> {
    const corr = params.correlation_id;
    try {
      // ⭐ 24/09/2026 — plus de repli « réinterprétation Mistral complète » (deployAndExecute) :
      // verbe/quoi/lieux sont déjà structurés par ia ; une commande non résolue est refusée avec
      // la raison exacte (verbe inconnu, aucune entité…), rien n'est envoyé à HA.
      const r = await this.executionEngine.executeImmediateAction(params.verbe, params.quoi, params.lieux, params.valeur);
      return r.success ? ok(corr, r.message) : err(corr, r.message);
    } catch (error) {
      this.logger.error('CommandHandler', `Erreur d'exécution de l'action immédiate: ${error}`);
      return err(corr, `Erreur interne: ${error}`);
    }
  }

  /**
   * Déclenchement d'une planification (minuteur, ou changement d'état pour `triggeredEntityId`/
   * `signal`, StateWatcher). ⭐ 24/09/2026 : exécute la structure `action` décidée à la création,
   * recalculée en code (ExecutionEngine.run) — plus de réinterprétation de la phrase par Mistral,
   * plus de cache de résolution (voir execution.ts).
   */
  async handleTriggerFired(plan: PlanificationDefinition, triggeredEntityId?: string, signal?: AbortSignal): Promise<void> {
    this.scheduleEnd(plan);

    let result: RunResult;
    try {
      result = await this.executionEngine.run(plan.action, { trigger: plan.name, signal, triggeredEntityId, nextFireAt: plan.next_fire_at });
    } catch (error) {
      // Redéclenchement "minuterie" (StateWatcher) pendant une attente — contrôle de flux normal.
      if (error instanceof AbortedExecutionError) return;
      throw error;
    }
    this.logRun(plan.name, result);

    let dirty = false;
    // Déclenchement effectué : efface l'indicateur « manqué » laissé par un rattrapage abandonné.
    if (plan.missed) { plan.missed = false; dirty = true; }
    // Anomalie : commande non résolue, condition non évaluable, macro inconnue… — effacée à la
    // prochaine exécution sans échec (même cycle de vie qu'avant).
    if (result.failures.length > 0) {
      plan.anomalie = { message: result.failures.join(' ; '), at: new Date().toISOString() };
      dirty = true;
    } else if (plan.anomalie) {
      plan.anomalie = undefined;
      dirty = true;
    }
    if (dirty) this.persistPlanifications();
  }

  /** ⭐ 24/09/2026 — fin d'une plage `window` (à `to`) ou d'une `duration` (après la durée) :
   *  exécute l'action inverse (inverseOf). Rien si aucune action n'a d'inverse évident. */
  private scheduleEnd(plan: PlanificationDefinition): void {
    const ms = plan.trigger.type === 'window' ? windowEndMs(plan.trigger)
      : plan.trigger.type === 'duration' ? durationEndMs(plan.trigger)
      : null;
    if (ms === null) return;
    const inverse = inverseOf(plan.action);
    if (!inverse) {
      this.logger.info('CommandHandler', `"${plan.name}" : aucune action à inverser en fin de ${plan.trigger.type === 'window' ? 'plage' : 'durée'}`);
      return;
    }
    const previous = this.endTimers.get(plan.name);
    if (previous) clearTimeout(previous);
    this.logger.info('CommandHandler', `"${plan.name}" : action de fin programmée dans ${Math.round(ms / 1000)}s`);
    this.endTimers.set(plan.name, setTimeout(() => {
      this.endTimers.delete(plan.name);
      this.executionEngine.run(inverse, { trigger: `${plan.name} (fin)` })
        .then((r) => this.logRun(`${plan.name} (fin)`, r))
        .catch((e) => this.logger.error('CommandHandler', `Erreur d'exécution de la fin de "${plan.name}": ${e}`));
    }, ms));
  }

  private logRun(label: string, result: RunResult): void {
    if (result.failures.length) this.logger.warn('CommandHandler', `"${label}" : ${result.actions} action(s), ${result.failures.length} échec(s) — ${result.failures.join(' ; ')}`);
    else this.logger.info('CommandHandler', `"${label}" : ${result.actions} action(s) exécutée(s)`);
  }

  /** ⭐ 24/09/2026 — validation d'une planification reçue (création ou « modifier ») : schéma de
   *  stockage, commandes exécutables (verbe connu + quoi), déclencheur calculable. Les champs
   *  d'état runtime éventuellement fournis sont retirés (gérés par planificateur seul). */
  private checkPlanification(candidate: unknown): { plan: PlanificationDefinition } | { error: string } {
    const parsed = planificationDefinitionSchema.safeParse(candidate);
    if (!parsed.success) return { error: `format invalide : ${zodDetails(parsed.error)}` };
    const plan = parsed.data;
    delete plan.next_fire_at; delete plan.pending; delete plan.missed; delete plan.anomalie; delete plan.completed_at;
    const problems = commandProblems(plan.action);
    if (problems.length) return { error: problems.join(' ; ') };
    const t = plan.trigger;
    if (t.type === 'state_change') {
      if (!t.to_state || (!t.entity_id && !t.domain)) return { error: 'déclencheur state_change sans to_state ni entity_id/domain' };
    } else if (t.type !== 'sun' && triggerToMs(t, this.logger) === null) {
      return { error: `déclencheur « ${t.type} » incomplet ou non reconnu` };
    }
    return { plan };
  }

  // ─── Gestion (lister/activer/désactiver/supprimer/modifier) ──────────────────────────────

  private handleGestion(corr: string, g: GestionNode & { correlation_id: string }): CorrelatedReponse {
    switch (g.operation) {
      case 'lister': {
        if (g.cible === 'macro') {
          const list = this.listMacros().map((m) => m.name);
          return ok(corr, list.length ? `Macros: ${list.join(', ')}.` : 'Aucune macro enregistrée.', list);
        }
        if (g.cible === 'planification') {
          const list = this.listPlanifications().map((p) => `${p.name} (${p.active ? 'active' : 'inactive'})`);
          return ok(corr, list.length ? `Planifications: ${list.join(', ')}.` : 'Aucune planification enregistrée.', list);
        }
        if (g.cible === 'tout') {
          const m = this.listMacros().map((m) => m.name);
          const p = this.listPlanifications().map((p) => `${p.name} (${p.active ? '✓' : '✗'})`);
          return ok(corr, `Macros: ${m.join(', ') || 'aucune'}. Planifications: ${p.join(', ') || 'aucune'}.`, { macros: m, planifications: p });
        }
        return err(corr, `Cible inconnue: ${g.cible}`);
      }

      case 'activer': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible !== 'planification') return err(corr, `Activation non supportée pour: ${g.cible}`);
        const plan = this.resolvePlan(g.name);
        if (!plan) return err(corr, `"${g.name}" introuvable.`);
        if (plan.active && !plan.completed_at) return ok(corr, `Planification "${plan.name}" déjà active.`);
        plan.active = true;
        // ⭐ Réactivation explicite (demande utilisateur, 12/08/2026) — efface `completed_at` :
        // sans ça, un trigger non récurrent déjà consommé resterait inerte malgré l'activation
        // explicite (armIfActive/load() ne reprogramment jamais une planification terminée).
        plan.completed_at = undefined;
        // ⭐ 24/09/2026 — repart d'une échéance RECALCULÉE : l'ancienne (d'avant la désactivation)
        // la faisait passer pour « en retard » → marquée manquée, terminée sans s'exécuter
        // (ponctuelle), ou exécutée tout de suite (< fenêtre de rattrapage).
        plan.next_fire_at = undefined;
        plan.missed = undefined;
        this.persistPlanifications();
        this.armIfActive(plan);
        return ok(corr, `Planification "${plan.name}" activée.`);
      }

      case 'desactiver': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible !== 'planification') return err(corr, `Désactivation non supportée pour: ${g.cible}`);
        const plan = this.resolvePlan(g.name);
        if (!plan) return err(corr, `"${g.name}" introuvable.`);
        plan.active = false;
        this.persistPlanifications();
        this.disarm(plan);
        return ok(corr, `Planification "${plan.name}" désactivée.`);
      }

      case 'supprimer': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible === 'macro') {
          if (!this.macros[g.name]) return err(corr, `Macro "${g.name}" introuvable.`);
          delete this.macros[g.name];
          this.persistMacros();
          return ok(corr, `Macro "${g.name}" supprimée.`);
        }
        if (g.cible === 'planification') {
          const plan = this.resolvePlan(g.name);
          if (!plan) return err(corr, `Planification "${g.name}" introuvable.`);
          this.disarm(plan);
          delete this.planifications[plan.name];
          this.persistPlanifications();
          return ok(corr, `Planification "${plan.name}" supprimée.`);
        }
        return err(corr, `Suppression non supportée pour: ${g.cible}`);
      }

      case 'modifier': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible !== 'planification') return err(corr, `Modification non supportée pour: ${g.cible}`);
        const plan = this.resolvePlan(g.name);
        if (!plan || !g.modifications) return err(corr, `"${g.name}" introuvable ou modifications manquantes.`);
        // ⭐ 24/09/2026 — le nom est la clé de stockage : le changer ici désynchronisait l'entrée.
        if (g.modifications.name !== undefined && g.modifications.name !== plan.name) {
          return err(corr, `Le nom d'une planification ne se modifie pas (supprimer puis recréer).`);
        }
        // Validée comme une création AVANT d'être appliquée (même garde-fou, rien n'est touché si
        // refusée) ; repart d'une échéance recalculée (l'ancienne ignorait la nouvelle heure).
        const checked = this.checkPlanification({ ...plan, ...g.modifications, name: plan.name });
        if ('error' in checked) return err(corr, `Modification refusée — ${checked.error}`);
        const updated: PlanificationDefinition = { ...checked.plan, id: plan.id };
        this.disarm(plan);
        this.planifications[plan.name] = updated;
        if (!this.persistPlanifications()) {
          this.planifications[plan.name] = plan;
          this.armIfActive(plan);
          return err(corr, `Planification "${plan.name}" non modifiée (écriture du fichier en échec).`);
        }
        this.armIfActive(updated);
        return ok(corr, `Planification "${plan.name}" modifiée.`);
      }

      default:
        return err(corr, `Opération inconnue: ${g.operation}`);
    }
  }

  private persistMacros(): boolean {
    const result = this.macrosManager.save({ macros: this.macros });
    if (!result.success) this.logger.error('CommandHandler', `Échec de sauvegarde des macros: ${result.error}`);
    return result.success;
  }

  persistPlanifications(): boolean {
    const result = this.planificationsManager.save({ planifications: this.planifications });
    if (!result.success) this.logger.error('CommandHandler', `Échec de sauvegarde des planifications: ${result.error}`);
    return result.success;
  }

  /** ⭐ Purge des planifications terminées depuis plus de 2 jours (demande utilisateur, 12/08/2026)
   *  — évite d'accumuler indéfiniment des triggers non récurrents déjà consommés (delay/date/
   *  duration, voir SchedulerRuntime). Appelée au chargement (load()) et périodiquement
   *  (PlanificateurService) — jamais sur une planification encore active sans completed_at, ni sur
   *  un trigger state_change (récurrent par défaut, n'atteint jamais cet état). */
  cleanupCompletedPlanifications(): void {
    const cutoff = Date.now() - COMPLETED_RETENTION_MS;
    let removed = 0;
    for (const [name, plan] of Object.entries(this.planifications)) {
      if (plan.completed_at && new Date(plan.completed_at).getTime() < cutoff) {
        delete this.planifications[name];
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.info('CommandHandler', `${removed} planification(s) terminée(s) depuis plus de 2 jours — supprimée(s).`);
      this.persistPlanifications();
    }
  }
}

function ok(corr: string, message: string, data?: unknown): CorrelatedReponse {
  return { correlation_id: corr, success: true, message, data };
}

function err(corr: string, message: string): CorrelatedReponse {
  return { correlation_id: corr, success: false, message };
}

function withoutCorrelation(payload: object): Record<string, unknown> {
  const { correlation_id: _c, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function zodDetails(error: ZodError): string {
  return error.errors.slice(0, 3).map((e) => `${e.path.join('.') || 'racine'}: ${e.message}`).join('; ');
}

/** ⭐ 24/09/2026 — toute commande (nœud action, à toute profondeur) doit porter un verbe connu du
 *  moteur et un quoi : sans eux, elle ne pourrait jamais être exécutée (plus de repli vers l'agent
 *  de conversation de HA, qui est ia lui-même). */
function commandProblems(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => commandProblems(n, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const n = node as Record<string, unknown>;
  if (n.type === 'action') {
    const label = String(n.order || `${n.verbe ?? ''} ${n.quoi ?? ''}`).trim() || 'commande';
    if (!n.verbe || !n.quoi) found.push(`« ${label} » : verbe/quoi manquant`);
    else if (!isKnownVerb(String(n.verbe))) found.push(`« ${label} » : verbe « ${n.verbe} » inconnu du moteur`);
  }
  for (const key of ['then', 'else', 'steps', 'action']) {
    if (n[key] !== undefined) commandProblems(n[key], found);
  }
  return found;
}
