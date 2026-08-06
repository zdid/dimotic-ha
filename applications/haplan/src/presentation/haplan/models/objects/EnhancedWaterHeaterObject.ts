// Classe pour les ballons d'eau chaude
import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { DataService } from '../../services/DataService';

/**
 * Classe pour les ballons d'eau chaude
 * Hérite de EnhancedSwitchObject pour les fonctionnalités de base
 */
export class EnhancedWaterHeaterObject extends EnhancedSwitchObject {
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    // Pas de libellé ON/OFF (demande utilisateur 06/08/2026) — l'état se lit uniquement à la
    // couleur de l'icône : bleu éteint / orange allumé.
    this.setColorScheme({
      primary: '#FF9800', // Orange (allumé)
      secondary: '#2196F3', // Bleu (éteint)
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-water-heater-object');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';

    // Créer l'icône spécifique
    const icon = this.createIcon(this.getIconForState(), 'medium');

    // Forcer la couleur de l'icône
    const iconElement = icon.querySelector('i');
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
    // Ballon d'eau chaude: toujours fa-water, mais la couleur change
    return 'fa-water';
  }

  updateDisplay(): void {
    if (!this.element) return;

    const icon = this.element.querySelector('i') as HTMLElement;  // ✅ AJOUTER cast
    if (icon) {
      icon.style.color = this.isOn ? this.colorScheme.primary : this.colorScheme.secondary;
    }
  }
}
