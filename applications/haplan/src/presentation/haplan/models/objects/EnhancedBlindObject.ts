import { EnhancedCoverObject } from './EnhancedCoverObject';
import { DataService } from '../../services/DataService';

export class EnhancedBlindObject extends EnhancedCoverObject {
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER commandService en dataService
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    
    // Couleurs spécifiques pour les stores
    this.setColorScheme({
      primary: '#9C27B0', // Violet
      secondary: '#BA68C8',
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  protected getIconForState(): string {
    // Store: rideau ouvert/fermé
    return this.isOn ? 'fa-window-maximize' : 'fa-window-minimize';
  }

  handleAction(action: string, value?: any): void {
    if (action === 'open') {
      this.sendCommand('cover', 'open_cover');
    } else if (action === 'close') {
      this.sendCommand('cover', 'close_cover');
    } else if (action === 'stop') {
      this.sendCommand('cover', 'stop_cover');
    } else {
      super.handleAction(action, value);
    }
  }
}