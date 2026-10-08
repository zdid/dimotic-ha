/**
 * Serveur MCP (Model Context Protocol) pour Claude Code — specs ia v1.15 §19.
 *
 * Expose à Claude Code les outils donnés à Mistral (tools.ts : lister_entites, obtenir_etat,
 * executer_action — mêmes résolutions quoi/lieux, même passage par planificateur pour les actions)
 * plus des outils de LECTURE propres à Claude Code (McpTools.ts), et lui transmet à la connexion
 * la même vision que Mistral : catalogue quoi/lieux/macros dans les « instructions » du serveur,
 * règles et catalogue en « ressources ».
 *
 * Transport « Streamable HTTP » simplifié et sans état : POST /mcp, une requête JSON-RPC 2.0 →
 * une réponse JSON. Pas de session, pas de flux SSE (aucune notification serveur à pousser).
 * Méthodes : initialize, notifications/initialized, ping, tools/list, tools/call, resources/list,
 * resources/read.
 *
 * Sécurité : jeton Bearer OBLIGATOIRE (le serveur ne démarre pas sans), comparaison à temps
 * constant, chaque appel d'outil journalisé (nom + arguments, jamais le jeton).
 */

import express, { type Request, type Response } from 'express';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../../core/dist/exports';

export type McpToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpServerOptions {
  host: string;
  port: number;
  token: string;
  logger: Logger;
  tools: McpToolDef[];
  onToolCall: McpToolHandler;
  /** Texte d'instructions renvoyé à `initialize` — recalculé à chaque connexion (catalogue à jour). */
  getInstructions: () => string;
  resources: McpResourceDef[];
  /** Contenu d'une ressource, ou undefined si inconnue. */
  readResource: (uri: string) => string | undefined;
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'dimotic-ha', version: '1.0.0' };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

export class McpHttpServer {
  private readonly app = express();
  private server?: http.Server;
  private readonly expectedToken: Buffer;

  private readonly host: string;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly tools: McpToolDef[];
  private readonly onToolCall: McpToolHandler;
  private readonly getInstructions: () => string;
  private readonly resources: McpResourceDef[];
  private readonly readResource: (uri: string) => string | undefined;

  constructor(options: McpServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.logger = options.logger;
    this.tools = options.tools;
    this.onToolCall = options.onToolCall;
    this.getInstructions = options.getInstructions;
    this.resources = options.resources;
    this.readResource = options.readResource;
    this.expectedToken = sha(options.token);
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '256kb' }));
    this.app.post('/mcp', (req, res) => void this.handle(req, res));
    // Pas de flux serveur→client : GET/DELETE non pris en charge (autorisé par la spec).
    this.app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  }

  start(): void {
    this.server = this.app.listen(this.port, this.host, () => {
      this.logger.info('McpHttpServer', `Serveur MCP à l'écoute sur http://${this.host}:${this.port}/mcp (jeton requis)`);
    });
    this.server.on('error', (error) => this.logger.error('McpHttpServer', `Erreur serveur MCP: ${error}`));
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private authorized(req: Request): boolean {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    return timingSafeEqual(sha(match[1].trim()), this.expectedToken);
  }

  private async handle(req: Request, res: Response): Promise<void> {
    if (!this.authorized(req)) {
      this.logger.warn('McpHttpServer', `Accès refusé (jeton absent ou invalide) depuis ${req.ip}`);
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
      return;
    }

    const message = req.body as JsonRpcRequest | undefined;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      res.status(400).json(rpcError(null, -32600, 'Requête JSON-RPC invalide'));
      return;
    }

    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) {
      res.status(202).end(); // notifications/initialized, notifications/cancelled... : rien à répondre
      return;
    }
    const id = message.id as string | number;

    try {
      switch (message.method) {
        case 'initialize': {
          const asked = String(message.params?.protocolVersion ?? '');
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
          res.json(rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
            serverInfo: SERVER_INFO,
            instructions: this.getInstructions()
          }));
          return;
        }
        case 'ping':
          res.json(rpcResult(id, {}));
          return;
        case 'tools/list':
          res.json(rpcResult(id, {
            tools: this.tools
          }));
          return;
        case 'resources/list':
          res.json(rpcResult(id, { resources: this.resources }));
          return;
        case 'resources/read': {
          const uri = String(message.params?.uri ?? '');
          const text = this.resources.some((r) => r.uri === uri) ? this.readResource(uri) : undefined;
          if (text === undefined) {
            res.json(rpcError(id, -32002, `Ressource inconnue : ${uri}`));
            return;
          }
          const mimeType = this.resources.find((r) => r.uri === uri)?.mimeType ?? 'text/plain';
          res.json(rpcResult(id, { contents: [{ uri, mimeType, text }] }));
          return;
        }
        case 'tools/call': {
          const name = String(message.params?.name ?? '');
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
          if (!this.tools.some((t) => t.name === name)) {
            res.json(rpcError(id, -32602, `Outil inconnu : ${name}`));
            return;
          }
          this.logger.info('McpHttpServer', `Claude Code → ${name} ${JSON.stringify(args)}`);
          try {
            const text = await this.onToolCall(name, args);
            res.json(rpcResult(id, { content: [{ type: 'text', text }] }));
          } catch (error) {
            this.logger.error('McpHttpServer', `Échec de ${name}: ${error}`);
            res.json(rpcResult(id, { content: [{ type: 'text', text: `Erreur : ${error instanceof Error ? error.message : error}` }], isError: true }));
          }
          return;
        }
        default:
          res.json(rpcError(id, -32601, `Méthode non prise en charge : ${message.method}`));
      }
    } catch (error) {
      this.logger.error('McpHttpServer', `Erreur MCP: ${error}`);
      res.json(rpcError(id, -32603, 'Erreur interne'));
    }
  }
}

function rpcResult(id: string | number, result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
