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

    // Deuxième méthode : par le "quoi" de la taxonomie (attributs_taxonomie, cf. taxonomy.ts côté
    // RFXCOM/nommage) — ⭐ 15/09/2026 : nécessaire pour les entités dont l'entity_id HA a été figé
    // AVANT que le "quoi" ne soit précisé/corrigé (ex: switch.entree_salle sur noisy2, dont
    // l'entity_id ne contient pas "radiateur" mais dont attributs_taxonomie.quoi vaut bien
    // "Radiateur" — HA ne renomme jamais un entity_id existant quand le nom source change).
    const typeByTaxonomy = this.detectByTaxonomyQuoi(attributes);
    if (typeByTaxonomy !== 'switch') {
      return typeByTaxonomy;
    }

    // Troisième méthode : par la forme des attributs (repli le moins fiable)
    return this.detectByAttributes(attributes);
  }

  /**
   * Détection par l'entity_id (première méthode)
   */
  private static detectByEntityId(entity_id: string): string {
    return this.matchKeywords(entity_id);
  }

  /**
   * Détection par le "quoi" de la taxonomie publiée par RFXCOM/nommage
   * (attributes.attributs_taxonomie.quoi, ex: "Radiateur") — même liste de mots-clés que
   * detectByEntityId, sur un texte différent (le nom source, pas l'entity_id dérivé).
   */
  private static detectByTaxonomyQuoi(attributes: any): string {
    const quoi = attributes?.attributs_taxonomie?.quoi;
    if (!quoi || typeof quoi !== 'string') return 'switch';
    return this.matchKeywords(quoi);
  }

  /**
   * Recherche des mots-clés de type (vmc/water_heater/radiator) dans un texte donné — partagé
   * entre detectByEntityId (entity_id HA) et detectByTaxonomyQuoi (nom taxonomie RFXCOM/nommage),
   * pour ne maintenir la liste de mots-clés qu'à un seul endroit.
   */
  private static matchKeywords(text: string): string {
    const lower = text.toLowerCase();

    // VMC : contient souvent "ventilation", "vmc", "fan"
    if (lower.includes('ventilation') || lower.includes('vmc') || lower.includes('fan')) {
      return 'vmc';
    }

    // Ballon d'eau chaude : contient souvent "water_heater", "chauffe_eau", "ballon"
    if (lower.includes('water_heater') || lower.includes('chauffe_eau') || lower.includes('ballon')) {
      return 'water_heater';
    }

    // Radiateur/élément chauffant : contient souvent "radiateur" (FR), "radiator" (EN), "heating",
    // "chauffage" — ⭐ 14/09/2026 : "radiateur" ajouté, absent jusqu'ici alors que c'est le nom
    // français réellement utilisé (ex. switch.salle_radiateur_18 sur noisy2) ; "radiator" ne le
    // matchait pas ("radiateur" n'est pas un sur-mot de "radiator", lettres différentes après
    // "radiat").
    if (
      lower.includes('radiateur') ||
      lower.includes('radiator') ||
      lower.includes('heating') ||
      lower.includes('chauffage')
    ) {
      return 'radiator';
    }

    // Switch générique par défaut
    return 'switch';
  }

  /**
   * Détection par la forme des attributs (dernier repli)
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
