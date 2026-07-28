// Classe pour les VMC (Ventilation Mécanique Contrôlée)
import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { DataService } from '../../services/DataService';

/**
 * Classe pour les VMC
 * Hérite de EnhancedSwitchObject pour les fonctionnalités de base
 */
export class EnhancedVMCObject extends EnhancedSwitchObject {
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    // Couleurs spécifiques pour les VMC
    this.setColorScheme({
      primary: '#FF9800', // Orange
      secondary: '#FFB74D',
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-vmc-object');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.gap = '8px';

    // Créer l'icône spécifique
    const icon = this.createIcon(this.getIconForState(), 'medium');
    
    // Forcer la couleur de l'icône
    const iconElement = icon.querySelector('i');
    if (iconElement) {
      iconElement.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }

    // Créer l'affichage de l'état
    const statusDisplay = this.createStyledElement('div', 'vmc-status-display');
    statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';
    statusDisplay.style.fontSize = '16px';
    statusDisplay.style.fontWeight = 'bold';
    statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';

    // Assembler les éléments
    container.appendChild(icon);
    container.appendChild(statusDisplay);

    // Ajouter un gestionnaire de clic
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick();
    });

    return container;
  }

  /**
   * Retourne l'icône appropriée en fonction de l'état
   */
  protected getIconForState(): string {
    // VMC: toujours fa-wind, mais la couleur change
    return 'fa-wind';
  }

  updateDisplay(): void {
    if (!this.element) return;
    
    const icon = this.element.querySelector('i') as HTMLElement;  // ✅ AJOUTER cast
    if (icon) {
      icon.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
    
    const statusDisplay = this.element.querySelector('.vmc-status-display') as HTMLElement;  // ✅ AJOUTER cast
    if (statusDisplay) {
      statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
  }
}
