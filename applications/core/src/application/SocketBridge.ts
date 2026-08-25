// src/application/SocketBridge.ts
// SocketBridge - Pont entre EventBus et Socket.io
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §5 et specs-presentation-v2.0.md §4

import type { Server as HttpServer } from 'http';
import type { EventBus } from './EventBus';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  AppStatus,
  ConfigSaveResult,
  ApplicationModule,
} from '../types/events';
import type { ConfigValidationResult, TechnicalConfig, ModuleUiMetadata } from '../types/config';
import type { Logger } from '../infrastructure/logger/index';
import type { AuthService } from '../infrastructure/auth/AuthService';

/**
 * SocketBridge - Traduit les événements EventBus ↔ Socket.io
 *
 * Règles strictes (conforme §5 specs-techniques-socle-ha-mqtt-v4.3) :
 * - SocketBridge est le SEUL point de contact entre EventBus et Socket.io
 * - Aucun module ne connaître l'existence de Socket.io directement
 * - La présentation ne connaît pas le domaine - tout passe par Socket.io
 *
 * Porte d'authentification OAuth2 HA (2026-07-28, voir décision "accès externe") : quand
 * `authService` est fourni et actif, la connexion Socket.io elle-même est gardée (handshake) —
 * la protection REST de `PresentationServer` seule ne suffit pas, Socket.io étant le canal
 * principal de toutes les applications (§5 specs socle), pas seulement les routes REST.
 */
export class SocketBridge {
  private io: any;
  private eventBus: EventBus;
  private logger: Logger;
  private httpServer: HttpServer;
  private authService?: AuthService;
  private sockets: Set<any> = new Set();
  private moduleUiMetadata: Record<string, ModuleUiMetadata> = {};
  private modulesList: ApplicationModule[] = [];
  private appSocketEvents: Map<string, Record<string, string>> = new Map();
  /** Dernier menu enregistré par chaque application via app:menu:register — rejoué aux nouvelles
   *  connexions, même principe que moduleUiMetadata (voir TODO.md, mécanisme resté sans relais
   *  jusqu'ici : émis par chaque app depuis l'origine, jamais câblé côté SocketBridge). */
  private customMenus: Record<string, unknown> = {};
  private persistentEvents: Map<string, { appId: string; eventName: string; lastData: unknown }> = new Map();
  /** Listeners EventBus posés par registerAppSocketEvents(), par appId — permet de les retirer
   *  avant un ré-enregistrement (ex: AppService.detectModules() ET Service.start() enregistrent
   *  chacun les mêmes événements au démarrage) pour ne jamais dupliquer un broadcast. */
  private appSocketEventListeners: Map<string, Array<{ eventName: string; listener: (data: unknown) => void }>> = new Map();

  /**
   * Crée un nouveau SocketBridge
   * @param httpServer - Serveur HTTP Express
   * @param eventBus - Instance de l'EventBus
   * @param logger - Instance du logger
   * @param authService - Porte d'authentification OAuth2 HA (optionnelle, inerte si absente ou désactivée)
   */
  constructor(
    httpServer: HttpServer,
    eventBus: EventBus,
    logger: Logger,
    authService?: AuthService
  ) {
    this.httpServer = httpServer;
    this.eventBus = eventBus;
    this.logger = logger;
    this.authService = authService?.isEnabled() ? authService : undefined;

    // Initialiser Socket.io
    this.initializeSocketIO();

    // Configurer les handlers
    this.setupEventBusListeners();
    this.setupSocketIOHandlers();
  }

  /**
   * Initialise le serveur Socket.io
   */
  private initializeSocketIO(): void {
    const { Server } = require('socket.io');

    this.io = new Server(this.httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      connectionStateRecovery: {
        maxDisconnectionDuration: 120000,
        skipMiddlewares: true,
      },
    });

    if (this.authService) {
      const authService = this.authService;
      this.io.use((socket: any, next: (err?: Error) => void) => {
        if (authService.verifySessionCookie(socket.handshake.headers.cookie)) return next();
        next(new Error('unauthorized'));
      });
      this.logger.info('SocketBridge', 'Garde d\'authentification activée sur le handshake Socket.io');
    }

    this.logger.info('SocketBridge', 'Socket.io serveur initialisé');
  }

  /**
   * Configure les listeners EventBus → Socket.io
   * Les événements EventBus sont relayés vers les clients Socket.io
   */
  private setupEventBusListeners(): void {
    // État de l'application
    this.eventBus.on('app:status:changed', (status: { ha: boolean; haEntities: number; uptime: number }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: app:status:changed');
      this.broadcast('app:status', {
        mqtt: false, // TODO: à mettre à jour avec le statut MQTT
        haEntities: status.haEntities,
        uptime: status.uptime,
      } as AppStatus);
    });

    // Configuration actuelle
    this.eventBus.on('config:save:requested', (config: TechnicalConfig) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: config:save:requested');
      console.log('[SocketBridge SERVEUR] Réception config:save:requested via EventBus');
      console.log('[SocketBridge SERVEUR] Config reçue:', JSON.stringify(config, null, 2));
      // La validation et sauvegarde sont gérées par AppService
      // SocketBridge ne fait que relayer les résultats
    });

    // Résultat de validation
    this.eventBus.on('config:validation:result', (result: ConfigValidationResult) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: config:validation:result');
      this.broadcast('config:validation:result', result);
    });

    // Résultat de sauvegarde
    this.eventBus.on('config:saved', (result: ConfigSaveResult) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: config:saved');
      this.broadcast('config:saved', result);
    });

    // Résultat réel de la sauvegarde globale (émis par AppService.handleConfigSave)
    this.eventBus.onGeneric('config:save:result', (result) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: config:save:result');
      this.broadcast('config:save:result', result as ConfigSaveResult);
    });

    // Configuration actuelle — événement persistant : mis en cache et rejoué
    // automatiquement à chaque nouvelle connexion (voir boucle persistentEvents ci-dessous)
    this.eventBus.on('config:current', (config: TechnicalConfig) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: config:current');
      this.persistentEvents.set('config:current', { appId: 'core', eventName: 'config:current', lastData: config });
      this.broadcast('config:current', config);
    });

    // Connexion HA / MQTT — ⭐ 24/08/2026, correctif : ces 4 événements étaient émis côté
    // eventBus interne (AppService.startHaWsClient, IntegrationBridge.updateAggregateMqttStatus)
    // mais jamais relayés vers Socket.io — aucune entrée ici ni dans les socketEvents déclarés
    // par une application. Résultat : $store.haWs.connected/$store.mqtt.connected (Sidebar,
    // indicateur tri-state) ne passaient jamais à `true`, quel que soit l'état réel de connexion
    // (constaté en conditions réelles : HA WS authentifié et une diffusion scriptsha réussie,
    // indicateur toujours orange). Persistant (comme config:current) pour qu'un client qui se
    // connecte/reconnecte APRÈS l'établissement de la connexion reçoive l'état réel, pas seulement
    // les transitions futures.
    this.eventBus.on('ha:connected', () => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: ha:connected');
      this.persistentEvents.set('ha:connected', { appId: 'core', eventName: 'ha:connected', lastData: undefined });
      this.persistentEvents.delete('ha:disconnected');
      this.broadcast('ha:connected', undefined);
    });

    this.eventBus.on('ha:disconnected', () => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: ha:disconnected');
      this.persistentEvents.set('ha:disconnected', { appId: 'core', eventName: 'ha:disconnected', lastData: undefined });
      this.persistentEvents.delete('ha:connected');
      this.broadcast('ha:disconnected', undefined);
    });

    this.eventBus.onGeneric('mqtt:connected', () => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: mqtt:connected');
      this.persistentEvents.set('mqtt:connected', { appId: 'core', eventName: 'mqtt:connected', lastData: undefined });
      this.persistentEvents.delete('mqtt:disconnected');
      this.broadcast('mqtt:connected', undefined);
    });

    this.eventBus.onGeneric('mqtt:disconnected', (data) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: mqtt:disconnected');
      const typed = data as { reason: string };
      this.persistentEvents.set('mqtt:disconnected', { appId: 'core', eventName: 'mqtt:disconnected', lastData: typed });
      this.persistentEvents.delete('mqtt:connected');
      this.broadcast('mqtt:disconnected', typed);
    });

    // Liste des modules
    this.eventBus.on('app:modules:registered', ({ modules }: { modules: ApplicationModule[] }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: app:modules:registered');
      this.modulesList = modules;
      this.broadcast('app:modules:list', { modules });
    });

    // Métadonnées UI des modules - Relay vers l'UI pour génération dynamique
    this.eventBus.onGeneric('app:module:ui:register', (data) => {
      const typedData = data as { moduleId: string; metadata: ModuleUiMetadata };
      this.logger.info('SocketBridge', `EventBus → Socket.io: app:module:ui:register pour module: ${typedData.moduleId}`);
      // Stocker les métadonnées pour les envoyer aux nouvelles connexions
      this.moduleUiMetadata[typedData.moduleId] = typedData.metadata;
      this.broadcast('app:module:ui:register', typedData);
      this.logger.info('SocketBridge', `Métadonnées UI relayées pour module: ${typedData.moduleId}, metadata: ${JSON.stringify(typedData.metadata)}`);
    });

    // Menu dynamique des applications - Relay vers l'UI (Sidebar.ts, registerCustomMenu())
    this.eventBus.onGeneric('app:menu:register', (data) => {
      const typedData = data as { appId: string; menuConfig: unknown };
      this.logger.info('SocketBridge', `EventBus → Socket.io: app:menu:register pour application: ${typedData.appId}`);
      this.customMenus[typedData.appId] = typedData.menuConfig;
      this.broadcast('app:menu:register', typedData);
    });

    // Configuration des modules - Demande de config
    this.eventBus.onGeneric('app:modules:config:get', (data) => {
      // Ce handler est déjà géré par SocketBridge dans setupSocketIOHandlers
      // pour recevoir les demandes du client et les traduire en EventBus
      // Ici on ne fait que relayer vers le client si c'est émis depuis EventBus
    });

    // Configuration des modules - Résultat réel de la sauvegarde (émis par AppService
    // une fois l'écriture effectuée, avec le succès/erreur véritable)
    this.eventBus.onGeneric('app:module:config:saved', (data) => {
      this.broadcast('app:module:config:saved', data as { moduleId: string; success: boolean; error?: string });
    });

    // Configuration des modules - Relay de la config
    // Écouter l'événement unique pour toutes les configs de modules
    this.eventBus.onGeneric('app:module:config', (data) => {
      // Relay vers le client Socket.io avec l'événement unique
      const typedData = data as { moduleId: string; config: Record<string, unknown> };
      this.broadcast('app:module:config', typedData);
    });

    // ======================================================================
    // GESTION DES ÉVÉNEMENTS SOCKET.IO DES APPLICATIONS (DYNAMIQUE)
    // ======================================================================

    // Registration dynamique des événements Socket.io des applications
    this.eventBus.on('app:socket-events:registered', (data: unknown) => {
      const typedData = data as { appId: string; socketEvents: Record<string, string>; persistentEvents?: string[] };
      this.logger.info('SocketBridge', `Événements Socket.io enregistrés pour application: ${typedData.appId}`);
      this.registerAppSocketEvents(typedData.appId, typedData.socketEvents, typedData.persistentEvents);
    });

    // ======================================================================
    // GESTION DES APPLICATIONS (NOUVEAU v4.4)
    // ======================================================================

    // Résultat de la liste des applications
    this.eventBus.on('app:applications:list:result', (data: { activated: string[]; disabled: string[] }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: app:applications:list:result');
      this.broadcast('app:applications:list:result', data);
    });

    // Résultat de l'activation d'une application
    this.eventBus.on('app:applications:enable:result', (data: { appId: string; success: boolean; error?: string }) => {
      this.logger.info('SocketBridge', `EventBus → Socket.io: app:applications:enable:result pour ${data.appId}`);
      this.broadcast('app:applications:enable:result', data);
    });

    // Résultat de la désactivation d'une application
    this.eventBus.on('app:applications:disable:result', (data: { appId: string; success: boolean; error?: string }) => {
      this.logger.info('SocketBridge', `EventBus → Socket.io: app:applications:disable:result pour ${data.appId}`);
      this.broadcast('app:applications:disable:result', data);
    });

    // Résultat de la demande de redémarrage manuel
    this.eventBus.on('app:restart:result', (data: { success: boolean; error?: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: app:restart:result');
      this.broadcast('app:restart:result', data);
    });

    // ======================================================================
    // DÉPLOIEMENT DE DIMOTIC-HA LUI-MÊME (⭐ 23/08/2026)
    // ======================================================================

    this.eventBus.on('core:deployment:targets:list', (data: { targets: { id: string; host: string }[]; isRunningInDocker: boolean; projectRoot: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:targets:list');
      this.broadcast('core:deployment:targets:list', data);
    });

    this.eventBus.on('core:deployment:remote-op:result', (data: { targetId: string; action: string; success: boolean; step?: string; error?: string; output?: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:remote-op:result');
      this.broadcast('core:deployment:remote-op:result', data);
    });

    // Ligne de progression pendant le pull-up (⭐ 24/08/2026) — pas de log par ligne (bruyant),
    // flux éphémère, jamais rejoué à la reconnexion.
    this.eventBus.on('core:deployment:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      this.broadcast('core:deployment:remote-op:progress', data);
    });

    // ======================================================================
    // DÉPLOIEMENT HOME ASSISTANT + MOSQUITTO (⭐ 24/08/2026)
    // ======================================================================

    this.eventBus.on('core:deployment:ha-stack:targets:list', (data: { targets: { id: string; host: string }[]; isRunningInDocker: boolean; projectRoot: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:ha-stack:targets:list');
      this.broadcast('core:deployment:ha-stack:targets:list', data);
    });

    this.eventBus.on('core:deployment:ha-stack:remote-op:result', (data: { targetId: string; action: string; success: boolean; step?: string; error?: string; output?: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:ha-stack:remote-op:result');
      this.broadcast('core:deployment:ha-stack:remote-op:result', data);
    });

    this.eventBus.on('core:deployment:ha-stack:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      this.broadcast('core:deployment:ha-stack:remote-op:progress', data);
    });

    // ======================================================================
    // DÉPLOIEMENT ZIGBEE2MQTT (⭐ 24/08/2026)
    // ======================================================================

    this.eventBus.on('core:deployment:zigbee2mqtt:targets:list', (data: { targets: { id: string; host: string }[]; isRunningInDocker: boolean; projectRoot: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:zigbee2mqtt:targets:list');
      this.broadcast('core:deployment:zigbee2mqtt:targets:list', data);
    });

    this.eventBus.on('core:deployment:zigbee2mqtt:remote-op:result', (data: { targetId: string; action: string; success: boolean; step?: string; error?: string; output?: string }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:deployment:zigbee2mqtt:remote-op:result');
      this.broadcast('core:deployment:zigbee2mqtt:remote-op:result', data);
    });

    this.eventBus.on('core:deployment:zigbee2mqtt:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      this.broadcast('core:deployment:zigbee2mqtt:remote-op:progress', data);
    });

    // ======================================================================
    // SERVICES POST-INSTALLATION HA (⭐ 24/08/2026)
    // ======================================================================

    this.eventBus.on('core:post-install:result', (data: { results: Array<{ kind: string; success: boolean; title?: string; error?: string }> }) => {
      this.logger.info('SocketBridge', 'EventBus → Socket.io: core:post-install:result');
      this.broadcast('core:post-install:result', data);
    });
  }

  /**
   * Configure les handlers Socket.io → EventBus
   * Les événements Socket.io sont traduits en événements EventBus
   */
  private setupSocketIOHandlers(): void {
    this.io.on('connection', (socket: any) => {
      this.sockets.add(socket);
      this.logger.info('SocketBridge', `Nouvelle connexion Socket.io : ${socket.id}`);
      
      // Envoyer la liste des modules à la nouvelle connexion
      if (this.modulesList.length > 0) {
        this.logger.info('SocketBridge', `Envoi de la liste des modules à ${socket.id}`);
        socket.emit('app:modules:list', { modules: this.modulesList });
      }
      
      // Envoyer toutes les métadonnées UI des modules à la nouvelle connexion
      for (const [moduleId, metadata] of Object.entries(this.moduleUiMetadata)) {
        this.logger.info('SocketBridge', `Envoi des métadonnées UI stockées pour ${moduleId} à ${socket.id}`);
        socket.emit('app:module:ui:register', { moduleId, metadata });
      }

      // Envoyer tous les menus dynamiques enregistrés à la nouvelle connexion
      for (const [appId, menuConfig] of Object.entries(this.customMenus)) {
        this.logger.info('SocketBridge', `Envoi du menu enregistré pour ${appId} à ${socket.id}`);
        socket.emit('app:menu:register', { appId, menuConfig });
      }

      // Envoyer les événements persistants à la nouvelle connexion
      for (const [eventName, eventData] of this.persistentEvents) {
        this.logger.info('SocketBridge', `Envoi de l'événement persistant ${eventName} à ${socket.id}`);
        socket.emit(eventName, eventData.lastData);
      }

      // Handler pour config:get
      // @ts-ignore
      socket.on('config:get', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: config:get de ${socket.id}`);
        this.eventBus.emit('config:get', undefined as void);
      });

      // Handler pour config:save
      // @ts-ignore
      socket.on('config:save', (config: TechnicalConfig) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: config:save de ${socket.id}, config: ${JSON.stringify(config)}`);
        this.eventBus.emit('config:save:requested', config);
      });

      // Handler pour config:validate
      // @ts-ignore
      socket.on('config:validate', (config: Partial<TechnicalConfig>) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: config:validate de ${socket.id}, config: ${JSON.stringify(config)}`);
        this.eventBus.emit('config:validate:requested', config);
      });

      // Handler pour logs:get
      // @ts-ignore
      socket.on('logs:get', (params: { lines: number }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: logs:get de ${socket.id}, params: ${JSON.stringify(params)}`);
        this.eventBus.emitGeneric('logs:get', params);
      });

      // Handler pour les modules
      // @ts-ignore
      socket.on('app:modules:config:get', (data: { moduleId: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:modules:config:get de ${socket.id}, data: ${JSON.stringify(data)}`);
        this.eventBus.emit('app:modules:config:get', data);
      });

      // @ts-ignore
      socket.on('app:modules:config:save', (data: { moduleId: string; config: Record<string, unknown> }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:modules:config:save de ${socket.id}, data: ${JSON.stringify(data)}`);
        console.log('[SocketBridge SERVEUR] Réception app:modules:config:save depuis socket');
        console.log('[SocketBridge SERVEUR] Données reçues:', JSON.stringify(data, null, 2));
        this.eventBus.emit('app:modules:config:save', data);
      });

      // Handler pour demander les métadonnées UI d'un module
      // @ts-ignore
      socket.on('app:module:ui:metadata:get', (data: { moduleId: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:module:ui:metadata:get de ${socket.id} pour ${data.moduleId}, data: ${JSON.stringify(data)}`);
        this.eventBus.emit('app:module:ui:metadata:get', data);
      });

      // Configuration dynamique des handlers pour les applications
      this.setupDynamicAppHandlers(socket);

      // ===========================================================================
      // GESTION DES APPLICATIONS (NOUVEAU v4.4)
      // ===========================================================================

      // @ts-ignore
      socket.on('app:applications:list', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:applications:list de ${socket.id}`);
        this.eventBus.emit('app:applications:list', undefined as void);
      });

      // @ts-ignore
      socket.on('app:applications:enable', (data: { appId: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:applications:enable de ${socket.id}, appId: ${data.appId}`);
        this.eventBus.emit('app:applications:enable', data);
      });

      // @ts-ignore
      socket.on('app:applications:disable', (data: { appId: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:applications:disable de ${socket.id}, appId: ${data.appId}`);
        this.eventBus.emit('app:applications:disable', data);
      });

      // Fenêtre de 15s après activation/désactivation (voir ApplicationManager.ts) —
      // l'utilisateur a quitté l'écran "Gestion des applications" avant la fin du compte à
      // rebours : plus la peine d'attendre, déclencher tout de suite.
      // @ts-ignore
      socket.on('app:applications:restart-now', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:applications:restart-now de ${socket.id}`);
        this.eventBus.emit('app:applications:restart-now', undefined as void);
      });

      // Handler pour la demande de redémarrage manuel (Paramètres Techniques)
      // @ts-ignore
      socket.on('app:restart', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: app:restart de ${socket.id}`);
        this.eventBus.emit('app:restart:requested', undefined as void);
      });

      // ===========================================================================
      // DÉPLOIEMENT DE DIMOTIC-HA LUI-MÊME (⭐ 23/08/2026)
      // ===========================================================================

      // @ts-ignore
      socket.on('core:deployment:targets:get', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:targets:get de ${socket.id}`);
        this.eventBus.emit('core:deployment:targets:get', undefined as void);
      });

      // @ts-ignore
      socket.on('core:deployment:target:save', (data: unknown) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:target:save de ${socket.id}`);
        this.eventBus.emit('core:deployment:target:save', data);
      });

      // @ts-ignore
      socket.on('core:deployment:target:delete', (data: { id: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:target:delete de ${socket.id}, id: ${data.id}`);
        this.eventBus.emit('core:deployment:target:delete', data);
      });

      // @ts-ignore
      socket.on('core:deployment:remote-op', (data: { targetId: string; action: string; version?: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:remote-op de ${socket.id}, ${data.targetId}/${data.action}`);
        this.eventBus.emit('core:deployment:remote-op', data);
      });

      // ===========================================================================
      // DÉPLOIEMENT HOME ASSISTANT + MOSQUITTO (⭐ 24/08/2026)
      // ===========================================================================

      // @ts-ignore
      socket.on('core:deployment:ha-stack:targets:get', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:ha-stack:targets:get de ${socket.id}`);
        this.eventBus.emit('core:deployment:ha-stack:targets:get', undefined as void);
      });

      // @ts-ignore
      socket.on('core:deployment:ha-stack:target:save', (data: unknown) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:ha-stack:target:save de ${socket.id}`);
        this.eventBus.emit('core:deployment:ha-stack:target:save', data);
      });

      // @ts-ignore
      socket.on('core:deployment:ha-stack:target:delete', (data: { id: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:ha-stack:target:delete de ${socket.id}, id: ${data.id}`);
        this.eventBus.emit('core:deployment:ha-stack:target:delete', data);
      });

      // @ts-ignore
      socket.on('core:deployment:ha-stack:remote-op', (data: { targetId: string; action: string; version?: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:ha-stack:remote-op de ${socket.id}, ${data.targetId}/${data.action}`);
        this.eventBus.emit('core:deployment:ha-stack:remote-op', data);
      });

      // ===========================================================================
      // DÉPLOIEMENT ZIGBEE2MQTT (⭐ 24/08/2026)
      // ===========================================================================

      // @ts-ignore
      socket.on('core:deployment:zigbee2mqtt:targets:get', () => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:zigbee2mqtt:targets:get de ${socket.id}`);
        this.eventBus.emit('core:deployment:zigbee2mqtt:targets:get', undefined as void);
      });

      // @ts-ignore
      socket.on('core:deployment:zigbee2mqtt:target:save', (data: unknown) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:zigbee2mqtt:target:save de ${socket.id}`);
        this.eventBus.emit('core:deployment:zigbee2mqtt:target:save', data);
      });

      // @ts-ignore
      socket.on('core:deployment:zigbee2mqtt:target:delete', (data: { id: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:zigbee2mqtt:target:delete de ${socket.id}, id: ${data.id}`);
        this.eventBus.emit('core:deployment:zigbee2mqtt:target:delete', data);
      });

      // @ts-ignore
      socket.on('core:deployment:zigbee2mqtt:remote-op', (data: { targetId: string; action: string; version?: string }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:deployment:zigbee2mqtt:remote-op de ${socket.id}, ${data.targetId}/${data.action}`);
        this.eventBus.emit('core:deployment:zigbee2mqtt:remote-op', data);
      });

      // ===========================================================================
      // SERVICES POST-INSTALLATION HA (⭐ 24/08/2026)
      // ===========================================================================

      // @ts-ignore
      socket.on('core:post-install:apply', (data: { requests: unknown[] }) => {
        this.logger.info('SocketBridge', `Socket.io → EventBus: core:post-install:apply de ${socket.id}, ${data.requests?.length ?? 0} service(s)`);
        this.eventBus.emit('core:post-install:apply', data as { requests: any[] });
      });

      // Gestion de la déconnexion
      // @ts-ignore
      socket.on('disconnect', () => {
        this.sockets.delete(socket);
        this.logger.info('SocketBridge', `Déconnexion Socket.io : ${socket.id}`);
      });

      // Gestion des erreurs
      // @ts-ignore
      socket.on('error', (error: Error) => {
        this.logger.error('SocketBridge', `Erreur Socket.io : ${error.message}`);
      });
    });
  }

  /**
   * Émet un événement à tous les clients connectés
   * @param event - Nom de l'événement
   * @param data - Payload
   */
  broadcast<K extends keyof ServerToClientEvents>(event: K, data: Parameters<ServerToClientEvents[K]>[0]): void {
    this.io.emit(event as string, data);
    this.logger.info('SocketBridge', `Broadcast ${String(event)}, data: ${JSON.stringify(data)}`);
  }

  /**
   * Enregistre les événements Socket.io pour une application
   * Stocke les événements pour configuration dynamique sur les sockets
   * @param appId - Identifiant de l'application
   * @param socketEvents - Objet contenant les événements
   * @param persistentEvents - Liste des noms d'événements à stocker et envoyer aux nouveaux clients
   */
  private registerAppSocketEvents(appId: string, socketEvents: Record<string, string>, persistentEvents?: string[]): void {
    this.logger.info('SocketBridge', `Enregistrement des événements Socket.io pour ${appId}...`);

    // Retirer les listeners d'un enregistrement précédent pour ce appId — sans ça, une application
    // dont les événements sont annoncés deux fois (ex: détection éager par AppService.detectModules()
    // PUIS Service.start() lui-même) finit avec deux listeners EventBus par événement, donc chaque
    // broadcast serveur→client part en double vers tous les clients Socket.io.
    const previousListeners = this.appSocketEventListeners.get(appId);
    if (previousListeners) {
      for (const { eventName, listener } of previousListeners) {
        this.eventBus.offGeneric(eventName, listener);
      }
    }

    // Stocker les événements pour cette application
    this.appSocketEvents.set(appId, socketEvents);

    // Handler Server→Client : EventBus.on(eventName) → socket.broadcast(eventName)
    // Configurer un handler EventBus pour chaque événement de cette application
    const newListeners: Array<{ eventName: string; listener: (data: unknown) => void }> = [];
    for (const [eventKey, eventName] of Object.entries(socketEvents)) {
      const listener = (data: unknown) => {
        this.logger.info('SocketBridge', `EventBus → Socket.io: ${eventName}`);
        this.broadcast(eventName as any, data as any);

        // Stocker la dernière valeur si c'est un événement persistant
        if (persistentEvents?.includes(eventName)) {
          this.persistentEvents.set(eventName, { appId, eventName, lastData: data });
          this.logger.debug('SocketBridge', `Événement persistant stocké: ${eventName}`);
        }
      };
      this.eventBus.onGeneric(eventName, listener);
      newListeners.push({ eventName, listener });
    }
    this.appSocketEventListeners.set(appId, newListeners);

    this.logger.info('SocketBridge', `Événements Socket.io enregistrés pour ${appId}: ${Object.keys(socketEvents).length} événements`);
  }

  /**
   * Configure les handlers Client→Server pour les applications sur un socket donné
   * @param socket - Le socket Socket.io
   */
  private setupDynamicAppHandlers(socket: any): void {
    this.logger.info('SocketBridge', `Configuration des handlers dynamiques pour socket ${socket.id}`);
    
    // Pour chaque application enregistrée
    for (const [appId, socketEvents] of this.appSocketEvents) {
      this.logger.info('SocketBridge', `Configuration des handlers pour application ${appId} sur socket ${socket.id}`);
      
      // Configurer un handler Socket.io pour chaque événement de cette application
      for (const [eventKey, eventName] of Object.entries(socketEvents)) {
        // Handler Client→Server : socket.on(eventName) → EventBus.emit(eventName)
        socket.on(eventName, (data: unknown) => {
          this.logger.info('SocketBridge', `Socket.io → EventBus: ${eventName} de ${socket.id}`);
          this.eventBus.emitGeneric(eventName, data);
        });
      }
    }
    
    this.logger.info('SocketBridge', `Handlers dynamiques configurés pour ${this.appSocketEvents.size} applications sur socket ${socket.id}`);
  }

  /**
   * Émet un événement à un socket spécifique
   * @param socketId - ID du socket cible
   * @param event - Nom de l'événement
   * @param data - Payload
   */
  emitTo(socketId: string, event: string, data: unknown): void {
    const socket = Array.from(this.sockets).find((s: any) => s.id === socketId);
    if (socket) {
      socket.emit(event, data);
      this.logger.debug('SocketBridge', `Émis ${event} à ${socketId}`);
    } else {
      this.logger.warn('SocketBridge', `Socket ${socketId} introuvable`);
    }
  }

  /**
   * Récupère le nombre de sockets connectés
   */
  getConnectedSocketsCount(): number {
    return this.sockets.size;
  }

  /**
   * Ferme proprement le SocketBridge
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close(() => {
        this.sockets.clear();
        this.logger.info('SocketBridge', 'Socket.io serveur fermé');
        resolve();
      });
    });
  }

  /**
   * Récupère l'instance Socket.io (pour les tests ou extensions)
   */
  getSocketServer(): any {
    return this.io;
  }

  /**
   * Émet un événement vers l'UI après une sauvegarde de config
   * Méthode utilitaire pour simplifier l'envoi des résultats
   * @param result - Résultat de la sauvegarde
   * @param validationResult - Résultat de la validation
   */
  emitConfigSaveResult(result: ConfigSaveResult, validationResult?: ConfigValidationResult): void {
    this.broadcast('config:saved', result);
    if (validationResult) {
      this.broadcast('config:validation:result', validationResult);
    }
  }
}
