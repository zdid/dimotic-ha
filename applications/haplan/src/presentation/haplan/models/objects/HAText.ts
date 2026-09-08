/**
 * HAText — élément de texte libre positionnable sur un plan HAPLAN, comme une icône d'entité mais
 * sans entity_id/état HA (⭐ 07/09/2026, fonctionnalité "texte libre", fonctionnelles-haplan_specs
 * v1.7). Volontairement PAS une sous-classe de `HAObject` : pas de `commandService`, pas d'état HA
 * à recevoir, pas d'action au clic — seuls le positionnement (glisser-déposer + poubelle) et
 * l'édition de contenu sont partagés avec les entités, repris ici directement plutôt qu'hérités
 * pour ne pas alourdir `HAObject` d'un cas qui ne le concerne pas.
 */
import { DragAndDropConstrained } from '../../ui/draganddropconstrained';
import { PositionManager, type TextEntry } from '../PositionManager';

export type HATextSize = 'small' | 'medium' | 'large';

/** Tailles en px côté web — mêmes trois paliers que le générateur ESP32 (voir
 *  generate_esphome_floorplan.py, TEXT_FONT_SIZE_BY_SIZE) et la carte Lovelace, pour un rendu
 *  cohérent d'un rendu à l'autre même si les valeurs exactes en px ne peuvent pas être identiques
 *  (échelles d'écran différentes). */
export const HA_TEXT_FONT_SIZE_PX: Record<HATextSize, number> = {
  small: 14,
  medium: 20,
  large: 28
};

export class HAText {
  private id: string;
  private text: string;
  private size: HATextSize;
  private color: string;
  private position: { x: number; y: number };
  private element: HTMLElement | null = null;
  private positionManager: PositionManager | undefined;
  private dragHandler: DragAndDropConstrained | null = null;

  constructor(id: string, text: string, position: { x: number; y: number }, size: HATextSize = 'medium', color: string = '#FFFFFF') {
    this.id = id;
    this.text = text;
    this.position = position;
    this.size = size;
    this.color = color;
  }

  getId(): string {
    return this.id;
  }

  getPosition(): { x: number; y: number } {
    return this.position;
  }

  setPosition(x: number, y: number): void {
    this.position = { x, y };
  }

  setPositionManager(positionManager: PositionManager): void {
    this.positionManager = positionManager;
  }

  getElement(): HTMLElement | null {
    return this.element;
  }

  setElement(element: HTMLElement): void {
    this.element = element;
  }

  private toEntry(): TextEntry {
    return { text: this.text, x: this.position.x, y: this.position.y, size: this.size, color: this.color };
  }

  render(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'haplan-text-object';
    el.id = `ha-text-${this.id}`;
    el.dataset.textId = this.id;
    el.textContent = this.text;
    // Taille de base posée via une classe CSS (pas de style inline) pour rester compatible avec
    // l'échelle réglable --plan-scale (voir .haplan-text-object dans styles.css).
    el.classList.add(`haplan-text-${this.size}`);
    el.style.position = 'absolute';
    el.style.color = this.color;
    el.style.whiteSpace = 'pre';
    el.style.userSelect = 'none';
    el.style.cursor = 'move';
    // Ombre portée noire — lisibilité garantie quelle que soit la zone du fond (image ou "page
    // libre") sous le texte, même raisonnement que buildSensorLabelCardMod (lovelace-generator.ts).
    el.style.textShadow = '0 0 3px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.9)';

    el.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.enterEditMode();
    });

    this.element = el;
    return el;
  }

  /** Édition inline — remplace temporairement le `<div>` par un `<textarea>` positionné au même
   *  endroit (mêmes styles left/top/transform, hérités du parent absolu), pour ne jamais entrer en
   *  conflit avec le `mousedown` de DragAndDropConstrained posé sur le `<div>` lui-même. */
  private enterEditMode(): void {
    if (!this.element || !this.element.parentElement) return;
    const container = this.element.parentElement;

    const textarea = document.createElement('textarea');
    textarea.className = 'haplan-text-editor';
    textarea.value = this.text;
    textarea.style.position = 'absolute';
    textarea.style.left = this.element.style.left;
    textarea.style.top = this.element.style.top;
    textarea.style.transform = this.element.style.transform;
    textarea.style.fontSize = `${HA_TEXT_FONT_SIZE_PX[this.size]}px`;
    textarea.style.zIndex = '100';
    textarea.style.minWidth = '80px';
    textarea.rows = 2;

    this.element.style.display = 'none';
    container.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const commit = () => {
      const trimmed = textarea.value.trim();
      textarea.remove();
      if (!this.element) return;
      this.element.style.display = '';
      if (trimmed && trimmed !== this.text) {
        this.text = trimmed;
        this.element.textContent = trimmed;
        this.positionManager?.updateText(this.id, this.toEntry());
      }
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        textarea.blur();
      } else if (event.key === 'Escape') {
        textarea.value = this.text;
        textarea.blur();
      }
    });
  }

  /** Active le glisser-déposer (mode édition uniquement) — même mécanique que
   *  `HAObject.initializeDragHandler` (mode 'center', snap 2%, dépôt sur la poubelle = suppression),
   *  reprise ici directement plutôt qu'héritée (voir en-tête du fichier). */
  enableDrag(): void {
    if (!this.element || this.dragHandler) return;

    const onDragEndCallback = (finalPosition: { x: number; y: number }) => {
      const container = this.element?.closest('.floorplan-drag-container') as HTMLElement | null;
      const trashIcon = container?.querySelector('.trash-icon') as HTMLElement | null;
      if (trashIcon && this.isOverTrash(trashIcon, finalPosition, container)) {
        this.removeFromFloorPlan();
        return;
      }

      if (this.positionManager && container) {
        const containerRect = container.getBoundingClientRect();
        const x = finalPosition.x / containerRect.width;
        const y = finalPosition.y / containerRect.height;
        this.position = { x, y };
        this.positionManager.updateText(this.id, this.toEntry());
      }
    };

    this.dragHandler = new DragAndDropConstrained(`#${this.element.id}`, onDragEndCallback, 'center', 2);
    this.element.classList.add('ha-object-draggable');
  }

  disableDrag(): void {
    if (this.dragHandler) {
      this.dragHandler.destroy();
      this.dragHandler = null;
    }
    if (this.element) {
      this.element.classList.remove('ha-object-draggable');
    }
  }

  private isOverTrash(trashIcon: HTMLElement, position: { x: number; y: number }, container: HTMLElement | null): boolean {
    if (!container) return false;
    const trashRect = trashIcon.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const absoluteX = containerRect.left + position.x;
    const absoluteY = containerRect.top + position.y;
    return (
      absoluteX >= trashRect.left &&
      absoluteX <= trashRect.right &&
      absoluteY >= trashRect.top &&
      absoluteY <= trashRect.bottom
    );
  }

  private removeFromFloorPlan(): void {
    this.disableDrag();
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.positionManager?.removeText(this.id);
  }

  destroy(): void {
    this.disableDrag();
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }
}
