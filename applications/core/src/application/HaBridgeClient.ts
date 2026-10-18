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

  /** Force un rechargement complet du cache et attend sa fin — pour un consommateur qui doit
   *  republier une donnée dérivée après une reconnexion HA (ex: HaplanService::emitTaxonomyTree
   *  sur `ha:ready`) sans dépendre de l'ordre d'exécution entre écouteurs du même événement (le
   *  rechargement interne déclenché par start() sur ce même événement est asynchrone, non
   *  attendu par son propre écouteur). */
  async refresh(): Promise<void> {
    await this.refreshCache();
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

  /** Rechargement groupé déclenché par une entité inconnue du cache (3 s : plusieurs créations d'un coup = un seul rechargement). */
  private rechargementPlanifie: NodeJS.Timeout | null = null;
  /** Entités restées absentes du cache APRÈS un rechargement (exclues volontairement, ex. sans pièce) : on n'y revient pas. */
  private readonly absentesApresRechargement = new Set<string>();
  private candidatesRechargement = new Set<string>();
  private dernierRechargement = 0;

  private patchCachedState(raw: HaRawEntity): void {
    const cached = this.entities.get(raw.entity_id);
    if (!cached) {
      // ⭐ 18/10/2026 — entité CRÉÉE après le dernier rechargement (script, aide, nouvel appareil…) : sans cela elle restait invisible
      // du cache (donc des outils des agents) jusqu'au prochain `ha:ready`. Un seul rechargement pour une rafale de créations.
      if (this.available && !this.rechargementPlanifie && !this.absentesApresRechargement.has(raw.entity_id)) {
        this.candidatesRechargement.add(raw.entity_id);
        // au plus un rechargement par minute (garde-fou : un cache qui exclut volontairement des entités ne doit pas boucler)
        const attente = Math.max(3000, 60000 - (Date.now() - this.dernierRechargement));
        this.rechargementPlanifie = setTimeout(() => {
          this.rechargementPlanifie = null;
          this.dernierRechargement = Date.now();
          const candidates = this.candidatesRechargement;
          this.candidatesRechargement = new Set();
          this.refreshCache()
            .then(() => { for (const id of candidates) if (!this.entities.has(id)) this.absentesApresRechargement.add(id); })
            .catch((error) => this.logger.warn('HaBridgeClient', `Rechargement après nouvelle entité échoué: ${error}`));
        }, attente);
        this.rechargementPlanifie.unref?.();
      } else if (this.available) {
        this.candidatesRechargement.add(raw.entity_id);
      }
      return;
    }
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
      if (entity.entity_category || entity.disabled_by) continue; // catalogue de lieux : entités « utilisateur » seulement
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

  /** `includeTechnical` : inclure aussi les entités de réglage/diagnostic et les désactivées (écartées par défaut). */
  async getEntitiesByQuoiAndLieux(quoi: string | undefined, lieux: string[], includeTechnical = false): Promise<HaStructuredEntity[]> {
    const reply = await this.request('getEntitiesByQuoiAndLieux', [quoi, lieux, includeTechnical]);
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

  /** Latitude/longitude de l'installation HA (`HaWsClient.getHaConfig()`) — lookup ponctuel, pas
   *  de cache local synchrone à patcher (ne change jamais en pratique). Utilisé par `planificateur`
   *  pour le calcul lever/coucher du soleil (`sun-times.ts`, §16 fonctionnelles-ia_specs). */
  async getHaConfig(): Promise<{ latitude: number; longitude: number }> {
    const reply = await this.request('getHaConfig', []);
    const config = reply as { latitude: number; longitude: number };
    return { latitude: config.latitude, longitude: config.longitude };
  }

  /**
   * ⭐ 13/10/2026 — « interroger HA » de façon générique (conception-esphome-assembleur) : n'importe quelle commande
   * WebSocket `{ type, … }` (sans `id`), ex. `{ type: 'dimotic_plans/floorplans/list' }`. Délai : celui du client, ou
   * `timeoutMs` pour une commande longue.
   */
  async callWs(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request('callWs', [message], timeoutMs);
  }

  /** ⭐ 13/10/2026 — appel REST générique sous `/api/` de HA (ex. flux de déclaration d'un appareil ESPHome). */
  async callRest(method: 'GET' | 'POST' | 'DELETE', apiPath: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }> {
    return (await this.request('callRest', [method, apiPath, body], timeoutMs)) as { status: number; body: unknown };
  }

  // ==========================================================================
  // Abonnement live — état brut, poussé par core à chaque state_changed HA
  // ==========================================================================

  onStateChanged(callback: (entity: HaRawEntity) => void): void {
    this.eventBus.onGeneric<HaRawEntity>('ha:entity:state_changed', callback);
  }

  private async request(method: HaBridgeMethod, args: unknown[], timeoutMs?: number): Promise<unknown> {
    const reply = await this.requester.request({ method, args }, timeoutMs ?? this.timeoutMs);
    if (!reply.ok) {
      throw new Error(reply.error || `Échec de la requête HaBridgeClient (${method})`);
    }
    return reply.result;
  }
}
