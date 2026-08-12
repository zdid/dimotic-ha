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
import { isRecurring } from './scheduler';
import type { StateWatcher } from './state-watcher';
import type { ExecutionEngine } from './execution';

// ⭐ Rétention des planifications terminées (demande utilisateur, 12/08/2026) — voir
// CommandHandler.cleanupCompletedPlanifications().
const COMPLETED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export class CommandHandler {
  private macros: Record<string, MacroDefinition>;
  private planifications: Record<string, PlanificationDefinition>;

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

    for (const plan of Object.values(this.planifications)) {
      // Les triggers state_change sont repris séparément par StateWatcher (voir
      // PlanificateurService), pas par SchedulerRuntime. Une planification déjà `completed_at`
      // (trigger non récurrent déjà consommé, demande utilisateur 12/08/2026) ne doit plus jamais
      // être reprogrammée — sinon le rattrapage après coupure (resumeOrSchedule) pourrait la
      // réexécuter puisque next_fire_at reste figé dans le passé une fois le trigger consommé.
      if (plan.active && !plan.completed_at && plan.trigger.type !== 'state_change') this.resumeOrSchedule(plan);
    }
    this.cleanupCompletedPlanifications();
    this.logger.info('CommandHandler', `Chargé: ${Object.keys(this.macros).length} macro(s), ${Object.keys(this.planifications).length} planification(s) (${this.schedulerRuntime.listScheduled().length} active(s))`);
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
      // Un déclenchement non récurrent manqué ne se représentera jamais — terminée au même titre
      // qu'un déclenchement réussi (voir cleanupCompletedPlanifications), sinon elle resterait
      // active indéfiniment, reconsidérée (et re-logguée "manquée") à chaque redémarrage.
      if (!isRecurring(plan.trigger)) plan.completed_at = new Date().toISOString();
      this.persistPlanifications();
    }
  }

  listMacros(): MacroDefinition[] {
    return Object.values(this.macros);
  }

  listPlanifications(): PlanificationDefinition[] {
    return Object.values(this.planifications);
  }

  findMacroByUtterance(text: string): MacroDefinition | undefined {
    const normalized = text.trim().toLowerCase();
    return Object.values(this.macros).find((m) => normalized.includes(m.name.toLowerCase()));
  }

  /** Traite un ia:command (JSON structuré, jamais un ActionNode de premier niveau — specs ia §9). */
  async handleCommand(payload: DomoticNode & { correlation_id: string }): Promise<CorrelatedReponse> {
    const corr = payload.correlation_id;

    try {
      switch (payload.type) {
        case 'macro': {
          const macro = payload as MacroDefinition & { correlation_id: string };
          this.macros[macro.name] = macro;
          this.persistMacros();
          return ok(corr, `Macro "${macro.name}" enregistrée avec ${macro.steps.length} étape(s).`);
        }

        case 'planification': {
          const plan = payload as PlanificationDefinition & { correlation_id: string };
          // Conserve l'id existant si on recrée une planification sous le même nom (ex: "modifie
          // la planification X" reformulée en une nouvelle création complète par Mistral) — n'en
          // attribue un nouveau que pour un nom réellement inédit.
          plan.id = this.planifications[plan.name]?.id ?? this.nextPlanificationId();
          this.planifications[plan.name] = plan;
          this.persistPlanifications();
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
          this.logger.info('CommandHandler', `Exécution directe "${exec.execution.trigger_name}" — ${exec.execution.steps.length} étape(s)`);
          this.executionEngine.executeSteps(exec.execution.steps, exec.execution.trigger_name).catch((e) =>
            this.logger.error('CommandHandler', `Erreur d'exécution: ${e}`)
          );
          return ok(corr, `Exécution de "${exec.execution.trigger_name}" lancée.`);
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
    const phrase = params.phrase_originale
      || `${params.verbe} ${params.quoi}${params.lieux?.length ? ' ' + params.lieux.join(' ') : ''}`;

    try {
      const result = await this.executionEngine.deployAndExecute('action_immediate', phrase, this.listMacros());
      return result.success
        ? ok(corr, `Action "${phrase}" exécutée.`)
        : err(corr, `Action "${phrase}" non exécutée: ${result.message}`);
    } catch (error) {
      this.logger.error('CommandHandler', `Erreur d'exécution de l'action immédiate: ${error}`);
      return err(corr, `Erreur interne: ${error}`);
    }
  }

  /**
   * Déploiement déclenché par un minuteur (specs §6, premier cas) — voir PlanificateurService.
   * `triggeredEntityId`/`signal` : uniquement renseignés pour un déclenchement `state_change`
   * (StateWatcher) — voir execution.ts::deployAndExecute.
   */
  async handleTriggerFired(plan: PlanificationDefinition, triggeredEntityId?: string, signal?: AbortSignal): Promise<void> {
    const result = await this.executionEngine.deployAndExecute(plan.name, plan.phrase_originale, this.listMacros(), triggeredEntityId, signal, plan.next_fire_at);
    let dirty = false;
    // Une exécution RÉUSSIE efface l'indicateur "manqué" laissé par un rattrapage abandonné
    // précédent (demande utilisateur : disparaît à la prochaine exécution, s'il y en a une).
    if (result.success && plan.missed) {
      plan.missed = false;
      dirty = true;
    }
    // ⭐ Anomalie quoi/lieux/entity_id (demande utilisateur, 12/08/2026) — positionnée uniquement
    // quand l'échec vient précisément de la vérification référentielle côté ia
    // (referenceValidator.ts, DeployReply.invalidReferences), pas de n'importe quel échec de
    // déploiement (timeout, JSON inexploitable) : ceux-là restent un simple log, pas un état
    // persistant de la planification — même lifecycle que `missed`, effacée à la prochaine
    // exécution réussie.
    if (result.invalidReferences) {
      plan.anomalie = { message: result.message, at: new Date().toISOString() };
      dirty = true;
    } else if (result.success && plan.anomalie) {
      plan.anomalie = undefined;
      dirty = true;
    }
    if (dirty) this.persistPlanifications();
  }

  /** Déploiement déclenché par une macro dite directement (specs §6, deuxième cas). */
  async handleMacroUtterance(macro: MacroDefinition, utterance: string): Promise<void> {
    await this.executionEngine.deployAndExecute(macro.name, utterance, this.listMacros());
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
        plan.active = true;
        // ⭐ Réactivation explicite (demande utilisateur, 12/08/2026) — efface `completed_at` :
        // sans ça, un trigger non récurrent déjà consommé resterait inerte malgré l'activation
        // explicite (armIfActive/load() ne reprogramment jamais une planification terminée).
        plan.completed_at = undefined;
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
        this.disarm(plan);
        Object.assign(plan, g.modifications);
        // Modification explicite (demande utilisateur, 12/08/2026) : même raisonnement que
        // "activer" ci-dessus — une planification modifiée doit pouvoir se redéclencher.
        plan.completed_at = undefined;
        this.persistPlanifications();
        this.armIfActive(plan);
        return ok(corr, `Planification "${plan.name}" modifiée.`);
      }

      default:
        return err(corr, `Opération inconnue: ${g.operation}`);
    }
  }

  private persistMacros(): void {
    const result = this.macrosManager.save({ macros: this.macros });
    if (!result.success) this.logger.error('CommandHandler', `Échec de sauvegarde des macros: ${result.error}`);
  }

  persistPlanifications(): void {
    const result = this.planificationsManager.save({ planifications: this.planifications });
    if (!result.success) this.logger.error('CommandHandler', `Échec de sauvegarde des planifications: ${result.error}`);
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
