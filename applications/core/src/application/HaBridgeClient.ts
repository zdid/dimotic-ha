/**
 * HaBridgeClient — façade côté application pour interroger le référentiel/exécuter des commandes
 * HA sans dépendre des classes concrètes `HaStructureRegistry`/`HaWsClient` (⭐ 24/08/2026, voir
 * HaQueryBridge côté `core` pour le pendant serveur, et fonctionnelles-supervisor_specs pour le
 * contexte). Seul type que `ia`/`planificateur`/`haplan`/`arbreouquoi` importent désormais pour
 * accéder à HA — construit avec juste un `IEventBus`, fonctionne à l'identique en process séparé
 * (`IpcEventBus`) ou in-process (`EventBus`).
 *
 * `getEntity`/`getAllEntities`/`getQuoiCatalog` sont **synchrones**, servis depuis un cache local
 * peuplé par `start()` et tenu à jour :
 *  - `ha:entity:state_changed` (déjà émis par AppService à chaque state_changed HA) met à jour
 *    state/attributes/last_updated de l'entité concernée dans le cache, sans aller-retour réseau —
 *    évite que le cache dérive entre deux resynchronisations complètes (cas réel : HaplanService
 *    lit `getAllEntities()` pour l'état affiché en direct sur un plan).
 *  - `ha:ready` (déjà émis après chaque `HaStructureRegistry.rebuild()`, connexion ET reconnexion)
 *    déclenche un rechargement complet du cache — la structure (area/device/quoi_ids) peut changer
 *    entièrement à une reconnexion.
 *
 * `getEntitiesByQuoiAndLieux`/`getLieuCatalog` restent de vraies requêtes asynchrones (graphe de
 * lieux non trivial, mieux vaut ne pas le dupliquer côté client) ; `sendCommand`/
 * `processConversation` aussi (déjà asynchrones côté HaWsClient).
 */

import type { IEventBus } from './IEventBus';
import type { Logger } from '../infrastructure/logger';
import type { HaStructuredEntity, HaQuoiDefinition, HaRawEntity } from '../ha/types/index';
import { CorrelatedRequester } from './CorrelatedRequester';
import type { HaBridgeMethod } from './HaQueryBridge';

const REQUEST_EVENT = 'ha:bridge:request';
const REPLY_EVENT = 'ha:bridge:reply';
const DEFAULT_TIMEOUT_MS = 5000;

interface HaBridgeRequestPayload {
  method: HaBridgeMethod;
  args: unknown[];
}

interface HaBridgeReplyPayload {
  correlation_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class HaBridgeClient {
  private readonly requester: CorrelatedRequester<HaBridgeRequestPayload, HaBridgeReplyPayload>;
  private entities = new Map<string, HaStructuredEntity>();
  private quoiCatalog: HaQuoiDefinition[] = [];
  /** true dès qu'un premier chargement a réussi — false ne signifie pas forcément une erreur (peut
   *  simplement refléter ha.ws_enable=false, état normal déjà toléré par toutes les apps). */
  private available = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.requester = new CorrelatedRequester<HaBridgeRequestPayload, HaBridgeReplyPayload>(
      eventBus,
      REQUEST_EVENT,
      REPLY_EVENT
    );
  }

  /** À appeler avant tout usage — charge le cache initial et met en place le rafraîchissement
   *  automatique. Ne rejette jamais (ha.ws_enable=false est un état normal) : consulter
   *  isAvailable() si le distinguo importe. */
  async start(): Promise<void> {
    this.eventBus.onGeneric<HaRawEntity>('ha:entity:state_changed', (raw) => this.patchCachedState(raw));
    this.eventBus.onGeneric('ha:ready', () => {
      this.refreshCache().catch((error) => this.logger.warn('HaBridgeClient', `Rechargement du cache après ha:ready échoué: ${error}`));
    });
    await this.refreshCache();
  }

  isAvailable(): boolean {
    return this.available;
  }

  private async refreshCache(): Promise<void> {
    try {
      const [entitiesReply, quoiReply] = await Promise.all([
        this.requester.request({ method: 'getAllEntities', args: [] }, this.timeoutMs),
        this.requester.request({ method: 'getQuoiCatalog', args: [] }, this.timeoutMs)
      ]);

      if (!entitiesReply.ok || !quoiReply.ok) {
        this.logger.warn('HaBridgeClient', `Référentiel HA indisponible côté core: ${entitiesReply.error || quoiReply.error}`);
        return;
      }

      const entities = entitiesReply.result as HaStructuredEntity[];
      this.entities = new Map(entities.map((e) => [e.entity_id, e]));
      this.quoiCatalog = quoiReply.result as HaQuoiDefinition[];
      this.available = true;
    } catch (error) {
      this.logger.warn('HaBridgeClient', `Chargement initial du référentiel HA échoué: ${error}`);
    }
  }

  private patchCachedState(raw: HaRawEntity): void {
    const cached = this.entities.get(raw.entity_id);
    if (!cached) return;
    this.entities.set(raw.entity_id, {
      ...cached,
      state: raw.state,
      attributes: raw.attributes,
      last_updated: new Date(raw.last_updated)
    });
  }

  // ==========================================================================
  // Lecture — synchrone, servie depuis le cache
  // ==========================================================================

  getEntity(entityId: string): HaStructuredEntity | undefined {
    return this.entities.get(entityId);
  }

  getAllEntities(): HaStructuredEntity[] {
    return Array.from(this.entities.values());
  }

  getQuoiCatalog(): HaQuoiDefinition[] {
    return this.quoiCatalog;
  }

  /**
   * Dérivation simple sur le cache local (`attributs_taxonomie.lieu_precis/lieu_principal/
   * lieu_pere/lieu_grand_pere` de chaque entité déjà en cache) — même logique que
   * `HaStructureRegistry.getLieuCatalog()`, dupliquée volontairement ici (contrairement à
   * `getEntitiesByQuoiAndLieux` ci-dessous) : c'est un simple ensemble de valeurs distinctes, sans
   * graphe de containment ni état privé à reproduire — rester synchrone évite un aller-retour
   * réseau à chaque appel (rules.ts en fait un par tour de conversation).
   */
  getLieuCatalog(excludedQuoiIds?: Iterable<string>): string[] {
    const excluded = excludedQuoiIds instanceof Set ? excludedQuoiIds : new Set(excludedQuoiIds ?? []);
    const lieux = new Set<string>();
    for (const entity of this.entities.values()) {
      const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
      if (!taxonomy) continue;
      const slugQuoi = taxonomy.slug_quoi;
      if (typeof slugQuoi === 'string' && excluded.has(slugQuoi)) continue;
      for (const field of ['lieu_precis', 'lieu_principal', 'lieu_pere', 'lieu_grand_pere'] as const) {
        const value = taxonomy[field];
        if (typeof value === 'string' && value && !/^\d+$/.test(value)) lieux.add(value);
      }
    }
    return [...lieux].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  // ==========================================================================
  // Lecture — requête distante (graphe de lieux/containment, non dupliqué côté client : logique
  // et état privé non exposés par HaStructureRegistry, voir son en-tête)
  // ==========================================================================

  async getEntitiesByQuoiAndLieux(quoi: string | undefined, lieux: string[]): Promise<HaStructuredEntity[]> {
    const reply = await this.request('getEntitiesByQuoiAndLieux', [quoi, lieux]);
    return (reply as HaStructuredEntity[]) ?? [];
  }

  // ==========================================================================
  // Commandes — toujours asynchrones
  // ==========================================================================

  async sendCommand(
    domain: string,
    service: string,
    target: { entity_id?: string | string[] },
    serviceData?: Record<string, unknown>
  ): Promise<unknown> {
    return this.request('sendCommand', [domain, service, target, serviceData]);
  }

  async processConversation(text: string, language = 'fr'): Promise<unknown> {
    return this.request('processConversation', [text, language]);
  }

  // ==========================================================================
  // Abonnement live — état brut, poussé par core à chaque state_changed HA
  // ==========================================================================

  onStateChanged(callback: (entity: HaRawEntity) => void): void {
    this.eventBus.onGeneric<HaRawEntity>('ha:entity:state_changed', callback);
  }

  private async request(method: HaBridgeMethod, args: unknown[]): Promise<unknown> {
    const reply = await this.requester.request({ method, args }, this.timeoutMs);
    if (!reply.ok) {
      throw new Error(reply.error || `Échec de la requête HaBridgeClient (${method})`);
    }
    return reply.result;
  }
}
