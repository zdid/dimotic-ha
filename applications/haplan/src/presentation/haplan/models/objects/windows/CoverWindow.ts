// Fenêtre contextuelle pour les volets (cover) — jusqu'ici routés vers GenericWindow (lecture
// seule, aucun bouton) : un tap sur un volet n'affichait donc que le titre, sans aucune action
// possible. EnhancedCoverObject a pourtant déjà toute la logique (openCover/closeCover/stopCover
// via handleAction) — il ne lui manquait qu'une fenêtre qui l'appelle, sur le modèle de
// SwitchContextWindow.
import { ContextWindow, getFormattedWindowTitle, applyFontSizeToWindow } from './ContextWindow';
import { BaseEntity } from '../BaseEntity';
import { ContextWindowManager } from './ContextWindowManager';

export class CoverWindow implements ContextWindow {
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
    cwindow.className = 'context-window cover-window';
    cwindow.style.minWidth = '250px';
    cwindow.style.padding = '15px';
    cwindow.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    cwindow.style.borderRadius = '8px';
    cwindow.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';

    const title = document.createElement('h3');
    title.textContent = getFormattedWindowTitle(this.entity);
    title.style.marginTop = '0';
    title.style.color = '#FFFFFF';
    title.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
    title.style.paddingBottom = '10px';
    cwindow.appendChild(title);

    applyFontSizeToWindow(cwindow);

    const controlsContainer = document.createElement('div');
    controlsContainer.style.display = 'flex';
    controlsContainer.style.justifyContent = 'center';
    controlsContainer.style.gap = '10px';
    controlsContainer.style.marginTop = '15px';

    const makeButton = (label: string, color: string, action: string): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.padding = '8px 14px';
      btn.style.backgroundColor = color;
      btn.style.color = 'white';
      btn.style.border = 'none';
      btn.style.borderRadius = '4px';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAction(action);
      });
      return btn;
    };

    controlsContainer.appendChild(makeButton('Fermer', '#F44336', 'close'));
    controlsContainer.appendChild(makeButton('Stop', '#9E9E9E', 'stop'));
    controlsContainer.appendChild(makeButton('Ouvrir', '#4CAF50', 'open'));

    cwindow.appendChild(controlsContainer);

    return cwindow;
  }

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

  onAction(action: string): void {
    this.entity.handleAction(action);
  }

  close(): void {
    const windowManager = ContextWindowManager.getInstance();
    windowManager.hideWindow();
  }
}
