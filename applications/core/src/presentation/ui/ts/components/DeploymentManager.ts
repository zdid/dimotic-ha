/**
 * Composant DeploymentManager — déploiement de dimotic-ha lui-même sur d'autres machines (⭐
 * 23/08/2026), en remplacement de docker/rebuild-and-deploy.sh. Structure calquée sur
 * ApplicationsManager.ts (Shadow DOM + <template>), mais utilise directement
 * `window.app.socketService.getSocket()` (même pattern que les dashboards rpigpio/teleinfo) plutôt
 * que la couche `window.app.appManager` — pas de restart-countdown ici, une cible distante n'a
 * aucun rapport avec le cycle de vie de CETTE instance.
 *
 * Réutilise `renderTargetCards`/`renderSshPrepSection`/`showTargetActionResult` (TargetCards.ts,
 * même dossier) — mêmes cartes de cible que rpigpio/teleinfo/arexx. Une seule clé SSH pour toute
 * l'installation (⭐ 24/08/2026) : `renderSshPrepSection` n'est appelée qu'une fois, en tête de
 * page, avant les deux sections (dimotic-ha et HA+Mosquitto partagent la même clé).
 */

import { renderTargetCards, renderSshPrepSection, showTargetActionResult, type TargetActionResult, type RemoteAction } from './TargetCards.js';

const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .deployment-management {
        padding: 20px;
        background: #2c3e50;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        color: #ecf0f1;
      }
      .deployment-management h2 { color: #ecf0f1; margin-bottom: 10px; }
      .section-description { margin: 0 0 20px 0; color: #7f8c8d; font-size: 0.9rem; }

      .add-target-form {
        display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;
        margin-bottom: 20px; padding: 15px; background: #34495e; border-radius: 8px;
      }
      .add-target-form .field { display: flex; flex-direction: column; gap: 4px; }
      .add-target-form label { font-size: 0.8rem; color: #bdc3c7; }
      .add-target-form input {
        padding: 8px 10px; border-radius: 4px; border: 1px solid #4a6278;
        background: #2c3e50; color: #ecf0f1; font-size: 0.9rem;
      }
      .add-target-form button {
        padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer;
        background: #3498db; color: white; font-size: 0.9rem; height: 36px;
      }

      .empty { color: #7f8c8d; font-style: italic; padding: 10px; }

      /* Section SSH préalable (TargetCards.ts#renderSshPrepSection) */
      .ssh-prep-section {
        margin-bottom: 20px; padding: 12px 15px; background: #34495e; border-radius: 8px;
        font-size: 0.9em; color: #ecf0f1;
      }
      .ssh-prep-section p { margin: 0 0 8px; color: #bdc3c7; }
      .ssh-prep-section pre {
        background: #2c3e50; border: 1px solid #4a6278; border-radius: 4px;
        padding: 10px; overflow-x: auto; font-size: 0.85em; color: #ecf0f1;
      }

      /* Cartes de cibles (TargetCards.ts) */
      .target-card { background: #34495e; border-radius: 8px; padding: 15px; margin-bottom: 12px; }
      .target-card h4 { margin: 0 0 10px; display: inline-block; color: #ecf0f1; }
      .target-delete {
        float: right; padding: 4px 10px; border-radius: 4px; border: 1px solid #e74c3c;
        background: transparent; color: #e74c3c; cursor: pointer; font-size: 0.8rem;
      }
      .target-card .target-host { color: #7f8c8d; font-weight: normal; }
      .target-docker-hint {
        padding: 8px; border-radius: 4px; background: rgba(255,193,7,0.15);
        border: 1px solid #ffc107; margin: 8px 0; color: #ecf0f1;
      }
      .target-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .target-actions button {
        padding: 6px 14px; border-radius: 4px; border: none; cursor: pointer;
        background: #3498db; color: white; font-size: 0.85rem;
      }
      .target-result { padding: 10px; border-radius: 4px; margin-top: 10px; }
      .target-result-success { background: rgba(46, 204, 113, 0.15); border: 1px solid #2ecc71; color: #2ecc71; }
      .target-result-error { background: rgba(231, 76, 60, 0.15); border: 1px solid #e74c3c; color: #e74c3c; }
    </style>
    <div class="deployment-management">
      <div id="ssh-prep-container"></div>

      <h2>📦 Déploiement de dimotic-ha</h2>
      <p class="section-description">
        Installer/mettre à jour dimotic-ha lui-même sur une machine distante — suppose que l'image
        est déjà publiée sur Docker Hub (build multi-arch, reste manuel :
        docker/rebuild-and-deploy.sh --build-only). Sur une machine neuve, toutes les applications
        démarrent désactivées ; à activer ensuite localement, depuis l'IHM de cette machine.
      </p>
      <div class="add-target-form">
        <div class="field">
          <label for="target-id">Identifiant</label>
          <input type="text" id="target-id" placeholder="ha2">
        </div>
        <div class="field">
          <label for="target-host">Hôte</label>
          <input type="text" id="target-host" placeholder="192.168.1.51">
        </div>
        <button type="button" id="add-target-btn">➕ Ajouter</button>
      </div>
      <div class="field" style="margin-bottom:12px;">
        <label for="deploy-version">Version à déployer (vide = latest)</label>
        <input type="text" id="deploy-version" placeholder="2.1.0" style="width:120px;">
      </div>
      <div id="targets-container"><div class="empty">Chargement...</div></div>

      <h2 style="margin-top:30px;">🏠 Déploiement Home Assistant + Mosquitto</h2>
      <p class="section-description">
        Provisionner un nouveau Home Assistant (Docker) accompagné d'un broker Mosquitto (config
        minimale sans authentification, LAN de confiance) sur une machine distante — liste de
        cibles séparée de celle de dimotic-ha ci-dessus.
      </p>
      <div class="add-target-form">
        <div class="field">
          <label for="ha-target-id">Identifiant</label>
          <input type="text" id="ha-target-id" placeholder="maison2">
        </div>
        <div class="field">
          <label for="ha-target-host">Hôte</label>
          <input type="text" id="ha-target-host" placeholder="192.168.1.60">
        </div>
        <button type="button" id="add-ha-target-btn">➕ Ajouter</button>
      </div>
      <div class="field" style="margin-bottom:12px;">
        <label for="ha-deploy-version">Version Home Assistant à déployer (vide = latest)</label>
        <input type="text" id="ha-deploy-version" placeholder="2026.8.0" style="width:120px;">
      </div>
      <div id="ha-targets-container"><div class="empty">Chargement...</div></div>
    </div>
  `;
  return template;
};

export class DeploymentManager extends HTMLElement {
  private socket: any = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    const template = createTemplate();
    this.shadowRoot!.appendChild(template.content.cloneNode(true));
  }

  connectedCallback(): void {
    this.setupSocket();
  }

  private setupSocket(): void {
    if (!window.app || !window.app.socketService) {
      setTimeout(() => this.setupSocket(), 100);
      return;
    }
    this.socket = window.app.socketService.getSocket();

    this.socket.on('core:deployment:targets:list', (data: { targets: { id: string; host: string }[]; isRunningInDocker: boolean; projectRoot: string }) => {
      this.renderSshPrep(data.isRunningInDocker, data.projectRoot);
      this.renderTargets(data);
    });

    this.socket.on('core:deployment:remote-op:result', (result: TargetActionResult) => {
      const container = this.shadowRoot!.getElementById('targets-container');
      if (container) showTargetActionResult(container, result);
    });

    this.socket.emit('core:deployment:targets:get');

    this.shadowRoot!.getElementById('add-target-btn')?.addEventListener('click', () => this.addTarget());

    this.socket.on('core:deployment:ha-stack:targets:list', (data: { targets: { id: string; host: string }[]; isRunningInDocker: boolean; projectRoot: string }) => {
      this.renderHaStackTargets(data);
    });

    this.socket.on('core:deployment:ha-stack:remote-op:result', (result: TargetActionResult) => {
      const container = this.shadowRoot!.getElementById('ha-targets-container');
      if (container) showTargetActionResult(container, result);
    });

    this.socket.emit('core:deployment:ha-stack:targets:get');

    this.shadowRoot!.getElementById('add-ha-target-btn')?.addEventListener('click', () => this.addHaStackTarget());
  }

  private renderSshPrep(isRunningInDocker: boolean, projectRoot: string): void {
    const container = this.shadowRoot!.getElementById('ssh-prep-container');
    if (container) renderSshPrepSection(container, { isRunningInDocker, projectRoot });
  }

  private renderTargets(data: { targets: { id: string; host: string }[] }): void {
    const container = this.shadowRoot!.getElementById('targets-container');
    if (!container) return;
    renderTargetCards(container, {
      targets: data.targets,
      onAction: (targetId: string, action: RemoteAction) => {
        const version = (this.shadowRoot!.getElementById('deploy-version') as HTMLInputElement | null)?.value.trim();
        this.socket.emit('core:deployment:remote-op', { targetId, action, version: version || undefined });
      },
      onDelete: (targetId: string) => {
        this.socket.emit('core:deployment:target:delete', { id: targetId });
      }
    });
  }

  private addTarget(): void {
    const idEl = this.shadowRoot!.getElementById('target-id') as HTMLInputElement | null;
    const hostEl = this.shadowRoot!.getElementById('target-host') as HTMLInputElement | null;

    const id = idEl?.value.trim() ?? '';
    const host = hostEl?.value.trim() ?? '';
    if (!id || !host) return;

    this.socket.emit('core:deployment:target:save', { id, host, remoteDir: '/docker/dimotic-ha' });

    if (idEl) idEl.value = '';
    if (hostEl) hostEl.value = '';
  }

  private renderHaStackTargets(data: { targets: { id: string; host: string }[] }): void {
    const container = this.shadowRoot!.getElementById('ha-targets-container');
    if (!container) return;
    renderTargetCards(container, {
      targets: data.targets,
      onAction: (targetId: string, action: RemoteAction) => {
        const version = (this.shadowRoot!.getElementById('ha-deploy-version') as HTMLInputElement | null)?.value.trim();
        this.socket.emit('core:deployment:ha-stack:remote-op', { targetId, action, version: version || undefined });
      },
      onDelete: (targetId: string) => {
        this.socket.emit('core:deployment:ha-stack:target:delete', { id: targetId });
      }
    });
  }

  private addHaStackTarget(): void {
    const idEl = this.shadowRoot!.getElementById('ha-target-id') as HTMLInputElement | null;
    const hostEl = this.shadowRoot!.getElementById('ha-target-host') as HTMLInputElement | null;

    const id = idEl?.value.trim() ?? '';
    const host = hostEl?.value.trim() ?? '';
    if (!id || !host) return;

    this.socket.emit('core:deployment:ha-stack:target:save', { id, host, remoteDir: '/docker/homeassistant' });

    if (idEl) idEl.value = '';
    if (hostEl) hostEl.value = '';
  }
}

customElements.define('app-deployment-manager', DeploymentManager);
