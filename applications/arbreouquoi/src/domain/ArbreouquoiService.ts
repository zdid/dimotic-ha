import type { IEventBus } from '../../../core/dist/application/IEventBus';
import type { Logger } from '../../../core/dist/infrastructure/logger/index';
import type { IAppConfigProvider } from '../../../core/dist/infrastructure/config/IAppConfigProvider';
import type { HaStructuredEntity } from '../../../core/dist/ha/types/ha-entity';
import type { HaArea, HaDevice, HaQuoiDefinition } from '../../../core/dist/ha/types/ha-structure';
import type { HaBridgeClient } from '../../../core/dist/application/HaBridgeClient';
import { arbreouquoiConfigSchema, type ArbreouquoiConfig } from './config-schema';
import type {
  OuNode,
  OuWithQuoiNode,
  OuFirstTree,
  QuoiFirstTree,
  QuiGroupWithOu,
  QuoiGroup,
  EntityInfo,
  QuoiCatalogWithCounts,
  ArbreOuQuoiTreePayload
} from './types';
import { ARBREOUQUOI_SOCKET_EVENTS } from './socket-events';

/**
 * Un segment du chemin OÙ, du plus général (grand_pere) au plus précis (lieu_precis). Porte son
 * niveau explicitement — contrairement à l'ancien système qui le devinait depuis la position dans
 * un tableau (getOuLevel(index, totalLength)), fragile et devenu carrément faux depuis que
 * lieu_precis peut être absent alors que pere/grand_pere sont présents (voir extractOuSegments).
 */
interface OuSegment {
  id: string;
  name: string;
  level: 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis';
}

export class ArbreouquoiService {
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(
    private eventBus: IEventBus,
    private logger: Logger,
    private configService: IAppConfigProvider<ArbreouquoiConfig>,
    /** Façade générique vers le référentiel HA détenu par `core` (⭐ 24/08/2026, voir
     *  HaBridgeClient.ts) — plus de HaStructureRegistry en direct depuis la migration en process
     *  séparé. isAvailable() reflète ha.ws_enable=false côté core, même état normal qu'avant. */
    private haBridgeClient: HaBridgeClient
  ) {
    this.setupEventListeners();
  }

  /**
   * Charge la config depuis le provider et applique les valeurs par défaut du schéma (le
   * provider retourne {} si la section 'arbreouquoi' n'existe pas encore dans config.yaml —
   * première installation, jamais configuré via l'UI).
   */
  private getConfig(): ArbreouquoiConfig {
    return arbreouquoiConfigSchema.parse(this.configService.getAppConfig());
  }

  /**
   * Accès au bridge avec message d'erreur clair s'il n'est pas disponible (ha.ws_enable=false côté
   * core) plutôt qu'un échec cryptique plus loin — les appelants sont déjà dans un try/catch qui
   * convertit l'exception en événement ARBREOUQUOI_SOCKET_EVENTS.ERROR côté client. Le
   * sanitizing device/area (cycle HaStructuredEntity.device.entities, cf. historique) est
   * désormais fait une fois pour toutes côté core (HaQueryBridge) avant de traverser l'IPC — plus
   * besoin de le refaire ici.
   */
  private requireBridge(): HaBridgeClient {
    if (!this.haBridgeClient.isAvailable()) {
      throw new Error('Référentiel HA indisponible (pas encore synchronisé, ou ha.ws_enable=false)');
    }
    return this.haBridgeClient;
  }

  // ⭐ OBLIGATOIRE : Méthode start() asynchrone
  async start(): Promise<void> {
    this.logger.info('ArbreouquoiService', 'Démarrage du service ArbreOuQui...');

    try {
      // Charger la configuration
      const config = this.getConfig();
      this.logger.info('ArbreouquoiService', `Configuration chargée. Mode: ${config.display.viewMode}`);

      // Le référentiel structuré n'existe que si ha.ws_enable=true (voir techniques-socle-ha-mqtt_specs
      // §8.1) — arbreouquoi en dépend entièrement (requiredHaWs: true), mais son absence est un état
      // normal (WS désactivé), pas une erreur : on le signale proprement plutôt que de planter.
      await this.haBridgeClient.start();
      this.registerPersistentEvents();
      if (this.haBridgeClient.isAvailable()) {
        this.initializeWithHa();
      } else {
        // ⭐ 24/09/2026 — HA pas encore synchronisé (état normal au démarrage : le core ne répond plus
        // « 0 entité » avant son premier ha:ready) ou désactivé : l'initialisation complète se fera
        // au premier ha:ready (voir setupEventListeners). Avant, start() s'arrêtait ici et seuls
        // l'arbre et les statistiques étaient rattrapés — ni catalogue, ni rafraîchissement auto, ni
        // statut « ready ».
        this.logger.info('ArbreouquoiService', 'Référentiel HA pas encore disponible — initialisation au premier ha:ready');
        this.emitStatus('error', 'Référentiel HA pas encore disponible (synchronisation en cours, ou ha.ws_enable désactivé)');
      }

      this.logger.info('ArbreouquoiService', 'Service ArbreOuQui démarré avec succès');
    } catch (error) {
      this.logger.error('ArbreouquoiService', `Erreur de démarrage: ${error}`);
      this.emitStatus('error', `Erreur de démarrage: ${error}`);
      throw error;
    }
  }

  /** Partie de l'initialisation qui dépend du référentiel HA — au démarrage si HA est déjà prêt,
   *  sinon au premier ha:ready (une seule fois). */
  private haInitialized = false;

  private initializeWithHa(): void {
    this.haInitialized = true;
    const config = this.getConfig();
    const entityCount = this.haBridgeClient.getAllEntities().length;
    this.logger.info('ArbreouquoiService', `Référentiel HA initialisé avec ${entityCount} entités`);
    if (config.refresh.autoRefreshEnabled) {
      this.startAutoRefresh(config.refresh.autoRefreshInterval);
    }
    this.emitTree();
    this.emitCatalog();
    this.emitStats();
    this.emitStatus('ready', `Service démarré avec ${entityCount} entités HA, mode: ${config.display.viewMode}`);
  }

  // OPTIONNEL : Méthode stop() pour un arrêt propre
  async stop(): Promise<void> {
    this.logger.info('ArbreouquoiService', 'Arrêt du service...');
    if (this.stateRefreshTimer) clearTimeout(this.stateRefreshTimer);

    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    this.emitStatus('stopped', 'Service arrêté');
    this.logger.info('ArbreouquoiService', 'Service arrêté');
  }

  private setupEventListeners(): void {
    // 'ha:structure:rebuilt' est déclaré dans core/types/events.ts mais n'a jamais été émis nulle
    // part (AppService.loadHaRegistry() émet 'ha:ready' à la place, une fois rebuild() terminé) —
    // ce listener ne se déclenchait donc jamais. Restait invisible tant que le minuteur périodique
    // (autoRefreshEnabled) finissait par rattraper le coup ; démasqué en le désactivant.
    // ⭐ 24/09/2026 — attendre le rechargement du cache HaBridgeClient (refresh()) AVANT de reconstruire :
    // HaBridgeClient se recharge sur ce même ha:ready, en parallèle — reconstruire immédiatement lisait
    // un cache pas encore rechargé (arbre à 0 entité, puis « indisponible »). Même patron que HaplanService.
    this.eventBus.on('ha:ready', () => {
      this.haBridgeClient.refresh()
        .then(() => {
          this.logger.info('ArbreouquoiService', 'Référentiel HA reconstruit');
          if (!this.haInitialized) {
            if (this.haBridgeClient.isAvailable()) this.initializeWithHa();
            return;
          }
          const config = this.getConfig();
          if (config.refresh.refreshOnHaUpdate) {
            this.emitTree();
            this.emitStats();
          }
        })
        .catch((error) => this.logger.warn('ArbreouquoiService', `Rechargement du référentiel après ha:ready échoué: ${error}`));
    });

    // ⭐ 24/09/2026 — `ha:entity:updated` n'était jamais ponté vers ce process (écouteur mort : les
    // états affichés restaient figés). `ha:entity:state_changed` l'est (HaBridgeClient met déjà son
    // cache à jour dessus) ; reconstruction LIMITÉE à une toutes les STATE_REFRESH_MIN_INTERVAL_MS —
    // une reconstruction complète par changement d'état serait bien trop lourde (740 entités).
    this.eventBus.onGeneric('ha:entity:state_changed', () => {
      if (!this.haInitialized || !this.getConfig().refresh.refreshOnHaUpdate) return;
      this.scheduleStateRefresh();
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.TREE_GET, () => this.emitTree());
    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.CATALOG_GET, () => this.emitCatalog());
    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.REFRESH, () => {
      this.emitTree();
      this.emitCatalog();
      this.emitStats();
    });

    // ⭐ 24/09/2026 — recherche et filtre « entités actives » appliqués CÔTÉ PAGE sur l'arbre complet
    // (FILTER_SET/SEARCH n'ont plus de traitement serveur) : la recherche était ignorée ici (arbre
    // complet renvoyé tel quel) et le filtre perdu à chaque rafraîchissement ; chaque onglet garde
    // désormais ses propres filtres, sans état partagé côté serveur.

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.ENTITY_GET, (data: unknown) => {
      this.emitEntityDetails(data as string);
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVE, (data: unknown) => {
      this.handleConfigSave(data as Partial<ArbreouquoiConfig>);
    });
  }

  private handleConfigSave(partialConfig: Partial<ArbreouquoiConfig>): void {
    try {
      const currentConfig = this.getConfig();
      // ⭐ 24/09/2026 — fusion PAR SECTION : `{ ...current, ...partial }` remplaçait tout `display`
      // quand la page n'envoyait que `{ display: { viewMode } }` — les autres réglages d'affichage
      // retombaient à leurs valeurs par défaut.
      const newConfig = arbreouquoiConfigSchema.parse({
        display: { ...currentConfig.display, ...(partialConfig.display ?? {}) },
        refresh: { ...currentConfig.refresh, ...(partialConfig.refresh ?? {}) }
      });

      const saveResult = this.configService.savePartialConfig(newConfig) as { success?: boolean; error?: string } | void;
      if (saveResult && saveResult.success === false) {
        throw new Error(saveResult.error ?? 'écriture refusée');
      }

      // ⚠️ Vérifier !== undefined, pas la simple vérité : autoRefreshInterval=0 est une valeur
      // valide (désactivation) mais falsy en JS — un test tronqué ignorerait silencieusement
      // toute tentative de mise à 0, laissant tourner l'ancien minuteur indéfiniment.
      if (partialConfig.refresh?.autoRefreshInterval !== undefined || partialConfig.refresh?.autoRefreshEnabled !== undefined) {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        if (newConfig.refresh.autoRefreshEnabled) {
          this.startAutoRefresh(newConfig.refresh.autoRefreshInterval);
        }
      }

      // Si le mode a changé, rafraîchir immédiatement
      if (partialConfig.display?.viewMode && partialConfig.display.viewMode !== currentConfig.display.viewMode) {
        this.emitTree();
      }

      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVED, {
        success: true,
        config: newConfig
      });
    } catch (error) {
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, {
        message: `Erreur de sauvegarde: ${error}`
      });
    }
  }

  private registerPersistentEvents(): void {
    this.eventBus.emit('app:socket-events:registered', {
      appId: 'arbreouquoi',
      socketEvents: ARBREOUQUOI_SOCKET_EVENTS,
      persistentEvents: [
        ARBREOUQUOI_SOCKET_EVENTS.TREE_STRUCTURE,
        ARBREOUQUOI_SOCKET_EVENTS.QUOI_CATALOG,
        ARBREOUQUOI_SOCKET_EVENTS.STATS,
        ARBREOUQUOI_SOCKET_EVENTS.STATUS
      ]
    });
  }

  /** Rythme maximal des reconstructions déclenchées par les changements d'état HA. */
  private static readonly STATE_REFRESH_MIN_INTERVAL_MS = 5000;
  private stateRefreshTimer: NodeJS.Timeout | null = null;
  private lastStateRefreshAt = 0;

  /** Au plus une reconstruction toutes les 5 s ; un changement arrivé entre-temps est pris en
   *  compte par une reconstruction différée (jamais perdu). */
  private scheduleStateRefresh(): void {
    if (this.stateRefreshTimer) return;
    const wait = Math.max(0, this.lastStateRefreshAt + ArbreouquoiService.STATE_REFRESH_MIN_INTERVAL_MS - Date.now());
    this.stateRefreshTimer = setTimeout(() => {
      this.stateRefreshTimer = null;
      this.lastStateRefreshAt = Date.now();
      this.emitTree();
    }, wait);
  }

  private startAutoRefresh(intervalMs: number): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => {
      try {
        this.emitTree();
        this.emitStats();
      } catch (error) {
        this.logger.error('ArbreouquoiService', `Rafraîchissement auto: ${error}`);
      }
    }, intervalMs);
  }

  private emitStatus(status: string, message: string): void {
    this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.STATUS, {
      status, message, timestamp: new Date().toISOString()
    });
  }

  private emitTree(): void {
    try {
      const config = this.getConfig();
      const viewMode = config.display.viewMode || 'ou-first';
      const tree = viewMode === 'ou-first' ? this.buildOuFirstTree() : this.buildQuoiFirstTree();
      const catalog = this.buildQuoiCatalog();

      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.TREE_STRUCTURE, {
        tree, viewMode, catalog, timestamp: new Date().toISOString()
      });
    } catch (error) {
      this.logger.error('ArbreouquoiService', `Erreur arbre: ${error}\n${(error as Error).stack}`);
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, { message: String(error) });
    }
  }

  private emitCatalog(): void {
    try {
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.QUOI_CATALOG, this.buildQuoiCatalog());
    } catch (error) {
      this.logger.error('ArbreouquoiService', `Erreur catalogue: ${error}`);
    }
  }

  private emitStats(): void {
    try {
      const allEntities = this.requireBridge().getAllEntities();
      const ouPaths = new Set<string>();
      for (const entity of allEntities) {
        const path = this.extractOuSegments(entity).map(s => s.id).join('/');
        if (path) ouPaths.add(path);
      }
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.STATS, {
        totalEntities: allEntities.length,
        totalOuPaths: ouPaths.size,
        unassignedEntities: allEntities.filter(e => this.extractOuSegments(e).length === 0).length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      this.logger.error('ArbreouquoiService', `Erreur stats: ${error}`);
    }
  }

  // ============ BUILD OÙ-FIRST TREE ============

  /** Identifiant d'un lieu = son CHEMIN COMPLET (`salon/plafonnier`), jamais son seul slug. */
  private pathKey(segments: OuSegment[], uptoIndex: number): string {
    return segments.slice(0, uptoIndex + 1).map((s) => s.id).join('/');
  }

  /**
   * ⭐ 24/09/2026, bug corrigé : les nœuds étaient indexés par slug seul — un même nom de lieu sous
   * des parents différents (`plafonnier` dans 7 pièces, 23 lieux sur 80 le 24/09) était FUSIONNÉ en un
   * seul nœud rattaché à la première pièce rencontrée. Désormais indexés par chemin complet : chaque
   * lieu reste à sa place (un même lieu à des profondeurs différentes est normal, affiché tel quel).
   */
  private buildOuFirstTree(): OuFirstTree {
    const allEntities = this.requireBridge().getAllEntities();
    const catalog = this.requireBridge().getQuoiCatalog();

    const rootOuNodes: OuNode[] = [];
    const ouNodeMap = new Map<string, OuNode>();
    const unassigned: EntityInfo[] = [];

    for (const entity of allEntities) {
      const segments = this.extractOuSegments(entity);
      if (segments.length === 0) {
        unassigned.push({ entity, ouPath: [], quoiIds: entity.quoi_ids, device: entity.device || null, area: entity.area || null });
        continue;
      }
      let parent: OuNode | null = null;
      for (let i = 0; i < segments.length; i++) {
        const key = this.pathKey(segments, i);
        let node = ouNodeMap.get(key);
        if (!node) {
          const { name, level } = segments[i]!;
          node = { id: key, name, level, children: [], entities: [], entityCount: 0, parentId: (parent as OuNode | null)?.id ?? null };
          ouNodeMap.set(key, node);
          if (parent) parent.children.push(node);
          else rootOuNodes.push(node);
        }
        node.entityCount++;
        if (i === segments.length - 1) node.entities.push(entity);
        parent = node;
      }
    }

    this.sortOuNodes(rootOuNodes);
    return {
      levels: this.buildOuWithQuoiNodes(rootOuNodes, catalog),
      unassigned,
      totalEntities: allEntities.length,
      totalOuNodes: ouNodeMap.size,
      totalQuoiTypes: new Set(allEntities.flatMap(e => e.quoi_ids)).size
    };
  }

  // ============ BUILD QUOI-FIRST TREE ============

  /**
   * ⭐ 24/09/2026, bug corrigé : la page ne voyait que 20 entités sur 324 — `entitiesByOu` était
   * rangé par chemin complet mais la hiérarchie par slug seul (la page cherchait `entitiesByOu[slug]`),
   * et une branche n'était ajoutée que si sa racine était absente (sous-branches perdues). Désormais
   * chaque groupe QUOI a sa propre hiérarchie indexée par chemin complet : `ouHierarchy` = RACINES
   * seulement (enfants imbriqués), `node.id` = clé de `entitiesByOu`, `entityCount` = entités du
   * sous-arbre.
   */
  private buildQuoiFirstTree(): QuoiFirstTree {
    const allEntities = this.requireBridge().getAllEntities();
    const catalog = this.requireBridge().getQuoiCatalog();

    const quoiGroups: QuiGroupWithOu[] = [];
    const quoiMap = new Map<string, { group: QuiGroupWithOu; nodes: Map<string, OuNode> }>();
    const unassigned: EntityInfo[] = [];
    const allPaths = new Set<string>();

    for (const entity of allEntities) {
      const segments = this.extractOuSegments(entity);
      if (segments.length === 0) {
        unassigned.push({ entity, ouPath: [], quoiIds: entity.quoi_ids, device: entity.device || null, area: entity.area || null });
      }
      for (let i = 0; i < segments.length; i++) allPaths.add(this.pathKey(segments, i));

      for (const quoiId of entity.quoi_ids) {
        let entry = quoiMap.get(quoiId);
        if (!entry) {
          const quoiDef = catalog.find(q => q.quoi_id === quoiId) || { quoi_id: quoiId, label: quoiId, description: '' };
          entry = { group: { quoi: quoiDef, entityCount: 0, ouHierarchy: [], entitiesByOu: {} }, nodes: new Map() };
          quoiMap.set(quoiId, entry);
          quoiGroups.push(entry.group);
        }
        const { group, nodes } = entry;
        group.entityCount++;
        if (segments.length === 0) {
          (group.entitiesByOu['unassigned'] ??= []).push(entity);
          continue;
        }
        let parent: OuNode | null = null;
        for (let i = 0; i < segments.length; i++) {
          const key = this.pathKey(segments, i);
          let node = nodes.get(key);
          if (!node) {
            const { name, level } = segments[i]!;
            node = { id: key, name, level, children: [], entities: [], entityCount: 0, parentId: (parent as OuNode | null)?.id ?? null };
            nodes.set(key, node);
            if (parent) parent.children.push(node);
            else group.ouHierarchy.push(node);
          }
          node.entityCount++;
          parent = node;
        }
        (group.entitiesByOu[this.pathKey(segments, segments.length - 1)] ??= []).push(entity);
      }
    }

    for (const group of quoiGroups) this.sortOuNodes(group.ouHierarchy);
    quoiGroups.sort((a, b) => b.entityCount - a.entityCount);
    return {
      quoiGroups,
      unassigned,
      totalEntities: allEntities.length,
      totalQuoiTypes: quoiGroups.length,
      totalOuNodes: allPaths.size
    };
  }

  // ============ HELPERS ============

  /**
   * Extrait le chemin OÙ d'une entité, du plus général au plus précis, chaque segment portant
   * son niveau réel — plutôt que de le déduire après coup de sa position dans un tableau (ancien
   * `getOuLevel(index, totalLength)`, supprimé). Cette déduction par position devenait ambiguë
   * dès que lieu_precis est absent (null) alors que pere/grand_pere sont présents — ce qui arrive
   * désormais couramment depuis que lieu_precis == lieu n'est plus dupliqué (voir
   * rfxcom/taxonomy.ts et nommage/NommageService.ts, 08/08/2026) : un tableau de longueur 2
   * pouvait alors être [pere, lieu] aussi bien que [precis, lieu], selon les cas — impossible à
   * distinguer sans porter le niveau explicitement à la source, comme ici.
   */
  private extractOuSegments(entity: HaStructuredEntity): OuSegment[] {
    const attrs = entity.attributes as Record<string, unknown> | undefined;
    const taxonomie = attrs?.attributs_taxonomie as {
      slug_grand_pere: string | null; lieu_grand_pere: string | null;
      slug_pere: string | null; lieu_pere: string | null;
      slug_lieu: string | null; lieu_principal: string | null;
      slug_precis: string | null; lieu_precis: string | null;
    } | undefined;
    if (!taxonomie) return [];

    const segments: OuSegment[] = [];
    if (taxonomie.slug_grand_pere) {
      segments.push({ id: taxonomie.slug_grand_pere, name: taxonomie.lieu_grand_pere || taxonomie.slug_grand_pere, level: 'grand_pere' });
    }
    if (taxonomie.slug_pere) {
      segments.push({ id: taxonomie.slug_pere, name: taxonomie.lieu_pere || taxonomie.slug_pere, level: 'pere' });
    }
    if (taxonomie.slug_lieu) {
      segments.push({ id: taxonomie.slug_lieu, name: taxonomie.lieu_principal || taxonomie.slug_lieu, level: 'lieu' });
    }
    if (taxonomie.slug_precis) {
      segments.push({ id: taxonomie.slug_precis, name: taxonomie.lieu_precis || taxonomie.slug_precis, level: 'lieu_precis' });
    }
    return segments;
  }

  private sortOuNodes(nodes: OuNode[]): void {
    nodes.sort((a, b) => {
      const order: Record<string, number> = { grand_pere: 0, pere: 1, lieu: 2, lieu_precis: 3 };
      const aOrder = order[a.level] ?? 99;
      const bOrder = order[b.level] ?? 99;
      return aOrder !== bOrder ? aOrder - bOrder : a.name.localeCompare(b.name);
    });
    for (const node of nodes) this.sortOuNodes(node.children);
  }

  private buildOuWithQuoiNodes(nodes: OuNode[], catalog: HaQuoiDefinition[]): OuWithQuoiNode[] {
    return nodes.map(ouNode => {
      const quoiGroupsMap = new Map<string, HaStructuredEntity[]>();
      for (const entity of ouNode.entities) {
        for (const quoiId of entity.quoi_ids) {
          if (!quoiGroupsMap.has(quoiId)) quoiGroupsMap.set(quoiId, []);
          quoiGroupsMap.get(quoiId)!.push(entity);
        }
      }
      const quoiGroups: QuoiGroup[] = Array.from(quoiGroupsMap.entries()).map(([qi, entities]) => ({
        quoi: catalog.find(q => q.quoi_id === qi) || { quoi_id: qi, label: qi, description: '' },
        entities,
        count: entities.length
      })).sort((a, b) => b.count - a.count);
      return { ou: ouNode, children: quoiGroups, entityCount: ouNode.entityCount };
    });
  }

  private buildQuoiCatalog(): QuoiCatalogWithCounts[] {
    const catalog = this.requireBridge().getQuoiCatalog();
    const allEntities = this.requireBridge().getAllEntities();
    return catalog.map(quoiDef => {
      const entities = allEntities.filter(e => e.quoi_ids.includes(quoiDef.quoi_id));
      const paths = new Set<string>();
      for (const e of entities) {
        const p = this.extractOuSegments(e).map(s => s.id).join('/');
        paths.add(p || 'unassigned');
      }
      return { quoi: quoiDef, entityCount: entities.length, ouPaths: Array.from(paths) };
    }).filter(i => i.entityCount > 0);
  }

  private emitEntityDetails(entityId: string): void {
    try {
      const entity = this.requireBridge().getEntity(entityId);
      if (!entity) {
        this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, { message: `Entité non trouvée: ${entityId}` });
        return;
      }
      const ouSegments = this.extractOuSegments(entity);
      const myPath = ouSegments.map(s => s.id).join('/');
      const related = this.requireBridge().getAllEntities()
                .filter(e => e.entity_id !== entityId)
        .filter(e => {
          const ePath = this.extractOuSegments(e).map(s => s.id).join('/');
          if (ePath === myPath) return true;
          return e.quoi_ids.some(q => entity.quoi_ids.includes(q));
        })
        .map(e => ({
          entity: e,
          ouPath: this.extractOuSegments(e).map(s => s.name),
          quoiIds: e.quoi_ids,
          device: e.device || null,
          area: e.area || null
        }));

      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ENTITY_DETAILS, {
        entity,
        ouPath: ouSegments.length > 0
          ? ouSegments.map(s => ({ name: s.name, level: s.level }))
          : [{ name: entity.area?.name || 'N/A', level: 'lieu' as const }],
        area: entity.area || null,
        device: entity.device || null,
        quiIds: entity.quoi_ids,
        relatedEntities: related
      });
    } catch (error) {
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, { message: String(error) });
    }
  }

}

/**
 * Factory appelée par standalone.ts (⭐ 24/08/2026, app en process séparé — voir
 * fonctionnelles-supervisor_specs) — reçoit un `HaBridgeClient` (façade générique vers le
 * référentiel HA détenu par `core`) plutôt que `HaStructureRegistry` en direct, jamais transportable
 * tel quel hors du process de `core`. `requireBridge()` gère l'indisponibilité (ha.ws_enable=false).
 */
export function createArbreouquoiService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<ArbreouquoiConfig>,
  haBridgeClient: HaBridgeClient
): ArbreouquoiService {
  return new ArbreouquoiService(eventBus, logger, configProvider, haBridgeClient);
}
