/**
 * Composant PostInstallManager — écran "Services post-installation" (⭐ 24/08/2026, demande
 * explicite) : coche les services voulus (MQTT/Whisper/Piper/openWakeWord/Ollama), remplit
 * host:port (vide = même machine que HA), et un bouton "Installer" déclenche leur ajout réel dans
 * la HA actuellement connectée via `ha.ws` — voir HaPostInstallService.ts côté serveur pour le
 * détail des flux REST (vérifiés en conditions réelles avant d'écrire ce composant).
 *
 * N'agit jamais sur une HA distante par token dédié : toujours la même HA que celle déjà
 * connectée par ce socle (Paramètres Techniques → Web-Services) — sans ha.ws configuré et vert,
 * ce formulaire ne peut rien faire (le bouton reste actif, l'erreur revient simplement du serveur
 * pour chaque service demandé).
 */

interface PostInstallResult {
  kind: string;
  success: boolean;
  title?: string;
  error?: string;
}

const SERVICE_LABELS: Record<string, string> = {
  mqtt: 'MQTT',
  whisper: 'Whisper (reconnaissance vocale)',
  piper: 'Piper (synthèse vocale)',
  wakeword: 'openWakeWord (mot-clé)',
  ollama: 'Ollama (agent de conversation IA)'
};

const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .post-install {
        padding: 20px;
        background: #2c3e50;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        color: #ecf0f1;
      }
      .post-install h2 { color: #ecf0f1; margin-bottom: 10px; }
      .section-description { margin: 0 0 20px 0; color: #7f8c8d; font-size: 0.9rem; }

      .service-block {
        display: flex; flex-direction: column; gap: 10px;
        padding: 15px; background: #34495e; border-radius: 8px; margin-bottom: 12px;
      }
      .service-block .service-header {
        display: flex; align-items: center; gap: 10px; font-weight: 600;
      }
      .service-block .service-header input[type="checkbox"] { width: 18px; height: 18px; }
      .service-fields { display: flex; gap: 10px; flex-wrap: wrap; }
      .service-fields .field { display: flex; flex-direction: column; gap: 4px; }
      .service-fields label { font-size: 0.8rem; color: #bdc3c7; }
      .service-fields input {
        padding: 8px 10px; border-radius: 4px; border: 1px solid #4a6278;
        background: #2c3e50; color: #ecf0f1; font-size: 0.9rem; width: 200px;
      }
      .service-hint { font-size: 0.8rem; color: #7f8c8d; }

      .apply-btn {
        padding: 10px 20px; border-radius: 4px; border: none; cursor: pointer;
        background: #3498db; color: white; font-size: 1rem; margin-top: 10px;
      }
      .apply-btn:disabled { background: #4a6278; cursor: not-allowed; }

      .results { margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
      .result-line { padding: 8px 12px; border-radius: 4px; font-size: 0.9rem; }
      .result-line.success { background: #1e4620; color: #a8e6a3; }
      .result-line.error { background: #5e2020; color: #f0a8a3; }
    </style>

    <div class="post-install">
      <h2>🔧 Services post-installation</h2>
      <p class="section-description">
        Ajoute les intégrations vocales/IA courantes sur la HA actuellement connectée
        (Paramètres Techniques → Web-Services) — hôte vide = même machine que HA.
      </p>

      <div class="service-block">
        <div class="service-header">
          <input type="checkbox" id="chk-mqtt">
          <span>📡 MQTT</span>
        </div>
        <div class="service-fields">
          <div class="field"><label for="mqtt-host">Hôte</label><input type="text" id="mqtt-host" placeholder="même machine que HA"></div>
          <div class="field"><label for="mqtt-port">Port</label><input type="text" id="mqtt-port" placeholder="1883"></div>
          <div class="field"><label for="mqtt-user">Utilisateur (optionnel)</label><input type="text" id="mqtt-user"></div>
          <div class="field"><label for="mqtt-pass">Mot de passe (optionnel)</label><input type="password" id="mqtt-pass"></div>
        </div>
      </div>

      <div class="service-block">
        <div class="service-header">
          <input type="checkbox" id="chk-whisper">
          <span>🎙️ Whisper (reconnaissance vocale)</span>
        </div>
        <div class="service-fields">
          <div class="field"><label for="whisper-host">Hôte</label><input type="text" id="whisper-host" placeholder="192.168.1.x"></div>
          <div class="field"><label for="whisper-port">Port</label><input type="text" id="whisper-port" placeholder="10300"></div>
        </div>
      </div>

      <div class="service-block">
        <div class="service-header">
          <input type="checkbox" id="chk-piper">
          <span>🔊 Piper (synthèse vocale)</span>
        </div>
        <div class="service-fields">
          <div class="field"><label for="piper-host">Hôte</label><input type="text" id="piper-host" placeholder="192.168.1.x"></div>
          <div class="field"><label for="piper-port">Port</label><input type="text" id="piper-port" placeholder="10200"></div>
        </div>
      </div>

      <div class="service-block">
        <div class="service-header">
          <input type="checkbox" id="chk-wakeword">
          <span>👂 openWakeWord (mot-clé)</span>
        </div>
        <div class="service-fields">
          <div class="field"><label for="wakeword-host">Hôte</label><input type="text" id="wakeword-host" placeholder="192.168.1.x"></div>
          <div class="field"><label for="wakeword-port">Port</label><input type="text" id="wakeword-port" placeholder="10400"></div>
        </div>
        <p class="service-hint">Consommé par un satellite vocal matériel, pas par le pipeline Assist lui-même.</p>
      </div>

      <div class="service-block">
        <div class="service-header">
          <input type="checkbox" id="chk-ollama">
          <span>🤖 Ollama (agent de conversation IA)</span>
        </div>
        <div class="service-fields">
          <div class="field"><label for="ollama-url">URL</label><input type="text" id="ollama-url" placeholder="http://192.168.1.x:11434"></div>
          <div class="field"><label for="ollama-model">Modèle</label><input type="text" id="ollama-model" placeholder="ex: mistral-small"></div>
        </div>
        <p class="service-hint">Choisir un modèle réellement présent sur ce serveur (vérifiable via son propre écran de configuration) — un nom qui n'existe pas y échouera.</p>
      </div>

      <button type="button" class="apply-btn" id="apply-btn">Installer la sélection</button>

      <div class="results" id="results"></div>
    </div>
  `;
  return template;
};

export class PostInstallManager extends HTMLElement {
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

    this.socket.on('core:post-install:result', (data: { results: PostInstallResult[] }) => {
      this.renderResults(data.results);
    });

    this.shadowRoot!.getElementById('apply-btn')?.addEventListener('click', () => this.apply());
  }

  private field(id: string): string {
    return (this.shadowRoot!.getElementById(id) as HTMLInputElement | null)?.value.trim() || '';
  }

  private checked(id: string): boolean {
    return (this.shadowRoot!.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
  }

  private toPort(raw: string): number | undefined {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private apply(): void {
    const requests: Array<Record<string, unknown>> = [];

    if (this.checked('chk-mqtt')) {
      requests.push({
        kind: 'mqtt',
        host: this.field('mqtt-host'),
        port: this.toPort(this.field('mqtt-port')) || 1883,
        username: this.field('mqtt-user') || undefined,
        password: this.field('mqtt-pass') || undefined
      });
    }
    if (this.checked('chk-whisper')) {
      requests.push({ kind: 'whisper', host: this.field('whisper-host'), port: this.toPort(this.field('whisper-port')) });
    }
    if (this.checked('chk-piper')) {
      requests.push({ kind: 'piper', host: this.field('piper-host'), port: this.toPort(this.field('piper-port')) });
    }
    if (this.checked('chk-wakeword')) {
      requests.push({ kind: 'wakeword', host: this.field('wakeword-host'), port: this.toPort(this.field('wakeword-port')) });
    }
    if (this.checked('chk-ollama')) {
      requests.push({ kind: 'ollama', url: this.field('ollama-url'), model: this.field('ollama-model') || undefined });
    }

    if (requests.length === 0) return;

    const resultsEl = this.shadowRoot!.getElementById('results');
    if (resultsEl) resultsEl.innerHTML = '<div class="result-line">Installation en cours…</div>';

    this.socket.emit('core:post-install:apply', { requests });
  }

  private renderResults(results: PostInstallResult[]): void {
    const resultsEl = this.shadowRoot!.getElementById('results');
    if (!resultsEl) return;
    resultsEl.innerHTML = results.map((r) => {
      const label = SERVICE_LABELS[r.kind] || r.kind;
      if (r.success) {
        return `<div class="result-line success">✅ ${label} : ${r.title || 'installé'}</div>`;
      }
      return `<div class="result-line error">❌ ${label} : ${r.error || 'échec'}</div>`;
    }).join('');
  }
}

customElements.define('app-post-install-manager', PostInstallManager);
