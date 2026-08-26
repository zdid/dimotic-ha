/**
 * HaQueryBridge — façade générique requête/réponse pour interroger `haStructureRegistry`/
 * `haWsClient` (objets vivants, construits par `core`) depuis une application en process séparé,
 * sans lui transporter ces classes elles-mêmes (⭐ 24/08/2026, découplage `ia`/`planificateur`/
 * `haplan`/`arbreouquoi`, voir fonctionnelles-supervisor_specs — migration différée le 16/08/2026,
 * reprise ici via le mécanisme `CorrelatedRequester` déjà existant pour le dialogue ia↔planificateur).
 *
 * Un seul canal générique de requête (`ha:bridge:request` → `ha:bridge:reply`, `method`/`args`)
 * plutôt qu'un événement par méthode — l'app demande ce dont elle a besoin, `core` reste seul
 * détenteur des objets réels. Voir `HaBridgeClient` (façade côté app, seul type qu'elle importe).
 *
 * L'abonnement live aux changements d'état et le signal de resynchronisation complète du
 * référentiel n'ont pas besoin d'un mécanisme dédié : `AppService` émet déjà
 * `ha:entity:state_changed` (par changement) et `ha:ready` (après chaque `rebuild()`) sur
 * l'EventBus — il suffit de les ponter aussi aux apps séparées (voir AppService.ts, bloc
 * d'enregistrement `runsAsSeparateProcess`).
 *
 * Toute `HaStructuredEntity` sortante passe par `sanitizeHaEntity`/`sanitizeHaEntities` — voir leur
 * documentation dans ha/types/ha-entity.ts pour le bug de cycle déjà rencontré une fois.
 */

import type { IEventBus } from './IEventBus';
import type { Logger } from '../infrastructure/logger';
import type { HaStructureRegistry } from '../ha/sync/HaStructureRegistry';
import type { HaWsClient } from '../ha/sync/HaWsClient';
import { sanitizeHaEntities, sanitizeHaEntity } from '../ha/types/ha-entity';

const REQUEST_EVENT = 'ha:bridge:request';
const REPLY_EVENT = 'ha:bridge:reply';

export type HaBridgeMethod =
  | 'getEntity'
  | 'getAllEntities'
  | 'getEntitiesByQuoiAndLieux'
  | 'getQuoiCatalog'
  | 'getLieuCatalog'
  | 'sendCommand'
  | 'processConversation'
  | 'getHaConfig';

interface HaBridgeRequest {
  correlation_id: string;
  method: HaBridgeMethod;
  args: unknown[];
}

interface HaBridgeReply {
  correlation_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class HaQueryBridge {
  /**
   * `getHaStructureRegistry`/`getHaWsClient` en fournisseurs (pas des valeurs figées) : `haWsClient`
   * redevient `undefined` sur `AppService.stop du client WS` (désactivation ha.ws_enable) —
   * capturer une valeur une fois à la construction retiendrait une référence obsolète, invisible
   * au prochain appel.
   */
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly getHaStructureRegistry: () => HaStructureRegistry | undefined,
    private readonly getHaWsClient: () => HaWsClient | undefined
  ) {}

  start(): void {
    this.eventBus.onGeneric<HaBridgeRequest>(REQUEST_EVENT, (request) => {
      void this.handleRequest(request);
    });
  }

  private async handleRequest(request: HaBridgeRequest): Promise<void> {
    const { correlation_id, method, args } = request;
    try {
      const result = await this.dispatch(method, args);
      const reply: HaBridgeReply = { correlation_id, ok: true, result };
      this.eventBus.emitGeneric(REPLY_EVENT, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('HaQueryBridge', `Échec ${method}: ${message}`);
      const reply: HaBridgeReply = { correlation_id, ok: false, error: message };
      this.eventBus.emitGeneric(REPLY_EVENT, reply);
    }
  }

  private async dispatch(method: HaBridgeMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getEntity': {
        const registry = this.requireRegistry();
        const [entityId] = args as [string];
        const entity = registry.getEntity(entityId);
        return entity ? sanitizeHaEntity(entity) : undefined;
      }
      case 'getAllEntities': {
        const registry = this.requireRegistry();
        return sanitizeHaEntities(registry.getAllEntities());
      }
      case 'getEntitiesByQuoiAndLieux': {
        const registry = this.requireRegistry();
        const [quoi, lieux] = args as [string | undefined, string[] | undefined];
        return sanitizeHaEntities(registry.getEntitiesByQuoiAndLieux(quoi, lieux ?? []));
      }
      case 'getQuoiCatalog': {
        return this.requireRegistry().getQuoiCatalog();
      }
      case 'getLieuCatalog': {
        const registry = this.requireRegistry();
        const [excludedQuoiIds] = args as [string[] | undefined];
        return registry.getLieuCatalog(excludedQuoiIds);
      }
      case 'sendCommand': {
        const client = this.requireWsClient();
        const [domain, service, target, serviceData] = args as [
          string,
          string,
          { entity_id?: string | string[] },
          Record<string, unknown> | undefined
        ];
        return client.sendCommand(domain, service, target, serviceData);
      }
      case 'processConversation': {
        const client = this.requireWsClient();
        const [text, language] = args as [string, string | undefined];
        return client.processConversation(text, language);
      }
      case 'getHaConfig': {
        const client = this.requireWsClient();
        return client.getHaConfig();
      }
      default: {
        const exhaustive: never = method;
        throw new Error(`Méthode HaQueryBridge inconnue: ${exhaustive}`);
      }
    }
  }

  private requireRegistry(): HaStructureRegistry {
    const registry = this.getHaStructureRegistry();
    if (!registry) {
      throw new Error('Référentiel HA indisponible (ha.ws_enable=false ?)');
    }
    return registry;
  }

  private requireWsClient(): HaWsClient {
    const client = this.getHaWsClient();
    if (!client) {
      throw new Error('HaWsClient indisponible (ha.ws_enable=false ?)');
    }
    return client;
  }
}
