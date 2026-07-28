// Utilitaire pour détecter le type de switch
/**
 * Classe utilitaire pour déterminer le type d'un objet switch
 * Combine plusieurs méthodes pour une détection robuste
 */
export class SwitchTypeDetector {
  /**
   * Détermine le type d'un switch en combinant plusieurs méthodes
   * @param entity_id - ID de l'entité
   * @param attributes - Attributs de l'entité
   * @returns Le type de switch ('vmc', 'water_heater', 'radiator', ou 'switch')
   */
  static detectType(entity_id: string, attributes: any = {}): string {
    // Première méthode : par l'entity_id
    const typeById = this.detectByEntityId(entity_id);
    if (typeById !== 'switch') {
      return typeById;
    }

    // Deuxième méthode : par les attributs
    return this.detectByAttributes(attributes);
  }

  /**
   * Détection par l'entity_id (première méthode)
   */
  private static detectByEntityId(entity_id: string): string {
    const lowerId = entity_id.toLowerCase();
    
    // VMC : contient souvent "ventilation", "vmc", "fan"
    if (lowerId.includes('ventilation') || lowerId.includes('vmc') || lowerId.includes('fan')) {
      return 'vmc';
    }
    
    // Ballon d'eau chaude : contient souvent "water_heater", "chauffe_eau", "ballon"
    if (lowerId.includes('water_heater') || lowerId.includes('chauffe_eau') || lowerId.includes('ballon')) {
      return 'water_heater';
    }
    
    // Radiateur/élément chauffant : contient souvent "radiator", "heating", "chauffage"
    if (lowerId.includes('radiator') || lowerId.includes('heating') || lowerId.includes('chauffage')) {
      return 'radiator';
    }
    
    // Switch générique par défaut
    return 'switch';
  }

  /**
   * Détection par les attributs (deuxième méthode)
   */
  private static detectByAttributes(attributes: any): string {
    // VMC pourrait avoir des attributs comme "fan_mode", "air_quality"
    if (attributes.fan_mode || attributes.air_quality) {
      return 'vmc';
    }
    
    // Ballon d'eau chaude pourrait avoir "water_temperature", "heating"
    if (attributes.water_temperature || attributes.current_temperature) {
      return 'water_heater';
    }
    
    // Radiateur pourrait avoir "target_temperature", "thermostat"
    if (attributes.target_temperature || attributes.thermostat) {
      return 'radiator';
    }
    
    // Switch générique par défaut
    return 'switch';
  }

  /**
   * Retourne l'icône appropriée pour le type de switch
   */
  static getIconForType(type: string): string {
    switch (type) {
      case 'vmc': return 'fa-wind';
      case 'water_heater': return 'fa-water';
      case 'radiator': return 'fa-fire';
      default: return 'fa-toggle-on';
    }
  }

  /**
   * Retourne la couleur principale pour le type de switch
   */
  static getColorForType(type: string): string {
    switch (type) {
      case 'vmc': return '#9C27B0'; // Violet
      case 'water_heater': return '#FF5722'; // Orange
      case 'radiator': return '#E91E63'; // Rose
      default: return '#2196F3'; // Bleu
    }
  }
}
