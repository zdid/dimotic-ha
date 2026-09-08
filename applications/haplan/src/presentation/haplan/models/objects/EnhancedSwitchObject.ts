// Classe de base pour les objets de type switch (interrupteurs)
import { DataService } from '../../services/DataService';
import { BaseEntity } from './BaseEntity';

/**
 * Classe de base pour les objets de type switch
 * Peut être étendue pour des types spécifiques comme les radiateurs, ballons d'eau chaude, etc.
 */
export class EnhancedSwitchObject extends BaseEntity {
  protected isOn: boolean = false;
  
  constructor(
    entity_id: string,
    position: { x: number; y: number },
    dimensions: { width: number; height: number } = { width: 32, height: 32 },
    dataService?: DataService
  ) {
    super(entity_id, position, dimensions, dataService);
    this.setVisualStyle('minimal');
    this.setColorScheme({
      primary: '#2196F3', // Bleu par défaut
      secondary: '#03A9F4',
      background: 'transparent',
      text: '#FFFFFF'
    });
  }

  updateState(state: any): void {
    this.isOn = state.state === 'on';
    this.updateDisplay();
  }

  /** ⭐ 08/09/2026 : accesseur public pour l'état on/off — utilisé par SwitchWindow.ts, qui lisait
   *  jusqu'ici `getDisplayValue('status')`, un mécanisme dont `updateState()` (ici et dans
   *  EnhancedLightObject, dont héritent MinimalLightObject/les switches réels) ne renseigne plus
   *  rien depuis le passage à "l'affichage simplifié" (voir son commentaire) — le bouton affichait
   *  donc toujours "Allumer", jamais "Éteindre", quel que soit l'état réel. */
  getIsOn(): boolean {
    return this.isOn;
  }

  renderEntity(): HTMLElement {
    const container = this.createStyledElement('div', 'enhanced-switch-object');
    
    const icon = this.createIcon(this.getIconForState(), 'medium') as HTMLElement;
    if (icon) {
      icon.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }

    const statusDisplay = document.createElement('div') as HTMLElement;
    // ⭐ 08/09/2026, bug réel corrigé : classe manquante — updateDisplay() cherche cet élément via
    // `.switch-status-display` (querySelector), introuvable sans elle. Le texte ON/OFF restait donc
    // figé sur sa valeur du premier rendu (l'icône, elle, se mettait à jour normalement, trouvée
    // génériquement via le sélecteur `i`).
    statusDisplay.className = 'switch-status-display';
    statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';

    container.appendChild(icon);
    container.appendChild(statusDisplay);

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick();
    });

    return container;
  }

  protected getIconForState(): string {
    return this.isOn ? 'fa-toggle-on' : 'fa-toggle-off';
  }

  protected toggle(): void {
    this.sendCommand(this.getDomain(), this.isOn ? 'turn_off' : 'turn_on');
  }

  handleAction(action: string, value?: any): void {
    if (action === 'toggle') {
      this.toggle();
    } else {
      this.sendCommand(this.getDomain(), action);
    }
  }

  /** ⭐ 08/09/2026 : domaine dérivé de l'entity_id (au lieu du littéral 'switch' en dur) — cette
   *  classe sert aussi de rendu générique pour `input_boolean.*` (voir UnifiedObjectFactory.ts),
   *  qui a exactement les mêmes services HA (turn_on/turn_off/toggle) mais un domaine différent ;
   *  un domaine en dur y enverrait `switch.toggle` sur une entité qui n'est pas un switch. */
  private getDomain(): string {
    return this.entity_id.split('.')[0];
  }

  updateDisplay(): void {
    if (!this.element) return;
    
    const icon = this.element.querySelector('i') as HTMLElement;
    if (icon) {
      // ⭐ 08/09/2026, bug réel corrigé : seule la couleur était rafraîchie ici, jamais la classe —
      // le glyphe restait donc figé sur celui du tout premier rendu (fa-toggle-off/fa-toggle-on,
      // voir getIconForState()) même une fois l'état changé, malgré deux icônes bien prévues à
      // l'origine. Même format de classe qu'à la création (createIcon(), BaseEntity.ts).
      icon.className = `fas ${this.getIconForState()}`;
      icon.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }

    const statusDisplay = this.element.querySelector('.switch-status-display') as HTMLElement;
    if (statusDisplay) {
      statusDisplay.textContent = this.isOn ? 'ON' : 'OFF';
      statusDisplay.style.color = this.isOn ? this.colorScheme.primary : '#999999';
    }
  }
}
