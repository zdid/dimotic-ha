// src/presentation/server/index.ts
// Serveur Express + Socket.io
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §5 et specs-presentation-v2.0.md §3

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Server as HttpServer } from 'http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Logger } from '../../infrastructure/logger/index';
import type { SocketBridge } from '../../application/SocketBridge';
import type { EventBus } from '../../application/EventBus';

/**
 * Crée et configure le serveur Express + Socket.io
 *
 * Règles (conforme §5 specs-techniques-socle-ha-mqtt-v4.3) :
 * - Socket.io est l'UNIQUE canal de communication UI ↔ Serveur (sauf /health)
 * - /health reste en HTTP pur pour le healthcheck Docker
 * - L'UI reste accessible même si HA n'est pas configuré
 * - **Deuxième exception volontaire** (2026-07-27, demande explicite de l'utilisateur) :
 *   `POST /api/haplan/floorplans/upload` — upload d'image de plan (HAPLAN). Un transfert binaire
 *   est un problème d'une autre nature que le reste de l'appli (état/commandes) ; HTTP/multipart
 *   (`multer`) est l'outil standard pour ça, contrairement à Socket.io qui n'a pas vocation à
 *   transporter des fichiers. Voir plus bas dans `configureRoutes()`.
 */
export class PresentationServer {
  private app: Express;
  private httpServer: HttpServer;
  private socketBridge?: SocketBridge;
  private eventBus?: EventBus;
  private logger: Logger;
  private port: number;
  private projectRoot: string;

  /**
   * Crée un nouveau serveur de présentation
   * @param logger - Instance du logger
   * @param port - Port HTTP (default: 8080)
   */
  constructor(logger: Logger, port: number = 8080) {
    this.app = express();
    this.logger = logger;
    this.port = port;
    this.projectRoot = process.env.PROJECT_ROOT || path.resolve(path.join(__dirname, '../../../../..'));
    
    // Créer le serveur HTTP
    this.httpServer = this.app.listen(port, () => {
      this.logger.info('PresentationServer', `Serveur démarré sur http://localhost:${port}`);
    });

    // Configurer le middleware
    this.configureMiddleware();
    
    // Configurer les routes
    this.configureRoutes();
    
    // Gestion des erreurs
    this.configureErrorHandling();
  }



  /**
   * Configure le middleware Express
   */
  private configureMiddleware(): void {
    // Parser JSON
    this.app.use(express.json({ limit: '10mb' }));
    
    // Middleware pour ajouter .js aux imports ES modules (DOIT être avant les static)
    this.app.use('/js/ts', (req: Request, res: Response, next: NextFunction) => {
      console.log('[ES-MODULE-MIDDLEWARE] ENTREE avec path:', req.path);
      const fs = require('fs');
      const coreRoot = path.join(process.env.PROJECT_ROOT || this.projectRoot, 'applications', 'core');
      const basePath = path.resolve(coreRoot, 'dist/presentation/ui/js/ts');
      console.log('[ES-MODULE-MIDDLEWARE] basePath:', basePath);
      const filePath = basePath + req.path;
      console.log('[ES-MODULE-MIDDLEWARE] ENTREE avec complet filepath:', filePath);
      const filePathWithJs = basePath + req.path + '.js';

      // Si le fichier n'existe pas sans extension, essayer avec .js
      if (!fs.existsSync(filePath)) {
        console.log('[ES-MODULE-MIDDLEWARE] TRYING .js:', filePathWithJs);
        if (fs.existsSync(filePathWithJs)) {
          console.log('[ES-MODULE-MIDDLEWARE] RETOURNE:', filePathWithJs);
          return res.sendFile(filePathWithJs);
        } else {
          console.log('[ES-MODULE-MIDDLEWARE] NOT FOUND:', filePathWithJs);
        }
      } else {
        console.log('[ES-MODULE-MIDDLEWARE] RETOURNE:', filePath);
        return res.sendFile(filePath);
      }
      
      console.log('[ES-MODULE-MIDDLEWARE] NOT FOUND:', req.path);
      next();
    });
    
    // Parser URL-encoded
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Servir les fichiers statiques (UI)
    // D'abord essayer dist/presentation/ui/, puis src/presentation/ui/
    const coreRoot = path.join(process.env.PROJECT_ROOT || this.projectRoot, 'applications', 'core');
    this.app.use(express.static(path.join(coreRoot, 'dist/presentation/ui')));
    this.app.use(express.static(path.join(coreRoot, 'src/presentation/ui')));
    
    // Servir les images depuis /images
    this.app.use('/images', express.static(path.join(coreRoot, 'dist/presentation/ui')));
    this.app.use('/images', express.static(path.join(coreRoot, 'src/presentation/ui')));
    
    // Servir les styles communs depuis /styles
    // D'abord essayer dist/presentation/general/styles/, puis src/presentation/general/styles/
    this.app.use('/styles', express.static(path.join(coreRoot, 'dist/presentation/general/styles')));
    this.app.use('/styles', express.static(path.join(coreRoot, 'src/presentation/general/styles')));
    
    // Servir les styles spécifiques UI depuis /styles
    this.app.use('/styles', express.static(path.join(coreRoot, 'dist/presentation/ui/styles')));
    this.app.use('/styles', express.static(path.join(coreRoot, 'src/presentation/ui/styles')));
    
    // Servir les assets des applications : /applications/{appId}/* correspond à
    // applications/{appId}/dist/* (prioritaire) puis applications/{appId}/src/* (fallback dev).
    // Chaque application est autonome avec son propre dist/src (voir CLAUDE.md). Le segment
    // "presentation/" fait partie du chemin demandé lui-même (ex: /applications/nommage/presentation/
    // index.html), pas de la racine de mapping — conforme à ModuleContainer.ts et presentation_specs
    // §4.3. Remplace l'ancien mapping vers un inexistant dist/applications racine et l'ancien
    // raccourci /nommage codé en dur avec un chemin src/applications/nommage/... qui n'existe plus.
    this.app.use('/applications/:appId', (req: Request, res: Response, next: NextFunction) => {
      const fs = require('fs');
      if (!req.params.appId) return next();
      const appsRoot = path.join(process.env.PROJECT_ROOT || this.projectRoot, 'applications', req.params.appId);
      const distPath = path.join(appsRoot, 'dist', req.path);
      // Les apps métier (evoo7/rfxcom/nommage) compilent avec rootDir=".." (pour inclure les
      // fichiers core/src référencés) : la sortie est imbriquée sous dist/{appId}/src/... au lieu
      // de dist/... à plat — sans ce candidat, tout .js compilé de ces apps répond 404.
      const distNestedPath = path.join(appsRoot, 'dist', req.params.appId, 'src', req.path);
      const srcPath = path.join(appsRoot, 'src', req.path);

      // Les imports ES modules sans extension (ex: "./socket-events") sont valides en
      // TypeScript mais un navigateur exige le nom de fichier exact — sans ce complément .js,
      // ces imports répondent 404 (même logique déjà appliquée à /js/ts pour le core).
      const candidates = [distPath, distNestedPath, srcPath].flatMap((p) => [p, `${p}.js`]);

      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return res.sendFile(candidate);
        }
      }
      next();
    });

    // Sert les images de plan HAPLAN depuis data/haplan/images/ (lecture seule) — établit la
    // convention /data/{app}/... pour du contenu utilisateur écrit dans data/, distinct de
    // /applications/{appId}/... ci-dessus qui ne sert jamais que dist/src (code, jamais
    // writable). À généraliser proprement si une autre app en a besoin.
    this.app.use('/data/haplan/images', express.static(
      path.join(process.env.PROJECT_ROOT || this.projectRoot, 'data', 'haplan', 'images')
    ));

    // CORS - À configurer pour la production
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    this.logger.debug('PresentationServer', 'Middleware configuré');
  }

  /**
   * Configure les routes
   */
  private configureRoutes(): void {
    // Route /health - HTTP pur (conforme §5 specs-techniques-socle-ha-mqtt-v4.3)
    this.app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Upload d'image de plan HAPLAN — voir le commentaire de tête de cette classe (deuxième
    // exception volontaire à "tout par Socket.io"). memoryStorage : on écrit nous-mêmes le
    // fichier final (nom sanitisé côté HaplanService), pas besoin d'un fichier temporaire sur
    // disque. Réponse HTTP = accusé de réception uniquement (fire-and-forget, comme le reste du
    // projet) — le résultat réel (créé ou HAPLAN_SAVE_FAILED) arrive via Socket.io
    // (haplan:floorplans:list / haplan:error), pas dans cette réponse.
    const haplanUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`Type de fichier non supporté: ${file.mimetype}`));
      }
    });

    this.app.post('/api/haplan/floorplans/upload', (req: Request, res: Response) => {
      haplanUpload.single('image')(req, res, (err: unknown) => {
        if (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(415).json({ error: 'Unsupported Media Type', message });
          return;
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        const floorplanId = req.body?.floorplanId;
        if (!file || !floorplanId) {
          res.status(400).json({ error: 'Bad Request', message: 'Champs "image" et "floorplanId" requis' });
          return;
        }
        if (!this.eventBus) {
          res.status(503).json({ error: 'Service Unavailable', message: 'EventBus non initialisé' });
          return;
        }

        this.eventBus.emitGeneric('haplan:internal:floorplan:create', {
          floorplanId,
          imageBuffer: file.buffer,
          imageMimeType: file.mimetype
        });
        res.status(200).json({ success: true });
      });
    });

    // Route racine - Redirige vers index.html pour une SPA
    this.app.get('/', (req: Request, res: Response) => {
      const coreRoot = path.join(process.env.PROJECT_ROOT || this.projectRoot, 'applications', 'core');
      const distPath = path.join(coreRoot, 'dist/presentation/ui');
      const srcPath = path.join(coreRoot, 'src/presentation/ui');

      res.sendFile('index.html', {
        root: distPath,
      }, (err) => {
        if (err) {
          res.sendFile('index.html', {
            root: srcPath,
          });
        }
      });
    });

    // Route pour Alpine.js (si utilisé via CDN)
    // Sinon, Alpine.js est importé via npm et bundlé
    this.app.get('/alpine', (req: Request, res: Response) => {
      res.redirect('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min');
    });

    // Route pour Socket.io client
    this.app.get('/socket.io', (req: Request, res: Response) => {
      res.redirect('https://cdn.socket.io/4.5.4/socket.io.min');
    });

    this.logger.debug('PresentationServer', 'Routes configurées');
  }

  /**
   * Configure la gestion des erreurs
   */
  private configureErrorHandling(): void {
    // 404 Not Found
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} non trouvée`,
      });
    });

    // 500 Internal Server Error
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      this.logger.error('PresentationServer', `Erreur interne: ${err.message}`);
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      });
    });

    this.logger.debug('PresentationServer', 'Gestion des erreurs configurée');
  }

  /**
   * Attache le SocketBridge au serveur
   * Doit être appelé APRES la création de l'EventBus et du Logger
   * @param socketBridge - Instance de SocketBridge
   */
  attachSocketBridge(socketBridge: SocketBridge): void {
    this.socketBridge = socketBridge;
    this.logger.info('PresentationServer', 'SocketBridge attaché');
  }

  /**
   * Attache l'EventBus — nécessaire pour la route d'upload HAPLAN (POST /api/haplan/floorplans/
   * upload), seule route de ce serveur qui déclenche une action métier applicative.
   * Doit être appelé APRES la création de l'EventBus.
   */
  attachEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    this.logger.info('PresentationServer', 'EventBus attaché');
  }

  /**
   * Récupère le serveur HTTP
   */
  getHttpServer(): HttpServer {
    return this.httpServer;
  }

  /**
   * Récupère l'application Express
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Récupère le SocketBridge
   */
  getSocketBridge(): SocketBridge | undefined {
    return this.socketBridge;
  }

  private isClosing = false;

  /**
   * Ferme proprement le serveur
   */
  async close(): Promise<void> {
    if (this.isClosing) {
      return; // Déjà en cours de fermeture
    }
    this.isClosing = true;
    
    return new Promise((resolve, reject) => {
      if (this.socketBridge) {
        this.socketBridge.close().then(() => {
          this.httpServer.close((err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
              this.logger.error('PresentationServer', `Erreur lors de la fermeture: ${err.message}`);
              reject(err);
            } else {
              this.logger.info('PresentationServer', 'Serveur fermé');
              resolve();
            }
          });
        }).catch(reject);
      } else {
        this.httpServer.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            this.logger.error('PresentationServer', `Erreur lors de la fermeture: ${err.message}`);
            reject(err);
          } else {
            this.logger.info('PresentationServer', 'Serveur fermé');
            resolve();
          }
        });
      }
    });
  }

  /**
   * Vérifie si le serveur est en cours d'exécution
   */
  isRunning(): boolean {
    return this.httpServer.listening;
  }

  /**
   * Récupère le port du serveur
   */
  getPort(): number {
    return this.port;
  }
}

// Export du singleton pour compatibilité (optionnel)
let globalServer: PresentationServer | null = null;

export function getPresentationServer(logger: Logger, port?: number): PresentationServer {
  if (!globalServer) {
    globalServer = new PresentationServer(logger, port);
  }
  return globalServer;
}

export function resetPresentationServer(): void {
  if (globalServer) {
    globalServer.close().catch(() => {});
    globalServer = null;
  }
}
