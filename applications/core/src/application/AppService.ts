// src/application/AppService.ts
// Service d'orchestration de l'application
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §10.1 et specs-presentation-v2.0.md §4.2

import { readdir, stat } from 'node:fs/promises';
import { Dirent, existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus } from './EventBus';
import { ApplicationManager } from './ApplicationManager';
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

    // Initialiser le gestionnaire d'applications
    this.applicationManager = new ApplicationManager(restartManager, logger, configService);
    
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
   * Détecte automatiquement les modules d'application dans applications/
   * Nouvelle structure : chaque application est dans applications/{app}/src/domain/index.ts
   * Conforme à specs-presentation-v2.0.md §4.3
   */
  private async detectApplicationModules(): Promise<void> {
    try {
      // Module core (paramètres techniques) est toujours présent
      this.modules.push(this.createCoreModule());

      // Chemin vers le répertoire applications
      const projectRoot = process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../'));
      const appsDir = path.join(projectRoot, 'applications');

      // Lister les répertoires dans applications/ (exclure core et desactivees)
      let dirs: Dirent[] = [];
      
      try {
        const allDirs = await readdir(appsDir, { withFileTypes: true });
        // Filtrer : on veut les répertoires qui sont des applications (pas core, pas desactivees)
        dirs = allDirs.filter(dir => 
          dir.isDirectory() && 
          dir.name !== 'core' && 
          dir.name !== 'desactivees' &&
          !dir.name.startsWith('.')
        );
      } catch (err) {
        this.logger.warn('AppService', `Aucun répertoire applications trouvé à ${appsDir}: ${err}`);
        return;
      }

      // Applications désactivées (data/core/config.yaml, disabledApps) — toujours présentes
      // physiquement sous applications/ (voir ApplicationManager.ts), donc explicitement
      // exclues ici pour reproduire le comportement antérieur (une app désactivée n'a aucune
      // trace dans this.modules : ni entrée de menu, ni schéma de config enregistré).
      const disabledApps = new Set(this.applicationManager.listAll().disabled);
      dirs = dirs.filter(dir => !disabledApps.has(dir.name));

      for (const dir of dirs) {
        // Vérifier si le répertoire contient dist/domain/index.js ou src/domain/index.ts
        //
        // ⚠️ `dist/domain/index.js` (production, code compilé) DOIT être vérifié en premier.
        // Ce processus lui-même tourne soit sous `tsx` (dev — `npm run dev`/`dev:local`, qui
        // enregistre un loader TypeScript pour TOUT le processus, y compris les modules chargés
        // dynamiquement plus bas), soit sous `node` pur (production — `node dist/index.js`,
        // aucun loader TS). Donner la priorité à `src/domain/index.ts` (ordre inversé jusqu'ici)
        // fonctionnait donc par accident sous `tsx`, mais échouait systématiquement en
        // production dès que `src/` existait (systématiquement vrai, le code source restant
        // toujours présent) — `import()`/`require()` d'un fichier `.ts` brut sous `node` pur
        // échoue avec une erreur de syntaxe (`Unexpected token`/`Unexpected identifier`), quel
        // que soit l'état du `dist` réellement construit. Bug resté invisible tant que le projet
        // n'avait jamais tourné en mode production réel — découvert en testant le déploiement
        // Docker (03/08/2026), qui exécute `node applications/core/dist/index.js` sans `tsx`.
        const distDomainIndexJs = path.join(appsDir, dir.name, 'dist', 'domain', 'index.js');
        const srcDomainIndexTs = path.join(appsDir, dir.name, 'src', 'domain', 'index.ts');
        const srcDomainIndexJs = path.join(appsDir, dir.name, 'src', 'domain', 'index.js');

        let domainIndexPath: string | null = null;

        if (existsSync(distDomainIndexJs)) {
          domainIndexPath = distDomainIndexJs;
        } else if (existsSync(srcDomainIndexTs)) {
          domainIndexPath = srcDomainIndexTs;
        } else if (existsSync(srcDomainIndexJs)) {
          domainIndexPath = srcDomainIndexJs;
        }
        
        if (!domainIndexPath) {
          this.logger.debug('AppService', `Pas de domain/index trouvé pour ${dir.name}, ignoré`);
          continue;
        }
        
        try {
          // ⚠️ `require()` direct pour un `.js` compilé (toujours CommonJS dans ce projet —
          // aucune application n'a `"type": "module"`), `import()` uniquement pour le `.ts`
          // source (dev sous `tsx`, dont le loader transpile à la volée pour `import()`).
          //
          // Historique : tenter `import()` d'abord puis retomber sur `require()` en cas
          // d'échec — comme le faisait ce bloc jusqu'ici — semble anodin mais NE L'EST PAS
          // pour un fichier CommonJS : Node délègue la résolution d'un `import()` de CJS à
          // son propre chargeur `require` en interne. Un premier `import()` en échec sur ce
          // même chemin, suivi d'un `require()` de repli qui réussit (exactement ce qui se
          // produit ici, `detectModules()` tournant avant `loadApplicationModule()` sur le
          // même fichier), laisse le résolveur de modules de Node dans un état incohérent
          // pour un `import()` ULTÉRIEUR du même chemin ailleurs dans le process — provoquant
          // un deuxième échec ("Cannot find module") sur un fichier pourtant bien présent et
          // par ailleurs chargeable. Découvert en testant le déploiement Docker (03/08/2026,
          // premier vrai test en mode production `node` pur, jamais exercé auparavant — voir
          // aussi le correctif de priorité dist/src juste au-dessus).
          let module: Record<string, unknown>;
          if (domainIndexPath.endsWith('.ts')) {
            const moduleUrl = pathToFileURL(domainIndexPath).href;
            module = await import(moduleUrl);
          } else {
            module = require(path.resolve(domainIndexPath));
          }

          // Chercher une constante *APP
          const appKey = Object.keys(module).find(k => k.endsWith('_APP'));
          if (appKey && module[appKey]) {
            const appModule = module[appKey] as ApplicationModule;
            
            this.logger.info('AppService', `Module ${dir.name} détecté - id: ${appModule.id}, name: ${appModule.name}, type: ${appModule.type}, hasConfigUi: ${!!appModule.configUi}, configUi: ${JSON.stringify(appModule.configUi)}`);
            
            // Déterminer le statut de configuration
            const configStatus = this.getModuleConfigStatus(appModule);
            
            // Ajouter le module avec son statut
            this.modules.push({
              ...appModule,
              status: configStatus,
            });

            // Détecter le schéma Zod du module (convention {moduleId}ConfigSchema, ex:
            // nommageConfigSchema) — permet à ConfigService.saveModuleConfig() de valider avant
            // écriture plutôt que de tout accepter via le .passthrough() de configSchema.
            const schemaKey = Object.keys(module).find(k => k.toLowerCase() === `${appModule.id}configschema`.toLowerCase());
            if (schemaKey && module[schemaKey]) {
              this.configService.registerModuleSchema(appModule.id, module[schemaKey] as any);
              this.logger.debug('AppService', `Schéma de configuration enregistré pour ${appModule.id}`);
            }

            // Détecter les événements Socket.io de l'application
            const socketEventsKey = Object.keys(module).find(k => k.endsWith('_SOCKET_EVENTS'));
            if (socketEventsKey && module[socketEventsKey]) {
              const appSocketEvents = module[socketEventsKey];
              this.logger.info('AppService', `Événements Socket.io détectés pour ${appModule.id}: ${Object.keys(appSocketEvents).length} événements`);
              
              // Envoyer les événements à SocketBridge pour configuration dynamique
              this.eventBus.emit('app:socket-events:registered', {
                appId: appModule.id,
                socketEvents: appSocketEvents
              });
            }

            this.logger.info('AppService', `Module détecté : ${appModule.id} (type: ${appModule.type})`);
          }
        } catch (error) {
          this.logger.warn('AppService', `Erreur de chargement du module ${dir.name}: ${error}`);
        }
      }
    } catch (error) {
      this.logger.error('AppService', `Erreur de détection des modules: ${error}`);
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
        this.logger.info('AppService', `Module ${module.id} a un configUi, émission en cours: ${JSON.stringify(module.configUi)}`);
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
    ];
    
    this.eventBus.emit('app:socket-events:registered', {
      appId: 'core',
      socketEvents: SOCLE_SOCKET_EVENTS,
      persistentEvents: persistentCoreEvents
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
    this.logger.info('AppService', `Métadonnées UI enregistrées pour ${data.moduleId}, metadata: ${JSON.stringify(data.metadata)}`);
  }

  // ===========================================================================
  // GESTION DES APPLICATIONS (NOUVEAU v4.4)
  // ===========================================================================

  /**
   * Gère la demande de liste des applications
   */
  private handleApplicationsList(): void {
    this.logger.info('AppService', 'Demande de liste des applications reçue');
    const { activated, disabled } = this.applicationManager.listAll();
    this.logger.info('AppService', `Liste des applications: activated=${JSON.stringify(activated)}, disabled=${JSON.stringify(disabled)}`);
    this.eventBus.emit('app:applications:list:result', { activated, disabled });
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
    });
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
    this.logger.info('AppService', `Applications activées: ${JSON.stringify(activated)}`);

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

    await Promise.all(startups);

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
    try {
      // Chemin vers le module (applications/{moduleId}/src/domain/index.ts ou dist/domain/index.js)
      const projectRoot = process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../'));
      const appsDir = path.join(projectRoot, 'applications');
      
      let modulePath: string | undefined;

      // Essayer applications/{moduleId}/dist/domain/index.js (production) EN PREMIER —
      // voir le commentaire détaillé dans detectModules() ci-dessus pour la raison impérative
      // de cet ordre (un `src/domain/index.ts` prioritaire échoue systématiquement sous `node`
      // pur, hors `tsx`).
      const distModulePath = path.join(appsDir, moduleId, 'dist', 'domain', 'index.js');
      if (existsSync(distModulePath)) {
        modulePath = distModulePath;
      }

      // Essayer applications/{moduleId}/src/domain/index.ts (développement, sous tsx)
      if (!modulePath) {
        const srcModulePath = path.join(appsDir, moduleId, 'src', 'domain', 'index.ts');
        if (existsSync(srcModulePath)) {
          modulePath = srcModulePath;
        }
      }

      // Essayer applications/{moduleId}/src/domain/index.js (cas résiduel)
      if (!modulePath) {
        const srcModuleJsPath = path.join(appsDir, moduleId, 'src', 'domain', 'index.js');
        if (existsSync(srcModuleJsPath)) {
          modulePath = srcModuleJsPath;
        }
      }
      
      if (!modulePath) {
        this.logger.debug('AppService', `Module ${moduleId} introuvable dans applications/`);
        return undefined;
      }
      
      // Convertir en URL pour l'import dynamique
      // `require()` direct pour le `.js` compilé (CommonJS), `import()` uniquement pour le
      // `.ts` source (dev sous tsx) — voir le commentaire détaillé dans detectModules().
      let module: Record<string, unknown>;
      if (modulePath.endsWith('.ts')) {
        const moduleUrl = pathToFileURL(modulePath).href;
        module = await import(moduleUrl);
      } else {
        module = require(path.resolve(modulePath));
      }
      return module;
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
    console.log('[AppService SERVEUR] Config à valider:', JSON.stringify(config, null, 2));
    
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
    console.log('[AppService SERVEUR] Config module:', JSON.stringify(data.config, null, 2));
    
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