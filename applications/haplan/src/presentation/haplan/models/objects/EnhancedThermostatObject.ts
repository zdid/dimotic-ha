import { BaseEntity } from './BaseEntity';
import { DataService } from '../../services/DataService';

export class EnhancedThermostatObject extends BaseEntity {
  protected currentTemperature: string | number = 0;
  protected targetTemperature: string | number = 0;
  protected hvacMode: string = 'off';
  protected temperatureUnit: string = '°C';

  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService  // ✅ CHANGER
  ) {
    super(entity_id, position, dimensions, dataService);  // ✅ CHANGER
    this.setVisualStyle('minimal'); // Style minimal pour afficher icône + valeur
    this.setColorScheme({
      primary: '#FF5722', // Orange
      secondary: '#FF7043', // Orange clair
      background: 'transparent', // Fond transparent
      text: '#FFFFFF' // Blanc pour le contraste sur fond noir
    });
  }

  updateState(state: any): void {
    console.log(`[TRACE] EnhancedThermostatObject.updateState() - Mise à jour avec l'état:`, state);
    
    // Extraire les données des attributs avec validation
    const rawCurrentTemp = this.extractAttribute(state, 'current_temperature', 0);
    const rawTargetTemp = this.extractAttribute(state, 'temperature', 0);
    this.currentTemperature = this.normalizeDisplayValue(rawCurrentTemp);
    this.targetTemperature = this.normalizeDisplayValue(rawTargetTemp);
    const rawHvacMode = state.state || 'off';
    this.hvacMode = typeof rawHvacMode === 'string' ? rawHvacMode : 'off';
    if (this.hvacMode.toLowerCase() === 'unknown' || this.hvacMode.toLowerCase() === 'unknow') {
      this.hvacMode = 'off';
    }
    this.temperatureUnit = this.extractAttribute(state, 'temperature_unit', '°C');

    console.log(`[TRACE] EnhancedThermostatObject - Données extraites:`);
    console.log(`  - Température actuelle: ${this.currentTemperature}${this.temperatureUnit}`);
    console.log(`  - Température cible: ${this.targetTemperature}${this.temperatureUnit}`);
    console.log(`  - Mode HVAC: ${this.hvacMode}`);

    // Mettre à jour les valeurs d'affichage pour la fenêtre contextuelle
    // Note: Utiliser 'current_temperature' pour la température actuelle
    this.setDisplayValue('current_temperature', this.currentTemperature);
    this.setDisplayValue('target_temp', this.targetTemperature);
    this.setDisplayValue('hvac_mode', this.normalizeDisplayValue(rawHvacMode));
    this.setDisplayValue('temperature_unit', this.temperatureUnit);

    this.updateDisplay();
    
    // Mettre à jour la fenêtre contextuelle si elle est ouverte
    this.updateContextWindowIfOpen();
  }

  /**
   * Extraire une valeur d'attribut avec validation
   * @param state - État complet de l'entité
   * @param attributeName - Nom de l'attribut à extraire
   * @param defaultValue - Valeur par défaut si l'attribut est manquant
   * @returns Valeur extraite ou valeur par défaut
   */
  private extractAttribute(state: any, attributeName: string, defaultValue: any): any {
    if (state?.attributes && typeof state.attributes === 'object') {
      const value = state.attributes[attributeName];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    //console.warn(`[TRACE] EnhancedThermostatObject - Attribut ${attributeName} manquant ou invalide, utilisation de la valeur par défaut:`, defaultValue);
    return defaultValue;
  }

  renderEntity(): HTMLElement {
    console.log("[TRACE] renderEntity ", this.entity_id)
    const container = this.createStyledElement('div', 'enhanced-thermostat-object');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.gap = '8px';

    // Créer l'icône
    const icon = this.createIcon('fa-thermometer-half', 'medium');
    
    // Forcer la couleur de l'icône en blanc pour le contraste sur fond noir
    const iconElement = icon.querySelector('i');
    if (iconElement) {
      iconElement.style.color = '#FFFFFF';
    }
    
    // Appliquer la colorisation initiale basée sur l'état actuel
    this.updateDisplay();

    // Créer l'affichage des températures (actuelle et cible)
    const tempDisplay = this.createStyledElement('div', 'thermostat-temp-display');
    tempDisplay.style.display = 'flex';
    tempDisplay.style.flexDirection = 'column';
    tempDisplay.style.alignItems = 'flex-start';
    tempDisplay.style.color = '#ffffff';
    tempDisplay.style.lineHeight = '1.2';

    // Ligne principale: icône + température cible
    const mainRow = this.createStyledElement('div', 'thermostat-main-row');
    mainRow.style.display = 'flex';
    mainRow.style.alignItems = 'center';
    mainRow.style.gap = '6px';

    // Température cible
    const targetTemp = this.createStyledElement('div', 'thermostat-target-temp');
    targetTemp.textContent = this.targetTemperature === 'N/A'
      ? 'N/A'
      : `${this.targetTemperature}${this.temperatureUnit}`;
    targetTemp.style.fontWeight = 'normal';
    targetTemp.style.display = 'block';

    // Température actuelle (plus petite)
    const currentTemp = this.createStyledElement('div', 'thermostat-current-temp');
    currentTemp.textContent = this.currentTemperature === 'N/A'
      ? 'act: N/A'
      : `act: ${this.currentTemperature}${this.temperatureUnit}`;
    currentTemp.style.opacity = '0.8';
    currentTemp.style.display = 'block';

    // Assembler les températures
    mainRow.appendChild(icon);
    mainRow.appendChild(targetTemp);
    tempDisplay.appendChild(mainRow);
    tempDisplay.appendChild(currentTemp);

    // Assembler les éléments (températures)
    container.appendChild(tempDisplay);

    // Ajouter un gestionnaire de clic pour ouvrir la fenêtre modale
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick(); // Cela ouvrira la fenêtre contextuelle
    });

    return container;
  }
  
  updateDisplay(): void {
    console.log("updateDisplay", this.entity_id,"element:", Boolean(this.element))
    
    if (!this.element) return;

    // Mettre à jour l'icône en fonction du mode
    const icon = this.element.querySelector('.entity-icon') as HTMLElement;
    console.log("have icon", icon)
    if (icon) {
      const thermostatIcon = icon.querySelector('i') as HTMLElement;
      console.log("y a t il un thermosIcon", Boolean(thermostatIcon))
      if (thermostatIcon) {
        let iconClass = 'fa-thermometer-half';
        let color = this.colorScheme.primary;
        
        // Si éteint, toujours gris
        if (this.hvacMode === 'off') {
          console.log("isoff")
          iconClass = 'fa-thermometer-half';
          color = '#999999';
        } else {

          // Déterminer la couleur en fonction de la température cible
          const targetTemp = typeof this.targetTemperature === 'string' ? parseFloat(this.targetTemperature) : this.targetTemperature;
          if (this.targetTemperature === 'N/A' || isNaN(targetTemp)) {
            color = '#999999';
          } else if (targetTemp <= 18) {
            console.log("temp < 18")
            color = '#2196F3'; // Bleu
          } else if (targetTemp >= 21) {
            console.log("temp > 21")
            color = '#F44336'; // Rouge
          } else {
            console.log("entre 18 et 21")
            // Entre 18 et 21: dégradé ou mélange
            color = '#9C27B0'; // Violet (mélange)
          }
          
          // Changer l'icône en fonction du mode
          switch (this.hvacMode) {
            case 'heat':
              iconClass = 'fa-thermometer-full';
              break;
            case 'cool':
              iconClass = 'fa-thermometer-empty';
              break;
            case 'auto':
              iconClass = 'fa-thermometer-half';
              break;
          }
        }
        
        thermostatIcon.className = `fas ${iconClass}`;
        thermostatIcon.style.color = color;
      }
    }

    // Mettre à jour l'affichage des températures
    const targetTemp = this.element.querySelector('.thermostat-target-temp') as HTMLElement;
    if (targetTemp) {
      targetTemp.textContent = this.targetTemperature === 'N/A'
        ? 'N/A'
        : `${this.targetTemperature}${this.temperatureUnit}`;
    }
    
    const currentTemp = this.element.querySelector('.thermostat-current-temp') as HTMLElement;
    if (currentTemp) {
      currentTemp.textContent = this.currentTemperature === 'N/A'
        ? 'act: N/A'
        : `act: ${this.currentTemperature}${this.temperatureUnit}`;
    }
  }

  protected increaseTemperature(): void {
    const currentTemp = typeof this.targetTemperature === 'string' ? parseFloat(this.targetTemperature) : this.targetTemperature;
    const newTemp = currentTemp + 0.5;
    console.log(`[TRACE] EnhancedThermostatObject.increaseTemperature() - Nouvelle température: ${newTemp}`);
    this.setTemperature(newTemp);
  }

  protected decreaseTemperature(): void {
    const currentTemp = typeof this.targetTemperature === 'string' ? parseFloat(this.targetTemperature) : this.targetTemperature;
    const newTemp = currentTemp - 0.5;
    console.log(`[TRACE] EnhancedThermostatObject.decreaseTemperature() - Nouvelle température: ${newTemp}`);
    this.setTemperature(newTemp);
  }

  protected setTemperature(temperature: number): void {
    console.log(`[TRACE] EnhancedThermostatObject.setTemperature() - Envoi de la commande climate.set_temperature avec ${temperature}`);
    this.sendCommand('climate', 'set_temperature', { temperature: temperature });
  }

  protected setHvacMode(mode: string): void {
    console.log(`[TRACE] EnhancedThermostatObject.setHvacMode() - Envoi de la commande climate.set_hvac_mode avec ${mode}`);
    this.sendCommand('climate', 'set_hvac_mode', { hvac_mode: mode });
  }

  handleAction(action: string, value?: any): void {
    console.log(`[TRACE] EnhancedThermostatObject.handleAction() appelé avec action: ${action}, valeur: ${value}`);
    
    switch (action) {
      case 'increase':
        console.log(`[TRACE] EnhancedThermostatObject - Augmentation de la température`);
        this.increaseTemperature();
        break;
      case 'decrease':
        console.log(`[TRACE] EnhancedThermostatObject - Diminution de la température`);
        this.decreaseTemperature();
        break;
      case 'set_temperature':
        console.log(`[TRACE] EnhancedThermostatObject - Définition de la température à ${value}`);
        if (value !== undefined) {
          this.setTemperature(parseFloat(value));
        }
        break;
      case 'toggle':
        console.log(`[TRACE] EnhancedThermostatObject - Basculement du mode HVAC`);
        this.setHvacMode(this.hvacMode === 'off' ? 'auto' : 'off');
        break;
    }
  }
}