/**
 * Traitement des commandes reçues de `ia` (ia:command — JSON structuré détecté en conversation) et
 * des appels d'outil résolus (ia:tool:execute — action immédiate, specs ia §7/§8). Port adapté de
 * ts-planner/src/handler.ts : CRUD sur les fichiers YAML au lieu du store en mémoire du prototype,
 * réponses via EventBus corrélé au lieu de MQTT.
 */

import type { Logger } from '../../../core/src/exports';
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
import type { StateWatcher } from './state-watcher';
import type { ExecutionEngine } from './execution';

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

    for (const plan of Object.values(this.planifications)) {
      // Les triggers state_change sont repris séparément par StateWatcher (voir
      // PlanificateurService), pas par SchedulerRuntime.
      if (plan.active && plan.trigger.type !== 'state_change') this.resumeOrSchedule(plan);
    }
    this.logger.info('CommandHandler', `Chargé: ${Object.keys(this.macros).length} macro(s), ${Object.keys(this.planifications).length} planification(s) (${this.schedulerRuntime.listScheduled().length} active(s))`);
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
      this.schedulerRuntime.schedule(plan);
    } else {
      this.logger.warn('CommandHandler', `"${plan.name}" manquée (en retard de ${Math.round(overdueMs / 1000)}s, au-delà de la fenêtre de rattrapage de ${this.catchUpWindowSeconds}s) — abandonnée`);
      plan.missed = true;
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
          this.planifications[plan.name] = plan;
          this.persistPlanifications();
          this.armIfActive(plan);
          return ok(corr, `Planification "${plan.name}" enregistrée et ${plan.active ? 'activée' : 'désactivée'}.`);
        }

        case 'gestion':
          return this.handleGestion(corr, payload as GestionNode & { correlation_id: string });

        case 'execution': {
          const exec = payload as ExecutionPayload & { correlation_id: string };
          this.logger.info('CommandHandler', `Exécution directe "${exec.execution.trigger_name}" — ${exec.execution.steps.length} étape(s)`);
          this.executionEngine.executeSteps(exec.execution.steps).catch((e) =>
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
    const result = await this.executionEngine.deployAndExecute(plan.name, plan.phrase_originale, this.listMacros(), triggeredEntityId, signal);
    // Une exécution RÉUSSIE efface l'indicateur "manqué" laissé par un rattrapage abandonné
    // précédent (demande utilisateur : disparaît à la prochaine exécution, s'il y en a une).
    if (result.success && plan.missed) {
      plan.missed = false;
      this.persistPlanifications();
    }
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
        const plan = this.planifications[g.name];
        if (!plan) return err(corr, `"${g.name}" introuvable.`);
        plan.active = true;
        this.persistPlanifications();
        this.armIfActive(plan);
        return ok(corr, `Planification "${g.name}" activée.`);
      }

      case 'desactiver': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible !== 'planification') return err(corr, `Désactivation non supportée pour: ${g.cible}`);
        const plan = this.planifications[g.name];
        if (!plan) return err(corr, `"${g.name}" introuvable.`);
        plan.active = false;
        this.persistPlanifications();
        this.disarm(plan);
        return ok(corr, `Planification "${g.name}" désactivée.`);
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
          const plan = this.planifications[g.name];
          if (!plan) return err(corr, `Planification "${g.name}" introuvable.`);
          this.disarm(plan);
          delete this.planifications[g.name];
          this.persistPlanifications();
          return ok(corr, `Planification "${g.name}" supprimée.`);
        }
        return err(corr, `Suppression non supportée pour: ${g.cible}`);
      }

      case 'modifier': {
        if (!g.name) return err(corr, 'Nom requis.');
        if (g.cible !== 'planification') return err(corr, `Modification non supportée pour: ${g.cible}`);
        const plan = this.planifications[g.name];
        if (!plan || !g.modifications) return err(corr, `"${g.name}" introuvable ou modifications manquantes.`);
        this.disarm(plan);
        Object.assign(plan, g.modifications);
        this.persistPlanifications();
        this.armIfActive(plan);
        return ok(corr, `Planification "${g.name}" modifiée.`);
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
}

function ok(corr: string, message: string, data?: unknown): CorrelatedReponse {
  return { correlation_id: corr, success: true, message, data };
}

function err(corr: string, message: string): CorrelatedReponse {
  return { correlation_id: corr, success: false, message };
}
