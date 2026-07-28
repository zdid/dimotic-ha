// Classe pour les radiateurs
import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { DataService } from '../../services/DataService';

/**
 * Classe pour les radiateurs
 * Hérite de EnhancedSwitchObject pour les fonctionnalités de base
 */
export class EnhancedRadiatorObject extends EnhancedSwitchObject {
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService
  ) {
    super(entity_id, position, dimensions, dataService);
    // Couleurs spécifiques pour les radiateurs
    this.setColorScheme({
      primary: '#E91E63', // Rose
      secondary: '#F06292',
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-radiator-object');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.gap = '8px';

    // Créer l'icône spécifique
    const icon = this.createIcon(this.getIconForState(), 'medium');
    
    // ✅ CORRECTION : Supprimer le cast dupliqué
    const iconElement = icon.querySelector('i') as HTMLElement;
    if (iconElement) {
      iconElement.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }

    // Créer l'affichage de l'état
    const statusDisplay = document.createElement('div') as HTMLElement;
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
    // Radiateur: feu quand allumé, flocon quand éteint
    return this.isOn ? 'fa-fire' : 'fa-snowflake';
  }

  updateDisplay(): void {
    if (!this.element) return;
    
    // ✅ CORRECTION : Supprimer le cast dupliqué
    const iconElement = this.element.querySelector('i') as HTMLElement;
    if (iconElement) {
      iconElement.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
    
    // ✅ CORRECTION : Supprimer le cast dupliqué
    const statusDisplay = this.element.querySelector('.radiator-status-display') as HTMLElement;
    if (statusDisplay) {
      statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';
      statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
  }
}
