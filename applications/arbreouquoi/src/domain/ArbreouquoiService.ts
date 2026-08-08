import type { IEventBus } from '../../../core/dist/application/IEventBus';
import type { Logger } from '../../../core/dist/infrastructure/logger/index';
import type { IAppConfigProvider } from '../../../core/dist/infrastructure/config/IAppConfigProvider';
import type { HaStructuredEntity } from '../../../core/dist/ha/types/ha-entity';
import type { HaArea, HaDevice, HaQuoiDefinition } from '../../../core/dist/ha/types/ha-structure';
import type { HaStructureRegistry } from '../../../core/dist/ha/sync/HaStructureRegistry';
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
  FilterOptions,
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
    /** Absent si ha.ws_enable=false — le référentiel structuré n'existe alors pas du tout. */
    private haStructureRegistry: HaStructureRegistry | undefined
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
   * Accès au référentiel structuré avec message d'erreur clair s'il est absent (ha.ws_enable=false)
   * plutôt qu'un "Cannot read properties of undefined" cryptique — les appelants sont déjà dans un
   * try/catch qui convertit l'exception en événement ARBREOUQUOI_SOCKET_EVENTS.ERROR côté client.
   */
  private requireRegistry(): HaStructureRegistry {
    if (!this.haStructureRegistry) {
      throw new Error('Référentiel HA indisponible (ha.ws_enable=false)');
    }
    return this.haStructureRegistry;
  }

  /**
   * `HaStructuredEntity.device`/`.area` (peuplés par `HaStructureRegistry`) sont des références
   * d'objets complets, pas de simples ID — `device.entities`/`area.entities` pointent en retour
   * vers cette même entité (et toutes ses "sœurs") : un graphe réellement circulaire. Envoyée
   * telle quelle sur le socket, cette structure fait boucler indéfiniment `socket.io-parser`
   * (`hasBinary`, qui parcourt tout objet sans détection de cycle contrairement à
   * `JSON.stringify`) — `RangeError: Maximum call stack size exceeded`, jamais atteint le
   * client. On ne garde que les champs id/name réellement utiles côté UI.
   */
  private sanitizeEntity(entity: HaStructuredEntity): HaStructuredEntity {
    const device = entity.device as { device_id?: string; name?: string } | undefined;
    const area = entity.area as { area_id?: string; name?: string } | undefined;
    return {
      ...entity,
      device: device ? { device_id: device.device_id, name: device.name } : undefined,
      area: area ? { area_id: area.area_id, name: area.name } : undefined
    };
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
      if (!this.haStructureRegistry) {
        this.logger.warn('ArbreouquoiService',
          'Référentiel HA indisponible (ha.ws_enable=false) — Arbre Où Quoi ne peut pas fonctionner sans lui');
        this.emitStatus('error', 'Référentiel HA indisponible : activez ha.ws_enable pour utiliser cette application');
        this.registerPersistentEvents();
        return;
      }

      const entityCount = this.haStructureRegistry.getAllEntities().length;
      this.logger.info('ArbreouquoiService', `Référentiel HA initialisé avec ${entityCount} entités`);

      // Démarrer le rafraîchissement automatique si activé
      if (config.refresh.autoRefreshEnabled) {
        this.startAutoRefresh(config.refresh.autoRefreshInterval);
      }

      // Envoyer la structure initiale selon le mode d'affichage
      this.emitTree();
      this.emitCatalog();
      this.emitStats();

      // Émettre le statut
      this.emitStatus('ready', `Service démarré avec ${entityCount} entités HA, mode: ${config.display.viewMode}`);

      // Enregistrer les événements persistants
      this.registerPersistentEvents();

      this.logger.info('ArbreouquoiService', 'Service ArbreOuQui démarré avec succès');
    } catch (error) {
      this.logger.error('ArbreouquoiService', `Erreur de démarrage: ${error}`);
      this.emitStatus('error', `Erreur de démarrage: ${error}`);
      throw error;
    }
  }

  // OPTIONNEL : Méthode stop() pour un arrêt propre
  async stop(): Promise<void> {
    this.logger.info('ArbreouquoiService', 'Arrêt du service...');

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
    this.eventBus.on('ha:ready', () => {
      this.logger.info('ArbreouquoiService', 'Référentiel HA reconstruit');
      const config = this.getConfig();
      if (config.refresh.refreshOnHaUpdate) {
        this.emitTree();
        this.emitStats();
      }
    });

    this.eventBus.on('ha:entity:updated', () => {
      const config = this.getConfig();
      if (config.refresh.refreshOnHaUpdate) {
        this.emitTree();
      }
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.TREE_GET, () => this.emitTree());
    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.CATALOG_GET, () => this.emitCatalog());
    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.REFRESH, () => {
      this.emitTree();
      this.emitCatalog();
      this.emitStats();
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.FILTER_SET, (data: unknown) => {
      this.emitFilteredTree(data as FilterOptions);
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.ENTITY_GET, (data: unknown) => {
      this.emitEntityDetails(data as string);
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.SEARCH, (data: unknown) => {
      this.emitSearchResults(data as string);
    });

    this.eventBus.on(ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVE, (data: unknown) => {
      this.handleConfigSave(data as Partial<ArbreouquoiConfig>);
    });
  }

  private handleConfigSave(partialConfig: Partial<ArbreouquoiConfig>): void {
    try {
      const currentConfig = this.getConfig();
      const newConfig = { ...currentConfig, ...partialConfig };

      this.configService.savePartialConfig(newConfig);

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
      const allEntities = this.requireRegistry().getAllEntities();
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

  private emitFilteredTree(filterOptions: FilterOptions): void {
    try {
      const config = this.getConfig();
      const viewMode = config.display.viewMode || 'ou-first';
      const tree = viewMode === 'ou-first'
        ? this.buildOuFirstTreeFiltered(filterOptions)
        : this.buildQuoiFirstTreeFiltered(filterOptions);
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.TREE_STRUCTURE, {
        tree, viewMode, catalog: this.buildQuoiCatalog(), timestamp: new Date().toISOString()
      });
    } catch (error) {
      this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, { message: String(error) });
    }
  }

  // ============ BUILD OÙ-FIRST TREE ============

  private buildOuFirstTree(): OuFirstTree {
    const allEntities = this.requireRegistry().getAllEntities().map(e => this.sanitizeEntity(e));
    const catalog = this.requireRegistry().getQuoiCatalog();

    const entitiesWithOu: Array<{ entity: HaStructuredEntity; segments: OuSegment[] }> = [];

    for (const entity of allEntities) {
      const segments = this.extractOuSegments(entity);
      if (segments.length > 0) {
        entitiesWithOu.push({ entity, segments });
      }
    }

    const rootOuNodes: OuNode[] = [];
    const ouNodeMap = new Map<string, OuNode>();

    for (const { entity, segments } of entitiesWithOu) {
      let currentParent: OuNode | null = null;
      for (let i = 0; i < segments.length; i++) {
        const { id: ouId, name: ouName, level } = segments[i]!;

        let ouNode = ouNodeMap.get(ouId);
        if (!ouNode) {
          ouNode = { id: ouId, name: ouName, level, children: [], entities: [], entityCount: 0, parentId: (currentParent as OuNode | null)?.id || null };
          ouNodeMap.set(ouId, ouNode);
          if (currentParent) currentParent.children.push(ouNode);
          else rootOuNodes.push(ouNode);
        }
        ouNode.entityCount++;
        if (i === segments.length - 1) ouNode.entities.push(entity);
        currentParent = ouNode;
      }
    }

    this.sortOuNodes(rootOuNodes);
    const levels = this.buildOuWithQuoiNodes(rootOuNodes, catalog);
    const unassigned = allEntities
      .filter(e => this.extractOuSegments(e).length === 0)
      .map(e => ({ entity: e, ouPath: [], quoiIds: e.quoi_ids, device: e.device || null, area: e.area || null }));

    return {
      levels,
      unassigned,
      totalEntities: allEntities.length,
      totalOuNodes: rootOuNodes.length,
      totalQuoiTypes: new Set(allEntities.flatMap(e => e.quoi_ids)).size
    };
  }

  private buildOuFirstTreeFiltered(filterOptions: FilterOptions): OuFirstTree {
    const allEntities = this.requireRegistry().getAllEntities().map(e => this.sanitizeEntity(e));
    let filtered = filterOptions.showOnlyActive !== false
      ? allEntities.filter(e => e.state !== 'unavailable')
      : allEntities;

    const catalog = this.requireRegistry().getQuoiCatalog();
    const entitiesWithOu: Array<{ entity: HaStructuredEntity; segments: OuSegment[] }> = [];

    for (const entity of filtered) {
      const segments = this.extractOuSegments(entity);
      if (segments.length > 0) entitiesWithOu.push({ entity, segments });
    }

    const rootOuNodes: OuNode[] = [];
    const ouNodeMap = new Map<string, OuNode>();
    for (const { entity, segments } of entitiesWithOu) {
      let currentParent: OuNode | null = null;
      for (let i = 0; i < segments.length; i++) {
        const { id: ouId, name: ouName, level } = segments[i]!;
        let ouNode = ouNodeMap.get(ouId);
        if (!ouNode) {
          ouNode = { id: ouId, name: ouName, level, children: [], entities: [], entityCount: 0, parentId: (currentParent as OuNode | null)?.id || null };
          ouNodeMap.set(ouId, ouNode);
          if (currentParent) currentParent.children.push(ouNode);
          else rootOuNodes.push(ouNode);
        }
        ouNode.entityCount++;
        if (i === segments.length - 1) ouNode.entities.push(entity);
        currentParent = ouNode;
      }
    }
    this.sortOuNodes(rootOuNodes);
    return {
      levels: this.buildOuWithQuoiNodes(rootOuNodes, catalog),
      unassigned: [],
      totalEntities: filtered.length,
      totalOuNodes: rootOuNodes.length,
      totalQuoiTypes: new Set(filtered.flatMap(e => e.quoi_ids)).size
    };
  }

  // ============ BUILD QUOI-FIRST TREE ============

  private buildQuoiFirstTree(): QuoiFirstTree {
    const allEntities = this.requireRegistry().getAllEntities().map(e => this.sanitizeEntity(e));
    const catalog = this.requireRegistry().getQuoiCatalog();

    const quoiGroups: QuiGroupWithOu[] = [];
    const quoiMap = new Map<string, QuiGroupWithOu>();

    for (const entity of allEntities) {
      for (const quoiId of entity.quoi_ids) {
        let group = quoiMap.get(quoiId);
        if (!group) {
          const quoiDef = catalog.find(q => q.quoi_id === quoiId) || { quoi_id: quoiId, label: quoiId, description: '' };
          group = { quoi: quoiDef, entityCount: 0, ouHierarchy: [], entitiesByOu: {} };
          quoiMap.set(quoiId, group);
          quoiGroups.push(group);
        }
        group!.entityCount++;
        const segments = this.extractOuSegments(entity);
        const ouKey = segments.map(s => s.id).join('/') || 'unassigned';
        if (!group!.entitiesByOu[ouKey]) group!.entitiesByOu[ouKey] = [];
        group!.entitiesByOu[ouKey].push(entity);
        this.updateOuHierarchyForQuoi(group!, segments);
      }
    }

    quoiGroups.sort((a, b) => b.entityCount - a.entityCount);
    const unassigned = allEntities
      .filter(e => this.extractOuSegments(e).length === 0)
      .map(e => ({ entity: e, ouPath: [], quoiIds: e.quoi_ids, device: e.device || null, area: e.area || null }));

    return {
      quoiGroups,
      unassigned,
      totalEntities: allEntities.length,
      totalQuoiTypes: quoiGroups.length,
      totalOuNodes: new Set(allEntities.flatMap(e => this.extractOuSegments(e).map(s => s.id))).size
    };
  }

  private buildQuoiFirstTreeFiltered(filterOptions: FilterOptions): QuoiFirstTree {
    const allEntities = this.requireRegistry().getAllEntities().map(e => this.sanitizeEntity(e));
    let filtered = filterOptions.showOnlyActive !== false
      ? allEntities.filter(e => e.state !== 'unavailable')
      : allEntities;

    const catalog = this.requireRegistry().getQuoiCatalog();
    const quoiGroups: QuiGroupWithOu[] = [];
    const quoiMap = new Map<string, QuiGroupWithOu>();

    for (const entity of filtered) {
      for (const quoiId of entity.quoi_ids) {
        let group = quoiMap.get(quoiId);
        if (!group) {
          const quoiDef = catalog.find(q => q.quoi_id === quoiId) || { quoi_id: quoiId, label: quoiId, description: '' };
          group = { quoi: quoiDef, entityCount: 0, ouHierarchy: [], entitiesByOu: {} };
          quoiMap.set(quoiId, group);
          quoiGroups.push(group);
        }
        group!.entityCount++;
        const segments = this.extractOuSegments(entity);
        const ouKey = segments.map(s => s.id).join('/') || 'unassigned';
        if (!group!.entitiesByOu[ouKey]) group!.entitiesByOu[ouKey] = [];
        group!.entitiesByOu[ouKey].push(entity);
      }
    }

    return {
      quoiGroups: quoiGroups.sort((a, b) => b.entityCount - a.entityCount),
      unassigned: [],
      totalEntities: filtered.length,
      totalQuoiTypes: quoiGroups.length,
      totalOuNodes: 0
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

  private updateOuHierarchyForQuoi(group: QuiGroupWithOu, segments: OuSegment[]): void {
    const existingIds = new Set(group.ouHierarchy.map(n => n.id));
    if (segments.length === 0 || existingIds.has(segments[0]!.id)) return;

    const newNodes: OuNode[] = [];
    let parent: OuNode | null = null;
    for (let i = 0; i < segments.length; i++) {
      const { id, name, level } = segments[i]!;
      const node: OuNode = {
        id,
        name,
        level,
        children: [],
        entities: [],
        entityCount: 0,
        parentId: parent?.id || null
      };
      newNodes.push(node);
      if (parent) parent.children.push(node);
      parent = node;
    }
    group.ouHierarchy.push(...newNodes);
  }

  private buildQuoiCatalog(): QuoiCatalogWithCounts[] {
    const catalog = this.requireRegistry().getQuoiCatalog();
    const allEntities = this.requireRegistry().getAllEntities();
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
      const rawEntity = this.requireRegistry().getEntity(entityId);
      if (!rawEntity) {
        this.eventBus.emit(ARBREOUQUOI_SOCKET_EVENTS.ERROR, { message: `Entité non trouvée: ${entityId}` });
        return;
      }
      const entity = this.sanitizeEntity(rawEntity);
      const ouSegments = this.extractOuSegments(entity);
      const myPath = ouSegments.map(s => s.id).join('/');
      const related = this.requireRegistry().getAllEntities()
        .map(e => this.sanitizeEntity(e))
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

  private emitSearchResults(query: string): void {
    this.emitTree();
  }
}

/**
 * Factory à 4 paramètres : AppService.startApplicationService() détecte l'arité (factory.length)
 * et fournit haStructureRegistry en 4ème argument (undefined si ha.ws_enable=false — voir
 * requireRegistry() ci-dessus pour la gestion de cette absence).
 *
 * ⚠️ Avant ce correctif, cette factory n'existait qu'à 3 paramètres et castait `configProvider`
 * en `HaStructureRegistry` (`as unknown as HaStructureRegistry`) faute de mécanisme d'injection —
 * plantait immédiatement (`getAllEntities is not a function`) dès le premier accès au référentiel.
 */
export function createArbreouquoiService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<ArbreouquoiConfig>,
  haStructureRegistry: HaStructureRegistry | undefined
): ArbreouquoiService {
  return new ArbreouquoiService(eventBus, logger, configProvider, haStructureRegistry);
}
