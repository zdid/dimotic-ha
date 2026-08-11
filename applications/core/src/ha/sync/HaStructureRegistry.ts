import { 
  HaStructuredRegistry, 
  HaArea, 
  HaDevice, 
  HaQuoi,
  IHaClassifier,
  HaQuoiDefinition 
} from '../types/ha-structure';
import { 
  HaStructuredEntity, 
  HaRawEntity 
} from '../types/ha-entity';
import { Logger } from '../../infrastructure/logger/index';

// =============================================================================
// HaStructureRegistry - Registre structuré des entités HA
// 
// Ce registre organise les entités par Area → QUOI → Entités.
// Il utilise HaClassifier pour classer les entités.
// =============================================================================

/**
 * Configuration pour la structuration.
 */
export interface HaStructureRegistryConfig {
  includeUnassigned: boolean;
  unassignedLabel: string;
}

/**
 * Événements émis par le registre structuré.
 */
export interface HaStructureRegistryEvents {
  onStructureRebuilt?: (registry: HaStructuredRegistry) => void;
  onEntityAdded?: (entity: HaStructuredEntity) => void;
  onEntityUpdated?: (entity: HaStructuredEntity) => void;
  onEntityRemoved?: (entityId: string) => void;
  onAreaAdded?: (area: HaArea) => void;
  onDeviceAdded?: (device: HaDevice) => void;
}

/**
 * Registre structuré des entités HA.
 * Organise les entités par Area → QUOI → Entités.
 */
export class HaStructureRegistry {
  private areas: Map<string, HaArea> = new Map();
  private devices: Map<string, HaDevice> = new Map();
  private unassigned?: HaArea;
  private entityMap: Map<string, HaStructuredEntity> = new Map();
  private lastFullSync: Date | null = null;
  private logger: Logger;

  // Graphe de lieux (specs à venir) — un "nœud" par valeur de lieu rencontrée dans
  // attributs_taxonomie, tous niveaux confondus (lieu_precis/lieu/lieu_pere/lieu_grand_pere,
  // via leurs champs slug_*). Sert getEntitiesByQuoiAndLieux() : recherche d'un terme de lieu
  // indépendante du niveau où il est codifié (demande utilisateur 10/08/2026 — "toilettes de
  // l'étage" doit se résoudre aussi bien qu'un lieu précis comme "salon"). Reconstruit
  // paresseusement (drapeau "dirty") à la première lecture suivant une mutation du registre —
  // à cette échelle (quelques centaines d'entités) une reconstruction complète est immédiate,
  // plus simple et plus sûre qu'un maintien incrémental avec comptage de références sur les
  // arêtes (nécessaire pour gérer correctement une suppression/reclassification d'entité).
  private lieuGraphDirty = true;
  private lieuChildren: Map<string, Set<string>> = new Map();

  /**
   * @param classifier - Classifieur pour déterminer les QUOI des entités
   * @param config - Configuration de structuration
   * @param logger - Logger pour les logs (optionnel)
   */
  constructor(
    private readonly classifier: IHaClassifier,
    private readonly config: HaStructureRegistryConfig = {
      includeUnassigned: false,
      unassignedLabel: 'Non assigné'
    },
    logger?: Logger
  ) {
    this.logger = logger || new Logger({
      level: 'info',
      maxSizeMb: 10,
      maxFiles: 5,
      logDir: '/app/logs',
    });

    // Initialiser l'area non assignée si configuré
    if (this.config.includeUnassigned) {
      this.unassigned = this.createUnassignedArea();
    }
  }

  /**
   * Crée l'area virtuelle pour les entités sans area.
   */
  private createUnassignedArea(): HaArea {
    return {
      area_id: 'unassigned',
      name: this.config.unassignedLabel,
      picture: undefined,
      quoiMap: new Map(),
    };
  }

  /**
   * Initialise le registre avec les données brutes de HA.
   * 
   * @param rawEntities - Entités brutes depuis HA
   * @param rawAreas - Areas brutes depuis HA
   * @param rawDevices - Devices brutes depuis HA
   * @param entityRegistry - Registre des entités avec métadonnées
   */
  initialize(
    rawEntities: HaRawEntity[],
    rawAreas: Array<{ area_id: string; name: string; picture?: string }>,
    rawDevices: Array<{
      device_id: string;
      name: string;
      area_id?: string;
      identifiers?: any[];
      manufacturer?: string;
      model?: string;
      via_device_id?: string;
    }>,
    entityRegistry: Array<{
      entity_id: string;
      domain: string;
      device_class?: string;
      area_id?: string;
      device_id?: string;
    }>
  ): HaStructuredRegistry {
    this.logger.info('ha:structure_registry', 'Initialisation du registre structuré...');

    // 1. Créer les areas
    for (const rawArea of rawAreas) {
      const area: HaArea = {
        area_id: rawArea.area_id,
        name: rawArea.name,
        picture: rawArea.picture,
        quoiMap: new Map(),
      };
      this.areas.set(area.area_id, area);
    }

    // 2. Créer les devices
    for (const rawDevice of rawDevices) {
      const device: HaDevice = {
        device_id: rawDevice.device_id,
        name: rawDevice.name,
        identifiers: rawDevice.identifiers,
        manufacturer: rawDevice.manufacturer,
        model: rawDevice.model,
        via_device_id: rawDevice.via_device_id,
        area_id: rawDevice.area_id,
        entities: [],
      };
      this.devices.set(device.device_id, device);
    }

    // 3. Créer les entités structurées et les classer
    for (const rawEntity of rawEntities) {
      const entityRegistryEntry = entityRegistry.find(e => e.entity_id === rawEntity.entity_id);
      const device = entityRegistryEntry?.device_id 
        ? this.devices.get(entityRegistryEntry.device_id) 
        : undefined;

      const structuredEntity: HaStructuredEntity = this.createStructuredEntity(
        rawEntity,
        entityRegistryEntry,
        device?.area_id
      );

      // Ajouter les références complètes à device et area — AVANT classify() ci-dessous : le
      // classifieur (TaxonomyHaClassifier, taxonomie virtuelle) lit entity.area?.name/
      // entity.device?.name pour dériver lieu_principal/lieu_precis, voir §9.3 du bug corrigé
      // le 06/08/2026 (lieu_principal affichait le slug d'area brut "chambre_de_jo" plutôt que
      // "Chambre de Jo", lieu_precis toujours absent).
      if (device) {
        structuredEntity.device = device;
      }

      // Résoudre l'area : priorité à entity.area_id, sinon device.area_id
      let area: HaArea | undefined;
      if (entityRegistryEntry?.area_id) {
        area = this.areas.get(entityRegistryEntry.area_id);
      } else if (device?.area_id) {
        area = this.areas.get(device.area_id);
      }

      if (area) {
        structuredEntity.area = area;
      } else if (this.unassigned) {
        // Si pas d'area trouvée mais includeUnassigned activé, assigner à unassigned
        structuredEntity.area = this.unassigned;
      }

      // Classer l'entité
      const quoiIds = this.classifier.classify(structuredEntity);
      structuredEntity.quoi_ids = quoiIds;

      // Stocker l'entité
      this.entityMap.set(structuredEntity.entity_id, structuredEntity);

      // Ajouter à la device
      if (device) {
        device.entities.push(structuredEntity);
      }

      // Ajouter à l'area ou à unassigned
      this.addEntityToArea(structuredEntity);
      this.addEntityToQuoi(structuredEntity);
    }

    this.lastFullSync = new Date();
    this.invalidateLieuGraph();
    this.logger.info('ha:structure_registry', `Registre structuré initialisé: ${this.areas.size} areas, ${this.devices.size} devices, ${this.entityMap.size} entités`);

    return this.getRegistry();
  }

  /**
   * Crée une entité structurée à partir des données brutes.
   */
  private createStructuredEntity(
    rawEntity: HaRawEntity,
    registryEntry?: { entity_id: string; domain: string; device_class?: string; area_id?: string; device_id?: string },
    deviceAreaId?: string
  ): HaStructuredEntity {
    // Extraire le domaine de l'entity_id si non disponible dans le registry
    const domain = registryEntry?.domain || rawEntity.entity_id.split('.')[0];
    const deviceClass = registryEntry?.device_class;
    const entityAreaId = registryEntry?.area_id;
    const deviceId = registryEntry?.device_id;

    // Priorité à entity.area_id, sinon device.area_id
    const areaId = entityAreaId || deviceAreaId;

    // Extraire friendly_name des attributs ou utiliser entity_id
    const friendlyName = (rawEntity.attributes.friendly_name as string) || rawEntity.entity_id;

    return {
      entity_id: rawEntity.entity_id,
      friendly_name: friendlyName,
      domain: domain as any, // Cast nécessaire pour le type HaDomain
      device_class: deviceClass as any, // Cast nécessaire pour le type HaDeviceClass
      state: rawEntity.state,
      attributes: rawEntity.attributes,
      device_id: deviceId,
      area_id: areaId,
      quoi_ids: [], // Seront remplis par la classification
      last_updated: new Date(rawEntity.last_updated),
    };
  }

  /**
   * Ajoute une entité à son area.
   */
  private addEntityToArea(entity: HaStructuredEntity): void {
    if (!entity.area_id) {
      // Pas d'area assignée
      if (this.unassigned) {
        this.addEntityToQuoiInArea(entity, this.unassigned);
      }
      return;
    }

    const area = this.areas.get(entity.area_id);
    if (area) {
      this.addEntityToQuoiInArea(entity, area);
    } else {
      // Area non trouvée, ajouter à unassigned si disponible
      if (this.unassigned) {
        this.addEntityToQuoiInArea(entity, this.unassigned);
      }
    }
  }

  /**
   * Ajoute une entité aux QUOI appropriés dans une area.
   */
  private addEntityToQuoiInArea(entity: HaStructuredEntity, area: HaArea): void {
    for (const quoiId of entity.quoi_ids) {
      if (!area.quoiMap.has(quoiId)) {
        // Créer le QUOI s'il n'existe pas
        const quoiDefinition = this.classifier.getQuoiCatalog().find(q => q.quoi_id === quoiId);
        const quoi: HaQuoi = {
          quoi_id: quoiId,
          label: quoiDefinition?.label || quoiId,
          description: quoiDefinition?.description,
          entities: [],
        };
        area.quoiMap.set(quoiId, quoi);
      }

      const quoi = area.quoiMap.get(quoiId)!;
      // Vérifier si l'entité est déjà dans le QUOI
      if (!quoi.entities.some(e => e.entity_id === entity.entity_id)) {
        quoi.entities.push(entity);
      }
    }
  }

  /**
   * Ajoute une entité aux QUOI appropriés dans le registre.
   */
  private addEntityToQuoi(entity: HaStructuredEntity): void {
    // Trouver l'area de l'entité
    const area = entity.area_id ? this.areas.get(entity.area_id) : this.unassigned;
    
    if (area) {
      this.addEntityToQuoiInArea(entity, area);
    }
  }

  /**
   * Met à jour une entité dans le registre.
   * 
   * @param rawEntity - Entité brute mise à jour
   * @param registryEntry - Entrée du registre d'entités (optionnel)
   * @returns L'entité structurée mise à jour ou undefined si non trouvée
   */
  updateEntity(
    rawEntity: HaRawEntity,
    registryEntry?: { entity_id: string; domain: string; device_class?: string; area_id?: string; device_id?: string }
  ): HaStructuredEntity | undefined {
    const existing = this.entityMap.get(rawEntity.entity_id);
    
    if (!existing) {
      // Nouvelle entité, l'ajouter
      return this.addNewEntity(rawEntity, registryEntry);
    }

    // Mettre à jour les champs de l'entité existante
    const device = registryEntry?.device_id ? this.devices.get(registryEntry.device_id) : undefined;
    
    const updatedEntity: HaStructuredEntity = {
      ...existing,
      state: rawEntity.state,
      attributes: rawEntity.attributes,
      last_updated: new Date(rawEntity.last_updated),
    };

    // Mettre à jour le device_class et domain si fournis
    if (registryEntry) {
      updatedEntity.domain = registryEntry.domain as any;
      updatedEntity.device_class = registryEntry.device_class as any;
      updatedEntity.device_id = registryEntry.device_id;
      updatedEntity.area_id = registryEntry.area_id || device?.area_id;
    }

    // Reclasser l'entité (les quoi_ids peuvent changer)
    const newQuoiIds = this.classifier.classify(updatedEntity);
    
    if (JSON.stringify(newQuoiIds) !== JSON.stringify(updatedEntity.quoi_ids)) {
      // Les QUOI ont changé, il faut restructuring
      this.removeEntityFromStructure(existing);
      updatedEntity.quoi_ids = newQuoiIds;
      this.addEntityToStructure(updatedEntity);
    } else {
      updatedEntity.quoi_ids = newQuoiIds;
      // Juste mettre à jour dans la structure existante
      this.updateEntityInStructure(updatedEntity);
    }

    this.entityMap.set(rawEntity.entity_id, updatedEntity);
    this.invalidateLieuGraph();
    this.logger.debug('ha:structure_registry', `Entité mise à jour: ${rawEntity.entity_id}`);

    return updatedEntity;
  }

  /**
   * Ajoute une nouvelle entité au registre.
   */
  private addNewEntity(
    rawEntity: HaRawEntity,
    registryEntry?: { entity_id: string; domain: string; device_class?: string; area_id?: string; device_id?: string }
  ): HaStructuredEntity {
    const structuredEntity = this.createStructuredEntity(rawEntity, registryEntry);
    const device = registryEntry?.device_id ? this.devices.get(registryEntry.device_id) : undefined;
    
    // Classer l'entité
    structuredEntity.quoi_ids = this.classifier.classify(structuredEntity);

    // Stocker l'entité
    this.entityMap.set(structuredEntity.entity_id, structuredEntity);

    // Ajouter à la device
    if (device) {
      device.entities.push(structuredEntity);
    }

    // Ajouter à la structure (area → QUOI)
    this.addEntityToStructure(structuredEntity);
    this.invalidateLieuGraph();

    this.logger.debug('ha:structure_registry', `Nouvelle entité ajoutée: ${structuredEntity.entity_id}`);

    return structuredEntity;
  }

  /**
   * Ajoute une entité à la structure (area → QUOI).
   */
  private addEntityToStructure(entity: HaStructuredEntity): void {
    this.addEntityToArea(entity);
  }

  /**
   * Met à jour une entité dans la structure existante.
   */
  private updateEntityInStructure(entity: HaStructuredEntity): void {
    // Trouver toutes les areas et QUOI où cette entité est présente
    for (const [_areaId, area] of this.areas) {
      for (const [_quoiId, quoi] of area.quoiMap) {
        const index = quoi.entities.findIndex(e => e.entity_id === entity.entity_id);
        if (index !== -1) {
          quoi.entities[index] = entity;
        }
      }
    }

    if (this.unassigned) {
      for (const [_quoiId, quoi] of this.unassigned.quoiMap) {
        const index = quoi.entities.findIndex(e => e.entity_id === entity.entity_id);
        if (index !== -1) {
          quoi.entities[index] = entity;
        }
      }
    }
  }

  /**
   * Supprime une entité de la structure.
   */
  private removeEntityFromStructure(entity: HaStructuredEntity): void {
    // Supprimer de toutes les areas
    for (const [_areaId, area] of this.areas) {
      for (const [qId, quoi] of area.quoiMap) {
        quoi.entities = quoi.entities.filter(e => e.entity_id !== entity.entity_id);
        // Nettoyer les QUOI vides
        if (quoi.entities.length === 0) {
          area.quoiMap.delete(qId);
        }
      }
      // ⚠️ Ex "nettoyer les areas vides" (this.areas.delete(areaId) si quoiMap vide) — RETIRÉ le
      // 10/08/2026, bug réel constaté en conditions réelles : une area vient d'être créée par
      // AreaEnsureService.resolveOrCreateArea (via addArea, quoiMap vide tant qu'aucune entité ne
      // lui est encore rattachée dans CE registre local — l'assignation arrive séparément, de façon
      // asynchrone, via un futur entity_registry_updated poussé par HA) ; si ce nettoyage tournait
      // pour la mise à jour d'une entité complètement différente pendant cette fenêtre, l'area
      // fraîchement créée disparaissait aussitôt du registre local — alors qu'elle existe bel et
      // bien côté HA. AreaEnsureService.findByName() ne la retrouvait alors plus, redéclenchait une
      // création WS, rejetée par HA ("name already in use") : c'est la cause des zigbee "mal pris en
      // compte" au démarrage (nombre variable, dépend du hasard des mises à jour d'entités
      // concurrentes). Une area a par ailleurs sa propre suppression, réelle celle-ci, câblée sur le
      // vrai événement WS area_registry_updated (voir removeArea() / AppService.ts) — ce nettoyage
      // "areas vides" était de toute façon redondant avec elle, en plus d'être incorrect.
    }

    // Supprimer de unassigned
    if (this.unassigned) {
      for (const [qId, quoi] of this.unassigned.quoiMap) {
        quoi.entities = quoi.entities.filter(e => e.entity_id !== entity.entity_id);
        if (quoi.entities.length === 0) {
          this.unassigned.quoiMap.delete(qId);
        }
      }
    }

    // Supprimer des devices
    for (const [_dId, device] of this.devices) {
      device.entities = device.entities.filter(e => e.entity_id !== entity.entity_id);
    }
  }

  /**
   * Supprime une entité du registre.
   * 
   * @param entityId - ID de l'entité à supprimer
   * @returns true si l'entité a été supprimée
   */
  removeEntity(entityId: string): boolean {
    const entity = this.entityMap.get(entityId);
    
    if (!entity) {
      return false;
    }

    this.removeEntityFromStructure(entity);
    this.entityMap.delete(entityId);
    this.invalidateLieuGraph();
    this.logger.debug('ha:structure_registry', `Entité supprimée: ${entityId}`);

    return true;
  }

  /**
   * Ajoute une nouvelle area au registre.
   * 
   * @param areaData - Données de l'area à ajouter
   */
  addArea(areaData: { area_id: string; name: string; picture?: string }): HaArea {
    const area: HaArea = {
      area_id: areaData.area_id,
      name: areaData.name,
      picture: areaData.picture,
      quoiMap: new Map(),
    };

    this.areas.set(area.area_id, area);
    this.logger.debug('ha:structure_registry', `Area ajoutée: ${area.area_id} (${area.name})`);

    return area;
  }

  /**
   * Met à jour une area.
   * 
   * @param areaData - Données de l'area à mettre à jour
   * @returns L'area mise à jour ou undefined si non trouvée
   */
  updateArea(areaData: { area_id: string; name: string; picture?: string }): HaArea | undefined {
    const area = this.areas.get(areaData.area_id);
    
    if (!area) {
      return undefined;
    }

    area.name = areaData.name;
    if (areaData.picture !== undefined) {
      area.picture = areaData.picture;
    }

    this.logger.debug('ha:structure_registry', `Area mise à jour: ${area.area_id}`);
    return area;
  }

  /**
   * Supprime une area du registre.
   * 
   * @param areaId - ID de l'area à supprimer
   * @returns true si l'area a été supprimée
   */
  removeArea(areaId: string): boolean {
    const area = this.areas.get(areaId);
    
    if (!area) {
      return false;
    }

    // Déplacer les entités de cette area vers unassigned
    if (this.unassigned) {
      for (const [_qId, quoi] of area.quoiMap) {
        for (const entity of quoi.entities) {
          entity.area_id = undefined;
          this.addEntityToQuoiInArea(entity, this.unassigned);
        }
      }
    }

    this.areas.delete(areaId);
    this.logger.debug('ha:structure_registry', `Area supprimée: ${areaId}`);

    return true;
  }

  /**
   * Ajoute un nouveau device au registre.
   * 
   * @param deviceData - Données du device à ajouter
   */
  addDevice(deviceData: {
    device_id: string;
    name: string;
    area_id?: string;
    identifiers?: any[];
    manufacturer?: string;
    model?: string;
    via_device_id?: string;
  }): HaDevice {
    const device: HaDevice = {
      device_id: deviceData.device_id,
      name: deviceData.name,
      identifiers: deviceData.identifiers,
      manufacturer: deviceData.manufacturer,
      model: deviceData.model,
      via_device_id: deviceData.via_device_id,
      area_id: deviceData.area_id,
      entities: [],
    };

    this.devices.set(device.device_id, device);
    this.logger.debug('ha:structure_registry', `Device ajouté: ${device.device_id} (${device.name})`);

    return device;
  }

  /**
   * Met à jour un device.
   * 
   * @param deviceData - Données du device à mettre à jour
   * @returns Le device mise à jour ou undefined si non trouvé
   */
  updateDevice(deviceData: {
    device_id: string;
    name?: string;
    area_id?: string;
    identifiers?: any[];
    manufacturer?: string;
    model?: string;
    via_device_id?: string;
  }): HaDevice | undefined {
    const device = this.devices.get(deviceData.device_id);
    
    if (!device) {
      return undefined;
    }

    if (deviceData.name !== undefined) {
      device.name = deviceData.name;
    }
    if (deviceData.area_id !== undefined) {
      device.area_id = deviceData.area_id;
    }
    if (deviceData.identifiers !== undefined) {
      device.identifiers = deviceData.identifiers;
    }
    if (deviceData.manufacturer !== undefined) {
      device.manufacturer = deviceData.manufacturer;
    }
    if (deviceData.model !== undefined) {
      device.model = deviceData.model;
    }
    if (deviceData.via_device_id !== undefined) {
      device.via_device_id = deviceData.via_device_id;
    }

    this.logger.debug('ha:structure_registry', `Device mis à jour: ${device.device_id}`);
    return device;
  }

  /**
   * Supprime un device du registre.
   * 
   * @param deviceId - ID du device à supprimer
   * @returns true si le device a été supprimé
   */
  removeDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    
    if (!device) {
      return false;
    }

    // Supprimer les entités du device
    for (const entity of device.entities) {
      this.entityMap.delete(entity.entity_id);
    }

    this.devices.delete(deviceId);
    this.logger.debug('ha:structure_registry', `Device supprimé: ${deviceId}`);

    return true;
  }

  /**
   * Récupère le registre structuré complet.
   */
  getRegistry(): HaStructuredRegistry {
    return {
      areas: new Map(this.areas),
      unassigned: this.unassigned ? { ...this.unassigned } : undefined,
      devices: new Map(this.devices),
      lastFullSync: this.lastFullSync || new Date(0),
      entityCount: this.entityMap.size,
      areaCount: this.areas.size,
      deviceCount: this.devices.size,
    };
  }

  /**
   * Récupère une entité structurée par son ID.
   * 
   * @param entityId - ID de l'entité
   * @returns L'entité structurée ou undefined
   */
  getEntity(entityId: string): HaStructuredEntity | undefined {
    return this.entityMap.get(entityId);
  }

  /**
   * Récupère toutes les entités structurées.
   */
  getAllEntities(): HaStructuredEntity[] {
    return Array.from(this.entityMap.values());
  }

  /**
   * Récupère les entités par QUOI (quoi_id).
   * 
   * @param quoiId - ID du QUOI à filtrer
   * @returns Tableau d'entités appartenant à ce QUOI
   */
  getEntitiesByQuoi(quoiId: string): HaStructuredEntity[] {
    const entities: HaStructuredEntity[] = [];

    // Parcourir toutes les areas
    for (const [, area] of this.areas) {
      const quoi = area.quoiMap.get(quoiId);
      if (quoi) {
        entities.push(...quoi.entities);
      }
    }

    // Parcourir unassigned
    if (this.unassigned) {
      const quoi = this.unassigned.quoiMap.get(quoiId);
      if (quoi) {
        entities.push(...quoi.entities);
      }
    }

    return entities;
  }

  /**
   * Récupère les entités par Area.
   * 
   * @param areaId - ID de l'area à filtrer
   * @returns Tableau d'entités appartenant à cette area
   */
  getEntitiesByArea(areaId: string): HaStructuredEntity[] {
    const area = this.areas.get(areaId);
    
    if (!area) {
      return [];
    }

    const entities: HaStructuredEntity[] = [];
    for (const [, quoi] of area.quoiMap) {
      entities.push(...quoi.entities);
    }

    return entities;
  }

  /**
   * Récupère les entités par Area et QUOI.
   *
   * @param areaId - ID de l'area à filtrer
   * @param quoiId - ID du QUOI à filtrer
   * @returns Tableau d'entités appartenant à cette area et ce QUOI
   */
  getEntitiesByAreaAndQuoi(areaId: string, quoiId: string): HaStructuredEntity[] {
    const area = this.areas.get(areaId);

    if (!area) {
      return [];
    }

    const quoi = area.quoiMap.get(quoiId);
    return quoi ? [...quoi.entities] : [];
  }

  /**
   * Résout les entités d'un QUOI (optionnel) dont le lieu correspond à au moins un des termes
   * demandés — recherche volontairement indépendante du niveau taxonomique auquel chaque terme
   * est codifié (lieu/area, lieu_pere, lieu_grand_pere pour un lieu "large" ; lieu_precis pour un
   * repère fin) : "toilettes du haut" (lieu/area), "étage" (lieu_pere), "maison" (lieu_grand_pere
   * pour la plupart des entités, mais aussi lieu_principal littéral d'une area technique — les
   * deux se combinent sans conflit), "salon" (lieu_precis d'une lumière de la Salle). `quoi` est
   * le niveau de filtrage principal : on part des entités de ce QUOI, puis on ne garde que
   * celles dont le lieu correspond — jamais l'inverse (demande utilisateur 10/08/2026).
   *
   * Un terme matche une entité de deux façons distinctes, jamais combinées :
   *  - directement, si son lieu_precis (propre à CETTE entité, ex: "plafonnier", "escalier")
   *    égale le terme — un repère précis est un simple label local, jamais un nœud du graphe :
   *    plusieurs pièces sans rapport réutilisent le même label ("plafonnier" apparaît dans une
   *    dizaine de pièces différentes) — le laisser participer au graphe de containment ci-dessous
   *    ferait converger toutes ces pièces vers le même nœud "plafonnier" et un terme comme
   *    "toilettes du haut" (dont c'est un enfant) ramènerait alors TOUTES les pièces ayant elles
   *    aussi un "plafonnier", bug réel observé le 10/08/2026 lors du test en direct de "toilettes
   *    de l'étage".
   *  - via le graphe de containment (grand_pere → pere → lieu/area uniquement, PAS lieu_precis) :
   *    le lieu/area de l'entité tombe dans le sous-arbre du terme — ce graphe ne représente que
   *    de l'imbrication physique réelle (pièce ⊂ étage ⊂ maison), jamais des labels répétés.
   *
   * `lieuTerms` vide → retourne simplement les entités du QUOI (comportement de
   * getEntitiesByQuoi). Plusieurs éléments du tableau → union des entités trouvées pour chacun
   * (OU, pas ET : "lieux" porte aussi bien un lieu unique qualifié que plusieurs lieux visés
   * séparément, ex. ["salon", "cuisine"] — voir regles_mistral.txt §2.1, "lieux" toujours un
   * tableau).
   *
   * Chaque élément peut lui-même être une phrase composée (ex: "plafonnier de la chambre") —
   * un lieu_precis comme "plafonnier" ou "chevet" est normalement partagé par plusieurs pièces
   * (demande utilisateur 10/08/2026 : "il est normal que le lieu précis existe dans plusieurs
   * pièces... il faut pouvoir dire éteins le plafonnier de la chambre"). On tente d'abord
   * l'élément TEL QUEL comme un seul terme (cas normal : nom d'area réel type "toilettes du
   * haut", ou lieu_precis seul type "salon") ; seulement s'il ne matche AUCUNE entité du QUOI,
   * on le découpe en mots (hors mots vides "de/du/des/la/le/les/l/au/aux/à") et on exige que
   * CHACUN matche (ET), pour distinguer "le plafonnier" (partout) de "le plafonnier de la
   * chambre" (une seule pièce) sans casser le cas d'une phrase entière qui désigne déjà un nœud
   * réel du graphe.
   *
   * @param quoiId - ID du QUOI à filtrer, ou undefined pour ne filtrer que par lieu
   * @param lieuTerms - termes de lieu à résoudre (déjà en langage naturel, pas nécessairement slugifiés)
   */
  getEntitiesByQuoiAndLieux(quoiId: string | undefined, lieuTerms: string[]): HaStructuredEntity[] {
    this.rebuildLieuGraphIfNeeded();

    const candidates = quoiId ? this.getEntitiesByQuoi(quoiId) : this.getAllEntities();
    if (lieuTerms.length === 0) return candidates;

    const matched = new Set<HaStructuredEntity>();
    for (const phrase of lieuTerms) {
      const wholeSlug = this.slugifyLieu(phrase);
      const wholeMatches = candidates.filter((e) => this.matchesLieuTerm(e, wholeSlug));
      if (wholeMatches.length > 0) {
        for (const e of wholeMatches) matched.add(e);
        continue;
      }

      const subTerms = this.tokenizeLieuPhrase(phrase);
      if (subTerms.length < 2) continue;
      for (const entity of candidates) {
        if (subTerms.every((sub) => this.matchesLieuTerm(entity, sub))) matched.add(entity);
      }
    }

    return [...matched];
  }

  /** Un terme (déjà slugifié) matche une entité directement (son propre lieu_precis) ou via le
   *  sous-arbre de containment de son lieu/area — voir getEntitiesByQuoiAndLieux. */
  private matchesLieuTerm(entity: HaStructuredEntity, termSlug: string): boolean {
    const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
    const precis = taxonomy?.slug_precis;
    if (typeof precis === 'string' && precis === termSlug) return true;

    const lieu = (typeof taxonomy?.slug_lieu === 'string' && taxonomy.slug_lieu) || entity.area_id;
    return lieu !== undefined && this.collectLieuSubtree(termSlug).has(lieu);
  }

  private readonly LIEU_STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'au', 'aux', 'a', 'et']);

  /** Découpe une phrase de lieu en mots significatifs (hors mots vides français) — utilisé
   *  uniquement en repli quand la phrase entière ne matche aucun nœud (voir getEntitiesByQuoiAndLieux). */
  private tokenizeLieuPhrase(phrase: string): string[] {
    return phrase
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && !this.LIEU_STOPWORDS.has(word));
  }

  /** Ensemble des slugs atteignables depuis lieuSlug (lui inclus) en suivant les arêtes
   *  parent→enfant du graphe de containment (grand_pere → pere → lieu/area) — sûr vis-à-vis des
   *  cycles (ex: "maison" est à la fois ancêtre de "rez_de_chaussee" pour la plupart des pièces
   *  ET, via une area technique du même nom, un lieu enfant de "rez_de_chaussee" — un parcours en
   *  profondeur avec ensemble de nœuds visités traverse ce genre de boucle sans souci). */
  private collectLieuSubtree(lieuSlug: string): Set<string> {
    const visited = new Set<string>();
    const stack = [lieuSlug];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = this.lieuChildren.get(current);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) stack.push(child);
        }
      }
    }
    return visited;
  }

  private rebuildLieuGraphIfNeeded(): void {
    if (!this.lieuGraphDirty) return;

    this.lieuChildren.clear();

    for (const entity of this.entityMap.values()) {
      const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
      if (!taxonomy) continue;

      // lieu_precis volontairement exclu : c'est un label local à l'entité (voir
      // getEntitiesByQuoiAndLieux), jamais une arête du graphe de containment.
      const levels = [taxonomy.slug_grand_pere, taxonomy.slug_pere, taxonomy.slug_lieu]
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (levels.length < 2) continue;

      for (let i = 0; i + 1 < levels.length; i++) {
        const parent = levels[i]!;
        const child = levels[i + 1]!;
        if (parent === child) continue;
        if (!this.lieuChildren.has(parent)) this.lieuChildren.set(parent, new Set());
        this.lieuChildren.get(parent)!.add(child);
      }
    }

    this.lieuGraphDirty = false;
  }

  private invalidateLieuGraph(): void {
    this.lieuGraphDirty = true;
  }

  private slugifyLieu(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
  }

  /**
   * Récupère le nombre d'entités.
   */
  getEntityCount(): number {
    return this.entityMap.size;
  }

  /**
   * Récupère toutes les areas.
   */
  getAreas(): Map<string, HaArea> {
    return new Map(this.areas);
  }

  /**
   * Récupère une area par son ID.
   * 
   * @param areaId - ID de l'area
   * @returns L'area ou undefined
   */
  getArea(areaId: string): HaArea | undefined {
    return this.areas.get(areaId);
  }

  /**
   * Récupère toutes les areas connues — utilisé par AreaEnsureService pour rechercher une area
   * par nom (dédoublonnage), aucune recherche par nom n'existant côté HA WS.
   */
  getAllAreas(): HaArea[] {
    return Array.from(this.areas.values());
  }

  /**
   * Récupère toutes les devices.
   */
  getDevices(): Map<string, HaDevice> {
    return new Map(this.devices);
  }

  /**
   * Récupère un device par son ID.
   * 
   * @param deviceId - ID du device
   * @returns Le device ou undefined
   */
  getDevice(deviceId: string): HaDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Récupère l'area non assignée.
   */
  getUnassignedArea(): HaArea | undefined {
    return this.unassigned;
  }

  /**
   * Récupère le catalogue des QUOI.
   */
  getQuoiCatalog(): HaQuoiDefinition[] {
    return this.classifier.getQuoiCatalog();
  }

  /**
   * ⭐ Catalogue de tous les lieux connus, tous niveaux confondus (lieu_precis, lieu/area,
   * lieu_pere, lieu_grand_pere) — dérivé de attributs_taxonomie de chaque entité, valeurs
   * "affichage" (pas les slugs). Destiné à une exposition statique côté `ia` (voir
   * `techniques-socle-ha-mqtt_specs` §8.3.2, `applications/ia/src/domain/rules.ts`) : demande
   * utilisateur — cette liste change rarement (seulement à l'ajout/modification/suppression de
   * matériel), transmettre à Mistral une vérité déjà connue évite un aller-retour d'outil et,
   * bien plus important, évite qu'il devine/halluciner qu'un lieu n'existe pas faute de donnée
   * sous les yeux (source du bug "quoi_introuvable" injustifié constaté en conditions réelles).
   * Calcul direct à chaque appel (pas de cache dirty-flag comme le graphe de containment
   * ci-dessus) : un simple passage sur les entités, coût négligeable à cette échelle.
   */
  getLieuCatalog(): string[] {
    const lieux = new Set<string>();
    for (const entity of this.entityMap.values()) {
      const taxonomy = entity.attributes?.attributs_taxonomie as Record<string, unknown> | undefined;
      if (!taxonomy) continue;
      for (const field of ['lieu_precis', 'lieu_principal', 'lieu_pere', 'lieu_grand_pere'] as const) {
        const value = taxonomy[field];
        if (typeof value === 'string' && value) lieux.add(value);
      }
    }
    return [...lieux].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  /**
   * Récupère le timestamp de la dernière synchronisation complète.
   */
  getLastFullSync(): Date | null {
    return this.lastFullSync;
  }

  /**
   * Met à jour le timestamp de la dernière synchronisation complète.
   */
  setLastFullSync(date: Date): void {
    this.lastFullSync = date;
  }

  /**
   * Efface toutes les données du registre.
   */
  clear(): void {
    this.areas.clear();
    this.devices.clear();
    this.entityMap.clear();
    this.lastFullSync = null;
    this.invalidateLieuGraph();

    if (this.config.includeUnassigned) {
      this.unassigned = this.createUnassignedArea();
    }

    this.logger.info('ha:structure_registry', 'Registre structuré vidé');
  }

  /**
   * Reconstruit complètement le registre.
   * Utile après une reconnexion HA complète.
   */
  rebuild(
    rawEntities: HaRawEntity[],
    rawAreas: Array<{ area_id: string; name: string; picture?: string }>,
    rawDevices: Array<{
      device_id: string;
      name: string;
      area_id?: string;
      identifiers?: any[];
      manufacturer?: string;
      model?: string;
      via_device_id?: string;
    }>,
    entityRegistry: Array<{
      entity_id: string;
      domain: string;
      device_class?: string;
      area_id?: string;
      device_id?: string;
    }>
  ): HaStructuredRegistry {
    this.clear();
    return this.initialize(rawEntities, rawAreas, rawDevices, entityRegistry);
  }
}
