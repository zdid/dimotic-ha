import { FloorPlan } from '../models/FloorPlan';
import { ObjectManager } from '../services/ObjectManager';
import { PositionManager } from '../models/PositionManager';
import { DataService } from '../services/DataService';
import { EntitySelector } from './EntitySelector';

export class FloorPlanContainer {
  private container: HTMLElement;
  private floorPlan: FloorPlan;
  private objectManager: ObjectManager;
  private dataService: DataService;
  private positionManager: PositionManager;
  private canvas: HTMLElement | null = null;
  private unsubscribeState: (() => void) | null = null;
  
  constructor(container: HTMLElement, dataService: DataService) {
    this.container = container;
    this.dataService = dataService;

    // Initialiser avec le plan courant
    const currentFloorplanId = dataService.getCurrentFloorplanId();
    console.log(`FloorPlanContainer: Initialisation avec le plan courant: ${currentFloorplanId}`);

    this.positionManager = new PositionManager((floorplanId: string, positions: any, texts: any) => {
      console.log(`FloorPlanContainer: Mise à jour positions/textes pour ${floorplanId}`);
      // Fire-and-forget : pas d'attente de réponse
      this.dataService.updatePositionsForFloorplan(floorplanId, positions, texts);
    }, currentFloorplanId);

    this.floorPlan = new FloorPlan(container, this.positionManager);
    this.objectManager = new ObjectManager(this.floorPlan, this.positionManager, this.dataService);
  }

  async initialize(): Promise<void> {
    try {
      await this.loadFloorplan();
      this.initDataServiceListeners();
    } catch (error) {
      console.error('Erreur initialisation FloorPlanContainer:', error);
    }
  }

  private async loadFloorplan(): Promise<void> {
    try {
      const floorplan = this.dataService.getCurrentFloorplan();
      const currentFloorplanId = this.dataService.getCurrentFloorplanId();
      
      if (floorplan && floorplan.filename) {
        // Obtenir l'image depuis le cache de DataService
        const cachedImage = this.dataService.getFloorplanImage(currentFloorplanId);

        if (cachedImage) {
          console.log('Plan chargé depuis le cache:', currentFloorplanId);
          await this.floorPlan.loadPlanFromImage(cachedImage);
        } else {
          // Fallback : charger l'image si elle n'est pas en cache
          console.warn('Image non trouvée en cache, chargement depuis URL pour:', currentFloorplanId);
          const imagePath = this.dataService.getFloorplanImageUrl(floorplan.filename);
          await this.floorPlan.loadPlan(imagePath);
        }
      } else {
        // Aucun plan disponible du tout (ex: liste vide)
        this.container.style.backgroundColor = 'transparent';
        console.log('Pas de plan disponible, mode transparent');
      }

      await this.loadFloorplanObjects();
    } catch (error) {
      console.error('Erreur chargement du plan:', error);
    }
  }

  private async loadFloorplanObjects(): Promise<void> {
    try {
      // ✅ Récupérer les positions du plan courant
      const currentFloorplanId = this.dataService.getCurrentFloorplanId();
      const positions = this.dataService.getPositionsForFloorplan(currentFloorplanId);
      console.log('[FloorPlanContainer] loadFloorplanObjects: Récupération des positions pour le plan:', currentFloorplanId, positions);

      if (positions && positions.length > 0) {
        this.positionManager.loadPositions(currentFloorplanId, positions);
        console.log(`[FloorPlanContainer] Chargement de ${positions.length} objets pour le plan ${currentFloorplanId}`);

        positions.forEach((position: any) => {
          if (position.entity_id === "__trash_icon__") {
            return;
          }

          const state = this.dataService.getState(position.entity_id);
          const entity = this.dataService.getEntity(position.entity_id);

          console.log(`[FloorPlanContainer] Création objet ${position.entity_id}`, {
            hasState: !!state,
            state: state,
            hasEntity: !!entity
          });

          this.objectManager.createObjectFromConfig({
            entity_id: position.entity_id,
            position: position.position,
            state: state,
            entity: entity
          }, true);
        });
      }

      // ⭐ 07/09/2026 : pendant du chargement des positions ci-dessus, pour les textes libres.
      const texts = this.dataService.getTextsForFloorplan(currentFloorplanId);
      if (texts && texts.length > 0) {
        this.positionManager.loadTexts(currentFloorplanId, texts);
        console.log(`[FloorPlanContainer] Chargement de ${texts.length} texte(s) pour le plan ${currentFloorplanId}`);

        texts.forEach((t) => {
          this.objectManager.createTextFromConfig({
            id: t.id,
            text: t.text,
            position: { x: t.x, y: t.y },
            size: t.size,
            color: t.color
          }, true);
        });
      }
    } catch (error) {
      console.error('Erreur chargement objets:', error);
    }
  }

  private initDataServiceListeners(): void {
    // ❌ NE PAS écouter refresh ici !
    // Avec la nouvelle architecture multi-containers, c'est App.ts qui gère
    // le refresh global et qui appelle initializeAllFloorplans()
    // Si chaque container écoutait refresh, on aurait N rechargements en parallèle !

    // ✅ Écouter UNIQUEMENT les mises à jour d'état
    // Stocker la fonction de désabonnement pour pouvoir se désabonner au cleanup
    this.unsubscribeState = this.dataService.on('state', (data: any) => {
       if (data.entity_id && data.state) {
        if (this.objectManager.hasObject(data.entity_id)) {
          console.log(`[${this.dataService.getCurrentFloorplanId()}] Mise à jour état:`, data.entity_id, data);
          this.objectManager.updateObjectState(data.entity_id, data);
        }
      }
    });
  }

  async enableEditMode(): Promise<void> {
    console.log('Mode édition activé');
    await this.objectManager.enableEditMode();
  }

  async disableEditMode(): Promise<void> {
    console.log('Mode édition désactivé');

    // Forcer la sauvegarde immédiate des positions en attente
    this.positionManager.forceSave();

    this.objectManager.disableEditMode();
  }

  /** ⭐ 08/09/2026 : sauvegarde immédiate d'une modif encore en attente (debounce 5s, voir
   *  PositionManager) — utilisée par dashboard-app.ts sur `beforeunload`, seul cas non couvert par
   *  les appels forceSave() déjà en place (disableEditMode ci-dessus, cleanup() lors d'un
   *  changement de plan) : fermer l'onglet/quitter la page directement pendant les 5 secondes de
   *  debounce perdait silencieusement la modif, le timer JS étant détruit avec la page. */
  forceSave(): void {
    this.positionManager.forceSave();
  }

  createObjectFromConfig(config: any): void {
    console.log('Création objet:', config.entity_id);
    this.objectManager.createObjectFromConfig(config);
  }

  /** ⭐ 07/09/2026 : ajoute un nouveau texte libre au plan courant (bouton "Ajouter un texte",
   *  voir dashboard-app.ts) — un identifiant unique est généré ici (pas fourni par l'appelant,
   *  contrairement à `entity_id` pour une entité HA). */
  addText(text: string, position: { x: number; y: number } = { x: 0.5, y: 0.5 }): void {
    const id = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log('Création texte:', id);
    this.objectManager.createTextFromConfig({ id, text, position });
  }

  setObjectScale(scale: number): void {
    this.objectManager.setObjectScale(scale);
  }

  updateEntitySelector(entitySelector: EntitySelector): void {
    try {
      if (!entitySelector || typeof entitySelector.setExistingObjects !== 'function') {
        console.warn('EntitySelector non valide');
        return;
      }
      
      const existingObjectIds = Array.from(this.objectManager.getAllObjects())
        .map(obj => obj.getEntity_id());
      entitySelector.setExistingObjects(existingObjectIds);
      console.log('EntitySelector mis à jour');
    } catch (error) {
      console.error('Erreur mise à jour EntitySelector:', error);
    }
  }

  async uploadFloorplan(file: File, name: string, description?: string): Promise<void> {
    try {
      console.log(`Upload plan: ${name}`);
      await this.dataService.uploadFloorplan(file, name, description);
      
      // ✅ Le serveur envoie un refresh broadcast
      // Le listener refresh se charge du rechargement
      console.log('Plan uploadé, attente du refresh serveur');
    } catch (error: any) {
      console.error('Erreur upload plan:', error);
      throw error;
    }
  }

  async changeFloorplan(floorplanId: string): Promise<void> {
    try {
      console.log(`Changement vers le plan: ${floorplanId}`);
      
      // ✅ Changer le plan courant
      this.dataService.setCurrentFloorplanId(floorplanId);
      this.positionManager.setCurrentFloorplan(floorplanId);
      
      // ✅ Recharger le plan
      await this.loadFloorplan();
      
      console.log(`Plan changé vers ${floorplanId}`);
    } catch (error) {
      console.error('Erreur changement de plan:', error);
      throw error;
    }
  }

  sendCommand(entity_id: string, service: string, serviceData?: any): void {
    console.log(`Envoi commande: ${entity_id} -> ${service}`);
    this.dataService.sendCommand(entity_id, service, serviceData)
      .catch((error) => {
        console.error('Erreur envoi commande:', error);
      });
  }

  async deleteFloorplan(floorplanId: string): Promise<void> {
    try {
      console.log(`Suppression plan: ${floorplanId}`);
      await this.dataService.deleteFloorplan(floorplanId);
      
      // ✅ Le serveur envoie un refresh broadcast
      console.log('Plan supprimé, attente du refresh serveur');
    } catch (error: any) {
      console.error('Erreur suppression plan:', error);
      throw error;
    }
  }

  /**
   * Nettoie proprement le FloorPlanContainer
   * Supprime les listeners, détruit les objets, annule les timers
   */
  cleanup(): void {
    console.log(`[FloorPlanContainer] Nettoyage pour le plan ${this.dataService.getCurrentFloorplanId()}`);
    
    // ✅ Désabonner les listeners DataService
    if (this.unsubscribeState) {
      this.unsubscribeState();
      this.unsubscribeState = null;
      console.log('[FloorPlanContainer] Listener state désabonné');
    }
    
    // ⭐ 30/08/2026, bug réel trouvé en investigant un retour utilisateur ("les icônes reprennent
    // la place qu'elles avaient avant, peut-être lorsque plusieurs sont déplacées") : ce
    // commentaire disait déjà "forcer la sauvegarde", mais le code appelait `cleanup()` — qui
    // ANNULE le timer de sauvegarde différée (5s, PositionManager.scheduleSave) et VIDE la Map en
    // mémoire SANS jamais envoyer la dernière position au serveur. `cleanup()` est appelé à CHAQUE
    // changement de plan (dashboard-app.ts::showFloorplanNow) — tout déplacement fait dans les 5
    // dernières secondes avant de changer de plan était donc perdu silencieusement ; en revenant
    // sur ce plan, les positions rechargées depuis le serveur reflétaient l'ancien emplacement.
    // Plus probable avec plusieurs icônes déplacées à la suite : chaque déplacement réarme le
    // timer de 5s (debounce), laissant plus de chances qu'un changement de plan survienne avant
    // l'échéance. `forceSave()` (déjà existant, déjà utilisé par disableEditMode ci-dessus) envoie
    // la sauvegarde immédiatement avant de nettoyer.
    if (this.positionManager) {
      this.positionManager.forceSave();
      this.positionManager.cleanup();
    }
    
    // Détruire tous les objets
    if (this.objectManager) {
      const allObjects = this.objectManager.getAllObjects();
      allObjects.forEach(obj => {
        try {
          obj.destroy();
        } catch (error) {
          console.error(`Erreur lors de la destruction de l'objet ${obj.getEntity_id()}:`, error);
        }
      });
    }
    
    // Nettoyer le DOM
    if (this.container) {
      this.container.innerHTML = '';
    }
    
    console.log(`[FloorPlanContainer] Nettoyage terminé`);
  }

  updatePreferences(fontSize: number, fontColor: string): void {
    console.log(`Mise à jour préférences: fontSize=${fontSize}, fontColor=${fontColor}`);
    
    if (this.canvas) {
      const allElements = this.canvas.querySelectorAll('[data-entity-id]');
      allElements.forEach((element: Element) => {
        const htmlElement = element as HTMLElement;
        if (htmlElement.style) {
          htmlElement.style.fontSize = `${fontSize}px`;
          htmlElement.style.color = fontColor;
        }
      });
    }
  }

  getObjectManager(): ObjectManager {
    return this.objectManager;
  }

  getFloorPlan(): FloorPlan {
    return this.floorPlan;
  }

  /**
   * Force le recalcul des dimensions du plan
   * À appeler après avoir affiché le container (display: block)
   */
  recalculateDimensions(): void {
    console.log(`[FloorPlanContainer] Recalcul des dimensions pour ${this.dataService.getCurrentFloorplanId()}`);
    if (this.floorPlan) {
      this.floorPlan.forceResize();
    }
  }
}