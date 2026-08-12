/**
 * PlanificateurService — orchestrateur unique de l'application planificateur.
 *
 * Point d'exécution unique du système (specs §1) : reçoit le JSON structuré et les appels d'outil
 * résolus depuis `ia` (EventBus), gère le cycle de vie des minuteurs, et exécute réellement les
 * actions sur HA (resolution.ts + HaCommandService, ou repli HaWsClient.processConversation).
 */

import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  HaCommandService,
  type IEventBus,
  type Logger,
  type IAppConfigProvider,
  type HaStructureRegistry,
  type HaWsClient
} from '../../../core/dist/exports';
import { planificateurConfigSchema, type PlanificateurConfig } from './config-schema';
import { macrosConfigSchema, planificationsConfigSchema, DEFAULT_MACROS_CONFIG, DEFAULT_PLANIFICATIONS_CONFIG, type MacrosConfigFile, type PlanificationsConfigFile } from './storage-schema';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { SchedulerRuntime } from './scheduler-runtime';
import { StateWatcher } from './state-watcher';
import { ExecutionEngine } from './execution';
import { CommandHandler } from './handler';
import type { DomoticNode, ExecuterActionParams, CorrelatedReponse } from './types';
import { PLANIFICATEUR_CLIENT_EVENTS, PLANIFICATEUR_SOCKET_EVENTS } from './socket-events';

export interface IPlanificateurService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Une entrée du journal des actions reçues de `ia` (ia:command / ia:tool:execute). */
interface PlanificateurAction {
  at: string;
  source: 'ia:command' | 'ia:tool:execute';
  request: string;
  reply: string;
  success: boolean;
}

export class PlanificateurService implements IPlanificateurService {
  private readonly config: PlanificateurConfig;
  private readonly macrosManager: ConfigFileManager<MacrosConfigFile>;
  private readonly planificationsManager: ConfigFileManager<PlanificationsConfigFile>;
  private readonly schedulerRuntime: SchedulerRuntime;
  private readonly stateWatcher?: StateWatcher;
  private readonly executionEngine: ExecutionEngine;
  private readonly handler: CommandHandler;
  private readonly haCommandService?: HaCommandService;
  private readonly recentActions: PlanificateurAction[] = [];
  // ⭐ Purge périodique des planifications terminées depuis plus de 2 jours (demande utilisateur,
  // 12/08/2026) — cleanupCompletedPlanifications() tourne déjà une fois au chargement (handler.load()),
  // ce timer couvre le cas d'un service qui reste actif plusieurs jours sans redémarrer.
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    configProvider: IAppConfigProvider<PlanificateurConfig>,
    private readonly haStructureRegistry?: HaStructureRegistry,
    private readonly haWsClient?: HaWsClient
  ) {
    this.config = planificateurConfigSchema.parse(configProvider.getAppConfig());

    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'planificateur');
    this.macrosManager = new ConfigFileManager<MacrosConfigFile>(
      path.join(dataDir, this.config.macrosFile),
      macrosConfigSchema,
      DEFAULT_MACROS_CONFIG,
      this.logger,
      'macros'
    );
    this.planificationsManager = new ConfigFileManager<PlanificationsConfigFile>(
      path.join(dataDir, this.config.planificationsFile),
      planificationsConfigSchema,
      DEFAULT_PLANIFICATIONS_CONFIG,
      this.logger,
      'planifications'
    );

    this.haCommandService = this.haWsClient
      ? new HaCommandService(this.haWsClient, {}, this.logger)
      : undefined;

    if (!this.haCommandService) {
      this.logger.warn('PlanificateurService', 'HaWsClient indisponible — exécution directe désactivée (ha.ws_enable=false ?), seul le repli conversation.process aurait pu être tenté, également indisponible.');
    }

    this.schedulerRuntime = new SchedulerRuntime(
      this.logger,
      (plan) => {
        this.handler.handleTriggerFired(plan).catch((e) => this.logger.error('PlanificateurService', `Erreur de déploiement pour "${plan.name}": ${e}`));
      },
      () => this.handler.persistPlanifications()
    );

    // Triggers state_change — nécessite le WebSocket HA (Mode A), même garde que haCommandService.
    // Sans lui, les planifications state_change restent inertes (dégradation cohérente avec le
    // reste de l'app quand ha.ws_enable=false).
    this.stateWatcher = this.haWsClient
      ? new StateWatcher(
          this.haWsClient,
          this.logger,
          (plan, entityId, signal) => this.handler.handleTriggerFired(plan, entityId, signal),
          () => this.handler.persistPlanifications()
        )
      : undefined;

    if (!this.stateWatcher) {
      this.logger.warn('PlanificateurService', 'HaWsClient indisponible — triggers state_change désactivés (ha.ws_enable=false ?).');
    }

    this.executionEngine = new ExecutionEngine(
      this.eventBus,
      this.logger,
      this.haStructureRegistry,
      this.haCommandService,
      this.haWsClient,
      this.config.deployTimeoutMs
    );

    this.handler = new CommandHandler(
      this.logger,
      this.macrosManager,
      this.planificationsManager,
      this.schedulerRuntime,
      this.executionEngine,
      this.config.catchUpWindowSeconds,
      this.stateWatcher
    );
  }

  async start(): Promise<void> {
    this.logger.info('PlanificateurService', 'Démarrage du service planificateur...');

    this.handler.load();
    this.stateWatcher?.start(this.handler.listPlanifications());
    this.wireEventBus();
    this.setupSocketEventListeners();
    this.emitStatus();
    this.emitMacros();
    this.emitPlanifications();

    // Toutes les heures suffit : la fenêtre de rétention est de 2 jours, pas besoin d'une purge fine.
    this.cleanupTimer = setInterval(() => this.handler.cleanupCompletedPlanifications(), 60 * 60 * 1000);

    this.logger.info('PlanificateurService', 'Service planificateur démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('PlanificateurService', 'Arrêt du service planificateur...');
    this.schedulerRuntime.stopAll();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.logger.info('PlanificateurService', 'Service planificateur arrêté');
  }

  // ==========================================================================
  // Communication interne avec `ia` (EventBus) — specs §9
  // ==========================================================================

  private wireEventBus(): void {
    this.eventBus.onGeneric<DomoticNode & { correlation_id: string }>('ia:command', (payload) => {
      this.handler.handleCommand(payload)
        .then((reply) => {
          this.recordAction('ia:command', payload, reply);
          this.eventBus.emitGeneric('ia:command:reply', reply);
          // Une planification/macro créée ou gérée par conversation (payload.type 'planification'
          // ou 'gestion') doit apparaître en direct sur les dashboards déjà ouverts — contrairement
          // aux actions UI directes (PLANIFICATION_ACTIVER etc. ci-dessous), ce chemin n'appelait
          // jusqu'ici aucun emit*(), le tableau de bord restait figé jusqu'à un rafraîchissement
          // manuel (constaté en testant en direct la nouvelle boîte de dialogue de création).
          if (payload.type === 'planification' || payload.type === 'gestion') {
            this.emitPlanifications();
            this.emitStatus();
          } else if (payload.type === 'macro') {
            this.emitMacros();
          }
        })
        .catch((e) => this.logger.error('PlanificateurService', `Erreur ia:command: ${e}`));
    });

    this.eventBus.onGeneric<ExecuterActionParams & { correlation_id: string }>('ia:tool:execute', (payload) => {
      this.handler.handleToolExecute(payload)
        .then((reply) => {
          this.recordAction('ia:tool:execute', payload, reply);
          this.eventBus.emitGeneric('ia:tool:execute:reply', reply);
        })
        .catch((e) => this.logger.error('PlanificateurService', `Erreur ia:tool:execute: ${e}`));
    });
  }

  /** Journalise une action reçue de `ia`, en mémoire (20 dernières) — demande utilisateur, voir
   *  socket-events.ts::ACTIONS_LIST. Même principe que IaService.recordExchange côté `ia`. */
  private recordAction(source: PlanificateurAction['source'], request: unknown, reply: CorrelatedReponse): void {
    const { correlation_id: _correlation_id, ...requestWithoutCorrelation } = request as Record<string, unknown>;
    this.recentActions.unshift({
      at: new Date().toISOString(),
      source,
      request: JSON.stringify(requestWithoutCorrelation, null, 2),
      reply: JSON.stringify(reply, null, 2),
      success: reply.success
    });
    if (this.recentActions.length > 20) this.recentActions.length = 20;
    this.eventBus.emitGeneric(PLANIFICATEUR_SOCKET_EVENTS.ACTIONS_LIST, this.recentActions);
  }

  // ==========================================================================
  // Statut / UI (Socket.io, via EventBus générique)
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric(PLANIFICATEUR_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.onGeneric(PLANIFICATEUR_CLIENT_EVENTS.GET_MACROS, () => this.emitMacros());
    this.eventBus.onGeneric(PLANIFICATEUR_CLIENT_EVENTS.GET_PLANIFICATIONS, () => this.emitPlanifications());
    this.eventBus.onGeneric(PLANIFICATEUR_CLIENT_EVENTS.GET_ACTIONS, () => {
      this.eventBus.emitGeneric(PLANIFICATEUR_SOCKET_EVENTS.ACTIONS_LIST, this.recentActions);
    });
    this.eventBus.onGeneric(PLANIFICATEUR_CLIENT_EVENTS.GET_HA_COMMANDS, () => {
      this.eventBus.emitGeneric(PLANIFICATEUR_SOCKET_EVENTS.HA_COMMANDS_LIST, this.executionEngine.getRecentHaCommands());
    });

    this.eventBus.onGeneric<{ name: string }>(PLANIFICATEUR_CLIENT_EVENTS.PLANIFICATION_ACTIVER, ({ name }) => {
      this.handler.handleCommand({ type: 'gestion', operation: 'activer', cible: 'planification', name, correlation_id: 'ui' })
        .then(() => { this.emitPlanifications(); this.emitStatus(); });
    });

    this.eventBus.onGeneric<{ name: string }>(PLANIFICATEUR_CLIENT_EVENTS.PLANIFICATION_DESACTIVER, ({ name }) => {
      this.handler.handleCommand({ type: 'gestion', operation: 'desactiver', cible: 'planification', name, correlation_id: 'ui' })
        .then(() => { this.emitPlanifications(); this.emitStatus(); });
    });

    this.eventBus.onGeneric<{ name: string }>(PLANIFICATEUR_CLIENT_EVENTS.PLANIFICATION_SUPPRIMER, ({ name }) => {
      this.handler.handleCommand({ type: 'gestion', operation: 'supprimer', cible: 'planification', name, correlation_id: 'ui' })
        .then(() => { this.emitPlanifications(); this.emitStatus(); });
    });

    this.eventBus.onGeneric<{ name: string }>(PLANIFICATEUR_CLIENT_EVENTS.MACRO_SUPPRIMER, ({ name }) => {
      this.handler.handleCommand({ type: 'gestion', operation: 'supprimer', cible: 'macro', name, correlation_id: 'ui' })
        .then(() => { this.emitMacros(); });
    });

    // ⭐ Consultation YAML (demande utilisateur, 12/08/2026) — même bibliothèque que le stockage
    // sur disque (ConfigFileManager), pour un rendu cohérent avec ce qui est réellement persisté.
    this.eventBus.onGeneric<{ name: string }>(PLANIFICATEUR_CLIENT_EVENTS.PLANIFICATION_YAML_GET, ({ name }) => {
      const plan = this.handler.listPlanifications().find((p) => p.name === name);
      const text = plan ? yaml.dump(plan, { lineWidth: -1 }) : `# Planification "${name}" introuvable.`;
      this.eventBus.emitGeneric(PLANIFICATEUR_SOCKET_EVENTS.PLANIFICATION_YAML, { name, yaml: text });
    });
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('planificateur:status', {
      macrosCount: this.handler.listMacros().length,
      planificationsCount: this.handler.listPlanifications().length,
      activeSchedules: this.schedulerRuntime.listScheduled()
    });
  }

  private emitMacros(): void {
    this.eventBus.emitGeneric('planificateur:macros:list', this.handler.listMacros());
  }

  private emitPlanifications(): void {
    this.eventBus.emitGeneric('planificateur:planifications:list', this.handler.listPlanifications());
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<PlanificateurConfig>,
    haStructureRegistry?: HaStructureRegistry,
    haWsClient?: HaWsClient
  ): PlanificateurService {
    return new PlanificateurService(eventBus, logger, configProvider, haStructureRegistry, haWsClient);
  }
}
