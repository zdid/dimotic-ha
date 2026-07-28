/**
 * Classe pour gérer le drag and drop d'un élément avec des contraintes de mouvement.
 * L'élément ne peut pas sortir d'une zone définie (par défaut, son conteneur parent).
 */
export class DragAndDropConstrained {
  private element: HTMLElement;
  private container: HTMLElement;
  private isDragging: boolean = false;
  private offsetX: number = 0;
  private offsetY: number = 0;
  private onDragEnd?:  (finalPosition: {x: number, y: number}) => void;
  private constraintMode: 'full' | 'center';
  private dragBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

  /**
   * @param elementSelector - Sélecteur CSS de l'élément à rendre "draggable".
   *                         Le conteneur parent sera utilisé automatiquement comme zone de mouvement.
   * @param onDragEnd - Callback appelé à la fin du drag avec la position finale
   * @param constraintMode - Mode de contrainte: 'full' (objet entier dans la zone) ou 'center' (centre dans la zone)
   */
  constructor(
    elementSelector: string,
    onDragEnd?: (finalPosition: {x: number, y: number}) => void,
    constraintMode: 'full' | 'center' = 'center'
  ) {
    this.element = document.querySelector<HTMLElement>(elementSelector)!;
    if (!this.element) {
      throw new Error(`Élément introuvable avec le sélecteur : ${elementSelector}`);
    }

    // Utilise toujours le parent direct comme conteneur
    this.container = this.element.parentElement!;

    if (!this.container) {
      throw new Error("Conteneur introuvable.");
    }

    // Stocker le callback de fin de drag
    this.onDragEnd = onDragEnd;
    this.constraintMode = constraintMode;

    console.log(`[TRACE] DragAndDropConstrained initialisé avec mode de contrainte: ${constraintMode}`);

    // Initialise les événements
    this.init();
  }

  /**
   * Initialise les écouteurs d'événements pour le drag and drop.
   */
  private init(): void {
    console.log(`[TRACE] DragAndDropConstrained.init() appelé pour l'élément:`, this.element);
    
    this.element.style.position = "absolute";
    this.element.style.cursor = "move";
    this.element.style.userSelect = "none";

    console.log(`[TRACE] Ajout des écouteurs d'événements`);
    this.element.addEventListener("mousedown", this.startDrag);
    // Ne pas ajouter les écouteurs globaux ici - ils seront ajoutés au début du drag
    console.log(`[TRACE] Écouteurs d'événements ajoutés avec succès`);
  }

  /**
   * Début du glisser : calcule les offsets et active le mode "dragging".
   * @param event - Événement de souris.
   */
  private startDrag = (event: MouseEvent): void => {
    console.log(`[TRACE] DragAndDropConstrained.startDrag() appelé`, event);
    
    // Vérifier si on clique sur une fenêtre contextuelle
    const contextWindow = document.querySelector('.context-window');
    if (contextWindow && contextWindow.contains(event.target as Node)) {
        console.log(`[TRACE] Clic sur fenêtre contextuelle - drag ignoré`);
        return;
    }
    
    // Vérifier si une fenêtre contextuelle est ouverte
    const windowManager = (window as any).ContextWindowManager2;
    if (windowManager && windowManager.getInstance().hasOpenWindow()) {
        console.log(`[TRACE] Fenêtre contextuelle ouverte - drag ignoré`);
        return;
    }
    
    event.preventDefault();
    this.isDragging = true;

    // Ajouter les écouteurs globaux seulement maintenant
    document.addEventListener("mousemove", this.drag);
    document.addEventListener("mouseup", this.endDrag);
    console.log(`[TRACE] Écouteurs globaux ajoutés pour le drag`);

    const rect = this.element.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    
    // Calculer les offsets en fonction du mode de contrainte
    if (this.constraintMode === 'full') {
      // Mode 'full': offsets calculés par rapport au coin supérieur gauche
      // Cela permet de maintenir l'objet entièrement dans la zone
      this.offsetX = event.clientX - rect.left;
      this.offsetY = event.clientY - rect.top;
      console.log(`[TRACE] Offset calculé en mode 'full' (coin supérieur gauche):`, {offsetX: this.offsetX, offsetY: this.offsetY});

      this.dragBounds = {
        minX: containerRect.left,
        maxX: containerRect.right - rect.width,
        minY: containerRect.top,
        maxY: containerRect.bottom - rect.height
      };
    } else {
      // Mode 'center': offsets calculés par rapport au centre
      // pour correspondre au transform: translate(-50%, -50%)
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      this.offsetX = event.clientX - centerX;
      this.offsetY = event.clientY - centerY;
      console.log(`[TRACE] Offset calculé en mode 'center' (centre):`, {offsetX: this.offsetX, offsetY: this.offsetY});

      this.dragBounds = {
        minX: containerRect.left , // + rect.width / 2,
        maxX: containerRect.right , // - rect.width / 2,
        minY: containerRect.top , // + rect.height / 2,
        maxY: containerRect.bottom // - rect.height / 2
      };
    }
  };

  /**
   * Pendant le glisser : déplace l'élément en respectant les contraintes du conteneur.
   * @param event - Événement de souris.
   */
  private drag = (event: MouseEvent): void => {
    if (!this.isDragging) {
      return;
    }
    
    console.log(`[TRACE] DragAndDropConstrained.drag() appelé`, event);
    
    // Calcule les nouvelles coordonnées de l'élément
    let newX = event.clientX - this.offsetX;
    let newY = event.clientY - this.offsetY;

    // Récupère les dimensions du conteneur et de l'élément
    const containerRect = this.container.getBoundingClientRect();
    const elementRect = this.element.getBoundingClientRect();
    const bounds = this.dragBounds;

    // Appliquer les contraintes selon le mode sélectionné
    if (this.constraintMode === 'full') {
      // Mode 'full': l'objet entier doit rester dans la zone
      // Contraintes pour ne pas sortir du conteneur (objet entier dans la zone)
      if (bounds) {
        newX = Math.max(bounds.minX, Math.min(newX, bounds.maxX));
        newY = Math.max(bounds.minY, Math.min(newY, bounds.maxY));
      }
      console.log(`[TRACE] Application des contraintes en mode 'full' (objet entier dans la zone)`);
    } else {
      // Mode 'center': seul le centre de l'objet doit rester dans la zone
      // Contraintes pour que le centre de l'élément reste dans le conteneur
      const centerX = event.clientX - this.offsetX;
      const centerY = event.clientY - this.offsetY;
      
      const constrainedCenterX = bounds
        ? Math.max(bounds.minX, Math.min(centerX, bounds.maxX))
        : centerX;
      const constrainedCenterY = bounds
        ? Math.max(bounds.minY, Math.min(centerY, bounds.maxY))
        : centerY;
      
      newX = constrainedCenterX;
      newY = constrainedCenterY;
      console.log(`[TRACE] Application des contraintes en mode 'center' (centre dans la zone)`);
    }

    // Applique les nouvelles coordonnées
    this.element.style.left = `${newX - containerRect.left}px`;
    this.element.style.top = `${newY - containerRect.top}px`;
    
    console.log(`[TRACE] Élément déplacé à:`, {left: this.element.style.left, top: this.element.style.top});
  };

  /**
   * Fin du glisser : désactive le mode "dragging".
   */
  private endDrag = (): void => {
    console.log(`[TRACE] DragAndDropConstrained.endDrag() appelé`);
    
    if (!this.isDragging) {
      console.log(`[TRACE] endDrag appelé alors que isDragging est false - ignoré`);
      return;
    }
    
    this.isDragging = false;
    console.log(`[TRACE] isDragging réinitialisé à false`);
    
    // Retirer les écouteurs globaux
    document.removeEventListener("mousemove", this.drag);
    document.removeEventListener("mouseup", this.endDrag);
    console.log(`[TRACE] Écouteurs globaux retirés`);
    
    // Appeler le callback de fin de drag si défini avec les coordonnées finales
    if (this.onDragEnd) {
      const elementRect = this.element.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      
      let finalPosition;
      if (this.constraintMode === 'full') {
        // Mode 'full': retourner les coordonnées du coin supérieur gauche par rapport au conteneur
        finalPosition = {
          x: parseFloat(this.element.style.left) || 0,
          y: parseFloat(this.element.style.top) || 0
        };
        console.log(`[TRACE] Position finale en mode 'full' (coin supérieur gauche):`, finalPosition);
      } else {
        // Mode 'center': retourner les coordonnées du centre par rapport au conteneur
        finalPosition = {
          x: elementRect.left - containerRect.left + elementRect.width / 2,
          y: elementRect.top - containerRect.top + elementRect.height / 2
        };
        console.log(`[TRACE] Position finale en mode 'center' (centre):`, finalPosition);
      }
      
      this.onDragEnd(finalPosition);
    }
  };

  /**
   * Nettoie les écouteurs d'événements (à appeler si la classe est détruite).
   */
  public destroy(): void {
    this.element.removeEventListener("mousedown", this.startDrag);
    document.removeEventListener("mousemove", this.drag);
    document.removeEventListener("mouseup", this.endDrag);
  }
}
