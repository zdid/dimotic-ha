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

import { renderTargetCards, renderSshPrepSection, showTargetActionResult, appendTargetProgress, type TargetActionResult, type RemoteAction } from './TargetCards.js';

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
      .target-badge-offline {
        margin-left: 8px; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;
        background: rgba(231, 76, 60, 0.15); border: 1px solid #e74c3c; color: #e74c3c;
      }
      .target-purge {
        float: right; margin-left: 6px; padding: 4px 10px; border-radius: 4px; border: 1px solid #f39c12;
        background: transparent; color: #f39c12; cursor: pointer; font-size: 0.8rem;
      }
      .target-docker-hint {
        padding: 8px; border-radius: 4px; background: rgba(255,193,7,0.15);
        border: 1px solid #ffc107; margin: 8px 0; color: #ecf0f1;
      }
      .target-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .target-actions button {
        padding: 6px 14px; border-radius: 4px; border: none; cursor: pointer;
        background: #3498db; color: white; font-size: 0.85rem;
      }
      .target-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
      .target-progress {
        margin-top: 10px; padding: 8px 10px; max-height: 180px; overflow-y: auto;
        background: #1a252f; border: 1px solid #4a6278; border-radius: 4px;
        color: #bdc3c7; font-size: 0.78rem; white-space: pre-wrap; word-break: break-all;
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

      <h2 style="margin-top:30px;">🐝 Déploiement zigbee2mqtt</h2>
      <p class="section-description">
        Installer/mettre à jour zigbee2mqtt (image koenkk/zigbee2mqtt) sur la machine où est branché
        le dongle USB Zigbee — liste de cibles séparée, le dongle peut être sur une machine
        différente de celle qui héberge HA+Mosquitto.
      </p>
      <div class="add-target-form">
        <div class="field">
          <label for="z2m-target-id">Identifiant</label>
          <input type="text" id="z2m-target-id" placeholder="orangepi">
        </div>
        <div class="field">
          <label for="z2m-target-host">Hôte</label>
          <input type="text" id="z2m-target-host" placeholder="192.168.1.130">
        </div>
        <div class="field">
          <label for="z2m-target-serial">Port série du dongle</label>
          <input type="text" id="z2m-target-serial" placeholder="/dev/ttyUSB0" style="width:140px;">
        </div>
        <div class="field">
          <label for="z2m-target-mqtt-host">Hôte MQTT</label>
          <input type="text" id="z2m-target-mqtt-host" placeholder="192.168.1.51" style="width:140px;">
        </div>
        <div class="field">
          <label for="z2m-target-mqtt-port">Port MQTT</label>
          <input type="text" id="z2m-target-mqtt-port" placeholder="1883" style="width:80px;">
        </div>
        <button type="button" id="add-z2m-target-btn">➕ Ajouter</button>
      </div>
      <div class="field" style="margin-bottom:12px;">
        <label for="z2m-deploy-version">Version zigbee2mqtt à déployer (vide = latest)</label>
        <input type="text" id="z2m-deploy-version" placeholder="1.40.0" style="width:120px;">
      </div>
      <div id="z2m-targets-container"><div class="empty">Chargement...</div></div>
    </div>
  `;
  return template;
};

/** Forme large des 3 listes de cibles — `origin` absent = ancienne forme (compat descendante,
 *  au cas où un serveur pas encore mis à jour émettrait l'ancienne forme sans ce champ). */
type TargetsListData = { targets: { id: string; host: string; origin?: 'local' | 'gossip' }[] };

export class DeploymentManager extends HTMLElement {
  private socket: any = null;
  /** ⭐ 31/08/2026 — statuts de présence des machines connues par gossip (core:machine:status:list),
   *  machineId → online. Absent = statut jamais reçu. */
  private liveness: Map<string, boolean> = new Map();
  /** Dernier payload reçu de chacune des 3 listes — permet de re-render sur un simple changement
   *  de statut de présence, sans attendre une nouvelle liste de cibles. */
  private lastCoreTargets: TargetsListData['targets'] = [];
  private lastHaStackTargets: TargetsListData['targets'] = [];
  private lastZ2mTargets: TargetsListData['targets'] = [];
  /** ⭐ 05/09/2026 — mis en cache pour pouvoir re-rendre `renderSshPrep()` (hôtes réels dans la
   *  commande ssh-copy-id) à chaque mise à jour d'une des 3 listes de cibles, pas seulement au
   *  premier événement `core:deployment:targets:list` qui les porte. */
  private cachedIsRunningInDocker = false;
  private cachedProjectRoot = '';

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

    this.socket.on('core:deployment:targets:list', (data: TargetsListData & { isRunningInDocker: boolean; projectRoot: string }) => {
      this.cachedIsRunningInDocker = data.isRunningInDocker;
      this.cachedProjectRoot = data.projectRoot;
      this.renderSshPrep();
      this.renderTargets(data);
    });

    // ⭐ 31/08/2026 : présence des machines connues par gossip (LWT MQTT natif côté serveur, voir
    // TargetGossipService) — persistant, rejoué à la connexion, donc l'état réel est déjà là dès le
    // premier rendu des cartes (pas seulement les transitions futures).
    this.socket.on('core:machine:status:list', (data: { statuses: { machineId: string; online: boolean }[] }) => {
      this.liveness = new Map(data.statuses.map((s) => [s.machineId, s.online]));
      this.renderTargets({ targets: this.lastCoreTargets });
      this.renderHaStackTargets({ targets: this.lastHaStackTargets });
      this.renderZigbee2mqttTargets({ targets: this.lastZ2mTargets });
    });

    this.socket.on('core:deployment:remote-op:result', (result: TargetActionResult) => {
      const container = this.shadowRoot!.getElementById('targets-container');
      if (container) showTargetActionResult(container, result);
    });

    this.socket.on('core:deployment:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      const container = this.shadowRoot!.getElementById('targets-container');
      if (container) appendTargetProgress(container, data.targetId, data.chunk);
    });

    this.socket.emit('core:deployment:targets:get');

    this.shadowRoot!.getElementById('add-target-btn')?.addEventListener('click', () => this.addTarget());

    this.socket.on('core:deployment:ha-stack:targets:list', (data: TargetsListData) => {
      this.renderHaStackTargets(data);
      this.renderSshPrep();
    });

    this.socket.on('core:deployment:ha-stack:remote-op:result', (result: TargetActionResult) => {
      const container = this.shadowRoot!.getElementById('ha-targets-container');
      if (container) showTargetActionResult(container, result);
    });

    this.socket.on('core:deployment:ha-stack:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      const container = this.shadowRoot!.getElementById('ha-targets-container');
      if (container) appendTargetProgress(container, data.targetId, data.chunk);
    });

    this.socket.emit('core:deployment:ha-stack:targets:get');

    this.shadowRoot!.getElementById('add-ha-target-btn')?.addEventListener('click', () => this.addHaStackTarget());

    this.socket.on('core:deployment:zigbee2mqtt:targets:list', (data: TargetsListData) => {
      this.renderZigbee2mqttTargets(data);
      this.renderSshPrep();
    });

    this.socket.on('core:deployment:zigbee2mqtt:remote-op:result', (result: TargetActionResult) => {
      const container = this.shadowRoot!.getElementById('z2m-targets-container');
      if (container) showTargetActionResult(container, result);
    });

    this.socket.on('core:deployment:zigbee2mqtt:remote-op:progress', (data: { targetId: string; chunk: string }) => {
      const container = this.shadowRoot!.getElementById('z2m-targets-container');
      if (container) appendTargetProgress(container, data.targetId, data.chunk);
    });

    this.socket.emit('core:deployment:zigbee2mqtt:targets:get');

    this.shadowRoot!.getElementById('add-z2m-target-btn')?.addEventListener('click', () => this.addZigbee2mqttTarget());
  }

  /** ⭐ 05/09/2026 — combine les 3 listes de cibles (core/HA-stack/zigbee2mqtt) pour que la commande
   *  ssh-copy-id affiche un bloc par hôte réel déjà connu, quelle que soit la liste d'où il vient. */
  private renderSshPrep(): void {
    const container = this.shadowRoot!.getElementById('ssh-prep-container');
    if (!container) return;
    const targets = [...this.lastCoreTargets, ...this.lastHaStackTargets, ...this.lastZ2mTargets];
    renderSshPrepSection(container, {
      isRunningInDocker: this.cachedIsRunningInDocker,
      projectRoot: this.cachedProjectRoot,
      targets
    });
  }

  /** ⭐ 31/08/2026 : dérive `online` (uniquement pour les cibles gossipées) à partir de `liveness`,
   *  côté appelant — TargetCards.ts n'a lui-même aucune idée de Socket.io/MQTT. */
  private withLiveness(targets: TargetsListData['targets']) {
    return targets.map((t) => ({
      ...t,
      online: t.origin === 'gossip' ? this.liveness.get(t.id.split('::')[0]) : undefined
    }));
  }

  private renderTargets(data: TargetsListData): void {
    this.lastCoreTargets = data.targets;
    const container = this.shadowRoot!.getElementById('targets-container');
    if (!container) return;
    renderTargetCards(container, {
      targets: this.withLiveness(data.targets),
      extraActions: ['push-config'],
      onAction: (targetId: string, action: RemoteAction) => {
        const version = (this.shadowRoot!.getElementById('deploy-version') as HTMLInputElement | null)?.value.trim();
        this.socket.emit('core:deployment:remote-op', { targetId, action, version: version || undefined });
      },
      onDelete: (targetId: string) => {
        this.socket.emit('core:deployment:target:delete', { id: targetId });
      },
      onPurge: (machineId: string) => {
        this.socket.emit('core:deployment:target:purge', { machineId });
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

  private renderHaStackTargets(data: TargetsListData): void {
    this.lastHaStackTargets = data.targets;
    const container = this.shadowRoot!.getElementById('ha-targets-container');
    if (!container) return;
    renderTargetCards(container, {
      targets: this.withLiveness(data.targets),
      onAction: (targetId: string, action: RemoteAction) => {
        const version = (this.shadowRoot!.getElementById('ha-deploy-version') as HTMLInputElement | null)?.value.trim();
        this.socket.emit('core:deployment:ha-stack:remote-op', { targetId, action, version: version || undefined });
      },
      onDelete: (targetId: string) => {
        this.socket.emit('core:deployment:ha-stack:target:delete', { id: targetId });
      },
      onPurge: (machineId: string) => {
        this.socket.emit('core:deployment:target:purge', { machineId });
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

  private renderZigbee2mqttTargets(data: TargetsListData): void {
    this.lastZ2mTargets = data.targets;
    const container = this.shadowRoot!.getElementById('z2m-targets-container');
    if (!container) return;
    renderTargetCards(container, {
      targets: this.withLiveness(data.targets),
      onAction: (targetId: string, action: RemoteAction) => {
        const version = (this.shadowRoot!.getElementById('z2m-deploy-version') as HTMLInputElement | null)?.value.trim();
        this.socket.emit('core:deployment:zigbee2mqtt:remote-op', { targetId, action, version: version || undefined });
      },
      onDelete: (targetId: string) => {
        this.socket.emit('core:deployment:zigbee2mqtt:target:delete', { id: targetId });
      },
      onPurge: (machineId: string) => {
        this.socket.emit('core:deployment:target:purge', { machineId });
      }
    });
  }

  private addZigbee2mqttTarget(): void {
    const idEl = this.shadowRoot!.getElementById('z2m-target-id') as HTMLInputElement | null;
    const hostEl = this.shadowRoot!.getElementById('z2m-target-host') as HTMLInputElement | null;
    const serialEl = this.shadowRoot!.getElementById('z2m-target-serial') as HTMLInputElement | null;
    const mqttHostEl = this.shadowRoot!.getElementById('z2m-target-mqtt-host') as HTMLInputElement | null;
    const mqttPortEl = this.shadowRoot!.getElementById('z2m-target-mqtt-port') as HTMLInputElement | null;

    const id = idEl?.value.trim() ?? '';
    const host = hostEl?.value.trim() ?? '';
    if (!id || !host) return;

    const serialPort = serialEl?.value.trim() || '/dev/ttyUSB0';
    const mqttHost = mqttHostEl?.value.trim() ?? '';
    const mqttPortRaw = mqttPortEl?.value.trim();
    const mqttPort = mqttPortRaw ? Number.parseInt(mqttPortRaw, 10) : undefined;

    this.socket.emit('core:deployment:zigbee2mqtt:target:save', {
      id, host, remoteDir: '/docker/zigbee2mqtt', serialPort, mqttHost,
      mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined
    });

    if (idEl) idEl.value = '';
    if (hostEl) hostEl.value = '';
    if (serialEl) serialEl.value = '';
    if (mqttHostEl) mqttHostEl.value = '';
    if (mqttPortEl) mqttPortEl.value = '';
  }
}

customElements.define('app-deployment-manager', DeploymentManager);
