import { HAObject } from './HAObject';
import { ContextWindowManager } from './windows/ContextWindowManager';
import { ContextWindow } from './windows/ContextWindow';
import { DataService } from '../../services/DataService';

export abstract class BaseEntity extends HAObject {
  protected dimensions: { width: number; height: number };
  protected baseDimensions: { width: number; height: number };
  protected displayValues: Map<string, string | number> = new Map();
  protected visualStyle: 'icon' | 'card' | 'gauge' | 'slider' | 'minimal' = 'icon';
  private contextWindow: ContextWindow | null = null;
  protected dataService: DataService;
  protected colorScheme: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
  };

  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 24, height: 24 },
    dataService?: DataService
  ) {
    super(entity_id, position, dataService);
    this.dataService = dataService!;
    this.dimensions = dimensions;
    this.baseDimensions = { ...dimensions };
    
    this.colorScheme = {
      primary: '#4285F4',
      secondary: '#34A853',
      background: '#FFFFFF',
      text: '#333333'
    };
  }

  // Méthode pour définir les valeurs à afficher
  setDisplayValue(key: string, value: string | number): void {
    const normalizedValue = this.normalizeDisplayValue(value);
    this.displayValues.set(key, normalizedValue);
    this.updateDisplay();
  }

  protected normalizeDisplayValue(value: string | number): string | number {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'unknown' || normalized === 'unknow') {
        return 'N/A';
      }
    }
    return value;
  }

  // Méthode pour obtenir une valeur à afficher
  getDisplayValue(key: string): string | number | undefined {
    return this.displayValues.get(key);
  }

  // Méthode pour définir le style visuel
  setVisualStyle(style: 'icon' | 'card' | 'gauge' | 'slider' | 'minimal'): void {
    this.visualStyle = style;
    if (this.element) {
      this.element.className = this.element.className.replace(
        /\b(icon|card|gauge|slider|minimal)-style\b/g,
        ''
      );
      this.element.classList.add(`${style}-style`);
    }
  }

  // Méthode pour définir les dimensions
  setDimensions(width: number, height: number): void {
    this.baseDimensions = { width, height };
    this.dimensions = { width, height };
    if (this.element) {
      this.element.style.width = `${width}px`;
      this.element.style.height = `${height}px`;
    }
  }

  applyScale(scale: number): void {
    const width = Math.round(this.baseDimensions.width * scale);
    const height = Math.round(this.baseDimensions.height * scale);
    this.dimensions = { width, height };
    if (this.element) {
      this.element.style.width = `${width}px`;
      this.element.style.height = `${height}px`;
    }
  }

  // Méthode pour obtenir les dimensions
  getDimensions(): { width: number; height: number } {
    return this.dimensions;
  }
  
  // Méthode pour définir le schéma de couleurs
  setColorScheme(scheme: {
    primary?: string;
    secondary?: string;
    background?: string;
    text?: string;
  }): void {
    this.colorScheme = { ...this.colorScheme, ...scheme };
    this.updateDisplay();
  }

  // Méthode abstraite pour le rendu spécifique
  abstract renderEntity(): HTMLElement;

  // Implémentation de la méthode render de HAObject
  render(): HTMLElement {
    const container = this.renderEntity();

    // S'assurer que l'élément a un ID stable
    this.ensureElementHasId(container);
    
    // Appliquer les dimensions
    container.style.width = `${this.dimensions.width}px`;
    container.style.height = `${this.dimensions.height}px`;
    
    // Appliquer le style visuel
    container.classList.add(`${this.visualStyle}-style`);
    
    // Appliquer les couleurs
    this.applyColorScheme(container);
    
    // Appliquer la classe de base
    container.classList.add('base-entity', 'ha-object');

    const entity = this.dataService?.getEntity(this.entity_id);
    console.log('[TRACE] BaseEntity.render entity data:', {
      entity_id: this.entity_id,
      hasEntity: !!entity,
      area_name: entity?.area_name,
      device_name: entity?.device_name,
      name: entity?.name
    });
    if (entity?.area_name) {
      container.dataset.areaName = entity.area_name;
    }
    if (entity?.device_name) {
      container.dataset.deviceName = entity.device_name;
    }
    if (entity?.name) {
      container.dataset.entityName = entity.name;
    }
    
    this.element = container;
    if (this.contextWindow) {
      this.setupClickHandler();
    }
    return container;
  }

  // Appliquer le schéma de couleurs à un élément
  protected applyColorScheme(element: HTMLElement): void {
    element.style.setProperty('--entity-primary-color', this.colorScheme.primary);
    element.style.setProperty('--entity-secondary-color', this.colorScheme.secondary);
    element.style.setProperty('--entity-background-color', this.colorScheme.background);
    element.style.setProperty('--entity-text-color', this.colorScheme.text);
  }

  // Méthode pour créer un élément avec style de base
  protected createStyledElement(
    tag: string,
    className: string,
    content: string = ''
  ): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    element.innerHTML = content;
    this.applyColorScheme(element);
    return element;
  }

  // Méthode pour créer un badge de valeur
  protected createValueBadge(
    label: string,
    value: string | number,
    unit: string = ''
  ): HTMLElement {
    const badge = this.createStyledElement('div', 'value-badge');
    badge.innerHTML = `
      <span class="badge-label">${label}:</span>
      <span class="badge-value">${value}</span>
      ${unit ? `<span class="badge-unit">${unit}</span>` : ''}
    `;
    return badge;
  }

  // Méthode pour créer un indicateur d'état
  protected createStatusIndicator(status: 'on' | 'off' | 'warning' | 'error'): HTMLElement {
    const indicator = this.createStyledElement('div', 'status-indicator');
    
    let color, icon;
    switch (status) {
      case 'on':
        color = 'var(--entity-secondary-color)';
        icon = 'fa-check-circle';
        break;
      case 'off':
        color = '#999999';
        icon = 'fa-circle';
        break;
      case 'warning':
        color = '#FFC107';
        icon = 'fa-exclamation-triangle';
        break;
      case 'error':
        color = '#F44336';
        icon = 'fa-exclamation-circle';
        break;
    }
    
    indicator.innerHTML = `<i class="fas ${icon}" style="color: ${color}"></i>`;
    return indicator;
  }

  // Méthode pour créer un conteneur de valeurs
  protected createValuesContainer(): HTMLElement {
    const container = this.createStyledElement('div', 'values-container');
    
    this.displayValues.forEach((value, key) => {
      const badge = this.createValueBadge(key, value);
      container.appendChild(badge);
    });
    
    return container;
  }

  // Méthode pour créer un titre
  protected createTitle(title: string): HTMLElement {
    const titleElement = this.createStyledElement('div', 'entity-title');
    titleElement.textContent = title;
    return titleElement;
  }

  // Méthode pour créer une icône
  protected createIcon(iconClass: string, size: 'small' | 'medium' | 'large' = 'medium'): HTMLElement {
    const icon = this.createStyledElement('div', `entity-icon ${size}`);
    icon.innerHTML = `<i class="fas ${iconClass}"></i>`;
    return icon;
  }

  // Méthode pour créer un contrôleur (boutons, sliders, etc.)
  protected createController(type: 'button' | 'slider' | 'switch'): HTMLElement {
    switch (type) {
      case 'button':
        return this.createStyledElement('button', 'entity-button', '<i class="fas fa-power-off"></i>');
      case 'slider':
        const slider = this.createStyledElement('input', 'entity-slider');
        slider.setAttribute('type', 'range');
        slider.setAttribute('min', '0');
        slider.setAttribute('max', '100');
        return slider;
      case 'switch':
        return this.createStyledElement('div', 'entity-switch');
    }
  }

  // Méthode pour mettre à jour l'affichage (à implémenter par les classes filles)
  abstract updateDisplay(): void;

  // Méthode pour gérer les actions (à implémenter par les classes filles)
  abstract handleAction(action: string, value?: any): void;

  // Méthode pour définir la fenêtre contextuelle
  setContextWindow(window: ContextWindow): void {
    this.contextWindow = window;
    this.setupClickHandler();
  }

  // Méthode pour obtenir la fenêtre contextuelle
  getContextWindow(): ContextWindow | null {
    return this.contextWindow;
  }

  // Méthode pour configurer le gestionnaire de clics
  protected setupClickHandler(): void {
    if (this.element) {
      this.element.style.cursor = 'pointer';
      console.log('[TRACE] BaseEntity.setupClickHandler: listeners attached', {
        entity_id: this.entity_id,
        hasElement: !!this.element
      });
      this.element.addEventListener('mouseenter', () => {
        console.log('[TRACE] BaseEntity.mouseenter', { entity_id: this.entity_id });
        this.emitHoveredEntityLabel();
      });
      this.element.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[TRACE] BaseEntity.click', { entity_id: this.entity_id });
        this.emitHoveredEntityLabel();
        this.onClick();
      });
    }
  }

  private emitHoveredEntityLabel(): void {
    const labelParts: string[] = [];
    const element = this.element;

    console.log('[TRACE] BaseEntity.emitHoveredEntityLabel dataset:', {
      entity_id: this.entity_id,
      areaName: element?.dataset.areaName,
      deviceName: element?.dataset.deviceName,
      entityName: element?.dataset.entityName
    });

    if (element?.dataset.areaName) {
      labelParts.push(element.dataset.areaName);
    }
    if (element?.dataset.deviceName) {
      labelParts.push(element.dataset.deviceName);
    }
    if (element?.dataset.entityName) {
      labelParts.push(element.dataset.entityName);
    }

    if (labelParts.length === 0) {
      console.log('[TRACE] BaseEntity.emitHoveredEntityLabel: no label parts');
      return;
    }

    const label = labelParts.join(' / ');
    console.log('[TRACE] BaseEntity.emitHoveredEntityLabel label:', label);
    window.dispatchEvent(new CustomEvent('ha-object-focus', { detail: { label } }));
  }

  // Méthode appelée lors du clic
  protected onClick(): void {
    // Vérifier si nous sommes en mode paramétrage (edit-mode) pour ignorer les clics
    const floorPlanContainer = document.querySelector('.floorplan-container');
    if (floorPlanContainer && floorPlanContainer.classList.contains('edit-mode')) {
      // En mode paramétrage, ignorer les clics (pas de fenêtres modales)
      console.log('[TRACE] BaseEntity - Clic ignoré : mode paramétrage, pas d\'ouverture de fenêtre');
    } else {
      if (this.entity_id.startsWith('sensor.')) {
        return;
      }
      // En mode normal, ouvrir la fenêtre modale
      if (this.contextWindow) {
        const windowManager = ContextWindowManager.getInstance();
        windowManager.showWindow(this, this.contextWindow);
      }
    }
  }

  // Méthode pour mettre à jour la fenêtre contextuelle si elle est ouverte
  protected updateContextWindowIfOpen(): void {
    const windowManager = ContextWindowManager.getInstance();
    if (windowManager.hasOpenWindow() && windowManager.getCurrentWindow() === this.contextWindow) {
      console.log(`[TRACE] BaseEntity - Mise à jour de la fenêtre contextuelle pour ${this.entity_id}`);
      windowManager.updateCurrentWindow();
    }
  }

  // Méthode pour détruire l'entité
  destroy(): void {
    super.destroy();
    this.displayValues.clear();
  }
}