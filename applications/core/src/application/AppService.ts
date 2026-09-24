// src/application/AppService.ts
// Service d'orchestration de l'application
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §10.1 et specs-presentation-v2.0.md §4.2

import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { EventBus } from './EventBus';
import { ApplicationManager } from './ApplicationManager';
import { CoreDeployService } from './CoreDeployService';
import { HaStackDeployService } from './HaStackDeployService';
import { HaplanLovelaceDeployService } from './HaplanLovelaceDeployService';
import { Zigbee2mqttDeployService } from './Zigbee2mqttDeployService';
import { TargetGossipService } from './TargetGossipService';
import { AppGossipService } from './AppGossipService';
import { HaPostInstallService, type PostInstallRequest } from './HaPostInstallService';
import { HaQueryBridge } from './HaQueryBridge';
import type { DeploymentTargetConfig, HaStackTargetConfig, Zigbee2mqttTargetConfig, ExternalSiteConfig } from '../infrastructure/config/schema';
import type { RemoteAction } from '../infrastructure/remote/RemoteUnitController';
import { ensureGlobalSshKey } from '../infrastructure/remote/SshClient';
import { isRunningInDocker } from '../infrastructure/runtime/docker';
import { getPrimaryIPv4Address } from '../infrastructure/runtime/network';
import { ProcessSupervisor, SupervisorEventBridge } from '../supervisor';
import type { RestartManager } from './RestartManager';
import type { SocketBridge } from './SocketBridge';
import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { Logger } from '../infrastructure/logger/index';
import type { HaWsClient } from '../ha/sync/HaWsClient';
import type { HaStructureRegistry } from '../ha/sync/HaStructureRegistry';
import { HaRegistryTracer } from '../ha/sync/HaRegistryTracer';
import type { HaRawEntity } from '../ha/types/ha-entity';
import type { HaWsConfig, ConfigSaveResult } from '../types/config';
import type {
  TechnicalConfig,
  AppConfig,
  ConfigValidationResult,
  ApplicationModule,
  ValidationError,
  ValidationWarning,
  ModuleUiMetadata,
} from '../types/config';
import { technicalConfigSchema, getRequiredMissing } from '../types/config';
import { AppConfigProvider } from '../infrastructure/config/AppConfigProvider';
import { SOCLE_SOCKET_EVENTS } from '../types/events';
import { setLoadedAppDir, clearLoadedAppDir } from './appRoots';
import { redactForLog } from '../infrastructure/logger/redact';

/**
 * ⭐ 24/08/2026, correctif d'un bug réel : une app requiredHaWs peut attendre `ha:ready`
 * indéfiniment PAR CONCEPTION (décision utilisateur du 08/08/2026, voir wsRegistryReady plus bas —
 * volontairement PAS touchée par ce correctif, ces apps ne doivent toujours jamais démarrer sans
 * synchro HA réelle). Le bug : ça bloquait aussi la FIN de startApplicationServices() (Promise.all
 * attend que TOUTES les promesses se résolvent), et donc tout le reste du démarrage — AppService.
 * start() ne se terminait jamais, Bootstrap n'émettait jamais app:started, uptime figé à 0s côté
 * IHM. Voir startApplicationServices() : seul le SIGNAL "démarrage terminé" cesse d'attendre après
 * ce délai, les apps concernées continuent d'attendre ha:ready en tâche de fond, sans limite.
 */
const STARTUP_SERVICES_TIMEOUT_MS = 30000;

/**
 * AppService - Orchestre le cycle de vie de l'application
 * 
 * Responsabilités (conforme §6.1 specs-presentation-v2.0) :
 * - Détection automatique des modules d'application
 * - Gestion de la configuration
 * - Coordination entre les couches
 * - Émission des événements système
 */
export class AppService {
  private eventBus: EventBus;
  private configService: ConfigService;
  private socketBridge: SocketBridge;
  private restartManager: RestartManager;
  private logger: Logger;
  
  // Gestion des applications
  public applicationManager: ApplicationManager;
  // Déploiement de dimotic-ha lui-même sur d'autres machines (⭐ 23/08/2026)
  private coreDeployService: CoreDeployService;
  // Déploiement Home Assistant + Mosquitto sur une machine distante (⭐ 24/08/2026)
  private haStackDeployService: HaStackDeployService;
  // Dépôt de la carte Plan Lovelace HAPLAN sur HA (⭐ 28/08/2026, voir HaplanLovelaceDeployService.ts)
  private haplanLovelaceDeployService: HaplanLovelaceDeployService;
  private zigbee2mqttDeployService: Zigbee2mqttDeployService;
  // Synchronisation "sans maître" des cibles connues (dimotic-ha + HA/Mosquitto) entre toutes les
  // instances du foyer via MQTT retenu (⭐ 24/08/2026, voir TargetGossipService.ts)
  private targetGossipService: TargetGossipService;
  private appGossipService: AppGossipService;
  // Services post-installation HA (MQTT/Whisper/Piper/openWakeWord/Ollama), ⭐ 24/08/2026
  private haPostInstallService: HaPostInstallService;
  // Découplage HaStructureRegistry/HaWsClient pour les apps en process séparé (⭐ 24/08/2026, voir
  // HaQueryBridge.ts) — ia/planificateur/haplan/arbreouquoi
  private haQueryBridge: HaQueryBridge;
  // ⭐ fonctionnelles-supervisor_specs v2.6 — applications tournant en process séparé (Phase 1 : espdisplay)
  private processSupervisor: ProcessSupervisor;
  private supervisorBridge: SupervisorEventBridge;
  
  // Instances des services d'application
  private appServiceInstances: Map<string, { service: any; moduleId: string }> = new Map();
  
  // Composants HA
  private haWsClient?: HaWsClient;
  private haStructureRegistry?: HaStructureRegistry;
  private haRegistryTracer: HaRegistryTracer;
  private haEventsWired: boolean = false;

  // État HA WebSocket
  private wsEnabled: boolean = false; // Flag pour gérer l'état WS
  private _isWsConnected: boolean = false; // État de connexion WS
  private wsConfig?: HaWsConfig; // Configuration WS sauvegardée

  /**
   * Résolue une fois pour toutes au premier `ha:ready` (référentiel HA chargé) — voir
   * waitUntilWsRegistryReady(). Décision utilisateur du 08/08/2026 : les apps déclarant
   * `requiredHaWs` (HAPLAN, ArbreOuQuoi, IA, Planificateur) n'ont leur `start()` appelé qu'une
   * fois cette promesse résolue, jamais avant — attente indéfinie si HA/WS n'est jamais prêt
   * (pas de timeout : "si HA est arrêté, pas de ready", ces apps ne démarrent alors jamais).
   * Même schéma que AreaEnsureService.waitUntilRegistryReady, dupliqué ici volontairement (pas
   * de dépendance croisée entre les deux services pour un mécanisme aussi simple).
   */
  private wsRegistryReady = false;
  private wsRegistryReadyPromise?: Promise<void>;
  
  // Liste des modules détectés
  private modules: ApplicationModule[] = [];

  // Statut de l'application
  private haConnected: boolean = false;
  private startTime: number = Date.now();

  /**
   * Crée un nouveau AppService
   */
  constructor(
    eventBus: EventBus,
    configService: ConfigService,
    socketBridge: SocketBridge,
    restartManager: RestartManager,
    logger: Logger,
    haWsClient?: HaWsClient,
    haStructureRegistry?: HaStructureRegistry
  ) {
    this.eventBus = eventBus;
    this.configService = configService;
    this.socketBridge = socketBridge;
    this.restartManager = restartManager;
    this.logger = logger;
    this.haWsClient = haWsClient;
    this.haStructureRegistry = haStructureRegistry;
    this.haRegistryTracer = new HaRegistryTracer(this.logger);
    this.haRegistryTracer.resetChangeLog();

    // ⭐ fonctionnelles-supervisor_specs v2.6 — superviseur des applications en process séparé,
    // construit avant ApplicationManager (qui en a besoin pour enable()/disable()). Le pont
    // EventBus↔app (SupervisorEventBridge) utilise IPC (16/08/2026, décision utilisateur) — les
    // apps séparées restent sur cette machine, spawn()'ées directement par ProcessSupervisor, plus
    // besoin de MQTT/`ha.mqtt` pour ce canal. MQTT reste utilisé UNIQUEMENT pour la fonctionnalité
    // séparée "commandes start/stop/restart à distance" (attachMqttCommandListener ci-dessous),
    // qui a besoin d'un canal réseau par nature (un opérateur externe doit pouvoir publier sur ce
    // topic depuis n'importe où) — indépendant de `ha.mqtt_enable` (bridges d'intégration HA).
    const projectRoot = process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../'));
    const coreDir = path.join(projectRoot, 'applications', 'core');
    const bootConfig = configService.getConfig();
    const machineId = bootConfig.core.machineId;
    this.supervisorBridge = new SupervisorEventBridge(this.eventBus, logger);
    // ⭐ 06/09/2026 — machineId transmis aux apps en process séparé (variable d'environnement
    // DIMOTIC_MACHINE_ID, voir ProcessSupervisor.spawnChild()) : leur bridgeInstance devient
    // `<préfixe configurable>_<machineId>` calculé à la volée au lieu d'un suffixe aléatoire généré
    // et persisté par app (voir arexx/evoo7/rfxcom/rpigpio ConfigSchema/Service.ts).
    this.processSupervisor = new ProcessSupervisor(logger, coreDir, machineId, this.supervisorBridge, bootConfig.logging?.level);

    const mqttConfig = bootConfig.ha?.mqtt;
    if (mqttConfig) {
      const brokerConfig = {
        host: mqttConfig.host,
        port: mqttConfig.port,
        username: mqttConfig.username,
        password: mqttConfig.password,
        keepalive: mqttConfig.keepalive,
        reconnectDelay: mqttConfig.reconnect_delay
      };
      this.processSupervisor.attachMqttCommandListener(machineId, brokerConfig);
    } else {
      this.logger.debug('AppService', 'ha.mqtt non configuré — commandes MQTT start/stop/restart à distance désactivées (le pont EventBus des apps séparées utilise IPC, indépendant de ha.mqtt)');
    }

    // Initialiser le gestionnaire d'applications
    this.applicationManager = new ApplicationManager(restartManager, logger, configService, this.processSupervisor);
    // ⭐ 24/09/2026 — UN chemin « activer » et UN chemin « désactiver » (voir activateApp()/
    // deactivateApp()), les mêmes au démarrage, au clic, à l'apparition ou à la disparition d'un
    // dossier d'application — jamais de redémarrage du core (décision du 24/09/2026).
    this.applicationManager.setLifecycleHooks(
      (appId, appDir) => this.activateApp(appId, appDir),
      (appId) => this.deactivateApp(appId)
    );
    // État des process (dont 'restarting'/'crashed', spec supervisor §8.4) visible dans Gestion des
    // applications ; et nettoyage côté core à CHAQUE fin de process (bridges MQTT tenus par le core,
    // voir IntegrationBridge) — un crash ou un SIGKILL n'appelle jamais le stop() propre de l'app.
    this.processSupervisor.onStateChange((appId, state) => {
      this.eventBus.emitGeneric('app:process:state', { appId, state });
    });
    this.processSupervisor.onChildExit((info) => {
      this.eventBus.emitGeneric('app:process:exited', info);
    });
    this.coreDeployService = new CoreDeployService(configService, this.applicationManager, logger);
    this.haStackDeployService = new HaStackDeployService(logger);
    this.haplanLovelaceDeployService = new HaplanLovelaceDeployService(logger);
    this.zigbee2mqttDeployService = new Zigbee2mqttDeployService(logger);
    this.targetGossipService = new TargetGossipService(configService, eventBus, logger);
    this.appGossipService = new AppGossipService(configService, eventBus, logger);
    this.haPostInstallService = new HaPostInstallService(configService, logger);
    this.haQueryBridge = new HaQueryBridge(eventBus, logger, () => this.haStructureRegistry, () => this.haWsClient,
      () => ({ enabled: this.wsEnabled, ready: this.wsRegistryReady }));
    // ⭐ 24/09/2026 — `wsRegistryReady` n'était mis à vrai que si quelqu'un ATTENDAIT ha:ready
    // (waitUntilWsRegistryReady, chemin in-process, plus utilisé depuis que toutes les apps sont en
    // process séparé) : désormais tenu à jour à chaque ha:ready, lu par HaQueryBridge ci-dessus.
    this.eventBus.onGeneric('ha:ready', () => {
      this.wsRegistryReady = true;
    });

    // Initialiser l'état WS depuis la config
    this.initializeWsState();
    
    // Initialiser
    this.setupEventListeners();
  }
  
  /**
   * Initialise l'état WS à partir de la configuration.
   */
  private initializeWsState(): void {
    const config = this.configService.getConfig();
    this.wsEnabled = config.ha?.ws_enable === true;
    this.wsConfig = config.ha?.ws;
    
    if (this.wsEnabled) {
      this.logger.info('AppService', 'HA WebSocket est ACTIF (ws_enable: true)');
    } else {
      this.logger.info('AppService', 'HA WebSocket est DESACTIVE (ws_enable: false)');
    }
  }

  /**
   * Configure les listeners EventBus
   */
  private setupEventListeners(): void {
    // Écouter les demandes de configuration
    this.eventBus.on('config:get', () => this.handleConfigGet());
    this.eventBus.on('config:save:requested', (config) => this.handleConfigSave(config as TechnicalConfig));
    this.eventBus.on('config:validate:requested', (config) => this.handleConfigValidate(config as TechnicalConfig));
    
    // Écouter les demandes de modules
    this.eventBus.on('app:modules:config:get', (data) => this.handleModuleConfigGet(data));
    this.eventBus.on('app:modules:config:save', (data) => this.handleModuleConfigSave(data));
    
    // Écouter les résultats de sauvegarde de configuration pour WS
    this.eventBus.onGeneric('config:save:result', (result: ConfigSaveResult) => {
      this.handleConfigSaveResultForWs(result);
    });

    // Écouter les demandes de métadonnées UI de modules
    this.eventBus.on('app:module:ui:register', (data) => this.handleModuleUiRegister(data as { moduleId: string; metadata: ModuleUiMetadata }));

    // Gestion des applications (NOUVEAU v4.4)
    this.eventBus.on('app:applications:list', () => this.handleApplicationsList());
    this.eventBus.on('app:applications:enable', (data: { appId: string }) => this.handleApplicationEnable(data));
    this.eventBus.on('app:applications:disable', (data: { appId: string }) => this.handleApplicationDisable(data));
    this.eventBus.on('app:applications:restart-now', () => this.applicationManager.restartNowIfPending());
    // ⭐ 24/09/2026 — « Relancer » une application en état 'crashed' (abandon après 5 crashs rapprochés).
    this.eventBus.onGeneric<{ appId: string }>('app:applications:restart', (data) => this.handleApplicationRestart(data));

    // Sites externes (⭐ 27/08/2026, voir schema.ts::externalSiteSchema) — liste personnelle,
    // jamais gossipée, même patron CRUD que les cibles de déploiement ci-dessous.
    this.eventBus.on('core:external-sites:get', () => this.handleExternalSitesGet());
    this.eventBus.on('core:external-site:save', (data: unknown) => this.handleExternalSiteSave(data as ExternalSiteConfig));
    this.eventBus.on('core:external-site:delete', (data: unknown) => this.handleExternalSiteDelete(data as { id: string }));

    // Déploiement de dimotic-ha lui-même (⭐ 23/08/2026, voir CoreDeployService.ts) — même
    // protocole { targetId, action } que rpigpio/teleinfo/arexx (core/infrastructure/remote/).
    this.eventBus.on('core:deployment:targets:get', () => this.handleDeploymentTargetsGet());
    this.eventBus.on('core:deployment:target:save', (data: unknown) => this.handleDeploymentTargetSave(data as DeploymentTargetConfig));
    this.eventBus.on('core:deployment:target:delete', (data: unknown) => this.handleDeploymentTargetDelete(data as { id: string }));
    this.eventBus.on('core:deployment:remote-op', (data: unknown) => {
      const { targetId, action, version } = data as { targetId: string; action: RemoteAction; version?: string };
      this.handleDeploymentRemoteOp(targetId, action, version);
    });

    // Déploiement Home Assistant + Mosquitto (⭐ nouveau 24/08/2026, voir HaStackDeployService.ts)
    // — liste de cibles séparée de core:deployment:targets, même protocole sinon.
    this.eventBus.on('core:deployment:ha-stack:targets:get', () => this.handleHaStackTargetsGet());
    this.eventBus.on('core:deployment:ha-stack:target:save', (data: unknown) => this.handleHaStackTargetSave(data as HaStackTargetConfig));
    this.eventBus.on('core:deployment:ha-stack:target:delete', (data: unknown) => this.handleHaStackTargetDelete(data as { id: string }));
    this.eventBus.on('core:deployment:ha-stack:remote-op', (data: unknown) => {
      const { targetId, action, version } = data as { targetId: string; action: RemoteAction; version?: string };
      this.handleHaStackRemoteOp(targetId, action, version);
    });

    // Dépôt de la carte Plan Lovelace HAPLAN (⭐ nouveau 28/08/2026, voir
    // HaplanLovelaceDeployService.ts) — événement ad hoc (pas dans core:deployment:*, HAPLAN reste
    // seul à connaître son propre contenu) émis par HaplanService via IPC (process séparé),
    // réponse repartant vers lui par bridgedEvents (voir applications/haplan/src/domain/index.ts).
    this.eventBus.onGeneric<{ yaml: string; images: Array<{ localPath: string; filename: string }> }>(
      'core:haplan-lovelace:deploy',
      (data) => this.handleHaplanLovelaceDeploy(data)
    );

    // Déploiement zigbee2mqtt (⭐ nouveau 24/08/2026, voir Zigbee2mqttDeployService.ts) — liste de
    // cibles séparée de haStackTargets, même protocole sinon.
    this.eventBus.on('core:deployment:zigbee2mqtt:targets:get', () => this.handleZigbee2mqttTargetsGet());
    this.eventBus.on('core:deployment:zigbee2mqtt:target:save', (data: unknown) => this.handleZigbee2mqttTargetSave(data as Zigbee2mqttTargetConfig));
    this.eventBus.on('core:deployment:zigbee2mqtt:target:delete', (data: unknown) => this.handleZigbee2mqttTargetDelete(data as { id: string }));
    this.eventBus.on('core:deployment:zigbee2mqtt:remote-op', (data: unknown) => {
      const { targetId, action, version } = data as { targetId: string; action: RemoteAction; version?: string };
      this.handleZigbee2mqttRemoteOp(targetId, action, version);
    });

    // ⭐ 31/08/2026, suppression définitive d'une machine disparue (confirmée par un humain, voir
    // TargetGossipService en-tête) — couvre les 3 listes de cibles à la fois, pas une par une.
    this.eventBus.on('core:deployment:target:purge', (data) => this.handleDeploymentTargetPurge(data));
    // Reflète en direct dans un tableau de bord déjà ouvert une réconciliation gossip (mise à jour
    // d'hôte, suppression volontaire à la source, suppression confirmée) — sans ça, les 3 listes ne
    // se rafraîchissent qu'au prochain `*:targets:get` explicite (rechargement de page).
    this.eventBus.onGeneric('core:deployment:gossip:changed', () => {
      this.handleDeploymentTargetsGet();
      this.handleHaStackTargetsGet();
      this.handleZigbee2mqttTargetsGet();
    });

    // Services post-installation HA (⭐ 24/08/2026, voir HaPostInstallService.ts)
    this.eventBus.on('core:post-install:apply', (data: unknown) => {
      const { requests } = data as { requests: PostInstallRequest[] };
      void this.handlePostInstallApply(requests);
    });

    // Redémarrage manuel demandé depuis l'UI (Paramètres Techniques > Journalisation)
    this.eventBus.on('app:restart:requested', () => this.handleRestartRequested());

    // Écouter les changements de configuration des modules
    // Note: Le redémarrage automatique a été désactivé comme demandé
    // this.eventBus.onGeneric('app:module:config:saved', (data: { moduleId: string; success: boolean }) => {
    //   if (data.success) {
    //     this.restartApplicationService(data.moduleId);
    //   }
    // });

    // Écouter config:reload pour reconfigure WS et MQTT
    this.eventBus.on('config:reload', () => {
      this.handleConfigReload();
    });
  }

  /**
   * Gère le rechargement de la configuration pour WS
   * (MQTT est géré indépendamment par IntegrationBridge, qui écoute
   * 'config:save:result' directement — voir ha/integration/IntegrationBridge.ts)
   */
  private handleConfigReload(): void {
    this.logger.info('AppService', 'Configuration rechargée - Reconfiguration des composants HA...');

    const config = this.configService.getConfig();

    // Reconfigurer WebSocket si activé et disponible
    if (config.ha?.ws_enable === true && config.ha?.ws && this.haWsClient) {
      this.logger.info('AppService', 'Reconfiguration HA WebSocket...');
      this.haWsClient.reconfigure(config.ha.ws);
    }

    // ⭐ 23/09/2026 — lien HA de la page d'accueil : émis jusqu'ici une seule fois au démarrage
    // (registerCoreSocketEvents), il restait sur l'ancienne adresse après un changement de
    // ha.ws.host jusqu'au redémarrage (constaté en test live, .19 → .51).
    if (config.ha?.ws?.host) {
      this.eventBus.emitGeneric(SOCLE_SOCKET_EVENTS.HA_ADDRESS, { host: config.ha.ws.host, port: config.ha.ws.port });
    }

    // Reconfigurer le logger si le niveau a changé
    if (config.logging?.level && this.logger) {
      const newLevel = config.logging.level as 'debug' | 'info' | 'warn' | 'error';
      if (newLevel !== this.logger.getLevel()) {
        this.logger.info('AppService', `Reconfiguration du niveau de log: ${newLevel}`);
        this.logger.setLevel(newLevel);
      }
    }
    
    this.logger.info('AppService', 'Reconfiguration des composants HA terminée');
  }

  /**
   * Démarre l'application
   * Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §10.1
   */
  async start(): Promise<void> {
    this.logger.info('AppService', 'Démarrage de l\'application...');

    // 1. Détecter les modules d'application
    await this.detectApplicationModules();
    this.logger.info('AppService', `Modules détectés : ${this.modules.map(m => m.id).join(', ')}`);

    // 1.5. S'assurer que les sections de configuration des modules existent
    const moduleIds = this.modules.map(m => m.id);
    this.configService.ensureModuleSections(moduleIds);

    // 2. Charger et valider la configuration
    await this.loadAndValidateConfig();

    // 2.1. Génère la clé SSH unique de l'installation si absente (⭐ 24/08/2026 — une seule clé
    // pour toute l'application, partagée par toutes les cibles, voir SshClient.ts#ensureGlobalSshKey).
    ensureGlobalSshKey();

    // 2.2. Démarre la synchronisation des cibles connues entre instances (⭐ 24/08/2026, voir
    // TargetGossipService.ts) — indépendant de HA WS/des services applicatifs, peut démarrer tôt.
    this.targetGossipService.start();

    // 2.2bis. Démarre le registre d'applications inter-machines (⭐ 27/08/2026, voir
    // AppGossipService.ts) — AVANT l'émission de app:modules:registered ci-dessous (3.), pour que
    // le premier abonnement ne rate pas la toute première annonce locale.
    this.appGossipService.start();

    // 2.3. Démarre le pont générique de requêtes HA pour les apps en process séparé (⭐ 24/08/2026,
    // voir HaQueryBridge.ts) — indépendant de l'état HA WS, la vérification se fait par requête.
    this.haQueryBridge.start();

    // 3. Émettre la liste des modules vers l'UI
    this.eventBus.emit('app:modules:registered', { modules: this.modules });

    // 3.1. Enregistrer les événements Socket.io du socle (core) avec persistants
    this.registerCoreSocketEvents();

    // 3.2. Émettre la liste des applications activées/désactivées
    this.handleApplicationsList();

    // 3.5. Émettre les métadonnées UI pour chaque module qui en a
    this.emitModuleUiMetadata();

    // 3.7. Démarrer HA WebSocket (si configuré) — AVANT les services applicatifs : les apps
    // requiredHaWs attendent ha:ready pour démarrer (voir startApplicationService()), la connexion
    // doit donc déjà être en cours, sinon ha:ready ne pourrait jamais survenir (blocage garanti).
    if (this.wsEnabled && this.haWsClient) {
      this.startHaWsClient();
    }

    // 3.8. Démarrer les services des applications activées (NOUVEAU)
    await this.startApplicationServices();

    this.logger.info('AppService', 'Application démarrée');
  }

  /**
   * Détecte les applications au démarrage du core — ⭐ 24/09/2026 : rapprochement disque/config
   * (`ApplicationManager.reconcile()` : application nouvelle = désactivée, deux racines interne/
   * externe) puis `registerApp()` pour chaque application activée — le MÊME enregistrement que
   * l'activation à chaud (activateApp()), pour que démarrage et activation ne divergent plus.
   * Le démarrage effectif des process a lieu ensuite dans startApplicationServices().
   */
  private async detectApplicationModules(): Promise<void> {
    try {
      this.modules.push(this.createCoreModule());
      this.applicationManager.reconcile();
      const { activated } = this.applicationManager.listAll();
      for (const appId of activated) {
        const appDir = this.applicationManager.resolveAppDir(appId);
        if (!appDir) continue;
        const error = this.registerApp(appId, appDir);
        if (error) this.logger.warn('AppService', `Application ${appId} non chargée : ${error}`);
      }
    } catch (error) {
      this.logger.error('AppService', `Erreur de détection des modules: ${error}`);
    }
  }

  /**
   * Charge le module de domaine d'une application depuis SON dossier (racine interne ou externe) —
   * `require()` dans tous les cas : `dist/domain/index.js` (production) en priorité, sinon la source
   * `.ts` (dev, uniquement sous tsx qui enregistre son loader pour tout le process). Le cache Node
   * des fichiers de CE dossier est vidé d'abord : une application remplacée sur disque (racine
   * externe) est relue, pas servie depuis une version précédente.
   * Historique conservé : `dist` DOIT passer avant `src` (sous `node` pur, un `.ts` ne se charge pas
   * — bug découvert au premier déploiement Docker le 03/08/2026) ; et ne jamais mélanger `import()`
   * puis `require()` sur un même fichier CommonJS (résolveur Node incohérent ensuite, même date).
   */
  private loadAppModule(appDir: string): Record<string, unknown> {
    const candidates = ['dist/domain/index.js', 'src/domain/index.ts', 'src/domain/index.js']
      .map((entry) => path.join(appDir, entry));
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`aucun domain/index dans ${appDir}`);
    let realDir = appDir;
    try { realDir = realpathSync(appDir); } catch { /* garde appDir */ }
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(realDir + path.sep)) delete require.cache[key];
    }
    return require(path.resolve(entry)) as Record<string, unknown>;
  }

  /**
   * ⭐ 24/09/2026 — ENREGISTREMENT d'une application, sans démarrage : module chargé, entrée dans
   * `this.modules`, schéma de config Zod (convention {moduleId}ConfigSchema — l'activation à chaud
   * l'omettait jusqu'ici, écart n°4 de l'analyse du 24/09), événements Socket.io déclarés, câblage du
   * process séparé. Commun au démarrage (detectApplicationModules) et à l'activation à chaud
   * (activateApp). Renvoie un message d'erreur, `undefined` si réussi.
   */
  private registerApp(appId: string, appDir: string): string | undefined {
    let module: Record<string, unknown>;
    try {
      module = this.loadAppModule(appDir);
    } catch (error) {
      return `chargement du module impossible (${error instanceof Error ? error.message : String(error)})`;
    }
    const appKey = Object.keys(module).find((k) => k.endsWith('_APP'));
    const appModule = appKey ? (module[appKey] as ApplicationModule) : undefined;
    if (!appModule) return 'aucune constante *_APP exportée par domain/index';
    if (appModule.id !== appId) return `l'id déclaré (${appModule.id}) ne correspond pas au dossier (${appId})`;

    this.logger.info('AppService', `Module ${appId} détecté - id: ${appModule.id}, name: ${appModule.name}, type: ${appModule.type}, dossier: ${appDir}, hasConfigUi: ${!!appModule.configUi}`);
    this.modules = this.modules.filter((m) => m.id !== appId);
    this.modules.push({ ...appModule, status: this.getModuleConfigStatus(appModule) });
    setLoadedAppDir(appId, appDir);

    const schemaKey = Object.keys(module).find((k) => k.toLowerCase() === `${appId}configschema`.toLowerCase());
    if (schemaKey && module[schemaKey]) {
      this.configService.registerModuleSchema(appId, module[schemaKey] as any);
      this.logger.debug('AppService', `Schéma de configuration enregistré pour ${appId}`);
    }

    const socketEventsKey = Object.keys(module).find((k) => k.endsWith('_SOCKET_EVENTS'));
    if (socketEventsKey && module[socketEventsKey]) {
      this.eventBus.emit('app:socket-events:registered', {
        appId,
        socketEvents: module[socketEventsKey] as Record<string, string>
      });
    }

    if (appModule.runsAsSeparateProcess) {
      if (!this.processSupervisor.isRegistered(appId)) {
        this.wireSeparateProcessApp(appModule, appDir);
      } else {
        // Déjà câblée : seul le dossier peut avoir changé (racine externe ajoutée/retirée).
        this.processSupervisor.register(appId, appDir);
      }
    }
    return undefined;
  }

  /**
   * ⭐ 24/09/2026 — ACTIVATION à chaud (bouton Activer) : enregistrement complet (registerApp) +
   * section de config + démarrage + annonce (menu, formulaire Paramètres Techniques, gossip).
   * Jamais de redémarrage du core. Renvoie un message d'erreur, `undefined` si l'application tourne.
   */
  private activateApp(appId: string, appDir: string): string | undefined {
    const error = this.registerApp(appId, appDir);
    if (error) return error;
    const appModule = this.modules.find((m) => m.id === appId)!;
    this.configService.ensureModuleSections([appId]);
    if (appModule.runsAsSeparateProcess) {
      this.processSupervisor.start(appId);
    } else {
      this.startApplicationService(appId).catch((err) => {
        this.logger.error('AppService', `Échec du démarrage du service ${appId}: ${err}`);
      });
    }
    this.eventBus.emit('app:modules:registered', { modules: this.modules });
    if (appModule.configUi) {
      this.eventBus.emit('app:module:ui:register', { moduleId: appId, metadata: appModule.configUi });
    }
    return undefined;
  }

  /**
   * ⭐ 24/09/2026 — DÉSACTIVATION à chaud : défait tout ce que l'activation avait mis en place —
   * arrêt du process (même en attente de relance, voir ProcessSupervisor.stop()), retrait de
   * `this.modules` (menu, gossip), et `app:unregistered` pour que SocketBridge (menu, métadonnées,
   * événements persistants, écouteurs) et IntegrationBridge (bridges MQTT) libèrent ce qu'ils tiennent.
   */
  private deactivateApp(appId: string): void {
    if (this.processSupervisor.isRegistered(appId)) {
      this.processSupervisor.stop(appId);
    } else {
      void this.stopApplicationService(appId);
    }
    const before = this.modules.length;
    this.modules = this.modules.filter((m) => m.id !== appId);
    if (this.modules.length !== before) {
      this.eventBus.emit('app:modules:registered', { modules: this.modules });
    }
    clearLoadedAppDir(appId);
    this.eventBus.emitGeneric('app:unregistered', { appId });
  }

  /**
   * Enregistre le spawn (ProcessSupervisor) et ponte les événements sens core → app
   * (SupervisorEventBridge) pour une application en process séparé — factorisé hors de
   * detectApplicationModules() (⭐ 25/08/2026) pour être réutilisable depuis
   * tryActivateSeparateProcessApp() (activation d'une app depuis l'état désactivé, sans
   * redémarrage de core — voir ApplicationManager.enable()) sans dupliquer cette logique.
   * Voir le commentaire détaillé sur les 3 mécanismes génériques + bridgedEvents, déplacé ici.
   */
  private wireSeparateProcessApp(appModule: ApplicationModule, appDir: string): void {
    this.processSupervisor.register(appModule.id, appDir);
    this.supervisorBridge.autoBridgeSocketEvents(appModule.id);
    this.supervisorBridge.bridgeEvent(appModule.id, 'app:module:config:saved');
    this.supervisorBridge.bridgeEvent(appModule.id, 'ha:bridge:reply');
    this.supervisorBridge.bridgeEvent(appModule.id, 'ha:entity:state_changed');
    this.supervisorBridge.bridgeEvent(appModule.id, 'ha:ready');
    if (appModule.type === 'integration') {
      this.supervisorBridge.bridgeEvent(appModule.id, `integration:${appModule.id}:command`);
      this.supervisorBridge.bridgeEvent(appModule.id, `integration:${appModule.id}:bridge:connection`);
      this.supervisorBridge.bridgeEvent(appModule.id, `integration:${appModule.id}:ha:online`);
      this.supervisorBridge.bridgeEvent(appModule.id, `integration:${appModule.id}:passthrough:message`);
    }
    for (const eventName of appModule.bridgedEvents ?? []) {
      this.supervisorBridge.bridgeEvent(appModule.id, eventName);
    }
  }

  /**
   * Crée le module core (paramètres techniques)
   */
  private createCoreModule(): ApplicationModule {
    return {
      id: 'core',
      name: 'Paramètres Techniques',
      description: 'Configuration globale de l\'application',
      icon: '⚙️',
      type: 'core',
      audience: 'configuration',
      configurable: true,
      requiredMqtt: false,
      requiredHaWs: false,
      status: 'partial', // À mettre à jour après validation
    };
  }

  /**
   * Détermine le statut de configuration d'un module
   */
  private getModuleConfigStatus(module: ApplicationModule): 'configured' | 'partial' | 'missing' | 'error' {
    // Pour le module core, vérifier la configuration technique
    if (module.id === 'core') {
      return this.getCoreConfigStatus();
    }
    
    // Pour les autres modules, vérifier leurs exigences
    if (module.requiredMqtt && !this.configService.getMqttConfig()) {
      return 'missing';
    }
    
    if (module.requiredHaWs && !this.configService.getHaConfig()) {
      return 'missing';
    }
    
    return 'partial';
  }

  /**
   * Détermine le statut de la configuration technique (core)
   */
  private getCoreConfigStatus(): 'configured' | 'partial' | 'missing' | 'error' {
    const config = this.configService.getConfig();
    const validationResult = this.validateConfig(config as TechnicalConfig);
    const missing = this.getRequiredMissing(config, validationResult);
    
    if (missing.length > 0) {
      return 'missing';
    }
    
    return 'configured';
  }

  /**
   * Récupère les champs requis manquants
   */
  private getRequiredMissing(config: unknown, validationResult: ConfigValidationResult): string[] {
    const requiredFields = ['ha.ws.host', 'ha.ws.token'];
    const configObj = config as Record<string, unknown>;
    return requiredFields.filter(field => {
      const value = this.getNestedValue(configObj, field);
      return value === undefined || value === null || value === '';
    });
  }

  /**
   * Récupère une valeur imbriquée par son chemin
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((current: any, key) => {
      return current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
    }, obj as Record<string, unknown>);
  }

  /**
   * Émet les métadonnées UI pour tous les modules qui en ont
   * Chaque module avec configUi émet un événement pour l'UI
   */
  private emitModuleUiMetadata(): void {
    this.logger.info('AppService', 'Début émission des métadonnées UI pour les modules');
    for (const module of this.modules) {
      if (module.configUi) {
        this.logger.info('AppService', `Module ${module.id} a un configUi, émission en cours: ${redactForLog(module.configUi)}`);
        this.eventBus.emit('app:module:ui:register', {
          moduleId: module.id,
          metadata: module.configUi,
        });
        this.logger.info('AppService', `Métadonnées UI émises pour le module : ${module.id}`);
      } else {
        this.logger.warn('AppService', `Module ${module.id} N'A PAS de configUi, aucune métadonnée UI émise`);
      }
    }
    this.logger.info('AppService', 'Fin émission des métadonnées UI');
  }

  /**
   * Enregistre les événements Socket.io du socle (core) avec les événements persistants
   * Les événements persistants sont automatiquement envoyés aux nouveaux clients Socket.io
   */
  private registerCoreSocketEvents(): void {
    this.logger.info('AppService', 'Enregistrement des événements Socket.io du socle (core)');
    
    // Événements persistants du socle : statut, config, modules, etc.
    const persistentCoreEvents = [
      SOCLE_SOCKET_EVENTS.APP_STATUS,
      SOCLE_SOCKET_EVENTS.APP_STARTED,
      SOCLE_SOCKET_EVENTS.CONFIG_CURRENT,
      SOCLE_SOCKET_EVENTS.MQTT_CONNECTED,
      SOCLE_SOCKET_EVENTS.MQTT_DISCONNECTED,
      SOCLE_SOCKET_EVENTS.MODULES_LIST,
      SOCLE_SOCKET_EVENTS.HA_STATUS,
      SOCLE_SOCKET_EVENTS.MACHINE_ID,
      SOCLE_SOCKET_EVENTS.HA_ADDRESS,
      SOCLE_SOCKET_EVENTS.REMOTE_APPS,
    ];

    this.eventBus.emit('app:socket-events:registered', {
      appId: 'core',
      socketEvents: SOCLE_SOCKET_EVENTS,
      persistentEvents: persistentCoreEvents
    });

    // ⭐ fonctionnelles-supervisor_specs v2.6 — identité de cette machine, une seule fois (valeur
    // stable pour toute la durée de vie du process, voir schema.ts::coreSchema).
    this.eventBus.emitGeneric(SOCLE_SOCKET_EVENTS.MACHINE_ID, {
      machineId: this.configService.getConfig().core.machineId,
      address: getPrimaryIPv4Address(),
    });

    // ⭐ 27/08/2026 — lien direct vers la HA configurée sur cette machine (page d'accueil). Rien
    // émis si ha.ws n'est pas configuré du tout (pas de lien à construire).
    const haWs = this.configService.getConfig().ha?.ws;
    if (haWs?.host) {
      this.eventBus.emitGeneric(SOCLE_SOCKET_EVENTS.HA_ADDRESS, { host: haWs.host, port: haWs.port });
    }

    // ⭐ 27/08/2026 — relaie le registre d'applications inter-machines (AppGossipService) vers le
    // frontend, sous le nom d'événement Socket.io déclaré ci-dessus (REMOTE_APPS) — snapshot
    // initial (vide tant qu'aucune annonce distante n'est arrivée) puis à chaque mise à jour.
    this.eventBus.emitGeneric(SOCLE_SOCKET_EVENTS.REMOTE_APPS, this.appGossipService.getRegistry());
    this.eventBus.onGeneric('app:remote-registry:changed', (registry) => {
      this.eventBus.emitGeneric(SOCLE_SOCKET_EVENTS.REMOTE_APPS, registry);
    });

    this.logger.info('AppService', `Événements Socket.io du socle enregistrés: ${Object.keys(SOCLE_SOCKET_EVENTS).length} événements, ${persistentCoreEvents.length} persistants`);
  }

  /**
   * Gère l'enregistrement des métadonnées UI d'un module
   * (Utilisé pour les modules chargés dynamiquement après le démarrage)
   */
  private handleModuleUiRegister(data: { moduleId: string; metadata: ModuleUiMetadata }): void {
    // Pour l'instant, on relaye juste vers SocketBridge
    // L'implémentation complète sera gérée par SocketBridge
    this.logger.info('AppService', `Métadonnées UI enregistrées pour ${data.moduleId}, metadata: ${redactForLog(data.metadata)}`);
  }

  // ===========================================================================
  // GESTION DES APPLICATIONS (NOUVEAU v4.4)
  // ===========================================================================

  /**
   * Gère la demande de liste des applications
   */
  private handleApplicationsList(): void {
    this.logger.info('AppService', 'Demande de liste des applications reçue');
    // ⭐ 24/09/2026 — relecture du disque à chaque ouverture de Gestion des applications : une
    // application apparue arrive désactivée (repère « nouvelle »), une disparue est arrêtée.
    const { removed } = this.applicationManager.reconcile();
    for (const appId of removed) {
      if (this.modules.some((m) => m.id === appId) || this.processSupervisor.isRegistered(appId)) {
        this.logger.info('AppService', `Application ${appId} retirée du disque — arrêt`);
        this.deactivateApp(appId);
      }
    }
    const { activated, disabled, details } = this.applicationManager.listAll();
    const states = this.processSupervisor.getStates();
    this.logger.info('AppService', `Liste des applications: activated=${redactForLog(activated)}, disabled=${redactForLog(disabled)}`);
    this.eventBus.emit('app:applications:list:result', {
      activated,
      disabled,
      details: details.map((d) => ({ ...d, state: activated.includes(d.appId) ? (states[d.appId] ?? 'stopped') : 'stopped' }))
    });
  }

  /** ⭐ 24/09/2026 — relance d'une application en état 'crashed' (compteur de tentatives remis à zéro). */
  private handleApplicationRestart(data: { appId: string }): void {
    const known = this.processSupervisor.isRegistered(data.appId);
    if (known) this.processSupervisor.restart(data.appId);
    this.eventBus.emitGeneric('app:applications:restart:result', {
      appId: data.appId,
      success: known,
      error: known ? undefined : `Application ${data.appId} non gérée par le superviseur`
    });
  }

  /**
   * Gère la demande d'activation d'une application
   */
  private handleApplicationEnable(data: { appId: string }): void {
    this.logger.info('AppService', `Demande d'activation de l'application ${data.appId} reçue`);
    const result = this.applicationManager.enable(data.appId);
    this.eventBus.emit('app:applications:enable:result', {
      appId: data.appId,
      success: result.success,
      error: result.error,
      restarting: result.restarting,
    });
  }

  /**
   * Gère la demande de désactivation d'une application
   */
  private handleApplicationDisable(data: { appId: string }): void {
    this.logger.info('AppService', `Demande de désactivation de l'application ${data.appId} reçue`);
    const result = this.applicationManager.disable(data.appId);
    this.eventBus.emit('app:applications:disable:result', {
      appId: data.appId,
      success: result.success,
      error: result.error,
      restarting: result.restarting,
    });
  }

  // ===========================================================================
  // SITES EXTERNES (⭐ 27/08/2026, voir schema.ts::externalSiteSchema) — liste personnelle de
  // raccourcis vers d'autres installations dimotic-ha indépendantes, jamais gossipée.
  // ===========================================================================

  private handleExternalSitesGet(): void {
    this.eventBus.emit('core:external-sites:list', { sites: this.configService.getExternalSites() });
  }

  private handleExternalSiteSave(site: ExternalSiteConfig): void {
    const sites = this.configService.getExternalSites();
    const index = sites.findIndex((s) => s.id === site.id);
    if (index === -1) sites.push(site);
    else sites[index] = site;

    const result = this.configService.setExternalSites(sites);
    if (!result.success) {
      this.logger.error('AppService', `Échec de sauvegarde du site externe ${site.id}: ${result.error}`);
    }
    this.handleExternalSitesGet();
  }

  private handleExternalSiteDelete(data: { id: string }): void {
    const sites = this.configService.getExternalSites().filter((s) => s.id !== data.id);
    const result = this.configService.setExternalSites(sites);
    if (!result.success) {
      this.logger.error('AppService', `Échec de suppression du site externe ${data.id}: ${result.error}`);
    }
    this.handleExternalSitesGet();
  }

  // ===========================================================================
  // DÉPLOIEMENT DE DIMOTIC-HA LUI-MÊME (⭐ 23/08/2026, voir CoreDeployService.ts)
  // ===========================================================================

  private handleDeploymentTargetsGet(): void {
    this.eventBus.emit('core:deployment:targets:list', {
      targets: this.configService.getTargets().map((t) => ({ id: t.id, host: t.host, origin: t.origin })),
      isRunningInDocker: isRunningInDocker(),
      projectRoot: process.env.PROJECT_ROOT || process.cwd(),
    });
  }

  private handleDeploymentTargetSave(target: DeploymentTargetConfig): void {
    const targets = this.configService.getTargets();
    const index = targets.findIndex((t) => t.id === target.id);
    if (index === -1) targets.push(target);
    else targets[index] = target;

    const result = this.configService.setTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de sauvegarde de la cible de déploiement ${target.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleDeploymentTargetsGet();
  }

  private handleDeploymentTargetDelete(data: { id: string }): void {
    const targets = this.configService.getTargets().filter((t) => t.id !== data.id);
    const result = this.configService.setTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de suppression de la cible de déploiement ${data.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleDeploymentTargetsGet();
  }

  /**
   * ⭐ 31/08/2026 : suppression définitive d'une machine disparue, confirmée par un humain (jamais
   * automatique — voir TargetGossipService en-tête). Une seule purge retire les cibles gossipées
   * de cette machine sur les 3 listes (core/haStack/zigbee2mqtt) à la fois — pas 3 flux séparés —
   * puis délègue au réseau (annonce + nettoyage des topics retenus de la machine disparue) à
   * TargetGossipService, propriétaire du canal MQTT gossip.
   */
  private handleDeploymentTargetPurge(data: { machineId: string }): void {
    const prefix = `${data.machineId}::`;

    const core = this.configService.getTargets();
    const coreRemaining = core.filter((t) => !t.id.startsWith(prefix));
    if (coreRemaining.length !== core.length) {
      const result = this.configService.setTargets(coreRemaining);
      if (!result.success) this.logger.error('AppService', `Échec de purge des cibles core de ${data.machineId}: ${result.error}`);
    }

    const haStack = this.configService.getHaStackTargets();
    const haStackRemaining = haStack.filter((t) => !t.id.startsWith(prefix));
    if (haStackRemaining.length !== haStack.length) {
      const result = this.configService.setHaStackTargets(haStackRemaining);
      if (!result.success) this.logger.error('AppService', `Échec de purge des cibles HA+Mosquitto de ${data.machineId}: ${result.error}`);
    }

    const zigbee2mqtt = this.configService.getZigbee2mqttTargets();
    const zigbee2mqttRemaining = zigbee2mqtt.filter((t) => !t.id.startsWith(prefix));
    if (zigbee2mqttRemaining.length !== zigbee2mqtt.length) {
      const result = this.configService.setZigbee2mqttTargets(zigbee2mqttRemaining);
      if (!result.success) this.logger.error('AppService', `Échec de purge des cibles zigbee2mqtt de ${data.machineId}: ${result.error}`);
    }

    this.targetGossipService.purgeMachine(data.machineId);
    this.logger.info('AppService', `Machine ${data.machineId} purgée — cibles gossipées retirées localement, suppression annoncée aux autres instances`);

    this.handleDeploymentTargetsGet();
    this.handleHaStackTargetsGet();
    this.handleZigbee2mqttTargetsGet();
  }

  /**
   * Point d'entrée unique pour toute intervention distante sur une cible de déploiement de
   * dimotic-ha — même protocole { targetId, action } que rpigpio/teleinfo/arexx.
   */
  private async handleDeploymentRemoteOp(targetId: string, action: RemoteAction, version?: string): Promise<void> {
    const target = this.configService.getTargets().find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emit('core:deployment:remote-op:result', {
        targetId,
        action,
        success: false,
        error: `Cible introuvable: ${targetId}`,
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.coreDeployService.deploy(target, version, (chunk) => {
            this.eventBus.emit('core:deployment:remote-op:progress', { targetId, chunk });
          })
        : action === 'start'
        ? this.coreDeployService.start(target)
        : action === 'stop'
        ? this.coreDeployService.stop(target)
        : action === 'restart'
        ? this.coreDeployService.restart(target)
        : action === 'push-config'
        ? this.coreDeployService.pushConfig(target)
        : Promise.resolve({ success: false, error: `Action distante inconnue: ${action}` }));
      this.eventBus.emit('core:deployment:remote-op:result', { targetId, action, ...result });
    } catch (error) {
      this.eventBus.emit('core:deployment:remote-op:result', {
        targetId,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ===========================================================================
  // DÉPLOIEMENT HOME ASSISTANT + MOSQUITTO (⭐ nouveau 24/08/2026, voir HaStackDeployService.ts)
  // ===========================================================================

  private handleHaStackTargetsGet(): void {
    this.eventBus.emit('core:deployment:ha-stack:targets:list', {
      targets: this.configService.getHaStackTargets().map((t) => ({ id: t.id, host: t.host, origin: t.origin })),
      isRunningInDocker: isRunningInDocker(),
      projectRoot: process.env.PROJECT_ROOT || process.cwd(),
    });
  }

  private handleHaStackTargetSave(target: HaStackTargetConfig): void {
    const targets = this.configService.getHaStackTargets();
    const index = targets.findIndex((t) => t.id === target.id);
    if (index === -1) targets.push(target);
    else targets[index] = target;

    const result = this.configService.setHaStackTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de sauvegarde de la cible HA+Mosquitto ${target.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleHaStackTargetsGet();
  }

  private handleHaStackTargetDelete(data: { id: string }): void {
    const targets = this.configService.getHaStackTargets().filter((t) => t.id !== data.id);
    const result = this.configService.setHaStackTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de suppression de la cible HA+Mosquitto ${data.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleHaStackTargetsGet();
  }

  /**
   * Dépôt de la carte Plan Lovelace HAPLAN — pas de sélecteur de cible pour cette première version
   * (voir specs §17.9/hors périmètre) : avec exactement une cible `haStackTargets` configurée (cas
   * réel), on la choisit implicitement ; sinon erreur claire plutôt qu'un choix risqué.
   *
   * ⭐ 08/09/2026, bug réel corrigé : `getHaStackTargets()` renvoie AUSSI les auto-annonces gossip
   * (`origin: 'gossip'`, voir TargetGossipService) — cette même machine s'annonce sous un
   * `machineId` DIFFÉRENT à chaque redémarrage, sans jamais nettoyer les anciennes annonces
   * (constaté en réel : 4 entrées `origin: gossip` pour le même hôte que l'unique entrée `local`,
   * `haStackTargets.length` valant 5 pour une seule vraie cible HA). Seules les cibles `origin:
   * 'local'` (celles que l'utilisateur a lui-même configurées sur CETTE instance) comptent pour ce
   * dépôt — n'importe quel nombre de doublons gossip du même hôte n'a alors plus d'effet.
   */
  private async handleHaplanLovelaceDeploy(data: { yaml: string; images: Array<{ localPath: string; filename: string }> }): Promise<void> {
    const targets = this.configService.getHaStackTargets().filter((t) => t.origin === 'local');
    if (targets.length !== 1) {
      const error = targets.length === 0
        ? 'Aucune cible HA+Mosquitto configurée (Paramètres Techniques > Déploiement HA)'
        : 'Plusieurs cibles HA+Mosquitto configurées, sélection non prise en charge pour ce dépôt';
      this.logger.error('AppService', `Dépôt carte Plan Lovelace: ${error}`);
      this.eventBus.emitGeneric('core:haplan-lovelace:deploy:result', { success: false, error });
      return;
    }

    const result = await this.haplanLovelaceDeployService.deploy(targets[0]!, data.yaml, data.images);
    this.eventBus.emitGeneric('core:haplan-lovelace:deploy:result', { success: result.success, error: result.error });
  }

  /**
   * Point d'entrée unique pour toute intervention distante sur une cible HA+Mosquitto — même
   * protocole { targetId, action, version? } que core:deployment:remote-op.
   */
  private async handleHaStackRemoteOp(targetId: string, action: RemoteAction, version?: string): Promise<void> {
    const target = this.configService.getHaStackTargets().find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emit('core:deployment:ha-stack:remote-op:result', {
        targetId,
        action,
        success: false,
        error: `Cible introuvable: ${targetId}`,
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.haStackDeployService.deploy(target, version, (chunk) => {
            this.eventBus.emit('core:deployment:ha-stack:remote-op:progress', { targetId, chunk });
          })
        : action === 'start'
        ? this.haStackDeployService.start(target)
        : action === 'stop'
        ? this.haStackDeployService.stop(target)
        : action === 'restart'
        ? this.haStackDeployService.restart(target)
        : Promise.resolve({ success: false, error: `Action distante inconnue: ${action}` }));
      this.eventBus.emit('core:deployment:ha-stack:remote-op:result', { targetId, action, ...result });
    } catch (error) {
      this.eventBus.emit('core:deployment:ha-stack:remote-op:result', {
        targetId,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ===========================================================================
  // DÉPLOIEMENT ZIGBEE2MQTT (⭐ nouveau 24/08/2026, voir Zigbee2mqttDeployService.ts) — liste de
  // cibles séparée de haStackTargets, même patron sinon.
  // ===========================================================================

  private handleZigbee2mqttTargetsGet(): void {
    this.eventBus.emit('core:deployment:zigbee2mqtt:targets:list', {
      targets: this.configService.getZigbee2mqttTargets().map((t) => ({ id: t.id, host: t.host, origin: t.origin })),
      isRunningInDocker: isRunningInDocker(),
      projectRoot: process.env.PROJECT_ROOT || process.cwd(),
    });
  }

  private handleZigbee2mqttTargetSave(target: Zigbee2mqttTargetConfig): void {
    const targets = this.configService.getZigbee2mqttTargets();
    const index = targets.findIndex((t) => t.id === target.id);
    if (index === -1) targets.push(target);
    else targets[index] = target;

    const result = this.configService.setZigbee2mqttTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de sauvegarde de la cible zigbee2mqtt ${target.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleZigbee2mqttTargetsGet();
  }

  private handleZigbee2mqttTargetDelete(data: { id: string }): void {
    const targets = this.configService.getZigbee2mqttTargets().filter((t) => t.id !== data.id);
    const result = this.configService.setZigbee2mqttTargets(targets);
    if (!result.success) {
      this.logger.error('AppService', `Échec de suppression de la cible zigbee2mqtt ${data.id}: ${result.error}`);
    } else {
      this.targetGossipService.republish();
    }
    this.handleZigbee2mqttTargetsGet();
  }

  /**
   * Point d'entrée unique pour toute intervention distante sur une cible zigbee2mqtt — même
   * protocole { targetId, action, version? } que core:deployment:remote-op.
   */
  private async handleZigbee2mqttRemoteOp(targetId: string, action: RemoteAction, version?: string): Promise<void> {
    const target = this.configService.getZigbee2mqttTargets().find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emit('core:deployment:zigbee2mqtt:remote-op:result', {
        targetId,
        action,
        success: false,
        error: `Cible introuvable: ${targetId}`,
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.zigbee2mqttDeployService.deploy(target, version, (chunk) => {
            this.eventBus.emit('core:deployment:zigbee2mqtt:remote-op:progress', { targetId, chunk });
          })
        : action === 'start'
        ? this.zigbee2mqttDeployService.start(target)
        : action === 'stop'
        ? this.zigbee2mqttDeployService.stop(target)
        : action === 'restart'
        ? this.zigbee2mqttDeployService.restart(target)
        : Promise.resolve({ success: false, error: `Action distante inconnue: ${action}` }));
      this.eventBus.emit('core:deployment:zigbee2mqtt:remote-op:result', { targetId, action, ...result });
    } catch (error) {
      this.eventBus.emit('core:deployment:zigbee2mqtt:remote-op:result', {
        targetId,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Installe les services post-installation demandés (MQTT/Whisper/Piper/openWakeWord/Ollama) sur
   * la HA actuellement connectée via `ha.ws` — voir HaPostInstallService.ts pour le détail des
   * flux REST utilisés (vérifiés en conditions réelles avant d'écrire ce code).
   */
  private async handlePostInstallApply(requests: PostInstallRequest[]): Promise<void> {
    const results = await this.haPostInstallService.apply(requests);
    this.eventBus.emit('core:post-install:result', { results });
  }

  /**
   * Gère une demande de redémarrage manuel de l'application, déclenchée depuis l'UI
   * (bouton "Redémarrer l'application" dans Paramètres Techniques > Journalisation).
   * Redémarrage seulement (pas d'arrêt persistant) : sous `restart: unless-stopped`,
   * Docker relance immédiatement le conteneur après un process.exit(0) — voir RestartManager.
   */
  private handleRestartRequested(): void {
    this.logger.warn('AppService', 'Redémarrage manuel de l\'application demandé depuis l\'interface');
    this.eventBus.emit('app:restart:result', { success: true });
    this.restartManager.scheduleRestart(1500, 'Redémarrage manuel demandé depuis Paramètres Techniques');
  }

  // ===========================================================================
  // GESTION DES SERVICES D'APPLICATIONS (NOUVEAU - Démarrage automatique)
  // ===========================================================================

  /**
   * Démarre tous les services des applications activées
   * Appelé au démarrage après détection des modules
   */
  private async startApplicationServices(): Promise<void> {
    this.logger.info('AppService', 'Démarrage des services des applications...');

    // Récupérer la liste des applications activées
    const { activated } = this.applicationManager.listAll();
    this.logger.info('AppService', `Applications activées: ${redactForLog(activated)}`);

    // Démarrage EN PARALLÈLE, pas séquentiel (08/08/2026) — une app requiredHaWs peut attendre
    // ha:ready indéfiniment (voir startApplicationService()) ; avec un for...of + await comme
    // avant, elle aurait bloqué le démarrage de TOUTES les apps suivantes dans this.modules,
    // même celles n'ayant aucun besoin de WS. Chaque app gère son propre gate indépendamment.
    const startups = this.modules
      .filter((module) => module.id !== 'core' && activated.includes(module.id))
      .map((module) =>
        this.startApplicationService(module.id).catch((error) => {
          this.logger.error('AppService', `Échec du démarrage du service ${module.id}: ${error}`);
        })
      );

    // ⭐ 24/08/2026 : une app requiredHaWs peut rester en attente de ha:ready indéfiniment PAR
    // CONCEPTION (décision du 08/08/2026 ci-dessus) — sans borne ici, ça bloquait aussi le reste
    // du démarrage de dimotic-ha lui-même (AppService.start()/Bootstrap.start()/app:started).
    // Course avec un timeout : rien n'est annulé, les apps concernées continuent d'attendre en
    // tâche de fond (démarreront normalement si HA finit par répondre) — seul le SIGNAL "démarrage
    // des services terminé" cesse d'attendre après ce délai.
    const allStarted = Promise.all(startups).then(() => true as const);
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), STARTUP_SERVICES_TIMEOUT_MS));
    const completed = await Promise.race([allStarted, timedOut]);
    if (!completed) {
      this.logger.warn(
        'AppService',
        `Démarrage des services : au moins une application (requiredHaWs ?) n'a pas terminé après ${STARTUP_SERVICES_TIMEOUT_MS / 1000}s — poursuite du démarrage sans attendre plus longtemps`
      );
    }

    this.logger.info('AppService', 'Services des applications démarrés');
  }

  /**
   * Démarre le service d'une application spécifique
   * @param moduleId - ID du module/application
   */
  private async startApplicationService(moduleId: string): Promise<void> {
    this.logger.info('AppService', `Démarrage du service pour ${moduleId}...`);

    // Arrêter d'abord si le service existe déjà
    await this.stopApplicationService(moduleId);

    // Gate WS (08/08/2026, décision utilisateur) : une app déclarant requiredHaWs (HAPLAN,
    // ArbreOuQuoi, IA, Planificateur) n'a son start() appelé qu'une fois le référentiel HA
    // synchronisé — attente indéfinie si ws_enable est actif mais que HA/WS n'est jamais prêt
    // (voir waitUntilWsRegistryReady). Si ws_enable est désactivé, ne bloque jamais (l'app doit
    // déjà tolérer l'absence de WS, comportement inchangé — voir le commentaire plus bas sur
    // haStructureRegistry potentiellement undefined).
    const metadata = this.modules.find((m) => m.id === moduleId);

    // ⭐ fonctionnelles-supervisor_specs v2.6 §5 — application en process séparé : spawn au lieu
    // d'instancier la factory in-process. Le gate WS ci-dessous ne s'applique pas (l'app gère sa
    // propre attente, dans son propre process — voir standalone.ts).
    if (metadata?.runsAsSeparateProcess) {
      this.processSupervisor.start(moduleId);
      return;
    }

    if (metadata?.requiredHaWs && this.wsEnabled) {
      if (!this.wsRegistryReady) {
        this.logger.info('AppService', `${moduleId} attend la synchronisation HA WebSocket avant de démarrer (requiredHaWs)...`);
      }
      await this.waitUntilWsRegistryReady();
    }

    try {
      // Charger le module
      const module = await this.loadApplicationModule(moduleId);
      if (!module) {
        this.logger.warn('AppService', `Module ${moduleId} introuvable`);
        return;
      }
      
      // Chercher une factory de service (create*Service ou *ServiceFactory)
      const factoryKey = Object.keys(module).find(k => 
        k.includes('Service') && (k.startsWith('create') || k.endsWith('FACTORY'))
      );
      
      if (!factoryKey) {
        this.logger.warn('AppService', `Aucune factory de service trouvée pour ${moduleId}`);
        return;
      }
      
      const factory = module[factoryKey];
      if (typeof factory !== 'function') {
        this.logger.warn('AppService', `Factory ${factoryKey} n'est pas une fonction pour ${moduleId}`);
        return;
      }
      
      // Instancier le service
      // Toutes les factories attendent un IAppConfigProvider en 3ème paramètre. Une factory à
      // 4 paramètres reçoit en plus this.haStructureRegistry (peut être undefined si
      // ha.ws_enable=false — à l'application de gérer cette absence, voir ArbreouquoiService).
      // Une factory à 5 paramètres reçoit en plus this.haWsClient (même caveat d'absence) — pour
      // les applications qui doivent émettre des commandes réelles vers HA (ex: planificateur,
      // via HaCommandService construit par l'application elle-même autour de ce client), pas
      // seulement lire le référentiel.
      let service: any;

      if (factory.length >= 5) {
        const configProvider = new AppConfigProvider(moduleId as any, this.configService);
        service = factory(this.eventBus, this.logger, configProvider, this.haStructureRegistry, this.haWsClient);
      } else if (factory.length >= 4) {
        const configProvider = new AppConfigProvider(moduleId as any, this.configService);
        service = factory(this.eventBus, this.logger, configProvider, this.haStructureRegistry);
      } else if (factory.length >= 3) {
        // La factory attend 3 paramètres : eventBus, logger, configProvider
        const configProvider = new AppConfigProvider(moduleId as any, this.configService);
        service = factory(this.eventBus, this.logger, configProvider);
      } else {
        throw new Error(`Factory ${factoryKey} attend moins de 3 paramètres`);
      }
      
      // Vérifier que le service a une méthode start()
      if (typeof service.start !== 'function') {
        this.logger.warn('AppService', `Service ${moduleId} n'a pas de méthode start()`);
        return;
      }
      
      // Démarrer le service
      await service.start();
      
      // Stocker l'instance
      this.appServiceInstances.set(moduleId, { service, moduleId });
      
      this.logger.info('AppService', `Service ${moduleId} démarré avec succès`);
    } catch (error) {
      this.logger.error('AppService', `Échec du démarrage du service ${moduleId}: ${error}`);
      throw error;
    }
  }

  /**
   * Arrête le service d'une application spécifique
   * @param moduleId - ID du module/application
   */
  private async stopApplicationService(moduleId: string): Promise<void> {
    const metadata = this.modules.find((m) => m.id === moduleId);
    if (metadata?.runsAsSeparateProcess) {
      this.processSupervisor.stop(moduleId);
      return;
    }

    const instance = this.appServiceInstances.get(moduleId);

    if (!instance) {
      this.logger.debug('AppService', `Aucun service à arrêter pour ${moduleId}`);
      return;
    }
    
    try {
      this.logger.info('AppService', `Arrêt du service ${moduleId}...`);
      
      // Arrêter si le service a une méthode stop()
      if (typeof instance.service.stop === 'function') {
        await instance.service.stop();
      }
      
      // Supprimer de la map
      this.appServiceInstances.delete(moduleId);
      
      this.logger.info('AppService', `Service ${moduleId} arrêté`);
    } catch (error) {
      this.logger.error('AppService', `Échec de l'arrêt du service ${moduleId}: ${error}`);
      // Ne pas bloquer, juste logger
    }
  }

  /**
   * Redémarre le service d'une application (arrête puis redémarre)
   * @param moduleId - ID du module/application
   */
  private async restartApplicationService(moduleId: string): Promise<void> {
    this.logger.info('AppService', `Redémarrage du service ${moduleId}...`);

    const metadata = this.modules.find((m) => m.id === moduleId);
    if (metadata?.runsAsSeparateProcess) {
      // ⚠️ Pas stop() puis start() séparément : processSupervisor.stop() envoie SIGTERM sans
      // attendre la sortie réelle du process — un start() immédiatement après trouverait l'ancien
      // enfant encore présent et n'en relancerait pas de nouveau. restart() de ProcessSupervisor
      // enchaîne correctement (attend la sortie avant de respawn).
      this.processSupervisor.restart(moduleId);
      return;
    }

    try {
      await this.stopApplicationService(moduleId);
      await this.startApplicationService(moduleId);
      this.logger.info('AppService', `Service ${moduleId} redémarré avec succès`);
    } catch (error) {
      this.logger.error('AppService', `Échec du redémarrage du service ${moduleId}: ${error}`);
    }
  }

  /**
   * Charge un module d'application par son ID
   * Nouvelle structure : applications/{moduleId}/src/domain/index.ts ou dist/domain/index.js
   * @param moduleId - ID du module
   * @returns Le module chargé ou undefined
   */
  private async loadApplicationModule(moduleId: string): Promise<Record<string, unknown> | undefined> {
    // ⭐ 24/09/2026 : dossier résolu sur les deux racines (voir appRoots.ts), même chargement que
    // registerApp().
    const appDir = this.applicationManager.resolveAppDir(moduleId);
    if (!appDir) {
      this.logger.debug('AppService', `Module ${moduleId} introuvable (applications/ ni data/applications/)`);
      return undefined;
    }
    try {
      return this.loadAppModule(appDir);
    } catch (error) {
      this.logger.error('AppService', `Échec du chargement du module ${moduleId}: ${error}`);
      return undefined;
    }
  }

  /**
   * Charge et valide la configuration
   */
  private async loadAndValidateConfig(): Promise<void> {
    try {
      const config = this.configService.getConfig();
      const validationResult = this.validateConfig(config);
      
      // Émettre la configuration actuelle
      this.eventBus.emit('config:current', config);
      
      // Émettre le résultat de validation
      this.eventBus.emit('config:validation:result', validationResult);

      if (!validationResult.valid) {
        this.logger.warn('AppService', `Configuration invalide : ${validationResult.errors.length} erreurs`);
      }
    } catch (error) {
      this.logger.error('AppService', `Erreur de chargement de la configuration: ${error}`);
      this.eventBus.emit('config:validation:result', {
        valid: false,
        errors: [{ path: 'config', message: String(error), severity: 'error', section: 'global', required: true }],
        warnings: [],
        requiredMissing: [],
      });
    }
  }

  /**
   * Valide une configuration avec Zod
   */
  validateConfig(config: Partial<TechnicalConfig>): ConfigValidationResult {
    const result = technicalConfigSchema.safeParse(config);
    
    if (result.success) {
      return {
        valid: true,
        errors: [],
        warnings: this.getConfigurationWarnings(result.data),
        requiredMissing: [],
      };
    }

    // Transformer les erreurs Zod en ValidationError
    const errors: ValidationError[] = result.error.errors.map(zodError => ({
      path: zodError.path.join('.'),
      message: zodError.message,
      severity: 'error',
      section: zodError.path[0] as string,
      required: true,
    }));

    return {
      valid: false,
      errors,
      warnings: [],
      requiredMissing: errors.map(e => e.path),
    };
  }

  /**
   * Génère des avertissements pour la configuration
   * NOTE: Désactivé temporairement pour masquer les messages d'avertissement
   */
  private getConfigurationWarnings(config: TechnicalConfig): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    // ⚠️ DESACTIVE TEMPORAIREMENT - Réactiver quand prêt
    // Avertir si level = debug en production
    // const loggingConfig = (config as any).logging as { level?: string } | undefined;
    // if (process.env.NODE_ENV === 'production' && loggingConfig?.level === 'debug') {
    //   warnings.push({
    //     path: 'logging.level',
    //     message: 'Recommended: use info or warn level in production',
    //     severity: 'warning',
    //     section: 'logging',
    //     required: false,
    //   });
    // }

    return warnings;
  }

  // ===========================================================================
  // Méthodes de gestion HA WebSocket (Toggle dynamique)
  // ===========================================================================

  /**
   * Gère le résultat de sauvegarde de configuration pour WS.
   */
  private handleConfigSaveResultForWs(result: ConfigSaveResult): void {
    if (!result.success) {
      this.logger.warn('AppService', `Sauvegarde config échouée: ${result.error}`);
      return;
    }
    
    this.logger.debug('AppService', 'Configuration sauvegardée - Vérification de ws_enable...');
    
    const currentConfig = this.configService.getConfig();
    const newWsEnable = currentConfig.ha?.ws_enable === true;
    const newWsConfig = currentConfig.ha?.ws;
    
    if (newWsEnable !== this.wsEnabled) {
      this.logger.info('AppService', `ws_enable a changé: ${this.wsEnabled} -> ${newWsEnable}`);
      this.toggleHaWs(newWsEnable, newWsConfig);
    } else if (newWsEnable && newWsConfig !== this.wsConfig) {
      // La config WS a changé, pour l'instant on nécessite un restart
      this.logger.info('AppService', 'Configuration WS mise à jour - Restart nécessaire pour appliquer les changements');
      this.wsConfig = newWsConfig;
      // Note: La recréation de HaWsClient avec nouvelle config nécessite un restart de l'application
      // car le client est passé via le constructeur
    }
  }
  
  /**
   * Active ou désactive HA WebSocket dynamiquement.
   * @param enable - true pour activer, false pour désactiver
   * @param config - Configuration WS optionnelle
   */
  private toggleHaWs(enable: boolean, config?: HaWsConfig): void {
    if (enable === this.wsEnabled) {
      this.logger.debug('AppService', `HA WebSocket déjà ${enable ? 'activé' : 'désactivé'}`);
      return;
    }
    
    this.wsEnabled = enable;
    
    if (enable) {
      this.logger.info('AppService', 'Activation de HA WebSocket...');
      if (config) {
        this.wsConfig = config;
      }
      // Démarrer la connexion si le client existe
      if (this.haWsClient) {
        this.startHaWsClient();
      } else {
        this.logger.warn('AppService', 'HaWsClient non disponible - activation reportée');
      }
    } else {
      this.logger.info('AppService', 'Désactivation de HA WebSocket...');
      this.destroyHaWsClient();
    }
    
    this.logger.info('AppService', `HA WebSocket ${enable ? 'ACTIF' : 'DESACTIVE'}`);
  }
  
  /**
   * Détruit le client WS actuel.
   */
  private destroyHaWsClient(): void {
    if (this.haWsClient) {
      if (this._isWsConnected) {
        this.haWsClient.disconnect();
        this._isWsConnected = false;
        this.haConnected = false;
      }
      this.haWsClient = undefined;
    }
  }

  // ===========================================================================
  // Méthodes pour HA WebSocket
  // ===========================================================================

  /**
   * Démarre le client HA WebSocket
   */
  private startHaWsClient(): void {
    if (!this.haWsClient) return;

    this.haWsClient.connect();

    // @ts-ignore
    this.haWsClient.onConnect(() => {
      this.haConnected = true;
      this._isWsConnected = true;
      this.logger.info('AppService', 'Connecté à Home Assistant WebSocket');
      this.eventBus.emitGeneric('ha:connected', undefined);
      void this.loadHaRegistry();
    });

    // @ts-ignore
    this.haWsClient.onDisconnect((reason?: string) => {
      this.haConnected = false;
      this._isWsConnected = false;
      this.logger.warn('AppService', `Déconnecté de Home Assistant WebSocket: ${reason || 'inconnu'}`);
      this.eventBus.emitGeneric('ha:disconnected', undefined);
    });

    // @ts-ignore
    this.haWsClient.onError((error: Error) => {
      this.logger.error('AppService', `Erreur HA WebSocket: ${error.message}`);
      // ⭐ 24/08/2026, demande explicite : un token confirmé invalide par HA lui-même ne doit
      // jamais rester tel quel dans la config — voir ConfigService.clearHaWsToken(). Empêche
      // aussi une future diffusion de dimotic-ha (CoreDeployService) de propager ce token mort
      // sur une nouvelle machine.
      if (error.message === 'Invalid HA token') {
        const result = this.configService.clearHaWsToken();
        if (result.success) {
          this.logger.warn('AppService', 'Token HA WS invalide — effacé de la configuration (ha.ws)');
        } else {
          this.logger.error('AppService', `Échec d'effacement du token HA WS invalide: ${result.error}`);
        }
      }
    });
  }

  /**
   * Charge le référentiel HA initial (get_states + area/device/entity registry) et peuple
   * HaStructureRegistry — conforme à specs-techniques-socle-ha-mqtt §8.1.2. Appelé à chaque
   * connexion ET reconnexion (rebuild() couvre les deux, §8.1.4 : rechargement complet).
   */
  private async loadHaRegistry(): Promise<void> {
    if (!this.haWsClient || !this.haStructureRegistry) return;

    try {
      // Abonnement AVANT l'instantané (get_states), pas après (08/08/2026, corrige un bug
      // constaté en conditions réelles) — sinon tout state_changed survenant entre les deux
      // est manqué définitivement pour une entité dont la valeur ne change plus avant longtemps
      // (ex: capteurs "Sun" — sensor.sun_next_dawn ne change qu'une fois par jour) : le
      // référentiel restait figé sur "unknown" indéfiniment. get_states() reflète toujours l'état
      // RÉEL au moment de l'appel (pas un cache), donc l'appeler après l'abonnement ne perd rien —
      // au pire un state_changed redondant est appliqué juste avant d'être écrasé par un
      // rebuild() tout aussi à jour. wireHaRegistryEvents() est idempotent (haEventsWired) : ne
      // s'applique qu'à la toute première connexion, sans effet sur les reconnexions suivantes.
      this.wireHaRegistryEvents();

      const { entities, areas, devices, entityRegistry } = await this.haWsClient.loadInitialRegistry();
      const registry = this.haStructureRegistry.rebuild(entities, areas, devices, entityRegistry);

      this.eventBus.emitGeneric('ha:ready', {
        entityCount: registry.entityCount,
        areaCount: registry.areaCount,
        deviceCount: registry.deviceCount,
      });
      this.haRegistryTracer.writeSnapshot(registry);
    } catch (error) {
      this.logger.error('AppService', `Échec du chargement du référentiel HA: ${error}`);
    }
  }

  /**
   * Résolue au premier `ha:ready` (voir loadHaRegistry) — jamais de timeout, volontairement (voir
   * le commentaire sur wsRegistryReady). Utilisée par startApplicationService() pour retarder le
   * démarrage des apps requiredHaWs jusqu'à ce que le référentiel HA soit réellement synchronisé.
   */
  private waitUntilWsRegistryReady(): Promise<void> {
    if (this.wsRegistryReady) return Promise.resolve();
    if (!this.wsRegistryReadyPromise) {
      this.wsRegistryReadyPromise = new Promise((resolve) => {
        this.eventBus.onGeneric('ha:ready', () => {
          this.wsRegistryReady = true;
          resolve();
        });
      });
    }
    return this.wsRegistryReadyPromise;
  }

  /**
   * Souscrit aux événements temps réel HA et route chaque mise à jour vers HaStructureRegistry.
   * Idempotent (haEventsWired) : onConnect peut se redéclencher à chaque reconnexion, il ne faut
   * jamais souscrire deux fois (callbacks empilés en double sur HaWsClient sinon).
   */
  private wireHaRegistryEvents(): void {
    if (this.haEventsWired || !this.haWsClient || !this.haStructureRegistry) return;
    this.haEventsWired = true;

    const registry = this.haStructureRegistry;

    // @ts-ignore
    this.haWsClient.onAreaUpdated((area) => {
      if (area.action === 'delete') {
        registry.removeArea(area.area_id);
      } else if (area.action === 'create') {
        registry.addArea(area);
      } else {
        registry.updateArea(area);
      }
      this.haRegistryTracer.logChange({ type: 'area', action: area.action, id: area.area_id, name: area.name });
      this.eventBus.emitGeneric('ha:area:updated', area);
      this.haRegistryTracer.writeSnapshot(registry.getRegistry());
    });

    // @ts-ignore
    this.haWsClient.onDeviceUpdated((device) => {
      if (device.action === 'delete') {
        registry.removeDevice(device.device_id);
      } else if (device.action === 'create') {
        registry.addDevice(device);
      } else {
        registry.updateDevice(device);
      }
      this.haRegistryTracer.logChange({ type: 'device', action: device.action, id: device.device_id, name: device.name });
      this.eventBus.emitGeneric('ha:device:updated', device);
      this.haRegistryTracer.writeSnapshot(registry.getRegistry());
    });

    // @ts-ignore
    this.haWsClient.onEntityUpdated((entityMeta) => {
      if (entityMeta.action === 'delete') {
        registry.removeEntity(entityMeta.entity_id);
      } else {
        // Pas d'état dans un entity_registry_updated (métadonnées seules) — on préserve le
        // dernier état connu du registre s'il existe, sinon un état minimal en attendant le
        // prochain state_changed.
        const existing = registry.getEntity(entityMeta.entity_id);
        const rawEntity: HaRawEntity = {
          entity_id: entityMeta.entity_id,
          state: existing?.state ?? 'unknown',
          attributes: existing?.attributes ?? {},
          last_changed: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          context: { id: '', parent_id: null, user_id: null },
        };
        registry.updateEntity(rawEntity, entityMeta);
      }
      this.haRegistryTracer.logChange({ type: 'entity', action: entityMeta.action, id: entityMeta.entity_id });
      this.eventBus.emitGeneric('ha:entity:updated', entityMeta);
      this.haRegistryTracer.writeSnapshot(registry.getRegistry());
    });

    // @ts-ignore
    this.haWsClient.onStateChanged((rawEntity: HaRawEntity) => {
      registry.updateEntity(rawEntity);
      this.eventBus.emitGeneric('ha:entity:state_changed', rawEntity);
      // Volontairement absent du journal des changements (états exclus, demande explicite) et
      // pas de writeSnapshot() ici : trop fréquent pour un fichier réécrit en entier à chaque
      // appel, réservé aux changements de structure (area/device/entity).
    });

    this.haWsClient.subscribeToEvents();
  }

  // ===========================================================================
  // Handlers de configuration
  // ===========================================================================

  /**
   * Gère la demande de configuration
   */
  private handleConfigGet(): void {
    const config = this.configService.getConfig();
    this.eventBus.emit('config:current', config);
  }

  /**
   * Gère la sauvegarde de la configuration
   */
  private handleConfigSave(config: TechnicalConfig): void {
    console.log('[AppService SERVEUR] Traitement de config:save:requested');
    console.log('[AppService SERVEUR] Config à valider:', redactForLog(config, 2));
    
    const validationResult = this.validateConfig(config);
    console.log('[AppService SERVEUR] Résultat validation:', validationResult);
    
    if (!validationResult.valid) {
      this.eventBus.emit('config:save:result', {
        success: false,
        errors: validationResult.errors,
        warnings: validationResult.warnings,
        message: 'Validation échouée',
      } as ConfigSaveResult);
      return;
    }

    // @ts-ignore
    const saveResult = this.configService.saveConfig(config as unknown as AppConfig);
    
    if (saveResult.success) {
      this.eventBus.emit('config:save:result', {
        success: true,
        message: 'Configuration sauvegardée',
      } as ConfigSaveResult);

      // Recharger la configuration
      this.configService.reload();

      // Rediffuser la configuration à jour à tous les clients connectés
      this.eventBus.emit('config:current', this.configService.getConfig());

      // Émettre un événement pour notifier que la config a été rechargée
      this.eventBus.emit('config:reload', { timestamp: new Date().toISOString() });
    } else {
      this.eventBus.emit('config:save:result', {
        success: false,
        errors: [{ path: 'config', message: saveResult.error || 'Erreur de sauvegarde', severity: 'error', section: 'global', required: true }],
        message: saveResult.error || 'Erreur de sauvegarde',
      } as ConfigSaveResult);
    }
  }

  /**
   * Gère la validation de la configuration
   */
  private handleConfigValidate(config: TechnicalConfig): void {
    const result = this.validateConfig(config);
    this.eventBus.emit('config:validation:result', result);
  }

  /**
   * Gère la demande de configuration d'un module
   */
  private handleModuleConfigGet(data: { moduleId: string }): void {
    const config = this.configService.getConfig();
    const moduleConfig = (config as any)[data.moduleId];
    
    // Émettre un événement unique pour que SocketBridge puisse le relayer
    this.eventBus.emit('app:module:config', {
      moduleId: data.moduleId,
      config: moduleConfig,
    });
  }

  /**
   * Gère la sauvegarde de la configuration d'un module
   */
  private handleModuleConfigSave(data: { moduleId: string; config: unknown }): void {
    console.log('[AppService SERVEUR] Traitement de app:modules:config:save');
    console.log('[AppService SERVEUR] Module:', data.moduleId);
    console.log('[AppService SERVEUR] Config module:', redactForLog(data.config, 2));
    
    // Utiliser ConfigService pour sauvegarder la configuration du module
    const saveResult = this.configService.saveModuleConfig(data.moduleId, data.config);
    console.log('[AppService SERVEUR] Résultat sauvegarde:', saveResult);
    
    // Émettre un événement unique pour que SocketBridge puisse le relayer
    this.eventBus.emit('app:module:config:saved', {
      moduleId: data.moduleId,
      success: saveResult.success,
      error: saveResult.error,
    });
    
    // Recharger la configuration globale après une sauvegarde de module
    this.configService.reload();

    if (saveResult.success) {
      // Rediffuser la configuration à jour à tous les clients connectés
      this.eventBus.emit('config:current', this.configService.getConfig());
    }

    // Émettre un événement global pour que SocketBridge puisse le relayer
    this.eventBus.emit('config:save:result', {
      success: saveResult.success,
      error: saveResult.error,
      message: saveResult.success ? 'Configuration du module sauvegardée' : 'Erreur de sauvegarde',
    } as ConfigSaveResult);
  }

  // ===========================================================================
  // Getters publics
  // ===========================================================================

  /**
   * Récupère la liste des modules détectés.
   */
  getModules(): ApplicationModule[] {
    return [...this.modules];
  }

  /**
   * ⭐ fonctionnelles-supervisor_specs v2.6 §5 — arrête tous les process séparés (espdisplay en
   * Phase 1) à l'arrêt de core lui-même (voir index.ts::ApplicationBootstrap.stop()). Sans ça, un
   * enfant spawné devient orphelin à chaque redémarrage de core (SIGKILL/SIGTERM de tsx watch ou
   * RestartManager sur le PARENT n'arrête jamais ses propres enfants automatiquement) —
   * accumulation constatée en conditions réelles (plusieurs process espdisplay/dist/standalone.js
   * vivants simultanément après quelques redémarrages de core en dev).
   */
  stopAllSeparateProcesses(): void {
    for (const module of this.modules) {
      if (module.runsAsSeparateProcess) {
        this.processSupervisor.stop(module.id);
      }
    }
  }

  /**
   * Vérifie si HA WebSocket est activé.
   */
  isWsEnabled(): boolean {
    return this.wsEnabled;
  }

  /**
   * Vérifie si HA WebSocket est connecté.
   */
  isWsConnected(): boolean {
    return this._isWsConnected;
  }

  /**
   * Récupère le client HA WebSocket.
   */
  getHaWsClient(): HaWsClient | undefined {
    return this.haWsClient;
  }
}

export default AppService;