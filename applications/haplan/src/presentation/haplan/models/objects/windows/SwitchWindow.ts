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

    // ⭐ 08/09/2026, demande explicite : toujours les deux boutons Allumer/Éteindre plutôt qu'un
    // seul bouton bascule dont le libellé dépend de l'état actuel — certaines entités (RF
    // notamment) ont un retour d'état peu fiable, un bouton unique peut alors afficher le libellé
    // opposé à l'action réellement voulue. Chaque bouton appelle explicitement turn_on/turn_off
    // (jamais toggle), même patron que SwitchContextWindow.ts (VMC/ballon/radiateur).
    const controlsContainer = document.createElement('div');
    controlsContainer.style.display = 'flex';
    controlsContainer.style.justifyContent = 'center';
    controlsContainer.style.gap = '15px';
    controlsContainer.style.marginTop = '10px';

    const offBtn = document.createElement('button');
    offBtn.textContent = 'Éteindre';
    offBtn.style.padding = '8px 16px';
    offBtn.style.backgroundColor = '#F44336';
    offBtn.style.color = 'white';
    offBtn.style.border = 'none';
    offBtn.style.borderRadius = '4px';
    offBtn.style.cursor = 'pointer';
    offBtn.addEventListener('click', () => {
      // Fermeture automatique gérée par ContextWindowManager (isSimple = true)
      this.onAction('turn_off');
    });
    controlsContainer.appendChild(offBtn);

    const onBtn = document.createElement('button');
    onBtn.textContent = 'Allumer';
    onBtn.style.padding = '8px 16px';
    onBtn.style.backgroundColor = '#4CAF50';
    onBtn.style.color = 'white';
    onBtn.style.border = 'none';
    onBtn.style.borderRadius = '4px';
    onBtn.style.cursor = 'pointer';
    onBtn.addEventListener('click', () => {
      this.onAction('turn_on');
    });
    controlsContainer.appendChild(onBtn);

    cwindow.appendChild(controlsContainer);

    return cwindow;
  }

  onAction(action: string): void {
    this.entity.handleAction(action);
  }

  close(): void {
    // Fermeture gérée par ContextWindowManager (isSimple = true)
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