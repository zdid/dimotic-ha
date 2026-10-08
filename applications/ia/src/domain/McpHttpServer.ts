/**
 * Serveur MCP (Model Context Protocol) pour Claude Code — specs ia v1.15 §19.
 *
 * Expose à Claude Code EXACTEMENT les outils donnés à Mistral (tools.ts : lister_entites,
 * obtenir_etat, executer_action), exécutés par le même ToolExecutor — mêmes résolutions quoi/lieux,
 * même passage par planificateur pour les actions. Aucun outil supplémentaire.
 *
 * Transport « Streamable HTTP » simplifié et sans état : POST /mcp, une requête JSON-RPC 2.0 →
 * une réponse JSON. Pas de session, pas de flux SSE (aucune notification serveur à pousser).
 * Méthodes : initialize, notifications/initialized, ping, tools/list, tools/call.
 *
 * Sécurité : jeton Bearer OBLIGATOIRE (le serveur ne démarre pas sans), comparaison à temps
 * constant, chaque appel d'outil journalisé (nom + arguments, jamais le jeton).
 */

import express, { type Request, type Response } from 'express';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../../core/dist/exports';
import { IA_TOOLS } from './tools';

export type McpToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'dimotic-ha', version: '1.0.0' };
const INSTRUCTIONS =
  "Accès à la maison (Home Assistant) via dimotic-ha. Vocabulaire QUOI/OÙ : `quoi` est une catégorie " +
  "(ex: lumière, volet, température), `lieux` une liste de lieux (ex: [\"salon\"]). Utiliser lister_entites " +
  "ou obtenir_etat avant executer_action pour vérifier que la cible existe : executer_action agit réellement " +
  "sur la maison.";

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

  constructor(
    private readonly host: string,
    private readonly port: number,
    token: string,
    private readonly logger: Logger,
    private readonly onToolCall: McpToolHandler
  ) {
    this.expectedToken = sha(token);
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
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS
          }));
          return;
        }
        case 'ping':
          res.json(rpcResult(id, {}));
          return;
        case 'tools/list':
          res.json(rpcResult(id, {
            tools: IA_TOOLS.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              inputSchema: t.function.parameters
            }))
          }));
          return;
        case 'tools/call': {
          const name = String(message.params?.name ?? '');
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
          if (!IA_TOOLS.some((t) => t.function.name === name)) {
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
