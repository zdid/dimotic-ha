import { ContextWindow, getFormattedWindowTitle, applyFontSizeToWindow } from './ContextWindow';
import { MinimalLightObject } from '../MinimalLightObject';

export class SwitchWindow implements ContextWindow {
  entity: MinimalLightObject;
  element: HTMLElement;
  isSimple: boolean = true; // Fermeture automatique après action

  constructor(entity: MinimalLightObject) {
    this.entity = entity;
    this.element = this.render();
  }

  render(): HTMLElement {
    const cwindow = document.createElement('div');
    cwindow.className = 'context-window switch-window';
    
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

    // Bouton d'état
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-button';
    toggleBtn.textContent = this.entity.getDisplayValue('status') === 'ON' ? 'Éteindre' : 'Allumer';
    toggleBtn.addEventListener('click', () => {
      this.onAction('toggle');
      // Fermeture automatique après 500ms
      setTimeout(() => this.close(), 500);
    });
    cwindow.appendChild(toggleBtn);

    return cwindow;
  }

  onAction(action: string): void {
    this.entity.handleAction(action);
  }

  close(): void {
    // Cette fenêtre se ferme automatiquement
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