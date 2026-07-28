// Classe de base pour les objets de type switch (interrupteurs)
import { DataService } from '../../services/DataService';
import { BaseEntity } from './BaseEntity';

/**
 * Classe de base pour les objets de type switch
 * Peut être étendue pour des types spécifiques comme les radiateurs, ballons d'eau chaude, etc.
 */
export class EnhancedSwitchObject extends BaseEntity {
  protected isOn: boolean = false;
  
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService
  ) {
    super(entity_id, position, dimensions, dataService);
    this.setVisualStyle('minimal');
    this.setColorScheme({
      primary: '#2196F3', // Bleu par défaut
      secondary: '#03A9F4',
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  updateState(state: any): void {
    this.isOn = state.state === 'on';
    this.updateDisplay();
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-switch-object');
    
    const icon = this.createIcon(this.getIconForState(), 'medium') as HTMLElement;
    if (icon) {
      icon.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }

    const statusDisplay = document.createElement('div') as HTMLElement;
    statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';

    container.appendChild(icon);
    container.appendChild(statusDisplay);

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick();
    });

    return container;
  }

  protected getIconForState(): string {
    return this.isOn ? 'fa-toggle-on' : 'fa-toggle-off';
  }

  protected toggle(): void {
    this.sendCommand('switch', this.isOn ? 'turn_off' : 'turn_on');
  }

  handleAction(action: string, value?: any): void {
    if (action === 'toggle') {
      this.toggle();
    } else {
      this.sendCommand('switch', action);
    }
  }

  updateDisplay(): void {
    if (!this.element) return;
    
    const icon = this.element.querySelector('i') as HTMLElement;
    if (icon) {
      icon.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
    
    const statusDisplay = this.element.querySelector('.switch-status-display') as HTMLElement;
    if (statusDisplay) {
      statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';
      statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
  }
}
