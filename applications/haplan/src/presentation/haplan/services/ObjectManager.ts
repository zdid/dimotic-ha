import { HAObject } from '../models/objects/HAObject';
import { UnifiedObjectFactory } from '../models/objects/UnifiedObjectFactory';
import { FloorPlan } from '../models/FloorPlan';
import { PositionManager } from '../models/PositionManager';
import { DataService } from './DataService';
import { BaseEntity } from '../models/objects/BaseEntity';

//import { DataService, getDataService } from './DataService'

export class ObjectManager {
  private floorPlan: FloorPlan;
  private positionManager: PositionManager;
  private objects: Map<string, HAObject> = new Map();
  private commandService : DataService;
  private objectScale: number = 1;
  

  constructor(floorPlan: FloorPlan, positionManager: PositionManager, commandService: DataService) {
    this.floorPlan = floorPlan;
    this.positionManager = positionManager;
    this.commandService = commandService;
   }

  async createObjectFromConfig(config: any, skipSave: boolean = false): Promise<HAObject> {
    const existingPosition = this.positionManager.getPosition(config.entity_id);
    const position = existingPosition || config.position;

    const existingObject = this.objects.get(config.entity_id);
    if (existingObject) {
      console.warn(`[ObjectManager] Objet déjà existant pour ${config.entity_id}, suppression avant recréation`);
      this.floorPlan.removeObject(config.entity_id);
      this.objects.delete(config.entity_id);
    }

    console.log(`[ObjectManager] createObjectFromConfig ${config.entity_id}`, {
      hasState: !!config.state,
      state: config.state,
      position: position
    });
    
    // Utiliser la nouvelle fabrique unifiée
    const { entity, cwindow: cwindow } = UnifiedObjectFactory.createObjectWithWindow(
      config.entity_id,
      position,
      config.state,
      this.commandService
    );
    if (entity instanceof BaseEntity) {
      entity.applyScale(this.objectScale);
    }
    // Injecter le PositionManager
    entity.setPositionManager(this.positionManager);

    this.objects.set(config.entity_id, entity);
    this.floorPlan.addObject(entity);

    // Appliquer l'état après que l'objet soit ajouté au DOM
    if (config.state) {
      console.log(`[ObjectManager] Appel updateState pour ${config.entity_id}`, config.state);
      entity.updateState(config.state);
    } else {
      console.warn(`[ObjectManager] Pas d'état pour ${config.entity_id}`);
    }

    // Si une position existe déjà, l'appliquer
    if (position) {
      entity.setPosition(position.x, position.y);
    }

    // Si c'est un nouvel objet (pas de position existante), enregistrer la position
    // sauf si on est en chargement initial
    if (!existingPosition && position && !skipSave) {
      console.log(`[ObjectManager] Nouvelle position enregistrée pour ${config.entity_id}`, position);
      this.positionManager.updatePosition(config.entity_id, position.x, position.y, false);
    }

    // NE PAS enregistrer la position dans le PositionManager lors du chargement initial
    // Les positions seront enregistrées automatiquement lors des modifications par drag & drop
    // via les événements 'positionupdate' gérés par HAObject

    // Si le mode édition est activé, activer le drag pour le nouvel objet
    // Vérifier si le conteneur a la classe edit-mode
    if (this.floorPlan && this.floorPlan['container']?.classList.contains('edit-mode')) {
      try {
        await entity.enableDrag();
      } catch (error) {
        console.error(`Failed to enable drag for new object ${config.entity_id}:`, error);
        // Ne pas empêcher la création de l'objet si le drag échoue
      }
    }

    return entity;
  }

  setObjectScale(scale: number): void {
    this.objectScale = scale;
    this.objects.forEach(object => {
      if (object instanceof BaseEntity) {
        object.applyScale(scale);
      }
    });
  }

  updateObjectState(entity_id: string, state: any): void {
    const object = this.objects.get(entity_id);
    console.log(`[ObjectManager] updateObjectState appelé pour ${entity_id}`, state, object ? 'objet trouvé' : 'objet NON trouvé');
    if (object) {
      object.updateState(state);
    }
  }

  removeObject(entity_id: string): void {
    const object = this.objects.get(entity_id);
    if (object) {
      this.floorPlan.removeObject(entity_id);
      this.objects.delete(entity_id);
      this.positionManager.removePosition(entity_id);
    }
  }

  getObject(entity_id: string): HAObject | undefined {
    return this.objects.get(entity_id);
  }

  /**
   * Vérifie si un objet existe dans le manager
   * @param entity_id - ID de l'entité à vérifier
   * @returns true si l'objet existe, false sinon
   */
  hasObject(entity_id: string): boolean {
    return this.objects.has(entity_id);
  }

  getAllObjects(): HAObject[] {
    return Array.from(this.objects.values());
  }

  async enableEditMode(): Promise<void> {
    this.floorPlan.enableEditMode();
    // Activer le drag-and-drop pour tous les objets
    const enableDragPromises = Array.from(this.objects.values()).map(object => {
      return object.enableDrag();
    });
    
    try {
      await Promise.all(enableDragPromises);
      console.log('All objects drag enabled successfully');
    } catch (error) {
      console.error('Failed to enable drag for some objects:', error);
      throw error;
    }
  }

  disableEditMode(): void {
    this.floorPlan.disableEditMode();
    // Désactiver le drag-and-drop pour tous les objets
    this.objects.forEach(object => {
      object.disableDrag();
    });
  }

  setCommandService(commandService: DataService): void {
    this.commandService = commandService;
    // Mettre à jour tous les objets existants
    this.objects.forEach(object => {
      object.setCommandService(commandService);
    });
  }
}