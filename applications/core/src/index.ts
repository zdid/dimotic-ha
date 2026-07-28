// src/index.ts
// Point d'entrée principal de l'application
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §10 et specs-presentation-v2.0.md

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import * as path from 'node:path';

// =============================================================================
// Initialisation globale - Trouver la racine du projet
// =============================================================================

/**
 * Trouve la racine du projet en remontant jusqu'à trouver le répertoire 'applications'
 */
function findProjectRoot(): string {
  let currentDir = path.resolve(__dirname);
  
  // Remonter jusqu'à trouver le répertoire 'applications'
  while (currentDir.length > 1) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // On a atteint la racine du filesystem
    
    const dirName = path.basename(currentDir);
    if (dirName === 'applications') {
      return parentDir; // La racine du projet est le parent de 'applications'
    }
    currentDir = parentDir;
  }
  
  // Fallback : utiliser le calcul par défaut depuis __dirname
  return path.resolve(path.join(__dirname, '../../../'));
}

// Définir la racine du projet une fois pour toute l'application
if (!process.env.PROJECT_ROOT) {
  process.env.PROJECT_ROOT = findProjectRoot();
}

import type { Server as HttpServer } from 'node:http';

// Import des services d'infrastructure
import { Logger, createLogger } from './infrastructure/logger/index';
import { ConfigService } from './infrastructure/config/ConfigService';
import { ConfigLoader } from './infrastructure/config/loader';
import { ConfigWriter } from './infrastructure/config/writer';
import { configSchema } from './infrastructure/config/schema';

// Import des services applicatifs
import { EventBus } from './application/EventBus';
import { RestartManager } from './application/RestartManager';
import { SocketBridge } from './application/SocketBridge';
import { AppService } from './application/AppService';

// Import du serveur de présentation
import { PresentationServer } from './presentation/server/index';

// Import de la porte d'authentification OAuth2 HA (accès externe)
import { AuthService } from './infrastructure/auth/AuthService';

// Import des clients HA (si disponibles)
import type { HaWsClient } from './ha/sync/HaWsClient';
import type { HaStructureRegistry } from './ha/sync/HaStructureRegistry';
import type { IntegrationBridge } from './ha/integration/IntegrationBridge';

// =============================================================================
// Bootstrap de l'application
// =============================================================================

/**
 * Classe Bootstrap - Gère l'initialisation et le cycle de vie de l'application
 * 
 * **Responsabilités :**
 * - Création et injection des dépendances
 * - Gestion du cycle de vie (start, stop)
 * - Arrêt propre (SIGTERM, SIGINT)
 */
class ApplicationBootstrap {
  private httpServer?: HttpServer;
  private logger?: Logger;
  private configService?: ConfigService;
  private eventBus?: EventBus;
  private restartManager?: RestartManager;
  private presentationServer?: PresentationServer;
  private socketBridge?: SocketBridge;
  private authService?: AuthService;
  private appService?: AppService;
  private haWsClient?: HaWsClient;
  private haStructureRegistry?: HaStructureRegistry;
  private integrationBridge?: IntegrationBridge;

  /**
   * Initialise toutes les dépendances
   */
  private initializeDependencies(): void {
    // 1. Créer le logger (avec configuration par défaut)
    const loggerConfig = {
      level: 'info' as const,
      maxSizeMb: 10,
      maxFiles: 5,
      logDir: process.env.LOG_DIR || '/app/logs',
    };
    this.logger = createLogger(loggerConfig);

    // 2. Créer les services de configuration
    // Les paths de config peuvent être personnalisés via variables d'environnement.
    // dataRoot = data/ (un sous-répertoire par application, chacun son propre config.yaml) ;
    // configPath = le config.yaml du socle (ha/web/logging), sous data/core/ par convention.
    const dataRoot = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data');
    const configPath = process.env.CONFIG_PATH || path.join(dataRoot, 'core', 'config.yaml');
    const configLoader = new ConfigLoader(configPath, configSchema, dataRoot);
    const configWriter = new ConfigWriter(configPath, configSchema, '.tmp', dataRoot);
    this.configService = new ConfigService(configLoader, configWriter, this.logger);

    // Le logger est créé avant la config (ci-dessus) avec un niveau par défaut 'info' — le
    // synchroniser immédiatement avec logging.level une fois la config disponible, sans
    // attendre une sauvegarde/config:reload pour que le niveau réel du fichier s'applique.
    const initialLoggingLevel = this.configService.getConfig().logging?.level;
    if (initialLoggingLevel) {
      this.logger.setLevel(initialLoggingLevel as 'debug' | 'info' | 'warn' | 'error');
    }

    // 3. Créer l'EventBus
    this.eventBus = new EventBus();

    // 4. Créer le RestartManager
    this.restartManager = new RestartManager(this.logger);

    this.logger.info('Bootstrap', 'Dépendances initialisées');
  }

  /**
   * Initialise le serveur HTTP et Socket.io
   */
  private initializeServer(): void {
    // Récupérer le port depuis la config ou utiliser le port par défaut
    const config = this.configService?.getConfig();
    const port = config?.web?.port || 8080;
    const host = config?.web?.host || '0.0.0.0';

    // Porte d'authentification OAuth2 HA — instance unique partagée avec SocketBridge (même
    // secret/config, pas de duplication de la logique de vérification). Inerte si
    // web.auth.enabled est absent/false (cas du déploiement interne actuel).
    if (this.logger) {
      this.authService = new AuthService(config?.web?.auth, this.logger);
    }

    // Créer le serveur de présentation
    if (this.logger) {
      this.presentationServer = new PresentationServer(this.logger, port, this.authService);
      // Récupérer le serveur HTTP du PresentationServer
      this.httpServer = this.presentationServer.getHttpServer();
      this.logger.info('Bootstrap', `Serveur de présentation initialisé sur ${host}:${port}`);
    }
  }

  /**
   * Initialise le SocketBridge
   */
  private initializeSocketBridge(): void {
    if (!this.httpServer || !this.eventBus || !this.logger) {
      throw new Error('Bootstrap: Dépendances manquantes pour SocketBridge');
    }

    this.socketBridge = new SocketBridge(this.httpServer, this.eventBus, this.logger, this.authService);

    // Attacher le SocketBridge au serveur de présentation
    if (this.presentationServer) {
      this.presentationServer.attachSocketBridge(this.socketBridge);
      this.presentationServer.attachEventBus(this.eventBus);
    }

    this.logger.info('Bootstrap', 'SocketBridge initialisé');
  }

  /**
   * Initialise les composants HA (si configuré)
   */
  private async initializeHaComponents(): Promise<void> {
    if (!this.configService || !this.logger || !this.eventBus) {
      throw new Error('Bootstrap: Dépendances manquantes pour HA');
    }

    const config = this.configService.getConfig();

    // Vérifier si HA WS est activé
    if (config.ha?.ws_enable === true && config.ha?.ws?.host && config.ha?.ws?.token) {
      try {
        // Importer dynamiquement pour éviter les erreurs si non disponible
        const haModule = await import('./ha/sync/HaWsClient');
        this.haWsClient = new haModule.HaWsClient(
          config.ha.ws,
          this.logger
        );

        const haClassifierModule = await import('./ha/sync/TaxonomyHaClassifier');
        const haClassifier = new haClassifierModule.TaxonomyHaClassifier();
        
        const haRegistryModule = await import('./ha/sync/HaStructureRegistry');
        this.haStructureRegistry = new haRegistryModule.HaStructureRegistry(
          haClassifier,
          {
            includeUnassigned: config.ha.structure.include_unassigned,
            unassignedLabel: config.ha.structure.unassigned_label,
          },
          this.logger
        );

        this.logger.info('Bootstrap', 'Composants HA WebSocket initialisés');
      } catch (error) {
        this.logger?.warn('Bootstrap', `Échec de l'initialisation HA WebSocket: ${error}`);
        // HA est optionnel, continuer sans
      }
    }

    // IntegrationBridge est toujours instancié : il gère lui-même l'activation/désactivation
    // dynamique via ha.mqtt_enable (voir IntegrationBridge.handleConfigSaveResult), et les
    // bridges ne se connectent qu'à l'enregistrement d'un module d'intégration.
    try {
      const bridgeModule = await import('./ha/integration/IntegrationBridge');
      this.integrationBridge = new bridgeModule.IntegrationBridge(this.eventBus, this.logger, this.configService);
      this.integrationBridge.initialize();
      this.logger.info('Bootstrap', 'IntegrationBridge initialisé');
    } catch (error) {
      this.logger?.warn('Bootstrap', `Échec de l'initialisation d'IntegrationBridge: ${error}`);
    }

    // Si au moins un composant HA est initialisé
    if (this.haWsClient || this.haStructureRegistry) {
      this.logger.info('Bootstrap', 'Composants HA initialisés');
    }
  }

  /**
   * Initialise l'AppService
   */
  private initializeAppService(): void {
    if (!this.eventBus || !this.configService || !this.socketBridge || 
        !this.restartManager || !this.logger) {
      throw new Error('Bootstrap: Dépendances manquantes pour AppService');
    }

    this.appService = new AppService(
      this.eventBus,
      this.configService,
      this.socketBridge,
      this.restartManager,
      this.logger,
      this.haWsClient,
      this.haStructureRegistry
    );

    this.logger.info('Bootstrap', 'AppService initialisé');
  }

  /**
   * Démarre l'application
   */
  async start(): Promise<void> {
    this.logger?.info('Bootstrap', 'Démarrage de l\'application...');

    // Initialiser dans l'ordre correct
    this.initializeDependencies();
    this.initializeServer();
    this.initializeSocketBridge();
    await this.initializeHaComponents();
    this.initializeAppService();

    // Démarrer l'AppService
    if (this.appService) {
      await this.appService.start();
    }

    // Configurer la détection des modules (déjà fait par AppService)
    // et émettre l'événement de démarrage
    this.eventBus?.emit('app:started', {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });

    this.logger?.info('Bootstrap', 'Application démarrée avec succès');
  }

  /**
   * Arrête l'application proprement
   */
  async stop(): Promise<void> {
    this.logger?.info('Bootstrap', 'Arrêt de l\'application...');

    // Arrêter dans l'ordre inverse
    if (this.appService) {
      // L'AppService gère l'arrêt des services HA
    }

    // Note: socketBridge.close() est appelé par presentationServer.close()
    // et httpServer.close() est aussi appelé par presentationServer.close()
    // Donc on n'appelle que presentationServer.close()
    if (this.presentationServer) {
      await this.presentationServer.close();
    }

    this.logger?.info('Bootstrap', 'Application arrêtée');
  }
}

// =============================================================================
// Gestion des signaux et démarrage
// =============================================================================

/**
 * Instance globale du bootstrap (pour la gestion des signaux)
 */
const bootstrap = new ApplicationBootstrap();

/**
 * Gestionnaire de signaux pour un arrêt propre
 */
function setupSignalHandlers(): void {
  const signals = ['SIGTERM', 'SIGINT'];

  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n${signal} reçu. Arrêt en cours...`);
      try {
        await bootstrap.stop();
        process.exit(0);
      } catch (error) {
        console.error('Erreur lors de l\'arrêt:', error);
        process.exit(1);
      }
    });
  }

  // Gestion de l'erreur non capturée
  process.on('uncaughtException', (error: Error) => {
    console.error('Uncaught Exception:', error);
    bootstrap.stop().then(() => process.exit(1)).catch(() => process.exit(1));
  });

  // Gestion de la promesse rejetée non capturée
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

// =============================================================================
// Point d'entrée principal
// =============================================================================

async function main(): Promise<void> {
  // Configurer les gestionnaires de signaux
  setupSignalHandlers();

  try {
    // Démarrer l'application
    await bootstrap.start();
  } catch (error) {
    console.error('Erreur lors du démarrage:', error);
    process.exit(1);
  }
}

// Démarrer l'application
main().catch((error) => {
  console.error('Erreur fatale:', error);
  process.exit(1);
});

// Export pour les tests
export { bootstrap, ApplicationBootstrap };
