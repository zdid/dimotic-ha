/**
 * Serveur HTTP dédié émulant le protocole Ollama (specs §2) — port propre (11434 par défaut),
 * indépendant du port web du socle. Pattern PushReceiver (applications/arexx) : Express +
 * http.createServer géré directement par le module métier.
 */

import express, { type Express, type Request, type Response } from 'express';
import http from 'node:http';
import type { Logger } from '../../../core/dist/exports';
import type { IaConfig } from './config-schema';
import type { OllamaChatRequestBody } from './types';

export type ChatHandler = (body: OllamaChatRequestBody, res: Response) => Promise<void>;

const MODEL_DETAILS = {
  parent_model: '',
  format: 'gguf',
  family: 'mistral',
  families: ['mistral'],
  parameter_size: '7B',
  quantization_level: 'Q4_0'
};

export class OllamaHttpServer {
  private app: Express;
  private server?: http.Server;

  constructor(
    private readonly config: IaConfig,
    private readonly logger: Logger,
    private readonly onChat: ChatHandler
  ) {
    this.app = express();
    this.app.use(express.json({ limit: '5mb' }));
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.get('/', (_req, res) => res.json({ version: '0.5.1' }));
    this.app.get('/api/version', (_req, res) => res.json({ version: '0.5.1' }));

    this.app.get('/api/tags', (_req, res) => {
      const models = Object.keys(this.config.modelMap).map((name) => ({
        name,
        model: name,
        modified_at: '2024-06-01T00:00:00Z',
        size: 4_113_000_000,
        digest: `sha256:sim-${name.replace(/[:/]/g, '-')}`,
        details: MODEL_DETAILS
      }));
      res.json({ models });
    });

    this.app.post('/api/show', (req: Request, res: Response) => {
      const model = req.body?.model || 'mistral';
      res.json({
        modelfile: `FROM ${model}\nSYSTEM You are a helpful assistant.`,
        parameters: 'temperature 0.7',
        template: '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}',
        details: MODEL_DETAILS
      });
    });

    // Route principale (specs §2)
    this.app.post('/api/chat', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('X-Accel-Buffering', 'no'); // specs §4 — anti-buffering
      this.onChat(req.body as OllamaChatRequestBody, res).catch((error) => {
        this.logger.error('OllamaHttpServer', `Erreur /api/chat: ${error}`);
        if (!res.headersSent) res.status(500);
        res.end();
      });
    });

    // Ancien format Ollama — réconcilié vers /api/chat (specs §4, troisième piège)
    this.app.post('/api/generate', (req: Request, res: Response) => {
      const body = req.body as OllamaChatRequestBody;
      if (!body.messages) body.messages = [];
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('X-Accel-Buffering', 'no');
      this.onChat(body, res).catch((error) => {
        this.logger.error('OllamaHttpServer', `Erreur /api/generate: ${error}`);
        if (!res.headersSent) res.status(500);
        res.end();
      });
    });

    this.app.post('/api/embeddings', (req: Request, res: Response) => {
      res.json({ model: req.body?.model || 'mistral', embedding: new Array(4096).fill(0) });
    });

    this.app.get('/api/ps', (_req, res) => res.json({ models: [] }));
    this.app.delete('/api/delete', (_req, res) => res.json({ status: 'ok' }));
    this.app.post('/api/pull', (req: Request, res: Response) => res.json({ status: 'success', model: req.body?.model }));
  }

  start(): void {
    const port = this.config.ollamaHttpPort;
    this.server = http.createServer(this.app).listen(port, () => {
      this.logger.info('OllamaHttpServer', `Serveur Ollama émulé en écoute sur le port ${port}`);
    });
  }

  stop(): void {
    this.server?.close();
  }
}
