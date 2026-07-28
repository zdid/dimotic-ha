import { DragAndDropConstrained } from '../ui/draganddropconstrained';
import { HAObject } from './objects/HAObject';
import { PositionManager } from './PositionManager';


export class FloorPlan {
  private container: HTMLElement;
  private planImage: HTMLImageElement | null = null;
  private objects: Map<string, HAObject> = new Map();
  private scale: number = 1;
  private offset: {x: number, y: number} = {x: 0, y: 0};
  private lastMousePosition: { x: number, y: number } | null = null;
  private dragContainer: HTMLElement| null = null;
  private dragContainerId: string | null = null;
  private trashIconId: string | null = null;
  private positionManager: PositionManager | undefined;
  private measurementDiv: HTMLElement | null = null; // Div de référence pour les mesures
;
  private trashPosition: {x: number, y: number} = {x: 0.95, y: 0.05}; // Position de la poubelle en pourcentages

  constructor(container: HTMLElement, positionManager?: PositionManager) {
    this.container = container;
    this.positionManager = positionManager;
    this.initContainer();
    this.createDragContainer(); 
    this.trackMousePosition();
    // S'assurer que le mode paramétrage est désactivé au démarrage
    this.disableEditMode();
    
    // Initialiser les dimensions du dragContainer par défaut (sera mis à jour quand le plan sera chargé)
    if (this.dragContainer) {
      this.dragContainer.style.width = '100%';
      this.dragContainer.style.height = '100%';
      // Les objets seront positionnés après le chargement du plan
    }
  }

  private initContainer(): void {
    this.container.className = 'floorplan-container';
    this.container.style.position = 'relative';
    this.container.style.overflow = 'hidden';
    
    // Créer un div de référence pour mesurer les dimensions réelles
    // Même quand le container parent est en display:none
    this.measurementDiv = document.createElement('div');
    this.measurementDiv.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      visibility: hidden;
      z-index: -1;
    `;
    this.container.appendChild(this.measurementDiv);
    
    this.setupResizeListener();
  }

  private createDragContainer(): void {
    const containerIdPrefix = this.getContainerIdPrefix();

    this.dragContainer = document.createElement('div');
    this.dragContainerId = `${containerIdPrefix}-drag-container`;
    this.dragContainer.id = this.dragContainerId;
    this.dragContainer.className = 'floorplan-drag-container';
    this.dragContainer.style.position = 'absolute';
    this.dragContainer.style.top = '50%';
    this.dragContainer.style.left = '50%';
    this.dragContainer.style.transform = 'translate(-50%, -50%)';
    this.dragContainer.style.border = '1px solid #CCCCCC'; // Contour gris clair permanent
    this.dragContainer.style.pointerEvents = 'auto'; // Permettre les interactions
    this.container.appendChild(this.dragContainer);
    this.createTrashIcon(); // Puis créer la poubelle
  
  }

  private getContainerIdPrefix(): string {
    return this.container.id || 'floorplan';
  }

  loadPlan(url: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.planImage) {
        this.planImage.remove();
      }

      this.planImage = new Image();
      this.planImage.src = url;
      this.planImage.className = 'floorplan-image';
      this.planImage.style.maxWidth = '100%';
      this.planImage.style.maxHeight = '100%';

      this.planImage.onload = () => {
        this.resizePlanAndContainer(); // Adapter le plan au conteneur
        if (this.planImage) {
          this.container.appendChild(this.planImage);
        }
        
        // Repositionner tous les objets existants après le chargement du plan
        // Cela garantit que les objets sont correctement centrés et positionnés
        // par rapport au nouveau plan chargé
        this.objects.forEach(object => {
          const element = object.getElement() || object.render();
          if (this.dragContainer && element.parentElement !== this.dragContainer) {
            this.dragContainer.appendChild(element);
          }
          this.positionObjectElement(element, object.getPosition());
        });
        
        resolve();
      };
    });
  }

  loadPlanFromImage(image: HTMLImageElement): Promise<void> {
    return new Promise((resolve) => {
      if (this.planImage) {
        this.planImage.remove();
      }

      // Cloner l'image pour éviter les conflits
      this.planImage = image.cloneNode(true) as HTMLImageElement;
      this.planImage.className = 'floorplan-image';
      this.planImage.style.maxWidth = '100%';
      this.planImage.style.maxHeight = '100%';

      // Attendre que l'image soit complètement chargée et le DOM mis à jour
      requestAnimationFrame(() => {
        this.resizePlanAndContainer(); // Adapter le plan au conteneur
        this.container.appendChild(this.planImage!);
        
        // Double requestAnimationFrame pour garantir que le DOM est stable
        // et que le container parent a ses dimensions finales
        requestAnimationFrame(() => {
          // Re-calculer pour être sûr d'avoir les bonnes dimensions
          this.resizePlanAndContainer();
          
          this.objects.forEach(object => {
            const element = object.getElement() || object.render();
            if (this.dragContainer && element.parentElement !== this.dragContainer) {
              this.dragContainer.appendChild(element);
            }
            this.positionObjectElement(element, object.getPosition());
          });
          
          resolve();
        });
      });
    });
  }

  private calculateScale(): void {
    if (!this.planImage) return;

    const containerRect = this.container.getBoundingClientRect();
    const imageRect = {
      width: this.planImage.naturalWidth,
      height: this.planImage.naturalHeight
    };

    // Calculer les ratios pour adapter le plan au conteneur
    const widthRatio = containerRect.width / imageRect.width;
    const heightRatio = containerRect.height / imageRect.height;
    
    // Utiliser le ratio qui permet au plan de s'adapter complètement au conteneur
    // en maintenant les proportions (le plan ne dépasse jamais du conteneur)
    this.scale = Math.min(widthRatio, heightRatio);

    const scaledWidth = imageRect.width * this.scale;
    const scaledHeight = imageRect.height * this.scale;

    this.planImage!.style.width = `${scaledWidth}px`;
    this.planImage!.style.height = `${scaledHeight}px`;
    
    // Forcer le recalcul du layout
    this.planImage!.style.maxWidth = 'none';
    this.planImage!.style.maxHeight = 'none';
    
    // Centrer le plan dans le conteneur
    this.planImage!.style.position = 'absolute';
    this.planImage!.style.left = '50%';
    this.planImage!.style.top = '50%';
    this.planImage!.style.transform = 'translate(-50%, -50%)';
    
    // Mettre à jour les dimensions du conteneur de drag-and-drop pour correspondre au plan
    if (this.dragContainer) {
      this.dragContainer.style.width = `${scaledWidth}px`;
      this.dragContainer.style.height = `${scaledHeight}px`;
      
      // Repositionner tous les objets existants après le chargement du plan
      this.positionAllObjects();
    }
    
  }

  addObject(object: HAObject): void {
    this.objects.set(object.getEntity_id(), object);
    const element = object.render();
    this.dragContainer!.appendChild(element);
    // Positionner l'objet immédiatement
    this.positionObjectElement(element, object.getPosition());
  }

  /**
   * Méthode unique pour dimensionner le plan et le dragContainer
   * Utilisée à la fois pour le chargement initial et le redimensionnement
   */
  private resizePlanAndContainer(): void {
    if (!this.planImage) {
      console.warn('Aucune image de plan chargée, impossible de calculer l échelle');
      return;
    }

    // Utiliser le measurementDiv pour obtenir les dimensions réelles
    // Même si le container parent est en display:none
    const measurementRect = this.measurementDiv?.getBoundingClientRect();
    
    if (!measurementRect || measurementRect.width === 0 || measurementRect.height === 0) {
      console.warn('[FloorPlan] Dimensions du measurementDiv nulles, utilisation du container');
      // Fallback sur le container si le measurementDiv a des dimensions nulles
      const containerRect = this.container.getBoundingClientRect();
      if (containerRect.width === 0 || containerRect.height === 0) {
        console.warn('[FloorPlan] Container et measurementDiv ont des dimensions nulles, impossible de dimensionner');
        return;
      }
    }
    
    const containerWidth = measurementRect?.width || this.container.getBoundingClientRect().width;
    const containerHeight = measurementRect?.height || this.container.getBoundingClientRect().height;
    
    console.log(`[FloorPlan] Dimensions disponibles: ${containerWidth}x${containerHeight}`);

    const imageRect = {
      width: this.planImage.naturalWidth,
      height: this.planImage.naturalHeight
    };

    // Calculer les ratios pour adapter le plan au conteneur
    const widthRatio = containerWidth / imageRect.width;
    const heightRatio = containerHeight / imageRect.height;
    
    // Utiliser le ratio qui permet au plan de s'adapter complètement au conteneur
    // en maintenant les proportions (le plan ne dépasse jamais du conteneur)
    this.scale = Math.min(widthRatio, heightRatio);

    const scaledWidth = imageRect.width * this.scale;
    const scaledHeight = imageRect.height * this.scale;
    
    console.log(`[FloorPlan] Plan dimensionné: ${scaledWidth}x${scaledHeight} (scale: ${this.scale})`);

    // Dimensionner le plan
    this.planImage!.style.width = `${scaledWidth}px`;
    this.planImage!.style.height = `${scaledHeight}px`;
    
    // Forcer le recalcul du layout
    this.planImage!.style.maxWidth = 'none';
    this.planImage!.style.maxHeight = 'none';
    
    // Centrer le plan dans le conteneur
    this.planImage!.style.position = 'absolute';
    this.planImage!.style.left = '50%';
    this.planImage!.style.top = '50%';
    this.planImage!.style.transform = 'translate(-50%, -50%)';
    
    // Mettre à jour les dimensions du dragContainer pour correspondre au plan
    if (this.dragContainer) {
      this.dragContainer.style.width = `${scaledWidth}px`;
      this.dragContainer.style.height = `${scaledHeight}px`;
      
      // Repositionner tous les objets après le dimensionnement
      this.positionAllObjects();
    }
  }
  
  /**
   * Positionne tous les objets par rapport au dragContainer
   * Méthode unique pour le positionnement, utilisée à l'initialisation et au redimensionnement
   */
  private positionAllObjects(): void {
    if (!this.dragContainer) {
      console.warn('dragContainer non initialisé, impossible de positionner les objets');
      return;
    }
    
    const dragContainerRect = this.dragContainer.getBoundingClientRect();
    if (dragContainerRect.width === 0 || dragContainerRect.height === 0) {
      console.warn('dragContainer a des dimensions nulles, impossible de positionner les objets');
      return;
    }
    
    this.objects.forEach(object => {
      const element = object.getElement() || object.render();
      if (this.dragContainer && element.parentElement !== this.dragContainer) {
        this.dragContainer.appendChild(element);
      }
      const position = object.getPosition();
      
      // Positionner l'élément en pourcentage par rapport au dragContainer
      element.style.position = 'absolute';
      element.style.left = `${position.x * 100}%`;
      element.style.top = `${position.y * 100}%`;
      element.style.transform = 'translate(-50%, -50%)';
    });
  }
  
  private positionObjectElement(element: HTMLElement, position: {x: number, y: number}): void {
    // Cette méthode est conservée pour compatibilité mais délègue à positionAllObjects
    // lorsque tous les objets doivent être repositionnés
    element.style.position = 'absolute';
    element.style.left = `${position.x * 100}%`;
    element.style.top = `${position.y * 100}%`;
    element.style.transform = 'translate(-50%, -50%)';
  }

  removeObject(entity_id: string): void {
    const object = this.objects.get(entity_id);
    if (object) {
      object.destroy();
      this.objects.delete(entity_id);
    }
  }

  getObject(entity_id: string): HAObject | undefined {
    return this.objects.get(entity_id);
  }

  getAllObjects(): HAObject[] {
    return Array.from(this.objects.values());
  }

  enableEditMode(): void {
    this.container.classList.add('edit-mode');
    this.showTrashIcon();
    this.showDragContainerBorder();
  }

  disableEditMode(): void {
    this.container.classList.remove('edit-mode');
    this.hideTrashIcon();
    this.hideDragContainerBorder();
  }

  /**
   * Force le recalcul des dimensions du plan et du dragContainer
   * Utile après avoir affiché un container qui était caché
   */
  forceResize(): void {
    console.log('[FloorPlan] ForceResize: Recalcul des dimensions');
    this.resizePlanAndContainer();
  }

  private showDragContainerBorder(): void {
    if (this.dragContainer) {
      // En mode édition : contour vert + liseré pointillé vert
      this.dragContainer.style.border = '3px solid #4CAF50';
      this.dragContainer.style.outline = '2px dashed #2E7D32';
      this.dragContainer.style.outlineOffset = '2px';
    }
  }

  private hideDragContainerBorder(): void {
    if (this.dragContainer) {
      // En mode normal : contour gris clair permanent
      this.dragContainer.style.border = '1px solid #CCCCCC';
      this.dragContainer.style.outline = 'none';
    }
  }

  private setupResizeListener(): void {
    const debounce = (func: Function, wait: number) => {
      let timeout: NodeJS.Timeout;
      return function executedFunction(...args: any[]) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    };

    window.addEventListener('resize', debounce(() => {
      this.resizePlanAndContainer(); // Recalculer l'échelle et dimensionner lors du redimensionnement
    }, 200));
  }

  private createTrashIcon(): void {
    const containerIdPrefix = this.getContainerIdPrefix();

    const trashIcon = document.createElement('div');
    trashIcon.className = 'trash-icon';
    this.trashIconId = `${containerIdPrefix}-trash-icon`;
    trashIcon.id = this.trashIconId;
    trashIcon.innerHTML = '<i class="fas fa-trash-alt"></i>';
    trashIcon.style.display = 'none';
    trashIcon.style.position = 'absolute';
    trashIcon.style.width = '40px';
    trashIcon.style.height = '40px';
    trashIcon.style.background = '#f44336';
    trashIcon.style.borderRadius = '50%';
    trashIcon.style.display = 'flex';
    trashIcon.style.alignItems = 'center';
    trashIcon.style.justifyContent = 'center';
    trashIcon.style.color = 'white';
    trashIcon.style.fontSize = '20px';
    trashIcon.style.cursor = 'move';
    trashIcon.style.zIndex = '99';
    
    // Ajouter un gestionnaire pour empêcher le clic
    trashIcon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    
    // Ajouter la poubelle au dragContainer
    this.dragContainer!.appendChild(trashIcon);
    
    // Position initiale de la poubelle (en pourcentages)
    this.positionTrashIcon(trashIcon, {x: 0.95, y: 0.05}); // En haut à droite par défaut
  }
  
  /**
   * Positionne la poubelle dans le dragContainer
   * @param trashIcon L'élément de la poubelle
   * @param position La position en pourcentages (0-1)
   */
  private positionTrashIcon(trashIcon: HTMLElement, position: {x: number, y: number}): void {
    // Positionner comme les entités: en pourcentages avec centrage
    trashIcon.style.left = `${position.x * 100}%`;
    trashIcon.style.top = `${position.y * 100}%`;
    trashIcon.style.transform = 'translate(-50%, -50%)';
    
    // Sauvegarder la position
    this.trashPosition = position;
  }
  
  /**
   * Rend la poubelle déplaçable avec les mêmes règles que les entités
   */
  private makeTrashIconDraggable(): void {
    const trashIcon = this.getTrashIconElement();
    if (!trashIcon) {
      console.warn('Trash icon not found, cannot make it draggable');
      return;
    }
    
    // Créer un callback pour la fin du drag de la poubelle
    const onTrashDragEnd = (finalPosition: {x: number, y: number}) => {
      console.log('[TRACE] FloorPlan - Fin du drag de la poubelle à:', finalPosition);
      
      // Convertir les coordonnées pixels en pourcentages
      const containerRect = this.dragContainer?.getBoundingClientRect();
      if (containerRect) {
        const x = finalPosition.x / containerRect.width;
        const y = finalPosition.y / containerRect.height;
        
        // Sauvegarder la position
        this.trashPosition = {x, y};
        
        // Sauvegarder via le PositionManager avec un nom spécial
        // Utiliser un entity_id spécial pour la poubelle pour éviter les confusions
        const trashEntity_id = '__trash_icon__'; // Nom spécial pour la poubelle
        
        // Si le PositionManager existe, mettre à jour la position
        if (this.positionManager) {
          this.positionManager.updatePosition(trashEntity_id, x, y);
        }
        
        console.log('[TRACE] FloorPlan - Position de la poubelle sauvegardée:', {x, y});
      }
    };
    
    // Utiliser DragAndDropConstrained pour la poubelle (mode center)
    const trashSelector = this.trashIconId ? `#${this.trashIconId}` : '.trash-icon';
    new DragAndDropConstrained(trashSelector, onTrashDragEnd, 'center');
  }

  private showTrashIcon(): void {
    const trashIcon = this.container.querySelector('.trash-icon') as HTMLElement;
    if (trashIcon) {
      trashIcon.style.display = 'flex';
      this.setupTrashDropZone();
      // Activer le drag pour la poubelle uniquement en mode paramétrage
      if (this.container.classList.contains('edit-mode')) {
        this.makeTrashIconDraggable();
        console.log('[TRACE] FloorPlan - Drag de la poubelle activé - mode paramétrage');
      } else {
        console.log('[TRACE] FloorPlan - Mode normal - drag de la poubelle non activé');
      }
    }
  }

  private hideTrashIcon(): void {
    const trashIcon = this.container.querySelector('.trash-icon') as HTMLElement;
    if (trashIcon) {
      trashIcon.style.display = 'none';
      this.cleanupTrashDropZone();
      this.disableTrashIconDrag(); // Désactiver le drag en mode normal
    }
  }

  /**
   * Désactive le drag-and-drop pour l'icône de la poubelle
   * Appelé lorsque l'on quitte le mode paramétrage
   */
  private disableTrashIconDrag(): void {
    const trashIcon = this.getTrashIconElement();
    if (trashIcon) {
      // Supprimer tous les gestionnaires d'événements de drag
      const clone = trashIcon.cloneNode(true);
      trashIcon.parentNode?.replaceChild(clone, trashIcon);
      console.log('[TRACE] FloorPlan - Drag de la poubelle désactivé - mode normal');
    }
  }

  private getTrashIconElement(): HTMLElement | null {
    if (!this.dragContainer) {
      return null;
    }
    if (this.trashIconId) {
      return this.dragContainer.querySelector(`#${this.trashIconId}`) as HTMLElement | null;
    }
    return this.dragContainer.querySelector('.trash-icon') as HTMLElement | null;
  }

  private setupTrashDropZone(): void {
    const trashIcon = this.container.querySelector('.trash-icon') as HTMLElement;
    if (!trashIcon) {
      console.warn('Trash icon not found, cannot setup drop zone');
      return;
    }
    
    // Ajouter des classes pour le style de drop
    this.container.classList.add('trash-active');
    
    // Écouter les événements de mouseover et mouseout sur la poubelle pour le feedback visuel
    trashIcon.addEventListener('mouseover', () => {
      trashIcon.classList.add('trash-highlight');
      console.log('[TRACE] Mouse over trash icon');
    });
    
    trashIcon.addEventListener('mouseout', () => {
      trashIcon.classList.remove('trash-highlight');
      console.log('[TRACE] Mouse out trash icon');
    });
    
    // Note: La détection du drop sur la poubelle est maintenant gérée dans le callback onDragEnd
    // de chaque objet via HAObject. Voir la méthode initializeDragHandler dans HAObject.ts
  }

  private isMouseOverTrashIcon(trashIcon: HTMLElement): boolean {
    const rect = trashIcon.getBoundingClientRect();
    const mouseX = this.lastMousePosition?.x || 0;
    const mouseY = this.lastMousePosition?.y || 0;
    
    return (
      mouseX >= rect.left &&
      mouseX <= rect.right &&
      mouseY >= rect.top &&
      mouseY <= rect.bottom
    );
  }

  private trackMousePosition(): void {
    document.addEventListener('mousemove', (e) => {
      this.lastMousePosition = { x: e.clientX, y: e.clientY };
    });
  }

  private cleanupTrashDropZone(): void {
    this.container.classList.remove('trash-active');
    
    // Retirer tous les écouteurs d'événements
    const trashIcon = this.container.querySelector('.trash-icon') as HTMLElement;
    if (trashIcon) {
      // Créer un nouveau clone pour retirer les écouteurs
      const newTrashIcon = trashIcon.cloneNode(true) as HTMLElement;
      trashIcon.replaceWith(newTrashIcon);
    }
    
    // Retirer les écouteurs des objets
    this.objects.forEach(object => {
      const element = object.render();
      if (element) {
        const clone = element.cloneNode(true) as HTMLElement;
        element.replaceWith(clone);
        object.setElement(clone); // Mettre à jour la référence
      }
    });
  }
}