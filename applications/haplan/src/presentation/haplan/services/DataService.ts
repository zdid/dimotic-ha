/**
 * DataService — adaptateur ws-ha du DataService original de haplanserver.
 *
 * Garde EXACTEMENT le même nom de classe et la même surface publique que l'original
 * (github.com/zdid/haplanserver, client/src/services/DataService.ts) pour que tous les fichiers
 * portés "quasi tels quels" (models/objects/**, components/FloorPlanContainer.ts,
 * services/ObjectManager.ts...) compilent sans aucune modification. Implémentation interne
 * entièrement différente : branchée sur Socket.io (SocketService, socle ws-ha) plutôt que sur le
 * WebSocket brut `{id,action,payload}` d'origine.
 *
 * Phase 1 : lecture d'état + commande sur les entités déjà placées sur un plan.
 * Phase 2 (voir plan de portage) : updatePositionsForFloorplan réellement implémenté (ajout,
 * déplacement, suppression d'icône passent tous par ce même chemin — voir PositionManager.ts) +
 * sélecteur d'entité (taxonomie QUOI/OÙ, onTaxonomyTree). uploadFloorplan/deleteFloorplan restent
 * des stubs (aucune route serveur — édition de plans différée à une Phase 3).
 */

import { SocketService } from '/js/ts/services/SocketService.js';

/** Singleton — même pattern que l'original (module var `dataService`, accesseur `getDataService()`),
 *  utilisé par ContextWindow.ts (fenêtres contextuelles) qui n'ont pas de référence directe. */
let dataServiceInstance: DataService;

interface HaplanFloorplan {
  filename: string;
  positions: Array<{ entity_id: string; x: number | null; y: number | null }>;
}

type StateListener = (data: { entity_id: string; state: string; attributes: Record<string, unknown> }) => void;

export class DataService {
  private socket: any;
  private connected = false;

  private states: Map<string, { state: string; attributes: Record<string, unknown> }> = new Map();
  private floorplans: Map<string, HaplanFloorplan> = new Map();
  private floorplanImages: Map<string, HTMLImageElement> = new Map();
  private currentFloorplanId = '';

  private stateListeners: Set<StateListener> = new Set();
  private floorplansReadyListeners: Set<() => void> = new Set();
  private floorplansReady = false;
  private taxonomyTreeListeners: Set<(areas: any[]) => void> = new Set();
  private deployStartedListeners: Set<(data: { floorplanId: string }) => void> = new Set();
  private deployResultListeners: Set<(data: { floorplanId?: string; ok: boolean; message: string; durationMs: number }) => void> = new Set();
  private errorListeners: Set<(error: { code?: string; message: string }) => void> = new Set();

  constructor() {
    dataServiceInstance = this;

    const socketService = new SocketService();
    this.socket = socketService.connect();

    this.socket.on('connect', () => { this.connected = true; });
    this.socket.on('disconnect', () => { this.connected = false; });

    this.socket.on('haplan:floorplans:list', (data: { floorplans: Record<string, HaplanFloorplan> }) => {
      this.floorplans = new Map(Object.entries(data.floorplans || {}));
      if (!this.currentFloorplanId) {
        const firstId = this.floorplans.keys().next().value;
        if (firstId) this.currentFloorplanId = firstId;
      }
      this.preloadFloorplanImages();
      this.floorplansReady = true;
      this.floorplansReadyListeners.forEach((cb) => cb());
    });

    this.socket.on('haplan:entities:state:bulk', (data: { states: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }> }) => {
      for (const s of data.states || []) {
        this.states.set(s.entity_id, { state: s.state, attributes: s.attributes });
        this.notifyStateListeners(s);
      }
    });

    this.socket.on('haplan:entity:state', (data: { entity_id: string; state: string; attributes: Record<string, unknown> }) => {
      this.states.set(data.entity_id, { state: data.state, attributes: data.attributes });
      this.notifyStateListeners(data);
    });

    this.socket.on('haplan:error', (error: { code?: string; message: string }) => {
      console.error('[DataService] Erreur serveur:', error.message);
      this.errorListeners.forEach((cb) => cb(error));
    });

    this.socket.on('haplan:taxonomy:tree', (data: { areas: any[] }) => {
      this.taxonomyTreeListeners.forEach((cb) => cb(data.areas || []));
    });

    this.socket.on('haplan:floorplan:deploy:started', (data: { floorplanId: string }) => {
      this.deployStartedListeners.forEach((cb) => cb(data));
    });

    this.socket.on('haplan:floorplan:deploy:result', (data: { floorplanId?: string; ok: boolean; message: string; durationMs: number }) => {
      this.deployResultListeners.forEach((cb) => cb(data));
    });

    this.socket.emit('haplan:floorplans:list:get');
    this.socket.emit('haplan:taxonomy:tree:get');
  }

  private notifyStateListeners(data: { entity_id: string; state: string; attributes: Record<string, unknown> }): void {
    this.stateListeners.forEach((cb) => cb(data));
  }

  private preloadFloorplanImages(): void {
    this.floorplans.forEach((floorplan, id) => {
      if (this.floorplanImages.has(id) || !floorplan.filename) return;
      const img = new Image();
      img.onload = () => this.floorplanImages.set(id, img);
      img.src = this.getFloorplanImageUrl(floorplan.filename);
    });
  }

  // ==========================================================================
  // Connexion
  // ==========================================================================

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.socket?.disconnect();
  }

  async refresh(): Promise<void> {
    this.socket.emit('haplan:floorplans:list:get');
  }

  // ==========================================================================
  // Abonnement aux notifications ('state' — seul type utilisé en Phase 1)
  // ==========================================================================

  on(event: 'state', callback: StateListener): () => void {
    if (event !== 'state') return () => {};
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /** Non présent dans le DataService original — utilisé uniquement par notre propre bootstrap
   *  (dashboard-app.ts) pour savoir quand la première liste de plans est disponible. */
  onFloorplansReady(callback: () => void): void {
    if (this.floorplansReady) { callback(); return; }
    this.floorplansReadyListeners.add(callback);
  }

  // ==========================================================================
  // États / entités
  // ==========================================================================

  getState(entity_id: string): { state: string; attributes: Record<string, unknown> } | undefined {
    return this.states.get(entity_id);
  }

  getStates(): Record<string, { state: string; attributes: Record<string, unknown> }> {
    return Object.fromEntries(this.states);
  }

  /** Phase 1 : pas d'arborescence area/device côté client (voir Phase 2, sélecteur QUOI/OÙ) —
   *  seul `name` (friendly_name HA) est disponible, dérivé de l'état déjà reçu. */
  getEntity(entity_id: string): { area_name?: string; device_name?: string; name?: string } | undefined {
    const state = this.states.get(entity_id);
    if (!state) return undefined;
    const friendlyName = state.attributes?.friendly_name;
    return { name: typeof friendlyName === 'string' ? friendlyName : entity_id };
  }

  getNameEntity(entity_id: string): string {
    const entity = this.getEntity(entity_id);
    return entity?.name || entity_id;
  }

  /** Nom d'affichage dérivé de la taxonomie QUOI/OÙ (quoi + lieu précis + lieu), même convention que
   *  RFXCOM (rfxcom/src/domain/taxonomy.ts::buildBoutonDisplayName) — ex: "Lumière Plan travail
   *  Cuisine" plutôt que le friendly_name HA brut. Retombe sur ce dernier si l'entité n'a pas
   *  (encore) de taxonomie publiée (attributs_taxonomie, déjà présent dans l'état reçu, voir
   *  TaxonomyHaClassifier côté serveur). */
  getTaxonomyDisplayName(entity_id: string): string {
    const attributes = this.states.get(entity_id)?.attributes;
    const taxonomy = attributes?.attributs_taxonomie as
      | { quoi?: string; lieu_precis?: string; lieu_principal?: string }
      | undefined;
    if (!taxonomy?.quoi) return this.getNameEntity(entity_id);

    const parts = [taxonomy.quoi];
    if (taxonomy.lieu_precis) parts.push(taxonomy.lieu_precis);
    if (taxonomy.lieu_principal && taxonomy.lieu_principal !== taxonomy.lieu_precis) {
      parts.push(taxonomy.lieu_principal);
    }
    return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }

  /** Phase 1 : pas d'arborescence area/device côté client (voir Phase 2) — toujours vide. */
  getAreaNameOfEntity(_entity_id: string): string {
    return '';
  }

  // ==========================================================================
  // Plans
  // ==========================================================================

  getAllFloorplans(): Record<string, HaplanFloorplan> {
    return Object.fromEntries(this.floorplans);
  }

  getFloorplan(id: string): HaplanFloorplan | undefined {
    return this.floorplans.get(id);
  }

  getCurrentFloorplanId(): string {
    return this.currentFloorplanId;
  }

  setCurrentFloorplanId(id: string): void {
    this.currentFloorplanId = id;
  }

  getCurrentFloorplan(): HaplanFloorplan | undefined {
    return this.floorplans.get(this.currentFloorplanId);
  }

  getPositionsForFloorplan(id: string): Array<{ entity_id: string; position: { x: number; y: number } }> {
    const floorplan = this.floorplans.get(id);
    if (!floorplan) return [];
    return floorplan.positions
      .filter((p) => p.x !== null && p.y !== null)
      .map((p) => ({ entity_id: p.entity_id, position: { x: p.x as number, y: p.y as number } }));
  }

  getFloorplanImage(id: string): HTMLImageElement | undefined {
    return this.floorplanImages.get(id);
  }

  getFloorplanImageUrl(filename: string): string {
    return `/data/haplan/images/${encodeURIComponent(filename)}`;
  }

  // ==========================================================================
  // Commandes
  // ==========================================================================

  sendCommand(entity_id: string, fullService: string, serviceData?: Record<string, unknown>): Promise<void> {
    const [domain, service] = fullService.split('.');
    if (!domain || !service) {
      return Promise.reject(new Error(`Service invalide: ${fullService}`));
    }
    this.socket.emit('haplan:entity:command', { entity_id, domain, service, serviceData });
    return Promise.resolve();
  }

  // ==========================================================================
  // Édition de plans (Phase 3 — voir plan de portage)
  // ==========================================================================

  /**
   * Upload en REST classique (`POST /api/haplan/floorplans/upload`, multipart), pas en Socket.io —
   * exception documentée dans PresentationServer.ts (un transfert binaire n'est pas le problème
   * que Socket.io résout dans ce projet). Le résultat réel (plan créé ou `haplan:error`) arrive
   * par le canal habituel (`haplan:floorplans:list`) — cette méthode ne fait que vérifier que la
   * requête HTTP elle-même a été acceptée (mauvais type de fichier → rejet immédiat).
   */
  async uploadFloorplan(file: File, name: string, _description?: string): Promise<void> {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('floorplanId', name);

    const response = await fetch('/api/haplan/floorplans/upload', { method: 'POST', body: formData });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(body.message || `Échec de l'upload (${response.status})`);
    }
  }

  async deleteFloorplan(floorplanId: string): Promise<void> {
    this.socket.emit('haplan:floorplan:delete', { floorplanId });
  }

  /** Déploiement du plan sur l'écran ESP physique (voir applications/espdisplay) — asynchrone,
   *  résultat livré via onDeployResult() (compilation ESPHome : 15-65s selon le cache). */
  deployFloorplan(floorplanId: string): void {
    this.socket.emit('haplan:floorplan:deploy', { floorplanId });
  }

  onDeployStarted(callback: (data: { floorplanId: string }) => void): void {
    this.deployStartedListeners.add(callback);
  }

  onDeployResult(callback: (data: { floorplanId?: string; ok: boolean; message: string; durationMs: number }) => void): void {
    this.deployResultListeners.add(callback);
  }

  onError(callback: (error: { code?: string; message: string }) => void): void {
    this.errorListeners.add(callback);
  }

  /** Ajout/déplacement/suppression d'icône — PositionManager.ts envoie toujours la liste COMPLÈTE
   *  des positions du plan (jamais un delta), sous la forme {entity_id, position:{x,y}}[]. */
  updatePositionsForFloorplan(floorplanId: string, positions: Array<{ entity_id: string; position: { x: number; y: number } }>): void {
    const flatPositions = positions.map((p) => ({ entity_id: p.entity_id, x: p.position.x, y: p.position.y }));
    this.socket.emit('haplan:floorplan:positions:update', { floorplanId, positions: flatPositions });
  }

  /** Non présent dans le DataService original — sélecteur d'entité (voir plan de portage Phase 2). */
  onTaxonomyTree(callback: (areas: any[]) => void): void {
    this.taxonomyTreeListeners.add(callback);
  }
}

export function getDataService(): DataService {
  return dataServiceInstance;
}
