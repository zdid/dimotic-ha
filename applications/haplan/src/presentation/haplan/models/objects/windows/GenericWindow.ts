import { ContextWindow, getFormattedWindowTitle, applyFontSizeToWindow } from './ContextWindow';
import { BaseEntity } from '../BaseEntity';

export class GenericWindow implements ContextWindow {
  entity: BaseEntity;
  element: HTMLElement;
  isSimple: boolean = false;

  constructor(entity: BaseEntity) {
    this.entity = entity;
    this.element = this.render();
  }

  render(): HTMLElement {
    const cwindow = document.createElement('div');
    cwindow.className = 'context-window generic-window';
    
    // Appliquer les styles de base pour les fenêtres contextuelles
    cwindow.style.backgroundColor = 'rgba(0, 0, 0, 0.8)'; // Fond semi-transparent
    cwindow.style.color = '#FFFFFF'; // Texte blanc
    cwindow.style.padding = '15px';
    cwindow.style.borderRadius = '8px';
    cwindow.style.minWidth = '250px';
    cwindow.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';

    // Titre formaté avec area - entity name
    const title = document.createElement('h3');
    title.textContent = getFormattedWindowTitle(this.entity);
    title.style.marginTop = '0';
    title.style.color = '#FFFFFF';
    title.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
    title.style.paddingBottom = '10px';
    cwindow.appendChild(title);
    
    // Appliquer la taille de police
    applyFontSizeToWindow(cwindow);

    // Affichage des valeurs
    const valuesContainer = document.createElement('div');
    valuesContainer.className = 'entity-values';

    // Parcourir toutes les valeurs affichables
    const displayValues = this.entity['displayValues'] as Map<string, any>;
    if (displayValues) {
      displayValues.forEach((value, key) => {
        const valueRow = document.createElement('div');
        valueRow.className = 'value-row';
        
        const valueLabel = document.createElement('span');
        valueLabel.className = 'value-label';
        valueLabel.textContent = `${key}:`;
        valueRow.appendChild(valueLabel);
        
        const valueContent = document.createElement('span');
        valueContent.className = 'value-content';
        valueContent.textContent = value.toString();
        valueRow.appendChild(valueContent);
        
        valuesContainer.appendChild(valueRow);
      });
    }

    cwindow.appendChild(valuesContainer);

    return cwindow;
  }

  onAction(action: string, value?: any): void {
    // Pas d'actions spécifiques pour les entités génériques
    console.log(`Action ${action} reçue pour l'entité générique`);
  }

  updateDisplay(): void {
    // Mettre à jour les valeurs affichées
    const displayValues = this.entity['displayValues'] as Map<string, any>;
    if (!displayValues) return;
    
    const valueRows = this.element.querySelectorAll('.value-row');
    valueRows.forEach(row => row.remove());
    
    const valuesContainer = this.element.querySelector('.entity-values');
    if (valuesContainer) {
      displayValues.forEach((value, key) => {
        const valueRow = document.createElement('div');
        valueRow.className = 'value-row';
        valueRow.style.margin = '8px 0';
        valueRow.style.padding = '5px';
        valueRow.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        valueRow.style.borderRadius = '4px';
        
        const valueLabel = document.createElement('span');
        valueLabel.className = 'value-label';
        valueLabel.textContent = `${key}:`;
        valueLabel.style.fontWeight = 'bold';
        valueLabel.style.color = '#CCCCCC';
        valueRow.appendChild(valueLabel);
        
        const valueContent = document.createElement('span');
        valueContent.className = 'value-content';
        valueContent.textContent = value.toString();
        valueContent.style.marginLeft = '10px';
        valueContent.style.color = '#FFFFFF';
        valueRow.appendChild(valueContent);
        
        valuesContainer.appendChild(valueRow);
      });
    }
  }

  close(): void {
    // Rien à faire ici
  }
   // ✅ AJOUTER
  getElement(): HTMLElement {
    return this.element;
  }

  // ✅ AJOUTER
  addEventListener(event: string, handler: (e: Event) => void): void {
    this.element.addEventListener(event, handler);
  }
}