export class FloorplanSelector {
  private container: HTMLElement;
  private dataService: any;
  private onSelectCallback: (floorplanId: string) => void;

  constructor(container: HTMLElement, dataService: any, onSelectCallback: (floorplanId: string) => void) {
    this.container = container;
    this.dataService = dataService;
    this.onSelectCallback = onSelectCallback;
  }

  render(): void {
    this.container.innerHTML = '';
    
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
      padding: 20px;
      background: #f5f5f5;
      min-height: 100vh;
    `;

    const floorplans = this.dataService.getAllFloorplans();
    const currentId = this.dataService.getCurrentFloorplanId();

    Object.entries(floorplans).forEach(([id, plan]: [string, any]) => {
      const card = this.createFloorplanCard(id, plan, currentId === id);
      wrapper.appendChild(card);
    });

    this.container.appendChild(wrapper);
  }

  private createFloorplanCard(id: string, plan: any, isCurrent: boolean): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = `
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      cursor: pointer;
      transition: all 0.3s ease;
      border: ${isCurrent ? '3px solid #007bff' : '1px solid #ddd'};
      display: flex;
      flex-direction: column;
      height: 100%;
    `;

    card.addEventListener('mouseover', () => {
      if (!isCurrent) {
        card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        card.style.transform = 'translateY(-4px)';
      }
    });

    card.addEventListener('mouseout', () => {
      if (!isCurrent) {
        card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
        card.style.transform = 'translateY(0)';
      }
    });

    // Titre du plan EN HAUT
    const titleContainer = document.createElement('div');
    titleContainer.style.cssText = `
      padding: 12px;
      background: ${isCurrent ? '#007bff' : '#f8f9fa'};
      border-bottom: 1px solid #ddd;
    `;

    const title = document.createElement('h3');
    title.textContent = id;
    title.style.cssText = `
      margin: 0;
      font-size: 16px;
      font-weight: bold;
      color: ${isCurrent ? 'white' : '#333'};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;

    titleContainer.appendChild(title);

    // Image du plan
    const imageContainer = document.createElement('div');
    imageContainer.style.cssText = `
      width: 100%;
      height: 200px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 14px;
      position: relative;
      flex-shrink: 0;
    `;

    const img = document.createElement('img');
    
    // Obtenir l'image depuis le cache
    const cachedImage = this.dataService.getFloorplanImage(id);
    if (cachedImage) {
      img.src = cachedImage.src;
    } else {
      // Fallback : construire l'URL si pas en cache
      img.src = this.dataService.getFloorplanImageUrl(plan.filename);
    }
    
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
    `;
    img.onerror = () => {
      imageContainer.innerHTML = '📐 Plan non disponible';
    };
    imageContainer.appendChild(img);

    // Info du plan EN BAS
    const infoContainer = document.createElement('div');
    infoContainer.style.cssText = `
      padding: 12px;
      background: white;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    `;

    const positions = this.dataService.getPositionsForFloorplan(id);
    const info = document.createElement('p');
    info.textContent = `📍 ${positions.length} entité(s)`;
    info.style.cssText = `
      margin: 0 0 8px 0;
      font-size: 12px;
      color: #666;
    `;

    const status = document.createElement('p');
    status.textContent = isCurrent ? '✓ Plan actif' : 'Cliquer pour sélectionner';
    status.style.cssText = `
      margin: 0;
      font-size: 12px;
      color: ${isCurrent ? '#007bff' : '#999'};
      font-weight: ${isCurrent ? 'bold' : 'normal'};
    `;

    infoContainer.appendChild(info);
    infoContainer.appendChild(status);

    // Assembler la carte
    card.appendChild(titleContainer);
    card.appendChild(imageContainer);
    card.appendChild(infoContainer);

    card.addEventListener('click', () => {
      this.dataService.setCurrentFloorplanId(id);
      this.onSelectCallback(id);
      this.render(); // Rafraîchir pour mettre à jour l'indicateur du plan actif
    });

    return card;
  }
}