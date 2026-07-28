import { BaseEntity } from './BaseEntity';
import { EnhancedLightObject } from './EnhancedLightObject';
import { MinimalLightObject } from './MinimalLightObject';
import { EnhancedTemperatureSensor } from './EnhancedTemperatureSensor';
import { EnhancedCoverObject } from './EnhancedCoverObject';
import { EnhancedBlindObject } from './EnhancedBlindObject';
import { EnhancedThermostatObject } from './EnhancedThermostatObject';
import { EnhancedHumiditySensor } from './EnhancedHumiditySensor';
import { EnhancedGenericSensor } from './EnhancedGenericSensor';
import { EnhancedSwitchObject } from './EnhancedSwitchObject';
import { EnhancedWaterHeaterObject } from './EnhancedWaterHeaterObject';
import { EnhancedRadiatorObject } from './EnhancedRadiatorObject';
import { EnhancedVMCObject } from './EnhancedVMCObject';
import { SwitchTypeDetector } from '../../utils/SwitchTypeDetector';
import { ContextWindow } from './windows/ContextWindow';
import { LightWindow } from './windows/LightWindow';
import { SwitchWindow } from './windows/SwitchWindow';
import { ThermostatWindow } from './windows/ThermostatWindow';
import { GenericWindow } from './windows/GenericWindow';
import { SwitchContextWindow } from './windows/SwitchContextWindow';
import { DataService } from '../../services/DataService';  // ✅ GARDER SEUL import

export class UnifiedObjectFactory {
  // Registre des créateurs d'entités
  private static entityCreators: Map<string, (
    entity_id: string,
    position: { x: number; y: number },
    state?: any,
    dataService?: DataService  // ✅ CHANGER
  ) => BaseEntity> = new Map();

  // Registre des créateurs de fenêtres
  private static windowCreators: Map<string, (entity: BaseEntity) => ContextWindow> = new Map();

  static {
    // Initialisation des types par défaut
    this.registerDefaultTypes();
  }

  private static registerDefaultTypes(): void {
    // Lumière standard
    this.registerEntityType('light', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const light = new EnhancedLightObject(entity_id, position, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
      // Ne plus appeler updateState ici - sera fait après render()
      return light;
    });

    this.registerWindowType('light', (entity) => new LightWindow(entity as EnhancedLightObject));

    // Lumière minimaliste
    this.registerEntityType('minimal_light', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const light = new MinimalLightObject(entity_id, position, { width: 24, height: 24 }, dataService);  // ✅ CHANGER
      return light;
    });

    this.registerWindowType('minimal_light', (entity) => new LightWindow(entity as MinimalLightObject));

    // Capteur de température
    this.registerEntityType('temperature_sensor', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const sensor = new EnhancedTemperatureSensor(entity_id, position, { width: 50, height: 50 }, dataService);  // ✅ CHANGER
      return sensor;
    });

    this.registerWindowType('temperature_sensor', (entity) => new GenericWindow(entity));

    // Capteur d'humidité
    this.registerEntityType('humidity_sensor', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const sensor = new EnhancedHumiditySensor(entity_id, position, { width: 50, height: 50 }, dataService);  // ✅ CHANGER
      return sensor;
    });

    this.registerWindowType('humidity_sensor', (entity) => new GenericWindow(entity));

    // Capteur générique
    this.registerEntityType('generic_sensor', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const sensorType = entity_id.split('.')[1].split('_')[0];
      const sensor = new EnhancedGenericSensor(entity_id, position, sensorType, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
      return sensor;
    });

    this.registerWindowType('generic_sensor', (entity) => new GenericWindow(entity));

    // Interrupteur simple
    this.registerEntityType('switch', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const light = new MinimalLightObject(entity_id, position, { width: 24, height: 24 }, dataService);  // ✅ CHANGER
      return light;
    });

    this.registerWindowType('switch', (entity) => new SwitchWindow(entity as MinimalLightObject));

    // Volet/Store
    this.registerEntityType('cover', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const cover = new EnhancedCoverObject(entity_id, position, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
      return cover;
    });

    this.registerWindowType('cover', (entity) => new GenericWindow(entity));

    // Store spécifique
    this.registerEntityType('blind', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const blind = new EnhancedBlindObject(entity_id, position, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
      return blind;
    });

    this.registerWindowType('blind', (entity) => new GenericWindow(entity));

    // Thermostat
    this.registerEntityType('thermostat', (entity_id, position, state, dataService) => {  // ✅ CHANGER
      const thermostat = new EnhancedThermostatObject(entity_id, position, { width: 60, height: 60 }, dataService);  // ✅ CHANGER
      return thermostat;
    });

    this.registerWindowType('thermostat', (entity) => new ThermostatWindow(entity));
  }

  /**
   * Méthode principale pour créer un objet et sa fenêtre associée
   */
  static createObjectWithWindow(
    entity_id: string,
    position: { x: number; y: number },
    state?: any,
    dataService?: DataService  // ✅ CHANGER
  ): { entity: BaseEntity; cwindow: ContextWindow } {
    // D'abord vérifier par domaine
    const entityType = this.getEntityType(entity_id);
    
    // Si c'est un switch, vérifier le type spécifique
    const isSwitch = entityType === 'switch' || entityType === 'light';
    let entity: BaseEntity;
    let cwindow: ContextWindow;
    
    if (isSwitch) {
      // Détecter le type spécifique de switch
      const switchType = SwitchTypeDetector.detectType(entity_id, state?.attributes || {});
      
      switch (switchType) {
        case 'vmc':
          entity = new EnhancedVMCObject(entity_id, position, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
          cwindow = new SwitchContextWindow(entity);
          break;
        case 'water_heater':
          entity = new EnhancedWaterHeaterObject(entity_id, position, { width: 40, height: 40 }, dataService);  // ✅ CHANGER
          cwindow = new SwitchContextWindow(entity);
          break;
        case 'radiator':
          entity = new EnhancedRadiatorObject(
            entity_id,
            position,
            { width: 40, height: 40 },
            dataService  // ✅ CHANGER
          );
          cwindow = new SwitchContextWindow(entity);
          break;
        default:
          // Switch générique
          const entityCreator = this.entityCreators.get(entityType) || this.entityCreators.get('light');
          entity = entityCreator!(entity_id, position, state, dataService);  // ✅ CHANGER
          const windowCreator = this.windowCreators.get(entityType) || this.windowCreators.get('light');
          cwindow = windowCreator!(entity);
      }
    } else {
      // Utiliser le type existant pour les autres cas
      const entityCreator = this.entityCreators.get(entityType) || this.entityCreators.get('light');
      entity = entityCreator!(entity_id, position, state, dataService);  // ✅ CHANGER
      const windowCreator = this.windowCreators.get(entityType) || this.windowCreators.get('light');
      cwindow = windowCreator!(entity);
    }
    
    // Lier la fenêtre à l'entité
    entity.setContextWindow(cwindow);
    
    return { entity, cwindow: cwindow };
  }

  /**
   * Enregistrer un nouveau type d'entité
   */
  static registerEntityType(
    type: string,
    creator: (
      entity_id: string,
      position: { x: number; y: number },
      state?: any,
      dataService?: DataService  // ✅ CHANGER
    ) => BaseEntity
  ): void {
    this.entityCreators.set(type, creator);
  }

  /**
   * Enregistrer un nouveau type de fenêtre
   */
  static registerWindowType(type: string, creator: (entity: BaseEntity) => ContextWindow): void {
    this.windowCreators.set(type, creator);
  }

  /**
   * Extraire le type à partir de l'entity_id
   */
  private static getEntityType(entity_id: string): string {
    const parts = entity_id.split('.');
    if (parts.length < 2) return 'light';
    
    const domain = parts[0];
    
    // Logique de détermination du type
    if (domain === 'light') {
      if (entity_id.includes('minimal')) return 'minimal_light';
      return 'light';
    }
    
    if (domain === 'switch') return 'switch';
    
    if (domain === 'sensor') {
      if (entity_id.includes('temperature')) return 'temperature_sensor';
      if (entity_id.includes('humidity')) return 'humidity_sensor';
      return 'generic_sensor';
    }
    
    if (domain === 'cover') {
      if (entity_id.includes('blind') || entity_id.includes('store')) return 'blind';
      return 'cover';
    }
    
    if (domain === 'climate') return 'thermostat';
    
    return 'light'; // Type par défaut
  }
}