import { BaseEntity } from '../BaseEntity';
import { getDataService } from '../../../services/DataService';

export interface ContextWindow {
  entity: BaseEntity;
  element: HTMLElement;
  isSimple: boolean; // Fermeture automatique après action

  /**
   * Rendu de la fenêtre
   */
  render(): HTMLElement;

  /**
   * Gestion des actions
   */
  onAction(action: string, value?: any): void;

  /**
   * Fermeture de la fenêtre
   */
  close(): void;

  /**
   * Mise à jour de l'affichage
   */
  updateDisplay?(): void;

  /**
   * Obtient l'élément HTML de la fenêtre
   */
  getElement(): HTMLElement;

  /**
   * Ajoute un écouteur d'événements
   */
  addEventListener(event: string, handler: EventListener): void;
}
export function capitalize(str: string ): string  {
  if(! str) return "";
  return str.substring(0,1).toUpperCase() + str.substring(1);  
}
// Fonction utilitaire pour obtenir le titre formaté
export function getFormattedWindowTitle(entity: BaseEntity): string {
  let name = getDataService().getNameEntity(entity.getEntity_id());
  let area = getDataService().getAreaNameOfEntity(entity.getEntity_id())
  console.log("getFormattedWindowTitle baseEntity", entity)
  return capitalize(area) + " - "+ capitalize(name)
  // const entityParts = entity.getEntity_id().split('.');
  // const entityName = entityParts.length > 1 ? entityParts[1].replace(/_/g, ' ') : entity.getEntity_id();
  
  // // Formater le titre
  
  // return capitalize(entityName);
  
}

// Fonction utilitaire pour appliquer la taille de police
export function applyFontSizeToWindow(windowElement: HTMLElement): void {
  const fontSize = localStorage.getItem('contextFontSize') || 'medium';
  let sizeValue = '14px';
  
  switch (fontSize) {
    case 'small':
      sizeValue = '12px';
      break;
    case 'medium':
      sizeValue = '14px';
      break;
    case 'large':
      sizeValue = '16px';
      break;
  }
  
  windowElement.style.fontSize = sizeValue;
}