import { DataService } from '../../services/DataService';
import { EnhancedLightObject } from './EnhancedLightObject';

export class MinimalLightObject extends EnhancedLightObject {
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    commandService?: DataService
  ) {
    super(entity_id, position, dimensions, commandService);
    
    // Personnalisation pour les lumières minimalistes
    this.setColorScheme({
      primary: '#FFD700', // Or
      secondary: '#FFC107', // Ambre
      background: 'transparent',
      text: '#333333'
    });
  }

  renderEntity(): HTMLElement {
    const container = super.renderEntity();
    
    // Remplacer l'icône par une icône plus petite
    const icon = container.querySelector('.entity-icon') as HTMLElement;
    if (icon) {
      const lightIcon = icon.querySelector('i') as HTMLElement;
      if (lightIcon) {
        lightIcon.className = 'fas fa-lightbulb';
        lightIcon.style.fontSize = '16px';
      }
    }
    
    return container;
  }
}