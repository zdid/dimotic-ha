import { HAObject } from './objects/HAObject';

export class PositionManager {
  private positionsByFloorplan: Map<string, Map<string, {x: number, y: number}>> = new Map();
  private currentFloorplanId: string = 'default';
  private debounceTimer: NodeJS.Timeout | null = null;
  private saveCallback: (floorplanId: string, positions: any[]) => void;

  constructor(saveCallback: (floorplanId: string, positions: any[]) => void, currentFloorplanId: string = 'default') {
    this.saveCallback = saveCallback;
    this.currentFloorplanId = currentFloorplanId;
    
    // Initialiser le plan courant s'il n'existe pas
    if (!this.positionsByFloorplan.has(this.currentFloorplanId)) {
      this.positionsByFloorplan.set(this.currentFloorplanId, new Map());
    }
  }

  // Méthode pour changer de plan courant
  setCurrentFloorplan(floorplanId: string): void {
    console.log(`[TRACE] PositionManager.setCurrentFloorplan: Changement de plan de ${this.currentFloorplanId} à ${floorplanId}`);
    
    // Initialiser le nouveau plan s'il n'existe pas
    if (!this.positionsByFloorplan.has(floorplanId)) {
      this.positionsByFloorplan.set(floorplanId, new Map());
      console.log(`[TRACE] Nouveau plan ${floorplanId} initialisé avec un Map vide`);
    }
    
    this.currentFloorplanId = floorplanId;
    console.log(`[TRACE] Plan courant mis à jour: ${this.currentFloorplanId}`);
  }

  getCurrentFloorplanId(): string {
    return this.currentFloorplanId;
  }

  updatePosition(entity_id: string, x: number, y: number, skipSave: boolean = false): void {
    console.log(`[TRACE] PositionManager.updatePosition appelé pour ${entity_id} sur plan ${this.currentFloorplanId}:`, {x, y, skipSave});
    
    const currentPositions = this.positionsByFloorplan.get(this.currentFloorplanId);
    if (currentPositions) {
      currentPositions.set(entity_id, {x, y});
      console.log(`[TRACE] Position stockée dans PositionManager pour ${entity_id} sur plan ${this.currentFloorplanId}. Nombre total de positions:`, currentPositions.size);
      
      // Ne déclencher la sauvegarde que si ce n'est pas un chargement initial
      if (!skipSave) {
        this.scheduleSave();
      } else {
        console.log(`[TRACE] Sauvegarde ignorée (chargement initial)`);
      }
    } else {
      console.error(`[TRACE] Impossible de trouver le Map de positions pour le plan ${this.currentFloorplanId}`);
    }
  }

  removePosition(entity_id: string): void {
    console.log(`[TRACE] PositionManager.removePosition appelé pour ${entity_id} sur plan ${this.currentFloorplanId}`);
    
    const currentPositions = this.positionsByFloorplan.get(this.currentFloorplanId);
    if (currentPositions) {
      currentPositions.delete(entity_id);
      console.log(`[TRACE] Position supprimée. Nombre total de positions:`, currentPositions.size);
      this.scheduleSave();
    } else {
      console.error(`[TRACE] Impossible de trouver le Map de positions pour le plan ${this.currentFloorplanId}`);
    }
  }

  private scheduleSave(): void {
    console.log(`[TRACE] PositionManager.scheduleSave appelé. Planification de la sauvegarde dans 5 secondes...`);
    
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      console.log(`[TRACE] Timer de sauvegarde précédent annulé.`);
    }

    this.debounceTimer = setTimeout(() => {
      console.log(`[TRACE] Délai de 5 secondes écoulé. Déclenchement de savePositions...`);
      this.savePositions();
    }, 5000); // 5 secondes de délai
  }

  private savePositions(): void {
    const currentPositions = this.positionsByFloorplan.get(this.currentFloorplanId);
    
    if (currentPositions) {
      const positions = Array.from(currentPositions.entries()).map(([entity_id, pos]) => ({
        entity_id: entity_id,
        position: pos
      }));

      console.log(`[TRACE] PositionManager.savePositions appelé pour plan ${this.currentFloorplanId} avec les positions:`, positions);
      console.log(`[TRACE] Appel du callback de sauvegarde...`);
      
      this.saveCallback(this.currentFloorplanId, positions);
    } else {
      console.error(`[TRACE] Impossible de sauvegarder les positions: aucun Map trouvé pour le plan ${this.currentFloorplanId}`);
    }
  }

  /**
   * Force la sauvegarde immédiate des positions en attente (annule le timer)
   * Utilisé lors de la sortie du mode édition
   */
  forceSave(): void {
    console.log(`[TRACE] PositionManager.forceSave appelé - Sauvegarde immédiate`);
    
    // Annuler le timer en attente
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      console.log(`[TRACE] Timer annulé, sauvegarde immédiate déclenchée`);
    }
    
    // Sauvegarder immédiatement
    this.savePositions();
  }

  loadPositions(floorplanId: string, positions: any[]): void {
    console.log(`[TRACE] PositionManager.loadPositions appelé pour plan ${floorplanId} avec ${positions.length} positions`);
    
    // Initialiser le plan s'il n'existe pas
    if (!this.positionsByFloorplan.has(floorplanId)) {
      this.positionsByFloorplan.set(floorplanId, new Map());
    }
    
    const floorplanPositions = this.positionsByFloorplan.get(floorplanId);
    if (floorplanPositions) {
      positions.forEach(pos => {
        floorplanPositions.set(pos.entity_id, pos.position);
      });
      console.log(`[TRACE] ${positions.length} positions chargées pour le plan ${floorplanId}`);
    } else {
      console.error(`[TRACE] Impossible de charger les positions: aucun Map trouvé pour le plan ${floorplanId}`);
    }
  }

  getPosition(entity_id: string): {x: number, y: number} | undefined {
    const currentPositions = this.positionsByFloorplan.get(this.currentFloorplanId);
    if (currentPositions) {
      return currentPositions.get(entity_id);
    }
    console.warn(`[TRACE] Impossible de récupérer la position: aucun Map trouvé pour le plan ${this.currentFloorplanId}`);
    return undefined;
  }

  /**
   * Retourne toutes les positions pour le plan courant
   * @returns Tableau de toutes les positions avec leurs entity_id
   */
  getAllPositions(): Array<{entity_id: string, position: {x: number, y: number}}> {
    const currentPositions = this.positionsByFloorplan.get(this.currentFloorplanId);
    if (currentPositions) {
      return Array.from(currentPositions.entries()).map(([entity_id, pos]) => ({
          entity_id,
          position: pos
      }));
    }
    console.warn(`[TRACE] Impossible de récupérer toutes les positions: aucun Map trouvé pour le plan ${this.currentFloorplanId}`);
    return [];
  }

  /**
   * Retourne toutes les positions pour tous les plans
   * @returns Objet avec les plans comme clés et les positions comme valeurs
   */
  getAllPositionsForAllFloorplans(): Record<string, Array<{entity_id: string, position: {x: number, y: number}}>> {
    const result: Record<string, Array<{entity_id: string, position: {x: number, y: number}}>> = {};
    
    this.positionsByFloorplan.forEach((positionsMap, floorplanId) => {
      result[floorplanId] = Array.from(positionsMap.entries()).map(([entity_id, pos]) => ({
        entity_id,
        position: pos
      }));
    });
    
    return result;
  }

  /**
   * Retourne les positions pour un plan spécifique
   * @param floorplanId L'ID du plan
   * @returns Tableau des positions pour ce plan
   */
  getPositionsForFloorplan(floorplanId: string): Array<{entity_id: string, position: {x: number, y: number}}> {
    const positionsMap = this.positionsByFloorplan.get(floorplanId);
    if (positionsMap) {
      return Array.from(positionsMap.entries()).map(([entity_id, pos]) => ({
        entity_id,
        position: pos
      }));
    }
    return [];
  }

  /**
   * Nettoie le PositionManager (annule les timers en attente)
   */
  cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      console.log('[TRACE] PositionManager.cleanup: Timer annulé');
    }
    this.positionsByFloorplan.clear();
  }
}