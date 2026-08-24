/**
 * HaPostInstallService — automatise l'ajout des intégrations "services post-installation" (MQTT,
 * Whisper, Piper, openWakeWord, Ollama + son agent de conversation) sur la HA actuellement
 * connectée via `ha.ws` (⭐ 24/08/2026, demande explicite).
 *
 * Agit TOUJOURS sur la HA déjà connectée par ce socle (mêmes host/port/token que HaWsClient) —
 * jamais sur une HA distante différente ni via un token dédié par cible. Flux découvert et vérifié
 * manuellement en conditions réelles contre une vraie instance HA (24/08/2026) avant d'écrire ce
 * code, plutôt que deviné depuis la documentation :
 *   - Wyoming (Whisper/Piper/openWakeWord), REST authentifié par le token HA WS :
 *       POST /api/config/config_entries/flow                {handler: 'wyoming'}
 *       POST /api/config/config_entries/flow/{flow_id}       {host, port}
 *   - Ollama (connexion de base), même patron, handler 'ollama' :
 *       POST /api/config/config_entries/flow                {handler: 'ollama'}
 *       POST /api/config/config_entries/flow/{flow_id}       {url, api_key?}
 *   - Agent de conversation Ollama — une SOUS-ENTRÉE séparée, pas la connexion de base elle-même
 *     (sans quoi l'agent n'apparaît jamais dans la liste "Agent de conversation" d'un pipeline
 *     Assist, vérifié en direct) :
 *       POST /api/config/config_entries/subentries/flow              {handler: 'conversation', entry_id}
 *       POST /api/config/config_entries/subentries/flow/{flow_id}    {name, model, ...}
 *   - MQTT : schéma REST identique (`config_entries/flow`, handler 'mqtt'), non revérifié en
 *     direct (risque jugé trop élevé de perturber la HA de production existante de l'utilisateur,
 *     86 appareils réels dessus) — ce flux est stable et documenté depuis des années dans HA,
 *     contrairement à Wyoming/Ollama plus récents.
 *
 * La case "Contrôler Home Assistant" (Assist) de l'agent de conversation est délibérément laissée
 * décochée (comportement par défaut du formulaire, jamais cochée ici) — le contrôle réel de la
 * maison par l'IA passe par le mécanisme interne de l'app `ia`/`planificateur`, pas par l'API
 * Assist exposée aux entités HA (clarifié avec l'utilisateur, 24/08/2026) : cocher cette case ne
 * changerait rien au périmètre réel de contrôle, seulement une confusion inutile côté HA.
 */

import type { ConfigService } from '../infrastructure/config/ConfigService';
import type { Logger } from '../infrastructure/logger';

export type PostInstallServiceKind = 'mqtt' | 'whisper' | 'piper' | 'wakeword' | 'ollama';

export interface PostInstallRequest {
  kind: PostInstallServiceKind;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  url?: string;
  model?: string;
}

export interface PostInstallResult {
  kind: PostInstallServiceKind;
  success: boolean;
  title?: string;
  error?: string;
}

const WYOMING_HANDLER: Record<'whisper' | 'piper' | 'wakeword', 'wyoming'> = {
  whisper: 'wyoming',
  piper: 'wyoming',
  wakeword: 'wyoming'
};

interface FlowInitResponse {
  flow_id: string;
  type?: string;
  errors?: Record<string, string>;
}

interface FlowStepResponse {
  type: 'create_entry' | 'form' | 'abort';
  flow_id?: string;
  title?: string;
  errors?: Record<string, string>;
  reason?: string;
  result?: { entry_id?: string };
}

export class HaPostInstallService {
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: Logger
  ) {}

  async apply(requests: PostInstallRequest[]): Promise<PostInstallResult[]> {
    const results: PostInstallResult[] = [];
    for (const request of requests) {
      results.push(await this.applyOne(request));
    }
    return results;
  }

  private async applyOne(request: PostInstallRequest): Promise<PostInstallResult> {
    const ha = this.configService.getHaWsConfig();
    if (!ha?.host || !ha?.token) {
      return { kind: request.kind, success: false, error: "HA WebSocket non configuré ou non connecté sur cette machine — configurez d'abord ha.ws avant d'installer un service." };
    }
    const baseUrl = `http://${ha.host}:${ha.port}`;

    try {
      if (request.kind === 'ollama') {
        return await this.installOllama(baseUrl, ha.token, request);
      }
      if (request.kind === 'mqtt') {
        return await this.installMqtt(baseUrl, ha.token, request);
      }
      return await this.installWyoming(baseUrl, ha.token, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaPostInstall', `Échec installation ${request.kind}: ${message}`);
      return { kind: request.kind, success: false, error: message };
    }
  }

  private async installWyoming(baseUrl: string, token: string, request: PostInstallRequest): Promise<PostInstallResult> {
    if (!request.host || !request.port) {
      return { kind: request.kind, success: false, error: 'Hôte et port requis' };
    }
    const handler = WYOMING_HANDLER[request.kind as 'whisper' | 'piper' | 'wakeword'];
    const init = await this.postFlow<FlowInitResponse>(baseUrl, token, '/api/config/config_entries/flow', { handler });
    const step = await this.postFlow<FlowStepResponse>(baseUrl, token, `/api/config/config_entries/flow/${init.flow_id}`, {
      host: request.host,
      port: request.port
    });
    return this.toResult(request.kind, step);
  }

  private async installMqtt(baseUrl: string, token: string, request: PostInstallRequest): Promise<PostInstallResult> {
    if (!request.host || !request.port) {
      return { kind: 'mqtt', success: false, error: 'Hôte et port requis' };
    }
    const init = await this.postFlow<FlowInitResponse>(baseUrl, token, '/api/config/config_entries/flow', { handler: 'mqtt' });
    const step = await this.postFlow<FlowStepResponse>(baseUrl, token, `/api/config/config_entries/flow/${init.flow_id}`, {
      broker: request.host,
      port: request.port,
      username: request.username || undefined,
      password: request.password || undefined
    });
    return this.toResult('mqtt', step);
  }

  /** Connexion Ollama de base, puis sous-entrée "Agent de conversation" séparée — sans laquelle
   *  l'agent n'apparaît jamais dans un pipeline Assist (vérifié en conditions réelles). */
  private async installOllama(baseUrl: string, token: string, request: PostInstallRequest): Promise<PostInstallResult> {
    if (!request.url) {
      return { kind: 'ollama', success: false, error: 'URL requise' };
    }

    const init = await this.postFlow<FlowInitResponse>(baseUrl, token, '/api/config/config_entries/flow', { handler: 'ollama' });
    const step = await this.postFlow<FlowStepResponse>(baseUrl, token, `/api/config/config_entries/flow/${init.flow_id}`, { url: request.url });
    const entryResult = this.toResult('ollama', step);
    if (!entryResult.success) return entryResult;

    const entryId = step.result?.entry_id;
    if (!entryId || !request.model) {
      // Connexion de base créée mais pas d'agent de conversation (modèle non fourni) — pas un
      // échec en soi, juste une étape non demandée.
      return entryResult;
    }

    // ⭐ Vérifié en conditions réelles (24/08/2026) : `handler` est un COUPLE [entry_id,
    // subentry_type] (sérialisé en tableau JSON), pas un objet {handler, entry_id} séparé — un
    // objet séparé provoque une erreur HTTP 500 côté HA (pas une erreur de validation propre).
    const subInit = await this.postFlow<FlowInitResponse>(baseUrl, token, '/api/config/config_entries/subentries/flow', {
      handler: [entryId, 'conversation']
    });
    const subStep = await this.postFlow<FlowStepResponse>(baseUrl, token, `/api/config/config_entries/subentries/flow/${subInit.flow_id}`, {
      name: 'Ollama Conversation',
      model: request.model,
      // Instructions/fenêtre de contexte/historique laissés aux défauts de HA lui-même (non
      // transmis) — "llm_hass_api" (case Assist) volontairement absent, voir en-tête du fichier.
    });
    const subResult = this.toResult('ollama', subStep);
    if (!subResult.success) {
      return { kind: 'ollama', success: false, error: `Connexion créée mais agent de conversation en échec: ${subResult.error}` };
    }
    return { kind: 'ollama', success: true, title: `${entryResult.title} + agent de conversation (${request.model})` };
  }

  private toResult(kind: PostInstallServiceKind, step: FlowStepResponse): PostInstallResult {
    if (step.type === 'create_entry') {
      return { kind, success: true, title: step.title };
    }
    if (step.type === 'abort') {
      return { kind, success: false, error: step.reason || 'Configuration refusée par HA' };
    }
    return { kind, success: false, error: step.errors ? JSON.stringify(step.errors) : 'Étape supplémentaire requise, non prise en charge automatiquement' };
  }

  private async postFlow<T>(baseUrl: string, token: string, path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} sur ${path}`);
    }
    return response.json() as Promise<T>;
  }
}
