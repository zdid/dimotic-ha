export class EntitySelector {
  private container: HTMLElement;
  private areaSelect!: HTMLSelectElement;
  private deviceSelect!: HTMLSelectElement;
  private entitySelect!: HTMLSelectElement;
  private areas: any[] = [];
  private devices: any[] = [];
  private entities: any[] = [];
  private onEntitySelectedCallback: (entity_id: string) => void;
  private existingObjects: Set<string> = new Set();
  private states: any = {}; // Ajouter le stockage des states

  constructor(container: HTMLElement, onEntitySelected: (entity_id: string) => void) {
    this.container = container;
    this.onEntitySelectedCallback = onEntitySelected;
    this.createSelectors();

    // // Gestionnaire pour fermer le menu si clic en dehors
    // document.addEventListener('mousedown', this.handleDocumentClick, true);
  }

  // Nettoyage si besoin (ex: à appeler lors de la destruction)
  // destroy(): void {
  //   document.removeEventListener('mousedown', this.handleDocumentClick, true);
  // }

  // // Masquer le menu
  // hide(): void {
  //   this.container.style.display = 'none';
  // }

  // // // Afficher le menu
  // show(): void {
  //    this.container.style.display = '';
  // }

  // Gestion du clic en dehors
  // private handleDocumentClick = (event: MouseEvent) => {
  //   if (!this.container.contains(event.target as Node)) {
  //     this.hide();
  //   }
  // };

  // Méthode pour définir les states
  setStates(states: any): void {
    this.states = states;
  }

  setExistingObjects(objectIds: string[]): void {
    this.existingObjects = new Set(objectIds);
  }

  private createSelectors(): void {
    this.container.innerHTML = `
      <div class="entity-selector">
        <select class="area-select">
          <option value="">Sélectionnez une pièce</option>
        </select>
        <select class="device-select" disabled>
          <option value="">Sélectionnez un appareil</option>
        </select>
        <select class="entity-select" disabled>
          <option value="">Sélectionnez une entité</option>
        </select>
      </div>
    `;

    this.areaSelect = this.container.querySelector('.area-select') as HTMLSelectElement;
    this.deviceSelect = this.container.querySelector('.device-select') as HTMLSelectElement;
    this.entitySelect = this.container.querySelector('.entity-select') as HTMLSelectElement;

    this.areaSelect.addEventListener('change', () => this.onAreaSelected());
    this.deviceSelect.addEventListener('change', () => this.onDeviceSelected());
    this.entitySelect.addEventListener('change', () => this.onEntitySelected());
  }

  // Méthode pour obtenir l'élément principal
  getElement(): HTMLElement {
    console.log(`[TRACE] getElement appelé, container:`, this.container);
    return this.container;
  }

  setData(tree: any): void {
    this.areas = this.filterAreas(tree);
    this.updateAreaSelect();
  }

  private filterAreas(areas: any[]): any[] {
    return areas.filter(area => {
      // Filtrer les areas qui ont des devices avec des entités
      if (!area.devices || area.devices.length === 0) {
        return false;
      }
      
      // Filtrer les devices qui ont des entités
      const filteredDevices = area.devices.filter((device: any) => {
        return device.entities && Object.keys(device.entities).length > 0;
      });
      
      area.devices = filteredDevices;
      return filteredDevices.length > 0;
    });
  }

  private updateAreaSelect(): void {
    this.areaSelect.innerHTML = '<option value="">Sélectionnez une pièce</option>';

    if (this.areas.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Aucune pièce disponible';
      option.disabled = true;
      this.areaSelect.appendChild(option);
      console.warn('Aucune pièce disponible dans l\'arborescence');
    } else {
      this.areas.forEach(area => {
        const option = document.createElement('option');
        option.value = area.id;
        option.textContent = area.name;
        this.areaSelect.appendChild(option);
      });
    }
    
    // Réinitialiser les sélecteurs dépendants
    this.deviceSelect.innerHTML = '<option value="">Sélectionnez un appareil</option>';
    this.deviceSelect.disabled = true;
    this.entitySelect.innerHTML = '<option value="">Sélectionnez une entité</option>';
    this.entitySelect.disabled = true;
  }

  private onAreaSelected(): void {
    const areaId = this.areaSelect.value;
    if (!areaId) {
      this.deviceSelect.innerHTML = '<option value="">Sélectionnez un appareil</option>';
      this.deviceSelect.disabled = true;
      this.entitySelect.innerHTML = '<option value="">Sélectionnez une entité</option>';
      this.entitySelect.disabled = true;
      return;
    }

    const area = this.areas.find(a => a.id === areaId);
    if (area && area.devices) {
      this.devices = area.devices;
      this.updateDeviceSelect();
      this.deviceSelect.disabled = false;
      
      // Si un seul device, le sélectionner automatiquement
      if (this.devices.length === 1) {
        this.deviceSelect.value = this.devices[0].id;
        this.onDeviceSelected();
      }
    }
  }

  private updateDeviceSelect(): void {
    this.deviceSelect.innerHTML = '<option value="">Sélectionnez un appareil</option>';

    if (this.devices.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Aucun appareil disponible';
      option.disabled = true;
      this.deviceSelect.appendChild(option);
      console.warn('Aucun appareil disponible pour la pièce sélectionnée');
    } else {
      this.devices.forEach(device => {
        if (device.entities && Object.keys(device.entities).length > 0) {
          const option = document.createElement('option');
          option.value = device.id;
          option.textContent = device.name;
          this.deviceSelect.appendChild(option);
        }
      });

      // Si un seul device, le sélectionner automatiquement
      if (this.devices.length === 1 && this.devices[0].entities) {
        this.deviceSelect.value = this.devices[0].id;
        this.onDeviceSelected();
      }
    }
  }

  private onDeviceSelected(): void {
    const deviceId = this.deviceSelect.value;
    console.log(`[TRACE] Device sélectionné: ${deviceId}`);
    
    if (!deviceId) {
      console.log(`[TRACE] Aucun device sélectionné, désactivation du combobox entité`);
      this.entitySelect.innerHTML = '<option value="">Sélectionnez une entité</option>';
      this.entitySelect.disabled = true;
      return;
    }

    const device = this.devices.find(d => d.id === deviceId);
    console.log(`[TRACE] Device trouvé:`, device);
    
    if (device && device.entities) {
      console.log(`[TRACE] Entités du device:`, device.entities);
      this.entities = Object.values(device.entities);
      console.log(`[TRACE] Entités converties en array:`, this.entities);
      this.updateEntitySelect();
      
      // Vérifier si des entités sont disponibles après filtrage
      const hasAvailableEntities = this.entitySelect.querySelectorAll('option:not([disabled])').length > 1;
      console.log(`[TRACE] Entités disponibles après filtrage: ${hasAvailableEntities}`);
      this.entitySelect.disabled = !hasAvailableEntities;
      
      if (!hasAvailableEntities) {
        console.warn(`[TRACE] Aucune entité disponible pour le device ${deviceId} après filtrage`);
      } else {
        console.log(`[TRACE] Combobox entité activé avec ${hasAvailableEntities} entités`);
      }
    } else {
      // Cas où device ou device.entities est undefined/null
      console.warn(`[TRACE] Aucune entité trouvée pour le device ${deviceId}`);
      this.entitySelect.innerHTML = '<option value="">Sélectionnez une entité</option>';
      this.entitySelect.disabled = true;
    }
  }

  private updateEntitySelect(): void {
    this.entitySelect.innerHTML = '<option value="">Sélectionnez une entité</option>';

    if (this.entities.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Aucune entité disponible';
      option.disabled = true;
      this.entitySelect.appendChild(option);
      console.warn('Aucune entité disponible pour l\'appareil sélectionné');
    } else {
      let entitiesAdded = 0;
      
      this.entities.forEach(entity => {
        // Filtrer les entités déjà présentes sur le plan
        if (this.existingObjects.has(entity.entity_id)) {
          return;
        }
        console.log("entity avant plantage",JSON.stringify(entity,null,2))
        // Filtrer les entités diagnostique/config
        if (entity.entity_id.startsWith('diagnostic.') || entity.entity_id.startsWith('config.')) {
          return;
        }
        
        const option = document.createElement('option');
        option.value = entity.entity_id;
        
        // Utiliser original_name directement depuis l'entité, sinon entity_id
        const displayName = entity.original_name || entity.name || entity.deviceName || entity.entity_id ;
        
        option.textContent = displayName;
        this.entitySelect.appendChild(option);
        entitiesAdded++;
      });
      
      if (entitiesAdded === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Aucune entité disponible (toutes déjà sur le plan ou filtrées)';
        option.disabled = true;
        this.entitySelect.appendChild(option);
        console.warn('Toutes les entités sont déjà sur le plan ou ont été filtrées');
      }
    }
  }

  private onEntitySelected(): void {
    const entity_id = this.entitySelect.value;
    if (entity_id) {
      this.onEntitySelectedCallback(entity_id);
    }
  }
}