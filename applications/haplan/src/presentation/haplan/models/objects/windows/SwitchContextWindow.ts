// Fenêtre contextuelle de base pour les objets de type switch
import { ContextWindow, getFormattedWindowTitle, applyFontSizeToWindow } from './ContextWindow';
import { BaseEntity } from '../BaseEntity';
import { ContextWindowManager } from './ContextWindowManager';

export class SwitchContextWindow implements ContextWindow {
  isSimple: boolean = true;
  entity: BaseEntity;
  element: HTMLElement;
  private listeners: Map<string, EventListener> = new Map();

  constructor(entity: BaseEntity) {
    this.entity = entity;
    this.element = this.render();
  }

  render(): HTMLElement {
    const cwindow = document.createElement('div');
    cwindow.className = 'context-window switch-context-window';
    cwindow.style.minWidth = '250px';
    cwindow.style.padding = '15px';
    cwindow.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    cwindow.style.borderRadius = '8px';
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

    // État actuel
    const statusDisplay = document.createElement('div');
    statusDisplay.style.margin = '15px 0';
    statusDisplay.style.padding = '10px';
    statusDisplay.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    statusDisplay.style.borderRadius = '5px';
    statusDisplay.style.textAlign = 'center';
    
    const statusValue = document.createElement('strong');
    statusValue.style.fontSize = '1.2em';
    statusValue.style.color = this.entity.getDisplayValue('status') === 'ON' ? '#4CAF50' : '#F44336';
    statusValue.textContent = String(this.entity.getDisplayValue('status') || 'OFF');
    
    statusDisplay.appendChild(statusValue);
    cwindow.appendChild(statusDisplay);

    // Contrôles
    const controlsContainer = document.createElement('div');
    controlsContainer.style.display = 'flex';
    controlsContainer.style.justifyContent = 'center';
    controlsContainer.style.gap = '15px';
    controlsContainer.style.marginTop = '20px';

    // Bouton Éteindre
    const offBtn = document.createElement('button');
    offBtn.textContent = 'Éteindre';
    offBtn.style.padding = '8px 16px';
    offBtn.style.backgroundColor = '#F44336';
    offBtn.style.color = 'white';
    offBtn.style.border = 'none';
    offBtn.style.borderRadius = '4px';
    offBtn.style.cursor = 'pointer';
    offBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onAction('turn_off');
    });
    controlsContainer.appendChild(offBtn);

    // Bouton Allumer
    const onBtn = document.createElement('button');
    onBtn.textContent = 'Allumer';
    onBtn.style.padding = '8px 16px';
    onBtn.style.backgroundColor = '#4CAF50';
    onBtn.style.color = 'white';
    onBtn.style.border = 'none';
    onBtn.style.borderRadius = '4px';
    onBtn.style.cursor = 'pointer';
    onBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onAction('turn_on');
    });
    controlsContainer.appendChild(onBtn);

    cwindow.appendChild(controlsContainer);

    return cwindow;
  }

  // IMPLÉMENTATION DE L'INTERFACE ContextWindow
  
  getElement(): HTMLElement {
    return this.element;
  }

  addEventListener(event: string, handler: EventListener): void {
    this.listeners.set(event, handler);
    this.element.addEventListener(event, handler);
  }

  removeEventListener(event: string): void {
    const handler = this.listeners.get(event);
    if (handler) {
      this.element.removeEventListener(event, handler);
      this.listeners.delete(event);
    }
  }

  // MÉTHODES MÉTIER
  
  onAction(action: string): void {
    this.entity.handleAction(action);
  }

  updateDisplay(): void {
    const statusValue = this.element.querySelector('strong');
    if (statusValue) {
      const status = this.entity.getDisplayValue('status');
      statusValue.textContent = String(status || 'OFF');
      statusValue.style.color = status === 'ON' ? '#4CAF50' : '#F44336';
    }
  }

  close(): void {
    const windowManager = ContextWindowManager.getInstance();
    windowManager.hideWindow();
  }

}
