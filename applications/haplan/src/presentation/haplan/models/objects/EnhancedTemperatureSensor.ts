import { BaseEntity } from './BaseEntity';
import { DataService } from '../../services/DataService';

export class EnhancedTemperatureSensor extends BaseEntity {
  protected temperature: string | number = 0;
  protected unit: string = '°C';

  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 24, height: 24 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    this.setVisualStyle('minimal'); // Style minimal pour afficher uniquement la valeur
    this.setColorScheme({
      primary: '#F44336', // Rouge
      secondary: '#E57373', // Rouge clair
      background: 'transparent', // Fond transparent
      text: '#FFFFFF' // Blanc pour le contraste sur fond noir
    });
  }

  updateState(state: any): void {
    const rawValue = state.state || 0;
    this.temperature = this.normalizeDisplayValue(rawValue);
    this.unit = state.attributes?.unit_of_measurement || '°C';
    
    this.updateDisplay();
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-temperature-sensor');

    // Créer uniquement l'affichage de la valeur (affichage simplifié)
    const valueDisplay = this.createStyledElement('div', 'sensor-value-display');
    valueDisplay.textContent = this.temperature === 'N/A'
      ? 'N/A'
      : `${this.temperature}${this.unit}`;
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

    // Mettre à jour uniquement la valeur de température
    const valueDisplay = this.element.querySelector('.sensor-value-display') as HTMLElement;
    if (valueDisplay) {
      valueDisplay.textContent = this.temperature === 'N/A'
        ? 'N/A'
        : `${this.temperature}${this.unit}`;
    }
  }

  handleAction(action: string): void {
    // Les capteurs de température sont généralement en lecture seule
    console.log(`Temperature sensor action ${action} - read only`);
  }
}