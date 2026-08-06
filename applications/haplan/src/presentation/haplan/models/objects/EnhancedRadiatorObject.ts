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
    // Pas de libellé ON/OFF (demande utilisateur 06/08/2026, même traitement que ballon/VMC) —
    // l'état se lit uniquement à la couleur (et à l'icône, feu/flocon) : bleu éteint / rouge allumé.
    this.setColorScheme({
      primary: '#F44336', // Rouge (allumé)
      secondary: '#2196F3', // Bleu (éteint)
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-radiator-object');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';

    // Créer l'icône spécifique
    const icon = this.createIcon(this.getIconForState(), 'medium');

    const iconElement = icon.querySelector('i') as HTMLElement;
    if (iconElement) {
      iconElement.style.color = this.isOn ? this.colorScheme.primary : this.colorScheme.secondary;
    }

    container.appendChild(icon);

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

    const iconElement = this.element.querySelector('i') as HTMLElement;
    if (iconElement) {
      iconElement.style.color = this.isOn ? this.colorScheme.primary : this.colorScheme.secondary;
    }
  }
}
