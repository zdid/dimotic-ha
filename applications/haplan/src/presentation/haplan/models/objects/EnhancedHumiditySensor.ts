import { BaseEntity } from './BaseEntity';
import { DataService } from '../../services/DataService';

export class EnhancedHumiditySensor extends BaseEntity {
  humidity: string | number = 0;
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 24, height: 24 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    this.setVisualStyle('minimal'); // Style minimal pour afficher uniquement la valeur
    this.setColorScheme({
      primary: '#00BCD4', // Cyan
      secondary: '#4DD0E1', // Cyan clair
      background: 'transparent', // Fond transparent
      text: '#FFFFFF' // Blanc pour le contraste sur fond noir
    });
  }

  updateState(state: any): void {
    const rawValue = state.state || 0;
    this.humidity = this.normalizeDisplayValue(rawValue);
    
    this.updateDisplay();
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-humidity-sensor');

    // Créer uniquement l'affichage de la valeur (affichage simplifié)
    const valueDisplay = this.createStyledElement('div', 'sensor-value-display');
    valueDisplay.textContent = this.humidity === 'N/A'
      ? 'N/A'
      : `${this.humidity}%`;
    valueDisplay.style.fontWeight = 'normal';
    valueDisplay.style.color = '#FFFFFF'; // Texte blanc pour le contraste

    // Assembler les éléments (uniquement la valeur)
    container.appendChild(valueDisplay);

    // Ajouter un gestionnaire de clic pour ouvrir la fenêtre modale
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick(); // Cela ouvrira la fenêtre contextuelle
    });

    return container;
  }

  updateDisplay(): void {
    if (!this.element) return;

    // Mettre à jour uniquement la valeur d'humidité
    const valueDisplay = this.element.querySelector('.sensor-value-display') as HTMLElement;
    if (valueDisplay) {
      valueDisplay.textContent = this.humidity === 'N/A'
        ? 'N/A'
        : `${this.humidity}%`;
    }
  }

  handleAction(action: string): void {
    // Les capteurs d'humidité sont généralement en lecture seule
    console.log(`Humidity sensor action ${action} - read only`);
  }
}