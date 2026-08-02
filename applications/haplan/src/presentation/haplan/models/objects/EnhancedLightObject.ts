import { BaseEntity } from './BaseEntity';
import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { DataService } from '../../services/DataService';

export class EnhancedLightObject extends EnhancedSwitchObject {
  protected isOn: boolean = false;
  protected brightness: number = 0;
  private domRetryCount: number = 0;
  private readonly maxDomRetries: number = 10;

  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    this.setVisualStyle('icon'); // Style simplifié pour afficher uniquement l'icône
    this.setColorScheme({
      primary: '#FFD700', // Or
      secondary: '#FFC107', // Ambre
      background: 'transparent', // Fond transparent
      text: '#FFFFFF' // Blanc pour le contraste sur fond noir
    });
  }

  updateState(state: any): void {
    console.log(`💡 [EnhancedLightObject] updateState appelé pour ${this.entity_id}`, state)
    
    const previousIsOn = this.isOn;
    this.isOn = state.state === 'on';
    this.brightness = state.attributes?.brightness || (this.isOn ? 255 : 0);
    
    console.log(`💡 [EnhancedLightObject] État mis à jour pour ${this.entity_id}`, {
      previousIsOn,
      isOn: this.isOn,
      brightness: this.brightness
    });

    if (this.entity_id === 'light.bureau_plafonnier') {
      console.log('[TRACE][EnhancedLightObject] element attaché au DOM avant updateDisplay?', !!this.element && document.contains(this.element));
    }
    
    // Ne plus stocker les valeurs à afficher (affichage simplifié)
    this.updateDisplay();
    
    console.log(`💡 [EnhancedLightObject] updateDisplay appelé pour ${this.entity_id}`);
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-light-object');

    // Créer uniquement l'icône (affichage simplifié)
    const icon = this.createIcon('fa-lightbulb', 'large');
    
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
    console.log(`🎨 [EnhancedLightObject] updateDisplay pour ${this.entity_id}`, {
      isOn: this.isOn,
      hasElement: !!this.element
    });
    
    if (!this.element) {
      console.warn(`⚠️ [EnhancedLightObject] Pas d'element pour ${this.entity_id}`);
      return;
    }

    if (!document.contains(this.element)) {
      if (this.domRetryCount < this.maxDomRetries) {
        this.domRetryCount += 1;
        console.log(`[TRACE][EnhancedLightObject] element détaché, retry ${this.domRetryCount}/${this.maxDomRetries}`);
        requestAnimationFrame(() => this.updateDisplay());
      } else {
        console.warn(`[TRACE][EnhancedLightObject] element toujours détaché après ${this.maxDomRetries} retries`);
      }
      return;
    }

    this.domRetryCount = 0;
    
    console.log(`🔍 [EnhancedLightObject] Élément DOM trouvé pour ${this.entity_id}:`, this.element);
    console.log(`🔍 [EnhancedLightObject] Classes de l'élément:`, this.element.className);

    // Mettre à jour uniquement l'icône en fonction de l'état
    const icon = this.element.querySelector('.entity-icon') as HTMLElement;
    console.log(`🔍 [EnhancedLightObject] Icon trouvé:`, icon);
    
    if (icon) {
      const bulbIcon = icon.querySelector('i') as HTMLElement;
      console.log(`🔍 [EnhancedLightObject] BulbIcon trouvé:`, bulbIcon);
      
      if (bulbIcon) {
        const oldOpacity = bulbIcon.style.opacity;
        const oldColor = bulbIcon.style.color;
        
        bulbIcon.className = `fas fa-lightbulb`;
        // Fond du plan très sombre (--color-bg #1a1a2e) : à 0.3 d'opacité, le gris #999999 s'y fond
        // presque entièrement (icône quasi invisible, éteinte impossible à repérer/cliquer). Reste
        // visiblement plus terne que l'état allumé, mais lisible.
        bulbIcon.style.opacity = this.isOn ? '1' : '0.7';
        bulbIcon.style.color = this.isOn ? this.colorScheme.primary : '#bbbbbb';
        
        console.log(`✅ [EnhancedLightObject] Icône mise à jour pour ${this.entity_id}`, {
          oldOpacity,
          newOpacity: bulbIcon.style.opacity,
          oldColor,
          newColor: bulbIcon.style.color,
          element: bulbIcon
        });

        if (this.entity_id === 'light.bureau_plafonnier') {
          console.log('[TRACE][EnhancedLightObject] element dans DOM?', document.contains(bulbIcon));
          console.log('[TRACE][EnhancedLightObject] computed style immédiat', {
            color: getComputedStyle(bulbIcon).color,
            opacity: getComputedStyle(bulbIcon).opacity
          });

          requestAnimationFrame(() => {
            console.log('[TRACE][EnhancedLightObject] computed style après RAF', {
              color: getComputedStyle(bulbIcon).color,
              opacity: getComputedStyle(bulbIcon).opacity
            });
          });
        }
      } else {
        console.warn(`⚠️ [EnhancedLightObject] Pas de bulbIcon (i) pour ${this.entity_id}`);
      }
    } else {
      console.warn(`⚠️ [EnhancedLightObject] Pas d'icon (.entity-icon) pour ${this.entity_id}`);
    }
  }

  protected toggle(): void {
    const action = this.isOn ? 'turn_off' : 'turn_on';
    console.log(`[TRACE] EnhancedLightObject.toggle() - Envoi de la commande light.${action}`);
    this.sendCommand('light', action);
  }
  protected turn(action: string) {
    this.sendCommand('light', action);
  }
 
  handleAction(action: string): void {
    if(action.startsWith('turn_')) {
      this.turn(action)
    } else       
    if (action === 'toggle') {
      this.toggle();
    }
  }
}