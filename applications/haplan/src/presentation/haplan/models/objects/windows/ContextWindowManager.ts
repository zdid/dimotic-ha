import { ContextWindow } from './ContextWindow';
import { BaseEntity } from '../BaseEntity';

export class ContextWindowManager {
  private static instance: ContextWindowManager;
  private currentWindow: ContextWindow | null = null;
  private container: HTMLElement;
  private overlay: HTMLElement;

  private constructor() {
    // Créer l'overlay qui contiendra tout
    this.overlay = document.createElement('div');
    this.overlay.id = 'context-windows-overlay';
    this.overlay.style.position = 'fixed';
    this.overlay.style.top = '0';
    this.overlay.style.left = '0';
    this.overlay.style.width = '100%';
    this.overlay.style.height = '100%';
    this.overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
    this.overlay.style.display = 'none';
    this.overlay.style.zIndex = '1000';

    // Créer le conteneur pour les fenêtres À L'INTÉRIEUR de l'overlay
    this.container = document.createElement('div');
    this.container.id = 'context-windows-container';
    this.container.style.position = 'absolute';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '1001';

    // Ajouter le conteneur à l'overlay
    this.overlay.appendChild(this.container);

    // Ajouter au body si possible
    if (typeof document !== 'undefined') {
      document.body.appendChild(this.overlay);
    }
  }

  public static getInstance(): ContextWindowManager {
    if (!ContextWindowManager.instance) {
      ContextWindowManager.instance = new ContextWindowManager();
    }
    return ContextWindowManager.instance;
  }

  // Méthode pour repositionner la fenêtre actuelle si nécessaire
  public repositionCurrentWindow(): void {
    if (this.currentWindow) {
      const entity = this.currentWindow.entity;
      const windowElement = this.currentWindow.element;
      this.positionWindowNearEntity(entity, windowElement);
    }
  }

  showWindow(entity: BaseEntity, cwindow: ContextWindow): void {
    console.log(`[TRACE] ContextWindowManager.showWindow() - Affichage de la fenêtre pour ${entity.getEntity_id()}`);
    
    // Fermer la fenêtre actuelle si elle existe
    if (this.currentWindow) {
      console.log(`[TRACE] ContextWindowManager - Fermeture de la fenêtre actuelle avant d'en ouvrir une nouvelle`);
      this.hideWindow();
    }

    // Stocker la fenêtre actuelle
    this.currentWindow = cwindow;
    console.log(`[TRACE] ContextWindowManager - Nouvelle fenêtre stockée`);

    // Positionner la fenêtre près de l'entité
    this.positionWindowNearEntity(entity, cwindow.element);

    // Appliquer la taille de police à la fenêtre
    this.applyFontSizeToWindow(cwindow.element);

    // Ajouter la fenêtre au conteneur
    this.container.appendChild(cwindow.element);

    // Autoriser les clics uniquement sur la fenêtre elle-meme
    cwindow.element.style.pointerEvents = 'auto';

    // Empêcher la propagation des clics depuis la fenêtre vers l'overlay
    cwindow.element.addEventListener('click', (e) => {
        console.log(`[TRACE] ContextWindowManager - Clic sur la fenêtre intercepté pour ${entity.getEntity_id()}`);
        e.stopPropagation();
    });

    // Afficher l'overlay
    this.overlay.style.display = 'block';
    this.overlay.style.pointerEvents = 'auto';

    // Laisser passer les clics vers l'overlay sauf pour la fenêtre
    this.container.style.pointerEvents = 'none';

    window.dispatchEvent(new CustomEvent('context-window-opened'));

    // Fermer la fenêtre quand on clique sur l'overlay (mais pas sur la fenêtre)
    this.overlay.onclick = (e) => {
        console.log(`[TRACE] ContextWindowManager - Clic sur overlay détecté`);
        
        // Vérifier que le clic n'est pas sur la fenêtre ou ses enfants
        if (this.currentWindow && !this.currentWindow.element.contains(e.target as Node)) {
            console.log(`[TRACE] ContextWindowManager - Clic en dehors de la fenêtre, fermeture`);
            this.hideWindow();
        } else {
            console.log(`[TRACE] ContextWindowManager - Clic sur la fenêtre ou ses enfants, ignorance`);
        }
    };

    // Fermer la fenêtre quand on appuie sur Échap
    document.addEventListener('keydown', this.handleKeyDown);
    
    // Ajouter un écouteur pour le redimensionnement
    try {
      window.addEventListener('resize', this.handleResize);
      
    } catch (error) {
      console.warn('[WARN] ContexteWindowManager: pas possible de mettre le addeventlistener sur le window (resize) a corriger des que possible')    
    }
  }

  // Méthode pour appliquer la taille de police à une fenêtre
  private applyFontSizeToWindow(windowElement: HTMLElement): void {
    const fontSize = localStorage.getItem('contextFontSize') || 'medium';
    let sizeValue = '14px';
    
    switch (fontSize) {
      case 'small':
        sizeValue = '12px';
        break;
      case 'medium':
        sizeValue = '14px';
        break;
      case 'large':
        sizeValue = '16px';
        break;
    }
    
    windowElement.style.fontSize = sizeValue;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hideWindow();
    }
  }

  hideWindow(): void {
    if (this.currentWindow) {
      // Ne pas appeler currentWindow.close() ici pour éviter la boucle infinie
      // La fenêtre est déjà en train de se fermer
      this.container.removeChild(this.currentWindow.element);
      this.currentWindow = null;
    }

    // Masquer l'overlay
    this.overlay.style.display = 'none';
    this.overlay.style.pointerEvents = 'none';

    // Désactiver les événements de pointer
    this.container.style.pointerEvents = 'none';

    window.dispatchEvent(new CustomEvent('context-window-closed'));

    // Retirer l'écouteur de touche
    document.removeEventListener('keydown', this.handleKeyDown);
    
    // Retirer l'écouteur de redimensionnement
    window.removeEventListener('resize', this.handleResize);
  }

  private handleResize = (): void => {
    // Utiliser debounce pour éviter les appels trop fréquents
    this.debouncedReposition();
  }

  private debounceTimer: number | null = null;
  private debouncedReposition = (): void => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = window.setTimeout(() => {
      this.repositionCurrentWindow();
      this.debounceTimer = null;
    }, 100); // Attendre 100ms après le dernier redimensionnement
  }
  
  // Méthode pour vérifier si une fenêtre est complètement visible
  private isWindowFullyVisible(windowElement: HTMLElement): boolean {
    const windowRect = windowElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Vérifier si la fenêtre est complètement visible
    const fullyVisible = (
      windowRect.left >= 0 &&
      windowRect.right <= viewportWidth &&
      windowRect.top >= 0 &&
      windowRect.bottom <= viewportHeight
    );
    
    console.log(`[TRACE] ContextWindowManager - Vérification visibilité: ${fullyVisible}`, {
      left: windowRect.left,
      right: windowRect.right,
      top: windowRect.top,
      bottom: windowRect.bottom,
      viewportWidth,
      viewportHeight
    });
    
    return fullyVisible;
  }
  
  // Méthode pour s'assurer que la fenêtre est complètement visible
  private ensureWindowIsVisible(windowElement: HTMLElement): void {
    const windowRect = windowElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let left = parseFloat(windowElement.style.left || '0');
    let top = parseFloat(windowElement.style.top || '0');
    const windowWidth = windowElement.offsetWidth;
    const windowHeight = windowElement.offsetHeight;
    
    // Corriger la position si la fenêtre dépasse
    if (windowRect.right > viewportWidth) {
      left = viewportWidth - windowWidth - 10;
      console.log(`[TRACE] ContextWindowManager - Correction position droite: ${left}`);
    }
    
    if (windowRect.left < 0) {
      left = 10;
      console.log(`[TRACE] ContextWindowManager - Correction position gauche: ${left}`);
    }
    
    if (windowRect.bottom > viewportHeight) {
      top = viewportHeight - windowHeight - 10;
      console.log(`[TRACE] ContextWindowManager - Correction position bas: ${top}`);
    }
    
    if (windowRect.top < 0) {
      top = 10;
      console.log(`[TRACE] ContextWindowManager - Correction position haut: ${top}`);
    }
    
    // Appliquer les corrections
    windowElement.style.left = `${left}px`;
    windowElement.style.top = `${top}px`;
    
    console.log(`[TRACE] ContextWindowManager - Position corrigée: (${left}, ${top})`);
  }

  private positionWindowNearEntity(entity: BaseEntity, windowElement: HTMLElement): void {
    // Obtenir la position de l'entité
    const entityElement = entity.getElement();
    
    if (entityElement) {
      const entityRect = entityElement.getBoundingClientRect();
      
      // Position par défaut à droite de l'entité
      let left = entityRect.right + 10;
      let top = entityRect.top;
      
      // Obtenir les dimensions de la fenêtre (après rendu)
      const windowWidth = windowElement.offsetWidth || 250; // Largeur par défaut
      const windowHeight = windowElement.offsetHeight || 200; // Hauteur par défaut
      
      // Obtenir les dimensions de la fenêtre du navigateur
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Vérifier si la fenêtre dépasse à droite
      if (left + windowWidth > viewportWidth) {
        // Essayer de positionner à gauche de l'entité
        left = entityRect.left - windowWidth - 10;
        
        // Si ça dépasse toujours à gauche, positionner à droite mais avec décalage
        if (left < 0) {
          left = Math.max(10, viewportWidth - windowWidth - 10);
        }
      }
      
      // Vérifier si la fenêtre dépasse en bas
      if (top + windowHeight > viewportHeight) {
        // Essayer de positionner au-dessus de l'entité
        top = entityRect.top - windowHeight - 10;
        
        // Si ça dépasse toujours en haut, positionner en bas mais avec décalage
        if (top < 0) {
          top = Math.max(10, viewportHeight - windowHeight - 10);
        }
      }
      
      // S'assurer que la fenêtre ne dépasse pas en haut ou à gauche
      left = Math.max(10, left);
      top = Math.max(10, top);
      
      // Positionner la fenêtre
      windowElement.style.position = 'absolute';
      windowElement.style.left = `${left}px`;
      windowElement.style.top = `${top}px`;
      windowElement.style.pointerEvents = 'auto';
      windowElement.style.zIndex = '1001';
      
      console.log(`[TRACE] ContextWindowManager - Fenêtre positionnée à (${left}, ${top}) avec dimensions (${windowWidth}x${windowHeight})`);
      
      // Vérifier si la fenêtre est complètement visible et ajuster si nécessaire
      setTimeout(() => {
        if (!this.isWindowFullyVisible(windowElement)) {
          console.log(`[TRACE] ContextWindowManager - Fenêtre pas complètement visible, repositionnement...`);
          this.ensureWindowIsVisible(windowElement);
        }
      }, 50); // Petit délai pour permettre le rendu
    } else {
      // Position par défaut centrée si l'élément n'est pas trouvé
      windowElement.style.position = 'absolute';
      windowElement.style.left = '50%';
      windowElement.style.top = '50%';
      windowElement.style.transform = 'translate(-50%, -50%)';
      windowElement.style.pointerEvents = 'auto';
      
      console.log(`[TRACE] ContextWindowManager - Position par défaut centrée appliquée`);
    }
  }

  // Méthode pour mettre à jour la fenêtre actuelle
  updateCurrentWindow(): void {
    if (this.currentWindow && this.currentWindow.updateDisplay) {
      this.currentWindow.updateDisplay();
    }
  }

  // Vérifier si une fenêtre est ouverte
  hasOpenWindow(): boolean {
    return this.currentWindow !== null;
  }

  // Obtenir la fenêtre actuelle
  getCurrentWindow(): ContextWindow | null {
    return this.currentWindow;
  }
}