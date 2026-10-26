/**
 * HaLectureDirecte — lecture de la taxonomie « quoi / où » de `ia` directement dans Home Assistant (intégration
 * `dimotic_taxonomie`), à la place du registre du cœur (conception-applications-vers-ha). Même surface que ce que `ia`
 * utilisait de `HaBridgeClient` ; le cœur n'est plus que le relais (`callWs`) qui porte le jeton de HA.
 *
 *  - `getEntitiesByQuoiAndLieux` : recherche faite par HA (une seule logique de résolution), toujours à jour.
 *  - `getAllEntities` / `getEntity` / `getQuoiCatalog` / `getLieuCatalog` : synchrones, servies par un instantané relu
 *    dans HA au démarrage, à chaque `ha:ready` (`refresh`), et en arrière-plan quand il a plus de `DUREE_VIE_MS`
 *    (les états et attributs restent donc frais à quelques dizaines de secondes près) ; `fresh()` force la relecture
 *    quand un outil a besoin de l'état courant.
 *  - Pas de repli : si HA ne répond pas, la recherche échoue avec un message clair ; l'instantané déjà lu reste servi.
 */

import type { HaBridgeClient, HaStructuredEntity, HaQuoiDefinition, Logger } from '../../../core/dist/exports';
import { HaTaxonomieClient } from '../../../core/dist/exports';

/** Ce que `ia` utilise de la couche d'accès à HA. */
export type HaLecture = Pick<
  HaBridgeClient,
  'callWs' | 'callRest' | 'isAvailable' | 'getEntitiesByQuoiAndLieux' | 'getQuoiCatalog' | 'getLieuCatalog' | 'getEntity' | 'getAllEntities' | 'start' | 'refresh'
> & { fresh(): Promise<void> };

const DUREE_VIE_MS = 30_000;
const RETENTE_MS = 15_000;

export class HaLectureDirecte implements HaLecture {
  private readonly taxonomie: HaTaxonomieClient;
  private snapshot: { entities: HaStructuredEntity[]; byId: Map<string, HaStructuredEntity>; quoi: HaQuoiDefinition[] } | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private lastAttemptAt = 0;

  constructor(private readonly bridge: HaBridgeClient, private readonly logger?: Logger) {
    // délai de 30 s : la liste de toutes les entités dépasse les 5 s par défaut du relais au démarrage
    this.taxonomie = new HaTaxonomieClient({ callWs: (m) => bridge.callWs(m, 30_000) });
  }

  // --- relais vers le cœur (jeton gardé par le cœur) -------------------------------------------------------------
  callWs(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown> { return this.bridge.callWs(message, timeoutMs); }
  callRest(...args: Parameters<HaBridgeClient['callRest']>): ReturnType<HaBridgeClient['callRest']> { return this.bridge.callRest(...args); }

  async start(): Promise<void> {
    await this.bridge.start();
    await this.refresh().catch((e) => this.logger?.warn('HaLectureDirecte', `Première lecture de HA impossible pour l'instant : ${e instanceof Error ? e.message : e}`));
  }

  /** Relit HA (un seul appel en vol à la fois). Échec : l'instantané précédent est conservé et l'erreur est propagée. */
  async refresh(): Promise<void> {
    await this.bridge.refresh().catch(() => undefined);
    return this.relire();
  }

  async fresh(): Promise<void> {
    if (!this.snapshot || Date.now() - this.loadedAt > 5_000) await this.relire();
  }

  private relire(): Promise<void> {
    if (this.loading) return this.loading;
    this.lastAttemptAt = Date.now();
    this.loading = (async () => {
      try {
        const [entities, quoi] = await Promise.all([this.taxonomie.getAllEntities(), this.taxonomie.getQuoiCatalog()]);
        this.snapshot = { entities, byId: new Map(entities.map((e) => [e.entity_id, e])), quoi };
        this.loadedAt = Date.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private current(): NonNullable<HaLectureDirecte['snapshot']> | null {
    const aucune = !this.snapshot && Date.now() - this.lastAttemptAt > RETENTE_MS; // première lecture échouée : on réessaie
    if ((aucune || (this.snapshot && Date.now() - this.loadedAt > DUREE_VIE_MS)) && !this.loading) {
      this.relire().catch((e) => this.logger?.warn('HaLectureDirecte', `Relecture de HA impossible : ${e instanceof Error ? e.message : e}`));
    }
    return this.snapshot;
  }

  /** Vrai dès qu'une lecture de HA a réussi. */
  isAvailable(): boolean { return this.snapshot !== null; }

  // --- lecture synchrone sur l'instantané -----------------------------------------------------------------------
  getAllEntities(): HaStructuredEntity[] { return this.current()?.entities ?? []; }
  getEntity(entityId: string): HaStructuredEntity | undefined { return this.current()?.byId.get(entityId); }
  getQuoiCatalog(): HaQuoiDefinition[] { return this.current()?.quoi ?? []; }

  /** Même dérivation que l'ancien `HaBridgeClient.getLieuCatalog` (valeurs distinctes lues dans `attributs_taxonomie`),
   *  sur l'instantané de HA ; résultat identique à `dimotic_taxonomie/catalogue_lieux` (comparé sur les 879 entités de ha2). */
  getLieuCatalog(excludedQuoiIds?: Iterable<string>): string[] {
    const excluded = excludedQuoiIds instanceof Set ? excludedQuoiIds : new Set(excludedQuoiIds ?? []);
    const lieux = new Set<string>();
    for (const entity of this.getAllEntities()) {
      if (entity.entity_category || entity.disabled_by) continue;
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

  // --- recherche : faite par HA ---------------------------------------------------------------------------------
  getEntitiesByQuoiAndLieux(quoi: string | undefined, lieux: string[], includeTechnical = false): Promise<HaStructuredEntity[]> {
    return this.taxonomie.getEntitiesByQuoiAndLieux(quoi, lieux, includeTechnical);
  }
}
