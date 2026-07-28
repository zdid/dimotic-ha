import { ContextWindow, getFormattedWindowTitle, applyFontSizeToWindow } from './ContextWindow';
import { EnhancedLightObject } from '../EnhancedLightObject';
import { MinimalLightObject } from '../MinimalLightObject';

export class LightWindow implements ContextWindow {
  entity: EnhancedLightObject | MinimalLightObject;
  element: HTMLElement;
  isSimple: boolean = false;

  constructor(entity: EnhancedLightObject | MinimalLightObject) {
    this.entity = entity;
    this.element = this.render();
  }

  render(): HTMLElement {
    const cwindow = document.createElement('div');
    cwindow.className = 'context-window light-window';
    
    // Appliquer les styles de base pour les fenêtres contextuelles
    cwindow.style.backgroundColor = 'rgba(0, 0, 0, 0.8)'; // Fond semi-transparent
    cwindow.style.color = '#FFFFFF'; // Texte blanc
    cwindow.style.padding = '15px';
    cwindow.style.borderRadius = '8px';
    cwindow.style.minWidth = '250px';
    cwindow.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';

    // Titre formaté avec area - entity name
    const title = document.createElement('h3');
    title.textContent = getFormattedWindowTitle(this.entity);
    title.style.marginTop = '0';
    title.style.color = '#FFFFFF';
    title.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
    title.style.paddingBottom = '10px';
    cwindow.appendChild(title);
    
    // Appliquer la taille de police
    applyFontSizeToWindow(cwindow);

    // Boutons Allumer et Éteindre
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.display = 'flex';
    buttonsContainer.style.gap = '10px';
    buttonsContainer.style.marginTop = '15px';

    // Bouton Éteindre
    const offBtn = document.createElement('button');
    offBtn.textContent = 'Éteindre';
    offBtn.style.padding = '8px 16px';
    offBtn.style.backgroundColor = '#F44336';
    offBtn.style.color = 'white';
    offBtn.style.border = 'none';
    offBtn.style.borderRadius = '4px';
    offBtn.style.cursor = 'pointer';
    offBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log("lightwindow clic on eteindre")
      this.onAction('turn_off');
    });
    buttonsContainer.appendChild(offBtn);

    // Bouton Allumer
    const onBtn = document.createElement('button');
    onBtn.textContent = 'Allumer';
    onBtn.style.padding = '8px 16px';
    onBtn.style.backgroundColor = '#4CAF50';
    onBtn.style.color = 'white';
    onBtn.style.border = 'none';
    onBtn.style.borderRadius = '4px';
    onBtn.style.cursor = 'pointer';
    onBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log("lightwindow clic on allumer")
      this.onAction('turn_on');
    });
    buttonsContainer.appendChild(onBtn);

    cwindow.appendChild(buttonsContainer);

    // Contrôle de luminosité (si supporté)
    if (this.entity instanceof EnhancedLightObject) {
      const brightnessContainer = document.createElement('div');
      brightnessContainer.className = 'brightness-control';

      const brightnessLabel = document.createElement('label');
      brightnessLabel.textContent = 'Luminosité:';
      brightnessContainer.appendChild(brightnessLabel);

      const brightnessInput = document.createElement('input');
      brightnessInput.type = 'range';
      brightnessInput.min = '0';
      brightnessInput.max = '255';
      brightnessInput.value = this.entity.getDisplayValue('brightness')?.toString() || '0';
      brightnessInput.addEventListener('input', (e) => {
        this.onAction('set_brightness', (e.target as HTMLInputElement).value);
      });
      brightnessContainer.appendChild(brightnessInput);

      const brightnessValue = document.createElement('span');
      brightnessValue.className = 'brightness-value';
      brightnessValue.textContent = brightnessInput.value;
      brightnessContainer.appendChild(brightnessValue);

      // Mettre à jour l'affichage de la valeur
      brightnessInput.addEventListener('input', (e) => {
        brightnessValue.textContent = (e.target as HTMLInputElement).value;
      });

      cwindow.appendChild(brightnessContainer);
    }

    return cwindow;
  }

  onAction(action: string, value?: any): void {
    console.log("lightwindow", "onaction",action)
    switch (action) {
      case 'toggle':
        this.entity.handleAction('toggle');
        break;
      case 'turn_on':
        this.entity.handleAction('turn_on');
        break;
      case 'turn_off':
        this.entity.handleAction('turn_off');
        break;
      case 'set_brightness':
        this.entity.updateState({
          state: 'on',
          attributes: { brightness: parseInt(value) }
        });
        break;
    }

    // Mettre à jour l'affichage
    this.updateDisplay();
  }

  updateDisplay(): void {
    // Mettre à jour le bouton d'état
    const toggleBtn = this.element.querySelector('.toggle-button') as HTMLButtonElement;
    if (toggleBtn) {
      toggleBtn.textContent = this.entity.getDisplayValue('status') === 'ON' ? 'Éteindre' : 'Allumer';
    }

    // Mettre à jour la luminosité si applicable
    if (this.entity instanceof EnhancedLightObject) {
      const brightnessInput = this.element.querySelector('input[type="range"]') as HTMLInputElement;
      const brightnessValue = this.element.querySelector('.brightness-value') as HTMLSpanElement;
      if (brightnessInput && brightnessValue) {
        const brightness = this.entity.getDisplayValue('brightness')?.toString() || '0';
        brightnessInput.value = brightness;
        brightnessValue.textContent = brightness;
      }
    }
  }

  close(): void {
    // Rien à faire ici, la fermeture est gérée par le gestionnaire
  }
   // ✅ AJOUTER
  getElement(): HTMLElement {
    return this.element;
  }

  // ✅ AJOUTER
  addEventListener(event: string, handler: (e: Event) => void): void {
    this.element.addEventListener(event, handler);
  }
}