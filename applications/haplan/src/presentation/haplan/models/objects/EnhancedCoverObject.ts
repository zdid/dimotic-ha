import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { DataService } from '../../services/DataService';

export class EnhancedCoverObject extends EnhancedSwitchObject {
  protected isOpen: boolean = false;
  protected currentPosition: number = 0;

  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    this.setVisualStyle('icon'); // Style icône pour afficher uniquement l'icône
    this.setColorScheme({
      primary: '#4CAF50', // Vert
      secondary: '#8BC34A', // Vert clair
      background: 'transparent', // Fond transparent
      text: '#FFFFFF' // Blanc pour le contraste sur fond noir
    });
  }

  updateState(state: any): void {
    this.isOpen = state.state === 'open';
    this.currentPosition = state.attributes?.current_position || 0;
    
    this.updateDisplay();
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-cover-object');

    // Créer uniquement l'icône (affichage simplifié)
    const icon = this.createIcon('fa-window-maximize', 'large');
    
    // Forcer la couleur de l'icône en blanc pour le contraste sur fond noir
    const iconElement = icon.querySelector('i');
    if (iconElement) {
      iconElement.style.color = '#FFFFFF';
    }

    // Assembler les éléments (uniquement l'icône)
    container.appendChild(icon);

    // Ajouter un gestionnaire de clic pour ouvrir la fenêtre modale
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick(); // Cela ouvrira la fenêtre contextuelle
    });

    return container;
  }

  updateDisplay(): void {
    if (!this.element) return;

    // Mettre à jour l'icône en fonction de l'état
    const icon = this.element.querySelector('.entity-icon') as HTMLElement;
    if (icon) {
      const coverIcon = icon.querySelector('i') as HTMLElement;
      if (coverIcon) {
        coverIcon.className = `fas fa-window-maximize`;
        coverIcon.style.opacity = this.isOpen ? '1' : '0.3';
        coverIcon.style.color = this.isOpen ? this.colorScheme.primary : '#999999';
      }
    }
  }

  protected openCover(): void {
    console.log(`[TRACE] EnhancedCoverObject.openCover() - Envoi de la commande cover.open_cover`);
    this.sendCommand('cover', 'open_cover');
  }

  protected closeCover(): void {
    console.log(`[TRACE] EnhancedCoverObject.closeCover() - Envoi de la commande cover.close_cover`);
    this.sendCommand('cover', 'close_cover');
  }

  protected stopCover(): void {
    console.log(`[TRACE] EnhancedCoverObject.stopCover() - Envoi de la commande cover.stop_cover`);
    this.sendCommand('cover', 'stop_cover');
  }

  protected toggle(): void {
    this.isOpen ? this.closeCover() : this.openCover();
  }

  handleAction(action: string, value?: any): void {
    switch (action) {
      case 'open':
        this.openCover();
        break;
      case 'close':
        this.closeCover();
        break;
      case 'stop':
        this.stopCover();
        break;
      case 'toggle':
        this.toggle();
        break;
    }
  }
}